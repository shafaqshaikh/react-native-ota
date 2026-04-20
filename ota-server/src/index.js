const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { UpdateStore } = require('./store');

const app = express();
const store = new UpdateStore();

// --- Config ---
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// Ensure upload directories exist
fs.mkdirSync(path.join(UPLOADS_DIR, 'bundles'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'manifests'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'assets'), { recursive: true });

// --- Middleware ---
app.use(cors());
app.use(express.json());

// Multer config for bundle + asset uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'bundle') {
      cb(null, path.join(UPLOADS_DIR, 'bundles'));
    } else {
      cb(null, path.join(UPLOADS_DIR, 'assets'));
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = crypto.randomUUID() + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

// ============================================================
// POST /publish — Register a new update
// ============================================================
app.post(
  '/publish',
  upload.fields([
    { name: 'bundle', maxCount: 1 },
    { name: 'assets', maxCount: 100 },
  ]),
  (req, res) => {
    try {
      const { appVersion, runtimeVersion, bundleHash, rolloutPercentage } = req.body;

      if (!appVersion || !runtimeVersion || !bundleHash) {
        return res.status(400).json({
          error: 'Missing required fields: appVersion, runtimeVersion, bundleHash',
        });
      }

      if (!req.files || !req.files.bundle || req.files.bundle.length === 0) {
        return res.status(400).json({ error: 'Bundle file is required' });
      }

      const bundleFile = req.files.bundle[0];
      const assetFiles = req.files.assets || [];

      // Verify bundle hash matches uploaded file
      const fileBuffer = fs.readFileSync(bundleFile.path);
      const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      if (actualHash !== bundleHash) {
        // Clean up uploaded file
        fs.unlinkSync(bundleFile.path);
        return res.status(400).json({
          error: 'Bundle hash mismatch',
          expected: bundleHash,
          actual: actualHash,
        });
      }

      // Parse asset hashes from request
      let assetManifest = [];
      try {
        assetManifest = req.body.assetManifest ? JSON.parse(req.body.assetManifest) : [];
      } catch (e) {
        // No asset manifest provided
      }

      const updateId = crypto.randomUUID();

      // Build manifest
      const manifest = {
        id: updateId,
        appVersion,
        runtimeVersion,
        bundleHash,
        bundleUrl: `/bundle/${updateId}`,
        assets: assetFiles.map((file, i) => ({
          name: assetManifest[i]?.name || file.originalname,
          hash: assetManifest[i]?.hash || '',
          url: `/assets/${file.filename}`,
        })),
        createdAt: Date.now(),
      };

      // Save manifest to disk
      const manifestPath = path.join(UPLOADS_DIR, 'manifests', `${updateId}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Save to store
      store.save({
        id: updateId,
        appVersion,
        runtimeVersion,
        bundleHash,
        rolloutPercentage: parseInt(rolloutPercentage) || 100,
        createdAt: Date.now(),
        manifestPath,
        bundlePath: bundleFile.path,
        assets: manifest.assets,
      });

      console.log(`[OTA] Published update ${updateId} for ${appVersion}/${runtimeVersion}`);

      res.json({
        success: true,
        updateId,
        manifest,
      });
    } catch (err) {
      console.error('[OTA] Publish error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================================
// GET /check — Check for available update
// Query params: appVersion, runtimeVersion, currentUpdateId, clientId
// ============================================================
app.get('/check', (req, res) => {
  const { appVersion, runtimeVersion, currentUpdateId, clientId } = req.query;

  if (!appVersion || !runtimeVersion) {
    return res.status(400).json({
      error: 'Missing required params: appVersion, runtimeVersion',
    });
  }

  const latest = store.findLatest(appVersion, runtimeVersion, clientId || '');

  if (!latest || latest.id === currentUpdateId) {
    return res.json({ available: false });
  }

  res.json({
    available: true,
    updateId: latest.id,
    bundleHash: latest.bundleHash,
    createdAt: latest.createdAt,
    manifestUrl: `/manifest/${latest.id}`,
  });
});

// ============================================================
// GET /manifest/:id — Return manifest JSON
// ============================================================
app.get('/manifest/:id', (req, res) => {
  const update = store.getById(req.params.id);
  if (!update) {
    return res.status(404).json({ error: 'Update not found' });
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(update.manifestPath, 'utf-8'));
    res.json(manifest);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read manifest' });
  }
});

// ============================================================
// GET /bundle/:id — Download the JS bundle
// ============================================================
app.get('/bundle/:id', (req, res) => {
  const update = store.getById(req.params.id);
  if (!update) {
    return res.status(404).json({ error: 'Update not found' });
  }

  if (!fs.existsSync(update.bundlePath)) {
    return res.status(404).json({ error: 'Bundle file not found' });
  }

  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.resolve(update.bundlePath));
});

// ============================================================
// GET /assets/:filename — Serve asset files
// ============================================================
app.use('/assets', express.static(path.join(UPLOADS_DIR, 'assets')));

// ============================================================
// GET /updates — List all updates (admin/debug)
// ============================================================
app.get('/updates', (req, res) => {
  const updates = store.getAll().map((u) => ({
    id: u.id,
    appVersion: u.appVersion,
    runtimeVersion: u.runtimeVersion,
    rolloutPercentage: u.rolloutPercentage,
    createdAt: u.createdAt,
  }));
  res.json({ updates });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`[OTA Server] Running on http://localhost:${PORT}`);
});

module.exports = app;