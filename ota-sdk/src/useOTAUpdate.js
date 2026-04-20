/**
 * React hook for OTA updates.
 *
 * Usage:
 *   const { status, progress, error, checkNow, applyNow } = useOTAUpdate();
 */

const { useState, useEffect, useCallback } = require('react');
const { checkForUpdate, downloadUpdate, applyUpdate, getCurrentVersion } = require('./updater');
const logger = require('./logger');

// Status enum for UI consumption
const OTA_STATUS = {
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  READY: 'ready',        // Downloaded, ready to apply
  APPLYING: 'applying',
  UP_TO_DATE: 'up_to_date',
  ERROR: 'error',
};

function useOTAUpdate(options = {}) {
  const { autoCheck = false, autoDownload = false } = options;

  const [status, setStatus] = useState(OTA_STATUS.IDLE);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [downloadResult, setDownloadResult] = useState(null);
  const [error, setError] = useState(null);
  const [currentVersion, setCurrentVersion] = useState(null);

  // Load current version info on mount
  useEffect(() => {
    getCurrentVersion().then(setCurrentVersion).catch(() => {});
  }, []);

  const checkNow = useCallback(async () => {
    setStatus(OTA_STATUS.CHECKING);
    setError(null);

    try {
      const update = await checkForUpdate();
      if (update) {
        setUpdateInfo(update);
        setStatus(OTA_STATUS.AVAILABLE);

        if (autoDownload) {
          return downloadNow(update);
        }
        return update;
      } else {
        setStatus(OTA_STATUS.UP_TO_DATE);
        return null;
      }
    } catch (err) {
      setError(err.message);
      setStatus(OTA_STATUS.ERROR);
      logger.error('Hook check failed', { error: err.message });
      return null;
    }
  }, [autoDownload]);

  const downloadNow = useCallback(async (info) => {
    const target = info || updateInfo;
    if (!target) {
      setError('No update to download');
      return null;
    }

    setStatus(OTA_STATUS.DOWNLOADING);
    setError(null);

    try {
      const result = await downloadUpdate(target);
      if (result) {
        setDownloadResult(result);
        setStatus(OTA_STATUS.READY);
        return result;
      } else {
        throw new Error('Download returned null');
      }
    } catch (err) {
      setError(err.message);
      setStatus(OTA_STATUS.ERROR);
      return null;
    }
  }, [updateInfo]);

  const applyNow = useCallback(async (result) => {
    const target = result || downloadResult;
    if (!target) {
      setError('No downloaded update to apply');
      return false;
    }

    setStatus(OTA_STATUS.APPLYING);
    setError(null);

    try {
      const success = await applyUpdate(target);
      if (success) {
        setStatus(OTA_STATUS.IDLE);
        return true;
      } else {
        throw new Error('Apply returned false');
      }
    } catch (err) {
      setError(err.message);
      setStatus(OTA_STATUS.ERROR);
      return false;
    }
  }, [downloadResult]);

  // Auto-check on mount
  useEffect(() => {
    if (autoCheck) {
      const timer = setTimeout(checkNow, 3000);
      return () => clearTimeout(timer);
    }
  }, [autoCheck, checkNow]);

  return {
    status,
    updateInfo,
    downloadResult,
    error,
    currentVersion,
    checkNow,
    downloadNow,
    applyNow,
    OTA_STATUS,
  };
}

module.exports = { useOTAUpdate, OTA_STATUS };