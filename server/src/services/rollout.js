/**
 * Compute the currently-active rollout percentage for a given update.
 *
 * - If no schedule is set, return the static rolloutPct.
 * - If a schedule is set, return the pct for the most recent step whose
 *   `atMinutes` offset (from rolloutStartedAt) has already elapsed.
 * - The static rolloutPct still acts as a ceiling.
 */
function currentRolloutPct(update, now = Date.now()) {
  const ceiling = typeof update.rolloutPct === 'number' ? update.rolloutPct : 100;
  const schedule = update.rolloutSchedule;
  if (!schedule || schedule.length === 0) return ceiling;

  const start = update.rolloutStartedAt
    ? new Date(update.rolloutStartedAt).getTime()
    : new Date(update.createdAt).getTime();

  // Sort by atMinutes ascending just in case they weren't stored in order.
  const sorted = [...schedule].sort((a, b) => a.atMinutes - b.atMinutes);
  let pct = 0;
  for (const step of sorted) {
    if (now >= start + step.atMinutes * 60 * 1000) pct = step.pct;
    else break;
  }
  return Math.min(pct, ceiling);
}

/**
 * Deterministic bucket: the same clientId always lands in the same bucket,
 * so rollouts are consistent even when a device retries /check.
 */
function passesRollout(pct, clientId) {
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  if (!clientId) return false;
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = ((hash << 5) - hash + clientId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100 < pct;
}

/**
 * Given a list of recent active updates (newest first), pick the one this
 * device should receive based on its rollout percentages.
 */
function pickForDevice(updates, clientId, now = Date.now()) {
  for (const update of updates) {
    const pct = currentRolloutPct(update, now);
    if (passesRollout(pct, clientId)) {
      return { update, effectivePct: pct };
    }
  }
  return null;
}

module.exports = { currentRolloutPct, passesRollout, pickForDevice };
