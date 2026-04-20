import { Platform } from 'react-native';
import { Native } from './native';
import * as Storage from './storage';
import type {
  OTAConfig,
  UpdateCheckResult,
  UpdateManifest,
  DownloadResult,
  VersionInfo,
} from './types';

let config: OTAConfig = {
  serverUrl: '',
  appVersion: '1.0.0',
  runtimeVersion: '1.0.0',
};

function log(...args: unknown[]) {
  if (config.debug) console.log('[OTA]', ...args);
}

function warn(...args: unknown[]) {
  console.warn('[OTA]', ...args);
}

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------

export function configure(opts: Partial<OTAConfig>): void {
  config = { ...config, ...opts };

  if (
    config.serverUrl.startsWith('http://') &&
    !config.serverUrl.includes('localhost') &&
    !config.serverUrl.includes('127.0.0.1')
  ) {
    warn('Using HTTP for a non-localhost server. Use HTTPS in production.');
  }

  log('Configured', { serverUrl: config.serverUrl, appVersion: config.appVersion });
}

export function getConfig(): Readonly<OTAConfig> {
  return config;
}

// ------------------------------------------------------------------
// Check for update
// ------------------------------------------------------------------

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!config.serverUrl) {
    throw new Error('OTA server URL not configured. Call configure() first.');
  }

  const current = await Storage.getCurrent();
  const params = new URLSearchParams({
    appVersion: config.appVersion,
    runtimeVersion: config.runtimeVersion,
    currentUpdateId: current?.updateId || '',
    clientId: config.clientId || '',
    platform: Platform.OS,
  });

  const url = `${config.serverUrl}/check?${params}`;
  log('Checking', url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout || 30000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ------------------------------------------------------------------
// Download update
// ------------------------------------------------------------------

export async function downloadUpdate(
  update: UpdateCheckResult,
): Promise<DownloadResult> {
  if (!update.available || !update.updateId) {
    throw new Error('No update available to download.');
  }

  const { updateId, bundleHash, manifestUrl } = update;
  const dir = Storage.bundleDir(updateId);
  await Native.mkdir(dir);

  try {
    // 1 — Manifest
    log('Downloading manifest…');
    const manifestRes = await fetch(`${config.serverUrl}${manifestUrl}`);
    if (!manifestRes.ok) throw new Error(`Manifest fetch failed: ${manifestRes.status}`);
    const manifest: UpdateManifest = await manifestRes.json();
    await Native.writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));

    // 2 — Bundle → temp file
    log('Downloading bundle…');
    const bundleRes = await fetch(`${config.serverUrl}${manifest.bundleUrl}`);
    if (!bundleRes.ok) throw new Error(`Bundle fetch failed: ${bundleRes.status}`);

    const buf = await bundleRes.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    const tmp = `${dir}/bundle.js.tmp`;
    const final = `${dir}/bundle.js`;
    await Native.writeFile(tmp, b64, 'base64');

    // 3 — SHA-256 verification
    log('Verifying hash…');
    const actual = await Native.sha256File(tmp);
    if (actual !== bundleHash) {
      await Native.deleteFile(dir).catch(() => {});
      throw new Error(
        `Integrity check failed.\n  Expected: ${bundleHash}\n  Got:      ${actual}`,
      );
    }

    // 4 — Atomic rename
    await Native.moveFile(tmp, final);
    log('Download complete', updateId);

    return { updateId, bundlePath: final, manifest };
  } catch (err) {
    await Native.deleteFile(dir).catch(() => {});
    throw err;
  }
}

// ------------------------------------------------------------------
// Apply update (activates on next restart)
// ------------------------------------------------------------------

export async function applyUpdate(result: DownloadResult): Promise<void> {
  const { updateId, bundlePath, manifest } = result;

  // current → previous (rollback safety net)
  const current = await Storage.getCurrent();
  if (current) await Storage.setPrevious(current);

  await Storage.setCurrent({
    updateId,
    bundlePath,
    status: 'pending',
    appVersion: manifest.appVersion,
    runtimeVersion: manifest.runtimeVersion,
    bundleHash: manifest.bundleHash,
    appliedAt: Date.now(),
  });

  await Native.setNextBundlePath(bundlePath);
  log('Update applied (pending restart)', updateId);

  // Cleanup old bundles
  const prev = await Storage.getPrevious();
  const keep = [updateId];
  if (prev?.updateId) keep.push(prev.updateId);
  await Storage.cleanup(keep);
}

// ------------------------------------------------------------------
// Stability & rollback
// ------------------------------------------------------------------

export async function markStable(): Promise<void> {
  const current = await Storage.getCurrent();
  if (current?.status === 'pending') {
    current.status = 'stable';
    current.confirmedAt = Date.now();
    await Storage.setCurrent(current);
    await Native.confirmLaunchSuccess();
    log('Marked stable', current.updateId);
  }
}

export async function rollback(): Promise<void> {
  const prev = await Storage.getPrevious();
  if (prev) {
    prev.status = 'rollback';
    await Storage.setCurrent(prev);
    await Storage.setPrevious(null);
    await Native.setNextBundlePath(prev.bundlePath);
    warn('Rolled back to', prev.updateId);
  } else {
    await Storage.setCurrent(null);
    await Native.clearBundlePath();
    warn('Rolled back to default bundle');
  }
}

export async function getCurrentVersion(): Promise<VersionInfo> {
  const current = await Storage.getCurrent();
  return {
    updateId: current?.updateId ?? null,
    bundlePath: current?.bundlePath ?? null,
    status: current?.status ?? 'default',
    appVersion: config.appVersion,
    runtimeVersion: config.runtimeVersion,
    isOTABundle: !!current?.updateId,
  };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return globalThis.btoa(bin);
}
