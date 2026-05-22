import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import {
  computeCEKHash,
  verifyCEKReveal,
  addTimelockToMetadata,
  isUnlocked,
  getUnlockRemaining,
  getTimeRemaining,
  formatTimeRemaining,
  formatBlocksRemaining,
  formatUnlockCondition,
  saveReveal,
  loadReveals,
  getReveal,
  confirmReveal,
  deleteReveal,
  setTimelockRevealStore,
  type TimelockReveal,
} from "../timelock";
import { buildEncryptedMetadata } from "../encryption";
import { GLYPH_ENCRYPTED, GLYPH_TIMELOCK } from "../protocols";

// ============================================================================
// Test fixtures
// ============================================================================

const makeCEK = () => new Uint8Array(32).fill(0xab);

const makeBaseMetadata = () =>
  buildEncryptedMetadata({
    protocolIds: [2, GLYPH_ENCRYPTED], // NFT + Encrypted
    contentType: "image/png",
    name: "test.png",
    plaintextHash: new Uint8Array(32).fill(0x01),
    cekHash: sha256(makeCEK()),
    size: 1024,
    numChunks: 1,
  });

// ============================================================================
// computeCEKHash
// ============================================================================

describe("computeCEKHash", () => {
  it("returns SHA256 of the CEK", () => {
    const cek = makeCEK();
    const hash = computeCEKHash(cek);
    expect(hash).toEqual(sha256(cek));
    expect(hash).toHaveLength(32);
  });

  it("produces different hashes for different CEKs", () => {
    const cek1 = new Uint8Array(32).fill(0x01);
    const cek2 = new Uint8Array(32).fill(0x02);
    expect(bytesToHex(computeCEKHash(cek1))).not.toEqual(
      bytesToHex(computeCEKHash(cek2))
    );
  });
});

// ============================================================================
// verifyCEKReveal
// ============================================================================

describe("verifyCEKReveal", () => {
  it("returns true for matching CEK and hash", () => {
    const cek = makeCEK();
    const hash = bytesToHex(sha256(cek));
    expect(verifyCEKReveal(cek, hash)).toBe(true);
  });

  it("returns false for wrong CEK", () => {
    const cek = makeCEK();
    const wrongCek = new Uint8Array(32).fill(0xcd);
    const hash = bytesToHex(sha256(cek));
    expect(verifyCEKReveal(wrongCek, hash)).toBe(false);
  });

  it("handles uppercase hex", () => {
    const cek = makeCEK();
    const hash = bytesToHex(sha256(cek)).toUpperCase();
    expect(verifyCEKReveal(cek, hash)).toBe(true);
  });
});

// ============================================================================
// addTimelockToMetadata — time mode
// ============================================================================

describe("addTimelockToMetadata (time mode)", () => {
  const cek = makeCEK();
  const futureTime = Math.floor(Date.now() / 1000) + 86400; // 1 day from now

  it("adds GLYPH_TIMELOCK protocol", () => {
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "time",
      unlockAt: futureTime,
    });
    expect(metadata.p).toContain(GLYPH_TIMELOCK);
    expect(metadata.p).toContain(GLYPH_ENCRYPTED);
  });

  it("does not duplicate GLYPH_TIMELOCK if already present", () => {
    const base = makeBaseMetadata();
    const { metadata: first } = addTimelockToMetadata(base, cek, {
      mode: "time",
      unlockAt: futureTime,
    });
    const { metadata: second } = addTimelockToMetadata(first, cek, {
      mode: "time",
      unlockAt: futureTime,
    });
    expect(second.p.filter((p) => p === GLYPH_TIMELOCK)).toHaveLength(1);
  });

  it("sets crypto.timelock with correct fields", () => {
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "time",
      unlockAt: futureTime,
      hint: "Test hint",
    });
    const tl = metadata.crypto.timelock;
    expect(tl).toBeDefined();
    expect(tl!.mode).toBe("time");
    expect(tl!.unlock_at).toBe(futureTime);
    expect(tl!.hint).toBe("Test hint");
    expect(tl!.cek_hash).toMatch(/^sha256:/);
  });

  it("cek_hash in metadata matches computeCEKHash", () => {
    const base = makeBaseMetadata();
    const { metadata, commitment } = addTimelockToMetadata(base, cek, {
      mode: "time",
      unlockAt: futureTime,
    });
    const expectedHash = bytesToHex(computeCEKHash(cek));
    expect(commitment.cekHash).toBe(expectedHash);
    expect(metadata.crypto.timelock!.cek_hash).toBe(`sha256:${expectedHash}`);
  });

  it("returns reveal record with correct fields", () => {
    const base = makeBaseMetadata();
    const { reveal } = addTimelockToMetadata(base, cek, {
      mode: "time",
      unlockAt: futureTime,
    });
    expect(reveal.cek).toBe(bytesToHex(cek));
    expect(reveal.mode).toBe("time");
    expect(reveal.unlockAt).toBe(futureTime);
    expect(reveal.createdAt).toBeGreaterThan(0);
  });
});

