const express = require('express');
const mongoose = require('mongoose');
const { Update } = require('../db/mongo');
const s3 = require('../storage/s3');

const router = express.Router();

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid update id' });
    }
    const update = await Update.findById(id).lean();
    if (!update || update.status === 'deleted') {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json({
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
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
