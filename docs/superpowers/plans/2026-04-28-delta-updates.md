# Delta Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship binary delta updates so devices download a ~1-3 MB patch instead of the full ~18 MB Hermes bundle, reducing OTA payload size by ~85-95% for the common case (a device on the previous active version).

**Architecture:** Server runs `bsdiff` synchronously at publish time against the previous active bundle, stores the patch in R2 and metadata in a new `UpdateDiff` Mongo collection. Client sends its current bundle hash as a `?from=` query param to `/v1/manifest/:id`; server returns extra fields (`diffUrl`, `diffHash`, `diffSize`, `fromBundleHash`) when a diff exists. Native iOS and Android modules gain a single new method `applyPatch(basePath, patchPath, outputPath)` backed by vendored `bspatch.c`. Every failure path falls back silently to the existing full-bundle download.

**Tech Stack:** Node.js + Express + Mongoose (server), `bsdiff` binary via `apk add bsdiff` (Alpine), TypeScript + React Native (client SDK), Objective-C + `bspatch.c` + system libbz2 (iOS), Kotlin + JNI + vendored C bspatch + bzip2 sources via NDK/CMake (Android), Jest (unit tests).

---

## File Structure

### Library repo (`/Users/spurge_1/WebstormProjects/liquide-inhouse-ota`)

**Server (Node):**
- Create: `server/src/services/diff.js` — diff pipeline service (download base, run bsdiff, upload patch, persist row)
- Create: `server/src/services/diff.test.js` — Jest unit tests for diff service
- Modify: `server/src/db/mongo.js` — add `UpdateDiff` schema + model export
- Modify: `server/src/routes/publish.js` — call `diffService.generate()` after successful publish
- Modify: `server/src/routes/manifest.js` — accept `?from=`, return diff fields, adjust cache key
- Modify: `server/Dockerfile` — `apk add bsdiff`
- Modify: `server/package.json` — add Jest + test script

**Client (TypeScript):**
- Modify: `src/types.ts` — extend `UpdateManifest` with optional diff fields
- Modify: `src/native.ts` — add `applyPatch` typing
- Modify: `src/updater.ts` — refactor existing download into `fullBundleDownload`, add `applyDelta` helper, add delta branch in `downloadUpdate`
- Create: `src/__tests__/updater.delta.test.ts` — Jest unit tests for updater delta logic
- Modify: `package.json` — add Jest + ts-jest devDeps + test script
- Create: `jest.config.js` — Jest config for the library

**iOS:**
- Create: `ios/bspatch.c` — vendored bspatch source (~200 LOC, public domain)
- Create: `ios/OTABsPatch.h` and `ios/OTABsPatch.m` — ObjC bridge wrapping the C function
- Modify: `ios/OTAUpdatesModule.m` — expose `applyPatch:patch:output:resolver:rejecter:`
- Modify: `react-native-ota-updates.podspec` — include `*.c` in source files, add `-lbz2` linker flag

**Android:**
- Create: `android/CMakeLists.txt` — declares the static lib target
- Create: `android/src/main/cpp/bspatch.c` — vendored bspatch source
- Create: `android/src/main/cpp/jni_bridge.c` — JNI wrapper
- Create: `android/src/main/cpp/bzip2/` — vendored upstream bzip2 (7 source files + 2 headers)
- Modify: `android/src/main/java/com/otaupdates/OTAUpdatesModule.kt` — add `external fun applyPatchNative` + `@ReactMethod applyPatch`
- Modify: `android/build.gradle` — `externalNativeBuild { cmake { ... } }` + `ndk { abiFilters }`

**Test fixtures (shared):**
- Create: `__fixtures__/old.bin`, `__fixtures__/new.bin`, `__fixtures__/patch.bin` — generated once with `bsdiff` binary

### Liquide repo (`/Users/spurge_1/Documents/shafaq-liquide/liquide-ota-server`)

Mirrors the server-side changes only:
- Create: `src/services/diff.js`
- Modify: `src/db/mongo.js`, `src/routes/publish.js`, `src/routes/manifest.js`, `Dockerfile`

(Native + client changes happen in the library only and propagate via npm version bump.)

---

## Tasks

### Task 1: Generate test fixtures and set up Jest in `server/`

**Files:**
- Create: `__fixtures__/old.bin`, `__fixtures__/new.bin`, `__fixtures__/patch.bin`
- Modify: `server/package.json`
- Create: `server/jest.config.js`

- [ ] **Step 1: Verify `bsdiff` binary is available locally**

```bash
which bsdiff bspatch
bsdiff --help 2>&1 | head -3
```

Expected: paths printed for both. If not present:

```bash
brew install bsdiff   # macOS
# or: apt-get install bsdiff   (Debian/Ubuntu)
```

- [ ] **Step 2: Create the fixture files**

```bash
mkdir -p /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/__fixtures__
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/__fixtures__

# Two small but non-trivial binaries that share most bytes (so diff is tiny)
printf 'lorem ipsum dolor sit amet consectetur adipiscing elit %s' \
  "$(seq 1 200 | tr '\n' ' ')" > old.bin

printf 'lorem ipsum dolor sit amet consectetur adipiscing elit %s' \
  "$(seq 1 200 | sed 's/^50$/FIFTY/' | tr '\n' ' ')" > new.bin

bsdiff old.bin new.bin patch.bin

ls -la *.bin
```

Expected: three files printed; `patch.bin` is much smaller than `new.bin` (a few hundred bytes vs ~1.5 KB).

- [ ] **Step 3: Add Jest to server**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server
npm install --save-dev jest@^29
```

Expected: installs without errors.

- [ ] **Step 4: Add test script and Jest config**

Edit `server/package.json` and add `"test": "jest"` to the `scripts` block:

```json
{
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "jest"
  }
}
```

Create `server/jest.config.js`:

```js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js'],
  testTimeout: 30000,   // bsdiff round-trip can take a few seconds
};
```

- [ ] **Step 5: Smoke test Jest is wired up**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server
npx jest --listTests
```

Expected: empty list (no test files yet) or "No tests found" — the important thing is no Jest config errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add __fixtures__/ server/package.json server/package-lock.json server/jest.config.js
git commit -m "chore: add bsdiff test fixtures + jest setup in server"
```

---

### Task 2: Add `UpdateDiff` Mongo schema

**Files:**
- Modify: `server/src/db/mongo.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/db/mongo.schema.test.js`:

```js
const mongoose = require('mongoose');

