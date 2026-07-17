/**
 * `requireUnlock` — the unlock-gate that replaces dead-end "Wallet locked"
 * error toasts with the password modal.
 *
 * Contract:
 *  - Locked wallet: opens the global unlock modal and, on a *successful*
 *    unlock, invokes the caller's `retry` so the action resumes. Returns
 *    `true` so the caller stops.
 *  - Locked wallet, user cancels: `retry` is NOT invoked.
 *  - Unlocked wallet: returns `false`, leaves the modal signal untouched, and
 *    does not invoke `retry` (the caller proceeds inline).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { wallet, openModal } from "@app/signals";
import { requireUnlock } from "@app/wallet";

describe("requireUnlock", () => {
  beforeEach(() => {
    openModal.value = {};
    wallet.value = {
      net: "testnet",
      address: "",
      swapAddress: "",
      ready: true,
      exists: true,
      locked: true,
    };
  });

  it("opens the unlock modal and returns true when locked", () => {
    const retry = vi.fn();

    const gated = requireUnlock(retry);

    expect(gated).toBe(true);
    expect(openModal.value.modal).toBe("unlock");
    expect(typeof openModal.value.onClose).toBe("function");
    // Nothing runs until the user actually unlocks.
    expect(retry).not.toHaveBeenCalled();
  });

  it("resumes the action when the unlock succeeds", () => {
    const retry = vi.fn();
    requireUnlock(retry);

    openModal.value.onClose?.(true);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not resume when the user cancels the unlock", () => {
    const retry = vi.fn();
    requireUnlock(retry);

    openModal.value.onClose?.(false);

    expect(retry).not.toHaveBeenCalled();
  });

  it("returns false and leaves the modal untouched when already unlocked", () => {
    wallet.value = { ...wallet.value, locked: false };
    const retry = vi.fn();

    const gated = requireUnlock(retry);

    expect(gated).toBe(false);
    expect(openModal.value.modal).toBeUndefined();
    expect(retry).not.toHaveBeenCalled();
  });
});
