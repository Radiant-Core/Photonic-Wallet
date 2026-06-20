/**
 * dMint ASERT-v2 difficulty adjustment — fractional, symmetric, damped.
 *
 * WHY THIS EXISTS
 * ---------------
 * The original on-chain "ASERT" (buildAsertDaaBytecode in script.ts) computes
 *   drift = (timeDelta - targetTime) / halfLife        // INTEGER, truncates toward 0
 *   target *= 2^drift                                   // drift clamped to [-4,+4]
 * Three structural defects make it unable to regulate block time (see the
 * 2026-06-19 DAA review):
 *   1. Dead zone — for |timeDelta - targetTime| < halfLife, drift truncates to 0
 *      → no adjustment at all. For a 10s target with halfLife=30, ANY gap in
 *      0–39s leaves difficulty unchanged.
 *   2. One-sided — raising difficulty (negative drift) needs
 *      timeDelta <= targetTime - halfLife, which is < 0 (impossible) whenever
 *      halfLife >= targetTime. So difficulty can only ratchet DOWN or freeze.
 *   3. Power-of-2 bang-bang — when it does move it lurches >=2x off a single
 *      miner-chosen nLockTime sample, with no averaging.
 *
 * ASERT-v2 replaces the integer power-of-2 stepper with a FRACTIONAL fixed-point
 * step computed in the same int64 domain the script VM enforces. It reuses the
 * divide-first + MAX_TARGET/4 cap pattern already proven for LWMA
 * (buildLinearDaaBytecode), so the same difficulty floor of 4 applies.
 *
 *   RADIX = 2^16  (fixed-point scale)
 *   excess   = (currentTime - lastTime) - targetTime          // signed seconds
 *   driftFp  = (excess * RADIX) / halfLife                     // = drift * 2^16, signed
 *   driftFp  = clamp(driftFp, -RADIX/4, +RADIX/4)              // ±25%/block damping
 *   t        = min(oldTarget, MAX_TARGET/4)                    // headroom + diff floor 4
 *   delta    = (t / RADIX) * driftFp                           // signed, divide-first
 *   newTarget= clamp(t + delta, 1, MAX_TARGET/4)
 *
 * PROPERTIES
 *   - No dead zone: driftFp is non-zero for any |excess| >= halfLife/RADIX seconds
 *     (i.e. >= ~1s for any halfLife <= RADIX).
 *   - Symmetric: driftFp is signed; difficulty rises on fast blocks AND falls on
 *     slow blocks regardless of halfLife vs targetTime.
 *   - Fine-grained + damped: each block moves the target by at most ±25%
 *     (driftFp clamp), proportional to how far off-target the block was — no
 *     ≥2x lurches, so it converges instead of oscillating.
 *
 * OVERFLOW SAFETY (every intermediate stays within int64, |x| <= 2^63 - 1):
 *   - currentTime, lastTime are tx nLockTimes (uint32, <= ~4.3e9), so
 *     |excess| <= ~4.3e9 and |excess * RADIX| <= ~2.8e14  < 2^63.
 *   - halfLife >= 1 (deploy-time enforced) → the OP_DIV is safe and never /0.
 *   - |driftFp| <= RADIX/4 = 2^14 after the clamp.
 *   - t <= MAX_TARGET/4 = 2^61, so t/RADIX <= 2^45 and
 *     |delta| = |(t/RADIX) * driftFp| <= 2^45 * 2^14 = 2^59  < 2^63.
 *   - |t + delta| <= 2^61 + 2^59 ≈ 2.88e18  < 2^63 - 1.
 *
 * CONSENSUS NOTE: this TypeScript reference is the single source of truth that
 * BOTH the on-chain bytecode (buildAsertV2DaaBytecode) and the miner mirror
 * (Glyph-miner computeAsertV2Target) must reproduce bit-for-bit. radiantjs
 * cannot validate the bytecode (it uses unbounded bignum and does not enforce
 * the int64 range-abort), so equivalence MUST be confirmed on regtest against
 * radiantd before any mainnet deploy.
 */

