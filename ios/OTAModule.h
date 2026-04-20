#import <React/RCTBridgeModule.h>

/**
 * OTA Native Module for iOS.
 *
 * Provides:
 * - Bundle path management for dynamic loading
 * - File system operations
 * - SHA256 hashing
 * - Crash detection and rollback
 */
@interface OTAModule : NSObject <RCTBridgeModule>

/**
 * Returns the OTA bundle URL if one is set, or nil to use the default.
 *
 * Usage in AppDelegate.m:
 *   - (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {
 *       NSURL *otaBundle = [OTAModule bundleURL];
 *       if (otaBundle) return otaBundle;
 *       return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
 *   }
 */
+ (nullable NSURL *)bundleURL;

/**
 * Call from application:didFinishLaunchingWithOptions: to install
 * the crash detection handler.
 */
+ (void)initialize;

@end