/**
 * In-memory update store. Replace with a real database (PostgreSQL, SQLite)
 * for production. The interface stays the same.
 */

class UpdateStore {
  constructor() {
    // Map<updateId, UpdateRecord>
    this.updates = new Map();
    // Map<"appVersion:runtimeVersion", UpdateRecord[]> — index for fast lookup
    this.versionIndex = new Map();
  }

  /**
   * Save an update record.
   * @param {object} record - { id, appVersion, runtimeVersion, bundleHash, assets, rolloutPercentage, createdAt, manifestPath, bundlePath }
   */
  save(record) {
    this.updates.set(record.id, record);

    const key = `${record.appVersion}:${record.runtimeVersion}`;
    if (!this.versionIndex.has(key)) {
      this.versionIndex.set(key, []);
    }
    this.versionIndex.get(key).push(record);
  }

  getById(id) {
    return this.updates.get(id) || null;
  }

  /**
   * Find the latest update that matches the given app/runtime version
   * and passes rollout targeting.
   */
  findLatest(appVersion, runtimeVersion, clientId) {
    const key = `${appVersion}:${runtimeVersion}`;
    const candidates = this.versionIndex.get(key);
    if (!candidates || candidates.length === 0) return null;

    // Sort by createdAt descending — newest first
    const sorted = [...candidates].sort((a, b) => b.createdAt - a.createdAt);

    for (const update of sorted) {
      if (this._passesRollout(update, clientId)) {
        return update;
      }
    }
    return null;
  }

  /**
   * Deterministic rollout check based on clientId hash.
   * A clientId always maps to the same bucket (0-99), so a given
   * device either always gets the update or never does at a given %.
   */
  _passesRollout(update, clientId) {
    if (!update.rolloutPercentage || update.rolloutPercentage >= 100) return true;
    if (!clientId) return false;

    let hash = 0;
    for (let i = 0; i < clientId.length; i++) {
      hash = ((hash << 5) - hash + clientId.charCodeAt(i)) | 0;
    }
    const bucket = Math.abs(hash) % 100;
    return bucket < update.rolloutPercentage;
  }

  getAll() {
    return [...this.updates.values()];
  }
}

module.exports = { UpdateStore };