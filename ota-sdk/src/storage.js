/**
 * OTA Local Storage Manager
 *
 * Directory structure:
 *   <documentsDir>/ota/
 *     current.json    — metadata for the active update
 *     previous.json   — metadata for the rollback update
 *     updates/
 *       <updateId>/
 *         bundle.js
 *         assets/
 *         manifest.json
 */

const { NativeModules, Platform } = require('react-native');
const RNFS = require('./fs-bridge'); // Thin abstraction over react-native-fs or native module
const logger = require('./logger');

const OTA_DIR_NAME = 'ota';
const UPDATES_DIR = 'updates';
const CURRENT_FILE = 'current.json';
const PREVIOUS_FILE = 'previous.json';

let _baseDir = null;

function getBaseDir() {
  if (_baseDir) return _baseDir;
  // Uses the app's documents directory — persists across app restarts
  _baseDir = RNFS.DocumentDirectoryPath + '/' + OTA_DIR_NAME;
  return _baseDir;
}

async function ensureDirs() {
  const base = getBaseDir();
  await RNFS.mkdir(base + '/' + UPDATES_DIR);
}

// --- Metadata read/write ---

async function readJSON(filePath) {
  try {
    const exists = await RNFS.exists(filePath);
    if (!exists) return null;
    const content = await RNFS.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    logger.error('Failed to read JSON', { filePath, error: err.message });
    return null;
  }
}

async function writeJSON(filePath, data) {
  await RNFS.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// --- Public API ---

async function getCurrent() {
  return readJSON(getBaseDir() + '/' + CURRENT_FILE);
}

async function getPrevious() {
  return readJSON(getBaseDir() + '/' + PREVIOUS_FILE);
}

async function setCurrent(metadata) {
  await ensureDirs();
  await writeJSON(getBaseDir() + '/' + CURRENT_FILE, metadata);
}

async function setPrevious(metadata) {
  await ensureDirs();
  await writeJSON(getBaseDir() + '/' + PREVIOUS_FILE, metadata);
}

/**
 * Returns the local path where a given update's files should be stored.
 */
function getUpdateDir(updateId) {
  return getBaseDir() + '/' + UPDATES_DIR + '/' + updateId;
}

function getBundlePath(updateId) {
  return getUpdateDir(updateId) + '/bundle.js';
}

/**
 * Save the downloaded bundle to local storage.
 */
async function saveBundle(updateId, tempBundlePath) {
  const updateDir = getUpdateDir(updateId);
  await RNFS.mkdir(updateDir);
  const destPath = getBundlePath(updateId);
  await RNFS.moveFile(tempBundlePath, destPath);
  logger.info('Bundle saved', { updateId, path: destPath });
  return destPath;
}

/**
 * Clean up old updates, keeping only current and previous.
 */
async function cleanup(keepIds) {
  try {
    const updatesDir = getBaseDir() + '/' + UPDATES_DIR;
    const exists = await RNFS.exists(updatesDir);
    if (!exists) return;

    const items = await RNFS.readDir(updatesDir);
    for (const item of items) {
      if (item.isDirectory() && !keepIds.includes(item.name)) {
        logger.info('Cleaning up old update', { id: item.name });
        await RNFS.unlink(item.path);
      }
    }
  } catch (err) {
    logger.warn('Cleanup failed', { error: err.message });
  }
}

module.exports = {
  getBaseDir,
  ensureDirs,
  getCurrent,
  getPrevious,
  setCurrent,
  setPrevious,
  getUpdateDir,
  getBundlePath,
  saveBundle,
  cleanup,
};