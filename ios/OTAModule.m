#import "OTAModule.h"
#import <React/RCTLog.h>
#import <CommonCrypto/CommonDigest.h>

static NSString *const kOTABundlePathKey = @"OTA_BUNDLE_PATH";
static NSString *const kOTALaunchCountKey = @"OTA_LAUNCH_COUNT";
static NSString *const kOTALastCrashKey = @"OTA_LAST_CRASH_TIME";
static NSInteger const kCrashThresholdSeconds = 10;
static NSInteger const kMaxCrashesBeforeRollback = 2;

@implementation OTAModule

RCT_EXPORT_MODULE();

#pragma mark - Static bundle URL management

+ (void)initialize {
  // Install uncaught exception handler for crash detection
  NSSetUncaughtExceptionHandler(&OTAUncaughtExceptionHandler);

  // Check for rapid crashes on startup
  [self checkForCrashLoop];

  RCTLogInfo(@"[OTA] Module initialized with crash detection");
}

+ (nullable NSURL *)bundleURL {
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  NSString *bundlePath = [defaults stringForKey:kOTABundlePathKey];

  if (bundlePath && bundlePath.length > 0) {
    NSFileManager *fm = [NSFileManager defaultManager];
    if ([fm fileExistsAtPath:bundlePath]) {
      RCTLogInfo(@"[OTA] Loading OTA bundle: %@", bundlePath);

      // Record launch for crash detection
      [self recordLaunch];

      return [NSURL fileURLWithPath:bundlePath];
    } else {
      RCTLogWarn(@"[OTA] Bundle not found at: %@, reverting to default", bundlePath);
      [defaults removeObjectForKey:kOTABundlePathKey];
      [defaults synchronize];
    }
  }

  return nil; // Use default bundle
}

+ (void)recordLaunch {
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  NSInteger count = [defaults integerForKey:kOTALaunchCountKey];
  [defaults setInteger:count + 1 forKey:kOTALaunchCountKey];
  [defaults setDouble:[[NSDate date] timeIntervalSince1970] forKey:kOTALastCrashKey];
  [defaults synchronize];
}

+ (void)checkForCrashLoop {
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  NSString *bundlePath = [defaults stringForKey:kOTABundlePathKey];

  if (!bundlePath || bundlePath.length == 0) return;

  NSInteger launchCount = [defaults integerForKey:kOTALaunchCountKey];
  NSTimeInterval lastCrash = [defaults doubleForKey:kOTALastCrashKey];
  NSTimeInterval now = [[NSDate date] timeIntervalSince1970];

  // If multiple crashes happened rapidly, rollback
  if (launchCount >= kMaxCrashesBeforeRollback &&
      (now - lastCrash) < kCrashThresholdSeconds * 3) {
    RCTLogWarn(@"[OTA] Crash loop detected (%ld launches)! Rolling back to default bundle.", (long)launchCount);
    [defaults removeObjectForKey:kOTABundlePathKey];
    [defaults setInteger:0 forKey:kOTALaunchCountKey];
    [defaults synchronize];
  }
}

static void OTAUncaughtExceptionHandler(NSException *exception) {
  RCTLogError(@"[OTA] Uncaught exception: %@", exception);

  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  [defaults setDouble:[[NSDate date] timeIntervalSince1970] forKey:kOTALastCrashKey];
  [defaults synchronize];
}

#pragma mark - JS-callable methods

/**
 * Set the bundle path for the next app launch.
 */
RCT_EXPORT_METHOD(setNextBundlePath:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setObject:path forKey:kOTABundlePathKey];
    [defaults synchronize];
    RCTLogInfo(@"[OTA] Next bundle path set: %@", path);
    resolve(@(YES));
  } @catch (NSException *exception) {
    reject(@"SET_BUNDLE_ERROR", exception.reason, nil);
  }
}

/**
 * Clear the custom bundle path — revert to built-in bundle.
 */
RCT_EXPORT_METHOD(clearBundlePath:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults removeObjectForKey:kOTABundlePathKey];
    [defaults synchronize];
    RCTLogInfo(@"[OTA] Bundle path cleared");
    resolve(@(YES));
  } @catch (NSException *exception) {
    reject(@"CLEAR_BUNDLE_ERROR", exception.reason, nil);
  }
}

/**
 * Confirm the app launched successfully — reset crash counter.
 */
