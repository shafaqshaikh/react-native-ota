const express = require('express');
const mongoose = require('mongoose');
const { Update } = require('../db/mongo');
const s3 = require('../storage/s3');

const router = express.Router();

// Per-worker cache of manifest responses. Responses are immutable per
// updateId once published (rollback sets status=deleted, which 60s TTL
// bounds exposure for). Combined with the Cache-Control header below,
// this keeps manifest origin traffic near zero during stampedes.
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

    const now = Date.now();
    const cached = manifestCache.get(id);
    if (cached && cached.expiresAt > now) {
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
      return res.json(cached.body);
    }

    const update = await Update.findById(id).lean();
    if (!update || update.status === 'deleted') {
      return res.status(404).json({ error: 'Not found' });
    }

    const body = buildPayload(update);
    if (manifestCache.size >= MANIFEST_CACHE_MAX_ENTRIES) manifestCache.clear();
    manifestCache.set(id, { body, expiresAt: now + MANIFEST_CACHE_TTL_MS });
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json(body);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
