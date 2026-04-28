#import "OTAUpdatesModule.h"
#import "OTABsPatch.h"
#import <React/RCTLog.h>
#import <React/RCTReloadCommand.h>
#import <CommonCrypto/CommonDigest.h>

static NSString *const kBundle   = @"OTAUpdates_bundlePath";
static NSString *const kLaunches = @"OTAUpdates_launches";
static NSString *const kCrashT   = @"OTAUpdates_crashTime";
static NSString *const kDidCrash = @"OTAUpdates_didCrash";

@implementation OTAUpdatesModule

RCT_EXPORT_MODULE();

// ── Static: bundle + crash detection ─────────────────────────────

+ (void)setup {
  NSSetUncaughtExceptionHandler(&OTACrashHandler);
  [self checkCrashLoop];
}

+ (nullable NSURL *)bundleURL {
  // Block briefly during launch to apply an OTA update in the same session.
  // Strict timeouts: 3s for /check, 12s for bundle download. Total max ~15s.
  // Falls through to the cached bundle if anything is too slow.
  [self checkAndDownloadOnLaunchBlocking];

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

// ── Synchronous launch-time update check ─────────────────────────

+ (void)checkAndDownloadOnLaunchBlocking {
  NSDictionary *info = [[NSBundle mainBundle] infoDictionary];
  NSString *serverUrl = info[@"OTAUpdatesServerUrl"];
  if (serverUrl.length == 0) {
    RCTLogInfo(@"[OTA] No OTAUpdatesServerUrl in Info.plist, skipping launch check");
    return;
  }
  NSString *appVersion = info[@"CFBundleShortVersionString"] ?: @"1.0.0";
  NSString *runtimeVersion = appVersion;
  NSString *projectId = info[@"OTAUpdatesProjectId"] ?: @"";
  NSString *channel = info[@"OTAUpdatesChannel"] ?: @"production";
  NSNumber *timeoutNum = info[@"OTAUpdatesLaunchTimeoutMs"];
  NSTimeInterval timeoutSec = (timeoutNum ? timeoutNum.doubleValue : 8000.0) / 1000.0;

  // Get current update id (if any)
  NSString *currentId = @"";
  NSString *currentBundle = [[NSUserDefaults standardUserDefaults] stringForKey:kBundle];
  if (currentBundle.length) {
    NSArray *parts = [currentBundle pathComponents];
    if (parts.count >= 2) currentId = parts[parts.count - 2];
  }

  NSString *endpoint = projectId.length ? @"/v1/check" : @"/check";
  NSString *checkUrlStr = projectId.length
    ? [NSString stringWithFormat:
        @"%@%@?appVersion=%@&runtimeVersion=%@&currentUpdateId=%@&platform=ios&projectId=%@&channel=%@",
        serverUrl, endpoint, appVersion, runtimeVersion, currentId, projectId, channel]
    : [NSString stringWithFormat:
        @"%@%@?appVersion=%@&runtimeVersion=%@&currentUpdateId=%@&platform=ios",
        serverUrl, endpoint, appVersion, runtimeVersion, currentId];
  NSURL *checkUrl = [NSURL URLWithString:checkUrlStr];
  if (!checkUrl) return;

  RCTLogInfo(@"[OTA] Launch check: %@", checkUrlStr);

  __block NSDictionary *checkResult = nil;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);

  // Strict timeouts so the launch never blocks more than ~15 seconds total.
  // /check: 3s. Bundle download: 12s. Server uses gzip so 19MB → ~7MB.
  NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  cfg.timeoutIntervalForRequest = 3;
  cfg.timeoutIntervalForResource = 15;
  cfg.HTTPAdditionalHeaders = @{@"Accept-Encoding": @"gzip"};
  NSURLSession *session = [NSURLSession sessionWithConfiguration:cfg];

  [[session dataTaskWithURL:checkUrl completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
    if (data && !err) {
      checkResult = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    } else {
      RCTLogWarn(@"[OTA] Launch check failed: %@", err.localizedDescription);
    }
    dispatch_semaphore_signal(sem);
  }] resume];

  // /check max 3 seconds
  if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC))) != 0) {
    RCTLogWarn(@"[OTA] Launch check timed out (>3s), skipping");
    return;
  }

  if (![checkResult[@"available"] boolValue]) {
    RCTLogInfo(@"[OTA] No update available");
    return;
  }

  NSString *updateId = checkResult[@"updateId"];
  NSString *expectedHash = checkResult[@"bundleHash"];
  NSString *manifestUrl = checkResult[@"manifestUrl"];
  if (!updateId || !expectedHash || !manifestUrl) return;

  RCTLogInfo(@"[OTA] Downloading update %@", updateId);

  // Fetch manifest to get bundleUrl (max 2s)
  NSString *manifestFullUrl = [manifestUrl hasPrefix:@"http"]
    ? manifestUrl
    : [NSString stringWithFormat:@"%@%@", serverUrl, manifestUrl];
  __block NSDictionary *manifest = nil;
  dispatch_semaphore_t sem2 = dispatch_semaphore_create(0);
  [[session dataTaskWithURL:[NSURL URLWithString:manifestFullUrl] completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
    if (data && !err) manifest = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    dispatch_semaphore_signal(sem2);
  }] resume];
  if (dispatch_semaphore_wait(sem2, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC))) != 0) {
    RCTLogWarn(@"[OTA] Manifest fetch timed out (>2s), skipping");
    return;
  }
  if (!manifest) return;

  NSString *bundleUrlPath = manifest[@"bundleUrl"];
  if (!bundleUrlPath) return;
  NSString *bundleFullUrl = [bundleUrlPath hasPrefix:@"http"]
    ? bundleUrlPath
    : [NSString stringWithFormat:@"%@%@", serverUrl, bundleUrlPath];

  // Download bundle to temp location
  NSString *docs = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
  NSString *dir = [docs stringByAppendingPathComponent:[NSString stringWithFormat:@"OTAUpdates/%@", updateId]];
  NSString *destPath = [dir stringByAppendingPathComponent:@"bundle.hbc"];
  NSFileManager *fm = [NSFileManager defaultManager];
  [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];

  __block NSURL *tmpFile = nil;
  __block NSError *dlErr = nil;
  dispatch_semaphore_t sem3 = dispatch_semaphore_create(0);
  [[session downloadTaskWithURL:[NSURL URLWithString:bundleFullUrl] completionHandler:^(NSURL *loc, NSURLResponse *resp, NSError *err) {
    if (loc && !err) {
      // Move synchronously inside the block before semaphore signal
      [fm removeItemAtPath:destPath error:nil];
      NSError *moveErr;
      if ([fm moveItemAtURL:loc toURL:[NSURL fileURLWithPath:destPath] error:&moveErr]) {
        tmpFile = [NSURL fileURLWithPath:destPath];
      } else {
        dlErr = moveErr;
      }
    } else {
      dlErr = err;
    }
    dispatch_semaphore_signal(sem3);
  }] resume];
  // Bundle download — strict 12-second cap
  if (dispatch_semaphore_wait(sem3, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(12 * NSEC_PER_SEC))) != 0) {
    RCTLogWarn(@"[OTA] Bundle download timed out (>12s), skipping");
    return;
  }
  if (!tmpFile) {
    RCTLogWarn(@"[OTA] Bundle download failed: %@", dlErr.localizedDescription);
    return;
  }

  // SHA-256 verify
  NSData *bundleData = [NSData dataWithContentsOfFile:destPath];
  if (!bundleData) return;
  unsigned char h[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bundleData.bytes, (CC_LONG)bundleData.length, h);
  NSMutableString *actualHash = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH*2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [actualHash appendFormat:@"%02x", h[i]];

  if (![actualHash isEqualToString:expectedHash]) {
    RCTLogWarn(@"[OTA] Hash mismatch! Expected %@, got %@", expectedHash, actualHash);
    [fm removeItemAtPath:destPath error:nil];
    return;
  }

  // Create a symlink so the asset resolver finds bundled assets next to
  // the OTA bundle. RN's scaledAssetURLNearBundle() looks at <bundleDir>/assets/...
  NSString *mainAssets = [[[NSBundle mainBundle] bundlePath] stringByAppendingPathComponent:@"assets"];
  NSString *otaAssetsLink = [dir stringByAppendingPathComponent:@"assets"];
  [fm removeItemAtPath:otaAssetsLink error:nil];
  NSError *linkErr;
  if (![fm createSymbolicLinkAtPath:otaAssetsLink withDestinationPath:mainAssets error:&linkErr]) {
    RCTLogWarn(@"[OTA] Failed to symlink assets: %@", linkErr.localizedDescription);
  }

  // Persist as the new bundle path
  NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
  [d setObject:destPath forKey:kBundle];
  [d setInteger:0 forKey:kLaunches];
  [d setBool:NO forKey:kDidCrash];
  [d synchronize];

  RCTLogInfo(@"[OTA] Update %@ ready, will load now", updateId);
}

