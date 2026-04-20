const express = require('express');
const { Project, Update } = require('../db/mongo');
const rollout = require('../services/rollout');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const {
      projectId: projectSlug,
      appVersion,
      runtimeVersion,
      platform,
      channel,
      currentUpdateId,
      clientId,
    } = req.query;

    if (!projectSlug || !appVersion || !runtimeVersion || !platform) {
      return res.status(400).json({
        error: 'Missing required query: projectId, appVersion, runtimeVersion, platform',
      });
    }
    if (!['ios', 'android'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be ios or android' });
    }

    const project = await Project.findOne({ slug: projectSlug }).lean();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const updates = await Update.find({
      projectId: project._id,
      platform,
      appVersion,
      runtimeVersion,
      channel: channel || 'production',
      status: 'active',
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    if (updates.length === 0) {
      return res.json({ available: false });
    }

    const picked = rollout.pickForDevice(updates, clientId);
    if (!picked) return res.json({ available: false });

    const { update, effectivePct } = picked;
    const updateId = update._id.toString();

    if (updateId === currentUpdateId) {
      return res.json({ available: false });
    }

    res.json({
      available: true,
      updateId,
      bundleHash: update.bundleHash,
      platform: update.platform,
      createdAt: update.createdAt.getTime(),
      effectiveRolloutPct: effectivePct,
      manifestUrl: `/v1/manifest/${updateId}`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
