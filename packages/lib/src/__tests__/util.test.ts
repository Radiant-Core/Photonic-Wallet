import { describe, it, expect } from "vitest";
import { shuffle, unbiasedRandomInt } from "../util";

describe("unbiasedRandomInt", () => {
  it("rejects non-positive or non-integer max", () => {
    expect(() => unbiasedRandomInt(0)).toThrow();
    expect(() => unbiasedRandomInt(-1)).toThrow();
    expect(() => unbiasedRandomInt(1.5)).toThrow();
    expect(() => unbiasedRandomInt(Number.NaN)).toThrow();
  });

  it("returns 0 for max=1", () => {
    for (let i = 0; i < 10; i++) {
      expect(unbiasedRandomInt(1)).toBe(0);
    }
  });

  it("returns values strictly in [0, max)", () => {
    const max = 7;
    for (let i = 0; i < 1000; i++) {
      const r = unbiasedRandomInt(max);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(max);
      expect(Number.isInteger(r)).toBe(true);
    }
  });

  it("produces a roughly uniform distribution over a small range", () => {
    // 10 buckets, 10k draws → ~1000/bucket. Allow generous slack so the
    // test is robust to legitimate CSPRNG variance (no chi-squared fancy
    // stats — just a sanity bound).
    const buckets = new Array(10).fill(0) as number[];
    const N = 10_000;
    for (let i = 0; i < N; i++) buckets[unbiasedRandomInt(buckets.length)]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });
});

describe("shuffle", () => {
  it("preserves length and contents", () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const copy = [...original];
    const result = shuffle(copy);
    expect(result.length).toBe(original.length);
    expect([...result].sort((a, b) => a - b)).toEqual(original);
  });

  it("returns the same reference (in-place mutation)", () => {
    const arr = [1, 2, 3];
    expect(shuffle(arr)).toBe(arr);
  });

  it("handles edge cases (empty, single)", () => {
    expect(shuffle([])).toEqual([]);
    expect(shuffle([42])).toEqual([42]);
  });

  it("produces different orderings across repeated calls", () => {
    // Two independent shuffles of a 12-element array should almost never
    // agree — the probability they match is 1/12! ≈ 2e-9. Treat any
    // ten-trial run that never sees a difference as failure.
    const reference = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    let sawDifferent = false;
    for (let trial = 0; trial < 10; trial++) {
      const a = shuffle([...reference]);
      const b = shuffle([...reference]);
      if (a.some((v, i) => v !== b[i])) {
        sawDifferent = true;
        break;
      }
    }
    expect(sawDifferent).toBe(true);
  });

  it("each position sees every value across many trials (basic uniformity)", () => {
    // For an N-element array, position 0 should see each of the N values
    // roughly N×trials/N = trials times. We use a small N and a generous
    // tolerance to avoid flakiness.
    const N = 6;
    const trials = 6000;
    // counts[pos][value] = how often `value` landed at position `pos`.
    const counts: number[][] = Array.from({ length: N }, () =>
      new Array(N).fill(0)
    );
    for (let t = 0; t < trials; t++) {
      const arr = shuffle([0, 1, 2, 3, 4, 5]);
      for (let pos = 0; pos < N; pos++) counts[pos][arr[pos]]++;
    }
    const expected = trials / N; // 1000
    for (let pos = 0; pos < N; pos++) {
      for (let v = 0; v < N; v++) {
        // ±20% slack — well within CSPRNG variance for this sample size.
        expect(counts[pos][v]).toBeGreaterThan(expected * 0.8);
        expect(counts[pos][v]).toBeLessThan(expected * 1.2);
      }
    }
  });
});
