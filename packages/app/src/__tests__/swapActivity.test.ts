/**
 * Regression guard: a successful swap must be recorded as a SUCCESS.
 *
 * The bug this catches: `pages/SwapLoad.tsx` broadcast a COMPLETED swap and
 * then wrote `description: "rxd_swap_cancel"` to `db.broadcast`, which
 * `activity.ts` maps to a red "Swap Cancelled". `pages/OpenOrders.tsx`
 * broadcast an order-book fill and wrote no row at all. Meanwhile `rxd_swap`
 * ("Swap Completed", green) was defined in `activity.ts` and emitted by
 * nothing — dead code. Net effect: every successful swap was either invisible
 * or displayed to the user as a red cancellation.
 *
 * These tests exercise the REAL `swapActivity.ts` functions that both
 * completion paths now call (not a reconstruction of them), plus the REAL
 * `classifyActivity` that renders the result, so the description string and
 * its rendering are pinned end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import db from "@app/db";
import {
  broadcastSwapCompletion,
  broadcastSwapCancellation,
  SWAP_COMPLETED,
  SWAP_CANCELLED,
} from "@app/swapActivity";
import { classifyActivity } from "@app/activity";

const mockBroadcast = vi.fn();

vi.mock("@app/electrum/Electrum", () => ({
  electrumWorker: { value: { broadcast: (raw: string) => mockBroadcast(raw) } },
}));

// `db` is mocked globally in __tests__/setup.ts; `db.broadcast.put` is a vi.fn().
const putMock = db.broadcast.put as unknown as ReturnType<typeof vi.fn>;

const RAW_TX = "0100000001deadbeef";
const TXID = "a".repeat(64);

beforeEach(() => {
  mockBroadcast.mockReset();
  putMock.mockReset();
  mockBroadcast.mockResolvedValue(TXID);
});

describe("swap completion is recorded as a completion", () => {
  it("broadcastSwapCompletion writes rxd_swap, not a cancellation", async () => {
    const txid = await broadcastSwapCompletion(RAW_TX);

    expect(mockBroadcast).toHaveBeenCalledWith(RAW_TX);
    expect(txid).toBe(TXID);
    expect(putMock).toHaveBeenCalledTimes(1);

    const row = putMock.mock.calls[0][0];
    expect(row.txid).toBe(TXID);
    expect(row.description).toBe(SWAP_COMPLETED);
    // The exact bug: a completed swap labelled as a cancellation.
    expect(row.description).not.toBe(SWAP_CANCELLED);
  });

  it("records nothing when the broadcast is rejected", async () => {
    mockBroadcast.mockRejectedValue(
      new Error("mandatory-script-verify-flag-failed")
    );

    await expect(broadcastSwapCompletion(RAW_TX)).rejects.toThrow();
    // A rejected transaction must never leave a "Swap Completed" row.
    expect(putMock).not.toHaveBeenCalled();
  });

  it("renders rxd_swap as a green completion, not a red cancellation", () => {
    const meta = classifyActivity(SWAP_COMPLETED);

    expect(meta.label).toBe("Swap Completed");
    expect(meta.color).toBe("green");
    expect(meta.category).toBe("swap");
    // Before the fix this string was emitted by nothing; assert it is reachable
    // and does not fall through to the substring fallback ("Swap Prepared").
    expect(meta.label).not.toBe("Swap Prepared");
  });
});

describe("genuine offer cancellation is still recorded as a cancellation", () => {
  it("broadcastSwapCancellation writes rxd_swap_cancel", async () => {
    await broadcastSwapCancellation(RAW_TX);

    const row = putMock.mock.calls[0][0];
    expect(row.description).toBe(SWAP_CANCELLED);
    expect(row.description).not.toBe(SWAP_COMPLETED);
  });

  it("renders rxd_swap_cancel as a red cancellation", () => {
    const meta = classifyActivity(SWAP_CANCELLED);

    expect(meta.label).toBe("Swap Cancelled");
    expect(meta.color).toBe("red");
  });

  it("keeps completion and cancellation distinguishable", () => {
    expect(SWAP_COMPLETED).not.toBe(SWAP_CANCELLED);
    expect(classifyActivity(SWAP_COMPLETED).label).not.toBe(
      classifyActivity(SWAP_CANCELLED).label
    );
  });
});
