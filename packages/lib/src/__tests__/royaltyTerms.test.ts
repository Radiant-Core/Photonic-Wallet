/**
 * Guards for the shared royalty terms / split-allocation logic.
 *
 * This logic was a byte-identical copy in pages/SwapLoad.tsx and
 * pages/OpenOrders.tsx (1851 chars each, including a third private copy of
 * computeRoyaltyAmount) and had NO tests in either home. It splits a creator's
 * money, so the load-bearing invariant is CONSERVATION: the parts must sum to
 * exactly the computed total — never create or lose a photon to rounding — and
 * both takers must pay a creator identically.
 */
import { describe, it, expect } from "vitest";
import {
  buildRoyaltyOutputs,
  parseRoyalty,
  RoyaltyTerms,
  RoyaltyTermsError,
} from "../royaltyTerms";
import { computeRoyaltyAmount } from "../royaltyCovenant";
import { p2pkhScript } from "../script";

// Known-valid mainnet P2PKH addresses, as used by the other lib tests.
const ADDR = {
  creator: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  a: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
  b: "12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX",
};

const terms = (over: Partial<RoyaltyTerms> = {}): RoyaltyTerms => ({
  enforced: true,
  bps: 1000, // 10%
  address: ADDR.creator,
  minimum: 0,
  maximum: null,
  splits: [],
  ...over,
});

const PRICE = 7_000_000; // photons

describe("buildRoyaltyOutputs — no splits", () => {
  it("pays the whole royalty to the creator address", () => {
    const outputs = buildRoyaltyOutputs(terms(), PRICE);

    expect(outputs).toHaveLength(1);
    expect(outputs[0].script).toBe(p2pkhScript(ADDR.creator));
    expect(outputs[0].value).toBe(700_000); // 10% of 7,000,000
  });

  it("returns no outputs when the royalty rounds to zero", () => {
    // 1 bps of 999 photons = floor(0.0999) = 0 → nothing to pay.
    expect(buildRoyaltyOutputs(terms({ bps: 1 }), 999)).toEqual([]);
  });

  it("honours the minimum floor", () => {
    const outputs = buildRoyaltyOutputs(
      terms({ bps: 1, minimum: 50_000 }),
      999
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0].value).toBe(50_000);
  });

  it("honours the maximum ceiling", () => {
    const outputs = buildRoyaltyOutputs(terms({ maximum: 100_000 }), PRICE);
    expect(outputs[0].value).toBe(100_000); // clamped down from 700_000
  });
});

describe("buildRoyaltyOutputs — splits conserve the total exactly", () => {
  it("splits evenly and sums to the total", () => {
    const t = terms({
      splits: [
        { address: ADDR.a, bps: 500 },
        { address: ADDR.b, bps: 500 },
      ],
    });
    const total = computeRoyaltyAmount(PRICE, t.bps, t.minimum, t.maximum);
    const outputs = buildRoyaltyOutputs(t, PRICE);

    expect(outputs.map((o) => o.value)).toEqual([350_000, 350_000]);
    expect(outputs.reduce((s, o) => s + o.value, 0)).toBe(total);
  });

  it("gives the remainder to the LAST split so no photon is lost", () => {
    // 3 equal splits of a total that does not divide by 3.
    const t = terms({
      bps: 1000,
      splits: [
        { address: ADDR.a, bps: 333 },
        { address: ADDR.b, bps: 333 },
        { address: ADDR.creator, bps: 334 },
      ],
    });
    const price = 1_000_001;
    const total = computeRoyaltyAmount(price, t.bps, t.minimum, t.maximum);
    const outputs = buildRoyaltyOutputs(t, price);

    // Conservation: this is the whole point of the last-takes-remainder rule.
    expect(outputs.reduce((s, o) => s + o.value, 0)).toBe(total);
    // Every part is a whole photon.
    for (const o of outputs) expect(Number.isInteger(o.value)).toBe(true);
  });

  it("conserves the total across many awkward price/bps combinations", () => {
    const t = terms({
      bps: 777,
      splits: [
        { address: ADDR.a, bps: 111 },
        { address: ADDR.b, bps: 333 },
        { address: ADDR.creator, bps: 333 },
      ],
    });

    for (const price of [
      1,
      999,
      1_000_001,
      7_000_003,
      123_456_789,
      2 ** 40 + 7,
    ]) {
      const total = computeRoyaltyAmount(price, t.bps, t.minimum, t.maximum);
      const outputs = buildRoyaltyOutputs(t, price);
      const sum = outputs.reduce((s, o) => s + o.value, 0);
      // Either nothing is payable, or the parts sum to exactly the total.
      expect(sum).toBe(total === 0 ? 0 : total);
    }
  });

  it("skips zero-value splits but still pays the full total", () => {
    // A split whose share floors to 0 must not create a dust output, and the
    // last split must still absorb everything left over.
    const t = terms({
      bps: 10000,
      splits: [
        { address: ADDR.a, bps: 1 }, // floor(10 * 1/10000) = 0
        { address: ADDR.b, bps: 9999 },
      ],
    });
    const price = 10;
    const total = computeRoyaltyAmount(price, t.bps, t.minimum, t.maximum);
    const outputs = buildRoyaltyOutputs(t, price);

    expect(outputs.every((o) => o.value > 0)).toBe(true);
    expect(outputs.reduce((s, o) => s + o.value, 0)).toBe(total);
  });

  it("pays each split recipient at their own address", () => {
    const t = terms({
      splits: [
        { address: ADDR.a, bps: 500 },
        { address: ADDR.b, bps: 500 },
      ],
    });
    const outputs = buildRoyaltyOutputs(t, PRICE);
    expect(outputs.map((o) => o.script)).toEqual([
      p2pkhScript(ADDR.a),
      p2pkhScript(ADDR.b),
    ]);
  });
});

