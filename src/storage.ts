/**
 * Local storage for OTA update metadata.
 *
 * Structure:
 *   <documents>/ota-updates/
 *     current.json    → active update metadata
 *     previous.json   → rollback target
 *     bundles/
 *       <updateId>/
 *         bundle.js
 *         manifest.json
 */

import { Native, documentDirectory } from './native';
import type { UpdateMetadata } from './types';

const BASE = `${documentDirectory}/ota-updates`;
const BUNDLES = `${BASE}/bundles`;
const CURRENT = `${BASE}/current.json`;
const PREVIOUS = `${BASE}/previous.json`;

async function ensureDirs(): Promise<void> {
  await Native.mkdir(BUNDLES);
}

async function readJSON<T>(path: string): Promise<T | null> {
  try {
    const exists = await Native.exists(path);
    if (!exists) return null;
    const raw = await Native.readFile(path);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJSON(path: string, data: unknown): Promise<void> {
  await Native.writeFile(path, JSON.stringify(data, null, 2));
}

export async function getCurrent(): Promise<UpdateMetadata | null> {
  return readJSON<UpdateMetadata>(CURRENT);
}

export async function setCurrent(meta: UpdateMetadata | null): Promise<void> {
  await ensureDirs();
  if (meta) {
    await writeJSON(CURRENT, meta);
  } else if (await Native.exists(CURRENT)) {
    await Native.deleteFile(CURRENT);
  }
}

export async function getPrevious(): Promise<UpdateMetadata | null> {
  return readJSON<UpdateMetadata>(PREVIOUS);
}

export async function setPrevious(meta: UpdateMetadata | null): Promise<void> {
  await ensureDirs();
  if (meta) {
    await writeJSON(PREVIOUS, meta);
  } else if (await Native.exists(PREVIOUS)) {
    await Native.deleteFile(PREVIOUS);
  }
}

export function bundleDir(updateId: string): string {
  return `${BUNDLES}/${updateId}`;
}

export function bundlePath(updateId: string): string {
  return `${BUNDLES}/${updateId}/bundle.js`;
}

export async function cleanup(keepIds: string[]): Promise<void> {
  try {
    if (!(await Native.exists(BUNDLES))) return;
    const items = await Native.readDir(BUNDLES);
    for (const item of items) {
      if (item.isDirectory && !keepIds.includes(item.name)) {
        await Native.deleteFile(item.path);
      }
    }
  } catch {
    // non-critical
  }
}
