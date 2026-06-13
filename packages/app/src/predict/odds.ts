/**
 * Unified YES order-book math for binary prediction markets.
 *
 * A YES/NO share of `amount` photons carries `amount` photons (the floor it always recovers) and
 * pays an EXTRA `amount` photons of collateral only if it wins, so it trades in [amount, 2·amount].
 * `impliedProbability` maps that range to [0,1]: p = (price − amount) / amount.
 *
 * YES and NO are quoted in two independent books. To present a single Polymarket/Kalshi-style YES
 * book we reflect every NO order via the complete-set identity — 1 YES + 1 NO ≡ 1 RXD, so
 * P(YES) + P(NO) = 1:
 *
 *   NO ask  @ qNo  ≡  YES bid @ (1 − qNo)   (you can SELL yes via merge-arb)
 *   NO bid  @ qNo  ≡  YES ask @ (1 − qNo)   (you can BUY  yes via mint-arb)
 *   YES ask @ pYes ≡  YES ask @ pYes        (unchanged)
 *   YES bid @ pYes ≡  YES bid @ pYes        (unchanged)
 */
import { impliedProbability } from "radiantswap";

/** The minimal order shape the odds math needs (structurally satisfied by IndexedAsk). */
export interface OrderRow {
  kind: "ask" | "bid";
  side: "yes" | "no";
  amount: number; // share photons
  priceSats: number; // RXD photons
  makerAddress?: string | null;
  adTxid?: string;
}

/** Probability implied by an order, expressed in terms of ITS OWN side, clamped to [0,1]. */
export function orderProbability(priceSats: number, amount: number): number {
  return impliedProbability(priceSats, amount, amount);
}

/** A row's probability re-expressed in YES terms (NO rows reflected: pYes = 1 − pNo). */
export function orderYesProbability(o: OrderRow): number {
  const own = orderProbability(o.priceSats, o.amount);
  return o.side === "yes" ? own : 1 - own;
}

/** Adds buy-YES (ask) liquidity? A native YES ask, or a reflected NO bid. */
function isYesAsk(o: OrderRow): boolean {
  return (o.side === "yes" && o.kind === "ask") || (o.side === "no" && o.kind === "bid");
}

/** Adds sell-YES (bid) liquidity? A native YES bid, or a reflected NO ask. */
function isYesBid(o: OrderRow): boolean {
  return (o.side === "yes" && o.kind === "bid") || (o.side === "no" && o.kind === "ask");
}

export interface MarketOdds {
  /** Headline P(YES) in [0,1] — mid when both sides quote, else the one available side, else null. */
  yesProb: number | null;
  bestYesAsk: number | null; // cheapest probability to BUY yes
  bestYesBid: number | null; // best probability to SELL yes
  mid: number | null;
  spread: number | null; // bestYesAsk − bestYesBid (can be < 0 on a crossed book)
  source: "mid" | "ask" | "bid" | "none";
}

/** Collapse a flat YES+NO order list into a unified YES view: best bid/ask, mid, spread, headline. */
export function deriveMarketOdds(orders: OrderRow[]): MarketOdds {
  let bestAsk: number | null = null;
  let bestBid: number | null = null;
  for (const o of orders) {
    const pYes = orderYesProbability(o);
    if (isYesAsk(o)) bestAsk = bestAsk === null ? pYes : Math.min(bestAsk, pYes);
    if (isYesBid(o)) bestBid = bestBid === null ? pYes : Math.max(bestBid, pYes);
  }
  let mid: number | null = null;
  let spread: number | null = null;
  let yesProb: number | null = null;
  let source: MarketOdds["source"] = "none";
  if (bestAsk !== null && bestBid !== null) {
    mid = (bestAsk + bestBid) / 2;
    spread = bestAsk - bestBid;
    yesProb = mid;
    source = "mid";
  } else if (bestAsk !== null) {
    yesProb = bestAsk;
    source = "ask";
  } else if (bestBid !== null) {
    yesProb = bestBid;
    source = "bid";
  }
  return { yesProb, bestYesAsk: bestAsk, bestYesBid: bestBid, mid, spread, source };
}

/** Cheapest fillable DIRECT ask (a maker selling shares) for `side`, excluding the user's own
 *  orders — the target a one-click "Buy YES/NO" fills. Returns null when no liquidity exists. */
export function bestDirectAsk<T extends OrderRow>(
  orders: T[],
  side: "yes" | "no",
  selfAddress?: string | null
): T | null {
  let best: T | null = null;
  let bestP = Infinity;
  for (const o of orders) {
    if (o.kind !== "ask" || o.side !== side) continue;
    if (selfAddress && o.makerAddress === selfAddress) continue;
    const p = orderProbability(o.priceSats, o.amount);
    if (p < bestP) {
      bestP = p;
      best = o;
    }
  }
  return best;
}
