import { describe, it, expect } from "vitest";
import { pushMinimal } from "../script";
import { runDaaBody } from "./_daaHarness";

// Harness fidelity proof. We validate the radiantjs script-VM harness against the
// LEGACY ASERT bytecode + its independent reference formula. The legacy builder
// no longer exists in script.ts (replaced in-place by ASERT-v2), so it is inlined
// here. Matching an algorithm that is COMPLETELY DIFFERENT from ASERT-v2 (integer
// power-of-2 stepper vs fractional) proves the harness faithfully executes scripts
// — so a pass in dmint-asert-v2-bytecode.test.ts is not a shared-bug coincidence.
//
// This is also the canonical record of the pre-2026-06-19 ASERT bytecode that the
// Glyph-miner old-vs-new detector must still recognise for already-deployed tokens.

const PUSH_MAX_TARGET = "08ffffffffffffff7f";
const PUSH_HALF_MAX_TARGET = "08ffffffffffffff3f";
const LEGACY_2MUL_STEP = [
  "7600a0", "63", "8c", "7c", "76", PUSH_HALF_MAX_TARGET, "a0", "63", "75",
  PUSH_MAX_TARGET, "67", "8d", "68", "7c", "68",
].join("");
const LEGACY_2DIV_STEP = ["7600a0", "63", "8c", "7c", "8e", "7c", "68"].join("");

function buildLegacyAsertBytecode(halfLife: number): string {
  const halfLifePush = pushMinimal(halfLife);
  return [
    "c5", "5279", "94", "5379", "94", halfLifePush, "96",
    "7654a0", "63", "7554", "68", "76548f", "9f", "63", "75548f", "68",
    "7600a0", "63",
    LEGACY_2MUL_STEP, LEGACY_2MUL_STEP, LEGACY_2MUL_STEP, LEGACY_2MUL_STEP, "75",
    "67", "76009f", "63", "8f",
    LEGACY_2DIV_STEP, LEGACY_2DIV_STEP, LEGACY_2DIV_STEP, LEGACY_2DIV_STEP, "75",
    "67", "75", "68", "68",
    "76519f", "63", "7551", "68",
  ].join("");
}

const MAX_TARGET = 0x7fffffffffffffffn;
function legacyAsert(
  oldTarget: bigint,
  lastTime: bigint,
  currentTime: bigint,
  targetTime: bigint,
  halfLife: bigint
): bigint {
  const excess = currentTime - lastTime - targetTime;
  let drift = excess / halfLife;
  if (drift > 4n) drift = 4n;
  if (drift < -4n) drift = -4n;
  let newTarget: bigint;
  if (drift > 0n) {
    newTarget = oldTarget << drift;
    if (newTarget > MAX_TARGET) newTarget = MAX_TARGET;
  } else if (drift < 0n) {
    newTarget = oldTarget >> -drift;
  } else {
    newTarget = oldTarget;
  }
  if (newTarget < 1n) newTarget = 1n;
  return newTarget;
}

describe("harness fidelity: legacy ASERT bytecode == legacy formula", () => {
  // Keep oldTarget below MAX/2 so the legacy power-of-2 shift can't overflow int64
  // (the legacy bytecode caps it; we validate the common, non-cap domain).
  const targets = [1n, 2n, 1000n, 1n << 20n, 1n << 40n, 1n << 55n];
  const halfLives = [1n, 5n, 30n, 1000n];
  const targetTimes = [10n, 60n];
  const gaps = [0n, 1n, 9n, 10n, 11n, 30n, 60n, 120n, 600n, -5n, -60n];

  it("matches across the input grid", () => {
    let checked = 0;
    for (const halfLife of halfLives) {
      const hex = buildLegacyAsertBytecode(Number(halfLife));
      for (const target of targets)
        for (const tt of targetTimes)
          for (const gap of gaps) {
            const lastTime = 1_000_000n;
            const currentTime = lastTime + gap;
            const expected = legacyAsert(target, lastTime, currentTime, tt, halfLife);
            const got = runDaaBody(hex, target, lastTime, currentTime, tt);
            expect(got, `hl=${halfLife} t=${target} tt=${tt} gap=${gap}`).toBe(
              expected
            );
            checked++;
          }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
