const cluster = require('cluster');
const { availableParallelism } = require('os');

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const mongoose = require('mongoose');

const config = require('./config');
const checkRoutes = require('./routes/check');
const manifestRoutes = require('./routes/manifest');
const publishRoutes = require('./routes/publish');
const adminRoutes = require('./routes/admin');

const USE_CLUSTER =
  process.env.CLUSTER === '1' ||
  (process.env.NODE_ENV === 'production' && process.env.CLUSTER !== '0');

if (USE_CLUSTER && cluster.isPrimary) {
  runPrimary();
} else {
  runWorker();
}

function runPrimary() {
  const numWorkers = Number(process.env.CLUSTER_WORKERS) || availableParallelism();
  console.log(`[OTA] Primary ${process.pid} forking ${numWorkers} worker(s)`);

  for (let i = 0; i < numWorkers; i++) cluster.fork();

  let shuttingDown = false;

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;
    console.error(
      `[OTA] Worker ${worker.process.pid} exited (code=${code}, signal=${signal}); respawning`,
    );
    cluster.fork();
  });

  const forward = (sig) => {
    shuttingDown = true;
    console.log(`[OTA] Primary received ${sig}, forwarding to workers`);
    for (const id of Object.keys(cluster.workers)) {
      cluster.workers[id].kill(sig);
    }
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));
}

function runWorker() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(cors());
  // Skip gzip on small payloads — /v1/check responses are ~20 bytes and
  // compressing them costs more CPU than it saves bandwidth.
  app.use(compression({ level: 6, threshold: 1024 }));
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
      pid: process.pid,
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

  (async () => {
    config.validate();
    try {
      await mongoose.connect(config.mongoUrl);
      console.log(
        `[OTA] Worker ${process.pid} Mongo connected: ${config.mongoUrl.replace(/\/\/[^@]+@/, '//***@')}`,
      );
    } catch (err) {
      console.error('[OTA] Mongo connection failed:', err.message);
      process.exit(1);
    }

    const server = app.listen(config.port, () => {
      console.log(`[OTA] Worker ${process.pid} listening on :${config.port}`);
    });

    // Graceful shutdown — stop accepting, drain in-flight, close Mongo, exit.
    // 10s hard timeout protects against stuck requests.
    let shuttingDown = false;
    const shutdown = async (sig) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[OTA] Worker ${process.pid} received ${sig}, draining`);
      const killTimer = setTimeout(() => {
        console.error(`[OTA] Worker ${process.pid} drain timed out, forcing exit`);
        process.exit(1);
      }, 10000);
      killTimer.unref();
      server.close(async () => {
        try {
          await mongoose.disconnect();
        } catch (err) {
          console.error(`[OTA] Worker ${process.pid} mongoose.disconnect error:`, err.message);
        }
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })();

  module.exports = app;
}
