# Delta Updates — Design Spec

**Status:** Design approved in brainstorming (2026-04-28); spec doc pending user review
**Author:** Shafaq + Claude (brainstorming session)
**Roadmap item:** #8 Delta updates
**Implementation tracking:** see follow-up plan in `docs/superpowers/plans/`

---

## 1. Overview

OTA updates currently ship the full bundle (`bundle.hbc`) on every publish. For Liquide, that bundle is ~18 MB. At 5L MAU, every update push transfers ~9 TB of egress and forces every device through a 25-40 second download on cellular, which often results in updates not applying within the user's session.

This spec introduces **binary delta updates**: the server pre-computes a binary patch between the new bundle and the previous active bundle at publish time. Clients download the much smaller patch (~1-3 MB) and apply it locally to reconstruct the new bundle. Bandwidth savings are 85-95%; perceived download time goes from 25-40 s to 3-5 s.

The mechanism is **bsdiff** (Colin Percival, 2003) — the same algorithm used by Apple Sparkle, Google Chrome auto-update, Expo EAS Update, and Microsoft CodePush.

## 2. Goals & Non-Goals

### Goals

- Reduce OTA payload size by ≥80% for the common case (a device on the previous active bundle)
- Reduce P95 update download wall-time on 4G from ~30s to ≤8s
- Maintain absolute correctness: zero risk of an incorrect bundle being applied
- Be additive — every existing client and every existing publish path keeps working unchanged
- Stay backwards/forwards compatible: any combination of {old/new client, old/new server} falls back gracefully to the existing full-bundle flow

### Non-Goals (v1)

