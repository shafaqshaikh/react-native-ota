const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const BSDIFF_TIMEOUT_MS = 120_000;  // 2 min hard ceiling for large bundles

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { timeout: BSDIFF_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts });
    let stderr = '';
    let settled = false;
    const settleReject = (err) => { if (!settled) { settled = true; reject(err); } };
    const settleResolve = () => { if (!settled) { settled = true; resolve(); } };

    // Best-effort deprioritise — ignore platforms without setPriority.
    try { os.setPriority(p.pid, 10); } catch { /* non-Linux or not supported */ }

    p.stderr.on('data', (d) => {
      if (stderr.length < 8 * 1024) stderr += d.toString();  // bounded
    });
    p.on('error', (err) => settleReject(err));
    p.on('exit', (code, signal) => {
      if (signal === 'SIGKILL') {
        return settleReject(new Error(`${cmd} timed out after ${BSDIFF_TIMEOUT_MS}ms`));
      }
      if (code === 0) return settleResolve();
      settleReject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function computePatch(oldBuf, newBuf) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bsdiff-'));
  const oldPath = path.join(tmpDir, 'old');
  const newPath = path.join(tmpDir, 'new');
  const patchPath = path.join(tmpDir, 'patch');

  try {
    await fs.writeFile(oldPath, oldBuf);
    await fs.writeFile(newPath, newBuf);
    await runCommand('bsdiff', [oldPath, newPath, patchPath]);
    return await fs.readFile(patchPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const PATCH_SIZE_GUARD_RATIO = 0.6;

async function generate({
  baseUpdate,
  newUpdate,
  newBundleBuffer,
  projectSlug,
  s3,
  UpdateDiff,
}) {
  const oldBuf = await s3.downloadBuffer(baseUpdate.bundleKey);
  const patchBuf = await computePatch(oldBuf, newBundleBuffer);

  if (patchBuf.length > newBundleBuffer.length * PATCH_SIZE_GUARD_RATIO) {
    return null;
  }

  const patchKey = `${projectSlug}/${newUpdate._id}/diffs/${baseUpdate._id}.patch`;
  const patchHash = sha256Hex(patchBuf);

  await s3.uploadBuffer(patchKey, patchBuf, 'application/octet-stream');

  const doc = await UpdateDiff.create({
    toUpdateId: newUpdate._id,
    fromUpdateId: baseUpdate._id,
    fromBundleHash: baseUpdate.bundleHash,
    patchKey,
    patchHash,
    patchSize: patchBuf.length,
  });

  return doc;
}

module.exports = {
  computePatch,
  sha256Hex,
  generate,
};
