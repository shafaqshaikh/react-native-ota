# react-native-ota-updates

Production-grade Over-The-Air updates for React Native. Ship JS bundle updates instantly — no app store review required.

Built as a drop-in alternative to Expo Updates / CodePush with full control over your infrastructure.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          PUBLISH FLOW                                │
│                                                                      │
│  Developer        CLI                         Server                 │
│  ─────────  ──────────────────  ──────────────────────────────────── │
│  Makes JS   npx ota-updates     POST /publish                       │
│  changes    publish              ├─ Verify SHA-256 hash              │
│       │      ├─ expo export      ├─ Store bundle on disk             │
│       │      ├─ SHA-256 hash     ├─ Save metadata to SQLite          │
│       │      ├─ Upload bundle    └─ Return update ID                 │
│       ▼      ▼                                                       │
│   [source] → [bundle.hbc] → ─── HTTPS ───→ [server/uploads/]        │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                          UPDATE FLOW                                 │
│                                                                      │
│  App Launch                                                          │
│  ──────────                                                          │
│  1. Native module checks for OTA bundle path in SharedPreferences    │
│     (Android) or NSUserDefaults (iOS)                                │
│  2. If found and file exists → load OTA bundle                       │
│  3. If crash loop detected (2+ crashes in 30s) → rollback to default │
│  4. JS SDK initializes:                                              │
│     a. If current update status = "pending" →                        │
│        start 10s stability timer → mark "stable" if survived         │
│     b. Background check: GET /check?platform=ios&appVersion=1.4.9    │
│     c. If update available:                                          │
│        ├─ Download manifest (GET /manifest/:id)                      │
│        ├─ Download bundle  (GET /bundle/:id)                         │
│        ├─ Verify SHA-256 hash against manifest                       │
│        ├─ Atomic write: bundle.js.tmp → bundle.js                    │
│        ├─ Shift current → previous (rollback safety net)             │
│        ├─ Save new metadata as "pending"                             │
│        └─ Tell native module the new bundle path                     │
│  5. On next app restart → native loads the new bundle                │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                        ROLLBACK FLOW                                 │
│                                                                      │
│  Launch 1: New bundle loaded, status = "pending"                     │
│            App crashes within 30 seconds                             │
│            Crash handler records timestamp                           │
│                                                                      │
│  Launch 2: Native module detects crash loop (2 launches + recent     │
│            crash timestamp)                                          │
│            → Clears OTA bundle path                                  │
│            → App loads default built-in bundle                       │
│            → User never sees a broken app                            │
└──────────────────────────────────────────────────────────────────────┘
```

### Data flow diagram

```
                    ┌─────────┐
                    │ SQLite  │
                    │ (meta)  │
                    └────┬────┘
                         │
┌─────────┐  publish  ┌──┴──────┐  /check   ┌───────────┐
│   CLI   │ ────────→ │ Server  │ ←──────── │  RN App   │
│         │           │ :4000   │ ────────→ │           │
└─────────┘           └──┬──────┘  manifest │  ┌─────┐  │
                         │         + bundle │  │ SDK │  │
                    ┌────┴────┐             │  └──┬──┘  │
                    │ Disk    │             │     │     │
                    │(bundles)│             │  ┌──┴──┐  │
                    └─────────┘             │  │Native│ │
                                            │  │Module│ │
                                            │  └─────┘  │
                                            └───────────┘
```

### Local storage structure (on device)

```
<DocumentsDirectory>/ota-updates/
  current.json          ← active update metadata
  previous.json         ← rollback target
  bundles/
    <updateId-1>/
      bundle.js         ← the JS/Hermes bytecode bundle
      manifest.json     ← server manifest snapshot
    <updateId-2>/
      bundle.js
      manifest.json
