import { describe, it, expect } from "vitest";
import {
  resolveTimelockParams,
  validateTimelockState,
  initialTimelockState,
  type TimelockSectionState,
} from "../timelockHelpers";

// ============================================================================
// resolveTimelockParams
// ============================================================================

describe("resolveTimelockParams", () => {
  it("returns null when disabled", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: false,
      unlockValue: "2099-01-01T00:00",
    };
    expect(resolveTimelockParams(state)).toBeNull();
  });

  it("returns null when unlockValue is empty", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      unlockValue: "",
    };
    expect(resolveTimelockParams(state)).toBeNull();
  });

  it("resolves time mode to future UNIX timestamp", () => {
    const future = new Date(Date.now() + 86400 * 1000);
    const isoLocal = future.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "time",
      unlockValue: isoLocal,
    };
    const result = resolveTimelockParams(state);
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("time");
    expect(result!.unlockAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns null for past datetime-local", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "time",
      unlockValue: "2000-01-01T00:00",
    };
    expect(resolveTimelockParams(state)).toBeNull();
  });

  it("resolves block mode to block number", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "block",
      unlockValue: "500000",
    };
    const result = resolveTimelockParams(state);
    expect(result).not.toBeNull();
    expect(result!.mode).toBe("block");
    expect(result!.unlockAt).toBe(500000);
  });

  it("returns null for invalid block number", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "block",
      unlockValue: "abc",
    };
    expect(resolveTimelockParams(state)).toBeNull();
  });

  it("returns null for zero block height", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "block",
      unlockValue: "0",
    };
    expect(resolveTimelockParams(state)).toBeNull();
  });

  it("includes hint when provided", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "block",
      unlockValue: "500000",
      hint: "New Year Reveal",
    };
    const result = resolveTimelockParams(state);
    expect(result!.hint).toBe("New Year Reveal");
  });

  it("omits hint key when empty", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "block",
      unlockValue: "500000",
      hint: "",
    };
    const result = resolveTimelockParams(state);
    expect(result).not.toBeNull();
    expect("hint" in result!).toBe(false);
  });
});

// ============================================================================
// validateTimelockState
// ============================================================================

describe("validateTimelockState", () => {
  it("returns null when not enabled", () => {
    expect(
      validateTimelockState({ ...initialTimelockState, enabled: false })
    ).toBeNull();
  });

  it("requires unlockValue when enabled (time mode)", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "time",
      unlockValue: "",
    };
    expect(validateTimelockState(state)).not.toBeNull();
  });

  it("requires unlockValue when enabled (block mode)", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "block",
      unlockValue: "",
    };
    expect(validateTimelockState(state)).not.toBeNull();
  });

  it("rejects past datetime", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "time",
      unlockValue: "2000-01-01T00:00",
    };
    expect(validateTimelockState(state)).not.toBeNull();
  });

  it("accepts valid future datetime", () => {
    const future = new Date(Date.now() + 86400 * 1000)
      .toISOString()
      .slice(0, 16);
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "time",
      unlockValue: future,
    };
    expect(validateTimelockState(state)).toBeNull();
  });

  it("rejects invalid block number string", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "block",
      unlockValue: "not-a-number",
    };
    expect(validateTimelockState(state)).not.toBeNull();
  });

  it("rejects block <= currentBlock", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "block",
      unlockValue: "400000",
    };
    expect(validateTimelockState(state, 500000)).not.toBeNull();
  });

  it("accepts block > currentBlock", () => {
    const state: TimelockSectionState = {
      ...initialTimelockState,
      enabled: true,
      mode: "block",
      unlockValue: "600000",
    };
    expect(validateTimelockState(state, 500000)).toBeNull();
  });
});
