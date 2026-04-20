/**
 * Asset resolution patch for Android OTA bundles.
 *
 * On Android, RN's AssetSourceResolver checks if the JS bundle was loaded
 * from a file system path. If yes, it looks for drawable assets next to
 * the bundle file (e.g. `<bundleDir>/drawable-mdpi/<id>.png`). For OTA
 * updates, the bundle lives in `/data/data/.../files/OTAUpdates/<id>/`
 * but the assets are still inside the APK, so this lookup fails.
 *
 * Forcing `isLoadedFromFileSystem` to return false makes the resolver
 * fall through to `resourceIdentifierWithoutScale()`, which uses APK
 * resource identifiers — these resolve correctly from the .apk regardless
 * of where the JS bundle came from.
 */
import { Platform } from 'react-native';

if (Platform.OS === 'android') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native/Libraries/Image/AssetSourceResolver');
    // Handle both ESM default export and CJS direct export
    const AssetSourceResolver = mod.default || mod;
    if (AssetSourceResolver && AssetSourceResolver.prototype) {
      AssetSourceResolver.prototype.isLoadedFromFileSystem = function () {
        return false;
      };
      console.log('[OTA] AssetSourceResolver patched for Android OTA bundles');
    } else {
      console.warn('[OTA] AssetSourceResolver not found at expected path');
    }
  } catch (e) {
    console.warn('[OTA] Failed to patch AssetSourceResolver:', e);
  }
}