```

---

## Project structure

```
react-native-ota-updates/
├── src/                          # TypeScript SDK (runs in React Native)
│   ├── index.ts                  #   Public API: configure, initialize, checkForUpdate, etc.
│   ├── updater.ts                #   Core lifecycle: check → download → verify → apply → rollback
│   ├── storage.ts                #   Local file storage for metadata and bundles
│   ├── native.ts                 #   Bridge to native module (OTAUpdatesModule)
│   └── types.ts                  #   TypeScript type definitions
│
├── android/                      # Android native module (Kotlin)
│   ├── build.gradle              #   Gradle build config
│   └── src/main/java/com/otaupdates/
│       ├── OTAUpdatesModule.kt   #   Bundle loading, file ops, SHA-256, crash detection
│       └── OTAUpdatesPackage.kt  #   React Native package registration
│
├── ios/                          # iOS native module (Objective-C)
│   ├── OTAUpdatesModule.h        #   Header: +bundleURL, +setup
│   └── OTAUpdatesModule.m        #   Bundle loading, file ops, SHA-256, crash detection
│
├── cli/                          # CLI tool (npx ota-updates <command>)
│   ├── index.js                  #   Entry: publish, check, list commands
│   └── publish.js                #   Build bundle (expo export / rn bundle), hash, upload
│
├── server/                       # OTA update server (Node.js + Express + SQLite)
│   ├── src/
│   │   ├── index.js              #   Express server: /publish, /check, /manifest, /bundle
│   │   └── db.js                 #   SQLite database: updates table, rollout logic
│   └── Dockerfile                #   Production deployment container
│
├── plugin/                       # Expo config plugin
│   └── withOTAUpdates.js         #   Auto-patches MainApplication.kt + AppDelegate.swift
│
├── app.plugin.js                 # Expo plugin entry point
├── react-native-ota-updates.podspec  # CocoaPods spec for iOS
├── package.json
└── tsconfig.json
```

---

## Installation

```bash
npm install react-native-ota-updates
```

### Expo (managed/bare)

Add the plugin to your `app.config.js`:

```js
export default {
  expo: {
    plugins: [
      'react-native-ota-updates',
    ],
    // ... rest of config
  },
};
```

Then rebuild native projects:

```bash
npx expo prebuild --clean
```

The config plugin automatically:
- **Android**: Adds `OTAUpdatesPackage`, overrides `getJSBundleFile()`, installs crash handler
- **iOS**: Calls `OTAUpdatesModule.setup()`, overrides `bundleURL()` in release builds

### Bare React Native (manual linking)

<details>
<summary>Android — MainApplication.kt</summary>

```kotlin
import com.otaupdates.OTAUpdatesModule
import com.otaupdates.OTAUpdatesPackage

class MainApplication : Application(), ReactApplication {

    override val reactNativeHost = object : DefaultReactNativeHost(this) {
        override fun getPackages() = PackageList(this).packages.apply {
            add(OTAUpdatesPackage())
        }

        override fun getJSBundleFile(): String? =
            OTAUpdatesModule.getBundleFile(this@MainApplication) ?: super.getJSBundleFile()
    }

    override fun onCreate() {
        super.onCreate()
        OTAUpdatesModule.install(this) // crash detection
    }
}
```
</details>

<details>
<summary>iOS — AppDelegate.swift</summary>

Add `#import "OTAUpdatesModule.h"` to your bridging header, then:

```swift
// In didFinishLaunchingWithOptions:
OTAUpdatesModule.setup()

// In your ReactNativeDelegate:
override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings()
        .jsBundleURL(forBundleRoot: "index")
#else
    if let ota = OTAUpdatesModule.bundleURL() { return ota }
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
}
```
</details>

---

## Server setup

### Local development

```bash
# Start the server (port 4000 by default)
npx ota-updates server

# Or with custom port
PORT=8080 npx ota-updates server
```

### Production deployment

**Docker:**

```bash
docker build -t ota-server -f node_modules/react-native-ota-updates/server/Dockerfile .
docker run -d \
  -p 4000:4000 \
  -v ota-data:/app/data \
  -v ota-uploads:/app/uploads \
  --name ota-server \
  ota-server
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Server port |
| `OTA_DATA_DIR` | `./server/data` | SQLite database directory |
| `OTA_UPLOADS_DIR` | `./server/uploads` | Bundle file storage |

### Server API reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /publish` | Multipart | Upload a new update (bundle file + metadata) |
| `GET /check` | Query params | Check if an update is available for a device |
| `GET /manifest/:id` | - | Get full manifest JSON for an update |
| `GET /bundle/:id` | - | Download the JS bundle binary |
| `GET /updates` | - | List all published updates |
| `GET /health` | - | Health check |

**`GET /check` query parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `appVersion` | Yes | Client's app version (e.g. `1.4.9`) |
| `runtimeVersion` | Yes | Client's runtime version |
| `platform` | Yes | `ios` or `android` |
| `currentUpdateId` | No | ID of the currently installed update |
| `clientId` | No | Unique device ID (used for rollout bucketing) |

