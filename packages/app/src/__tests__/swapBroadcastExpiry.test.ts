import { describe, it, expect } from "vitest";
import {
  isOfferExpiredOnChain,
  RSWP_VERSION_V2,
  RSWP_VERSION_V3,
  RSWP_FLAG_HAS_EXPIRY,
  type SwapOffer,
} from "@app/swapBroadcast";

// Minimal SwapOffer-shaped fixture; only expiry_height matters for these tests.
function offer(expiry_height?: number): Pick<SwapOffer, "expiry_height"> {
  return { expiry_height };
}

describe("RSWP version / flag constants", () => {
  it("v2 = 0x02, v3 = 0x03, expiry flag = 0x02 (bit 1, distinct from want-token bit 0)", () => {
    expect(RSWP_VERSION_V2).toBe(0x02);
    expect(RSWP_VERSION_V3).toBe(0x03);
    expect(RSWP_FLAG_HAS_EXPIRY).toBe(0x02);
    // want-token bit is 0x01; the expiry bit must not collide with it.
    expect(RSWP_FLAG_HAS_EXPIRY & 0x01).toBe(0);
  });
});

describe("isOfferExpiredOnChain", () => {
  it("v2 offers (no expiry_height) are never on-chain-expired", () => {
    expect(isOfferExpiredOnChain(offer(undefined), 1_000_000)).toBe(false);
    expect(isOfferExpiredOnChain(offer(0), 1_000_000)).toBe(false);
  });

  it("fillable strictly before expiry; expired at/after the height", () => {
    expect(isOfferExpiredOnChain(offer(410_000), 409_999)).toBe(false);
    expect(isOfferExpiredOnChain(offer(410_000), 410_000)).toBe(true);
    expect(isOfferExpiredOnChain(offer(410_000), 410_001)).toBe(true);
  });

  it("unknown chain tip (0 / NaN) is treated as not-expired (fail-open)", () => {
    expect(isOfferExpiredOnChain(offer(410_000), 0)).toBe(false);
    expect(isOfferExpiredOnChain(offer(410_000), Number.NaN)).toBe(false);
  });

  it("matches the covenant boundary: fillable iff currentHeight < expiry_height", () => {
    const expiry = 500_000;
    for (const tip of [499_998, 499_999, 500_000, 500_001]) {
      expect(isOfferExpiredOnChain(offer(expiry), tip)).toBe(tip >= expiry);
    }
  });
});
