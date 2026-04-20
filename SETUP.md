# React Native OTA Update System — Setup Guide

## Architecture

```
Developer → CLI (build + hash) → Server (store) → App SDK (check + download + verify) → Native Module (load bundle)
```

## Folder Structure

```
├── ota-server/          # Node.js backend
│   └── src/
│       ├── index.js     # Express server with /publish, /check, /manifest, /bundle
│       └── store.js     # In-memory update store (swap for DB in prod)
│
├── ota-cli/             # CLI tool
│   └── src/
│       ├── index.js     # Entry point (commander)
│       └── commands/
│           ├── build.js # Bundle + hash + manifest generation
│           └── publish.js # Upload to server
│
├── ota-sdk/             # React Native SDK
│   └── src/
│       ├── index.js     # Main entry: configure, checkForUpdate, downloadUpdate, applyUpdate
│       ├── updater.js   # Core lifecycle engine
│       ├── storage.js   # Local storage manager (current.json, previous.json)
│       ├── hash.js      # SHA256 verification (native + JS fallback)
│       ├── config.js    # SDK configuration
│       ├── logger.js    # Structured logging
│       ├── fs-bridge.js # Filesystem abstraction
│       └── useOTAUpdate.js # React hook
│
├── android/src/main/java/com/ota/
│   ├── OTAModule.java          # Native module: bundle loading, file ops, hashing
│   ├── OTAPackage.java         # React Native package registration
│   └── OTAExceptionHandler.java # Crash detection
│
└── ios/
    ├── OTAModule.h              # Header
    └── OTAModule.m              # Native module: bundle loading, file ops, hashing, crash detection
```

---

## Step-by-Step Integration

### 1. Start the OTA Server

```bash
cd ota-server
npm install
npm start
# Server runs on http://localhost:3000
```

### 2. Install the CLI

```bash
cd ota-cli
npm install
npm link    # Makes `ota` command available globally
```

### 3. Android Integration

**a. Copy native files** into your RN project's `android/app/src/main/java/com/ota/` directory.

**b. Register the package** in `MainApplication.java`:

```java
import com.ota.OTAPackage;
import com.ota.OTAExceptionHandler;
import com.ota.OTAModule;

public class MainApplication extends Application implements ReactApplication {

    @Override
    public void onCreate() {
        super.onCreate();
        // Install crash handler for OTA rollback
        OTAExceptionHandler.install(this);
    }

    @Override
    protected List<ReactPackage> getPackages() {
        List<ReactPackage> packages = new PackageList(this).getPackages();
        packages.add(new OTAPackage());
        return packages;
    }
}
```

**c. Override bundle loading** in your `ReactActivity` or `ReactNativeHost`:

```java
@Override
protected String getJSBundleFile() {
    String otaBundle = OTAModule.getJSBundleFile(getApplicationContext());
    return otaBundle != null ? otaBundle : super.getJSBundleFile();
}
```

### 4. iOS Integration

**a. Copy `OTAModule.h` and `OTAModule.m`** into your Xcode project.

**b. Update `AppDelegate.m`:**

```objc
#import "OTAModule.h"

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    [OTAModule initialize]; // Install crash detection
    // ... rest of setup
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge {
    NSURL *otaBundle = [OTAModule bundleURL];
    if (otaBundle) return otaBundle;

    #if DEBUG
    return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
    #else
    return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
    #endif
}
```

### 5. SDK Integration in JavaScript

**a. Copy or link `ota-sdk/`** into your project.

**b. Initialize on app start** (e.g., in `App.js`):

```javascript
import OTA from './ota-sdk/src';

// Configure
OTA.configure({
    serverUrl: 'https://your-ota-server.com',
    appVersion: '1.0.0',
    runtimeVersion: '1.0.0',
    clientId: 'unique-device-id', // Use a UUID stored on device
});

// Initialize (checks for pending updates, sets up stability monitoring)
OTA.initialize({
    autoCheck: true,
    onUpdateAvailable: async (update) => {
        console.log('Update available!', update.updateId);
    },
});
```

**c. Manual update flow:**

```javascript
async function checkAndUpdate() {
    const update = await OTA.checkForUpdate();
    if (!update) return console.log('Up to date!');

    const result = await OTA.downloadUpdate(update);
    if (!result) return console.log('Download failed');

    const applied = await OTA.applyUpdate(result);
    if (applied) {
        Alert.alert('Update Ready', 'Restart the app to apply the update.', [
            { text: 'Later' },
            { text: 'Restart', onPress: () => RNRestart.Restart() },
        ]);
    }
}
```

**d. Using the React hook:**

