import { describe, it, expect } from "vitest";
import {
  computeAsertV2Target,
  ASERT_V2_MAX_TARGET,
  ASERT_V2_MAX_TARGET_DIV4,
  ASERT_V2_RADIX,
} from "../dmintDaaV2";

// Difficulty is MAX_TARGET / target. Lower target ⇒ higher difficulty.
const diff = (target: bigint) => Number(ASERT_V2_MAX_TARGET / target);

// Deterministic PRNG (mulberry32) so the noisy convergence test is reproducible.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("ASERT-v2 dMint DAA reference", () => {
  const targetTime = 10n; // the operator's 10s token
  const halfLife = 40n; // ~4×targetTime, the sweet spot

  describe("1. no dead zone (the core bug)", () => {
    it("a block even 1s off-target moves the target (with halfLife <= RADIX)", () => {
      const t0 = ASERT_V2_MAX_TARGET_DIV4 / 1000n; // mid-range
      // 11s block (1s slow) — old ASERT: drift=(11-10)/40=0 → frozen. v2 must move.
      const slow = computeAsertV2Target(t0, 0n, 11n, targetTime, halfLife);
      expect(slow).not.toBe(t0);
      expect(slow).toBeGreaterThan(t0); // slow → ease → target up
      // 9s block (1s fast) — must harden.
      const fast = computeAsertV2Target(t0, 0n, 9n, targetTime, halfLife);
      expect(fast).toBeLessThan(t0); // fast → harden → target down
    });

    it("on-target block (excess=0) leaves target EXACTLY unchanged", () => {
      const t0 = ASERT_V2_MAX_TARGET_DIV4 / 777n;
      expect(computeAsertV2Target(t0, 0n, targetTime, targetTime, halfLife)).toBe(
        t0
      );
    });
  });

  describe("2. symmetry — works even when halfLife >= targetTime (old bug)", () => {
    // Old ASERT could NOT raise difficulty when halfLife >= targetTime.
    it("fast blocks raise difficulty (lower target) for halfLife >> targetTime", () => {
      const t0 = ASERT_V2_MAX_TARGET_DIV4 / 500n;
      let t = t0;
      for (let i = 0n; i < 5n; i++) {
        t = computeAsertV2Target(t, 0n, 5n, targetTime, 100n); // 5s blocks, halfLife=100
      }
      expect(t).toBeLessThan(t0); // difficulty went UP — impossible under old ASERT
      expect(diff(t)).toBeGreaterThan(diff(t0));
    });

    it("slow blocks lower difficulty (raise target) for halfLife >> targetTime", () => {
      const t0 = ASERT_V2_MAX_TARGET_DIV4 / 500n;
      let t = t0;
      for (let i = 0n; i < 5n; i++) {
        t = computeAsertV2Target(t, 0n, 25n, targetTime, 100n);
      }
      expect(t).toBeGreaterThan(t0);
    });
  });

  describe("3. damping — no >2x bang-bang lurches", () => {
    it("a single extreme-slow block moves target by at most ~+25%", () => {
      const t0 = ASERT_V2_MAX_TARGET_DIV4 / 1000n;
      const t = computeAsertV2Target(t0, 0n, 100_000n, targetTime, halfLife); // huge gap
      // clamp caps driftFp at RADIX/4 ⇒ factor ≤ 1.25
      expect(t).toBeLessThanOrEqual((t0 * 5n) / 4n + 2n);
      expect(t).toBeGreaterThan(t0);
    });

    it("a single extreme-fast block moves target by at most ~-25%", () => {
      const t0 = ASERT_V2_MAX_TARGET_DIV4 / 1000n;
      const t = computeAsertV2Target(t0, 0n, 0n, targetTime, halfLife); // delta = -10
      expect(t).toBeGreaterThanOrEqual((t0 * 3n) / 4n - 2n);
      expect(t).toBeLessThan(t0);
    });
  });

  describe("4. convergence — realized block time approaches target", () => {
    // Closed loop: solve time ≈ C / target (more target = easier = faster).
    // Equilibrium target T* = C / targetTime.
    function simulate(opts: {
      startTarget: bigint;
      C: bigint;
      blocks: number;
      noise?: number;
      seed?: number;
    }) {
      const { startTarget, C, blocks } = opts;
      const rand = rng(opts.seed ?? 1);
      let target = startTarget;
      let lastTime = 0n;
      let clock = 0n;
      const blockTimes: number[] = [];
      for (let i = 0; i < blocks; i++) {
        let bt = C / target; // deterministic component
        if (opts.noise) {
          // multiply by a factor in [1-noise, 1+noise]
          const f = 1 + (rand() * 2 - 1) * opts.noise;
          bt = BigInt(Math.max(1, Math.round(Number(bt) * f)));
        }
        if (bt < 1n) bt = 1n;
        clock += bt;
        const next = computeAsertV2Target(
          target,
          lastTime,
          clock,
          targetTime,
          halfLife
        );
        lastTime = clock;
        target = next;
        blockTimes.push(Number(bt));
      }
      return blockTimes;
    }

    it("converges from 8x-too-slow toward ~target within 60 blocks", () => {
      // Equilibrium target chosen mid-range; start 8x harder (blocks 8x slow).
      const Tstar = ASERT_V2_MAX_TARGET_DIV4 / 5000n;
      const C = Tstar * targetTime; // so blockTime(Tstar) == targetTime
      const bts = simulate({ startTarget: Tstar / 8n, C, blocks: 60 });
      const tail = bts.slice(-10);
      const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
      expect(avg).toBeGreaterThan(7); // within ~30% of 10s
      expect(avg).toBeLessThan(13);
    });

    it("converges from 8x-too-fast toward ~target within 60 blocks", () => {
      const Tstar = ASERT_V2_MAX_TARGET_DIV4 / 5000n;
      const C = Tstar * targetTime;
      const bts = simulate({ startTarget: Tstar * 8n, C, blocks: 60 });
      const tail = bts.slice(-10);
      const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
      expect(avg).toBeGreaterThan(7);
      expect(avg).toBeLessThan(13);
    });

    it("stays near target under ±40% per-block noise (no runaway oscillation)", () => {
      const Tstar = ASERT_V2_MAX_TARGET_DIV4 / 5000n;
      const C = Tstar * targetTime;
      const bts = simulate({
        startTarget: Tstar,
        C,
        blocks: 400,
        noise: 0.4,
        seed: 12345,
      });
      const tail = bts.slice(-200);
      const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
      // Mean block time should hold near the 10s target despite noise.
      expect(avg).toBeGreaterThan(8);
      expect(avg).toBeLessThan(12.5);
    });
  });

  describe("5. overflow safety + range across the input domain", () => {
    const targets = [
      1n,
      2n,
      1000n,
      ASERT_V2_RADIX - 1n,
      ASERT_V2_RADIX,
      ASERT_V2_MAX_TARGET_DIV4 - 1n,
      ASERT_V2_MAX_TARGET_DIV4,
      ASERT_V2_MAX_TARGET_DIV4 + 1n,
      ASERT_V2_MAX_TARGET, // above the cap — must be pulled into range
    ];
    const deltas = [
      -4_000_000_000n, -100_000n, -100n, -1n, 0n, 1n, 100n, 100_000n,
      4_000_000_000n,
    ];
    const halfLives = [1n, 5n, 40n, 1000n, 65536n];
    const tt = [1n, 10n, 60n, 600n];

    it("every output is in [1, MAX_TARGET/4] and never throws", () => {
      for (const target of targets)
        for (const d of deltas)
          for (const hl of halfLives)
            for (const time of tt) {
              const out = computeAsertV2Target(target, 0n, d, time, hl);
              expect(out).toBeGreaterThanOrEqual(1n);
              expect(out).toBeLessThanOrEqual(ASERT_V2_MAX_TARGET_DIV4);
              // int64 invariant the script VM enforces
              expect(out).toBeLessThanOrEqual(ASERT_V2_MAX_TARGET);
            }
    });

    it("halfLife=0 is guarded (no divide-by-zero)", () => {
      expect(() =>
        computeAsertV2Target(1000n, 0n, 50n, 10n, 0n)
      ).not.toThrow();
    });

    it("negative timeDelta (nLockTime moved backward) hardens, stays >= 1", () => {
      const t0 = ASERT_V2_MAX_TARGET_DIV4 / 1000n;
      const out = computeAsertV2Target(t0, 100n, 50n, 10n, 40n); // delta = -60
      expect(out).toBeLessThan(t0);
      expect(out).toBeGreaterThanOrEqual(1n);
    });
  });

  describe("6. monotonicity of response", () => {
    it("slower blocks ⇒ strictly-not-lower target than faster blocks", () => {
      const t0 = ASERT_V2_MAX_TARGET_DIV4 / 1000n;
      let prev = 0n;
      for (const gap of [0n, 5n, 10n, 15n, 20n, 40n, 100n]) {
        const out = computeAsertV2Target(t0, 0n, gap, targetTime, halfLife);
        expect(out).toBeGreaterThanOrEqual(prev);
        prev = out;
      }
    });
  });
});
