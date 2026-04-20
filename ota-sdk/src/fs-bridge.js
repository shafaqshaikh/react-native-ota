/**
 * Filesystem bridge — abstracts file operations so the SDK works with
 * react-native-fs or the native OTA module's file helpers.
 *
 * If react-native-fs is installed, we use it. Otherwise, we fall back
 * to the OTANative module which exposes the same essential operations.
 */

const { NativeModules, Platform } = require('react-native');

let _fs = null;

function getFS() {
  if (_fs) return _fs;

  // Try react-native-fs first
  try {
    _fs = require('react-native-fs');
    return _fs;
  } catch (e) {
    // Fall back to our native module
  }

  const OTANative = NativeModules.OTAModule;
  if (!OTANative) {
    throw new Error(
      '[OTA] No filesystem module available. Install react-native-fs or link the OTA native module.'
    );
  }

  // Wrap native module to match RNFS interface
  _fs = {
    DocumentDirectoryPath: OTANative.documentDirectory,

    async mkdir(path) {
      return OTANative.mkdir(path);
    },
    async exists(path) {
      return OTANative.exists(path);
    },
    async readFile(path, encoding) {
      return OTANative.readFile(path, encoding || 'utf8');
    },
    async writeFile(path, content, encoding) {
      return OTANative.writeFile(path, content, encoding || 'utf8');
    },
    async moveFile(src, dest) {
      return OTANative.moveFile(src, dest);
    },
    async unlink(path) {
      return OTANative.deleteFile(path);
    },
    async readDir(path) {
      return OTANative.readDir(path);
    },
    async downloadFile(options) {
      return OTANative.downloadFile(options.fromUrl, options.toFile);
    },
  };

  return _fs;
}

// Export as a proxy so we can lazily initialize
module.exports = new Proxy(
  {},
  {
    get(target, prop) {
      const fs = getFS();
      if (typeof fs[prop] === 'function') {
        return fs[prop].bind(fs);
      }
      return fs[prop];
    },
  }
);