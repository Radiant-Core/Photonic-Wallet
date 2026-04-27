/**
 * Pure timelock UI helpers — no React/Lingui imports.
 * Exported for both TimelockSection.tsx and unit tests.
 */

import { type TimelockMode } from "@lib/timelock";

// ============================================================================
// Types
// ============================================================================

export type TimelockSectionState = {
  enabled: boolean;
  mode: TimelockMode;
  /**
   * Block mode: stringified integer block height.
   * Time mode: ISO 8601 datetime-local string (YYYY-MM-DDTHH:mm).
   */
  unlockValue: string;
  hint: string;
};

export const initialTimelockState: TimelockSectionState = {
  enabled: false,
  mode: "time",
  unlockValue: "",
  hint: "",
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the UI state to concrete timelock parameters, or null if invalid.
 */
export function resolveTimelockParams(
  state: TimelockSectionState
): { mode: TimelockMode; unlockAt: number; hint?: string } | null {
  if (!state.enabled || !state.unlockValue) return null;

  if (state.mode === "block") {
    const block = parseInt(state.unlockValue, 10);
    if (isNaN(block) || block <= 0) return null;
    return {
      mode: "block",
      unlockAt: block,
      ...(state.hint ? { hint: state.hint } : {}),
    };
  }

  // Time mode
  const ms = new Date(state.unlockValue).getTime();
  if (isNaN(ms) || ms <= Date.now()) return null;
  return {
    mode: "time",
    unlockAt: Math.floor(ms / 1000),
    ...(state.hint ? { hint: state.hint } : {}),
  };
}

/**
 * Validate timelock state and return an i18n-safe error string, or null.
 * Note: returns plain strings (not Lingui `t` tagged) for test portability.
 */
export function validateTimelockState(
  state: TimelockSectionState,
  currentBlock?: number
): string | null {
  if (!state.enabled) return null;

  if (!state.unlockValue) {
    return state.mode === "block"
      ? "Enter a block height"
      : "Enter an unlock date/time";
  }

  if (state.mode === "block") {
    const block = parseInt(state.unlockValue, 10);
    if (isNaN(block) || block <= 0) return "Invalid block height";
    if (currentBlock !== undefined && block <= currentBlock) {
      return `Unlock block must be in the future (current: ${currentBlock})`;
    }
  } else {
    const ms = new Date(state.unlockValue).getTime();
    if (isNaN(ms)) return "Invalid date/time";
    if (ms <= Date.now()) return "Unlock time must be in the future";
  }

  return null;
}