```javascript
import { useOTAUpdate } from './ota-sdk/src/useOTAUpdate';

function UpdateBanner() {
    const { status, checkNow, downloadNow, applyNow, OTA_STATUS } = useOTAUpdate({
        autoCheck: true,
    });

    if (status === OTA_STATUS.AVAILABLE) {
        return <Button title="Download Update" onPress={downloadNow} />;
    }
    if (status === OTA_STATUS.READY) {
        return <Button title="Install & Restart" onPress={applyNow} />;
    }
    return null;
}
```

---

## Publishing an Update

### 1. Build

```bash
# From your React Native project root
ota build --platform android --app-version 1.0.0 --runtime-version 1.0.0

# Output goes to ./ota-output/
#   ├── index.android.bundle
#   ├── assets/
#   └── manifest.json
```

### 2. Publish

```bash
ota publish --dir ./ota-output --server http://localhost:3000 --rollout 100

# Partial rollout (10% of users):
ota publish --dir ./ota-output --server http://localhost:3000 --rollout 10
```

### 3. Verify

```bash
# Check server has the update
curl http://localhost:3000/updates

# Simulate a client check
curl "http://localhost:3000/check?appVersion=1.0.0&runtimeVersion=1.0.0"
```

---

## Testing the OTA Flow

### Quick local test:

1. Start server: `cd ota-server && npm start`
2. Build your RN app normally, run on device/emulator
3. Make a JS change in your RN app
4. Build OTA: `ota build --platform android`
5. Publish: `ota publish --dir ./ota-output`
6. The app should detect the update on next check
7. Download + apply, restart app → new code loads

### Testing rollback:

1. Publish an update that intentionally crashes (e.g., throw in componentDidMount)
2. App downloads and applies it
3. On restart, app crashes → native module detects crash loop
4. On next restart, native module rolls back to previous bundle

---

## Production Considerations

### CDN Integration

Replace direct bundle serving with a CDN:

```javascript
// In ota-server, return CDN URLs instead of local paths
manifest.bundleUrl = `https://cdn.example.com/ota/${updateId}/bundle.js`;

// Upload bundles to S3/CloudFront/Cloudflare R2 during publish
```

### Gradual Rollouts

Already built-in. Use `--rollout` percentage:
- Start at 1%, monitor crash rates
- Increase to 10%, 50%, 100%
- Rollout is deterministic per clientId (same device always gets same result)

### Background Updates

```javascript
// Use React Native's AppState to check in background
import { AppState } from 'react-native';

AppState.addEventListener('change', (state) => {
    if (state === 'background') {
        // Pre-download update so it's ready when user returns
        OTA.checkForUpdate().then(update => {
            if (update) OTA.downloadUpdate(update).then(OTA.applyUpdate);
        });
    }
});
```

### Analytics

Add event tracking to the SDK:

```javascript
// In updater.js, emit events:
// - ota.check (with result)
// - ota.download.start / .complete / .fail
// - ota.apply
// - ota.rollback
// - ota.stable

// Send to your analytics provider (Amplitude, Mixpanel, etc.)
```

### Delta Updates

For delta/diff updates:
1. Server stores the previous bundle alongside the new one
2. On publish, compute a binary diff (bsdiff)
3. Client downloads the diff instead of full bundle
4. Client applies diff to current bundle to produce the new one
5. Verify hash of the result

### Feature Flags

```javascript
// Extend the /check response:
{
    available: true,
    updateId: "...",
    featureFlags: {
        newCheckout: true,
        darkMode: false,
    }
}

// SDK exposes:
const flags = await OTA.getFeatureFlags();
if (flags.newCheckout) { /* show new UI */ }
```

### Database Migration (from in-memory)

Replace `store.js` with PostgreSQL/SQLite:

```sql
CREATE TABLE ota_updates (
    id UUID PRIMARY KEY,
    app_version VARCHAR(50) NOT NULL,
    runtime_version VARCHAR(50) NOT NULL,
    bundle_hash VARCHAR(64) NOT NULL,
    bundle_path TEXT NOT NULL,
    rollout_percentage INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_version ON ota_updates(app_version, runtime_version);
```

### Security Hardening

1. **HTTPS only** — enforce in SDK config
2. **Manifest signing** — sign manifest with private key on server, verify with public key in app
3. **Certificate pinning** — pin your server's TLS certificate in the native module
4. **Code signing** — sign bundles during build, verify signature before loading

```javascript
// Example manifest signing (server-side):
const crypto = require('crypto');
const sign = crypto.createSign('SHA256');
sign.update(JSON.stringify(manifest));
manifest.signature = sign.sign(privateKey, 'hex');

// Client-side verification:
const verify = crypto.createVerify('SHA256');
verify.update(JSON.stringify(manifestWithoutSignature));
const valid = verify.verify(publicKey, manifest.signature, 'hex');
```