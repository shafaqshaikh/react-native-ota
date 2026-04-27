const mongoose = require('mongoose');

// ── Project ───────────────────────────────────────────────────────
const projectSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// ── API key ───────────────────────────────────────────────────────
const apiKeySchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  keyHash: { type: String, required: true, index: true, unique: true },
  name: { type: String, default: 'default' },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date },
});

// ── Update (one published OTA) ────────────────────────────────────
const rolloutStepSchema = new mongoose.Schema({
  atMinutes: { type: Number, required: true }, // minutes since rolloutStartedAt
  pct: { type: Number, required: true, min: 0, max: 100 },
}, { _id: false });

const updateSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  platform: { type: String, enum: ['ios', 'android'], required: true },
  appVersion: { type: String, required: true },
  runtimeVersion: { type: String, required: true },
  channel: { type: String, default: 'production' },
  label: { type: String },

  bundleKey: { type: String, required: true },
  bundleHash: { type: String, required: true },
  bundleSize: { type: Number, required: true },

  assetsZipKey: { type: String },
  assetsZipHash: { type: String },
  assetsZipSize: { type: Number },

  rolloutPct: { type: Number, default: 100, min: 0, max: 100 },
  rolloutStartedAt: { type: Date, default: Date.now },
  rolloutSchedule: { type: [rolloutStepSchema], default: undefined },

  status: { type: String, enum: ['active', 'rolledback', 'deleted'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});

updateSchema.index({
  projectId: 1,
  platform: 1,
  appVersion: 1,
  runtimeVersion: 1,
  channel: 1,
  status: 1,
  createdAt: -1,
});

// ── Audit log ─────────────────────────────────────────────────────
const auditLogSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },
  type: { type: String, required: true }, // publish, rollback, delete, key_created, project_created
  actor: { type: String, default: 'system' },
  payload: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
});

module.exports = {
  Project: mongoose.model('Project', projectSchema),
  ApiKey: mongoose.model('ApiKey', apiKeySchema),
  Update: mongoose.model('Update', updateSchema),
  AuditLog: mongoose.model('AuditLog', auditLogSchema),
};
