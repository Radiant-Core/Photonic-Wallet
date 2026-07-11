/**
 * Pure order-ladder math (no chain/db deps, so it's unit-testable in isolation).
 *
 * RSWP sell orders are atomic all-or-nothing (SIGHASH_SINGLE|ANYONECANPAY commits the whole share
 * UTXO ↔ an exact payment), so a taker can't buy part of one order. To let buyers purchase PARTIAL
 * positions, the maker fans a position into k tranche UTXOs (`buildShareTranches`) and posts one
 * order per tranche; takers fill any subset. `splitLadder` computes those k rungs.
 */

/** Clamp a probability to [0, 1]. */
export const clampProb = (p: number): number => Math.max(0, Math.min(1, p));

/**
 * A YES/NO share of `shares` photons CARRIES `shares` photons (a floor the holder always recovers)
 * and pays an EXTRA `shares` photons of collateral only if it wins — so it trades in
 * [shares, 2·shares], and the market's implied probability is `(price − shares) / shares`
 * (see odds.ts). These two helpers convert between that carrier-inclusive price and a plain
 * probability so the UI can quote in %/probability instead of raw RXD.
 */
export function priceSatsForProb(shares: number, prob: number): number {
  return Math.round(shares * (1 + clampProb(prob)));
}
export function probForPriceSats(priceSats: number, shares: number): number {
  return shares > 0 ? clampProb((priceSats - shares) / shares) : 0;
}

/** `rungs` probabilities stepping linearly from `start` to `end` (inclusive), each clamped to [0,1].
 *  `start === end` (or rungs ≤ 1) gives a flat ladder. Used to build a SLOPED ladder — depth at
 *  several price levels, like a real order book — from a low/high (or center + step) pair. */
export function rampProbs(start: number, end: number, rungs: number): number[] {
  if (rungs <= 1) return [clampProb(start)];
  const step = (end - start) / (rungs - 1);
  return Array.from({ length: rungs }, (_, i) => clampProb(start + i * step));
}

/** Split `shares` into `probs.length` equal parts (remainder on the last) and price each at its own
 *  carrier-inclusive probability. This is the general ladder: pass equal probs for a flat book or a
 *  `rampProbs` array for sloped depth. A taker can buy any single rung (a partial position). */
export function slopedRungs(
  shares: number,
  probs: number[]
): { amount: number; priceSats: number }[] {
  const n = probs.length;
  const base = Math.floor(shares / n);
  const out: { amount: number; priceSats: number }[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const amount = i === n - 1 ? shares - sum : base;
    out.push({ amount, priceSats: priceSatsForProb(amount, probs[i]) });
    sum += amount;
  }
  return out;
}

/** Ladder rungs for a FLAT target probability — every rung implies the same probability. */
export function rungsForProb(
  shares: number,
  prob: number,
  rungs: number
): { amount: number; priceSats: number }[] {
  return slopedRungs(shares, Array.from({ length: rungs }, () => prob));
}

/** Split a whole position + its total ask price into `rungs` equal rungs (any remainder lands on the
 *  last rung) so every rung trades at the SAME effective per-share price — the ladder just lets a
 *  taker buy a fraction. The returned amounts sum to exactly `shares` and prices to exactly
 *  `priceSats` (both are value-conserving: shares are collateral-backed, price is the maker's payout). */
export function splitLadder(
  shares: number,
  priceSats: number,
  rungs: number
): { amount: number; priceSats: number }[] {
  const baseShares = Math.floor(shares / rungs);
  const basePrice = Math.floor(priceSats / rungs);
  const out: { amount: number; priceSats: number }[] = [];
  let sShares = 0;
  let sPrice = 0;
  for (let i = 0; i < rungs; i++) {
    const last = i === rungs - 1;
    const amount = last ? shares - sShares : baseShares;
    const price = last ? priceSats - sPrice : basePrice;
    out.push({ amount, priceSats: price });
    sShares += amount;
    sPrice += price;
  }
  return out;
}
