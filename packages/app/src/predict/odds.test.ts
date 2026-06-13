import { describe, it, expect } from "vitest";
import {
  orderProbability,
  orderYesProbability,
  deriveMarketOdds,
  bestDirectAsk,
  type OrderRow,
} from "./odds";

const N = 100_000_000; // 1 RXD nominal share, in photons

/** Build an order at YES/NO probability `p` for a share of `amount` photons:
 *  price = (1 + p)·amount (carrier floor `amount` + premium `p·amount`). */
function at(
  kind: "ask" | "bid",
  side: "yes" | "no",
  p: number,
  amount = N,
  extra: Partial<OrderRow> = {}
): OrderRow {
  return { kind, side, amount, priceSats: Math.round((1 + p) * amount), ...extra };
}

describe("orderProbability (carrier floor)", () => {
  it("maps price = 1.64·amount to 0.64", () => {
    expect(orderProbability(164_000_000, N)).toBeCloseTo(0.64, 6);
  });
  it("clamps the always-recoverable floor to 0 and a full 1-RXD claim to 1", () => {
    expect(orderProbability(N, N)).toBe(0); // price == carrier floor
    expect(orderProbability(2 * N, N)).toBe(1); // floor + full claim
    expect(orderProbability(N / 2, N)).toBe(0); // below floor clamps to 0
  });
});

describe("orderYesProbability (NO reflection)", () => {
  it("returns a YES order's own probability unchanged", () => {
    expect(orderYesProbability(at("ask", "yes", 0.7))).toBeCloseTo(0.7, 6);
  });
  it("reflects a NO order to 1 − pNo", () => {
    expect(orderYesProbability(at("ask", "no", 0.3))).toBeCloseTo(0.7, 6);
    expect(orderYesProbability(at("bid", "no", 0.25))).toBeCloseTo(0.75, 6);
  });
});

describe("deriveMarketOdds", () => {
  it("returns 'none' for an empty book", () => {
    expect(deriveMarketOdds([])).toEqual({
      yesProb: null,
      bestYesAsk: null,
      bestYesBid: null,
      mid: null,
      spread: null,
      source: "none",
    });
  });

  it("computes mid/spread from native YES asks and bids", () => {
    const o = deriveMarketOdds([
      at("ask", "yes", 0.66), // sell YES @ 0.66  → buy-yes liquidity
      at("ask", "yes", 0.65), // cheaper ask wins
      at("bid", "yes", 0.61), // buy YES @ 0.61   → sell-yes liquidity
      at("bid", "yes", 0.63), // higher bid wins
    ]);
    expect(o.bestYesAsk).toBeCloseTo(0.65, 6);
    expect(o.bestYesBid).toBeCloseTo(0.63, 6);
    expect(o.mid).toBeCloseTo(0.64, 6);
    expect(o.spread).toBeCloseTo(0.02, 6);
    expect(o.yesProb).toBeCloseTo(0.64, 6);
    expect(o.source).toBe("mid");
  });

  it("folds NO orders into the YES book via reflection", () => {
    // A NO ask @ 0.30 reflects to a YES BID @ 0.70; a NO bid @ 0.28 reflects to a YES ASK @ 0.72.
    const o = deriveMarketOdds([
      at("ask", "no", 0.3), // → YES bid @ 0.70
      at("bid", "no", 0.28), // → YES ask @ 0.72
    ]);
    expect(o.bestYesBid).toBeCloseTo(0.7, 6);
    expect(o.bestYesAsk).toBeCloseTo(0.72, 6);
    expect(o.mid).toBeCloseTo(0.71, 6);
    expect(o.spread).toBeCloseTo(0.02, 6);
    expect(o.source).toBe("mid");
  });

  it("takes the best across native YES and reflected NO on each side", () => {
    const o = deriveMarketOdds([
      at("ask", "yes", 0.7), // YES ask @ 0.70
      at("bid", "no", 0.32), // → YES ask @ 0.68 (better/cheaper)
      at("bid", "yes", 0.6), // YES bid @ 0.60
      at("ask", "no", 0.35), // → YES bid @ 0.65 (better/higher)
    ]);
    expect(o.bestYesAsk).toBeCloseTo(0.68, 6);
    expect(o.bestYesBid).toBeCloseTo(0.65, 6);
  });

  it("falls back to a single side when only asks (or only bids) exist", () => {
    const askOnly = deriveMarketOdds([at("ask", "yes", 0.55)]);
    expect(askOnly.source).toBe("ask");
    expect(askOnly.yesProb).toBeCloseTo(0.55, 6);
    expect(askOnly.spread).toBeNull();

    const bidOnly = deriveMarketOdds([at("bid", "yes", 0.45)]);
    expect(bidOnly.source).toBe("bid");
    expect(bidOnly.yesProb).toBeCloseTo(0.45, 6);
  });
});

describe("bestDirectAsk", () => {
  it("picks the cheapest direct ask for the side and excludes own orders", () => {
    const mine = at("ask", "yes", 0.6, N, { makerAddress: "me", adTxid: "mine" });
    const cheap = at("ask", "yes", 0.64, N, { makerAddress: "alice", adTxid: "cheap" });
    const dear = at("ask", "yes", 0.7, N, { makerAddress: "bob", adTxid: "dear" });
    const noSide = at("ask", "no", 0.3, N, { makerAddress: "carol", adTxid: "no" });
    const bid = at("bid", "yes", 0.5, N, { makerAddress: "dave", adTxid: "bid" });

    const best = bestDirectAsk([mine, cheap, dear, noSide, bid], "yes", "me");
    expect(best?.adTxid).toBe("cheap"); // 'mine' excluded though it is cheaper
  });

  it("returns null when no fillable ask exists for the side", () => {
    expect(bestDirectAsk([at("bid", "yes", 0.5)], "yes")).toBeNull();
    expect(bestDirectAsk([at("ask", "no", 0.3)], "yes")).toBeNull();
  });
});
