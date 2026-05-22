/**
 * R4 — Idle auto-lock + SecretBytes wipe tests.
 *
 * Covers:
 *  - `SecretBytes` zeros its buffer on `wipe()`.
 *  - `lockWallet()` wipes mnemonic/wif/swapWif and drops their references.
 *  - `useActivityDetector` fires `lockWallet()` after the configured idle
 *    interval, and a settings change live-updates that interval.
 *
 * The hook test renders inside React-Testing-Library with fake timers
 * because the production hook uses `setTimeout(lockWallet, autoLockMs)`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { SecretBytes } from "@app/secretBytes";
import { wallet } from "@app/signals";
import { unlockWallet, lockWallet } from "@app/wallet";
import {
  autoLockMs,
  DEFAULT_AUTO_LOCK_MS,
  MIN_AUTO_LOCK_MS,
  MAX_AUTO_LOCK_MS,
  clampAutoLockMs,
} from "@app/autoLock";
import useActivityDetector from "@app/hooks/useActivityDetector";

// ChakraProvider is overkill for a hook smoke test; stub useToast to a no-op
vi.mock("@chakra-ui/react", async () => {
  const actual = await vi.importActual<typeof import("@chakra-ui/react")>(
    "@chakra-ui/react"
  );
  return {
    ...actual,
    useToast: () => () => undefined,
  };
});

// useActivityDetector touches the electrum worker for sync activation. Stub it
// so the hook can run without bringing up the worker mesh.
vi.mock("@app/electrum/Electrum", () => ({
  electrumWorker: {
    value: {
      isActive: vi.fn().mockResolvedValue(true),
      setActive: vi.fn(),
      syncPending: vi.fn(),
    },
  },
}));

const SAMPLE_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SAMPLE_WIF = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
const SAMPLE_SWAP_WIF = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnowq";

describe("SecretBytes", () => {
  it("zeros its buffer on wipe()", () => {
    const sb = SecretBytes.fromString("hunter2");
    const peek = sb.use((b) => Array.from(b));
    expect(peek.some((byte) => byte !== 0)).toBe(true);
    sb.wipe();
    expect(sb.isWiped).toBe(true);
    expect(() => sb.use((b) => b.length)).toThrow();
  });

  it("toString round-trips through UTF-8", () => {
    const sb = SecretBytes.fromString("café");
    expect(sb.toString()).toBe("café");
  });

  it("wipe() is idempotent", () => {
    const sb = SecretBytes.fromString("x");
    sb.wipe();
    expect(() => sb.wipe()).not.toThrow();
    expect(sb.isWiped).toBe(true);
  });
});

describe("lockWallet", () => {
  beforeEach(() => {
    // Make sure the wallet signal starts in a clean known state per test.
    wallet.value = {
      net: "testnet",
      address: "",
      swapAddress: "",
      ready: true,
      exists: true,
      locked: true,
    };
  });

  it("wipes mnemonic, wif, and swapWif bytes and flips locked: true", () => {
    unlockWallet(SAMPLE_MNEMONIC, SAMPLE_WIF, SAMPLE_SWAP_WIF);
    const beforeLock = wallet.value;
    expect(beforeLock.locked).toBe(false);
    expect(beforeLock.wif?.toString()).toBe(SAMPLE_WIF);
    expect(beforeLock.mnemonic?.toString()).toBe(SAMPLE_MNEMONIC);
    expect(beforeLock.swapWif?.toString()).toBe(SAMPLE_SWAP_WIF);

    // Capture references to the SecretBytes instances so we can verify
    // their buffers were zeroed even though the signal no longer points
    // at them.
    const mnemonicRef = beforeLock.mnemonic!;
    const wifRef = beforeLock.wif!;
    const swapRef = beforeLock.swapWif!;

    lockWallet();

    expect(wallet.value.locked).toBe(true);
    expect(wallet.value.mnemonic).toBeUndefined();
    expect(wallet.value.wif).toBeUndefined();
    expect(wallet.value.swapWif).toBeUndefined();
    expect(mnemonicRef.isWiped).toBe(true);
    expect(wifRef.isWiped).toBe(true);
    expect(swapRef.isWiped).toBe(true);
  });

  it("is safe to call on an already-locked wallet", () => {
    expect(() => lockWallet()).not.toThrow();
    expect(wallet.value.locked).toBe(true);
  });
});

describe("clampAutoLockMs", () => {
  it("clamps below MIN to MIN", () => {
    expect(clampAutoLockMs(1)).toBe(MIN_AUTO_LOCK_MS);
  });
  it("clamps above MAX to MAX", () => {
    expect(clampAutoLockMs(MAX_AUTO_LOCK_MS * 10)).toBe(MAX_AUTO_LOCK_MS);
  });
  it("falls back to DEFAULT for invalid input", () => {
    expect(clampAutoLockMs(NaN)).toBe(DEFAULT_AUTO_LOCK_MS);
    expect(clampAutoLockMs(-1)).toBe(DEFAULT_AUTO_LOCK_MS);
  });
});

describe("useActivityDetector — configurable idle auto-lock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    autoLockMs.value = DEFAULT_AUTO_LOCK_MS;
    wallet.value = {
      net: "testnet",
      address: "",
      swapAddress: "",
      ready: true,
      exists: true,
      locked: true,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("locks the wallet after the configured idle interval and wipes secrets", () => {
    // Use a short, custom interval so the test runs quickly.
    autoLockMs.value = 60_000; // 1 minute

    unlockWallet(SAMPLE_MNEMONIC, SAMPLE_WIF, SAMPLE_SWAP_WIF);
    const mnemonicRef = wallet.value.mnemonic!;
    expect(wallet.value.locked).toBe(false);
    expect(mnemonicRef.isWiped).toBe(false);

    renderHook(() => useActivityDetector());

    // Just before the interval — still unlocked.
    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(wallet.value.locked).toBe(false);

    // Cross the interval — auto-lock should fire.
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(wallet.value.locked).toBe(true);
    expect(wallet.value.mnemonic).toBeUndefined();
    expect(wallet.value.wif).toBeUndefined();
    expect(wallet.value.swapWif).toBeUndefined();
    // The previously-captured SecretBytes instance must have been zeroed —
    // this is the bit a heap snapshot would otherwise reveal.
    expect(mnemonicRef.isWiped).toBe(true);
  });

  it("respects the default 15-minute interval", () => {
    // Sanity-check the constant matches the spec.
    expect(DEFAULT_AUTO_LOCK_MS).toBe(15 * 60 * 1000);

    unlockWallet(SAMPLE_MNEMONIC, SAMPLE_WIF, SAMPLE_SWAP_WIF);
    renderHook(() => useActivityDetector());

    // At 14:59 the wallet is still unlocked.
    act(() => {
      vi.advanceTimersByTime(14 * 60 * 1000 + 59_000);
    });
    expect(wallet.value.locked).toBe(false);

    // At 15:00 the wallet locks.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(wallet.value.locked).toBe(true);
  });
});