export const ASERT_V2_RADIX = 65536n; // 2^16
export const ASERT_V2_MAX_TARGET = 0x7fffffffffffffffn; // 2^63 - 1
export const ASERT_V2_MAX_TARGET_DIV4 = ASERT_V2_MAX_TARGET >> 2n; // 0x1FFF_FFFF_FFFF_FFFF
/** Per-block fractional-drift clamp: ±RADIX/4 ⇒ target moves at most ±25%/block. */
export const ASERT_V2_DRIFT_FP_CLAMP = ASERT_V2_RADIX >> 2n; // 16384

/**
 * Compute the ASERT-v2 next target. Pure integer (bigint) arithmetic mirroring
 * exactly what the on-chain bytecode and the miner must compute.
 *
 * @param oldTarget   current contract target (1 .. MAX_TARGET)
 * @param lastTime    previous mint's recorded nLockTime (seconds)
 * @param currentTime this mint's nLockTime (seconds)
 * @param targetTime  desired seconds between mints
 * @param halfLife    responsiveness divisor (seconds of excess per unit drift); >= 1
 */
export function computeAsertV2Target(
  oldTarget: bigint,
  lastTime: bigint,
  currentTime: bigint,
  targetTime: bigint,
  halfLife: bigint
): bigint {
  if (halfLife < 1n) {
    // Deploy-time validation forbids this; guard so the reference never divides
    // by zero. The bytecode bakes a >=1 constant so this branch is unreachable
    // on-chain.
    halfLife = 1n;
  }

  const excess = currentTime - lastTime - targetTime; // signed seconds
  let driftFp = (excess * ASERT_V2_RADIX) / halfLife; // = drift * 2^16, truncates toward 0

  if (driftFp > ASERT_V2_DRIFT_FP_CLAMP) driftFp = ASERT_V2_DRIFT_FP_CLAMP;
  if (driftFp < -ASERT_V2_DRIFT_FP_CLAMP) driftFp = -ASERT_V2_DRIFT_FP_CLAMP;

  const t =
    oldTarget > ASERT_V2_MAX_TARGET_DIV4 ? ASERT_V2_MAX_TARGET_DIV4 : oldTarget;

  // divide-first so the multiply can never overflow int64 (see header proof).
  const delta = (t / ASERT_V2_RADIX) * driftFp;
  let newTarget = t + delta;

  if (newTarget > ASERT_V2_MAX_TARGET_DIV4) newTarget = ASERT_V2_MAX_TARGET_DIV4;
  if (newTarget < 1n) newTarget = 1n;
  return newTarget;
}

/**
 * LWMA-v2 reference — the damped fractional single-sample retarget used by the
 * on-chain `lwma` mode (buildLinearDaaBytecode). It is exactly computeAsertV2Target
 * with the responsiveness gain auto-set to targetTime instead of a separate
 * halfLife knob, so a 2×-target block hits the ±25%/block clamp. Mirrors the
 * on-chain bytecode and the Glyph-miner computeLinearV2Target bit-for-bit.
 *
 *   driftFp = (excess * RADIX) / targetTime   // gain = 1/targetTime (vs 1/halfLife)
 *
 * Same int64 overflow proof as ASERT-v2 (targetTime ≥ 1 is deploy-enforced, so the
 * OP_DIV is safe and never /0).
 */
export function computeLwmaV2Target(
  oldTarget: bigint,
  lastTime: bigint,
  currentTime: bigint,
  targetTime: bigint
): bigint {
  // targetTime is the divisor; deploy validation guarantees targetTime ≥ 1, but
  // guard the reference so it never divides by zero.
  const tt = targetTime < 1n ? 1n : targetTime;
  return computeAsertV2Target(oldTarget, lastTime, currentTime, tt, tt);
}
