/**
 * Unified market model.
 *
 * Photonic has two on-chain sell mechanisms that the unified Market hub presents
 * side by side:
 *   - 'swap'    — RSWP atomic swap offers (maker pre-signs a partial tx; taker
 *                 completes). Discovered globally via RXinDexer `swap.get_orders`.
 *                 Filled by deep-linking into the per-token Open Orders book
 *                 (which fetches the fillable offer from the node `-swapindex`).
 *   - 'royalty' — royalty-covenant listings (the covenant script enforces price +
 *                 creator royalty on-chain; no maker signature). Filled inline via
 *                 buildRoyaltyPurchaseTx. Discovered locally today (db.covenant +
 *                 shareable descriptor); cross-seller discovery via the indexer
 *                 royalty index lands in a later stage.
 *
 * This module is the seam: a discriminated union + pure mappers so the hub UI is
 * mechanism-agnostic. The per-row badge falls straight out of the `kind` tag.
 */
import Outpoint, { reverseRef } from "@lib/Outpoint";
import type {
  SwapOpenOrder,
  RoyaltyIndexListing,
} from "@app/electrum/worker/electrumWorker";
import type { CovenantRecord, CovenantRoyaltyTerms } from "@app/types";
import type { ListingDescriptor } from "@app/covenant";
import { swapIndexRefToRef } from "@app/swapBroadcast";

export type MarketMechanism = "swap" | "royalty";

// ───────────────────────── swap-index ref helpers ──────────────────────────
// The swap index reports the RXD side of an order as an all-zero ref
// ("000…000_0"), not null — so a naive ref check would treat RXD as a bogus
// token. Centralised here so the Browse view and the Market hub agree.
const ZERO_TXID = "0".repeat(64);

export function isRxdRef(displayRef: string | null): boolean {
  return !displayRef || displayRef.startsWith(ZERO_TXID);
}

/** The display ref of a side iff it is a real token (else null for RXD). */
export function tokenRefOrNull(displayRef: string | null): string | null {
  return isRxdRef(displayRef) ? null : displayRef;
}

/**
 * The 72-hex token ref to land on when opening a swap listing. Prefer the
 * offered token; fall back to the wanted token. Either side is enough to surface
 * the order in the per-token Open Orders book (it searches both sides).
 */
export function swapTokenSideRef(o: SwapOpenOrder): string | null {
  return (
    swapIndexRefToRef(tokenRefOrNull(o.base_ref)) ||
    swapIndexRefToRef(tokenRefOrNull(o.quote_ref))
  );
}

// ───────────────────────────── unified listing ─────────────────────────────
export interface UnifiedSwapListing {
  kind: "swap";
  key: string;
  mechanism: "swap";
  order: SwapOpenOrder;
  /** 72-hex ref of the token side, for the Open Orders deep-link (null = RXD↔RXD). */
  tokenRef72: string | null;
  baseRef: string | null; // display form, RXD-normalised to null
  quoteRef: string | null;
  side: "buy" | "sell";
  status: string;
  height: number;
}

export interface UnifiedRoyaltyListing {
  kind: "royalty";
  key: string;
  mechanism: "royalty";
  ref: string; // BE display form (matches SmartToken.ref)
  name?: string;
  price: number;
  royaltyTotal: number;
  sellerAddress: string;
  covenantUtxo: { txid: string; vout: number; script: string; value: number };
  descriptor: ListingDescriptor;
  /** True when sourced from this wallet's own local tracking (db.covenant). */
  mine: boolean;
  status: string;
  height?: number;
}

export type UnifiedListing = UnifiedSwapListing | UnifiedRoyaltyListing;

export function royaltyTotal(terms?: CovenantRoyaltyTerms): number {
  return terms?.royalties.reduce((a, r) => a + (r.value || 0), 0) ?? 0;
}

export function swapKey(o: SwapOpenOrder): string {
  return o.order_id || `${o.tx_hash}:${o.vout}`;
}

export function royaltyKey(u: {
  covenantUtxo: { txid: string; vout: number };
}): string {
  return `${u.covenantUtxo.txid}:${u.covenantUtxo.vout}`;
}

/** Map a swap-index order to a unified row. */
export function swapOrderToListing(o: SwapOpenOrder): UnifiedSwapListing {
  return {
    kind: "swap",
    key: swapKey(o),
    mechanism: "swap",
    order: o,
    tokenRef72: swapTokenSideRef(o),
    baseRef: tokenRefOrNull(o.base_ref),
    quoteRef: tokenRefOrNull(o.quote_ref),
    side: o.side,
    status: o.status,
    height: o.height,
  };
}

/** Map a shareable/indexer royalty descriptor to a unified row. */
export function royaltyFromDescriptor(
  d: ListingDescriptor,
  opts: { mine?: boolean; height?: number } = {}
): UnifiedRoyaltyListing {
  return {
    kind: "royalty",
    key: royaltyKey({ covenantUtxo: d.covenantUtxo }),
    mechanism: "royalty",
    ref: d.ref,
    name: d.name,
    price: d.terms.price,
    royaltyTotal: royaltyTotal(d.terms),
    sellerAddress: d.terms.sellerAddress,
    covenantUtxo: d.covenantUtxo,
    descriptor: d,
    mine: opts.mine ?? false,
    status: "active",
    height: opts.height,
  };
}

/** Map a royalty listing discovered via the RXinDexer royalty index to a unified
 *  row. The indexer gives the raw LE ref (`ref_le`, the covenant/nftScript form,
 *  used for `terms.ref`) and the covenant script, so a buyer can purchase with no
 *  off-chain descriptor. The display ref (BE, for glyph lookup) is `reverseRef(ref_le)`. */
export function royaltyFromIndexer(
  rec: RoyaltyIndexListing
): UnifiedRoyaltyListing | null {
  if (
    !rec.ref_le ||
    !rec.txid ||
    !rec.covenant_script ||
    !rec.seller_address ||
    !rec.seller_script
  ) {
    return null;
  }
  const refBE = reverseRef(rec.ref_le); // display / glyph-lookup form (g.ref)
  const descriptor: ListingDescriptor = {
    ref: refBE,
    covenantUtxo: {
      txid: rec.txid,
      vout: rec.vout,
      script: rec.covenant_script,
      value: rec.value,
    },
    terms: {
      ref: rec.ref_le, // LE form the covenant + buildRoyaltyPurchaseTx expect
      sellerAddress: rec.seller_address,
      sellerScript: rec.seller_script,
      price: rec.price,
      royalties: rec.royalties.map((r) => ({ script: r.script, value: r.value })),
    },
  };
  return royaltyFromDescriptor(descriptor, { mine: false, height: rec.height });
}

/** Map a locally-tracked royalty covenant record to a unified row. */
export function royaltyFromCovenant(
  cov: CovenantRecord,
  name?: string
): UnifiedRoyaltyListing | null {
  if (!cov.terms) return null;
  const descriptor: ListingDescriptor = {
    ref: cov.ref,
    name,
    covenantUtxo: {
      txid: cov.txid,
      vout: cov.vout,
      script: cov.script,
      value: cov.value,
    },
    terms: cov.terms,
  };
  return royaltyFromDescriptor(descriptor, { mine: true });
}

/** Stable identity for an NFT ref, used to dedupe across sources. */
export function shortRef(displayRef: string): string {
  try {
    return Outpoint.fromString(displayRef).shortRef();
  } catch {
    const sep = displayRef.indexOf("_");
    const head = sep > 0 ? displayRef.slice(0, sep) : displayRef;
    return `${head.slice(0, 8)}…${head.slice(-4)}`;
  }
}
