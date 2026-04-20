/**
 * react-native-ota-sdk — Main entry point
 *
 * Usage:
 *   import OTA from 'react-native-ota-sdk';
 *
 *   // Configure once at app startup
 *   OTA.configure({
 *     serverUrl: 'https://your-ota-server.com',
 *     appVersion: '1.0.0',
 *     runtimeVersion: '1.0.0',
 *     clientId: deviceId,
 *   });
 *
 *   // Check and apply updates
 *   const update = await OTA.checkForUpdate();
 *   if (update) {
 *     const result = await OTA.downloadUpdate(update);
 *     if (result) {
 *       await OTA.applyUpdate(result);
 *       // Update will activate on next app restart
 *     }
 *   }
 */

const { configure, OTAConfig } = require('./config');
const {
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  getCurrentVersion,
  markStable,
  rollback,
  UPDATE_STATUS,
} = require('./updater');
const logger = require('./logger');

/**
 * Initialize the OTA system. Call this on app startup.
 * Handles:
 *   1. Checking if a pending update survived its first launch
 *   2. Auto-marking as stable after a delay
 *   3. Starting background update check (optional)
 */
async function initialize(options = {}) {
  if (options.serverUrl) {
    configure(options);
  }

  const {
    autoCheck = true,
    stabilityDelay = 10000, // 10 seconds to confirm stability
  } = options;

  try {
    const current = await getCurrentVersion();

    if (current.status === UPDATE_STATUS.PENDING) {
      // This is the first launch after an update was applied.
      // Start a timer — if the app doesn't crash within stabilityDelay,
      // mark the update as stable.
      logger.info('Pending update detected, monitoring stability...', {
        updateId: current.updateId,
      });

      setTimeout(async () => {
        try {
          await markStable();
          logger.info('Update confirmed stable');
        } catch (err) {
          logger.error('Failed to mark stable', { error: err.message });
        }
      }, stabilityDelay);
    }

    // Auto-check for updates in the background
    if (autoCheck) {
      // Slight delay to not block app startup
      setTimeout(async () => {
        try {
          const update = await checkForUpdate();
          if (update) {
            logger.info('Background check found update', { updateId: update.updateId });
            // Emit event for the app to handle
            if (options.onUpdateAvailable) {
              options.onUpdateAvailable(update);
            }
          }
        } catch (err) {
          logger.debug('Background update check failed', { error: err.message });
        }
      }, 5000);
    }
  } catch (err) {
    logger.error('OTA initialization failed', { error: err.message });
  }
}

module.exports = {
  // Configuration
  configure,
  initialize,

  // Core lifecycle
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  getCurrentVersion,

  // Stability / rollback
  markStable,
  rollback,

  // Logging
  logger,

  // Constants
  UPDATE_STATUS,
};