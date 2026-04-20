package com.otaupdates

import android.content.Context
import android.content.pm.PackageManager
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.*
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class OTAUpdatesModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    companion object {
        private const val TAG = "OTAUpdates"
        private const val PREFS = "OTAUpdatesPrefs"
        private const val K_BUNDLE = "bundlePath"
        private const val K_LAUNCHES = "launchCount"
        private const val K_DID_CRASH = "didCrash"
        private const val MAX_CRASHES = 2

        // Strict timeouts so launch never blocks more than ~17s total
        private const val CHECK_TIMEOUT_MS = 3_000
        private const val MANIFEST_TIMEOUT_MS = 2_000
        private const val BUNDLE_TIMEOUT_MS = 12_000

        private var sBundlePath: String? = null
        private var sInit = false

        /**
         * Call from MainApplication.getJSBundleFile() to load OTA bundle.
         * Performs a synchronous check + download (with strict timeouts) and
         * returns the new bundle path, or the cached one, or null to fall
         * through to the embedded index.android.bundle.
         */
        @JvmStatic
        fun getBundleFile(context: Context): String? {
            if (!sInit) { init(context); sInit = true }

            // Run check + download on a background thread with a HARD 17-second
            // total cap. Network on the main thread would throw
            // NetworkOnMainThreadException; this also keeps the launch fast.
            val latch = java.util.concurrent.CountDownLatch(1)
            Thread {
                try {
                    checkAndDownloadOnLaunchBlocking(context)
                } catch (e: Exception) {
                    Log.w(TAG, "checkAndDownloadOnLaunchBlocking failed: ${e.message}")
                } finally {
                    latch.countDown()
                }
            }.apply {
                isDaemon = true
                name = "OTAUpdatesLaunchCheck"
            }.start()

            // Wait at most 17 seconds for the whole flow
            if (!latch.await(17, java.util.concurrent.TimeUnit.SECONDS)) {
                Log.w(TAG, "OTA launch check exceeded 17s, falling through")
            }

            // Re-read after the (possibly) updated path
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            sBundlePath = prefs.getString(K_BUNDLE, null)

            val p = sBundlePath ?: return null
            if (File(p).exists()) {
                Log.i(TAG, "Loading OTA bundle: $p")
                recordLaunch(context)
                return p
            }

            Log.w(TAG, "OTA bundle missing at $p — falling back")
            prefs.edit().remove(K_BUNDLE).apply()
            sBundlePath = null
            return null
        }

        /**
         * Synchronous launch-time check + download. Mirrors the iOS flow with
         * the same strict timeouts (3s/2s/12s = ~17s max).
         */
        private fun checkAndDownloadOnLaunchBlocking(context: Context) {
            val meta = getMetaData(context) ?: return
            val serverUrl = meta.getString("OTAUpdatesServerUrl") ?: return
            if (serverUrl.isEmpty()) {
                Log.i(TAG, "No OTAUpdatesServerUrl meta-data, skipping")
                return
            }

            val appVersion = try {
                context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "1.0.0"
            } catch (_: Exception) { "1.0.0" }
            val runtimeVersion = appVersion
            val projectId = meta.getString("OTAUpdatesProjectId") ?: ""
            val channel = meta.getString("OTAUpdatesChannel") ?: "production"

            // Get current update id from path
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val currentBundle = prefs.getString(K_BUNDLE, null)
            val currentId = currentBundle?.let {
                val parts = it.split('/')
                if (parts.size >= 2) parts[parts.size - 2] else ""
            } ?: ""

            // ── /check ──────────────────────────────────────────────
            val endpoint = if (projectId.isNotEmpty()) "/v1/check" else "/check"
            val checkUrl = "$serverUrl$endpoint?appVersion=$appVersion" +
                "&runtimeVersion=$runtimeVersion" +
                "&currentUpdateId=$currentId" +
                "&platform=android" +
                (if (projectId.isNotEmpty()) "&projectId=$projectId&channel=$channel" else "")
            Log.i(TAG, "Launch check: $checkUrl")
            val checkResult = httpGetJson(checkUrl, CHECK_TIMEOUT_MS) ?: return
            if (!checkResult.optBoolean("available", false)) {
                Log.i(TAG, "No update available")
                return
            }

            val updateId = checkResult.optString("updateId", "")
            val expectedHash = checkResult.optString("bundleHash", "")
            val manifestUrl = checkResult.optString("manifestUrl", "")
            if (updateId.isEmpty() || expectedHash.isEmpty() || manifestUrl.isEmpty()) return

            Log.i(TAG, "Downloading update $updateId")

            // ── /manifest ────────────────────────────────────────────
            val manifestFullUrl = absoluteUrl(serverUrl, manifestUrl)
            val manifest = httpGetJson(manifestFullUrl, MANIFEST_TIMEOUT_MS) ?: return
            val bundleUrlPath = manifest.optString("bundleUrl", "")
            if (bundleUrlPath.isEmpty()) return
            val bundleFullUrl = absoluteUrl(serverUrl, bundleUrlPath)

            // ── /bundle ──────────────────────────────────────────────
            val dir = File(context.filesDir, "OTAUpdates/$updateId")
            dir.mkdirs()
            val destFile = File(dir, "bundle.hbc")
            try {
                httpDownload(bundleFullUrl, destFile, BUNDLE_TIMEOUT_MS)
            } catch (e: Exception) {
                Log.w(TAG, "Bundle download failed: ${e.message}")
                destFile.delete()
                return
            }

            // ── SHA-256 verify ───────────────────────────────────────
            val actualHash = sha256(destFile)
            if (actualHash != expectedHash) {
                Log.w(TAG, "Hash mismatch! Expected $expectedHash, got $actualHash")
                destFile.delete()
                return
            }

            // ── Download assets zip and extract ──────────────────────
            // One HTTP GET + native unzip is ~10x faster than 244 sequential
            // asset GETs. Assets land under <bundleDir>/drawable-*dpi/... so
            // RN's default drawableFolderInBundle() resolver finds them.
            val assetsZipUrl = manifest.optString("assetsZipUrl", "")
            val assetsZipHash = manifest.optString("assetsZipHash", "")
            if (assetsZipUrl.isNotEmpty()) {
                Log.i(TAG, "Downloading assets zip")
                val zipFile = File(dir, "assets.zip")
                try {
                    httpDownload(absoluteUrl(serverUrl, assetsZipUrl), zipFile, BUNDLE_TIMEOUT_MS)
                } catch (e: Exception) {
                    Log.w(TAG, "Assets zip download failed: ${e.message}")
                    dir.deleteRecursively()
                    return
                }
                if (assetsZipHash.isNotEmpty()) {
                    val actualZipHash = sha256(zipFile)
                    if (actualZipHash != assetsZipHash) {
                        Log.w(TAG, "Assets zip hash mismatch. Expected $assetsZipHash, got $actualZipHash")
                        dir.deleteRecursively()
                        return
                    }
                }
                try {
                    unzip(zipFile, dir)
                } catch (e: Exception) {
                    Log.w(TAG, "Assets zip extract failed: ${e.message}")
                    dir.deleteRecursively()
                    return
                }
                zipFile.delete()
                Log.i(TAG, "Assets extracted")
            }

            // ── Persist new bundle path ──────────────────────────────
            prefs.edit()
                .putString(K_BUNDLE, destFile.absolutePath)
                .putInt(K_LAUNCHES, 0)
                .putBoolean(K_DID_CRASH, false)
                .apply()
            sBundlePath = destFile.absolutePath
            Log.i(TAG, "Update $updateId ready, will load now")
        }

        private fun getMetaData(context: Context): android.os.Bundle? {
            return try {
                context.packageManager.getApplicationInfo(
                    context.packageName,
                    PackageManager.GET_META_DATA
                ).metaData
            } catch (_: Exception) { null }
        }

        private fun httpGetJson(urlStr: String, timeoutMs: Int): JSONObject? {
            return try {
                val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                    connectTimeout = timeoutMs
                    readTimeout = timeoutMs
                    setRequestProperty("Accept-Encoding", "gzip")
                }
                if (conn.responseCode != 200) {
                    Log.w(TAG, "HTTP ${conn.responseCode} from $urlStr")
                    conn.disconnect()
                    return null
                }
                val stream = if ("gzip" == conn.contentEncoding) {
                    java.util.zip.GZIPInputStream(conn.inputStream)
                } else conn.inputStream
                val text = stream.bufferedReader().use { it.readText() }
                conn.disconnect()
                JSONObject(text)
            } catch (e: Exception) {
                Log.w(TAG, "httpGetJson failed for $urlStr: ${e.message}")
                null
            }
        }

        private fun httpDownload(urlStr: String, dest: File, timeoutMs: Int) {
            val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Accept-Encoding", "gzip")
            }
            if (conn.responseCode != 200) {
                conn.disconnect()
                throw RuntimeException("HTTP ${conn.responseCode}")
            }
            val stream = if ("gzip" == conn.contentEncoding) {
                java.util.zip.GZIPInputStream(conn.inputStream)
            } else conn.inputStream
            stream.use { input ->
                dest.outputStream().use { output ->
                    input.copyTo(output, 8192)
                }
            }
            conn.disconnect()
        }

        private fun unzip(zipFile: File, destDir: File) {
            val destCanonical = destDir.canonicalFile
            java.util.zip.ZipInputStream(java.io.FileInputStream(zipFile)).use { zis ->
                var entry = zis.nextEntry
                while (entry != null) {
                    val target = File(destDir, entry.name)
                    // Path traversal guard
                    val targetCanonical = target.canonicalFile
                    if (!targetCanonical.path.startsWith(destCanonical.path + File.separator) &&
                        targetCanonical.path != destCanonical.path) {
                        throw SecurityException("Unsafe zip entry: ${entry.name}")
                    }
                    if (entry.isDirectory) {
                        target.mkdirs()
                    } else {
                        target.parentFile?.mkdirs()
                        target.outputStream().use { out -> zis.copyTo(out, 8192) }
                    }
                    zis.closeEntry()
                    entry = zis.nextEntry
                }
            }
        }

        private fun absoluteUrl(serverUrl: String, url: String): String {
            return if (url.startsWith("http://") || url.startsWith("https://")) url
            else "$serverUrl$url"
        }

        private fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            FileInputStream(file).use { fis ->
                val buf = ByteArray(8192)
                var n: Int
                while (fis.read(buf).also { n = it } != -1) digest.update(buf, 0, n)
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }

        /**
         * Call from Application.onCreate() to install crash detection.
         */
        @JvmStatic
        fun install(context: Context) {
            val prev = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { t, e ->
                try {
                    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    prefs.edit()
                        .putBoolean(K_DID_CRASH, true)
                        .putInt(K_LAUNCHES, prefs.getInt(K_LAUNCHES, 0) + 1)
                        .apply()
                } catch (_: Exception) {}
                prev?.uncaughtException(t, e)
            }
            Log.i(TAG, "Crash handler installed")
        }

        private fun init(context: Context) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            sBundlePath = prefs.getString(K_BUNDLE, null)

            if (sBundlePath != null) {
                val didCrash = prefs.getBoolean(K_DID_CRASH, false)
                if (!didCrash) {
                    // No crash since last launch — reset counter
                    prefs.edit().putInt(K_LAUNCHES, 0).apply()
                    return
                }
                // A crash happened
                prefs.edit().putBoolean(K_DID_CRASH, false).apply()
                val launches = prefs.getInt(K_LAUNCHES, 0)
                if (launches >= MAX_CRASHES) {
                    Log.w(TAG, "Crash loop ($launches crashes)! Rolling back")
                    prefs.edit().remove(K_BUNDLE).putInt(K_LAUNCHES, 0).apply()
                    sBundlePath = null
                }
            }
        }

        private fun recordLaunch(context: Context) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            prefs.edit()
                .putInt(K_LAUNCHES, prefs.getInt(K_LAUNCHES, 0) + 1)
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

    @ReactMethod
    fun reload(promise: Promise) {
        try {
            val activity = ctx.currentActivity
            if (activity == null) {
                promise.reject("RELOAD", "No current activity")
                return
            }
            activity.runOnUiThread {
                try {
                    val app = activity.application as com.facebook.react.ReactApplication
                    val rim = app.reactNativeHost.reactInstanceManager
                    rim.recreateReactContextInBackground()
                    promise.resolve(true)
                } catch (e: Exception) {
                    promise.reject("RELOAD", e.message)
                }
            }
        } catch (e: Exception) {
            promise.reject("RELOAD", e.message)
        }
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

    // ── Download file (bypasses JS base64 for large binaries) ──────

    @ReactMethod fun downloadFile(urlStr: String, dest: String, promise: Promise) {
        Thread {
            try {
                val url = java.net.URL(urlStr)
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 30_000
                conn.readTimeout = 300_000
                conn.connect()
                if (conn.responseCode != 200) {
                    promise.reject("DL", "HTTP ${conn.responseCode}")
                    return@Thread
                }
                val destFile = File(dest)
                destFile.parentFile?.mkdirs()
                conn.inputStream.use { input ->
                    destFile.outputStream().use { output ->
                        input.copyTo(output, 8192)
                    }
                }
                conn.disconnect()
                promise.resolve(dest)
            } catch (e: Exception) {
                promise.reject("DL", e.message)
            }
        }.start()
    }

    // ── Unzip ──────────────────────────────────────────────────────

    @ReactMethod fun unzipFile(zipPath: String, destDir: String, promise: Promise) {
        Thread {
            try {
                unzip(File(zipPath), File(destDir))
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("UNZIP", e.message)
            }
        }.start()
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
