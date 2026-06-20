import { describe, it, expect } from "vitest";
import { buildLinearDaaBytecode } from "../script";
import {
  computeLwmaV2Target,
  computeAsertV2Target,
  ASERT_V2_MAX_TARGET,
  ASERT_V2_MAX_TARGET_DIV4,
} from "../dmintDaaV2";
import { runDaaBody } from "./_daaHarness";

// Difficulty is MAX_TARGET / target.
const diff = (target: bigint) => Number(ASERT_V2_MAX_TARGET / target);

describe("LWMA-v2 reference (damped fractional single-sample)", () => {
  const targetTime = 10n;

  it("equals ASERT-v2 with halfLife = targetTime (the defining identity)", () => {
    for (const t of [ASERT_V2_MAX_TARGET_DIV4 / 1000n, 1000n, ASERT_V2_MAX_TARGET_DIV4]) {
      for (const gap of [0n, 5n, 10n, 11n, 20n, 100n, -50n]) {
        expect(computeLwmaV2Target(t, 0n, gap, targetTime)).toBe(
          computeAsertV2Target(t, 0n, gap, targetTime, targetTime)
        );
      }
    }
  });

  it("no dead zone: a 1s deviation moves the target both ways", () => {
    const t0 = ASERT_V2_MAX_TARGET_DIV4 / 1000n;
    expect(computeLwmaV2Target(t0, 0n, 11n, targetTime)).toBeGreaterThan(t0); // slow → ease
    expect(computeLwmaV2Target(t0, 0n, 9n, targetTime)).toBeLessThan(t0); // fast → harden
  });

  it("on-target block leaves target unchanged", () => {
    const t0 = ASERT_V2_MAX_TARGET_DIV4 / 777n;
    expect(computeLwmaV2Target(t0, 0n, targetTime, targetTime)).toBe(t0);
  });

  it("damps a 2×-target block to +25% (old LWMA would have doubled the target)", () => {
    const t0 = ASERT_V2_MAX_TARGET_DIV4 / 1000n;
    // delta = 2×target ⇒ excess = targetTime ⇒ driftFp = RADIX ⇒ clamped to +RADIX/4
    const out = computeLwmaV2Target(t0, 0n, 2n * targetTime, targetTime);
    expect(out).toBeLessThanOrEqual((t0 * 5n) / 4n + 2n);
    expect(out).toBeGreaterThan(t0);
  });

  it("damps a 0-delta block to -25% (old LWMA slammed target to 1 ⇒ max difficulty)", () => {
    const t0 = ASERT_V2_MAX_TARGET_DIV4 / 1000n;
    const out = computeLwmaV2Target(t0, 0n, 0n, targetTime);
    expect(out).toBeGreaterThanOrEqual((t0 * 3n) / 4n - 2n);
    expect(diff(out)).toBeGreaterThan(diff(t0)); // difficulty rose, but only ~33%
  });

  it("converges toward target under a closed loop (no oscillation)", () => {
    // solve time ≈ C / target; equilibrium target = C / targetTime.
    const Tstar = ASERT_V2_MAX_TARGET_DIV4 / 5000n;
    const C = Tstar * targetTime;
    let target = Tstar * 4n; // start 4× too easy (blocks 4× too fast)
    let lastTime = 0n,
      clock = 0n;
    const times: number[] = [];
    for (let i = 0; i < 80; i++) {
      const bt = C / target;
      clock += bt > 0n ? bt : 1n;
      target = computeLwmaV2Target(target, lastTime, clock, targetTime);
      lastTime = clock;
      times.push(Number(bt > 0n ? bt : 1n));
    }
    const tail = times.slice(-10);
    const avg = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(avg).toBeGreaterThan(7);
    expect(avg).toBeLessThan(13);
  });

  it("stays in [1, MAX/4] across the input domain", () => {
    const targets = [1n, 1000n, 65536n, ASERT_V2_MAX_TARGET_DIV4, ASERT_V2_MAX_TARGET];
    const gaps = [-100000n, -60n, 0n, 10n, 100000n];
    const tts = [1n, 10n, 60n, 600n];
    for (const target of targets)
      for (const gap of gaps)
        for (const tt of tts) {
          const out = computeLwmaV2Target(target, 0n, gap, tt);
          expect(out).toBeGreaterThanOrEqual(1n);
          expect(out).toBeLessThanOrEqual(ASERT_V2_MAX_TARGET_DIV4);
        }
  });
});

describe("LWMA-v2 bytecode == reference across the domain", () => {
  const targets = [
    1n,
    1000n,
    65535n,
    65536n,
    1n << 40n,
    ASERT_V2_MAX_TARGET_DIV4 - 1n,
    ASERT_V2_MAX_TARGET_DIV4,
    ASERT_V2_MAX_TARGET_DIV4 + 1n,
    ASERT_V2_MAX_TARGET,
  ];
  const targetTimes = [1n, 10n, 60n, 600n];
  const gaps = [
    0n, 1n, 5n, 9n, 10n, 11n, 20n, 60n, 120n, 600n, 100000n, -1n, -60n, -100000n,
  ];

  it("matches computeLwmaV2Target for every (target, targetTime, gap)", () => {
    const hex = buildLinearDaaBytecode();
    let checked = 0;
    const mismatches: string[] = [];
    for (const target of targets)
      for (const tt of targetTimes)
        for (const gap of gaps) {
          const lastTime = 1_500_000n;
          const currentTime = lastTime + gap;
          const expected = computeLwmaV2Target(target, lastTime, currentTime, tt);
          const got = runDaaBody(hex, target, lastTime, currentTime, tt);
          if (got !== expected && mismatches.length < 5) {
            mismatches.push(`t=${target} tt=${tt} gap=${gap}: got ${got} want ${expected}`);
          }
          checked++;
        }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
    expect(checked).toBeGreaterThan(400);
  });

  it("emits the v2 LWMA signature, not the legacy unity-gain stepper", () => {
    const hex = buildLinearDaaBytecode();
    // common prefix + RADIX push + OP_MUL, then OP_3 PICK targetTime + OP_DIV.
    expect(hex).toContain("c5527994537994" + "03000001" + "95" + "5379" + "96");
    // legacy markers (delta cap "5379 54 95 a3", floor "00 a4") must be gone.
    expect(hex).not.toContain("a300a4");
  });
});
