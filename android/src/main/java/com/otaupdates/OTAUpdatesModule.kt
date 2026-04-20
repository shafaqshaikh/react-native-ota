package com.otaupdates

import android.content.Context
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.*
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

class OTAUpdatesModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "OTAUpdates"
        private const val PREFS = "OTAUpdatesPrefs"
        private const val K_BUNDLE = "bundlePath"
        private const val K_LAUNCHES = "launchCount"
        private const val K_CRASH_T = "lastCrashTime"
        private const val MAX_CRASHES = 2
        private const val CRASH_WINDOW_MS = 30_000L

        private var sBundlePath: String? = null
        private var sInit = false

        /**
         * Call from MainApplication.getJSBundleFile() to load OTA bundle.
         *
         * ```kotlin
         * override fun getJSBundleFile(): String? =
         *     OTAUpdatesModule.getBundleFile(this) ?: super.getJSBundleFile()
         * ```
         */
        @JvmStatic
        fun getBundleFile(context: Context): String? {
            if (!sInit) { init(context); sInit = true }

            val p = sBundlePath ?: return null
            if (File(p).exists()) {
                Log.i(TAG, "Loading OTA bundle: $p")
                recordLaunch(context)
                return p
            }

            Log.w(TAG, "OTA bundle missing at $p — falling back")
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().remove(K_BUNDLE).apply()
            sBundlePath = null
            return null
        }

        /**
         * Call from Application.onCreate() to install crash detection.
         */
        @JvmStatic
        fun install(context: Context) {
            val prev = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { t, e ->
                try {
                    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putLong(K_CRASH_T, System.currentTimeMillis()).apply()
                } catch (_: Exception) {}
                prev?.uncaughtException(t, e)
            }
            Log.i(TAG, "Crash handler installed")
        }

        private fun init(context: Context) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            sBundlePath = prefs.getString(K_BUNDLE, null)

            if (sBundlePath != null) {
                val launches = prefs.getInt(K_LAUNCHES, 0)
                val lastCrash = prefs.getLong(K_CRASH_T, 0)
                val now = System.currentTimeMillis()
                if (launches >= MAX_CRASHES && (now - lastCrash) < CRASH_WINDOW_MS) {
                    Log.w(TAG, "Crash loop ($launches)! Rolling back")
                    prefs.edit().remove(K_BUNDLE).putInt(K_LAUNCHES, 0).apply()
                    sBundlePath = null
                }
            }
        }

        private fun recordLaunch(context: Context) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            prefs.edit()
                .putInt(K_LAUNCHES, prefs.getInt(K_LAUNCHES, 0) + 1)
                .putLong(K_CRASH_T, System.currentTimeMillis())
                .apply()
        }
    }

    override fun getName() = "OTAUpdatesModule"

    override fun getConstants(): Map<String, Any> = mapOf(
        "documentDirectory" to ctx.filesDir.absolutePath
    )

    // ── Bundle management ──────────────────────────────────────────

    @ReactMethod
    fun setNextBundlePath(path: String, promise: Promise) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(K_BUNDLE, path).apply()
        sBundlePath = path
        promise.resolve(true)
    }

    @ReactMethod
    fun clearBundlePath(promise: Promise) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(K_BUNDLE).apply()
        sBundlePath = null
        promise.resolve(true)
    }

    @ReactMethod
    fun confirmLaunchSuccess(promise: Promise) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putInt(K_LAUNCHES, 0).apply()
        promise.resolve(true)
    }

    // ── File system ────────────────────────────────────────────────

    @ReactMethod fun mkdir(p: String, promise: Promise) {
        File(p).mkdirs(); promise.resolve(true)
    }

    @ReactMethod fun exists(p: String, promise: Promise) {
        promise.resolve(File(p).exists())
    }

    @ReactMethod fun readFile(p: String, enc: String, promise: Promise) {
        try {
            val bytes = File(p).readBytes()
            promise.resolve(if (enc == "base64") Base64.encodeToString(bytes, Base64.NO_WRAP) else String(bytes))
        } catch (e: Exception) { promise.reject("READ", e.message) }
    }

    @ReactMethod fun writeFile(p: String, content: String, enc: String, promise: Promise) {
        try {
            val f = File(p); f.parentFile?.mkdirs()
            if (enc == "base64") f.writeBytes(Base64.decode(content, Base64.DEFAULT))
            else f.writeText(content)
            promise.resolve(true)
        } catch (e: Exception) { promise.reject("WRITE", e.message) }
    }

    @ReactMethod fun moveFile(src: String, dst: String, promise: Promise) {
        try {
            val s = File(src); val d = File(dst); d.parentFile?.mkdirs()
            if (!s.renameTo(d)) { s.copyTo(d, overwrite = true); s.delete() }
            promise.resolve(true)
        } catch (e: Exception) { promise.reject("MOVE", e.message) }
    }

    @ReactMethod fun deleteFile(p: String, promise: Promise) {
        File(p).deleteRecursively(); promise.resolve(true)
    }

    @ReactMethod fun readDir(p: String, promise: Promise) {
        val arr = WritableNativeArray()
        File(p).listFiles()?.forEach { f ->
            arr.pushMap(WritableNativeMap().apply {
                putString("name", f.name)
                putString("path", f.absolutePath)
                putBoolean("isDirectory", f.isDirectory)
                putDouble("size", f.length().toDouble())
            })
        }
        promise.resolve(arr)
    }

    // ── SHA-256 ────────────────────────────────────────────────────

    @ReactMethod fun sha256File(p: String, promise: Promise) {
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            FileInputStream(p).use { fis ->
                val buf = ByteArray(8192); var n: Int
                while (fis.read(buf).also { n = it } != -1) digest.update(buf, 0, n)
            }
            promise.resolve(digest.digest().joinToString("") { "%02x".format(it) })
        } catch (e: Exception) { promise.reject("HASH", e.message) }
    }
}
