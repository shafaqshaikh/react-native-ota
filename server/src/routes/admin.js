const express = require('express');
const mongoose = require('mongoose');
const { Project, ApiKey, Update, AuditLog } = require('../db/mongo');
const { requireAdmin, generateKey, hashKey } = require('../middleware/auth');
const rollout = require('../services/rollout');
const s3 = require('../storage/s3');

const router = express.Router();

router.use(requireAdmin);
router.use(express.urlencoded({ extended: true }));

// ── UI helpers ────────────────────────────────────────────────────
function layout(title, body, flash = '') {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 2em auto; padding: 0 1em; color: #222; }
  h1, h2 { margin: 0.6em 0; }
  nav a { margin-right: 1em; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 1em 0; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e5e5e5; }
  th { background: #f7f7f7; }
  tr.rolledback { opacity: 0.5; }
  tr.deleted { opacity: 0.4; text-decoration: line-through; }
  form { display: inline; }
  button, input[type=submit] { cursor: pointer; padding: 4px 10px; font-size: 12px; }
  button.danger { background: #fee; color: #a00; border: 1px solid #f99; }
  code { background: #f3f3f3; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .flash { padding: 10px; background: #efe; border: 1px solid #9c9; margin: 1em 0; }
  .platform-ios { color: #06c; }
  .platform-android { color: #0a6; }
  .row { display: flex; gap: 0.5em; align-items: center; }
  .mono { font-family: ui-monospace, monospace; font-size: 11px; }
  .pill { background: #eef; padding: 1px 6px; border-radius: 10px; font-size: 11px; }
</style>
</head><body>
<nav><strong>OTA Admin</strong> &nbsp; <a href="/admin">Dashboard</a> <a href="/admin/projects">Projects</a> <a href="/admin/audit">Audit log</a></nav>
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}
<h1>${esc(title)}</h1>
${body}
</body></html>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function fmtDate(d) {
  return d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '—';
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// ── Dashboard: recent updates across all projects ─────────────────
router.get('/', async (req, res, next) => {
  try {
    const updates = await Update.find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('projectId', 'slug name')
      .lean();

    const rows = updates
      .map((u) => {
        const pct = rollout.currentRolloutPct(u);
        return `<tr class="${u.status}">
          <td class="mono">${esc(u._id)}</td>
          <td>${esc(u.projectId?.slug || '—')}</td>
          <td class="platform-${u.platform}">${esc(u.platform)}</td>
          <td>${esc(u.appVersion)}</td>
          <td>${esc(u.channel)}</td>
          <td>${esc(u.label || '')}</td>
          <td>${pct}%${u.rolloutSchedule?.length ? ' <span class="pill">staged</span>' : ''}</td>
          <td>${fmtSize(u.bundleSize)} + ${fmtSize(u.assetsZipSize)}</td>
          <td>${fmtDate(u.createdAt)}</td>
          <td>${esc(u.status)}</td>
          <td>
            ${u.status === 'active' ? `
              <form method="post" action="/admin/updates/${u._id}/rollback">
                <button class="danger" onclick="return confirm('Rollback update ${u._id}?')">Rollback</button>
              </form>
              <form method="post" action="/admin/updates/${u._id}/delete">
                <button class="danger" onclick="return confirm('Delete update ${u._id}? This removes bundle from storage.')">Delete</button>
              </form>
            ` : ''}
          </td>
        </tr>`;
      })
      .join('');

    const body = `
<p>Showing the 50 most recent updates.</p>
<table>
  <tr><th>ID</th><th>Project</th><th>Platform</th><th>App ver</th><th>Channel</th><th>Label</th><th>Rollout</th><th>Size</th><th>Created</th><th>Status</th><th></th></tr>
  ${rows || '<tr><td colspan="11">No updates published yet.</td></tr>'}
</table>`;
    res.send(layout('Dashboard', body, req.query.msg || ''));
  } catch (err) {
    next(err);
  }
});

// ── Projects: list + create ──────────────────────────────────────
router.get('/projects', async (req, res, next) => {
  try {
    const projects = await Project.find({}).sort({ createdAt: -1 }).lean();
    const rows = await Promise.all(projects.map(async (p) => {
      const keyCount = await ApiKey.countDocuments({ projectId: p._id });
      const updateCount = await Update.countDocuments({ projectId: p._id, status: 'active' });
      return `<tr>
        <td>${esc(p.slug)}</td>
        <td>${esc(p.name)}</td>
        <td>${updateCount}</td>
        <td>${keyCount}</td>
        <td>${fmtDate(p.createdAt)}</td>
        <td>
          <form method="post" action="/admin/projects/${p._id}/keys">
            <button>+ API key</button>
          </form>
        </td>
      </tr>`;
    }));

    const body = `
<h2>Create a project</h2>
<form method="post" action="/admin/projects">
  <input name="slug" placeholder="slug (e.g. liquide)" required>
  <input name="name" placeholder="Display name" required>
  <button>Create</button>
</form>
<h2>All projects</h2>
<table>
  <tr><th>Slug</th><th>Name</th><th>Updates</th><th>API keys</th><th>Created</th><th></th></tr>
  ${rows.join('')}
</table>`;
    res.send(layout('Projects', body, req.query.msg || ''));
  } catch (err) {
    next(err);
  }
});

router.post('/projects', async (req, res, next) => {
  try {
    const { slug, name } = req.body;
    if (!slug || !name) {
      return res.redirect('/admin/projects?msg=missing+slug+or+name');
    }
    const project = await Project.create({ slug: slug.toLowerCase(), name });

    // Auto-generate first API key
    const plain = generateKey();
    await ApiKey.create({
      projectId: project._id,
      keyHash: hashKey(plain),
      name: 'default',
    });

    AuditLog.create({
      projectId: project._id,
      type: 'project_created',
      actor: 'admin',
      payload: { slug, name },
    }).catch(() => {});

    const body = `
<div class="flash">
  Project created. Save this API key <strong>now</strong> — it is shown only once:
  <pre style="user-select:all">${esc(plain)}</pre>
  Devices can call /v1/check with <code>projectId=${esc(slug)}</code>.
  The CLI uses this token via <code>OTA_UPDATES_TOKEN=${esc(plain)}</code>.
</div>
<p><a href="/admin/projects">← Back to projects</a></p>`;
    res.send(layout('Project created', body));
  } catch (err) {
    if (err.code === 11000) {
      return res.redirect('/admin/projects?msg=slug+already+in+use');
    }
    next(err);
  }
});

router.post('/projects/:id/keys', async (req, res, next) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.redirect('/admin/projects?msg=project+not+found');
    const plain = generateKey();
    await ApiKey.create({
      projectId: project._id,
      keyHash: hashKey(plain),
      name: req.body.name || 'generated',
    });
    AuditLog.create({
      projectId: project._id,
      type: 'key_created',
      actor: 'admin',
      payload: { name: req.body.name || 'generated' },
    }).catch(() => {});

    const body = `
<div class="flash">
  New API key for <strong>${esc(project.slug)}</strong> (shown only once):
  <pre style="user-select:all">${esc(plain)}</pre>
</div>
<p><a href="/admin/projects">← Back to projects</a></p>`;
    res.send(layout('API key created', body));
  } catch (err) {
    next(err);
  }
});

// ── Rollback / delete ────────────────────────────────────────────
router.post('/updates/:id/rollback', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).send('Invalid id');
    const update = await Update.findByIdAndUpdate(req.params.id, { status: 'rolledback' });
    if (update) {
      AuditLog.create({
        projectId: update.projectId,
        type: 'rollback',
        actor: 'admin',
        payload: { updateId: update._id.toString() },
      }).catch(() => {});
    }
    res.redirect('/admin?msg=rolled+back');
  } catch (err) {
    next(err);
  }
});

router.post('/updates/:id/delete', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).send('Invalid id');
    const update = await Update.findById(req.params.id);
    if (!update) return res.redirect('/admin?msg=not+found');

    // Best-effort delete from storage
    await Promise.all([
      s3.deleteKey(update.bundleKey).catch((e) => console.warn('S3 bundle delete failed:', e.message)),
      update.assetsZipKey ? s3.deleteKey(update.assetsZipKey).catch((e) => console.warn('S3 zip delete failed:', e.message)) : Promise.resolve(),
    ]);

    update.status = 'deleted';
    await update.save();

    AuditLog.create({
      projectId: update.projectId,
      type: 'delete',
      actor: 'admin',
      payload: { updateId: update._id.toString() },
    }).catch(() => {});

    res.redirect('/admin?msg=deleted');
  } catch (err) {
    next(err);
  }
});

// ── Audit log ─────────────────────────────────────────────────────
router.get('/audit', async (req, res, next) => {
  try {
    const logs = await AuditLog.find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('projectId', 'slug')
      .lean();
    const rows = logs
      .map(
        (l) => `<tr>
          <td>${fmtDate(l.createdAt)}</td>
          <td>${esc(l.projectId?.slug || '—')}</td>
          <td>${esc(l.type)}</td>
          <td>${esc(l.actor)}</td>
          <td class="mono">${esc(JSON.stringify(l.payload || {}))}</td>
        </tr>`,
      )
      .join('');
    const body = `<table>
      <tr><th>Time</th><th>Project</th><th>Event</th><th>Actor</th><th>Payload</th></tr>
      ${rows || '<tr><td colspan="5">No events yet.</td></tr>'}
    </table>`;
    res.send(layout('Audit log', body));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
