#import <React/RCTBridgeModule.h>

@interface OTAUpdatesModule : NSObject <RCTBridgeModule>

/** Returns OTA bundle URL or nil (use default). Call from bundleURL(). */
+ (nullable NSURL *)bundleURL;

/** Install crash detection. Call from didFinishLaunchingWithOptions. */
+ (void)setup;

@end
