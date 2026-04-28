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

/** If the manifest URL is absolute (http(s)://), use as-is — S3/R2 URLs are direct. */
function absoluteUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${config.serverUrl}${url}`;
}

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
  if (config.projectId) params.set('projectId', config.projectId);
  if (config.channel) params.set('channel', config.channel);

  // Prefer v1 if projectId is set; fall back to legacy path otherwise.
  const endpoint = config.projectId ? '/v1/check' : '/check';
  const url = `${config.serverUrl}${endpoint}?${params}`;
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
    // 1 — Fetch manifest, appending ?from=<currentBundleHash> so the server
    //     can include a diff URL tailored to this device's current bundle.
    log('Downloading manifest…');
    const current = await Storage.getCurrent();
    const baseManifestUrl = absoluteUrl(manifestUrl!);
    const manifestFetchUrl = current?.bundleHash
      ? `${baseManifestUrl}${baseManifestUrl.includes('?') ? '&' : '?'}from=${current.bundleHash}`
      : baseManifestUrl;
    const manifestRes = await fetch(manifestFetchUrl);
    if (!manifestRes.ok) throw new Error(`Manifest fetch failed: ${manifestRes.status}`);
    const manifest: UpdateManifest = await manifestRes.json();
    await Native.writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));

    const finalBundle = `${dir}/bundle.hbc`;

    // 2 — Delta path: attempt if the server returned a patch applicable to
    //     the device's current bundle.
    const deltaApplicable =
      !!manifest.diffUrl &&
      !!manifest.diffHash &&
      !!manifest.fromBundleHash &&
      !!current?.bundlePath &&
      current.bundleHash === manifest.fromBundleHash;

    if (deltaApplicable) {
      log('Attempting delta patch…');
      try {
        await applyDelta(current!.bundlePath, manifest, dir, finalBundle);
        log('Delta patch applied successfully');
      } catch (deltaErr) {
        log('Delta patch failed, falling back to full download:', deltaErr);
        await fullBundleDownload(manifest, dir, finalBundle, bundleHash!);
      }
    } else {
      // 3 — Full bundle download path
      await fullBundleDownload(manifest, dir, finalBundle, bundleHash!);
    }

    // 4 — Download+extract the single assets zip (Android). One HTTP GET
    // beats hundreds of individual asset GETs. iOS manifests omit this
    // field and keep the native symlink-to-main-bundle trick.
    if (manifest.assetsZipUrl) {
      log('Downloading assets zip…');
      const zipPath = `${dir}/assets.zip`;
      await Native.downloadFile(absoluteUrl(manifest.assetsZipUrl), zipPath);
      if (manifest.assetsZipHash) {
        const actualZipHash = await Native.sha256File(zipPath);
        if (actualZipHash !== manifest.assetsZipHash) {
          throw new Error(
            `Assets zip integrity check failed.\n` +
            `  Expected: ${manifest.assetsZipHash}\n  Got:      ${actualZipHash}`,
          );
        }
      }
      await Native.unzipFile(zipPath, dir);
      await Native.deleteFile(zipPath).catch(() => {});
    }

    log('Download complete', updateId);

    return { updateId, bundlePath: finalBundle, manifest };
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
// Reload (apply downloaded update immediately, like Updates.reloadAsync)
// ------------------------------------------------------------------

export async function reloadAsync(): Promise<void> {
  log('Reloading bridge to apply OTA bundle…');
  await Native.reload();
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

/**
 * Apply a binary delta patch to reconstruct the new bundle.
 * Throws on any failure — caller falls back to full bundle download.
 */
async function applyDelta(
  basePath: string,
  manifest: UpdateManifest,
  dir: string,
  finalBundle: string,
): Promise<void> {
  const patchPath = `${dir}/bundle.patch`;
  const tmpOut = `${finalBundle}.tmp`;

  await Native.downloadFile(absoluteUrl(manifest.diffUrl!), patchPath);

  const actualPatchHash = await Native.sha256File(patchPath);
  if (actualPatchHash !== manifest.diffHash) {
    throw new Error(
      `Patch hash mismatch (expected ${manifest.diffHash}, got ${actualPatchHash})`,
    );
  }

  await Native.applyPatch(basePath, patchPath, tmpOut);

  const actualOut = await Native.sha256File(tmpOut);
  if (actualOut !== manifest.bundleHash) {
    throw new Error(
      `Reconstructed bundle hash mismatch (expected ${manifest.bundleHash}, got ${actualOut})`,
    );
  }

  await Native.moveFile(tmpOut, finalBundle);
  await Native.deleteFile(patchPath).catch(() => {});
}

/**
 * The existing full-bundle download path — extracted so the delta path
 * can fall back to it on any failure.
 */
async function fullBundleDownload(
  manifest: UpdateManifest,
  dir: string,
  finalBundle: string,
  expectedHash: string,
): Promise<void> {
  log('Downloading bundle...');
  const bundleUrl = absoluteUrl(manifest.bundleUrl);
  const tmp = `${finalBundle}.tmp`;
  await Native.downloadFile(bundleUrl, tmp);

  log('Verifying hash...');
  const actual = await Native.sha256File(tmp);
  if (actual !== expectedHash) {
    await Native.deleteFile(dir).catch(() => {});
    throw new Error(
      `Integrity check failed.\n  Expected: ${expectedHash}\n  Got:      ${actual}`,
    );
  }

  await Native.moveFile(tmp, finalBundle);
}

