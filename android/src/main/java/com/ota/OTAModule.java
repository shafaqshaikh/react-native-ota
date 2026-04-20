package com.ota;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.WritableNativeArray;
import com.facebook.react.bridge.WritableNativeMap;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;

/**
 * Native module for OTA updates on Android.
 *
 * Responsibilities:
 * - Provide document directory path
 * - File system operations (mkdir, read, write, move, delete)
 * - SHA256 file hashing
 * - Bundle path management for dynamic loading
 * - Crash detection and rollback
 */
public class OTAModule extends ReactContextBaseJavaModule {

    private static final String TAG = "OTAModule";
    private static final String PREFS_NAME = "OTAPrefs";
    private static final String KEY_BUNDLE_PATH = "bundlePath";
    private static final String KEY_LAUNCH_COUNT = "launchCount";
    private static final String KEY_LAST_CRASH_TIME = "lastCrashTime";
    private static final int CRASH_THRESHOLD_MS = 10000; // 10 seconds

    private final ReactApplicationContext reactContext;

    // Static reference so getJSBundleFile() can access it without an instance
    private static String sBundlePath = null;
    private static boolean sInitialized = false;

    public OTAModule(ReactApplicationContext context) {
        super(context);
        this.reactContext = context;

        if (!sInitialized) {
            sInitialized = true;
            initializeFromPrefs(context);
        }
    }

    @NonNull
    @Override
    public String getName() {
        return "OTAModule";
    }

    @Override
    public Map<String, Object> getConstants() {
        final Map<String, Object> constants = new HashMap<>();
        constants.put("documentDirectory", getDocumentDir());
        return constants;
    }

    // ============================================================
    // Bundle path management
    // ============================================================

