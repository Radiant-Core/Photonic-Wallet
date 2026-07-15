/**
 * Royalty terms as recorded in an NFT's Glyph metadata, and the payout outputs
 * they imply for a swap completion.
 *
 * This lived as a byte-identical copy in BOTH takers — pages/SwapLoad.tsx (the
 * PSRT paste flow) and pages/OpenOrders.tsx (the order-book fill) — down to the
 * split-allocation loop and a third private copy of `computeRoyaltyAmount`
 * (which royaltyCovenant.ts already exported, explicitly so that "listing
 * builders compute R identically to the swap-completion path"). Two copies of a
 * money split is two chances to drift: fix a rounding bug in one and the other
 * silently keeps paying the old amount. It lives here once now.
 *
 * SCOPE — this is the ADVISORY royalty path. In a PSRT swap the maker signs
 * only output[0] (SIGHASH_SINGLE) and the NFT sits in a plain `nftScript`, so
 * nothing on-chain forces these outputs: a hostile taker can simply omit them.
 * For UNSTRIPPABLE, consensus-enforced royalty the seller must list via the
 * royalty covenant (./royaltyCovenant: buildRoyaltyListingTx /
 * buildRoyaltyPurchaseTx), which makes the payouts a spend condition.
 *
 * Position is NOT decided here: `buildSwapCompletionOutputs` (./swapOutputs)
 * places these at index 2+, after the maker payment at index 0 that the maker's
 * signature commits to.
 */
import { p2pkhScript } from "./script";
import { computeRoyaltyAmount } from "./royaltyCovenant";
import { UnfinalizedOutput } from "./types";

export type RoyaltySplit = { address: string; bps: number };

export type RoyaltyTerms = {
  /** Whether the creator marked the royalty as enforced. Callers gate on this. */
  enforced: boolean;
  /** Total royalty, in basis points of the sale price. */
  bps: number;
  /** Default payout address, used when there are no `splits`. */
  address: string;
  /** Floor for the computed amount, in photons. */
  minimum: number;
  /** Ceiling for the computed amount, in photons; null = uncapped. */
  maximum: number | null;
  /** Optional recipients, splitting the total by their own bps. */
  splits: RoyaltySplit[];
};

/** Thrown when royalty terms cannot be turned into payable outputs. */
export class RoyaltyTermsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoyaltyTermsError";
  }
}

/**
 * `p2pkhScript` THROWS on an unusable address (it does not return "" — the
 * copies this was lifted from both guarded with `if (!script) throw …`, which
 * was dead code, so a bad royalty address surfaced a raw
 * "p2pkhScript: invalid address …" instead). Translate it into a
 * RoyaltyTermsError naming the offending recipient.
 */
function royaltyPayoutScript(address: string, label: string): string {
  try {
    return p2pkhScript(address);
  } catch (err) {
    throw new RoyaltyTermsError(
      `${label}: ${JSON.stringify(address)} (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
}

/**
 * Read royalty terms out of a decoded Glyph payload, tolerating anything.
 *
 * The payload is third-party data (it rides the mint CBOR), so every field is
 * validated rather than trusted; returns null if there is no usable royalty.
 */
export function parseRoyalty(payload: unknown): RoyaltyTerms | null {
  if (!payload || typeof payload !== "object") return null;
  const royalty = (payload as { royalty?: unknown }).royalty;
  if (!royalty || typeof royalty !== "object") return null;

  const r = royalty as {
    enforced?: unknown;
    bps?: unknown;
    address?: unknown;
    minimum?: unknown;
    maximum?: unknown;
    splits?: unknown;
  };

  const enforced = r.enforced === true;
  const bps = typeof r.bps === "number" ? r.bps : NaN;
  const address = typeof r.address === "string" ? r.address : "";
  const minimum = typeof r.minimum === "number" ? r.minimum : 0;
  const maximum = typeof r.maximum === "number" ? r.maximum : null;

  const splits: RoyaltySplit[] = Array.isArray(r.splits)
    ? (r.splits
        .map((s) => {
          if (!s || typeof s !== "object") return null;
          const so = s as { address?: unknown; bps?: unknown };
          const a = typeof so.address === "string" ? so.address : "";
          const b = typeof so.bps === "number" ? so.bps : NaN;
          if (!a || !Number.isFinite(b)) return null;
          return { address: a, bps: b };
        })
        .filter(Boolean) as RoyaltySplit[])
    : [];

  if (!Number.isFinite(bps) || bps <= 0 || bps > 10000) return null;
  if (!address) return null;

  return { enforced, bps, address, minimum, maximum, splits };
}

/**
 * Build the royalty payout outputs for a sale at `salePrice` photons.
 *
 * The total is `computeRoyaltyAmount` (floor(price*bps/10000), clamped to
 * minimum/maximum). With `splits`, each recipient gets
 * `floor(total * split.bps / royalty.bps)` and the LAST recipient takes the
 * remainder — so the parts always sum to exactly the total and no photon is
 * created or lost to rounding. Without splits, the whole total goes to
 * `royalty.address`.
 *
 * Returns [] when the computed royalty rounds to zero (nothing to pay).
 * Throws RoyaltyTermsError if a recipient address is unusable — better to fail
 * the swap than to silently drop a creator's payout. Both takers surface that
 * message to the user (OpenOrders via its catch, SwapLoad via its
 * TransferError/SwapError/RoyaltyTermsError branch).
 */
export function buildRoyaltyOutputs(
  royalty: RoyaltyTerms,
  salePrice: number
): UnfinalizedOutput[] {
  const totalRoyalty = computeRoyaltyAmount(
    salePrice,
    royalty.bps,
    royalty.minimum,
    royalty.maximum
  );

  if (totalRoyalty <= 0) return [];

  const outputs: UnfinalizedOutput[] = [];

  if (royalty.splits.length > 0) {
    // Allocate split amounts deterministically. Last split receives remainder.
    let remaining = totalRoyalty;
    for (let i = 0; i < royalty.splits.length; i++) {
      const split = royalty.splits[i];
      const isLast = i === royalty.splits.length - 1;
      const amt = isLast
        ? remaining
        : Math.floor((totalRoyalty * split.bps) / royalty.bps);
      remaining -= amt;
      if (amt > 0) {
        const script = royaltyPayoutScript(
          split.address,
          "Invalid royalty split address"
        );
        outputs.push({ script, value: amt });
      }
    }
  } else {
    const script = royaltyPayoutScript(
      royalty.address,
      "Invalid royalty address"
    );
    outputs.push({ script, value: totalRoyalty });
  }

  return outputs;
}