+ (void)recordLaunch {
  NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
  [d setInteger:[d integerForKey:kLaunches] + 1 forKey:kLaunches];
  [d synchronize];
}

+ (void)checkCrashLoop {
  NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
  if (![d stringForKey:kBundle].length) return;

  // Only rollback if a crash actually happened
  BOOL didCrash = [d boolForKey:kDidCrash];
  if (!didCrash) {
    // No crash since last launch — reset counter
    [d setInteger:0 forKey:kLaunches];
    [d synchronize];
    return;
  }

  // A crash happened — increment crash counter
  [d setBool:NO forKey:kDidCrash]; // clear the flag
  NSInteger n = [d integerForKey:kLaunches];
  if (n >= 2) {
    RCTLogWarn(@"[OTA] Crash loop (%ld crashes). Rolling back.", (long)n);
    [d removeObjectForKey:kBundle];
    [d setInteger:0 forKey:kLaunches];
    [d synchronize];
  } else {
    [d synchronize];
  }
}

static void OTACrashHandler(NSException *ex) {
  NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
  [d setBool:YES forKey:kDidCrash];
  [d setInteger:[d integerForKey:kLaunches] + 1 forKey:kLaunches];
  [d synchronize];
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

RCT_EXPORT_METHOD(linkAssets:(NSString *)bundleDir
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *mainAssets = [[[NSBundle mainBundle] bundlePath] stringByAppendingPathComponent:@"assets"];
  NSString *otaAssetsLink = [bundleDir stringByAppendingPathComponent:@"assets"];
  NSFileManager *fm = [NSFileManager defaultManager];
  [fm removeItemAtPath:otaAssetsLink error:nil];
  NSError *err;
  if ([fm createSymbolicLinkAtPath:otaAssetsLink withDestinationPath:mainAssets error:&err]) {
    resolve(@YES);
  } else {
    reject(@"LINK", err.localizedDescription, err);
  }
}

RCT_EXPORT_METHOD(reload:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    RCTTriggerReloadCommandListeners(@"OTA update");
    resolve(@YES);
  });
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