    /**
     * Called from JS to set the bundle path for the NEXT app launch.
     */
    @ReactMethod
    public void setNextBundlePath(String path, Promise promise) {
        try {
            SharedPreferences prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_BUNDLE_PATH, path).apply();
            sBundlePath = path;
            Log.i(TAG, "Next bundle path set: " + path);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("SET_BUNDLE_ERROR", e.getMessage());
        }
    }

    /**
     * Clear the custom bundle path — revert to the built-in bundle.
     */
    @ReactMethod
    public void clearBundlePath(Promise promise) {
        try {
            SharedPreferences prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().remove(KEY_BUNDLE_PATH).apply();
            sBundlePath = null;
            Log.i(TAG, "Bundle path cleared, will use default");
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("CLEAR_BUNDLE_ERROR", e.getMessage());
        }
    }

    /**
     * Static method called by the Application class to get the bundle file path.
     * This is the KEY integration point.
     *
     * Usage in MainApplication.java:
     *   @Override
     *   protected String getJSBundleFile() {
     *       String otaBundle = OTAModule.getJSBundleFile(this);
     *       return otaBundle != null ? otaBundle : super.getJSBundleFile();
     *   }
     */
    @Nullable
    public static String getJSBundleFile(Context context) {
        if (!sInitialized) {
            initializeFromPrefs(context);
            sInitialized = true;
        }

        if (sBundlePath != null) {
            File bundleFile = new File(sBundlePath);
            if (bundleFile.exists()) {
                Log.i(TAG, "Loading OTA bundle: " + sBundlePath);

                // Record launch time for crash detection
                recordLaunchTime(context);
                return sBundlePath;
            } else {
                Log.w(TAG, "OTA bundle not found at: " + sBundlePath + ", falling back to default");
                // Clear the invalid path
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .edit().remove(KEY_BUNDLE_PATH).apply();
                sBundlePath = null;
            }
        }

        return null; // Use default bundle
    }

    /**
     * Load the persisted bundle path from SharedPreferences.
     * Also performs crash detection.
     */
    private static void initializeFromPrefs(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        sBundlePath = prefs.getString(KEY_BUNDLE_PATH, null);

        // --- Crash detection ---
        // If the app crashed quickly after last launch while using an OTA bundle,
        // we should rollback to the default bundle.
        if (sBundlePath != null) {
            long lastCrash = prefs.getLong(KEY_LAST_CRASH_TIME, 0);
            long now = System.currentTimeMillis();

            // If two crashes happened within threshold, rollback
            int launchCount = prefs.getInt(KEY_LAUNCH_COUNT, 0);
            if (launchCount >= 2 && (now - lastCrash) < CRASH_THRESHOLD_MS * 3) {
                Log.w(TAG, "Multiple quick crashes detected! Rolling back to default bundle.");
                prefs.edit()
                        .remove(KEY_BUNDLE_PATH)
                        .putInt(KEY_LAUNCH_COUNT, 0)
                        .apply();
                sBundlePath = null;
            }
        }
    }

    private static void recordLaunchTime(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int count = prefs.getInt(KEY_LAUNCH_COUNT, 0);
        prefs.edit()
                .putLong(KEY_LAST_CRASH_TIME, System.currentTimeMillis())
                .putInt(KEY_LAUNCH_COUNT, count + 1)
                .apply();
    }

    /**
     * Call this from JS when the app is confirmed running fine.
     * Resets the crash counter.
     */
    @ReactMethod
    public void confirmLaunchSuccess(Promise promise) {
        try {
            SharedPreferences prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putInt(KEY_LAUNCH_COUNT, 0).apply();
            Log.i(TAG, "Launch confirmed successful, crash counter reset");
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("CONFIRM_ERROR", e.getMessage());
        }
    }

    // ============================================================
    // File system operations (used by ota-sdk's fs-bridge)
    // ============================================================

    @ReactMethod
    public void mkdir(String path, Promise promise) {
        try {
            File dir = new File(path);
            if (!dir.exists()) {
                dir.mkdirs();
            }
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("MKDIR_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void exists(String path, Promise promise) {
        promise.resolve(new File(path).exists());
    }

    @ReactMethod
    public void readFile(String path, String encoding, Promise promise) {
        try {
            File file = new File(path);
            byte[] bytes = new byte[(int) file.length()];
            FileInputStream fis = new FileInputStream(file);
            fis.read(bytes);
            fis.close();

            if ("base64".equals(encoding)) {
                promise.resolve(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
            } else {
                promise.resolve(new String(bytes, "UTF-8"));
            }
        } catch (Exception e) {
            promise.reject("READ_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void writeFile(String path, String content, String encoding, Promise promise) {
        try {
            File file = new File(path);
            File parent = file.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }

            FileOutputStream fos = new FileOutputStream(file);
            if ("base64".equals(encoding)) {
                byte[] bytes = android.util.Base64.decode(content, android.util.Base64.DEFAULT);
                fos.write(bytes);
            } else {
                fos.write(content.getBytes("UTF-8"));
            }
            fos.close();
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("WRITE_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void moveFile(String src, String dest, Promise promise) {
        try {
            File srcFile = new File(src);
            File destFile = new File(dest);

            // Ensure parent dirs exist
            File parent = destFile.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }

            if (srcFile.renameTo(destFile)) {
                promise.resolve(true);
            } else {
                // Fallback: copy + delete (cross-filesystem moves)
                copyFile(srcFile, destFile);
                srcFile.delete();
                promise.resolve(true);
            }
        } catch (Exception e) {
            promise.reject("MOVE_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void deleteFile(String path, Promise promise) {
        try {
            File file = new File(path);
            deleteRecursive(file);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("DELETE_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void readDir(String path, Promise promise) {
        try {
            File dir = new File(path);
            File[] files = dir.listFiles();
            WritableArray result = new WritableNativeArray();

            if (files != null) {
                for (File file : files) {
                    WritableMap item = new WritableNativeMap();
                    item.putString("name", file.getName());
                    item.putString("path", file.getAbsolutePath());
                    item.putBoolean("isDirectory", file.isDirectory());
                    item.putDouble("size", file.length());
                    result.pushMap(item);
                }
            }

            promise.resolve(result);
        } catch (Exception e) {
            promise.reject("READDIR_ERROR", e.getMessage());
        }
    }

    // ============================================================
    // SHA256 hashing
    // ============================================================

    @ReactMethod
    public void sha256File(String path, Promise promise) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            FileInputStream fis = new FileInputStream(new File(path));
            byte[] buffer = new byte[8192];
            int bytesRead;

            while ((bytesRead = fis.read(buffer)) != -1) {
                digest.update(buffer, 0, bytesRead);
            }
            fis.close();

            byte[] hashBytes = digest.digest();
            StringBuilder hex = new StringBuilder();
            for (byte b : hashBytes) {
                hex.append(String.format("%02x", b));
            }

            promise.resolve(hex.toString());
        } catch (Exception e) {
            promise.reject("HASH_ERROR", e.getMessage());
        }
    }

    // ============================================================
    // Helpers
    // ============================================================

    private String getDocumentDir() {
        return reactContext.getFilesDir().getAbsolutePath();
    }

    private void deleteRecursive(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursive(child);
                }
            }
        }
        file.delete();
    }

    private void copyFile(File src, File dest) throws IOException {
        InputStream in = new FileInputStream(src);
        OutputStream out = new FileOutputStream(dest);
        byte[] buffer = new byte[8192];
        int len;
        while ((len = in.read(buffer)) > 0) {
            out.write(buffer, 0, len);
        }
        in.close();
        out.close();
    }
}