---

## Usage

### Initialize (call once on app startup)

```typescript
import OTAUpdates from 'react-native-ota-updates';

OTAUpdates.initialize({
  serverUrl: 'https://ota.yourcompany.com',
  appVersion: '1.4.9',
  runtimeVersion: '1.4.9',
  autoCheck: true,
  onUpdateAvailable: async (update) => {
    const result = await OTAUpdates.downloadUpdate(update);
    await OTAUpdates.applyUpdate(result);
    // Update activates on next app restart
  },
});
```

### Manual update flow

```typescript
import OTAUpdates from 'react-native-ota-updates';

async function checkAndUpdate() {
  // 1. Check
  const check = await OTAUpdates.checkForUpdate();
  if (!check.available) return;

  // 2. Download + verify
  const result = await OTAUpdates.downloadUpdate(check);

  // 3. Apply (activates on next restart)
  await OTAUpdates.applyUpdate(result);

  // 4. Optionally prompt user to restart
  Alert.alert('Update Ready', 'Restart to apply the update.', [
    { text: 'Later' },
    { text: 'Restart', onPress: () => RNRestart.restart() },
  ]);
}
```

### Get current version info

```typescript
const info = await OTAUpdates.getCurrentVersion();
// {
//   updateId: "abc-123" | null,
//   bundlePath: "/data/.../bundle.js" | null,
//   status: "stable" | "pending" | "rollback" | "default",
//   appVersion: "1.4.9",
//   runtimeVersion: "1.4.9",
//   isOTABundle: true,
// }
```

### Force rollback

```typescript
await OTAUpdates.rollback();
// Next restart will load the previous update (or default bundle)
```

---

## CLI reference

### Publish an update

```bash
# From your React Native project root
npx ota-updates publish --platform android
npx ota-updates publish --platform ios

# With options
npx ota-updates publish \
  --platform android \
  --server https://ota.yourcompany.com \
  --app-version 1.4.9 \
  --runtime-version 1.4.9 \
  --rollout 10          # 10% gradual rollout
```

The CLI automatically:
1. Builds the bundle (`expo export` or `react-native bundle`)
2. Computes SHA-256 hash
3. Uploads to the server
4. Cleans up temp files

### Check for updates

```bash
npx ota-updates check --platform android --server http://localhost:4000
```

### List published updates

```bash
npx ota-updates list --server http://localhost:4000
```

---

## How it works

### Update lifecycle

```
App Start
 │
 ├─ Native: Is there an OTA bundle path in preferences?
 │   ├─ YES → Does the file exist?
 │   │   ├─ YES → Crash loop detected? (2+ crashes in 30s)
 │   │   │   ├─ YES → Clear path, load DEFAULT bundle
 │   │   │   └─ NO  → Load OTA bundle
 │   │   └─ NO → Clear stale path, load DEFAULT bundle
 │   └─ NO → Load DEFAULT bundle
 │
 ├─ JS: SDK initializes
 │   ├─ Is current update "pending"?
 │   │   └─ YES → Start 10s timer → mark "stable" if no crash
 │   │
 │   └─ Auto-check enabled?
 │       └─ YES → GET /check (after 5s delay to not block startup)
 │           └─ Update available?
 │               └─ YES → call onUpdateAvailable callback
 │
 └─ App runs normally
```

### Security

| Layer | Mechanism |
|-------|-----------|
| **Transport** | HTTPS enforced (warning logged for HTTP non-localhost) |
| **Integrity** | SHA-256 hash verified after download, before activation |
| **Atomic writes** | Bundle written to `.tmp`, verified, then renamed |
| **Rollback** | Crash loop detection auto-reverts to last known good bundle |

### Versioning strategy

- **`appVersion`**: The native app version (from `package.json` or app config). Must match for an update to apply.
- **`runtimeVersion`**: Compatibility layer. OTA updates only apply when the device's runtime version matches the update's. Use this to prevent JS bundles from loading on incompatible native code.

Example: If you add a new native module in version 1.5.0, set `runtimeVersion: "1.5.0"`. OTA updates published for `runtimeVersion: "1.4.9"` will not be delivered to 1.5.0 devices.

### Rollout targeting

Rollout is deterministic per `clientId`. A device is hashed to a bucket (0–99). If the rollout percentage is 10%, only devices in buckets 0–9 receive the update. The same device always gets the same result for a given update, so you can safely increase rollout from 10% → 50% → 100% without re-delivering to devices that already received it.

