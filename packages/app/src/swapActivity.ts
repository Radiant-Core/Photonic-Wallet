/**
 * Swap activity recording.
 *
 * Every swap transaction the wallet broadcasts must land in `db.broadcast`
 * with a `description` that says what actually happened, because that string
 * is the ONLY thing `activity.ts classifyActivity` has to work with when it
 * renders the history page and the notification surfaces.
 *
 * Broadcasting and recording are paired here rather than left to each call
 * site. Previously both were open-coded: `pages/SwapLoad.tsx` broadcast a
 * COMPLETED swap and then wrote `"rxd_swap_cancel"`, so every filled offer
 * rendered as a red "Swap Cancelled"; `pages/OpenOrders.tsx` broadcast a fill
 * and wrote nothing at all, so it left no history row. Routing both through
 * `broadcastSwapCompletion` means the completion path has no description
 * constant for a call site to get wrong.
 */
import db from "@app/db";
import { electrumWorker } from "@app/electrum/Electrum";

/**
 * A swap that settled: the taker's transaction confirmed the trade. Maps to
 * "Swap Completed" (green) in `activity.ts`.
 */
export const SWAP_COMPLETED = "rxd_swap";

/**
 * A swap OFFER the maker revoked by self-spending the reserved UTXO. Maps to
 * "Swap Cancelled" (red). This is NOT a completed trade.
 *
 * HISTORICAL ROWS ARE DELIBERATELY NOT BACKFILLED. Swaps completed via
 * SwapLoad before this fix are already on record as `rxd_swap_cancel`, which
 * is the same string genuine cancellations write, so the local database cannot
 * tell the two apart — separating them would mean refetching every historical
 * swap txid and re-deriving its shape from chain (a cancel returns the
 * reserved UTXO to the wallet's own address; a completion pays a third-party
 * maker at output[0]). That is unavailable offline and, if it guessed wrong,
 * would relabel a genuine cancellation as a completed trade — a new false
 * entry on a money-history surface, strictly worse than the current
 * conservative-but-wrong label. The mislabelling is display-only: balances and
 * UTXO state are derived from chain, not from these rows. Only rows written
 * from this commit forward are correct.
 */
export const SWAP_CANCELLED = "rxd_swap_cancel";

/**
 * Broadcast a completed (filled) swap and record it as a completion.
 *
 * Used by both completion paths — the PSRT paste flow (`pages/SwapLoad.tsx`)
 * and the order-book fill (`pages/OpenOrders.tsx`). Returns the txid.
 *
 * The record is written only after the broadcast resolves, so a rejected
 * transaction never produces a "Swap Completed" row.
 */
export async function broadcastSwapCompletion(rawTx: string): Promise<string> {
  const txid = await electrumWorker.value.broadcast(rawTx);
  await db.broadcast.put({
    txid,
    date: Date.now(),
    description: SWAP_COMPLETED,
  });
  return txid;
}

/**
 * Broadcast a swap-offer cancellation and record it as a cancellation.
 *
 * Only for the maker revoking their own offer (`swap.ts cancelSwap`), never
 * for a settled trade.
 */
export async function broadcastSwapCancellation(
  rawTx: string
): Promise<string> {
  const txid = await electrumWorker.value.broadcast(rawTx);
  await db.broadcast.put({
    txid,
    date: Date.now(),
    description: SWAP_CANCELLED,
  });
  return txid;
}