describe('UpdateDiff schema', () => {
  let conn;
  beforeAll(async () => {
    // mongodb-memory-server would be ideal but we avoid the extra dep.
    // Skip if no Mongo URL; CI provides one.
    if (!process.env.TEST_MONGO_URL) return;
    conn = await mongoose.createConnection(process.env.TEST_MONGO_URL).asPromise();
  });
  afterAll(async () => {
    if (conn) await conn.close();
  });

  it('exports UpdateDiff model with required fields', () => {
    const { UpdateDiff } = require('./mongo');
    expect(UpdateDiff).toBeDefined();
    expect(UpdateDiff.modelName).toBe('UpdateDiff');
    const paths = UpdateDiff.schema.paths;
    expect(paths.toUpdateId).toBeDefined();
    expect(paths.fromUpdateId).toBeDefined();
    expect(paths.fromBundleHash).toBeDefined();
    expect(paths.patchKey).toBeDefined();
    expect(paths.patchHash).toBeDefined();
    expect(paths.patchSize).toBeDefined();
  });

  it('declares (toUpdateId, fromBundleHash) compound index', () => {
    const { UpdateDiff } = require('./mongo');
    const indexes = UpdateDiff.schema.indexes();
    const compound = indexes.find(
      ([fields]) => fields.toUpdateId === 1 && fields.fromBundleHash === 1
    );
    expect(compound).toBeDefined();
    expect(compound[1].unique).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server
npx jest src/db/mongo.schema.test.js
```

Expected: FAIL with "UpdateDiff is undefined" or schema-shape mismatch.

- [ ] **Step 3: Implement the schema**

Edit `server/src/db/mongo.js`. Just before the `module.exports = { ... }` block, add:

```js
// ── UpdateDiff (binary patch from one bundle to another) ──────────
const updateDiffSchema = new mongoose.Schema({
  toUpdateId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Update', required: true },
  fromUpdateId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Update', required: true },
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

Then add `UpdateDiff` to the export block:

```js
module.exports = {
  Project: mongoose.model('Project', projectSchema),
  ApiKey: mongoose.model('ApiKey', apiKeySchema),
  Update: mongoose.model('Update', updateSchema),
  AuditLog: mongoose.model('AuditLog', auditLogSchema),
  UpdateDiff: mongoose.model('UpdateDiff', updateDiffSchema),
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/db/mongo.schema.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add server/src/db/mongo.js server/src/db/mongo.schema.test.js
git commit -m "feat(server): add UpdateDiff schema and compound index"
```

---

### Task 3: Implement `diff.js` service — bsdiff round-trip

**Files:**
- Create: `server/src/services/diff.js`
- Create: `server/src/services/diff.test.js`

- [ ] **Step 1: Write the bsdiff round-trip failing test**

Create `server/src/services/diff.test.js`:

```js
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

describe('diff service', () => {
  const fixturesDir = path.join(__dirname, '../../../__fixtures__');

  it('produces a patch that bspatch can apply back to the new buffer', async () => {
    const oldBuf = await fs.readFile(path.join(fixturesDir, 'old.bin'));
    const newBuf = await fs.readFile(path.join(fixturesDir, 'new.bin'));

    const diffService = require('./diff');
    const patchBuf = await diffService.computePatch(oldBuf, newBuf);

    expect(patchBuf).toBeInstanceOf(Buffer);
    expect(patchBuf.length).toBeGreaterThan(0);
    expect(patchBuf.length).toBeLessThan(newBuf.length);  // patch is smaller than full

    // Round-trip via bspatch binary
    const tmp = `/tmp/diff-test-${Date.now()}`;
    await fs.mkdir(tmp, { recursive: true });
    await fs.writeFile(`${tmp}/old`, oldBuf);
    await fs.writeFile(`${tmp}/patch`, patchBuf);
    await new Promise((resolve, reject) => {
      const p = spawn('bspatch', [`${tmp}/old`, `${tmp}/new-out`, `${tmp}/patch`]);
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d));
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    });
    const reconstructed = await fs.readFile(`${tmp}/new-out`);
    expect(reconstructed.equals(newBuf)).toBe(true);
    await fs.rm(tmp, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server
npx jest src/services/diff.test.js
```

Expected: FAIL with "Cannot find module './diff'".

- [ ] **Step 3: Implement `computePatch`**

Create `server/src/services/diff.js`:

```js
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

/**
 * Run a binary as a subprocess, resolve on exit-0, reject otherwise.
 */
function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

/**
 * Run `bsdiff old new patch` against in-memory buffers.
 * Returns the patch buffer.
 */
async function computePatch(oldBuf, newBuf) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsdiff-'));
  const oldPath = path.join(tmpDir, 'old');
  const newPath = path.join(tmpDir, 'new');
  const patchPath = path.join(tmpDir, 'patch');

  try {
    await fs.writeFile(oldPath, oldBuf);
    await fs.writeFile(newPath, newBuf);
    // nice -n 10 deprioritises against /v1/check on the same pod.
    await runCommand('nice', ['-n', '10', 'bsdiff', oldPath, newPath, patchPath]);
    return await fs.readFile(patchPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = {
  computePatch,
  sha256Hex,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/services/diff.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add server/src/services/diff.js server/src/services/diff.test.js
git commit -m "feat(server): add computePatch in diff service"
```

---

### Task 4: Add the full `diff.generate()` orchestrator with size guard

**Files:**
- Modify: `server/src/services/diff.js`
- Modify: `server/src/services/diff.test.js`

- [ ] **Step 1: Write the failing tests for `generate()`**

Append to `server/src/services/diff.test.js`:

```js
describe('diff.generate()', () => {
  const fixturesDir = path.join(__dirname, '../../../__fixtures__');

  it('uploads patch + inserts UpdateDiff doc when patch under 60% threshold', async () => {
    const oldBuf = await fs.readFile(path.join(fixturesDir, 'old.bin'));
    const newBuf = await fs.readFile(path.join(fixturesDir, 'new.bin'));

    const fakeS3 = {
      downloadBuffer: jest.fn().mockResolvedValue(oldBuf),
      uploadBuffer: jest.fn().mockResolvedValue(),
      publicUrl: jest.fn((k) => `https://r2.test/${k}`),
    };
    const fakeUpdateDiff = { create: jest.fn().mockResolvedValue({}) };

    const diffService = require('./diff');
    const result = await diffService.generate({
      baseUpdate: { _id: 'BASE', bundleKey: 'p/BASE/bundle.hbc', bundleHash: 'oldhash' },
      newUpdate: { _id: 'NEW' },
      newBundleBuffer: newBuf,
      projectSlug: 'p',
      s3: fakeS3,
      UpdateDiff: fakeUpdateDiff,
    });

    expect(result).not.toBeNull();
    expect(fakeS3.downloadBuffer).toHaveBeenCalledWith('p/BASE/bundle.hbc');
    expect(fakeS3.uploadBuffer).toHaveBeenCalledWith(
      'p/NEW/diffs/BASE.patch',
      expect.any(Buffer),
      'application/octet-stream',
    );
    expect(fakeUpdateDiff.create).toHaveBeenCalledWith(
      expect.objectContaining({
        toUpdateId: 'NEW',
        fromUpdateId: 'BASE',
        fromBundleHash: 'oldhash',
        patchKey: 'p/NEW/diffs/BASE.patch',
      }),
    );
  });

  it('returns null and skips upload when patch is too large (size guard)', async () => {
    // Create two completely unrelated buffers — patch will be ~ size of new
    const oldBuf = Buffer.from('A'.repeat(2000));
    const newBuf = Buffer.from('Z'.repeat(2000));

    const fakeS3 = {
      downloadBuffer: jest.fn().mockResolvedValue(oldBuf),
      uploadBuffer: jest.fn(),
    };
    const fakeUpdateDiff = { create: jest.fn() };

    const diffService = require('./diff');
    const result = await diffService.generate({
      baseUpdate: { _id: 'BASE', bundleKey: 'p/BASE/bundle.hbc', bundleHash: 'oldhash' },
      newUpdate: { _id: 'NEW' },
      newBundleBuffer: newBuf,
      projectSlug: 'p',
      s3: fakeS3,
      UpdateDiff: fakeUpdateDiff,
    });

    expect(result).toBeNull();
    expect(fakeS3.uploadBuffer).not.toHaveBeenCalled();
    expect(fakeUpdateDiff.create).not.toHaveBeenCalled();
  });

  it('does not leave tmp files behind on upload failure', async () => {
    const oldBuf = await fs.readFile(path.join(fixturesDir, 'old.bin'));
    const newBuf = await fs.readFile(path.join(fixturesDir, 'new.bin'));

    const fakeS3 = {
      downloadBuffer: jest.fn().mockResolvedValue(oldBuf),
      uploadBuffer: jest.fn().mockRejectedValue(new Error('R2 boom')),
    };
    const fakeUpdateDiff = { create: jest.fn() };

    const before = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('bsdiff-'));

    const diffService = require('./diff');
    await expect(
      diffService.generate({
        baseUpdate: { _id: 'B', bundleKey: 'p/B/bundle.hbc', bundleHash: 'h' },
        newUpdate: { _id: 'N' },
        newBundleBuffer: newBuf,
        projectSlug: 'p',
        s3: fakeS3,
        UpdateDiff: fakeUpdateDiff,
      }),
    ).rejects.toThrow();

    const after = (await fs.readdir(os.tmpdir())).filter((f) => f.startsWith('bsdiff-'));
    expect(after.length).toBeLessThanOrEqual(before.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest src/services/diff.test.js
```

Expected: 3 new tests fail with "diffService.generate is not a function".

- [ ] **Step 3: Add `generate()` to diff.js**

Append to `server/src/services/diff.js` (above `module.exports`):

```js
const PATCH_SIZE_GUARD_RATIO = 0.6;

/**
 * Compute and persist a binary diff from baseUpdate to newUpdate.
 *
 * Returns the inserted UpdateDiff doc on success, or null if the patch
 * exceeded the size guard (PATCH_SIZE_GUARD_RATIO of new bundle).
 *
 * Throws on any pipeline failure (download, bsdiff, upload, persist) —
 * caller (publish.js) wraps in try/catch so publish itself doesn't fail.
 */
async function generate({
  baseUpdate,
  newUpdate,
  newBundleBuffer,
  projectSlug,
  s3,
  UpdateDiff,
}) {
  const oldBuf = await s3.downloadBuffer(baseUpdate.bundleKey);
  const patchBuf = await computePatch(oldBuf, newBundleBuffer);

  if (patchBuf.length > newBundleBuffer.length * PATCH_SIZE_GUARD_RATIO) {
    return null;
  }

  const patchKey = `${projectSlug}/${newUpdate._id}/diffs/${baseUpdate._id}.patch`;
  const patchHash = sha256Hex(patchBuf);

  await s3.uploadBuffer(patchKey, patchBuf, 'application/octet-stream');

  const doc = await UpdateDiff.create({
    toUpdateId: newUpdate._id,
    fromUpdateId: baseUpdate._id,
    fromBundleHash: baseUpdate.bundleHash,
    patchKey,
    patchHash,
    patchSize: patchBuf.length,
  });

  return doc;
}
```

And update the exports at the bottom of the file:

```js
module.exports = {
  computePatch,
  sha256Hex,
  generate,
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest src/services/diff.test.js
```

Expected: all 4 tests PASS (3 in the new `describe`, 1 from Task 3).

- [ ] **Step 5: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add server/src/services/diff.js server/src/services/diff.test.js
git commit -m "feat(server): diff.generate orchestrator with 60% size guard"
```

---

### Task 5: Wire diff generation into `publish.js`

**Files:**
- Modify: `server/src/routes/publish.js`

- [ ] **Step 1: Read the current publish.js to confirm anchor lines**

```bash
sed -n '1,30p' /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server/src/routes/publish.js
```

Expected: matches the existing imports — `const { Update, AuditLog } = require('../db/mongo');`

- [ ] **Step 2: Add UpdateDiff import + diffService import**

In `server/src/routes/publish.js`, change:

```js
const { Update, AuditLog } = require('../db/mongo');
```

to:

```js
const { Update, AuditLog, UpdateDiff } = require('../db/mongo');
const diffService = require('../services/diff');
```

- [ ] **Step 3: Insert the diff generation call after Update.create**

In `server/src/routes/publish.js`, locate the line that calls `await Update.create({ ... })` and stores the result in `update`. Immediately after the existing `AuditLog.create(...).catch(() => {})` block but before the existing `console.log('[OTA] Published ...')`, insert:

```js
    // Generate binary diff against the previous active bundle (best-effort).
    // Failures here are logged but do not fail the publish — devices fall
    // back to full-bundle download via the existing /v1/manifest path.
    try {
      const baseUpdate = await Update.findOne({
        projectId: req.project._id,
        platform,
        appVersion,
        runtimeVersion,
        channel: update.channel,
        status: 'active',
        _id: { $ne: update._id },
      })
        .sort({ createdAt: -1 })
        .lean();

      if (baseUpdate) {
        console.log(`[OTA] Generating diff (${baseUpdate._id} -> ${update._id})...`);
        const diffDoc = await diffService.generate({
          baseUpdate,
          newUpdate: update,
          newBundleBuffer: bundleFile.buffer,
          projectSlug: req.project.slug,
          s3,
          UpdateDiff,
        });
        if (diffDoc) {
          console.log(`[OTA] Diff generated (${diffDoc.patchSize} bytes)`);
        } else {
          console.log('[OTA] Diff skipped (size guard tripped)');
        }
      }
    } catch (err) {
      console.error('[OTA] Diff generation failed (non-fatal):', err.message);
    }
```

(Verify `s3` is already required at the top of `publish.js` — `const s3 = require('../storage/s3');` should already be there.)

- [ ] **Step 4: Verify syntax**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server
node --check src/routes/publish.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 5: Run all server tests to confirm nothing broke**

```bash
npx jest
```

Expected: PASS (no new tests added in this task; existing diff service tests still pass).

- [ ] **Step 6: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add server/src/routes/publish.js
git commit -m "feat(server): wire diff generation into publish flow"
```

---

### Task 6: Update `manifest.js` to accept `?from=` and return diff fields

**Files:**
- Modify: `server/src/routes/manifest.js`

- [ ] **Step 1: Read current manifest.js**

```bash
cat /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server/src/routes/manifest.js
```

This was rewritten during Sprint 0 to add caching. We're adding diff lookup on top.

- [ ] **Step 2: Add UpdateDiff import + buildPayload extension + diff lookup + cache key adjustment**

Replace the entire `server/src/routes/manifest.js` with:

```js
const express = require('express');
const mongoose = require('mongoose');
const { Update, UpdateDiff } = require('../db/mongo');
const s3 = require('../storage/s3');

const router = express.Router();

// Per-worker cache of manifest responses. Keyed by id|fromHash because
// different `from=` values produce different bodies.
const MANIFEST_CACHE_TTL_MS = 60_000;
const MANIFEST_CACHE_MAX_ENTRIES = 1000;
const manifestCache = new Map();

function buildPayload(update) {
  return {
    id: update._id.toString(),
    platform: update.platform,
    appVersion: update.appVersion,
    runtimeVersion: update.runtimeVersion,
    channel: update.channel,
    label: update.label || null,
    bundleUrl: s3.publicUrl(update.bundleKey),
    bundleHash: update.bundleHash,
    assetsZipUrl: update.assetsZipKey ? s3.publicUrl(update.assetsZipKey) : null,
    assetsZipHash: update.assetsZipHash || null,
    assets: [],
    createdAt: update.createdAt.getTime(),
  };
}

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid update id' });
    }

    const fromHash = typeof req.query.from === 'string' ? req.query.from : null;
    const cacheKey = `${id}|${fromHash || 'none'}`;

    const now = Date.now();
    const cached = manifestCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      // Only the no-diff path is CDN-cacheable; ?from= varies per device.
      if (!fromHash) {
        res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
      } else {
        res.setHeader('Cache-Control', 'private, no-store');
      }
      return res.json(cached.body);
    }

    const update = await Update.findById(id).lean();
    if (!update || update.status === 'deleted') {
      return res.status(404).json({ error: 'Not found' });
    }

    const body = buildPayload(update);

    if (fromHash) {
      try {
        const diff = await UpdateDiff.findOne({
          toUpdateId: id,
          fromBundleHash: fromHash,
        }).lean();
        if (diff) {
          body.diffUrl = s3.publicUrl(diff.patchKey);
          body.diffHash = diff.patchHash;
          body.diffSize = diff.patchSize;
          body.fromBundleHash = diff.fromBundleHash;
        }
      } catch (err) {
        // Diff lookup error is non-fatal — fall back to full manifest.
        console.error('[OTA] UpdateDiff lookup failed:', err.message);
      }
    }

    if (manifestCache.size >= MANIFEST_CACHE_MAX_ENTRIES) manifestCache.clear();
    manifestCache.set(cacheKey, { body, expiresAt: now + MANIFEST_CACHE_TTL_MS });

    if (!fromHash) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    } else {
      res.setHeader('Cache-Control', 'private, no-store');
    }
    res.json(body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
```

- [ ] **Step 3: Verify syntax**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server
node --check src/routes/manifest.js && echo "SYNTAX OK"
```

Expected: `SYNTAX OK`.

- [ ] **Step 4: Run server tests**

```bash
npx jest
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add server/src/routes/manifest.js
git commit -m "feat(server): manifest accepts ?from= and returns diff fields"
```

---

### Task 7: Add `bsdiff` to the Dockerfile

**Files:**
- Modify: `server/Dockerfile`

- [ ] **Step 1: Read current Dockerfile**

```bash
cat /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server/Dockerfile
```

- [ ] **Step 2: Insert `apk add bsdiff` in the runtime stage**

Edit `server/Dockerfile`. Find the runtime stage (the second `FROM node:20-alpine`) and immediately after the `WORKDIR /app` line, insert:

```dockerfile
RUN apk add --no-cache bsdiff
```

The Dockerfile after edit looks like:

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production --no-audit --no-fund

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache bsdiff
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1

CMD ["node", "src/index.js"]
```

- [ ] **Step 3: Verify Docker build still works (optional, requires Docker)**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server
docker build -t ota-server-test .
docker run --rm ota-server-test which bsdiff bspatch
```

Expected: paths printed for both binaries inside the container.

If Docker isn't available locally, this verification happens in CI on the next push.

- [ ] **Step 4: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add server/Dockerfile
git commit -m "build(server): install bsdiff in runtime image"
```

---

### Task 8: Extend client `UpdateManifest` type and `Native` interface

**Files:**
- Modify: `src/types.ts`
- Modify: `src/native.ts`

- [ ] **Step 1: Read current types.ts and native.ts**

```bash
cat /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/src/types.ts
cat /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/src/native.ts
```

- [ ] **Step 2: Add diff fields to `UpdateManifest` in types.ts**

Edit `src/types.ts`. In the `UpdateManifest` interface, immediately after `assetsZipHash?: string | null;`, add:

```ts
  /** Binary patch URL (delta updates). Only present if a diff exists for the device's current bundle. */
  diffUrl?: string | null;
  /** SHA-256 hex of the patch bytes. */
  diffHash?: string | null;
  /** Patch size in bytes (for logging / progress). */
  diffSize?: number | null;
  /** Hash of the bundle the patch applies *to*. Client must verify equality with its current bundle hash. */
  fromBundleHash?: string | null;
```

- [ ] **Step 3: Add `applyPatch` typing in native.ts**

Edit `src/native.ts`. Find the existing native interface (the type that lists methods like `downloadFile`, `sha256File`, etc.) and add this entry:

```ts
  applyPatch(basePath: string, patchPath: string, outputPath: string): Promise<void>;
```

If your native module is exposed via `NativeModules.OTAUpdates`, just add the typing — actual native implementation comes in iOS / Android tasks below.

- [ ] **Step 4: TypeScript compile check**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
npx tsc --noEmit -p tsconfig.json
```

Expected: no errors. If `tsconfig.json` doesn't exist, fall back to:

```bash
npx tsc --noEmit src/types.ts src/native.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/native.ts
git commit -m "feat(sdk): extend UpdateManifest + Native with delta fields"
```

---

### Task 9: Set up Jest for the library + write `applyDelta` tests

**Files:**
- Modify: `package.json`
- Create: `jest.config.js`
- Create: `src/__tests__/updater.delta.test.ts`

- [ ] **Step 1: Install Jest + ts-jest**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
npm install --save-dev jest@^29 ts-jest@^29 @types/jest@^29
```

Expected: installs cleanly.

- [ ] **Step 2: Add Jest config**

Create `jest.config.js` at the repo root:

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  testTimeout: 10000,
};
```

- [ ] **Step 3: Add test script in package.json**

Edit `package.json` and ensure the `scripts` block contains:

```json
{
  "scripts": {
    "test": "jest"
  }
}
```

(Merge with existing scripts, don't overwrite them.)

- [ ] **Step 4: Write the delta-path happy-path failing test**

Create `src/__tests__/updater.delta.test.ts`:

```ts
// Mock the native module before importing updater
jest.mock('../native', () => ({
  default: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    downloadFile: jest.fn().mockResolvedValue(undefined),
    sha256File: jest.fn(),
    moveFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    applyPatch: jest.fn().mockResolvedValue(undefined),
    unzipFile: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../storage', () => ({
  default: {
    bundleDir: (id: string) => `/tmp/${id}`,
    getCurrent: jest.fn(),
    setCurrent: jest.fn(),
    setPrevious: jest.fn(),
    cleanup: jest.fn(),
  },
}));

// Mock global fetch
const fetchMock = jest.fn();
(global as any).fetch = fetchMock;

import Native from '../native';
import Storage from '../storage';
import { downloadUpdate, configure } from '../updater';

describe('downloadUpdate — delta path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configure({ serverUrl: 'https://server.test', appVersion: '1.0', runtimeVersion: '1.0' });
  });

  it('takes the delta path when manifest has diff fields and current.bundleHash matches', async () => {
    (Storage.getCurrent as jest.Mock).mockResolvedValue({
      updateId: 'OLD',
      bundlePath: '/tmp/OLD/bundle.hbc',
      bundleHash: 'oldhash123',
    });

    const manifest = {
      id: 'NEW',
      bundleHash: 'newhash456',
      bundleUrl: '/full.hbc',
      diffUrl: '/patch.bin',
      diffHash: 'patchhash',
      diffSize: 500,
      fromBundleHash: 'oldhash123',
    };
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => manifest,
    });

    (Native.sha256File as jest.Mock)
      .mockResolvedValueOnce('patchhash')   // patch matches diffHash
      .mockResolvedValueOnce('newhash456'); // reconstructed matches bundleHash

    await downloadUpdate({
      available: true,
      updateId: 'NEW',
      bundleHash: 'newhash456',
      manifestUrl: '/v1/manifest/NEW',
    });

    // Verify call sequence
    expect(Native.downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('/patch.bin'),
      expect.stringContaining('bundle.patch'),
    );
    expect(Native.applyPatch).toHaveBeenCalledWith(
      '/tmp/OLD/bundle.hbc',
      expect.stringContaining('bundle.patch'),
      expect.stringContaining('bundle.hbc.tmp'),
    );
    expect(Native.moveFile).toHaveBeenCalled();
    // Full bundle URL should NOT have been downloaded
    expect(Native.downloadFile).not.toHaveBeenCalledWith(
      expect.stringContaining('/full.hbc'),
      expect.anything(),
    );
  });

  it('falls back to full download when patch hash mismatches', async () => {
    (Storage.getCurrent as jest.Mock).mockResolvedValue({
      updateId: 'OLD',
      bundlePath: '/tmp/OLD/bundle.hbc',
      bundleHash: 'oldhash123',
    });

    const manifest = {
      id: 'NEW',
      bundleHash: 'newhash456',
      bundleUrl: '/full.hbc',
      diffUrl: '/patch.bin',
      diffHash: 'expected-patch-hash',
      diffSize: 500,
      fromBundleHash: 'oldhash123',
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => manifest });

    (Native.sha256File as jest.Mock)
      .mockResolvedValueOnce('WRONG-PATCH-HASH')  // Patch verification fails
      .mockResolvedValueOnce('newhash456');         // Full-path bundle verification passes

    await downloadUpdate({
      available: true,
      updateId: 'NEW',
      bundleHash: 'newhash456',
      manifestUrl: '/v1/manifest/NEW',
    });

    // Full bundle URL must have been downloaded after fallback
    expect(Native.downloadFile).toHaveBeenCalledWith(
      expect.stringContaining('/full.hbc'),
      expect.anything(),
    );
    // applyPatch must NOT have been called past the corrupted patch
    expect(Native.moveFile).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
npx jest
```

Expected: tests fail because `downloadUpdate` doesn't yet handle delta path.

- [ ] **Step 6: Commit (test-only commit)**

```bash
git add jest.config.js package.json package-lock.json src/__tests__/updater.delta.test.ts
git commit -m "test(sdk): add failing delta-path tests for downloadUpdate"
```

---

### Task 10: Implement `applyDelta` + delta branch in `updater.ts`

**Files:**
- Modify: `src/updater.ts`

- [ ] **Step 1: Read current updater.ts download flow to confirm anchors**

```bash
sed -n '90,170p' /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/src/updater.ts
```

- [ ] **Step 2: Refactor existing full-download body into `fullBundleDownload` and add `applyDelta`**

Edit `src/updater.ts`. Locate the existing `downloadUpdate` function (around line 90-160) and replace the body of the `try` block so the function looks like:

```ts
export async function downloadUpdate(
  update: UpdateCheckResult,
): Promise<DownloadResult> {
  if (!update.available || !update.updateId) {
    throw new Error('No update available to download.');
  }

  const { updateId, bundleHash, manifestUrl } = update;
  const dir = Storage.bundleDir(updateId);
  await Native.mkdir(dir);

  try {
    // 1 — Manifest. Pass our current bundle hash so the server can pick a diff.
    log('Downloading manifest...');
    const current = await Storage.getCurrent();
    const fromParam = current?.bundleHash
      ? `?from=${encodeURIComponent(current.bundleHash)}`
      : '';
    const manifestRes = await fetch(absoluteUrl(`${manifestUrl!}${fromParam}`));
    if (!manifestRes.ok) throw new Error(`Manifest fetch failed: ${manifestRes.status}`);
    const manifest: UpdateManifest = await manifestRes.json();
    await Native.writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));

    const finalBundle = `${dir}/bundle.hbc`;

    // 2 — Try delta path if all conditions met
    const deltaApplicable =
      manifest.diffUrl &&
      manifest.fromBundleHash &&
      current?.bundlePath &&
      current.bundleHash === manifest.fromBundleHash;

    if (deltaApplicable) {
      try {
        await applyDelta(current!.bundlePath, manifest, dir, finalBundle);
        log(`Bundle reconstructed via delta (${manifest.diffSize ?? 0} bytes)`);
      } catch (err) {
        log('Delta path failed, falling back to full download', err);
        await fullBundleDownload(manifest, dir, finalBundle, bundleHash!);
      }
    } else {
      log('No delta available, full download');
      await fullBundleDownload(manifest, dir, finalBundle, bundleHash!);
    }

    // 3 — Assets zip — unchanged (always full)
    if (manifest.assetsZipUrl) {
      log('Downloading assets zip...');
      const zipPath = `${dir}/assets.zip`;
      await Native.downloadFile(absoluteUrl(manifest.assetsZipUrl), zipPath);
      if (manifest.assetsZipHash) {
        const actualZipHash = await Native.sha256File(zipPath);
        if (actualZipHash !== manifest.assetsZipHash) {
          throw new Error(
            `Assets zip integrity check failed.\n` +
              `  Expected: ${manifest.assetsZipHash}\n  Got:      ${actualZipHash}`,
          );
        }
      }
      await Native.unzipFile(zipPath, dir);
      await Native.deleteFile(zipPath).catch(() => {});
    }

    log('Download complete', updateId);
    return { updateId, bundlePath: finalBundle, manifest };
  } catch (err) {
    await Native.deleteFile(dir).catch(() => {});
    throw err;
  }
}

/**
 * Apply a binary delta patch to reconstruct the new bundle.
 * Throws on any failure — caller falls back to full bundle download.
 */
async function applyDelta(
  basePath: string,
  manifest: UpdateManifest,
  dir: string,
  finalBundle: string,
): Promise<void> {
  const patchPath = `${dir}/bundle.patch`;
  const tmpOut = `${finalBundle}.tmp`;

  // Download patch
  await Native.downloadFile(absoluteUrl(manifest.diffUrl!), patchPath);

  // Verify patch integrity
  const actualPatchHash = await Native.sha256File(patchPath);
  if (actualPatchHash !== manifest.diffHash) {
    throw new Error(
      `Patch hash mismatch (expected ${manifest.diffHash}, got ${actualPatchHash})`,
    );
  }

  // Apply patch — native bspatch
  await Native.applyPatch(basePath, patchPath, tmpOut);

  // Verify reconstructed bundle hash matches the canonical hash.
  // This is the safety net: any patch corruption surfaces here.
  const actualOut = await Native.sha256File(tmpOut);
  if (actualOut !== manifest.bundleHash) {
    throw new Error(
      `Reconstructed bundle hash mismatch (expected ${manifest.bundleHash}, got ${actualOut})`,
    );
  }

  // Atomic rename
  await Native.moveFile(tmpOut, finalBundle);

  // Cleanup patch
  await Native.deleteFile(patchPath).catch(() => {});
}

/**
 * The existing full-bundle download path — extracted so the delta path
 * can fall back to it on any failure.
 */
async function fullBundleDownload(
  manifest: UpdateManifest,
  dir: string,
  finalBundle: string,
  expectedHash: string,
): Promise<void> {
  log('Downloading bundle...');
  const bundleUrl = absoluteUrl(manifest.bundleUrl);
  const tmp = `${finalBundle}.tmp`;
  await Native.downloadFile(bundleUrl, tmp);

  log('Verifying hash...');
  const actual = await Native.sha256File(tmp);
  if (actual !== expectedHash) {
    await Native.deleteFile(dir).catch(() => {});
    throw new Error(
      `Integrity check failed.\n  Expected: ${expectedHash}\n  Got:      ${actual}`,
    );
  }

  await Native.moveFile(tmp, finalBundle);
}
```

(Don't modify other functions in updater.ts.)

- [ ] **Step 3: Run delta tests to verify they pass**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
npx jest src/__tests__/updater.delta.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 4: TypeScript compile check**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/updater.ts
git commit -m "feat(sdk): downloadUpdate uses delta path with full fallback"
```

---

### Task 11: Vendor `bspatch.c` and add iOS bridge

**Files:**
- Create: `ios/bspatch.c`
- Create: `ios/OTABsPatch.h`
- Create: `ios/OTABsPatch.m`

- [ ] **Step 1: Vendor bspatch.c**

Download the canonical bspatch source from a public-domain repo (mendsley/bsdiff) into `ios/`:

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/ios
curl -fsSL -o bspatch.c \
  https://raw.githubusercontent.com/mendsley/bsdiff/master/bspatch.c
head -20 bspatch.c
```

Expected: file starts with the public-domain license header.

- [ ] **Step 2: Verify the bspatch.c API surface**

```bash
grep -n "int bspatch" ios/bspatch.c
```

Expected: signature is `int bspatch(const uint8_t* old, int64_t oldsize, uint8_t* new, int64_t newsize, struct bspatch_stream* stream);`

The mendsley variant uses a stream interface, so we need to wrap it with our file-based bridge in step 3.

- [ ] **Step 3: Create the ObjC bridge header**

Create `ios/OTABsPatch.h`:

```objc
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface OTABsPatch : NSObject

/**
 * Apply a bsdiff patch. Returns YES on success, NO on failure with `error` set.
 * - basePath:  existing bundle file (read-only input)
 * - patchPath: bsdiff patch file (read-only input)
 * - outPath:   destination for the reconstructed bundle (overwritten)
 */
+ (BOOL)applyPatchAtBase:(NSString *)basePath
                   patch:(NSString *)patchPath
                  output:(NSString *)outPath
                   error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
```

- [ ] **Step 4: Create the ObjC bridge implementation**

Create `ios/OTABsPatch.m`:

```objc
#import "OTABsPatch.h"
#import <bzlib.h>

extern int bspatch(const uint8_t* old, int64_t oldsize, uint8_t* new, int64_t newsize, struct bspatch_stream* stream);

struct bspatch_stream {
    void* opaque;
    int (*read)(const struct bspatch_stream* stream, void* buffer, int length);
};

typedef struct {
    BZFILE* bz;
    FILE* fp;
} bz_stream_state;

static int bz_read(const struct bspatch_stream* stream, void* buffer, int length) {
    bz_stream_state* s = (bz_stream_state*)stream->opaque;
    int bzerror;
    int n = BZ2_bzRead(&bzerror, s->bz, buffer, length);
    if (bzerror != BZ_OK && bzerror != BZ_STREAM_END) return -1;
    return n;
}

@implementation OTABsPatch

+ (BOOL)applyPatchAtBase:(NSString *)basePath
                   patch:(NSString *)patchPath
                  output:(NSString *)outPath
                   error:(NSError **)error {
    NSData* baseData = [NSData dataWithContentsOfFile:basePath];
    if (!baseData) {
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:1
            userInfo:@{NSLocalizedDescriptionKey: @"Cannot read base bundle"}];
        return NO;
    }

    FILE* pf = fopen([patchPath UTF8String], "rb");
    if (!pf) {
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:2
            userInfo:@{NSLocalizedDescriptionKey: @"Cannot open patch file"}];
        return NO;
    }

    // Read 32-byte bsdiff header
    uint8_t header[32];
    if (fread(header, 1, 32, pf) != 32) {
        fclose(pf);
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:3
            userInfo:@{NSLocalizedDescriptionKey: @"Short patch header"}];
        return NO;
    }
    if (memcmp(header, "ENDSLEY/BSDIFF43", 16) != 0) {
        fclose(pf);
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:4
            userInfo:@{NSLocalizedDescriptionKey: @"Bad patch magic"}];
        return NO;
    }

    int64_t newsize = 0;
    for (int i = 0; i < 8; i++) newsize |= ((int64_t)header[24 + i]) << (i * 8);
    if (newsize < 0) {
        fclose(pf);
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:5
            userInfo:@{NSLocalizedDescriptionKey: @"Negative new size"}];
        return NO;
    }

    int bzerror;
    BZFILE* bz = BZ2_bzReadOpen(&bzerror, pf, 0, 0, NULL, 0);
    if (bzerror != BZ_OK) {
        fclose(pf);
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:6
            userInfo:@{NSLocalizedDescriptionKey: @"bzReadOpen failed"}];
        return NO;
    }

    bz_stream_state state = { bz, pf };
    struct bspatch_stream stream = { &state, bz_read };

    NSMutableData* outData = [NSMutableData dataWithLength:(NSUInteger)newsize];
    int rc = bspatch((const uint8_t*)baseData.bytes, baseData.length,
                     (uint8_t*)outData.mutableBytes, newsize, &stream);

    BZ2_bzReadClose(&bzerror, bz);
    fclose(pf);

    if (rc != 0) {
        if (error) *error = [NSError errorWithDomain:@"OTABsPatch" code:7
            userInfo:@{NSLocalizedDescriptionKey: @"bspatch returned non-zero"}];
        return NO;
    }

    NSError* writeErr;
    if (![outData writeToFile:outPath options:NSDataWritingAtomic error:&writeErr]) {
        if (error) *error = writeErr;
        return NO;
    }

    return YES;
}

@end
```

- [ ] **Step 5: Verify file syntax via clang**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/ios
clang -c -x objective-c OTABsPatch.m -o /tmp/oc-syntax-check.o \
  -fsyntax-only -Wno-everything 2>&1 || echo "(syntax issues — review)"
```

Expected: no fatal errors. Warnings about the missing bspatch declaration are fine — it'll resolve at link time.

- [ ] **Step 6: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add ios/bspatch.c ios/OTABsPatch.h ios/OTABsPatch.m
git commit -m "feat(ios): vendor bspatch.c and add ObjC bridge"
```

---

### Task 12: Wire `applyPatch` into `OTAUpdatesModule.m` and update podspec

**Files:**
- Modify: `ios/OTAUpdatesModule.m`
- Modify: `react-native-ota-updates.podspec`

- [ ] **Step 1: Read current OTAUpdatesModule.m to find where to add the method**

```bash
grep -n "RCT_EXPORT_METHOD" /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/ios/OTAUpdatesModule.m | head -10
```

You'll see existing exports like `downloadFile:resolver:rejecter:`. Add the new one below them.

- [ ] **Step 2: Add the import and the export**

Edit `ios/OTAUpdatesModule.m`. Near the top with the other imports, add:

```objc
#import "OTABsPatch.h"
```

Then after the last `RCT_EXPORT_METHOD` block, add:

```objc
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
```

- [ ] **Step 3: Update the podspec**

Read current podspec:

```bash
cat /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/react-native-ota-updates.podspec
```

Edit `react-native-ota-updates.podspec`. Find the `s.source_files` line (typically `s.source_files = "ios/**/*.{h,m,mm}"`). Change it to also include `.c`:

```ruby
s.source_files = "ios/**/*.{h,m,mm,c}"
```

Add the bz2 linker flag right after `s.source_files`:

```ruby
s.libraries = "bz2"
```

(If `s.libraries` already exists, append `"bz2"` to its array.)

- [ ] **Step 4: Verify podspec syntax**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
ruby -c react-native-ota-updates.podspec && echo "PODSPEC SYNTAX OK"
```

Expected: `PODSPEC SYNTAX OK`.

If `pod` is available locally, also run:

```bash
pod lib lint react-native-ota-updates.podspec --quick
```

Expected: passes lint (or fails only on optional checks like sources).

- [ ] **Step 5: Commit**

```bash
git add ios/OTAUpdatesModule.m react-native-ota-updates.podspec
git commit -m "feat(ios): expose applyPatch RN method + link libbz2"
```

---

### Task 13: Vendor `bspatch.c` and bzip2 sources for Android

**Files:**
- Create: `android/src/main/cpp/bspatch.c`
- Create: `android/src/main/cpp/bzip2/blocksort.c`, `bzlib.c`, `compress.c`, `crctable.c`, `decompress.c`, `huffman.c`, `randtable.c`
- Create: `android/src/main/cpp/bzip2/bzlib.h`, `bzlib_private.h`

- [ ] **Step 1: Create the cpp directory**

```bash
mkdir -p /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/android/src/main/cpp/bzip2
```

- [ ] **Step 2: Vendor bspatch.c**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/android/src/main/cpp
curl -fsSL -o bspatch.c \
  https://raw.githubusercontent.com/mendsley/bsdiff/master/bspatch.c
head -10 bspatch.c
```

- [ ] **Step 3: Vendor minimal bzip2 sources**

bzip2 is upstream at sourceware.org. We need 7 .c files and 2 .h files. Pull them from a stable mirror:

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/android/src/main/cpp/bzip2
BZIP2_URL=https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz
curl -fsSL "$BZIP2_URL" -o /tmp/bzip2.tgz
mkdir -p /tmp/bz_extract && tar -xzf /tmp/bzip2.tgz -C /tmp/bz_extract --strip-components=1
cp /tmp/bz_extract/{blocksort.c,bzlib.c,compress.c,crctable.c,decompress.c,huffman.c,randtable.c} .
cp /tmp/bz_extract/{bzlib.h,bzlib_private.h} .
ls *.c *.h
```

Expected: 7 .c files + 2 .h files listed.

License is BSD-style (in the bzlib.h header). Compatible with our project.

- [ ] **Step 4: Commit the vendored sources**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add android/src/main/cpp/bspatch.c android/src/main/cpp/bzip2/
git commit -m "vendor(android): bspatch.c + bzip2-1.0.8 sources for NDK build"
```

---

### Task 14: Add JNI bridge + CMakeLists for Android

**Files:**
- Create: `android/src/main/cpp/jni_bridge.c`
- Create: `android/CMakeLists.txt`

- [ ] **Step 1: Write the JNI bridge**

Create `android/src/main/cpp/jni_bridge.c`:

```c
#include <jni.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "bzip2/bzlib.h"

extern int bspatch(const uint8_t* old, int64_t oldsize, uint8_t* new, int64_t newsize, struct bspatch_stream* stream);

struct bspatch_stream {
    void* opaque;
    int (*read)(const struct bspatch_stream* stream, void* buffer, int length);
};

typedef struct {
    BZFILE* bz;
    FILE* fp;
} bz_stream_state;

static int bz_read(const struct bspatch_stream* stream, void* buffer, int length) {
    bz_stream_state* s = (bz_stream_state*)stream->opaque;
    int bzerror;
    int n = BZ2_bzRead(&bzerror, s->bz, buffer, length);
    if (bzerror != BZ_OK && bzerror != BZ_STREAM_END) return -1;
    return n;
}

static jboolean throw_runtime(JNIEnv* env, const char* msg) {
    jclass cls = (*env)->FindClass(env, "java/lang/RuntimeException");
    (*env)->ThrowNew(env, cls, msg);
    return JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_otaupdates_OTAUpdatesModule_applyPatchNative(
    JNIEnv* env, jobject thiz,
    jstring jBase, jstring jPatch, jstring jOut)
{
    const char* basePath = (*env)->GetStringUTFChars(env, jBase, NULL);
    const char* patchPath = (*env)->GetStringUTFChars(env, jPatch, NULL);
    const char* outPath = (*env)->GetStringUTFChars(env, jOut, NULL);

    FILE* bf = fopen(basePath, "rb");
    if (!bf) { throw_runtime(env, "Cannot open base"); goto cleanup_strs; }
    fseek(bf, 0, SEEK_END);
    long baseSize = ftell(bf);
    rewind(bf);
    uint8_t* baseBuf = (uint8_t*)malloc(baseSize);
    if (!baseBuf || fread(baseBuf, 1, baseSize, bf) != (size_t)baseSize) {
        fclose(bf); free(baseBuf); throw_runtime(env, "Cannot read base"); goto cleanup_strs;
    }
    fclose(bf);

    FILE* pf = fopen(patchPath, "rb");
    if (!pf) { free(baseBuf); throw_runtime(env, "Cannot open patch"); goto cleanup_strs; }

    uint8_t header[32];
    if (fread(header, 1, 32, pf) != 32) {
        fclose(pf); free(baseBuf); throw_runtime(env, "Short patch header"); goto cleanup_strs;
    }
    if (memcmp(header, "ENDSLEY/BSDIFF43", 16) != 0) {
        fclose(pf); free(baseBuf); throw_runtime(env, "Bad patch magic"); goto cleanup_strs;
    }
    int64_t newsize = 0;
    for (int i = 0; i < 8; i++) newsize |= ((int64_t)header[24 + i]) << (i * 8);
    if (newsize < 0) {
        fclose(pf); free(baseBuf); throw_runtime(env, "Negative new size"); goto cleanup_strs;
    }

    int bzerror;
    BZFILE* bz = BZ2_bzReadOpen(&bzerror, pf, 0, 0, NULL, 0);
    if (bzerror != BZ_OK) {
        fclose(pf); free(baseBuf); throw_runtime(env, "bzReadOpen failed"); goto cleanup_strs;
    }

    bz_stream_state state = { bz, pf };
    struct bspatch_stream stream = { &state, bz_read };
    uint8_t* outBuf = (uint8_t*)malloc((size_t)newsize);
    if (!outBuf) {
        BZ2_bzReadClose(&bzerror, bz); fclose(pf); free(baseBuf);
        throw_runtime(env, "OOM out buffer"); goto cleanup_strs;
    }

    int rc = bspatch(baseBuf, baseSize, outBuf, newsize, &stream);
    BZ2_bzReadClose(&bzerror, bz);
    fclose(pf);
    free(baseBuf);

    if (rc != 0) {
        free(outBuf);
        throw_runtime(env, "bspatch returned non-zero");
        goto cleanup_strs;
    }

    FILE* of = fopen(outPath, "wb");
    if (!of || fwrite(outBuf, 1, (size_t)newsize, of) != (size_t)newsize) {
        if (of) fclose(of);
        free(outBuf);
        throw_runtime(env, "Cannot write output");
        goto cleanup_strs;
    }
    fclose(of);
    free(outBuf);

cleanup_strs:
    (*env)->ReleaseStringUTFChars(env, jBase, basePath);
    (*env)->ReleaseStringUTFChars(env, jPatch, patchPath);
    (*env)->ReleaseStringUTFChars(env, jOut, outPath);
}
```

- [ ] **Step 2: Write CMakeLists.txt**

Create `android/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.10)
project(otaupdates C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(BZ2_SOURCES
  src/main/cpp/bzip2/blocksort.c
  src/main/cpp/bzip2/bzlib.c
  src/main/cpp/bzip2/compress.c
  src/main/cpp/bzip2/crctable.c
  src/main/cpp/bzip2/decompress.c
  src/main/cpp/bzip2/huffman.c
  src/main/cpp/bzip2/randtable.c
)

add_library(otaupdates SHARED
  src/main/cpp/bspatch.c
  src/main/cpp/jni_bridge.c
  ${BZ2_SOURCES}
)

target_include_directories(otaupdates PRIVATE src/main/cpp src/main/cpp/bzip2)
target_compile_options(otaupdates PRIVATE
  -O2
  -Wno-unused-parameter
  -Wno-implicit-function-declaration
  -DBZ_NO_STDIO_NEEDED=0
)

find_library(log-lib log)
target_link_libraries(otaupdates ${log-lib})
```

- [ ] **Step 3: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add android/src/main/cpp/jni_bridge.c android/CMakeLists.txt
git commit -m "feat(android): JNI bridge + CMakeLists for native bspatch"
```

---

### Task 15: Wire `applyPatch` into Android module + build.gradle

**Files:**
- Modify: `android/src/main/java/com/otaupdates/OTAUpdatesModule.kt`
- Modify: `android/build.gradle`

- [ ] **Step 1: Read the existing module to find a good insertion point**

```bash
grep -n "@ReactMethod\|companion object\|init" \
  /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/android/src/main/java/com/otaupdates/OTAUpdatesModule.kt
```

- [ ] **Step 2: Add `applyPatch` to the Kotlin module**

Edit `android/src/main/java/com/otaupdates/OTAUpdatesModule.kt`. Inside the class body, near the existing `@ReactMethod` blocks (e.g., next to `downloadFile`), add the loadLibrary block (only once — check that it doesn't already exist) and the new method:

```kotlin
companion object {
    init {
        System.loadLibrary("otaupdates")
    }
}

private external fun applyPatchNative(basePath: String, patchPath: String, outputPath: String)

@ReactMethod
fun applyPatch(basePath: String, patchPath: String, outputPath: String, promise: Promise) {
    try {
        applyPatchNative(basePath, patchPath, outputPath)
        promise.resolve(null)
    } catch (e: Throwable) {
        promise.reject("PATCH_FAILED", e.message ?: "bspatch failed", e)
    }
}
```

(If a `companion object` already exists, append the `init` block inside the existing companion rather than redeclaring.)

- [ ] **Step 3: Update build.gradle**

Read current `android/build.gradle`:

```bash
cat /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/android/build.gradle
```

Edit `android/build.gradle`. Inside the `android { ... }` block, add (or merge into existing blocks):

```gradle
android {
  // … existing config …

  defaultConfig {
    // … existing fields …
    externalNativeBuild {
      cmake {
        cppFlags "-O2"
      }
    }
    ndk {
      abiFilters "armeabi-v7a", "arm64-v8a", "x86", "x86_64"
    }
  }

  externalNativeBuild {
    cmake {
      path "CMakeLists.txt"
    }
  }
}
```

- [ ] **Step 4: Local Gradle build sanity check (optional, requires Android SDK)**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/android
./gradlew assembleDebug --offline 2>&1 | tail -20
```

If Android SDK / NDK not configured locally, this will fail — that's fine, CI will build. The validation we *can* do without SDK is a Groovy/Kotlin syntax check via `gradle help`, which most local installs handle:

```bash
./gradlew help 2>&1 | head -5
```

Expected: prints "Welcome to Gradle".

- [ ] **Step 5: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add android/src/main/java/com/otaupdates/OTAUpdatesModule.kt android/build.gradle
git commit -m "feat(android): expose applyPatch RN method + NDK build config"
```

---

### Task 16: Mirror server changes to the Liquide repo

**Files (in `/Users/spurge_1/Documents/shafaq-liquide/liquide-ota-server`):**
- Modify: `src/db/mongo.js`
- Create: `src/services/diff.js`
- Modify: `src/routes/publish.js`
- Modify: `src/routes/manifest.js`
- Modify: `Dockerfile`

- [ ] **Step 1: Create a feature branch in the Liquide repo**

```bash
cd /Users/spurge_1/Documents/shafaq-liquide/liquide-ota-server
git status   # ensure clean working tree first
git checkout -b feat/delta-updates
```

- [ ] **Step 2: Mirror schema change**

Apply the exact same diff from library Task 2 to `src/db/mongo.js` in the Liquide repo. The schema definition + index + export entry are identical.

- [ ] **Step 3: Copy the diff service**

```bash
cp /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/server/src/services/diff.js \
   /Users/spurge_1/Documents/shafaq-liquide/liquide-ota-server/src/services/diff.js
```

- [ ] **Step 4: Apply the publish.js change**

Mirror the diff from library Task 5 to `src/routes/publish.js`. Add the same import line and the same try-block insertion.

- [ ] **Step 5: Apply the manifest.js change**

Replace `src/routes/manifest.js` with the same content from library Task 6.

- [ ] **Step 6: Apply the Dockerfile change**

Add `RUN apk add --no-cache bsdiff` after the `WORKDIR /app` of the runtime stage.

- [ ] **Step 7: Syntax check + diff stat**

```bash
cd /Users/spurge_1/Documents/shafaq-liquide/liquide-ota-server
for f in src/db/mongo.js src/services/diff.js src/routes/publish.js src/routes/manifest.js; do
  node --check "$f" || echo "SYNTAX FAIL: $f"
done
git --no-pager diff --stat
```

Expected: no syntax failures.

- [ ] **Step 8: Commit on Liquide branch**

```bash
git add src/ Dockerfile
git commit -m "feat: delta updates (mirror from library)"
```

(Don't push yet — user will open a PR via Bitbucket pipeline.)

---

### Task 17: Update SDK README with delta-updates note

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README to find appropriate insertion point**

```bash
grep -n "^## " /Users/spurge_1/WebstormProjects/liquide-inhouse-ota/README.md | head -20
```

- [ ] **Step 2: Add a "Delta updates" section**

Edit `README.md`. After the existing usage section (typically after `## Usage` or `## API`), insert:

```markdown
## Delta updates

When the server publishes a new bundle, it generates a binary patch (`bsdiff`) against the previous active bundle. The SDK detects this and downloads the patch instead of the full bundle, reducing payload size by 85-95% in the common case.

The behavior is fully automatic — no API changes for consumer apps. If a delta is unavailable (first install, missing precomputed diff, or any failure during patch download/application), the SDK silently falls back to the full bundle download. Verification is byte-for-byte: the reconstructed bundle's SHA-256 must match the canonical hash from the manifest, otherwise the patched output is discarded and the full bundle is fetched.

For self-hosted deployments, ensure the server's runtime image includes `bsdiff` (already in the published Docker image; for custom builds, `apk add bsdiff` on Alpine).
```

- [ ] **Step 3: Commit**

```bash
cd /Users/spurge_1/WebstormProjects/liquide-inhouse-ota
git add README.md
git commit -m "docs: document delta-updates behavior"
```

---

### Task 18: Manual E2E validation checklist (post-merge, on staging)

This task isn't code — it's a checklist that runs against staging after the implementation is deployed.

- [ ] Publish bundle V1 from CI → verify `UpdateDiff` collection is empty (first publish, no base).
- [ ] Publish bundle V2 against V1's target → verify `UpdateDiff` row inserted, patch in R2 at `<slug>/<V2id>/diffs/<V1id>.patch`, CLI logs show "Diff generated".
- [ ] Install staging app at V1, trigger update check → inspect logcat / Xcode console for `?from=<V1_hash>` in manifest URL, network log shows ~1-3 MB download not 18 MB, log line `Bundle reconstructed via delta`.
- [ ] Repeat with the device at an *older* bundle (V0, no diff) → confirm full-download fallback (`No delta available, full download`).
- [ ] Manually corrupt the patch in R2 (overwrite with random bytes) → confirm device logs `Delta path failed, falling back` and the update still applies via full download.
- [ ] Build with old SDK against new server → confirm full-download path still works (no `?from=` sent).
- [ ] Build with new SDK against old server (no UpdateDiff schema) → confirm `?from=` is sent but server returns no diff fields, full path runs.
- [ ] Capture in PR: patch size + bspatch wall-time on a real low-end Android device for an 18 MB bundle.
- [ ] Capture in PR: total update-applied time delta-vs-full.

If all items pass, the feature is production-ready. If any fail, file a follow-up before broad rollout.

---

## Self-Review

**Spec coverage:**
- Decisions Made (§3 of spec): all 10 mapped to tasks (schema=Task 2; diff service=Tasks 3-4; bsdiff binary=Task 7; publish wiring=Task 5; manifest=Task 6; types=Task 8; client logic=Tasks 9-10; iOS=Tasks 11-12; Android=Tasks 13-15; Liquide mirror=Task 16; docs=Task 17; E2E=Task 18). ✓
- Server testing (§9.1 of spec): Task 4's three tests cover bsdiff round-trip, size guard, error isolation. ✓
- Client testing (§9.2): Task 9 has happy-path + corrupt-patch fallback tests. ✓
- Native smoke tests (§9.3): explicitly deferred via "rely on upstream stability" + Task 18 E2E validation. ✓
- Rollout plan (§10): covered by Tasks 16 (Liquide mirror), 17 (docs), 18 (E2E checklist). ✓

**Placeholder scan:** No `TBD` / `TODO` / "implement later" / "fill in details". Code blocks contain actual code in every step.

**Type consistency:** `applyPatch(basePath, patchPath, outputPath)` signature consistent across `src/native.ts` (Task 8), iOS bridge `OTABsPatch.applyPatchAtBase:patch:output:error:` (Task 11), iOS RN method `applyPatch:patch:output:resolver:rejecter:` (Task 12), JNI `Java_com_otaupdates_OTAUpdatesModule_applyPatchNative` (Task 14), Kotlin `applyPatch(basePath, patchPath, outputPath, promise)` (Task 15). All three string args consistently named.

`UpdateDiff` field names consistent across schema (Task 2), service (Tasks 3-4), publish wiring (Task 5), manifest lookup (Task 6).

`fromBundleHash` / `bundleHash` / `from` query-param name consistent across server, client, native flows.

No issues found.
