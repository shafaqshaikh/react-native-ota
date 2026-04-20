package com.ota;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

/**
 * Uncaught exception handler for crash detection.
 *
 * Intercepts crashes and records them so the next launch can detect
 * whether the OTA bundle caused a crash and roll back.
 *
 * Install in Application.onCreate():
 *   OTAExceptionHandler.install(this);
 */
public class OTAExceptionHandler implements Thread.UncaughtExceptionHandler {

    private static final String TAG = "OTAExceptionHandler";
    private static final String PREFS_NAME = "OTAPrefs";
    private static final String KEY_LAST_CRASH_TIME = "lastCrashTime";

    private final Context context;
    private final Thread.UncaughtExceptionHandler defaultHandler;

    private OTAExceptionHandler(Context context) {
        this.context = context.getApplicationContext();
        this.defaultHandler = Thread.getDefaultUncaughtExceptionHandler();
    }

    /**
     * Install the OTA crash handler. Chains with the existing handler.
     */
    public static void install(Context context) {
        Thread.setDefaultUncaughtExceptionHandler(new OTAExceptionHandler(context));
        Log.i(TAG, "OTA crash handler installed");
    }

    @Override
    public void uncaughtException(Thread thread, Throwable throwable) {
        try {
            Log.e(TAG, "Crash detected! Recording for OTA rollback.", throwable);

            // Record crash time so next launch can detect rapid crashes
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit()
                    .putLong(KEY_LAST_CRASH_TIME, System.currentTimeMillis())
                    .apply();

        } catch (Exception e) {
            // Don't let our handler crash the crash handler
            Log.e(TAG, "Error in crash handler", e);
        }

        // Pass to the original handler (which will show the crash dialog / kill the app)
        if (defaultHandler != null) {
            defaultHandler.uncaughtException(thread, throwable);
        }
    }
}