// ── Download file (bypasses JS base64 for large binaries) ────────

RCT_EXPORT_METHOD(downloadFile:(NSString *)urlStr dest:(NSString *)dest
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSURL *url = [NSURL URLWithString:urlStr];
  if (!url) { reject(@"E", @"Invalid URL", nil); return; }

  NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
  cfg.timeoutIntervalForResource = 300;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:cfg];

  [[session downloadTaskWithURL:url completionHandler:^(NSURL *tmpFile, NSURLResponse *resp, NSError *err) {
    if (err) { reject(@"E", err.localizedDescription, err); return; }

    NSHTTPURLResponse *http = (NSHTTPURLResponse *)resp;
    if (http.statusCode != 200) {
      reject(@"E", [NSString stringWithFormat:@"HTTP %ld", (long)http.statusCode], nil);
      return;
    }

    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *dir = [dest stringByDeletingLastPathComponent];
    [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    [fm removeItemAtPath:dest error:nil];

    NSError *moveErr;
    if ([fm moveItemAtURL:tmpFile toURL:[NSURL fileURLWithPath:dest] error:&moveErr]) {
      resolve(dest);
    } else {
      reject(@"E", moveErr.localizedDescription, moveErr);
    }
  }] resume];
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

// ── Delta patch ──────────────────────────────────────────────────

RCT_EXPORT_METHOD(applyPatch:(NSString *)basePath
                       patch:(NSString *)patchPath
                      output:(NSString *)outPath
                    resolver:(RCTPromiseResolveBlock)resolve
                    rejecter:(RCTPromiseRejectBlock)reject)
{
    NSError *error = nil;
    BOOL ok = [OTABsPatch applyPatchAtBase:basePath
                                     patch:patchPath
                                    output:outPath
                                     error:&error];
    if (ok) {
        resolve(nil);
    } else {
        reject(@"PATCH_FAILED",
               error.localizedDescription ?: @"bspatch failed",
               error);
    }
}

// ── Constants ────────────────────────────────────────────────────

- (NSDictionary *)constantsToExport {
  return @{@"documentDirectory": NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject ?: @""};
}
+ (BOOL)requiresMainQueueSetup { return YES; }

@end
