/**
 * OTA Updater — Core update lifecycle engine.
 *
 * Lifecycle:
 *   1. checkForUpdate()  — asks server if a new update is available
 *   2. downloadUpdate()  — downloads bundle + assets, verifies hash
 *   3. applyUpdate()     — marks update as pending; activated on next app launch
 *
 * Rollback:
 *   On app start, the native module checks if the current update is "pending".
 *   If the app crashes within the first launch, it reverts to "previous".
 *   If the app survives, it marks the update as "stable".
 */

const { NativeModules, Platform } = require('react-native');
const { OTAConfig } = require('./config');
const storage = require('./storage');
const { verifyHash } = require('./hash');
const RNFS = require('./fs-bridge');
const logger = require('./logger');

// States for the update lifecycle
const UPDATE_STATUS = {
  PENDING: 'pending',     // Downloaded, will activate on next launch
  STABLE: 'stable',       // Survived first launch — confirmed good
  ROLLBACK: 'rollback',   // Reverted from a failed update
};

/**
 * Check server for available updates.
 * Returns update info if available, null otherwise.
 */
async function checkForUpdate() {
  try {
    const current = await storage.getCurrent();
    const currentUpdateId = current?.updateId || '';

    const params = new URLSearchParams({
      appVersion: OTAConfig.appVersion,
      runtimeVersion: OTAConfig.runtimeVersion,
      currentUpdateId,
      clientId: OTAConfig.clientId,
    });

    const url = `${OTAConfig.serverUrl}/check?${params}`;
    logger.debug('Checking for update', { url });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OTAConfig.timeout);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const data = await response.json();

    if (!data.available) {
      logger.info('No update available');
      return null;
    }

    logger.info('Update available', { updateId: data.updateId });
    return {
      updateId: data.updateId,
      bundleHash: data.bundleHash,
      manifestUrl: data.manifestUrl,
      createdAt: data.createdAt,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.error('Update check timed out');
    } else {
      logger.error('Update check failed', { error: err.message });
    }
    return null;
  }
}

/**
 * Download an update's manifest, bundle, and assets.
 * Verifies integrity via SHA256 hash.
 *
 * @param {object} updateInfo — returned from checkForUpdate()
 * @returns {object} — { updateId, bundlePath, manifest } or null on failure
 */