// ============================================================================
// addTimelockToMetadata — block mode
// ============================================================================

describe("addTimelockToMetadata (block mode)", () => {
  const cek = makeCEK();
  const unlockBlock = 500000;

  it("sets mode to block and unlock_at to block height", () => {
    const base = makeBaseMetadata();
    const { metadata, commitment } = addTimelockToMetadata(base, cek, {
      mode: "block",
      unlockAt: unlockBlock,
    });
    expect(metadata.crypto.timelock!.mode).toBe("block");
    expect(metadata.crypto.timelock!.unlock_at).toBe(unlockBlock);
    expect(commitment.mode).toBe("block");
    expect(commitment.unlockAt).toBe(unlockBlock);
  });
});

// ============================================================================
// isUnlocked
// ============================================================================

describe("isUnlocked", () => {
  it("returns true for non-timelocked metadata", () => {
    const base = makeBaseMetadata();
    expect(isUnlocked(base)).toBe(true);
  });

  it("returns false for time-locked future content", () => {
    const cek = makeCEK();
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "time",
      unlockAt: Math.floor(Date.now() / 1000) + 86400,
    });
    expect(isUnlocked(metadata)).toBe(false);
  });

  it("returns true for time-locked past content", () => {
    const cek = makeCEK();
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "time",
      unlockAt: Math.floor(Date.now() / 1000) - 1,
    });
    expect(isUnlocked(metadata)).toBe(true);
  });

  it("returns false for block-locked future content (block not reached)", () => {
    const cek = makeCEK();
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "block",
      unlockAt: 500000,
    });
    expect(isUnlocked(metadata, 400000)).toBe(false);
  });

  it("returns true for block-locked content when block reached", () => {
    const cek = makeCEK();
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "block",
      unlockAt: 500000,
    });
    expect(isUnlocked(metadata, 500000)).toBe(true);
    expect(isUnlocked(metadata, 600000)).toBe(true);
  });

  it("returns false for block-locked when no currentBlock provided", () => {
    const cek = makeCEK();
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "block",
      unlockAt: 500000,
    });
    expect(isUnlocked(metadata, undefined)).toBe(false);
  });
});

// ============================================================================
// getUnlockRemaining
// ============================================================================

