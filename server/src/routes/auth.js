const express = require('express');
const { User, Session, AuditLog } = require('../db/mongo');
const passwordUtil = require('../utils/password');
const sessionUtil = require('../utils/session');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password required' });
    }
    const user = await User.findOne({ email: String(email).toLowerCase().trim() }).lean();
    const ok = user && (await passwordUtil.compare(password, user.passwordHash));
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const { token, tokenHash } = sessionUtil.generateToken();
    const expiresAt = sessionUtil.defaultExpiry();
    const session = await Session.create({
      userId: user._id,
      tokenHash,
      expiresAt,
      userAgent: (req.get('User-Agent') || '').slice(0, 256),
    });

    AuditLog.create({
      type: 'login',
      actor: `user:${user.email}`,
      payload: { sessionId: session._id },
    }).catch(() => {});

    return res.json({
      token,
      expiresAt,
      user: { id: user._id, email: user.email, name: user.name || '' },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    if (!req.session) return res.status(401).json({ error: 'No session' });
    await Session.deleteOne({ _id: req.session._id });
    AuditLog.create({
      type: 'logout',
      actor: `user:${req.user.email}`,
      payload: { sessionId: req.session._id },
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No session' });
  res.json({
    id: req.user._id,
    email: req.user.email,
    name: req.user.name || '',
    createdAt: req.user.createdAt,
  });
});

module.exports = router;
