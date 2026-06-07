/**
 * Soft-expiry policy for broadcast swap offers. Pins the staleness math the
 * Open Orders book and the swap-offer risk UI rely on. See
 * `docs/swap-offer-expiry-cancellation.md` and the TODO(security) it resolves
 * in `pages/Swap.tsx`.
 */
import { describe, it, expect } from "vitest";
import {
  SWAP_BLOCK_SECONDS,
  SWAP_OFFER_DEFAULT_MAX_AGE_BLOCKS,
  offerAgeBlocks,
  isOfferStale,
  offerAgeLabel,
} from "@app/swapExpiry";

describe("swap soft-expiry constants", () => {
  it("defaults to a ~30 day window at 600s blocks", () => {
    expect(SWAP_BLOCK_SECONDS).toBe(600);
    expect(SWAP_OFFER_DEFAULT_MAX_AGE_BLOCKS).toBe(4320);
  });
});

describe("offerAgeBlocks", () => {
  it("returns the block delta for a dated offer", () => {
    expect(offerAgeBlocks(1000, 1500)).toBe(500);
  });

  it("returns 0 for an offer mined at the current tip", () => {
    expect(offerAgeBlocks(1500, 1500)).toBe(0);
  });

  it("returns null when the offer has no confirmation height", () => {
    expect(offerAgeBlocks(0, 1500)).toBeNull();
  });

  it("returns null when the current height is unknown", () => {
    expect(offerAgeBlocks(1000, 0)).toBeNull();
  });

  it("returns null for a future / out-of-order block height", () => {
    expect(offerAgeBlocks(1600, 1500)).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    expect(offerAgeBlocks(NaN, 1500)).toBeNull();
    expect(offerAgeBlocks(1000, Infinity)).toBeNull();
  });
});

describe("isOfferStale", () => {
  const current = 100000;

  it("is not stale within the window", () => {
    expect(isOfferStale(current - 100, current)).toBe(false);
  });

  it("is not stale exactly at the window boundary", () => {
    expect(
      isOfferStale(current - SWAP_OFFER_DEFAULT_MAX_AGE_BLOCKS, current)
    ).toBe(false);
  });

  it("is stale one block past the window", () => {
    expect(
      isOfferStale(current - SWAP_OFFER_DEFAULT_MAX_AGE_BLOCKS - 1, current)
    ).toBe(true);
  });

  it("honors a custom max age", () => {
    expect(isOfferStale(current - 11, current, 10)).toBe(true);
    expect(isOfferStale(current - 9, current, 10)).toBe(false);
  });

  it("treats an undateable offer as not stale (fail-open for display)", () => {
    expect(isOfferStale(0, current)).toBe(false);
    expect(isOfferStale(current, 0)).toBe(false);
  });
});

describe("offerAgeLabel", () => {
  it("labels days", () => {
    // 144 blocks * 600s = 86400s = 1 day
    expect(offerAgeLabel(1000, 1000 + 144 * 3)).toBe("3 days old");
    expect(offerAgeLabel(1000, 1000 + 144)).toBe("1 day old");
  });

  it("labels hours below a day", () => {
    // 6 blocks * 600s = 3600s = 1 hour
    expect(offerAgeLabel(1000, 1000 + 6 * 5)).toBe("5 hours old");
    expect(offerAgeLabel(1000, 1000 + 6)).toBe("1 hour old");
  });

  it("labels minutes below an hour, flooring to at least one", () => {
    expect(offerAgeLabel(1000, 1000 + 1)).toBe("10 minutes old");
    expect(offerAgeLabel(1000, 1000)).toBe("1 minute old");
  });

  it("returns null when the age is unknown", () => {
    expect(offerAgeLabel(0, 1000)).toBeNull();
  });
});
