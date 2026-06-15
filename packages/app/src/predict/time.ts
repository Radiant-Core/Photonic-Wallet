/**
 * Block ↔ wall-clock helpers for the prediction-market UI.
 *
 * Radiant targets one block every five minutes on every network
 * (`consensus.nPowTargetSpacing = 5 * 60` in Radiant-Core `chainparams.cpp`), so a block delta
 * maps to an *approximate* duration. Block times only hold on average, so every estimate derived
 * here is approximate — callers prefix it with "≈" and never present it as a hard deadline. The
 * hard facts (expiry block, grace, liveness) stay in blocks; these helpers only humanise them.
 */

/** RXD target block spacing, seconds. Source: Radiant-Core chainparams `nPowTargetSpacing = 5*60`. */
export const SECONDS_PER_BLOCK = 300;

/** Blocks remaining until `target` (0 once reached/passed). Clamped at 0 so countdowns never go negative. */
export function blocksUntil(current: number, target: number): number {
  return Math.max(0, Math.floor(target - current));
}

/** Seconds for a (non-negative) block count, rounded. */
export function blocksToSeconds(blocks: number): number {
  return Math.max(0, Math.round(blocks)) * SECONDS_PER_BLOCK;
}

/**
 * Coarse, compact human duration for a block count, e.g. "45m", "3h 20m", "2d".
 * Returns "now" for <= 0 blocks. Intended to be rendered behind an "≈" — it is a target-based
 * estimate, not a guarantee.
 */
export function blocksToDuration(blocks: number): string {
  const secs = blocksToSeconds(blocks);
  if (secs <= 0) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 48) return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/**
 * "≈3h 20m" style ETA for reaching `target` from `current`, or "now" when already there.
 * Convenience wrapper around {@link blocksUntil} + {@link blocksToDuration}.
 */
export function blockEta(current: number, target: number): string {
  const left = blocksUntil(current, target);
  if (left <= 0) return "now";
  return `≈${blocksToDuration(left)}`;
}