RCT_EXPORT_METHOD(confirmLaunchSuccess:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setInteger:0 forKey:kOTALaunchCountKey];
    [defaults synchronize];
    RCTLogInfo(@"[OTA] Launch confirmed successful");
    resolve(@(YES));
  } @catch (NSException *exception) {
    reject(@"CONFIRM_ERROR", exception.reason, nil);
  }
}

#pragma mark - File system operations

RCT_EXPORT_METHOD(mkdir:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error;
  [[NSFileManager defaultManager] createDirectoryAtPath:path
                            withIntermediateDirectories:YES
                                            attributes:nil
                                                 error:&error];
  if (error) {
    reject(@"MKDIR_ERROR", error.localizedDescription, error);
  } else {
    resolve(@(YES));
  }
}

RCT_EXPORT_METHOD(exists:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  BOOL exists = [[NSFileManager defaultManager] fileExistsAtPath:path];
  resolve(@(exists));
}

RCT_EXPORT_METHOD(readFile:(NSString *)path
                  encoding:(NSString *)encoding
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) {
      reject(@"READ_ERROR", @"File not found or empty", nil);
      return;
    }

    if ([encoding isEqualToString:@"base64"]) {
      resolve([data base64EncodedStringWithOptions:0]);
    } else {
      resolve([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
    }
  } @catch (NSException *exception) {
    reject(@"READ_ERROR", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(writeFile:(NSString *)path
                  content:(NSString *)content
                  encoding:(NSString *)encoding
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    NSData *data;
    if ([encoding isEqualToString:@"base64"]) {
      data = [[NSData alloc] initWithBase64EncodedString:content options:0];
    } else {
      data = [content dataUsingEncoding:NSUTF8StringEncoding];
    }

    // Ensure parent directory exists
    NSString *parentDir = [path stringByDeletingLastPathComponent];
    [[NSFileManager defaultManager] createDirectoryAtPath:parentDir
                              withIntermediateDirectories:YES
                                              attributes:nil
                                                   error:nil];

    [data writeToFile:path atomically:YES];
    resolve(@(YES));
  } @catch (NSException *exception) {
    reject(@"WRITE_ERROR", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(moveFile:(NSString *)src
                  dest:(NSString *)dest
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error;

  // Ensure parent dir exists
  NSString *parentDir = [dest stringByDeletingLastPathComponent];
  [[NSFileManager defaultManager] createDirectoryAtPath:parentDir
                            withIntermediateDirectories:YES
                                            attributes:nil
                                                 error:nil];

  // Remove destination if exists
  [[NSFileManager defaultManager] removeItemAtPath:dest error:nil];

  [[NSFileManager defaultManager] moveItemAtPath:src toPath:dest error:&error];
  if (error) {
    reject(@"MOVE_ERROR", error.localizedDescription, error);
  } else {
    resolve(@(YES));
  }
}

RCT_EXPORT_METHOD(deleteFile:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error;
  [[NSFileManager defaultManager] removeItemAtPath:path error:&error];
  if (error) {
    reject(@"DELETE_ERROR", error.localizedDescription, error);
  } else {
    resolve(@(YES));
  }
}

RCT_EXPORT_METHOD(readDir:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error;
  NSArray<NSString *> *items = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:path error:&error];

  if (error) {
    reject(@"READDIR_ERROR", error.localizedDescription, error);
    return;
  }

  NSMutableArray *result = [NSMutableArray new];
  for (NSString *item in items) {
    NSString *fullPath = [path stringByAppendingPathComponent:item];
    BOOL isDir;
    [[NSFileManager defaultManager] fileExistsAtPath:fullPath isDirectory:&isDir];

    NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:fullPath error:nil];

    [result addObject:@{
      @"name": item,
      @"path": fullPath,
      @"isDirectory": @(isDir),
      @"size": attrs[NSFileSize] ?: @(0),
    }];
  }

  resolve(result);
}

#pragma mark - SHA256 hashing

RCT_EXPORT_METHOD(sha256File:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  @try {
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) {
      reject(@"HASH_ERROR", @"File not found", nil);
      return;
    }

    unsigned char hash[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, hash);

    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
      [hex appendFormat:@"%02x", hash[i]];
    }

    resolve(hex);
  } @catch (NSException *exception) {
    reject(@"HASH_ERROR", exception.reason, nil);
  }
}

#pragma mark - Constants

- (NSDictionary *)constantsToExport {
  NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  return @{
    @"documentDirectory": paths.firstObject ?: @"",
  };
}

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

@end