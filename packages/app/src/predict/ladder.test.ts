import { describe, it, expect } from "vitest";
import {
  splitLadder,
  priceSatsForProb,
  probForPriceSats,
  rungsForProb,
  rampProbs,
  slopedRungs,
} from "./ladder";

/** Every split must conserve BOTH totals exactly (shares are collateral-backed; price is what the
 *  maker receives) — any rounding leak would misprice or lose value. */
function assertConserves(shares: number, price: number, rungs: number) {
  const out = splitLadder(shares, price, rungs);
  expect(out).toHaveLength(rungs);
  expect(out.reduce((s, r) => s + r.amount, 0)).toBe(shares);
  expect(out.reduce((s, r) => s + r.priceSats, 0)).toBe(price);
  // same effective rate on every full rung except where the remainder lands
  expect(out.every((r) => r.amount > 0 && r.priceSats > 0)).toBe(true);
}

describe("splitLadder", () => {
  it("splits evenly when divisible", () => {
    expect(splitLadder(1000, 100, 4)).toEqual([
      { amount: 250, priceSats: 25 },
      { amount: 250, priceSats: 25 },
      { amount: 250, priceSats: 25 },
      { amount: 250, priceSats: 25 },
    ]);
  });

  it("puts the remainder on the last rung", () => {
    const out = splitLadder(1003, 103, 4);
    expect(out.slice(0, 3)).toEqual([
      { amount: 250, priceSats: 25 },
      { amount: 250, priceSats: 25 },
      { amount: 250, priceSats: 25 },
    ]);
    expect(out[3]).toEqual({ amount: 253, priceSats: 28 });
  });

  it("conserves both totals across many shapes", () => {
    for (const [shares, price, rungs] of [
      [1000, 100, 2],
      [999, 51, 2],
      [12_000_000, 7_200_000, 5],
      [100_000_001, 63_333_333, 7],
      [5460, 5460, 10], // exactly the dust floor per rung
    ] as const) {
      assertConserves(shares, price, rungs);
    }
  });
});

describe("carrier-inclusive probability pricing", () => {
  it("prices a share in [amount, 2·amount] as (1+prob)·amount", () => {
    expect(priceSatsForProb(1000, 0)).toBe(1000); // prob 0 → carrier floor only
    expect(priceSatsForProb(1000, 1)).toBe(2000); // prob 1 → full collateral
    expect(priceSatsForProb(1000, 0.62)).toBe(1620);
  });

  it("clamps probability to [0,1]", () => {
    expect(priceSatsForProb(1000, 1.5)).toBe(2000);
    expect(priceSatsForProb(1000, -0.3)).toBe(1000);
    expect(probForPriceSats(3000, 1000)).toBe(1); // above 2·amount clamps to 1
    expect(probForPriceSats(500, 1000)).toBe(0); // below amount clamps to 0
  });

  it("round-trips price ⇄ probability", () => {
    for (const p of [0, 0.05, 0.25, 0.5, 0.62, 0.9, 1]) {
      const shares = 12_345_678;
      const round = probForPriceSats(priceSatsForProb(shares, p), shares);
      expect(round).toBeCloseTo(p, 6);
    }
  });

  it("rungsForProb: amounts sum exactly, every rung implies the target probability", () => {
    const shares = 6_000_001;
    const rungs = rungsForProb(shares, 0.64, 3);
    expect(rungs).toHaveLength(3);
    expect(rungs.reduce((s, r) => s + r.amount, 0)).toBe(shares);
    for (const r of rungs) {
      expect(r.priceSats).toBe(priceSatsForProb(r.amount, 0.64));
      expect(probForPriceSats(r.priceSats, r.amount)).toBeCloseTo(0.64, 6);
    }
  });

  it("rampProbs steps linearly from start to end and clamps to [0,1]", () => {
    expect(rampProbs(0.58, 0.62, 3)).toEqual([0.58, 0.6, 0.62]);
    expect(rampProbs(0.5, 0.5, 4)).toEqual([0.5, 0.5, 0.5, 0.5]); // flat
    expect(rampProbs(0.3, 0.3, 1)).toEqual([0.3]);
    const r = rampProbs(0.9, 1.3, 3); // overshoot clamps
    expect(r[0]).toBeCloseTo(0.9, 6);
    expect(r[2]).toBe(1);
  });

  it("slopedRungs: sum-exact amounts, monotonically increasing implied probability", () => {
    const shares = 9_000_002;
    const probs = rampProbs(0.58, 0.62, 3);
    const rungs = slopedRungs(shares, probs);
    expect(rungs.reduce((s, r) => s + r.amount, 0)).toBe(shares);
    const implied = rungs.map((r) => probForPriceSats(r.priceSats, r.amount));
    expect(implied[0]).toBeCloseTo(0.58, 5);
    expect(implied[1]).toBeCloseTo(0.6, 5);
    expect(implied[2]).toBeCloseTo(0.62, 5);
    expect(implied[0]).toBeLessThan(implied[1]);
    expect(implied[1]).toBeLessThan(implied[2]);
  });
});
