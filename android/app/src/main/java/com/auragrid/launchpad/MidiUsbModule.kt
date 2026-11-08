package com.auragrid.launchpad

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * USB host MIDI bridge for the Novation Launchpad.
 *
 * This is the Android USB-MIDI class driver, not a generic serial port hack:
 * interface class AUDIO (1) / subclass MIDI_STREAMING (3), bulk endpoints, and
 * 4-byte USB-MIDI event packets. Keeping the parse here means the JS driver gets
 * plain MIDI bytes and knows nothing about USB.
 *
 * Latency note: reads run on a dedicated thread that does nothing else. No
 * allocation per packet beyond the reusable buffer, no logging in the hot path.
 */
class MidiUsbModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "AuraMidi"
        private const val TAG = "AuraMidi"
        private const val ACTION_USB_PERMISSION = "com.auragrid.launchpad.USB_PERMISSION"
        private const val READ_BUFFER = 256
    }

    private val usbManager: UsbManager? =
        reactContext.getSystemService(Context.USB_SERVICE) as? UsbManager

    private var connection: UsbDeviceConnection? = null
    private var midiInterface: UsbInterface? = null
    private var endpointIn: UsbEndpoint? = null
    private var endpointOut: UsbEndpoint? = null
    private var device: UsbDevice? = null

    private val reader = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "AuraMidi-Reader").apply { priority = Thread.MAX_PRIORITY }
    }
    private val writer = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "AuraMidi-Writer").apply { priority = Thread.MAX_PRIORITY }
    }
    private val reading = AtomicBoolean(false)

    override fun getName() = NAME

    private val detachReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val attached = intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)
                    if (attached != null && attached.deviceId == device?.deviceId) {
                        closeDevice()
                        emit("AuraMidi:device", attached.productName ?: "Launchpad", false)
                    }
                }
                ACTION_USB_PERMISSION -> {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    if (granted) openFirstAvailable()
                }
            }
        }
    }

    init {
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(ACTION_USB_PERMISSION)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactContext.registerReceiver(detachReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            reactContext.registerReceiver(detachReceiver, filter)
        }
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    @ReactMethod
    fun start(promise: com.facebook.react.bridge.Promise) {
        try {
            openFirstAvailable()
            promise.resolve(true)
        } catch (error: Exception) {
            promise.reject("start_failed", error)
        }
    }

    @ReactMethod
    fun stop(promise: com.facebook.react.bridge.Promise) {
        closeDevice()
        promise.resolve(true)
    }

    @ReactMethod
    fun listDevices(promise: com.facebook.react.bridge.Promise) {
        val result: WritableArray = Arguments.createArray()
        usbManager?.deviceList?.values?.forEach { candidate ->
            if (findMidiInterface(candidate) != null) {
                val item = Arguments.createMap()
                item.putString("id", candidate.deviceId.toString())
                item.putString("name", candidate.productName ?: "USB MIDI ${candidate.deviceId}")
                result.pushMap(item)
            }
        }
        promise.resolve(result)
    }

    /**
     * Sends one complete MIDI/SysEx message.
     * Frames are packetised into 4-byte USB-MIDI event packets: SysEx is chunked
     * with CIN 0x04 and terminated with 0x05/0x06/0x07 per the USB-MIDI spec.
     */
    @ReactMethod
    fun send(bytes: com.facebook.react.bridge.ReadableArray, promise: com.facebook.react.bridge.Promise) {
        val data = ByteArray(bytes.size())
        for (index in 0 until bytes.size()) data[index] = bytes.getInt(index).toByte()
        val out = endpointOut
        val conn = connection
        if (out == null || conn == null) {
            promise.reject("no_device", "Kein Launchpad verbunden")
            return
        }
        writer.execute {
            try {
                val packets = packetise(data)
                var offset = 0
                while (offset < packets.size) {
                    val written = conn.bulkTransfer(out, packets, offset, packets.size - offset, 200)
                    if (written <= 0) break
                    offset += written
                }
                promise.resolve(true)
            } catch (error: Exception) {
                promise.reject("send_failed", error)
            }
        }
    }

    // ── opening ─────────────────────────────────────────────────────────────

    private fun openFirstAvailable() {
        if (connection != null) return
        val manager = usbManager ?: return
        val candidate = manager.deviceList.values.firstOrNull { findMidiInterface(it) != null } ?: return
        if (!manager.hasPermission(candidate)) {
            val flags = PendingIntent.FLAG_IMMUTABLE
            val intent = PendingIntent.getBroadcast(
                reactContext, 0,
                Intent(ACTION_USB_PERMISSION).setPackage(reactContext.packageName), flags
            )
            manager.requestPermission(candidate, intent)
            return
        }
        openDevice(candidate)
    }

    private fun openDevice(target: UsbDevice) {
        val manager = usbManager ?: return
        val midi = findMidiInterface(target) ?: return
        val conn = manager.openDevice(target) ?: return

        if (!conn.claimInterface(midi, true)) {
            conn.close()
            Log.w(TAG, "claimInterface rejected for ${target.productName}")
            return
        }

        var outEndpoint: UsbEndpoint? = null
        var inEndpoint: UsbEndpoint? = null
        for (index in 0 until midi.endpointCount) {
            val endpoint = midi.getEndpoint(index)
            if (endpoint.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
            if (endpoint.direction == UsbConstants.USB_DIR_OUT && outEndpoint == null) outEndpoint = endpoint
            if (endpoint.direction == UsbConstants.USB_DIR_IN && inEndpoint == null) inEndpoint = endpoint
        }
        if (outEndpoint == null) {
            conn.releaseInterface(midi)
            conn.close()
            return
        }

        connection = conn
        midiInterface = midi
        endpointIn = inEndpoint
        endpointOut = outEndpoint
        device = target

        emit("AuraMidi:device", target.productName ?: "Launchpad", true)
        startReader(conn, inEndpoint)
    }

    private fun startReader(conn: UsbDeviceConnection, endpoint: UsbEndpoint?) {
        if (endpoint == null || reading.getAndSet(true)) return
        reader.execute {
            val buffer = ByteArray(READ_BUFFER)
            try {
                while (reading.get()) {
                    val read = conn.bulkTransfer(endpoint, buffer, buffer.size, 500)
                    if (read <= 0) continue
                    // Strip USB-MIDI framing: keep bytes 1..3 per 4-byte packet,
                    // skipping zero padding.
                    var index = 0
                    while (index + 3 <= read) {
                        val cin = buffer[index].toInt() and 0x0f
                        val length = cinLength(cin)
                        val payload = Arguments.createArray()
                        for (offset in 1..length) {
                            payload.pushInt(buffer[index + offset].toInt() and 0xff)
                        }
                        if (length > 0) emitBytes(payload)
                        index += 4
                    }
                }
            } catch (error: Exception) {
                Log.w(TAG, "reader stopped: ${error.message}")
            } finally {
                reading.set(false)
            }
        }
    }

    private fun closeDevice() {
        reading.set(false)
        midiInterface?.let { iface ->
            try {
                connection?.releaseInterface(iface)
            } catch (_: Exception) {
            }
        }
        connection?.close()
        connection = null
        midiInterface = null
        endpointIn = null
        endpointOut = null
        device = null
    }

    private fun findMidiInterface(candidate: UsbDevice): UsbInterface? {
        for (index in 0 until candidate.interfaceCount) {
            val iface = candidate.getInterface(index)
            if (iface.interfaceClass == UsbConstants.USB_CLASS_AUDIO &&
                iface.interfaceSubclass == 3 // MIDI_STREAMING
            ) {
                return iface
            }
            // Novation firmware also exposes a vendor-specific audio interface.
            if (iface.interfaceClass == UsbConstants.USB_CLASS_AUDIO) return iface
        }
        return null
    }

    // ── packetisation ───────────────────────────────────────────────────────

    private fun packetise(data: ByteArray): ByteArray {
        val packets = ArrayList<Byte>(data.size + 8)
        var index = 0
        while (index < data.size) {
            val status = data[index].toInt() and 0xff
            if (status == 0xf0) {
                // SysEx: 3 bytes per packet, last packet uses a terminating CIN.
                var cursor = index
                while (cursor < data.size) {
                    val remaining = data.size - cursor
                    val chunk = minOf(3, remaining)
                    val cin = if (remaining <= 3) (0x04 + chunk) else 0x04
                    packets.add(cin.toByte())
                    for (offset in 0 until 3) {
                        packets.add(if (offset < chunk) data[cursor + offset] else 0)
                    }
                    cursor += chunk
                }
                index = data.size
            } else {
                val length = when {
                    status >= 0xf0 -> 1
                    status and 0xf0 == 0xc0 || status and 0xf0 == 0xd0 -> 2
                    else -> 3
                }
                val cin = when {
                    status and 0xf0 == 0x80 -> 0x08
                    status and 0xf0 == 0x90 -> 0x09
                    status and 0xf0 == 0xa0 -> 0x0a
                    status and 0xf0 == 0xb0 -> 0x0b
                    status and 0xf0 == 0xe0 -> 0x0e
                    else -> 0x0f
                }
                packets.add(cin.toByte())
                for (offset in 0 until 3) {
                    packets.add(if (offset < length && index + offset < data.size) data[index + offset] else 0)
                }
                index += length
            }
        }
        return packets.toByteArray()
    }

    private fun cinLength(cin: Int): Int = when (cin) {
        0x05 -> 1
        0x02, 0x06, 0x0c, 0x0d -> 2
        0x03, 0x04, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0e -> 3
        0x0f -> 1
        else -> 0
    }

    // ── events ──────────────────────────────────────────────────────────────

    private fun emitBytes(payload: WritableArray) {
        val map = Arguments.createMap()
        map.putArray("bytes", payload)
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("AuraMidi:message", map)
    }

    private fun emit(event: String, name: String, attached: Boolean) {
        val map = Arguments.createMap()
        map.putString("name", name)
        map.putBoolean("attached", attached)
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, map)
    }

    override fun onCatalystInstanceDestroy() {
        closeDevice()
        try {
            reactContext.unregisterReceiver(detachReceiver)
        } catch (_: Exception) {
        }
        reader.shutdownNow()
        writer.shutdownNow()
        super.onCatalystInstanceDestroy()
    }
}
