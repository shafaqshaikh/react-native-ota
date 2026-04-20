const express = require('express');
const cors = require('cors');
const compression = require('compression');
const mongoose = require('mongoose');

const config = require('./config');
const checkRoutes = require('./routes/check');
const manifestRoutes = require('./routes/manifest');
const publishRoutes = require('./routes/publish');
const adminRoutes = require('./routes/admin');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(cors());
// gzip everything — even binary bundles compress when served from here.
app.use(compression({ level: 6, threshold: 0, filter: () => true }));
app.use(express.json());

// ── v1 API ────────────────────────────────────────────────────────
app.use('/v1/check', checkRoutes);
app.use('/v1/manifest', manifestRoutes);
app.use('/v1/publish', publishRoutes);

// ── Legacy aliases (for backwards compat with older clients) ─────
app.use('/check', checkRoutes);
app.use('/manifest', manifestRoutes);
app.use('/publish', publishRoutes);

// ── Admin dashboard ──────────────────────────────────────────────
app.use('/admin', adminRoutes);

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    ok: true,
    version: process.env.npm_package_version || '0.0.0',
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

app.get('/', (_, res) =>
  res.type('text/plain').send('react-native-ota-updates server. See /admin and /v1/*.'),
);

// ── Error handler ─────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[OTA] error:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

async function start() {
  config.validate();
  try {
    await mongoose.connect(config.mongoUrl);
    console.log(`[OTA] Mongo connected: ${config.mongoUrl.replace(/\/\/[^@]+@/, '//***@')}`);
  } catch (err) {
    console.error('[OTA] Mongo connection failed:', err.message);
    process.exit(1);
  }
  app.listen(config.port, () => {
    console.log(`[OTA] Server listening on :${config.port}`);
    console.log(`[OTA] Admin dashboard: http://localhost:${config.port}/admin`);
  });
}

start();

module.exports = app;