describe("buildRoyaltyOutputs — unusable addresses fail loudly", () => {
  it("throws RoyaltyTermsError for a bad split address", () => {
    const t = terms({
      splits: [
        { address: ADDR.a, bps: 500 },
        { address: "not-an-address", bps: 500 },
      ],
    });
    expect(() => buildRoyaltyOutputs(t, PRICE)).toThrow(RoyaltyTermsError);
    expect(() => buildRoyaltyOutputs(t, PRICE)).toThrow(
      /Invalid royalty split address/
    );
  });

  it("throws RoyaltyTermsError for a bad creator address", () => {
    const t = terms({ address: "not-an-address" });
    expect(() => buildRoyaltyOutputs(t, PRICE)).toThrow(RoyaltyTermsError);
    expect(() => buildRoyaltyOutputs(t, PRICE)).toThrow(
      /Invalid royalty address/
    );
  });

  it("never silently drops a creator payout", () => {
    // The failure mode that matters: returning [] (paying nobody) instead of
    // throwing would let the swap complete royalty-free.
    const t = terms({ address: "not-an-address" });
    let threw = false;
    try {
      buildRoyaltyOutputs(t, PRICE);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("parseRoyalty", () => {
  it("reads well-formed royalty metadata", () => {
    const parsed = parseRoyalty({
      royalty: {
        enforced: true,
        bps: 500,
        address: ADDR.creator,
        minimum: 10,
        maximum: 1000,
        splits: [{ address: ADDR.a, bps: 500 }],
      },
    });
    expect(parsed).toEqual({
      enforced: true,
      bps: 500,
      address: ADDR.creator,
      minimum: 10,
      maximum: 1000,
      splits: [{ address: ADDR.a, bps: 500 }],
    });
  });

  it("rejects payloads with no usable royalty", () => {
    expect(parseRoyalty(null)).toBeNull();
    expect(parseRoyalty({})).toBeNull();
    expect(parseRoyalty({ royalty: null })).toBeNull();
    expect(parseRoyalty({ royalty: { bps: 500 } })).toBeNull(); // no address
    expect(
      parseRoyalty({ royalty: { bps: 0, address: ADDR.creator } })
    ).toBeNull();
    expect(
      parseRoyalty({ royalty: { bps: 10001, address: ADDR.creator } })
    ).toBeNull(); // >100%
    expect(
      parseRoyalty({ royalty: { bps: "500", address: ADDR.creator } })
    ).toBeNull();
  });

  it("defaults enforced to false and drops malformed splits", () => {
    const parsed = parseRoyalty({
      royalty: {
        bps: 500,
        address: ADDR.creator,
        splits: [{ address: ADDR.a, bps: 500 }, { address: "" }, 42, null],
      },
    });
    expect(parsed?.enforced).toBe(false);
    expect(parsed?.splits).toEqual([{ address: ADDR.a, bps: 500 }]);
    expect(parsed?.minimum).toBe(0);
    expect(parsed?.maximum).toBeNull();
  });
});
