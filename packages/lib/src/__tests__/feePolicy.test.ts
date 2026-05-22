import { describe, it, expect } from "vitest";
import {
  MIN_RELAY_FEE_RATE,
  LEGACY_MIN_RELAY_FEE_RATE,
  MAX_REASONABLE_FEE_RATE,
  normalizeFeeRate,
} from "../feePolicy";

describe("feePolicy constants", () => {
  it("MIN_RELAY_FEE_RATE matches Radiant Core RADIANT_CORE_2_MIN_RELAY_TX_FEE_PER_KB", () => {
    // policy.h:49 — 10_000_000 sats/kB = 10_000 photons/byte
    expect(MIN_RELAY_FEE_RATE).toBe(10_000);
  });

  it("LEGACY_MIN_RELAY_FEE_RATE matches the pre-V2 floor", () => {
    // policy.h:47 — 1_000_000 sats/kB = 1_000 photons/byte
    expect(LEGACY_MIN_RELAY_FEE_RATE).toBe(1_000);
  });

  it("MAX_REASONABLE_FEE_RATE is 2x the network minimum", () => {
    expect(MAX_REASONABLE_FEE_RATE).toBe(2 * MIN_RELAY_FEE_RATE);
  });
});

describe("normalizeFeeRate", () => {
  it("returns the input when it is at or above the minimum", () => {
    expect(normalizeFeeRate(MIN_RELAY_FEE_RATE)).toBe(MIN_RELAY_FEE_RATE);
    expect(normalizeFeeRate(50_000)).toBe(50_000);
  });

  it("clamps inputs below the minimum up to the floor", () => {
    expect(normalizeFeeRate(1)).toBe(MIN_RELAY_FEE_RATE);
    expect(normalizeFeeRate(LEGACY_MIN_RELAY_FEE_RATE)).toBe(
      MIN_RELAY_FEE_RATE
    );
    expect(normalizeFeeRate(9_999)).toBe(MIN_RELAY_FEE_RATE);
  });

  it("treats zero, negative, NaN, and infinity as the floor", () => {
    expect(normalizeFeeRate(0)).toBe(MIN_RELAY_FEE_RATE);
    expect(normalizeFeeRate(-1)).toBe(MIN_RELAY_FEE_RATE);
    expect(normalizeFeeRate(NaN)).toBe(MIN_RELAY_FEE_RATE);
    expect(normalizeFeeRate(Infinity)).toBe(MIN_RELAY_FEE_RATE);
  });
});
