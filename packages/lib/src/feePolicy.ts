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
 *
 * DELIBERATELY A MAINNET-ONLY SCALAR, NOT NETWORK-DERIVED. Testnet and regtest
 * floors are 10x lower (LEGACY_MIN_RELAY_FEE_RATE), so on those networks the
 * wallet overpays 10x. That is a considered trade, not an oversight:
 *
 *  - The error is one-directional and safe. Overpaying is always accepted;
 *    UNDERpaying is what gets a transaction rejected. Deriving the floor from a
 *    network value adds a way to underpay on MAINNET if that value is ever
 *    unset, stale, or resolved late — trading a harmless overpay on worthless
 *    coins for a real failure on real money.
 *  - The cost is only paid where money is not. Mainnet, the only network with
 *    value at stake, is exactly the network this constant is correct for.
 *  - Threading a network through `normalizeFeeRate` would mean threading it
 *    through `fundTx` and `buildTx` too — every signature on the swap fill
 *    path, whose guards are load-bearing and regtest-proven.
 *
 * Revisit if the wallet ever needs to build fee-sensitive transactions on a
 * non-mainnet network (e.g. a testnet faucet under fee pressure). Xetch's
 * swap/feePolicy is network-aware because its test gate RUNS on regtest, where
 * a 10x overpay would distort what the gate proves; Photonic's does not.
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
