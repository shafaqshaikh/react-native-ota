const crypto = require('crypto');
const config = require('../config');
const { ApiKey, Project } = require('../db/mongo');

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateKey() {
  // Format: ota_live_<32 hex chars>
  return `ota_live_${crypto.randomBytes(16).toString('hex')}`;
}

async function requireApiKey(req, res, next) {
  try {
    const header = req.get('Authorization') || req.get('X-API-Key') || '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ error: 'Missing API key' });

    const keyHash = hashKey(token);
    const apiKey = await ApiKey.findOne({ keyHash }).lean();
    if (!apiKey) return res.status(401).json({ error: 'Invalid API key' });

    const project = await Project.findById(apiKey.projectId).lean();
    if (!project) return res.status(401).json({ error: 'Project not found' });

    req.project = project;
    req.apiKey = apiKey;

    // Fire-and-forget lastUsedAt bump
    ApiKey.updateOne({ _id: apiKey._id }, { lastUsedAt: new Date() }).catch(() => {});

    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  const auth = req.get('Authorization') || '';
  if (!auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="OTA Admin"');
    return res.status(401).send('Authentication required');
  }
  let user, pass;
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    user = decoded.slice(0, idx);
    pass = decoded.slice(idx + 1);
  } catch {
    return res.status(400).send('Invalid auth header');
  }
  // Constant-time compare
  const userOk = safeEqual(user, config.admin.user);
  const passOk = safeEqual(pass, config.admin.password);
  if (!userOk || !passOk) {
    res.set('WWW-Authenticate', 'Basic realm="OTA Admin"');
    return res.status(401).send('Unauthorized');
  }
  next();
}

function safeEqual(a, b) {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { requireApiKey, requireAdmin, hashKey, generateKey };
