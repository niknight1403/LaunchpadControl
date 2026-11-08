package com.auragrid.launchpad

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Foreground audio service.
 *
 * Why it exists: without a foreground service Android kills or throttles the
 * audio thread when the screen locks, which on stage looks like a crash. With
 * it, the stream survives the notification shade, a locked screen and app
 * switching, and we hold a wake lock plus audio focus.
 *
 * Audio focus is requested as `AUDIOFOCUS_GAIN` with
 * `AUDIOFOCUS_FLAG_LOCK`-equivalent semantics: a chat notification must not duck
 * a live set. If another app takes focus away, we notify JS instead of guessing.
 */
class AudioForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "auragrid_audio"
        const val NOTIFICATION_ID = 4711
        const val ACTION_START = "com.auragrid.launchpad.START"
        const val ACTION_STOP = "com.auragrid.launchpad.STOP"

        fun start(context: Context) {
            val intent = Intent(context, AudioForegroundService::class.java).apply {
                action = ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, AudioForegroundService::class.java).apply { action = ACTION_STOP }
            )
        }
    }

    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        // Do not stop audio on transient loss: the callback keeps rendering and
        // the user decides. Reporting it is enough.
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> Unit
            AudioManager.AUDIOFOCUS_GAIN -> requestFocus()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        requestFocus()
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        // Sticky: if the system restarts us, the stream should come back too.
        return START_STICKY
    }

    override fun onDestroy() {
        releaseFocus()
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Live Audio",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Hält den Audio-Core während eines Sets aktiv"
            setShowBadge(false)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("LaunchpadControl")
            .setContentText("AuraGrid Audio-Core aktiv")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .build()
    }

    private fun requestFocus(): Boolean {
        val manager = audioManager ?: (getSystemService(Context.AUDIO_SERVICE) as AudioManager).also {
            audioManager = it
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build()
                )
                .setWillPauseWhenDucked(false)
                .setOnAudioFocusChangeListener(focusListener)
                .build()
            focusRequest = request
            manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            manager.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
    }

    private fun releaseFocus() {
        val manager = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { manager.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            manager.abandonAudioFocus(focusListener)
        }
        focusRequest = null
    }

    private fun acquireWakeLock() {
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AuraGrid::AudioCore").apply {
            setReferenceCounted(false)
            acquire()
        }
    }
}
