/**
 * Fee-rate policy for Photonic Wallet.
 *
 * The numbers here mirror Radiant Core's relay-policy constants so that any
 * transaction the wallet builds will be accepted by an up-to-date node.
 *
 * Canonical source: `Radiant-Core/src/policy/policy.h` lines 47–49:
 *
 *     LEGACY_MIN_RELAY_TX_FEE_PER_KB      = 1_000_000 sats/kB  (=  1_000 photons/byte)
 *     DEFAULT_MIN_RELAY_TX_FEE_PER_KB     = 1_000_000 sats/kB
 *     RADIANT_CORE_2_MIN_RELAY_TX_FEE_PER_KB = 10_000_000 sats/kB (= 10_000 photons/byte)
 *
 * The Radiant Core 2.0 upgrade (V2 hard fork, mainnet block 410_000) raised the
 * min relay fee to 10x the legacy value. A 5_000-block grace period (~1 week)
 * after activation let the legacy floor continue to apply, then the new floor
 * takes over. Mainnet has been past the grace period for many months — any
 * transaction broadcast today must clear 10_000 photons/byte to be relayed.
 *
 * 1 photon = 1 satoshi-equivalent (Radiant base unit). 1 RXD = 100_000_000 photons.
 */

/** Pre-V2 (legacy) minimum relay fee rate, in photons/byte. Kept for reference. */
export const LEGACY_MIN_RELAY_FEE_RATE = 1_000;

/**
 * Post-V2 minimum relay fee rate enforced by Radiant Core nodes, in photons/byte.
 *
 * Any transaction built with an effective rate below this will be rejected
 * with "min relay fee not met" by mainnet nodes. The wallet clamps caller-
 * provided rates up to this value at every action boundary.
 */
export const MIN_RELAY_FEE_RATE = 10_000;

/**
 * Upper sanity bound used by the wallet's internal `feeCheck`. Transactions
 * paying more than 1.2x this rate trip the "Failed fee check" guard, which
 * exists to catch unit-confusion bugs (e.g. accidentally paying sats/kB as
 * photons/byte) rather than as a policy limit.
 *
 * Chosen as 2x the network floor: comfortably above the typical user-set rate
 * but well below "absurdly high" territory.
 */
export const MAX_REASONABLE_FEE_RATE = 2 * MIN_RELAY_FEE_RATE;

/**
 * Clamp a fee rate to the network minimum. Use this at every transaction-
 * building entry point that accepts a user-supplied rate.
 *
 * Returns MIN_RELAY_FEE_RATE for non-finite, negative, or zero inputs.
 */
export function normalizeFeeRate(feeRate: number): number {
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    return MIN_RELAY_FEE_RATE;
  }
  return Math.max(MIN_RELAY_FEE_RATE, feeRate);
}
