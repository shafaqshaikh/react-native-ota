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

// ── UpdateDiff (binary patch from one bundle to another) ──────────
const updateDiffSchema = new mongoose.Schema({
  toUpdateId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Update', required: true },
  fromUpdateId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Update', required: true },
  fromBundleHash: { type: String, required: true },
  patchKey:       { type: String, required: true },
  patchHash:      { type: String, required: true },
  patchSize:      { type: Number, required: true },
  createdAt:      { type: Date, default: Date.now },
});

updateDiffSchema.index(
  { toUpdateId: 1, fromBundleHash: 1 },
  { unique: true },
);

// ── User (CLI-login email/password account) ───────────────────────
const userSchema = new mongoose.Schema({
  email:        { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  name:         { type: String, default: '' },
  createdAt:    { type: Date, default: Date.now },
});
userSchema.index({ email: 1 }, { unique: true });

// ── Session (per-CLI-login bearer token) ──────────────────────────
const sessionSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tokenHash:  { type: String, required: true },
  expiresAt:  { type: Date, required: true },
  createdAt:  { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: Date.now },
  userAgent:  { type: String, default: '' },
});
sessionSchema.index({ tokenHash: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = {
  Project: mongoose.model('Project', projectSchema),
  ApiKey: mongoose.model('ApiKey', apiKeySchema),
  Update: mongoose.model('Update', updateSchema),
  AuditLog: mongoose.model('AuditLog', auditLogSchema),
  UpdateDiff: mongoose.model('UpdateDiff', updateDiffSchema),
  User: mongoose.model('User', userSchema),
  Session: mongoose.model('Session', sessionSchema),
};