describe("getUnlockRemaining", () => {
  it("returns 0 for non-timelocked metadata", () => {
    const base = makeBaseMetadata();
    expect(getUnlockRemaining(base)).toBe(0);
  });

  it("returns remaining seconds for time-locked future content", () => {
    const cek = makeCEK();
    const base = makeBaseMetadata();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "time",
      unlockAt: future,
    });
    const remaining = getUnlockRemaining(metadata);
    expect(remaining).toBeGreaterThan(3500);
    expect(remaining).toBeLessThanOrEqual(3600);
  });

  it("returns 0 for past time-locked content", () => {
    const cek = makeCEK();
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "time",
      unlockAt: Math.floor(Date.now() / 1000) - 100,
    });
    expect(getUnlockRemaining(metadata)).toBe(0);
  });

  it("returns remaining blocks for block-locked content", () => {
    const cek = makeCEK();
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "block",
      unlockAt: 500000,
    });
    expect(getUnlockRemaining(metadata, 400000)).toBe(100000);
  });

  it("deprecated getTimeRemaining delegates to getUnlockRemaining", () => {
    const base = makeBaseMetadata();
    // Non-timelocked should return 0
    expect(getTimeRemaining(base as never)).toBe(0);
  });
});

// ============================================================================
// formatTimeRemaining
// ============================================================================

describe("formatTimeRemaining", () => {
  it('returns "Unlocked" for 0 or negative', () => {
    expect(formatTimeRemaining(0)).toBe("Unlocked");
    expect(formatTimeRemaining(-1)).toBe("Unlocked");
  });

  it("formats days/hours/minutes", () => {
    expect(formatTimeRemaining(86400)).toBe("1d");
    expect(formatTimeRemaining(90061)).toBe("1d 1h 1m");
    expect(formatTimeRemaining(3661)).toBe("1h 1m");
    expect(formatTimeRemaining(61)).toBe("1m");
  });

  it('returns "< 1m" for <60s', () => {
    expect(formatTimeRemaining(30)).toBe("< 1m");
    expect(formatTimeRemaining(1)).toBe("< 1m");
  });
});

// ============================================================================
// formatBlocksRemaining
// ============================================================================

describe("formatBlocksRemaining", () => {
  it('returns "Unlocked" for 0', () => {
    expect(formatBlocksRemaining(0)).toBe("Unlocked");
  });

  it("includes block count and estimated time", () => {
    const result = formatBlocksRemaining(10);
    expect(result).toContain("10 blocks");
    expect(result).toContain("~"); // estimated time
  });
});

// ============================================================================
// formatUnlockCondition
// ============================================================================

describe("formatUnlockCondition", () => {
  it("returns 'Not timelocked' for unlocked metadata", () => {
    const base = makeBaseMetadata();
    expect(formatUnlockCondition(base)).toBe("Not timelocked");
  });

  it("includes block number for block-mode locks", () => {
    const cek = makeCEK();
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "block",
      unlockAt: 500000,
    });
    const result = formatUnlockCondition(metadata, 400000);
    expect(result).toContain("500000");
    expect(result).toContain("100000 blocks");
  });

  it("shows unlocked for past block-mode lock", () => {
    const cek = makeCEK();
    const base = makeBaseMetadata();
    const { metadata } = addTimelockToMetadata(base, cek, {
      mode: "block",
      unlockAt: 100,
    });
    const result = formatUnlockCondition(metadata, 500000);
    expect(result).toContain("unlocked");
  });
});

// ============================================================================
// Reveal persistence (localStorage mocked)
// ============================================================================

