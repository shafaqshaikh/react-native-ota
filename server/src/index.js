const express = require('express');
const multer = require('multer');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

// Storage paths
const UPLOADS = process.env.OTA_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(path.join(UPLOADS, 'bundles'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS, 'manifests'), { recursive: true });

app.use(cors());
app.use(express.json());

// Multer
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, path.join(UPLOADS, 'bundles')),
  filename: (_, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ── POST /publish ─────────────────────────────────────────────────
app.post('/publish', upload.single('bundle'), (req, res) => {
  try {
    const { appVersion, runtimeVersion, bundleHash, rolloutPercentage, platform } = req.body;

    if (!appVersion || !runtimeVersion || !bundleHash || !req.file) {
      return res.status(400).json({ error: 'Missing: appVersion, runtimeVersion, bundleHash, bundle file' });
    }

    // Verify hash
    const actual = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
    if (actual !== bundleHash) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Hash mismatch', expected: bundleHash, actual });
    }

    const id = crypto.randomUUID();
    const plat = platform || 'android';

    const manifest = {
      id,
      platform: plat,
      appVersion,
      runtimeVersion,
      bundleHash,
      bundleUrl: `/bundle/${id}`,
      assets: [],
      createdAt: Date.now(),
    };

    // Save manifest file
    const manifestPath = path.join(UPLOADS, 'manifests', `${id}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    db.save({
      id,
      platform: plat,
      appVersion,
      runtimeVersion,
      bundleHash,
      bundlePath: req.file.path,
      rolloutPct: parseInt(rolloutPercentage) || 100,
      createdAt: Date.now(),
    });

    console.log(`[OTA] Published ${id} (${plat}) v${appVersion}`);
    res.json({ success: true, updateId: id, manifest });
  } catch (err) {
    console.error('[OTA] Publish error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /check ────────────────────────��───────────────────────────
app.get('/check', (req, res) => {
  const { appVersion, runtimeVersion, currentUpdateId, clientId, platform } = req.query;

  if (!appVersion || !runtimeVersion) {
    return res.status(400).json({ error: 'Missing: appVersion, runtimeVersion' });
  }

  const latest = db.findLatestFor(
    platform || 'android',
    appVersion,
    runtimeVersion,
    clientId || '',
  );

  if (!latest || latest.id === currentUpdateId) {
    return res.json({ available: false });
  }

  res.json({
    available: true,
    updateId: latest.id,
    bundleHash: latest.bundle_hash,
    platform: latest.platform,
    createdAt: latest.created_at,
    manifestUrl: `/manifest/${latest.id}`,
  });
});

// ── GET /manifest/:id ───────────────��─────────────────────────────
app.get('/manifest/:id', (req, res) => {
  const manifestPath = path.join(UPLOADS, 'manifests', `${req.params.id}.json`);
  if (!fs.existsSync(manifestPath)) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
});

// ── GET /bundle/:id ─────────────────────────────���─────────────────
app.get('/bundle/:id', (req, res) => {
  const update = db.getById(req.params.id);
  if (!update || !fs.existsSync(update.bundle_path)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(path.resolve(update.bundle_path));
});

// ── GET /updates ───────��──────────────────────────────────────────
app.get('/updates', (_, res) => {
  res.json({ updates: db.listAll() });
});

// ── Health ────────────���───────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`[OTA Server] http://localhost:${PORT}`));

module.exports = app;