- Diff coverage beyond the immediately previous active bundle (devices on N-2 or older fall back to full)
- Asset-zip diffing (assets stay full download)
- Server-side delta hit-rate metrics (deferred to roadmap item #4 / #9)
- Cross-bundle hash chain repair (A→B→C two-step diffs)
- Out-of-band diff invalidation
- Async / background diff generation (synchronous at publish time only)

## 3. Decisions Made During Brainstorming

| Decision | Choice | Rationale |
|---|---|---|
| Diff format | **bsdiff** | Industry standard. ~85-95% size reduction. Vendor-stable (~30 years). |
| Diff coverage | **Last 1 active version only** | Cheapest publish (~30-60s extra). Covers ~70-85% of devices. Simplest to operate. Can extend later. |
| Diff timing | **Synchronous at publish time** | Publish is rare and CLI-driven, so a 2-3 minute publish is acceptable. No queue/worker infra to build. |
| Server bsdiff implementation | **Spawn `bsdiff` binary via `apk add bsdiff`** | No Node native addon, no build complexity. 30-year-stable C program. |
| iOS bspatch implementation | **Vendor `bspatch.c` into the pod, link `libbz2`** | iOS ships libbz2; vendor is one C file. |
| Android bspatch implementation | **Vendor `bspatch.c` + minimal bzip2 sources via NDK/JNI** | NDK doesn't ship libbz2. C path takes ~500ms vs ~5-10s for a Java port — matters on low-end devices. One-time NDK setup. |
| Manifest API shape | **`/v1/manifest/:id?from=<currentBundleHash>`** | Reuses the existing endpoint. Server picks the diff. Client signals only its current hash. |
| Failure policy | **Silent fallback to full bundle on any failure** | Worst case is identical to current production behavior. No new user-visible failure modes. |
| Patch size guard | **Skip persistence if `patchSize > 0.6 × bundleSize`** | Avoids storing diffs that don't save meaningful bandwidth. |
| Telemetry/observability | **`log()` calls only in v1** | Defer structured metrics to roadmap items #4 / #9. |

## 4. Architecture

```
Publisher                         Server                            R2                            Device
─────────                         ──────                            ──                            ──────
liquide-ota publish ───POST───►  /v1/publish
                                  ├─ upload new.hbc ─────────────► <slug>/<newId>/bundle.hbc
                                  ├─ fetch latest active ◄────── <slug>/<oldId>/bundle.hbc
                                  ├─ run bsdiff (~30-60s)
                                  ├─ upload patch ────────────────► <slug>/<newId>/diffs/<oldId>.patch
                                  ├─ insert UpdateDiff row
                                  └─ respond 200 to CLI

                                  /v1/check (unchanged) ◄──────────────────────────────────────── /v1/check
                                                                                                  /v1/manifest/:newId
                                                                                                    ?from=<currentBundleHash>
                                  /v1/manifest/:newId
                                  ├─ look up UpdateDiff
                                  └─ return manifest with diff fields if found
                                                                                                  Native code:
                                                                                                  if diffUrl AND device has fromBundleHash:
                                                                                                    download patch
                                                                                                    bspatch(current, patch) → new
                                                                                                    sha256(new) === bundleHash?
                                                                                                       yes → apply
                                                                                                       no  → fall back to full
                                                                                                  else:
                                                                                                    download full bundle (existing path)
```

## 5. Server Changes

### 5.1 New schema: `UpdateDiff` (Mongo)

A separate collection rather than embedding into `Update`. Lookup by destination + source-hash needs its own compound index.

```js
const updateDiffSchema = new mongoose.Schema({
  toUpdateId:     { type: ObjectId, ref: 'Update', required: true },
  fromUpdateId:   { type: ObjectId, ref: 'Update', required: true },
  fromBundleHash: { type: String, required: true },
  patchKey:       { type: String, required: true },
  patchHash:      { type: String, required: true },
  patchSize:      { type: Number, required: true },
  createdAt:      { type: Date, default: Date.now },
});

updateDiffSchema.index(
  { toUpdateId: 1, fromBundleHash: 1 },
  { unique: true },
);
```

### 5.2 New service: `server/src/services/diff.js`

Holds the 5-step pipeline:

```
1. Download base bundle from R2
2. Write new bundle (already in memory) + base to /tmp/<workdir>/
3. Spawn `bsdiff old new patch.bin`  (niced -n 10)
4. If patch > 0.6 × bundle size, log + skip
5. Upload patch to R2 at <slug>/<newId>/diffs/<oldId>.patch
6. Insert UpdateDiff row
7. Cleanup tmp dir (try/finally)
```

Public API:
- `generate(baseUpdate, newUpdate, newBundleBuffer, projectSlug): Promise<UpdateDiffDoc | null>`

Returns `null` if the patch was skipped (size guard) or generation failed; service does not throw upward.

### 5.3 `publish.js` — wire diff generation in

After `Update.create(...)` and before `res.json(...)`:

```js
const baseUpdate = await Update.findOne({
  projectId: req.project._id,
  platform, appVersion, runtimeVersion,
  channel: update.channel,
  status: 'active',
  _id: { $ne: update._id },
}).sort({ createdAt: -1 }).lean();

if (baseUpdate) {
  try {
    console.log(`[OTA] Generating diff (${baseUpdate._id} → ${update._id})…`);
    await diffService.generate(baseUpdate, update, bundleFile.buffer, req.project.slug);
  } catch (err) {
    console.error(`[OTA] Diff generation failed (non-fatal):`, err);
  }
}
```

### 5.4 `manifest.js` — accept `?from=` and return diff fields

```js
const fromHash = req.query.from;
const body = buildPayload(update);

if (fromHash) {
  const diff = await UpdateDiff.findOne({
    toUpdateId: id,
    fromBundleHash: fromHash,
  }).lean();
  if (diff) {
    body.diffUrl        = s3.publicUrl(diff.patchKey);
    body.diffHash       = diff.patchHash;
    body.diffSize       = diff.patchSize;
    body.fromBundleHash = diff.fromBundleHash;
  }
}
res.json(body);
```

**Cache adjustment:** the per-worker manifest cache key changes from `id` to `${id}|${fromHash || 'none'}`. CF `Cache-Control` is preserved only when `from` is absent (the no-diff fallback path); when `from` is present, set `Cache-Control: private, no-store` since clients only fetch a given (id, from) pair once.

### 5.5 Dockerfile

```dockerfile
RUN apk add --no-cache bsdiff
```

## 6. Native Module Changes

### 6.1 New native method (both platforms)

```ts
applyPatch(basePath: string, patchPath: string, outputPath: string): Promise<void>;
```

Inputs are absolute file paths. The native side reads `basePath`, applies `patchPath`, writes the result to `outputPath`, returns. JS-side hash verification happens after.

### 6.2 iOS implementation

- Drop `bspatch.c` (~200 LOC, BSD-2-Clause) into `ios/`.
- Update `react-native-ota-updates.podspec` to include `*.c` in source files.
- Add `OTABsPatch.m` ObjC bridge wrapping the C function.
- Wire `applyPatch:resolver:rejecter:` into `OTAUpdatesModule.m`.
- Add `'-lbz2'` to podspec `OTHER_LDFLAGS`.

### 6.3 Android implementation

- `android/src/main/cpp/bspatch.c` (~200 LOC)
- `android/src/main/cpp/bzip2/` — minimal upstream bzip2 sources (~7 C files, ~3000 LOC)
- `android/src/main/cpp/jni_bridge.c` — single JNI function `Java_com_otaupdates_OTAUpdatesModule_applyPatchNative`
- `android/CMakeLists.txt` declaring the static lib target
- `OTAUpdatesModule.kt` adds `external fun applyPatchNative(...)` with `System.loadLibrary("otaupdates")` and a `@ReactMethod` wrapper that resolves/rejects a Promise

`build.gradle` additions:
```gradle
android {
  externalNativeBuild { cmake { path "CMakeLists.txt" } }
  defaultConfig {
    externalNativeBuild { cmake { cppFlags "-O2" } }
    ndk { abiFilters "armeabi-v7a", "arm64-v8a", "x86", "x86_64" }
  }
}
```

### 6.4 Error contract

Native rejects with a typed code on failure (e.g., `BSPATCH_FAILED`, `INPUT_NOT_FOUND`, `OOM`). Updater.ts treats any error as "fall back to full" — no per-code branching at JS layer. Native logs detail for ops.

## 7. Client / SDK Changes

### 7.1 Type additions (`src/types.ts`)

```ts
export interface UpdateManifest {
  // existing fields…
  diffUrl?: string | null;
  diffHash?: string | null;
  diffSize?: number | null;
  fromBundleHash?: string | null;
}
```

### 7.2 `downloadUpdate` flow (`src/updater.ts`)

The function gains a delta-path branch inserted between manifest fetch and bundle download. Existing full-download code is refactored into a named helper `fullBundleDownload` and used as the fallback.

```ts
const current = await Storage.getCurrent();
const fromParam = current?.bundleHash
  ? `?from=${encodeURIComponent(current.bundleHash)}`
  : '';
const manifest: UpdateManifest = await fetchManifest(`${manifestUrl}${fromParam}`);

const deltaApplicable =
  manifest.diffUrl &&
  manifest.fromBundleHash &&
  current?.bundlePath &&
  current.bundleHash === manifest.fromBundleHash;

if (deltaApplicable) {
  try {
    await applyDelta(current!.bundlePath, manifest, dir, finalBundle);
  } catch (err) {
    log('Delta path failed, falling back to full download', err);
    await fullBundleDownload(manifest, dir, finalBundle, bundleHash!);
  }
} else {
  await fullBundleDownload(manifest, dir, finalBundle, bundleHash!);
}
```

### 7.3 New helper: `applyDelta`

```ts
async function applyDelta(basePath, manifest, dir, finalBundle) {
  const patchPath = `${dir}/bundle.patch`;
  const tmpOut    = `${finalBundle}.tmp`;

  await Native.downloadFile(absoluteUrl(manifest.diffUrl!), patchPath);

  const actualPatchHash = await Native.sha256File(patchPath);
  if (actualPatchHash !== manifest.diffHash) throw new Error('Patch hash mismatch');

  await Native.applyPatch(basePath, patchPath, tmpOut);

  const actualOut = await Native.sha256File(tmpOut);
  if (actualOut !== manifest.bundleHash) throw new Error('Reconstructed bundle hash mismatch');

  await Native.moveFile(tmpOut, finalBundle);
  await Native.deleteFile(patchPath).catch(() => {});
}
```

### 7.4 Storage layer

No changes. `Storage.setCurrent` already persists `bundleHash` (updater.ts:115); `Storage.getCurrent` already returns it. `current.bundleHash` is the canonical source for the `from=` query param.

### 7.5 Logging

Three new `log()` calls behind the existing `config.debug` flag:
- `'Bundle reconstructed via delta (<size> bytes)'` — success
- `'Delta path failed, falling back to full download'` — fallback (with reason)
- `'No delta available, full download'` — no diff returned

## 8. Failure Modes

### 8.1 Server-side (every failure → no diff fields in manifest → device falls back)

- `bsdiff` subprocess missing/crashes → publish.js catch logs + continues
- Base bundle download from R2 fails → same
- Patch upload to R2 succeeds but Mongo insert fails → orphan patch in R2 (~1.5 MB; logged for periodic cleanup)
- `/v1/manifest` `UpdateDiff.findOne` errors → wrapped in try/catch, omit diff fields
- Patch larger than 60% of new bundle → skip persistence, log

### 8.2 Client-side (every failure → fall back to full bundle download)

- `?from=` doesn't match any UpdateDiff → manifest omits diff fields → full path
- `current.bundleHash` undefined (old SDK migrating) → no `?from=` → full path
- Patch download fails (network/404/timeout) → catch in applyDelta → full path
- Patch hash mismatch → full path
- Native `applyPatch` throws → full path
- **Reconstructed bundle hash mismatch (critical safety net) → full path**

### 8.3 Race conditions

- New publish between check and manifest → server returns the latest manifest; if a diff exists, used. Mathematically equivalent to a single check at T+ε.
- Device on a `status: rolledback` bundle → diff lookup is by `(toUpdateId, fromBundleHash)` only, source status irrelevant. Patch is mathematically valid bytes-to-bytes.
- Concurrent OTA checks on device → same as today; both attempt download, second uses cache.
- Disk-full during patch → native rejects → fall back to full download (same disk pressure, but tmp cleanup is correct).

### 8.4 Operational guard rails

- bsdiff subprocess `nice -n 10` so concurrent `/v1/check` requests aren't impacted on the same pod.
- `try/finally` cleanup of `/tmp/bsdiff-<id>` on every code path.
- 60% patch-size guard.
- No automatic retry of delta path. Subsequent app launches re-evaluate from scratch.

## 9. Testing Approach

### 9.1 Server unit tests (Jest, new in `server/`)

- **bsdiff round-trip** — feed two small buffers, verify patch reconstructs new buffer exactly.
- **Diff size guard** — feed dissimilar buffers, verify service skips persistence.
- **Failure isolation** — mock `s3.uploadBuffer` to throw, verify no tmp leftovers.

### 9.2 Client unit tests (Jest, new at library root)

- **Happy path** — mock all `Native.*`, verify call sequence on success.
- **Fallback on corrupted patch** — mock wrong patch hash, verify `fullBundleDownload` is called and no partial files.

### 9.3 Native modules — rely on upstream stability

iOS: smoke test in example app calling `applyPatch` on a fixture, asserting output hash. ~15 LOC.
Android: JUnit `androidTest/` with the same fixture. ~15 LOC.
Test fixtures: `__fixtures__/old.bin` + `new.bin` + `patch.bin` (offline-generated, checked in).

### 9.4 Manual E2E checklist (run on staging before merge)

- Publish V1 → verify no UpdateDiff row.
- Publish V2 → verify UpdateDiff row + R2 patch + CLI shows "Diff generated".
- Device at V1 → trigger update → confirm `?from=<V1_hash>` in manifest URL, network log shows ~1-3 MB download not 18 MB.
- Device at V0 (no diff) → confirm full-download fallback.
- Manually corrupt the R2 patch → confirm device logs failure and full-download path completes.
- Old SDK against new server → full path works.
- New SDK against old server → full path works.

### 9.5 Performance smoke (in PR)

- Patch download size + bspatch wall-time on a real low-end Android device for an 18 MB bundle.
- Total update-applied time delta-vs-full.

## 10. Rollout Plan

1. **Library PR:** SDK + native modules + spec + tests. Released as a minor version bump (deltas are additive, no breaking API changes).
2. **Server PR (library repo):** schema + diff service + publish/manifest changes + Dockerfile. Merge first; deploy to staging.
3. **Server PR (Liquide repo):** identical changes ported, same Dockerfile change.
4. **Staging E2E:** run the manual checklist (§9.4). Capture performance numbers (§9.5).
5. **Library version bump:** publish to GitHub Packages.
6. **Liquide-app upgrade:** consume the new library version, ship a new RN binary build (the native code change requires a new app store / Play Store release — *not* a JS-only OTA).
7. **Production publish with delta enabled:** first delta-aware publish goes out. Devices with the new RN binary use deltas; older binaries take full path. No coordination required.
8. **Monitor logs** for delta success / fallback rates over the first 48 hours.

### 10.1 Backout plan

If delta path causes elevated failures, the server can be rolled back independently of clients:
- Remove the `await diffService.generate(...)` call from `publish.js` and redeploy. New publishes won't generate diffs.
- Or: drop `UpdateDiff` rows for affected updates. `manifest.js` returns no diff fields → clients fall back to full path on next check.

No client rollback required.

## 11. Open Questions / Future Work

- **Coverage expansion to N=3:** if production telemetry shows significant fallback rate (>15-20%), upgrade to diff against last 3 active versions. Triples publish CPU but covers ~95% of devices.
- **Async diff generation:** if publish wall-time becomes a developer pain point, move diff generation to a background queue. Adds infra cost (Mongo-backed queue + worker process) but keeps publish snappy.
- **Asset zip diffing:** if assets grow large enough to matter (currently ~5 MB on Android), apply same bsdiff approach to assets.zip.
- **Delta hit-rate metrics:** ship as part of roadmap item #4 (structured logging) or #9 (adoption tracking).
- **bsdiff5 / xdelta3:** if bsdiff CPU becomes a bottleneck at higher publish frequency, evaluate xdelta3 (~2-3× faster compute, slightly larger output).

---

## Appendix A — File-by-file change inventory

### Library repo (`liquide-inhouse-ota`)

| File | Change |
|---|---|
| `server/src/db/mongo.js` | Add `updateDiffSchema` and export `UpdateDiff` model |
| `server/src/services/diff.js` | **NEW** — diff pipeline service |
| `server/src/routes/publish.js` | Wire `diffService.generate` after `Update.create` |
| `server/src/routes/manifest.js` | Accept `?from=`, return diff fields, adjust cache key |
| `server/Dockerfile` | `RUN apk add --no-cache bsdiff` |
| `server/package.json` | Add `jest` devDep, `test` script |
| `server/src/services/diff.test.js` | **NEW** — unit tests |
| `src/types.ts` | Extend `UpdateManifest` interface |
| `src/native.ts` | Add `applyPatch` typings |
| `src/updater.ts` | Add delta branch, `applyDelta` helper, refactor full-download into named helper |
| `src/__tests__/updater.delta.test.ts` | **NEW** — unit tests |
| `package.json` | Add `jest` devDep, `test` script |
| `ios/bspatch.c` | **NEW** — vendored bspatch source |
| `ios/OTABsPatch.h` + `.m` | **NEW** — ObjC bridge |
| `ios/OTAUpdatesModule.m` | Add `applyPatch:resolver:rejecter:` |
| `react-native-ota-updates.podspec` | Include `*.c`, add `-lbz2` |
| `android/CMakeLists.txt` | **NEW** — declare static lib |
| `android/src/main/cpp/bspatch.c` | **NEW** — vendored bspatch |
| `android/src/main/cpp/bzip2/` | **NEW** — vendored bzip2 sources |
| `android/src/main/cpp/jni_bridge.c` | **NEW** — JNI wrapper |
| `android/src/main/java/com/otaupdates/OTAUpdatesModule.kt` | Add `applyPatch` ReactMethod + `external fun applyPatchNative` |
| `android/build.gradle` | Add `externalNativeBuild { cmake { ... } }` |
| `__fixtures__/old.bin`, `new.bin`, `patch.bin` | **NEW** — test fixtures |

### Liquide repo (`liquide-ota-server`)

Mirrors all `server/` changes from the library repo. No additional Liquide-specific changes.

---

## Appendix B — Decision Log

| # | Decision point | Options considered | Chosen | Reason |
|---|---|---|---|---|
| 1 | Bundle size driver | Under 2 MB / 2-5 MB / 5-15 MB / 15+ MB | 18 MB → 15+ MB tier | Confirmed via admin dashboard. Delta is mandatory at this size. |
| 2 | Diff coverage | N=1 / N=3 / N=5 / hybrid | **N=1** | Cheapest publish, 70-85% device coverage, simplest. |
| 3 | Diff timing | Synchronous / async background | **Synchronous** | Publishes are rare; no queue/worker infra to build. |
| 4 | Server bsdiff impl | Spawn binary / Node native addon / WASM | **Spawn `bsdiff` binary** | Standard, stable, simple Dockerfile change. |
| 5 | iOS bspatch impl | Vendored C / Swift port | **Vendored C** | iOS ships libbz2; one C file; performant. |
| 6 | Android bspatch impl | Vendored C+NDK / Kotlin port / jbsdiff | **Vendored C+NDK** | C is ~10× faster on low-end devices; one-time NDK setup. |
| 7 | Manifest API shape | `?from=` query / new endpoint / array of diffs in manifest | **`?from=` on existing endpoint** | Reuses endpoint, server picks. |
| 8 | Failure policy | Silent fallback / surface to host app / both | **Silent fallback + log** | Worst case = current production behavior. No new user-visible failures. |
| 9 | Patch size guard | None / fixed % | **60% threshold** | Avoids storing diffs that don't save meaningful bandwidth. |
| 10 | Telemetry | Built-in / deferred | **Deferred** | Belongs in dedicated observability roadmap items. |