describe("Reveal persistence (pluggable store)", () => {
  // After R15 the reveal store is pluggable. These tests exercise the
  // public API against the default localStorage backend. The localStorage
  // stub lets the default `LocalStorageRevealStore` work under vitest.
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    });
    // Re-install the default LocalStorageRevealStore so it picks up the
    // freshly-stubbed `localStorage`. (The module loads its singleton
    // adapter once at import time; resetting via setTimelockRevealStore
    // creates a fresh instance bound to the current global.)
    setTimelockRevealStore(
      new (class {
        async load() {
          const raw = localStorage.getItem("glyph_timelock_reveals");
          try {
            return raw ? (JSON.parse(raw) as TimelockReveal[]) : [];
          } catch {
            return [];
          }
        }
        async save(reveal: TimelockReveal) {
          const existing = await this.load();
          const updated = existing.filter(
            (r) => r.tokenRef !== reveal.tokenRef
          );
          updated.push(reveal);
          localStorage.setItem(
            "glyph_timelock_reveals",
            JSON.stringify(updated)
          );
        }
        async rename(tempId: string, confirmedTokenRef: string) {
          const reveals = await this.load();
          const idx = reveals.findIndex((r) => r.tokenRef === tempId);
          if (idx === -1) return;
          reveals[idx] = { ...reveals[idx], tokenRef: confirmedTokenRef };
          localStorage.setItem(
            "glyph_timelock_reveals",
            JSON.stringify(reveals)
          );
        }
        async delete(tokenRef: string) {
          const updated = (await this.load()).filter(
            (r) => r.tokenRef !== tokenRef
          );
          localStorage.setItem(
            "glyph_timelock_reveals",
            JSON.stringify(updated)
          );
        }
      })()
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeReveal = (tokenRef = "txid:0"): TimelockReveal => ({
    tokenRef,
    cek: "ab".repeat(32),
    cekHash: "cd".repeat(32),
    mode: "time",
    unlockAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: Math.floor(Date.now() / 1000),
  });

  it("saveReveal and loadReveals round-trip", async () => {
    const reveal = makeReveal();
    await saveReveal(reveal);
    const loaded = await loadReveals();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].tokenRef).toBe(reveal.tokenRef);
    expect(loaded[0].cek).toBe(reveal.cek);
  });

  it("overwriting a tokenRef replaces the record", async () => {
    const r1 = makeReveal("txid:0");
    await saveReveal(r1);
    const r2 = { ...makeReveal("txid:0"), cek: "ef".repeat(32) };
    await saveReveal(r2);
    const loaded = await loadReveals();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].cek).toBe(r2.cek);
  });

  it("getReveal returns the correct record", async () => {
    await saveReveal(makeReveal("txid:1"));
    await saveReveal(makeReveal("txid:2"));
    const r = await getReveal("txid:1");
    expect(r).toBeDefined();
    expect(r!.tokenRef).toBe("txid:1");
  });

  it("getReveal returns undefined for unknown ref", async () => {
    expect(await getReveal("nope")).toBeUndefined();
  });

  it("confirmReveal updates tokenRef", async () => {
    const reveal = makeReveal("pending");
    await saveReveal(reveal);
    await confirmReveal("pending", "txid:confirmed");
    const r = await getReveal("txid:confirmed");
    expect(r).toBeDefined();
    expect(await getReveal("pending")).toBeUndefined();
  });

  it("deleteReveal removes the record", async () => {
    await saveReveal(makeReveal("txid:del"));
    await deleteReveal("txid:del");
    expect(await getReveal("txid:del")).toBeUndefined();
    expect(await loadReveals()).toHaveLength(0);
  });

  it("loadReveals returns empty array on empty storage", async () => {
    expect(await loadReveals()).toEqual([]);
  });

  it("loadReveals returns empty array on corrupted storage", async () => {
    store["glyph_timelock_reveals"] = "not json {";
    expect(await loadReveals()).toEqual([]);
  });

  it("custom store: in-memory adapter is honored after setTimelockRevealStore", async () => {
    const records = new Map<string, TimelockReveal>();
    setTimelockRevealStore({
      async load() {
        return Array.from(records.values());
      },
      async save(r) {
        records.set(r.tokenRef, r);
      },
      async rename(tempId, newRef) {
        const r = records.get(tempId);
        if (!r) return;
        records.delete(tempId);
        records.set(newRef, { ...r, tokenRef: newRef });
      },
      async delete(ref) {
        records.delete(ref);
      },
    });
    await saveReveal(makeReveal("in-memory"));
    expect(await getReveal("in-memory")).toBeDefined();
    // The localStorage backend should NOT have seen this write.
    expect(store["glyph_timelock_reveals"]).toBeUndefined();
  });
});
