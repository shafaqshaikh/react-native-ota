/**
 * Expo config plugin for react-native-ota-updates.
 *
 * Usage in app.config.js:
 *   plugins: [
 *     ['react-native-ota-updates', { serverUrl: 'https://ota.example.com' }]
 *   ]
 *
 * This plugin:
 * 1. Android: Adds OTAUpdatesPackage + crash handler to MainApplication
 * 2. Android: Overrides getJSBundleFile() to check OTA bundle
 * 3. iOS: Adds OTAUpdatesModule.setup() to AppDelegate
 * 4. iOS: Overrides bundleURL() to check OTA bundle in release builds
 */

const {
  withMainApplication,
  withAppDelegate,
  createRunOncePlugin,
} = require('@expo/config-plugins');

const pkg = require('../package.json');

function withOTAUpdatesAndroid(config) {
  return withMainApplication(config, (cfg) => {
    let src = cfg.modResults.contents;

    // Skip if already patched
    if (src.includes('OTAUpdatesModule')) return cfg;

    // 1. Add import
    const importLine = 'import com.otaupdates.OTAUpdatesModule\nimport com.otaupdates.OTAUpdatesPackage';
    src = src.replace(
      /(import .+\n)(?=\s*class\s)/,
      `$1${importLine}\n\n`,
    );

    // If the simple regex didn't work, try inserting after the last import
    if (!src.includes('import com.otaupdates')) {
      const lastImport = src.lastIndexOf('import ');
      const eol = src.indexOf('\n', lastImport);
      src = src.slice(0, eol + 1) + importLine + '\n' + src.slice(eol + 1);
    }

    // 2. Add OTAUpdatesPackage to getPackages()
    src = src.replace(
      /(PackageList\(this\)\.packages\.apply\s*\{)/,
      '$1\n              add(OTAUpdatesPackage())',
    );

    // 3. Add getJSBundleFile override (after getPackages block)
    if (!src.includes('getJSBundleFile')) {
      src = src.replace(
        /(override fun getPackages\(\)[\s\S]*?\})/,
        '$1\n\n          override fun getJSBundleFile(): String? =\n' +
        '            OTAUpdatesModule.getBundleFile(this@MainApplication) ?: super.getJSBundleFile()',
      );
    }

    // 4. Add crash handler install in onCreate
    if (!src.includes('OTAUpdatesModule.install')) {
      src = src.replace(
        /(override fun onCreate\(\)\s*\{[\s\S]*?super\.onCreate\(\))/,
        '$1\n    OTAUpdatesModule.install(this)',
      );
    }

    cfg.modResults.contents = src;
    return cfg;
  });
}

function withOTAUpdatesIOS(config) {
  return withAppDelegate(config, (cfg) => {
    let src = cfg.modResults.contents;

    if (src.includes('OTAUpdatesModule')) return cfg;

    // Detect language
    const isSwift = cfg.modResults.language === 'swift' || src.includes('ExpoAppDelegate');

    if (isSwift) {
      // Swift AppDelegate

      // 1. Add setup() call in didFinishLaunching
      src = src.replace(
        /(didFinishLaunchingWithOptions[\s\S]*?\{)/,
        '$1\n    OTAUpdatesModule.setup()',
      );

      // 2. Override bundleURL() to check OTA in release
      if (src.includes('override func bundleURL()')) {
        src = src.replace(
          /(override func bundleURL\(\) -> URL\? \{)/,
          '$1\n    #if !DEBUG\n    if let ota = OTAUpdatesModule.bundleURL() { return ota }\n    #endif',
        );
      }
    } else {
      // Obj-C AppDelegate

      // 1. Add import
      if (!src.includes('#import "OTAUpdatesModule.h"')) {
        src = src.replace(
          /(#import "AppDelegate.h")/,
          '$1\n#import "OTAUpdatesModule.h"',
        );
      }

      // 2. Add setup() in didFinishLaunching
      src = src.replace(
        /(didFinishLaunchingWithOptions[\s\S]*?\{)/,
        '$1\n  [OTAUpdatesModule setup];',
      );
    }

    cfg.modResults.contents = src;
    return cfg;
  });
}

function withOTAUpdates(config, _props) {
  config = withOTAUpdatesAndroid(config);
  config = withOTAUpdatesIOS(config);
  return config;
}

module.exports = createRunOncePlugin(withOTAUpdates, pkg.name, pkg.version);