async function downloadUpdate(updateInfo) {
  if (!updateInfo || !updateInfo.updateId) {
    logger.error('No update info provided');
    return null;
  }

  const { updateId, bundleHash, manifestUrl } = updateInfo;
  const updateDir = storage.getUpdateDir(updateId);

  try {
    await RNFS.mkdir(updateDir);

    // --- Step 1: Download manifest ---
    logger.info('Downloading manifest...');
    const manifestResponse = await fetch(`${OTAConfig.serverUrl}${manifestUrl}`);
    if (!manifestResponse.ok) {
      throw new Error(`Failed to download manifest: ${manifestResponse.status}`);
    }
    const manifest = await manifestResponse.json();

    // Save manifest locally
    await RNFS.writeFile(
      updateDir + '/manifest.json',
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    // --- Step 2: Download bundle ---
    logger.info('Downloading bundle...');
    const bundleUrl = `${OTAConfig.serverUrl}${manifest.bundleUrl}`;
    const tempBundlePath = updateDir + '/bundle.js.tmp';
    const finalBundlePath = updateDir + '/bundle.js';

    // Download to temp file first (atomic write pattern)
    const bundleResponse = await fetch(bundleUrl);
    if (!bundleResponse.ok) {
      throw new Error(`Failed to download bundle: ${bundleResponse.status}`);
    }

    // Read as array buffer and write to file
    const bundleArrayBuffer = await bundleResponse.arrayBuffer();
    const bundleBase64 = arrayBufferToBase64(bundleArrayBuffer);
    await RNFS.writeFile(tempBundlePath, bundleBase64, 'base64');

    // --- Step 3: Verify hash ---
    logger.info('Verifying bundle integrity...');
    const hashValid = await verifyHash(tempBundlePath, bundleHash);

    if (!hashValid) {
      // Clean up corrupt download
      await RNFS.unlink(tempBundlePath).catch(() => {});
      await RNFS.unlink(updateDir).catch(() => {});
      throw new Error('Bundle hash verification failed — possible corruption or tampering');
    }

    // Move temp to final path (atomic)
    await RNFS.moveFile(tempBundlePath, finalBundlePath);

    // --- Step 4: Download assets ---
    if (manifest.assets && manifest.assets.length > 0) {
      const assetsDir = updateDir + '/assets';
      await RNFS.mkdir(assetsDir);

      for (const asset of manifest.assets) {
        const assetUrl = `${OTAConfig.serverUrl}${asset.url}`;
        const assetPath = assetsDir + '/' + asset.name.replace(/\//g, '_');

        logger.debug('Downloading asset', { name: asset.name });
        const assetResponse = await fetch(assetUrl);
        if (assetResponse.ok) {
          const assetBuffer = await assetResponse.arrayBuffer();
          const assetBase64 = arrayBufferToBase64(assetBuffer);
          await RNFS.writeFile(assetPath, assetBase64, 'base64');

          // Verify asset hash if provided
          if (asset.hash) {
            const assetHashValid = await verifyHash(assetPath, asset.hash);
            if (!assetHashValid) {
              logger.warn('Asset hash mismatch, skipping', { name: asset.name });
            }
          }
        }
      }
    }

    logger.info('Download complete', { updateId });
    return { updateId, bundlePath: finalBundlePath, manifest };
  } catch (err) {
    logger.error('Download failed', { updateId, error: err.message });
    // Clean up partial download
    try {
      await RNFS.unlink(updateDir);
    } catch (cleanupErr) {
      // Directory may not exist
    }
    return null;
  }
}

/**
 * Mark a downloaded update as pending activation.
 * The update will be loaded on the next app restart.
 */
async function applyUpdate(downloadResult) {
  if (!downloadResult || !downloadResult.bundlePath) {
    logger.error('No download result to apply');
    return false;
  }

  try {
    const { updateId, bundlePath, manifest } = downloadResult;

    // Shift current → previous (for rollback)
    const current = await storage.getCurrent();
    if (current) {
      await storage.setPrevious(current);
    }

    // Set new update as current with pending status
    await storage.setCurrent({
      updateId,
      bundlePath,
      status: UPDATE_STATUS.PENDING,
      appVersion: manifest.appVersion,
      runtimeVersion: manifest.runtimeVersion,
      bundleHash: manifest.bundleHash,
      appliedAt: Date.now(),
    });

    // Tell native module about the new bundle path
    const OTANative = NativeModules.OTAModule;
    if (OTANative && OTANative.setNextBundlePath) {
      await OTANative.setNextBundlePath(bundlePath);
    }

    logger.info('Update applied (pending restart)', { updateId, bundlePath });

    // Clean up old updates (keep current + previous only)
    const previous = await storage.getPrevious();
    const keepIds = [updateId];
    if (previous?.updateId) keepIds.push(previous.updateId);
    await storage.cleanup(keepIds);

    return true;
  } catch (err) {
    logger.error('Apply failed', { error: err.message });
    return false;
  }
}

/**
 * Get current version info.
 */
async function getCurrentVersion() {
  const current = await storage.getCurrent();
  return {
    updateId: current?.updateId || null,
    bundlePath: current?.bundlePath || null,
    status: current?.status || 'default',
    appVersion: OTAConfig.appVersion,
    runtimeVersion: OTAConfig.runtimeVersion,
    isOTABundle: !!current?.updateId,
  };
}

/**
 * Mark the current update as stable (survived first launch).
 * Call this after the app has been running for a reasonable time.
 */
async function markStable() {
  const current = await storage.getCurrent();
  if (current && current.status === UPDATE_STATUS.PENDING) {
    current.status = UPDATE_STATUS.STABLE;
    current.confirmedAt = Date.now();
    await storage.setCurrent(current);
    logger.info('Update marked as stable', { updateId: current.updateId });
  }
}

/**
 * Rollback to the previous update (or default bundle).
 * Called automatically by the native module on crash, or manually.
 */
async function rollback() {
  const current = await storage.getCurrent();
  const previous = await storage.getPrevious();

  if (previous) {
    // Restore previous as current
    previous.status = UPDATE_STATUS.ROLLBACK;
    await storage.setCurrent(previous);
    await storage.setPrevious(null);

    const OTANative = NativeModules.OTAModule;
    if (OTANative && OTANative.setNextBundlePath) {
      await OTANative.setNextBundlePath(previous.bundlePath);
    }

    logger.warn('Rolled back to previous update', { updateId: previous.updateId });
    return true;
  }

  // No previous — revert to default bundle
  await storage.setCurrent(null);
  const OTANative = NativeModules.OTAModule;
  if (OTANative && OTANative.clearBundlePath) {
    await OTANative.clearBundlePath();
  }

  logger.warn('Rolled back to default bundle (no previous OTA update)');
  return true;
}

// --- Helpers ---

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return global.btoa(binary);
}

module.exports = {
  checkForUpdate,
  downloadUpdate,
  applyUpdate,
  getCurrentVersion,
  markStable,
  rollback,
  UPDATE_STATUS,
};