---

## Production considerations

### CDN integration

For large-scale deployments, serve bundles from a CDN instead of directly from the OTA server:

1. After publishing, upload the bundle to S3/CloudFront/Cloudflare R2
2. Modify the server to return CDN URLs in the manifest's `bundleUrl`
3. The SDK downloads from the CDN transparently

### Monitoring

Add analytics events to track the update funnel:

```typescript
OTAUpdates.initialize({
  onUpdateAvailable: async (update) => {
    analytics.track('ota_update_available', { updateId: update.updateId });

    try {
      const result = await OTAUpdates.downloadUpdate(update);
      analytics.track('ota_download_complete', { updateId: update.updateId });
      await OTAUpdates.applyUpdate(result);
      analytics.track('ota_update_applied', { updateId: update.updateId });
    } catch (err) {
      analytics.track('ota_update_failed', { error: err.message });
    }
  },
});
```

### Background updates

Pre-download updates when the app is backgrounded:

```typescript
import { AppState } from 'react-native';

AppState.addEventListener('change', async (state) => {
  if (state === 'background') {
    const check = await OTAUpdates.checkForUpdate();
    if (check.available) {
      const result = await OTAUpdates.downloadUpdate(check);
      await OTAUpdates.applyUpdate(result);
      // Ready on next foreground/restart
    }
  }
});
```

### Database migration

The server uses SQLite by default (zero-config, single-file). For high-traffic production:

```sql
-- PostgreSQL equivalent schema
CREATE TABLE updates (
    id              UUID PRIMARY KEY,
    platform        VARCHAR(10) NOT NULL,
    app_version     VARCHAR(50) NOT NULL,
    runtime_version VARCHAR(50) NOT NULL,
    bundle_hash     VARCHAR(64) NOT NULL,
    bundle_path     TEXT NOT NULL,
    rollout_pct     INTEGER DEFAULT 100,
    created_at      BIGINT NOT NULL
);

CREATE INDEX idx_updates_lookup
    ON updates(platform, app_version, runtime_version, created_at DESC);
```

### Manifest signing (advanced)

For additional security, sign manifests with a private key on the server and verify with a public key embedded in the app:

```javascript
// Server-side (during publish)
const sign = crypto.createSign('SHA256');
sign.update(JSON.stringify(manifest));
manifest.signature = sign.sign(privateKey, 'hex');

// Client-side (before applying)
const verify = crypto.createVerify('SHA256');
verify.update(JSON.stringify({ ...manifest, signature: undefined }));
if (!verify.verify(publicKey, manifest.signature, 'hex')) {
  throw new Error('Manifest signature verification failed');
}
```

---

## Error handling

The SDK handles these failure modes:

| Scenario | Behavior |
|----------|----------|
| Network unreachable | `checkForUpdate()` returns `{ available: false }` silently |
| Server down | Same as above — never blocks app startup |
| Partial download | Temp file is cleaned up, update is not applied |
| Hash mismatch | Bundle is deleted, error thrown — app continues on current bundle |
| Corrupt bundle crashes app | Native crash loop detection rolls back after 2 crashes in 30s |
| Version mismatch | Server only returns updates matching `appVersion` + `runtimeVersion` |
| Disk full | Write fails, temp files cleaned up, update skipped |

---

## API reference

### `configure(config: OTAConfig): void`

Set the server URL, app version, and runtime version. Must be called before any other method.

### `initialize(options?: InitializeOptions): Promise<void>`

Start the OTA system. Monitors stability of pending updates, optionally auto-checks for new updates.

### `checkForUpdate(): Promise<UpdateCheckResult>`

Ask the server if a newer update is available for this device + platform.

### `downloadUpdate(update: UpdateCheckResult): Promise<DownloadResult>`

Download the bundle, verify its SHA-256 hash, store locally.

### `applyUpdate(result: DownloadResult): Promise<void>`

Mark the update as pending. It activates on the next app restart.

### `getCurrentVersion(): Promise<VersionInfo>`

Get metadata about the currently active update (or "default" if no OTA bundle is loaded).

### `markStable(): Promise<void>`

Manually confirm the current update is stable. Called automatically by `initialize()` after the stability delay.

### `rollback(): Promise<void>`

Revert to the previous update or the default built-in bundle.

---

## License

MIT
