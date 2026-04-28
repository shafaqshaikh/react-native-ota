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
