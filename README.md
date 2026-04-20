# react-native-ota-updates

**Self-hosted over-the-air updates for React Native.** MongoDB for metadata, any S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze, Wasabi, MinIO) for bundles. Multi-tenant, staged rollouts, crash-loop rollback, and **same-launch delivery** — the OTA bundle downloads, extracts, and loads before the splash screen is gone.

alsoDesigned as a drop-in, fully self-hosted alternative to Expo EAS Update and the deprecated App Center CodePush.

---

## Features

- **Same-launch OTA apply** — bundle and assets download + install during the app's splash screen. No "update applies next launch" UX limbo.
- **Single-zip asset delivery** — all React Native assets ship as one zip instead of hundreds of HTTP GETs. On a typical app this is ~10× faster than per-asset downloads.
- **Multi-tenant** — one server hosts updates for any number of apps / projects, each with its own API keys.
- **Staged auto-ramping rollouts** — publish once with e.g. `5% → 25% → 50% → 100% over 4 hours`. Server picks the right pct for each `/check` based on elapsed time.
- **Deterministic rollout buckets** — the same `clientId` always lands in the same bucket, so devices don't flap in and out of an in-progress rollout.
- **Crash-loop rollback** — if a new bundle crashes twice in a row on launch, the native module automatically rolls back to the embedded build.
- **SHA-256 integrity** verified on both bundle and assets zip, on publish and on download.
- **Release channels** — `production`, `staging`, `beta`, or whatever you want. Devices pick their channel at install time via native config.
- **Built-in admin dashboard** at `/admin` — create projects, mint API keys, list publishes, rollback, delete.
- **Audit log** for every publish / rollback / delete.
- **Works with Hermes** (`.hbc` bundles) and plain JS bundles.

## Architecture

```
┌──────────────┐    publish    ┌───────────────┐   upload   ┌────────────┐
│   CLI (npm)  │──────────────▶│  API server   │───────────▶│  S3 / R2   │
│ ota-updates  │               │ Express+Mongo │            │  (bundles  │
└──────────────┘               └───────┬───────┘            │   + zips)  │
                                       │                    └─────┬──────┘
┌──────────────┐    /check, /manifest  │                          │
│   RN device  │◀──────────────────────┘                          │
│  (library)   │                                                  │
│              │──────── direct download (public / presigned) ────┘
└──────────────┘
```

- Device downloads go **directly** from your S3/R2 bucket — the API server never handles bundle bytes after upload, so it scales cheaply.
- API server only serves small JSON responses (`/check`, `/manifest`).
- Metadata (projects, api keys, updates, audit log) lives in MongoDB.

---

## Install in a React Native app

```bash
npm install react-native-ota-updates
# or
yarn add react-native-ota-updates
```

If you're on Expo with a development build, also add to `app.config.js`:

```js
plugins: [
  ['react-native-ota-updates', {
    serverUrl: 'https://ota.example.com',
    projectId: 'your-project-slug',
    channel: 'production',
  }],
],
```

Then `npx expo prebuild` and rebuild the native app.

### Configure in JS

```ts
import * as OTAUpdates from 'react-native-ota-updates';

OTAUpdates.configure({
  serverUrl: 'https://ota.example.com',
  projectId: 'your-project-slug',
  channel: 'production',
  appVersion: '1.4.9',
  runtimeVersion: '1.4.9',
  clientId: 'uuid-from-your-analytics',
  debug: __DEV__,
});

// Typical JS flow:
const check = await OTAUpdates.checkForUpdate();
if (check.available) {
  const result = await OTAUpdates.downloadUpdate(check);
  await OTAUpdates.applyUpdate(result);
  await OTAUpdates.reloadAsync();
}
```

### Native launch-time check (recommended)

The native module can also do `/check` + download before the React context is created, so a fresh OTA applies on the *same* launch without any JS intervention. Wire it up in your `MainApplication.kt`:

```kotlin
override fun getJSBundleFile(): String? {
    return OTAUpdatesModule.getBundleFile(this@MainApplication) ?: super.getJSBundleFile()
}

override fun onCreate() {
    super.onCreate()
    OTAUpdatesModule.install(this)
    SoLoader.init(this, false)
}
```

and in `AndroidManifest.xml` under `<application>`:

```xml
<meta-data android:name="OTAUpdatesServerUrl" android:value="https://ota.example.com" />
<meta-data android:name="OTAUpdatesProjectId" android:value="your-project-slug" />
<meta-data android:name="OTAUpdatesChannel" android:value="production" />
```

iOS equivalent lives in `Info.plist`:

```xml
<key>OTAUpdatesServerUrl</key>
<string>https://ota.example.com</string>
<key>OTAUpdatesProjectId</key>
<string>your-project-slug</string>
<key>OTAUpdatesChannel</key>
<string>production</string>
```

### CLI: publish an update

```bash
export OTA_UPDATES_TOKEN=ota_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export OTA_UPDATES_SERVER=https://ota.example.com

# Simple publish (100% rollout, production channel)
npx ota-updates publish -p android --app-version 1.4.9

# Staged rollout: 5% → 50% → 100% over 2 hours
npx ota-updates publish -p android --app-version 1.4.9 \
  --rollout-schedule '[{"atMinutes":0,"pct":5},{"atMinutes":60,"pct":50},{"atMinutes":120,"pct":100}]'

# Publish to a staging channel
npx ota-updates publish -p android --app-version 1.4.9 --channel staging --label "hotfix-3"
```

---

## Self-host the server

See **[SELF_HOSTING.md](SELF_HOSTING.md)** for the full walkthrough. Quick start with Docker:

```bash
git clone https://github.com/your-org/react-native-ota-updates
cd react-native-ota-updates/server
cp .env.example .env
docker compose up -d
```

Open `http://localhost:4000/admin` (user `admin` / password from your `.env`) to create your first project and mint an API key.

---

## Security

- API keys are never stored in plaintext (SHA-256 hashed in MongoDB).
- SHA-256 integrity verification on bundles and asset zips, both server-side (after upload) and client-side (after download).
- Public `projectId` is safe to ship in the app — it only authorises read access to `/check` and `/manifest`.
- Path-traversal guards on both server (upload rel paths) and client (zip extraction).
- All admin routes are protected by HTTP Basic Auth with constant-time comparison.
- Automatic crash-loop rollback on the client — two crashes in a row on launch revert to the embedded bundle.

## License

MIT
