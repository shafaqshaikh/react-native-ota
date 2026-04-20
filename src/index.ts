/**
 * react-native-ota-updates
 *
 * Production-grade OTA updates for React Native.
 *
 * @example
 * ```ts
 * import OTAUpdates from 'react-native-ota-updates';
 *
 * // 1. Configure on app start
 * OTAUpdates.configure({
 *   serverUrl: 'https://ota.yourcompany.com',
 *   appVersion: '1.4.9',
 *   runtimeVersion: '1.4.9',
 * });
 *
 * // 2. Initialize (monitors stability, optional auto-check)
 * OTAUpdates.initialize();
 *
 * // 3. Or manually check + download + apply
 * const check = await OTAUpdates.checkForUpdate();
 * if (check.available) {
 *   const download = await OTAUpdates.downloadUpdate(check);
 *   await OTAUpdates.applyUpdate(download);
 *   // Restart app to load the new bundle
 * }
 * ```
 */

// Patch RN's asset resolver before anything else loads. On Android, when the
// JS bundle is loaded from a file:// path (OTA), the default resolver looks
// for drawables next to the bundle file — which don't exist. Forcing
// `isLoadedFromFileSystem` to false makes it use APK resource IDs instead,
// so images/fonts continue to resolve from the .apk.
import './assetPatch';

import {
  configure,
  getConfig,
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  reloadAsync,
  markStable,
  rollback,
  getCurrentVersion,
} from './updater';
import type { InitializeOptions } from './types';

/**
 * Initialize the OTA system. Call once on app startup.
 *
 * - Monitors pending updates for stability (auto-rollback on crash)
 * - Optionally auto-checks for updates in background
 */
async function initialize(options: InitializeOptions = {}): Promise<void> {
  if (options.serverUrl) configure(options);

  const { autoCheck = true, stabilityDelay = 10000 } = options;

  try {
    const current = await getCurrentVersion();

    // If a pending update survived launch → schedule marking it stable
    if (current.status === 'pending') {
      setTimeout(() => markStable().catch(() => {}), stabilityDelay);
    }

    // Background update check
    if (autoCheck && getConfig().serverUrl) {
      setTimeout(async () => {
        try {
          const update = await checkForUpdate();
          if (update.available && options.onUpdateAvailable) {
            options.onUpdateAvailable(update);
          }
        } catch (err) {
          console.warn('[OTA] Auto-check failed:', err);
        }
      }, 5000);
    }
  } catch (err) {
    console.warn('[OTA] Initialize error:', err);
  }
}

const OTAUpdates = {
  configure,
  initialize,
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  reloadAsync,
  markStable,
  rollback,
  getCurrentVersion,
};

export default OTAUpdates;

export {
  configure,
  initialize,
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  reloadAsync,
  markStable,
  rollback,
  getCurrentVersion,
};

export type {
  OTAConfig,
  UpdateCheckResult,
  UpdateManifest,
  DownloadResult,
  UpdateMetadata,
  VersionInfo,
  InitializeOptions,
} from './types';
