/**
 * Asset resolution for OTA bundles.
 *
 * Android: assets are shipped alongside the bundle (see cli/publish.js and
 * server/src/index.js). They land in `<bundleDir>/drawable-*dpi/...` etc,
 * which matches RN's default `drawableFolderInBundle()` resolver when the
 * bundle is loaded from the file system — so no patch is needed.
 *
 * iOS: the native module symlinks `<bundleDir>/assets` to the main bundle's
 * assets dir, so RN's default `scaledAssetURLNearBundle()` resolver finds
 * IPA-embedded assets. Also no JS patch needed.
 */
export {};