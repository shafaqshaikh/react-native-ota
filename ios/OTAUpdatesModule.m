#import "OTAUpdatesModule.h"
#import <React/RCTLog.h>
#import <CommonCrypto/CommonDigest.h>

static NSString *const kBundle   = @"OTAUpdates_bundlePath";
static NSString *const kLaunches = @"OTAUpdates_launches";
static NSString *const kCrashT   = @"OTAUpdates_crashTime";

@implementation OTAUpdatesModule

RCT_EXPORT_MODULE();

// ── Static: bundle + crash detection ─────────────────────────────

+ (void)setup {
  NSSetUncaughtExceptionHandler(&OTACrashHandler);
  [self checkCrashLoop];
}

+ (nullable NSURL *)bundleURL {
  NSString *p = [[NSUserDefaults standardUserDefaults] stringForKey:kBundle];
  if (p.length && [[NSFileManager defaultManager] fileExistsAtPath:p]) {
    [self recordLaunch];
    return [NSURL fileURLWithPath:p];
  }
  if (p.length) {
    [[NSUserDefaults standardUserDefaults] removeObjectForKey:kBundle];
    [[NSUserDefaults standardUserDefaults] synchronize];
  }
  return nil;
}

+ (void)recordLaunch {
  NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
  [d setInteger:[d integerForKey:kLaunches] + 1 forKey:kLaunches];
  [d setDouble:[[NSDate date] timeIntervalSince1970] forKey:kCrashT];
  [d synchronize];
}

+ (void)checkCrashLoop {
  NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
  if (![d stringForKey:kBundle].length) return;
  NSInteger n = [d integerForKey:kLaunches];
  NSTimeInterval last = [d doubleForKey:kCrashT];
  if (n >= 2 && ([[NSDate date] timeIntervalSince1970] - last) < 30) {
    RCTLogWarn(@"[OTA] Crash loop (%ld). Rolling back.", (long)n);
    [d removeObjectForKey:kBundle];
    [d setInteger:0 forKey:kLaunches];
    [d synchronize];
  }
}

static void OTACrashHandler(NSException *ex) {
  [[NSUserDefaults standardUserDefaults] setDouble:[[NSDate date] timeIntervalSince1970] forKey:kCrashT];
  [[NSUserDefaults standardUserDefaults] synchronize];
}

// ── JS methods: bundle ───────────────────────────────────────────

RCT_EXPORT_METHOD(setNextBundlePath:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [[NSUserDefaults standardUserDefaults] setObject:path forKey:kBundle];
  [[NSUserDefaults standardUserDefaults] synchronize];
  resolve(@YES);
}

RCT_EXPORT_METHOD(clearBundlePath:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [[NSUserDefaults standardUserDefaults] removeObjectForKey:kBundle];
  [[NSUserDefaults standardUserDefaults] synchronize];
  resolve(@YES);
}

RCT_EXPORT_METHOD(confirmLaunchSuccess:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [[NSUserDefaults standardUserDefaults] setInteger:0 forKey:kLaunches];
  [[NSUserDefaults standardUserDefaults] synchronize];
  resolve(@YES);
}

// ── JS methods: filesystem ───────────────────────────────────────

RCT_EXPORT_METHOD(mkdir:(NSString *)p
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *e;
  [[NSFileManager defaultManager] createDirectoryAtPath:p withIntermediateDirectories:YES attributes:nil error:&e];
  e ? reject(@"E", e.localizedDescription, e) : resolve(@YES);
}

RCT_EXPORT_METHOD(exists:(NSString *)p
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@([[NSFileManager defaultManager] fileExistsAtPath:p]));
}

RCT_EXPORT_METHOD(readFile:(NSString *)p encoding:(NSString *)enc
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSData *d = [NSData dataWithContentsOfFile:p];
  if (!d) { reject(@"E", @"Not found", nil); return; }
  resolve([enc isEqualToString:@"base64"]
    ? [d base64EncodedStringWithOptions:0]
    : [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding]);
}

RCT_EXPORT_METHOD(writeFile:(NSString *)p content:(NSString *)c encoding:(NSString *)enc
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSData *d = [enc isEqualToString:@"base64"]
    ? [[NSData alloc] initWithBase64EncodedString:c options:0]
    : [c dataUsingEncoding:NSUTF8StringEncoding];
  NSString *dir = [p stringByDeletingLastPathComponent];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  [d writeToFile:p atomically:YES];
  resolve(@YES);
}

RCT_EXPORT_METHOD(moveFile:(NSString *)s dest:(NSString *)d
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *dir = [d stringByDeletingLastPathComponent];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  [[NSFileManager defaultManager] removeItemAtPath:d error:nil];
  NSError *e;
  [[NSFileManager defaultManager] moveItemAtPath:s toPath:d error:&e];
  e ? reject(@"E", e.localizedDescription, e) : resolve(@YES);
}

RCT_EXPORT_METHOD(deleteFile:(NSString *)p
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [[NSFileManager defaultManager] removeItemAtPath:p error:nil];
  resolve(@YES);
}

RCT_EXPORT_METHOD(readDir:(NSString *)p
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *e;
  NSArray *items = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:p error:&e];
  if (e) { reject(@"E", e.localizedDescription, e); return; }
  NSMutableArray *r = [NSMutableArray new];
  for (NSString *name in items) {
    NSString *fp = [p stringByAppendingPathComponent:name];
    BOOL isDir; [[NSFileManager defaultManager] fileExistsAtPath:fp isDirectory:&isDir];
    NSDictionary *a = [[NSFileManager defaultManager] attributesOfItemAtPath:fp error:nil];
    [r addObject:@{@"name":name, @"path":fp, @"isDirectory":@(isDir), @"size":a[NSFileSize]?:@0}];
  }
  resolve(r);
}

// ── SHA-256 ──────────────────────────────────────────────────────

RCT_EXPORT_METHOD(sha256File:(NSString *)p
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSData *d = [NSData dataWithContentsOfFile:p];
  if (!d) { reject(@"E", @"Not found", nil); return; }
  unsigned char h[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(d.bytes, (CC_LONG)d.length, h);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH*2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", h[i]];
  resolve(hex);
}

// ── Constants ────────────────────────────────────────────────────

- (NSDictionary *)constantsToExport {
  return @{@"documentDirectory": NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject ?: @""};
}
+ (BOOL)requiresMainQueueSetup { return YES; }

@end
