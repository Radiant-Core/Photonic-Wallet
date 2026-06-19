import { describe, it, expect } from "vitest";
import { buildAsertDaaBytecode } from "../script";
import { computeAsertV2Target, ASERT_V2_MAX_TARGET_DIV4 } from "../dmintDaaV2";
import { runDaaBody } from "./_daaHarness";

// Proves the on-chain ASERT-v2 bytecode computes EXACTLY what the TypeScript
// reference (computeAsertV2Target) does — across the full reachable input domain.
// The harness is validated against the legacy bytecode in _daaHarnessValidate.test.ts,
// so a pass here means the bytecode logic matches the reference. radiantd on
// regtest remains the final consensus gate, but ASERT-v2 provably never overflows
// int64, so radiantjs (unbounded bignum) and radiantd agree on every case here.
describe("ASERT-v2 bytecode == reference across the domain", () => {
  const targets = [
    1n,
    2n,
    1000n,
    65535n,
    65536n,
    1n << 30n,
    1n << 45n,
    ASERT_V2_MAX_TARGET_DIV4 / 2n,
    ASERT_V2_MAX_TARGET_DIV4 - 1n,
    ASERT_V2_MAX_TARGET_DIV4,
    ASERT_V2_MAX_TARGET_DIV4 + 1n, // above cap → pulled to DIV4
    0x7fffffffffffffffn, // MAX_TARGET, above cap
  ];
  const halfLives = [1n, 5n, 30n, 40n, 240n, 1000n, 65536n];
  const targetTimes = [1n, 10n, 60n, 600n];
  const gaps = [
    0n, 1n, 2n, 5n, 9n, 10n, 11n, 15n, 20n, 30n, 60n, 120n, 600n, 100000n,
    -1n, -10n, -60n, -100000n,
  ];

  it("matches computeAsertV2Target for every (target, halfLife, targetTime, gap)", () => {
    let checked = 0;
    let mismatches = 0;
    const firstFew: string[] = [];
    for (const halfLife of halfLives) {
      const hex = buildAsertDaaBytecode(Number(halfLife));
      for (const target of targets)
        for (const tt of targetTimes)
          for (const gap of gaps) {
            const lastTime = 1_500_000n;
            const currentTime = lastTime + gap;
            const expected = computeAsertV2Target(
              target,
              lastTime,
              currentTime,
              tt,
              halfLife
            );
            const got = runDaaBody(hex, target, lastTime, currentTime, tt);
            if (got !== expected) {
              mismatches++;
              if (firstFew.length < 5) {
                firstFew.push(
                  `hl=${halfLife} t=${target} tt=${tt} gap=${gap}: got ${got} want ${expected}`
                );
              }
            }
            checked++;
          }
    }
    expect(firstFew, firstFew.join("\n")).toEqual([]);
    expect(mismatches).toBe(0);
    expect(checked).toBeGreaterThan(1000);
  });
});
