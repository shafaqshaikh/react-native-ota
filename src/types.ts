export interface OTAConfig {
  /** URL of your OTA update server */
  serverUrl: string;
  /** Project slug, registered via /admin on the server */
  projectId?: string;
  /** Release channel (default: "production") */
  channel?: string;
  /** Current app version (e.g. "1.4.9") */
  appVersion: string;
  /** Runtime version — updates only apply if this matches */
  runtimeVersion: string;
  /** Unique device ID for rollout bucketing */
  clientId?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Enable debug logging (default: false in production) */
  debug?: boolean;
}

export interface UpdateCheckResult {
  /** Whether an update is available */
  available: boolean;
  /** Update ID from server */
  updateId?: string;
  /** SHA256 hash of the bundle */
  bundleHash?: string;
  /** URL to fetch the manifest */
  manifestUrl?: string;
  /** Server-side platform tag */
  platform?: string;
  /** When the update was published */
  createdAt?: number;
}

export interface UpdateManifest {
  id: string;
  platform: string;
  appVersion: string;
  runtimeVersion: string;
  bundleHash: string;
  bundleUrl: string;
  /** URL to a single zip of all assets (Android only). iOS uses a symlink trick instead. */
  assetsZipUrl?: string | null;
  /** SHA-256 hash of the zip for integrity verification. */
  assetsZipHash?: string | null;
  assets: AssetEntry[];
  createdAt: number;
}

export interface AssetEntry {
  name: string;
  hash: string;
  url: string;
}

export interface DownloadResult {
  updateId: string;
  bundlePath: string;
  manifest: UpdateManifest;
}

export interface UpdateMetadata {
  updateId: string;
  bundlePath: string;
  status: 'pending' | 'stable' | 'rollback';
  appVersion: string;
  runtimeVersion: string;
  bundleHash: string;
  appliedAt: number;
  confirmedAt?: number;
}

export interface VersionInfo {
  updateId: string | null;
  bundlePath: string | null;
  status: string;
  appVersion: string;
  runtimeVersion: string;
  isOTABundle: boolean;
}

export type UpdateStatus = 'pending' | 'stable' | 'rollback';

export interface InitializeOptions extends Partial<OTAConfig> {
  /** Auto-check for updates on init (default: true) */
  autoCheck?: boolean;
  /** Ms to wait before marking update as stable (default: 10000) */
  stabilityDelay?: number;
  /** Called when an update is found during auto-check */
  onUpdateAvailable?: (update: UpdateCheckResult) => void;
}
