/**
 * Swap-offer expiry / staleness policy (client-side, Phase 1).
 *
 * Background — broadcast swap offers are Partially Signed Radiant Transactions
 * (PSRT) signed with `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` (see
 * `@lib/transfer` `partiallySigned`). That signature commits to nothing that
 * bounds its lifetime: there is no expiry and no per-offer revocation nonce, so
 * a published offer stays executable at the originally-signed price by anyone
 * who holds it until the maker self-spends the reserved UTXO to cancel it (see
 * `swap.ts` `cancelSwap`). A public offer advertised to the swap index is the
 * worst case: it remains fillable indefinitely at a stale price.
 *
 * Until the on-chain protocol gains a real expiry — RSWP v3 carrying an
 * `expiry_height` plus a timelocked-refund covenant on the reserved UTXO; see
 * `docs/swap-offer-expiry-cancellation.md` — the reference wallet applies a
 * *soft* expiry: offers older than a configurable window are treated as stale,
 * hidden from the public order book by default, and flagged before a taker
 * fills them.
 *
 * IMPORTANT — what soft expiry does and does NOT do. It binds cooperative
 * clients (this wallet) and the swap index (which already accepts an optional
 * `maxAge` filter on `getopenorders`). It does NOT bind an attacker who saved a
 * raw PSRT and broadcasts it directly to a node — for that, maker cancellation
 * (self-spending the reserved UTXO) remains the only hard revocation. Soft
 * expiry is defense-in-depth and taker protection, not a consensus guarantee.
 */

// Seconds per block used for human-readable age estimates. Matches the rough
// estimate already used in the Open Orders table.
export const SWAP_BLOCK_SECONDS = 600;

// Default soft-expiry window for broadcast offers, in blocks (~30 days at
// SWAP_BLOCK_SECONDS). Centralized here so a future maker-chosen, on-chain
// expiry (Phase 2) can override it per offer.
export const SWAP_OFFER_DEFAULT_MAX_AGE_BLOCKS = Math.round(
  (30 * 24 * 60 * 60) / SWAP_BLOCK_SECONDS
); // 4320

/**
 * Age of an offer in blocks given the current chain tip height. Returns null
 * when either height is unknown/invalid: a `blockHeight` of 0 means the index
 * has no confirmation height yet (e.g. an unconfirmed advertisement), and a
 * `currentHeight` of 0 means we could not query the index. We never invent an
 * age from missing data.
 */
export function offerAgeBlocks(
  blockHeight: number,
  currentHeight: number
): number | null {
  if (
    !Number.isFinite(blockHeight) ||
    !Number.isFinite(currentHeight) ||
    blockHeight <= 0 ||
    currentHeight <= 0 ||
    currentHeight < blockHeight
  ) {
    return null;
  }
  return currentHeight - blockHeight;
}

/**
 * Whether an offer is past the soft-expiry window. Unknown age (null) is treated
 * as NOT stale so we never hide offers we cannot date — the maker-cancel path is
 * the fail-safe, not over-aggressive hiding.
 */
export function isOfferStale(
  blockHeight: number,
  currentHeight: number,
  maxAgeBlocks: number = SWAP_OFFER_DEFAULT_MAX_AGE_BLOCKS
): boolean {
  const age = offerAgeBlocks(blockHeight, currentHeight);
  if (age === null) return false;
  return age > maxAgeBlocks;
}

/**
 * Human-readable age label, e.g. "3 days old", "5 hours old". Returns null when
 * the age cannot be determined (so callers can omit the label entirely).
 */
export function offerAgeLabel(
  blockHeight: number,
  currentHeight: number
): string | null {
  const age = offerAgeBlocks(blockHeight, currentHeight);
  if (age === null) return null;
  const seconds = age * SWAP_BLOCK_SECONDS;
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} old`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"} old`;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"} old`;
}
