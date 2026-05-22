import { signal } from "@preact/signals-react";
import db from "@app/db";

/**
 * Idle auto-lock — configurable. Reactive across components via the
 * `autoLockMs` signal, persisted in Dexie kvp under "autoLockMs".
 *
 * R4: bumped default from 10 min to 15 min. The actual lock action lives
 * in `wallet.ts::lockWallet` (which wipes the byte-backed secrets); this
 * module owns timing + persistence only.
 */

/** Default idle-lock duration in milliseconds (15 minutes). */
export const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;

/** Minimum allowed idle-lock duration — guard against accidentally setting
 *  a tiny value that locks mid-keystroke. 30 seconds. */
export const MIN_AUTO_LOCK_MS = 30 * 1000;

/** Maximum allowed idle-lock duration — 12 hours. Past this the protection
 *  is largely theoretical and an attacker has plenty of window. */
export const MAX_AUTO_LOCK_MS = 12 * 60 * 60 * 1000;

/**
 * Reactive idle-lock interval. Components import this signal directly so
 * an in-flight change in WalletSettings propagates to the active timer
 * without needing a page refresh.
 */
export const autoLockMs = signal<number>(DEFAULT_AUTO_LOCK_MS);

/** Clamp + sanitize a user-supplied number. */
export function clampAutoLockMs(input: number): number {
  if (!Number.isFinite(input) || input <= 0) return DEFAULT_AUTO_LOCK_MS;
  return Math.min(
    MAX_AUTO_LOCK_MS,
    Math.max(MIN_AUTO_LOCK_MS, Math.floor(input))
  );
}

/**
 * Hydrate `autoLockMs` from Dexie on app boot. Silently falls back to the
 * default if the kvp row is missing or unreadable.
 */
export async function loadAutoLockMs(): Promise<void> {
  try {
    const stored = (await db.kvp.get("autoLockMs")) as number | undefined;
    if (typeof stored === "number" && Number.isFinite(stored)) {
      autoLockMs.value = clampAutoLockMs(stored);
    }
  } catch {
    // Dexie not available (e.g. fresh install before db opens) — keep default.
  }
}

/**
 * Persist a new idle-lock interval. The signal updates synchronously so
 * any mounted `useActivityDetector` instance picks it up on its next
 * effect run.
 */
export async function saveAutoLockMs(value: number): Promise<void> {
  const clamped = clampAutoLockMs(value);
  autoLockMs.value = clamped;
  try {
    await db.kvp.put(clamped, "autoLockMs");
  } catch {
    // Persist failed — the in-memory signal is still updated for this
    // session. User-visible feedback is the caller's job.
  }
}
