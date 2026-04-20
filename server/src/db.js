const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.OTA_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'ota.db'));

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS updates (
    id            TEXT PRIMARY KEY,
    platform      TEXT NOT NULL DEFAULT 'android',
    app_version   TEXT NOT NULL,
    runtime_version TEXT NOT NULL,
    bundle_hash   TEXT NOT NULL,
    bundle_path   TEXT NOT NULL,
    rollout_pct   INTEGER NOT NULL DEFAULT 100,
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_updates_lookup
    ON updates(platform, app_version, runtime_version, created_at DESC);
`);

// Prepared statements
const insertUpdate = db.prepare(`
  INSERT INTO updates (id, platform, app_version, runtime_version, bundle_hash, bundle_path, rollout_pct, created_at)
  VALUES (@id, @platform, @appVersion, @runtimeVersion, @bundleHash, @bundlePath, @rolloutPct, @createdAt)
`);

const findLatest = db.prepare(`
  SELECT * FROM updates
  WHERE platform = @platform AND app_version = @appVersion AND runtime_version = @runtimeVersion
  ORDER BY created_at DESC
  LIMIT 10
`);

const getById = db.prepare(`SELECT * FROM updates WHERE id = ?`);

const listAll = db.prepare(`SELECT * FROM updates ORDER BY created_at DESC LIMIT 100`);

/**
 * Deterministic rollout — same clientId always gets the same bucket.
 */
function passesRollout(rolloutPct, clientId) {
  if (rolloutPct >= 100) return true;
  if (!clientId) return false;
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = ((hash << 5) - hash + clientId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100 < rolloutPct;
}

module.exports = {
  save(record) {
    insertUpdate.run(record);
  },

  findLatestFor(platform, appVersion, runtimeVersion, clientId) {
    const rows = findLatest.all({ platform, appVersion, runtimeVersion });
    for (const row of rows) {
      if (passesRollout(row.rollout_pct, clientId)) return row;
    }
    return null;
  },

  getById(id) {
    return getById.get(id) || null;
  },

  listAll() {
    return listAll.all();
  },
};
