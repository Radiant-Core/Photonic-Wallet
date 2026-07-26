/**
 * Unit tests for `../swapFlow`'s pure royalty-total helper
 * (`royaltyTotalRxd`), the figure the `swap-accept-request` approval screen
 * shows the taker on top of the price.
 *
 * Why this is worth a test: the taker pays price + royalty + marketplace fee,
 * so a royalty the screen understates is money the user approves without
 * seeing. The helper deliberately sums the outputs `buildRoyaltyOutputs`
 * actually builds rather than recomputing bps itself — these tests assert
 * that real function's behaviour (clamping, split rounding) flows through,
 * so a rounding change in the payout path can't leave the displayed total
 * silently disagreeing with what gets charged.
 *
 * The broadcasting halves of swapFlow (`createSwapOffer`, `acceptSwapOffer`,
 * `cancelSwapOffer`) touch db/electrum/wallet signals and are exercised
 * end-to-end via the connect UI rather than mocked here; the modules that
 * construct a real Worker or hit the network at import time are stubbed
 * below, same reason and pattern as `mintFlow.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { RoyaltyTerms } from "@lib/royaltyTerms";

vi.mock("@app/electrum/Electrum", () => ({ electrumWorker: { value: {} } }));
vi.mock("@app/utxos", () => ({
  updateRxdBalances: vi.fn(),
  updateWalletUtxos: vi.fn(),
}));
vi.mock("@app/swapActivity", () => ({ broadcastSwapCompletion: vi.fn() }));
vi.mock("@app/swap", () => ({ cancelSwap: vi.fn() }));

import { royaltyTotalRxd } from "../swapFlow";

const PHOTONS_PER_RXD = 100_000_000;

// Mainnet P2PKH addresses; `buildRoyaltyOutputs` builds real scripts from
// these, so they have to be valid.
const CREATOR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const SPLIT_A = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

function terms(overrides: Partial<RoyaltyTerms> = {}): RoyaltyTerms {
  return {
    enforced: true,
    bps: 500, // 5%
    address: CREATOR,
    minimum: 0,
    maximum: null,
    splits: [],
    ...overrides,
  };
}

describe("royaltyTotalRxd", () => {
  it("returns undefined when there is no royalty at all", () => {
    expect(royaltyTotalRxd(null, 10 * PHOTONS_PER_RXD)).toBeUndefined();
  });

  it("returns undefined for an advisory (unenforced) royalty", () => {
    // `acceptSwapOffer` only builds outputs when `enforced` — an unenforced
    // royalty costs the taker nothing, so showing one would overstate.
    expect(
      royaltyTotalRxd(terms({ enforced: false }), 10 * PHOTONS_PER_RXD)
    ).toBeUndefined();
  });

  it("computes a straight percentage of the sale price, in RXD", () => {
    expect(royaltyTotalRxd(terms(), 10 * PHOTONS_PER_RXD)).toBe(0.5);
  });

  it("applies the minimum floor", () => {
    // 5% of 1 RXD = 0.05, floored up to the 0.2 RXD minimum.
    expect(
      royaltyTotalRxd(
        terms({ minimum: 0.2 * PHOTONS_PER_RXD }),
        1 * PHOTONS_PER_RXD
      )
    ).toBe(0.2);
  });

  it("applies the maximum ceiling", () => {
    // 5% of 1000 RXD = 50, capped at 1 RXD.
    expect(
      royaltyTotalRxd(
        terms({ maximum: 1 * PHOTONS_PER_RXD }),
        1000 * PHOTONS_PER_RXD
      )
    ).toBe(1);
  });

  it("sums every split, so the total is what the taker actually pays", () => {
    // Two recipients splitting the same 5% total must still add up to 5%.
    const total = royaltyTotalRxd(
      terms({
        splits: [
          { address: CREATOR, bps: 300 },
          { address: SPLIT_A, bps: 200 },
        ],
      }),
      10 * PHOTONS_PER_RXD
    );
    expect(total).toBe(0.5);
  });

  it("loses nothing to split rounding on an indivisible amount", () => {
    // The builder gives the remainder to the last split; the displayed total
    // must equal the sum of the real outputs, not a re-derived percentage.
    const price = 3333;
    const total = royaltyTotalRxd(
      terms({
        bps: 300,
        splits: [
          { address: CREATOR, bps: 100 },
          { address: SPLIT_A, bps: 200 },
        ],
      }),
      price
    );
    // floor(3333 * 300 / 10000) = 99 photons, split 33 / 66.
    expect(total).toBe(99 / PHOTONS_PER_RXD);
  });

  it("returns undefined when the computed amount rounds down to zero", () => {
    // Dust-priced sale: no output would be built, so nothing is owed.
    expect(royaltyTotalRxd(terms({ bps: 1 }), 100)).toBeUndefined();
  });

  it("propagates a bad payout address so callers can flag it as unknown", () => {
    // `previewSwapAccept` catches this and sets `royaltyUnknown`, rather than
    // reporting a misleading zero.
    expect(() =>
      royaltyTotalRxd(terms({ address: "not-an-address" }), 10 * PHOTONS_PER_RXD)
    ).toThrow();
  });
});
