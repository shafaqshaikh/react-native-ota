const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const mongoose = require('mongoose');

const config = require('../config');
const s3 = require('../storage/s3');
const { Update, AuditLog, UpdateDiff } = require('../db/mongo');
const diffService = require('../services/diff');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxBundleSizeMb * 1024 * 1024 },
});

const publishUpload = upload.fields([
  { name: 'bundle', maxCount: 1 },
  { name: 'assetsZip', maxCount: 1 },
]);

router.post('/', requireApiKey, publishUpload, async (req, res, next) => {
  try {
    const {
      appVersion,
      runtimeVersion,
      bundleHash,
      assetsZipHash,
      rolloutPercentage,
      rolloutSchedule,
      platform,
      channel,
      label,
    } = req.body;

    const bundleFile = req.files && req.files.bundle && req.files.bundle[0];
    const assetsZipFile = req.files && req.files.assetsZip && req.files.assetsZip[0];

    if (!appVersion || !runtimeVersion || !bundleHash || !bundleFile || !platform) {
      return res.status(400).json({
        error: 'Missing required: appVersion, runtimeVersion, bundleHash, platform, bundle',
      });
    }
    if (!['ios', 'android'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be ios or android' });
    }

    // Verify bundle hash
    const actualBundleHash = crypto.createHash('sha256').update(bundleFile.buffer).digest('hex');
    if (actualBundleHash !== bundleHash) {
      return res.status(400).json({
        error: 'Bundle hash mismatch',
        expected: bundleHash,
        actual: actualBundleHash,
      });
    }

    // Verify assets zip hash (if provided)
    let finalAssetsZipHash = null;
    if (assetsZipFile) {
      finalAssetsZipHash = crypto.createHash('sha256').update(assetsZipFile.buffer).digest('hex');
      if (assetsZipHash && assetsZipHash !== finalAssetsZipHash) {
        return res.status(400).json({
          error: 'assetsZip hash mismatch',
          expected: assetsZipHash,
          actual: finalAssetsZipHash,
        });
      }
    }

    // Parse optional staged rollout schedule
    let schedule;
    if (rolloutSchedule) {
      try {
        schedule = JSON.parse(rolloutSchedule);
        if (!Array.isArray(schedule)) throw new Error('rolloutSchedule must be an array');
        schedule = schedule.map((s) => ({
          atMinutes: Number(s.atMinutes),
          pct: Number(s.pct),
        }));
      } catch (err) {
        return res.status(400).json({ error: 'Invalid rolloutSchedule JSON', detail: err.message });
      }
    }

    const updateId = new mongoose.Types.ObjectId();
    const bundleKey = `${req.project.slug}/${updateId}/bundle.hbc`;
    const assetsZipKey = assetsZipFile ? `${req.project.slug}/${updateId}/assets.zip` : null;

    // Upload to S3/R2 in parallel
    const uploads = [s3.uploadBuffer(bundleKey, bundleFile.buffer, 'application/octet-stream')];
    if (assetsZipFile) {
      uploads.push(s3.uploadBuffer(assetsZipKey, assetsZipFile.buffer, 'application/zip'));
    }
    await Promise.all(uploads);

    const update = await Update.create({
      _id: updateId,
      projectId: req.project._id,
      platform,
      appVersion,
      runtimeVersion,
      channel: channel || 'production',
      label: label || undefined,
      bundleKey,
      bundleHash,
      bundleSize: bundleFile.size,
      assetsZipKey,
      assetsZipHash: finalAssetsZipHash,
      assetsZipSize: assetsZipFile ? assetsZipFile.size : undefined,
      rolloutPct: parseInt(rolloutPercentage, 10) || 100,
      rolloutStartedAt: new Date(),
      rolloutSchedule: schedule,
    });

    AuditLog.create({
      projectId: req.project._id,
      type: 'publish',
      actor: req.apiKey.name || 'api',
      payload: {
        updateId: update._id.toString(),
        platform,
        appVersion,
        runtimeVersion,
        channel: update.channel,
        bundleSize: update.bundleSize,
        assetsZipSize: update.assetsZipSize,
      },
    }).catch(() => {});

    console.log(`[OTA] Published ${update._id} (${platform} ${appVersion}) project=${req.project.slug}`);

    res.json({
      success: true,
      updateId: update._id.toString(),
      project: req.project.slug,
      bundleUrl: s3.publicUrl(bundleKey),
      assetsZipUrl: assetsZipKey ? s3.publicUrl(assetsZipKey) : null,
    });

    // Fire-and-forget: diff generation continues after the response is sent.
    // Publishing CLI sees success the moment the Update doc lands; bsdiff runs
    // in the background of this same Node process. Failures are logged.
    (async () => {
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

        if (!baseUpdate) return;

        console.log(`[OTA] Generating diff (${baseUpdate._id.toString()} -> ${update._id.toString()})...`);
        const diffDoc = await diffService.generate({
          baseUpdate,
          newUpdate: update,
          newBundleBuffer: bundleFile.buffer,
          projectSlug: req.project.slug,
        });
        if (diffDoc) {
          console.log(`[OTA] Diff generated (${diffDoc.patchSize} bytes)`);
        } else {
          console.log('[OTA] Diff skipped (patch >= 60% of bundle)');
        }
      } catch (err) {
        console.error('[OTA] Diff generation failed (non-fatal):', err);
      }
    })();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
