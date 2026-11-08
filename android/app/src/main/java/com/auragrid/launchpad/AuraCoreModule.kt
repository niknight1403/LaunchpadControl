package com.auragrid.launchpad

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Installs the C++ core into the JS runtime (JNI → `JsiAudioBindings.cpp`).
 *
 * `install()` is blocking-synchronous on purpose: it must run before any React
 * component can call the engine, and a promise would race the first render.
 *
 * The JNI entry point is `Java_com_auragrid_launchpad_AuraCoreModule_installNative`,
 * which matches this class name and method name exactly — renaming either breaks
 * the binding at runtime, not at compile time, so keep them in sync.
 */
class AuraCoreModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "AuraCore"

    @ReactMethod(isBlockingSynchronousMethod = true)
    fun install(): Boolean {
        return try {
            val holder = reactContext.javaScriptContextHolder ?: return false
            installNative(holder.get())
        } catch (error: Throwable) {
            false
        }
    }

    private external fun installNative(runtimePtr: Long): Boolean

    companion object {
        init {
            // Must match target_link_libraries(auragrid_core ...) in CMakeLists.txt.
            System.loadLibrary("auragrid_core")
        }
    }
}
