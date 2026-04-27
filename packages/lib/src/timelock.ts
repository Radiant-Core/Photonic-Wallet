/**
 * Glyph v2 Timelocked Content Support (REP-3009)
 *
 * Implements:
 * - Hash-commit key generation (SHA256 of CEK committed on-chain)
 * - Reveal transaction structure (broadcasts CEK after lock expires)
 * - Block-height and UNIX timestamp locking modes
 * - Auto-unlock detection and countdown helpers
 *
 * Security model: The CEK MUST be wrapped to self (backup key) BEFORE timelock
 * commitment so the content can be recovered even if the reveal tx is lost.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { GlyphV2Metadata } from "./v2metadata";
import { GLYPH_TIMELOCK } from "./protocols";
import { type EncryptedContentStub } from "./encryption";

// ============================================================================
// Types
// ============================================================================

/** How the timelock unlock condition is expressed */
export type TimelockMode = "block" | "time";

/** Parameters for creating a timelock commitment */
export type TimelockParams = {
  /** Locking mode: block height or UNIX timestamp */
  mode: TimelockMode;
  /**
   * For "block" mode: absolute block height at which content unlocks.
   * For "time" mode: UNIX timestamp (seconds) at which content unlocks.
   */
  unlockAt: number;
  /** Optional label shown to viewers before unlock */
  hint?: string;
};

/** The hash commitment stored on-chain for a timelocked CEK */
export type TimelockCommitment = {
  /** SHA256 of the CEK — committed on-chain, proves reveal is authentic */
  cekHash: string; // hex
  /** Locking mode */
  mode: TimelockMode;
  /** Block height or UNIX timestamp */
  unlockAt: number;
  /** Optional hint for viewers */
  hint?: string;
};

/** A pending reveal: contains the CEK to be broadcast after unlock */
export type TimelockReveal = {
  /** Token reference (txid:vout) this reveal is for */
  tokenRef: string;
  /** The CEK in hex — broadcast this after unlock to allow decryption */
  cek: string;
  /** On-chain commitment hash (must match SHA256(CEK)) */
  cekHash: string;
  /** Locking mode */
  mode: TimelockMode;
  /** Unlock block height or UNIX timestamp */
  unlockAt: number;
  /** UNIX timestamp when this reveal record was created */
  createdAt: number;
};

/** Result of building a timelock-encrypted metadata stub */
export type TimelockMetadataResult = {
  /** Updated metadata with timelock fields added */
  metadata: EncryptedContentStub;
  /** Reveal record to persist locally (contains the raw CEK) */
  reveal: Omit<TimelockReveal, "tokenRef">; // tokenRef not known until broadcast
  /** On-chain commitment hash */
  commitment: TimelockCommitment;
};

// ============================================================================
// Core helpers
// ============================================================================

/**
 * Compute the SHA256 commitment hash of a CEK.
 * This is stored on-chain to authenticate reveal transactions without
 * revealing the key itself until unlock time.
 */
export function computeCEKHash(cek: Uint8Array): Uint8Array {
  return sha256(cek);
}

/**
 * Verify that a revealed CEK matches its on-chain commitment hash.
 * @param cek The raw CEK bytes to verify
 * @param commitmentHex SHA256 hex from on-chain metadata
 */
export function verifyCEKReveal(cek: Uint8Array, commitmentHex: string): boolean {
  const actual = bytesToHex(sha256(cek));
  return actual === commitmentHex.toLowerCase();
}

// ============================================================================
// Metadata builders
// ============================================================================

/**
 * Add timelock fields to an existing encrypted metadata stub.
 *
 * The metadata's `crypto.timelock` object carries the commitment hash and
 * unlock condition.  The protocols array gains GLYPH_TIMELOCK (9).
 *
 * @param metadata Base encrypted metadata (must already contain GLYPH_ENCRYPTED)
 * @param cek Raw 32-byte content encryption key (not stored on-chain)
 * @param params Timelock parameters
 * @returns Updated metadata, reveal record, and commitment hash
 */
export function addTimelockToMetadata(
  metadata: EncryptedContentStub,
  cek: Uint8Array,
  params: TimelockParams
): TimelockMetadataResult {
  const cekHashBytes = computeCEKHash(cek);
  const cekHashHex = bytesToHex(cekHashBytes);

  const commitment: TimelockCommitment = {
    cekHash: cekHashHex,
    mode: params.mode,
    unlockAt: params.unlockAt,
    ...(params.hint ? { hint: params.hint } : {}),
  };

  // Add GLYPH_TIMELOCK (9) protocol if not already present
  const protocols = metadata.p.includes(GLYPH_TIMELOCK)
    ? metadata.p
    : [...metadata.p, GLYPH_TIMELOCK];

  const updatedMetadata: EncryptedContentStub = {
    ...metadata,
    p: protocols,
    crypto: {
      ...metadata.crypto,
      timelock: {
        mode: params.mode,
        unlock_at: params.unlockAt,
        cek_hash: `sha256:${cekHashHex}`,
        ...(params.hint ? { hint: params.hint } : {}),
      },
    },
  };

  const reveal: Omit<TimelockReveal, "tokenRef"> = {
    cek: bytesToHex(cek),
    cekHash: cekHashHex,
    mode: params.mode,
    unlockAt: params.unlockAt,
    createdAt: Math.floor(Date.now() / 1000),
  };

  return { metadata: updatedMetadata, reveal, commitment };
}

// ============================================================================
// Unlock detection
// ============================================================================

/**
 * Extract timelock info from EncryptedContentStub crypto metadata.
 */
function getTimelockInfo(
  metadata: EncryptedContentStub | GlyphV2Metadata
): { mode?: TimelockMode; unlockAt?: number } | null {
  // EncryptedContentStub: metadata.crypto.timelock
  const stub = metadata as EncryptedContentStub;
  if (stub.crypto?.timelock) {
    const tl = stub.crypto.timelock as {
      mode?: TimelockMode;
      unlock_at?: number;
    };
    return { mode: tl.mode, unlockAt: tl.unlock_at };
  }
  // GlyphV2Metadata: metadata.app?.timelock
  const glyph = metadata as GlyphV2Metadata;
  const app = (glyph as Record<string, unknown>).app as
    | { timelock?: { mode?: TimelockMode; unlock_at?: number; unlock_time?: number } }
    | undefined;
  if (app?.timelock) {
    return {
      mode: app.timelock.mode ?? "time",
      unlockAt: app.timelock.unlock_at ?? app.timelock.unlock_time,
    };
  }
  return null;
}

/**
 * Check if timelocked content is unlocked.
 * @param metadata Encrypted content stub or full Glyph v2 metadata
 * @param currentBlock Current best-block height (required for block-mode locks)
 */
export function isUnlocked(
  metadata: EncryptedContentStub | GlyphV2Metadata,
  currentBlock?: number
): boolean {
  const protocols =
    (metadata as EncryptedContentStub).p ?? (metadata as GlyphV2Metadata).p;
  if (!protocols?.includes(GLYPH_TIMELOCK)) {
    return true; // Not timelocked
  }

  const info = getTimelockInfo(metadata);
  if (!info?.unlockAt) return true;

  if (info.mode === "block") {
    if (currentBlock === undefined) return false; // Can't determine without block height
    return currentBlock >= info.unlockAt;
  }

  // Default: time mode
  const now = Math.floor(Date.now() / 1000);
  return now >= info.unlockAt;
}

/**
 * Get seconds (or blocks) remaining until unlock.
 * Returns 0 if already unlocked or no timelock set.
 * @param metadata Encrypted content stub or full Glyph v2 metadata
 * @param currentBlock Current best-block height (required for block-mode)
 */
export function getUnlockRemaining(
  metadata: EncryptedContentStub | GlyphV2Metadata,
  currentBlock?: number
): number {
  const info = getTimelockInfo(metadata);
  if (!info?.unlockAt) return 0;

  if (info.mode === "block") {
    if (currentBlock === undefined) return 0;
    return Math.max(0, info.unlockAt - currentBlock);
  }

  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, info.unlockAt - now);
}

/**
 * @deprecated Use getUnlockRemaining()
 */
export function getTimeRemaining(metadata: GlyphV2Metadata): number {
  return getUnlockRemaining(metadata);
}

// ============================================================================
// Formatting helpers
// ============================================================================

/**
 * Format seconds as human-readable countdown string.
 */
export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return "Unlocked";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  return parts.length > 0 ? parts.join(" ") : "< 1m";
}

/**
 * Format remaining blocks as human-readable string.
 * Estimates ~2 minutes per Radiant block.
 */
export function formatBlocksRemaining(blocks: number): string {
  if (blocks <= 0) return "Unlocked";
  const BLOCK_TIME_SECONDS = 120; // Radiant ~2 min blocks
  const estimatedSeconds = blocks * BLOCK_TIME_SECONDS;
  return `${blocks} blocks (~${formatTimeRemaining(estimatedSeconds)})`;
}

/**
 * Format the unlock condition for display.
 * @param metadata Encrypted content stub or full Glyph v2 metadata
 * @param currentBlock Current best-block height (for block mode)
 */
export function formatUnlockCondition(
  metadata: EncryptedContentStub | GlyphV2Metadata,
  currentBlock?: number
): string {
  const info = getTimelockInfo(metadata);
  if (!info?.unlockAt) return "Not timelocked";

  if (info.mode === "block") {
    const remaining =
      currentBlock !== undefined
        ? Math.max(0, info.unlockAt - currentBlock)
        : undefined;
    if (remaining !== undefined) {
      return remaining === 0
        ? `Block #${info.unlockAt} (unlocked)`
        : `Block #${info.unlockAt} (${formatBlocksRemaining(remaining)})`;
    }
    return `Block #${info.unlockAt}`;
  }

  // Time mode
  const date = new Date(info.unlockAt * 1000);
  const remaining = getUnlockRemaining(metadata, currentBlock);
  if (remaining === 0) {
    return `${date.toLocaleDateString()} (unlocked)`;
  }
  return `${date.toLocaleDateString()} (${formatTimeRemaining(remaining)})`;
}

// ============================================================================
// Reveal persistence helpers
// ============================================================================

const REVEALS_STORAGE_KEY = "glyph_timelock_reveals";

/**
 * Persist a reveal record to localStorage.
 * Call this immediately after minting — before the user navigates away.
 */
export function saveReveal(reveal: TimelockReveal): void {
  const existing = loadReveals();
  const updated = existing.filter((r) => r.tokenRef !== reveal.tokenRef);
  updated.push(reveal);
  localStorage.setItem(REVEALS_STORAGE_KEY, JSON.stringify(updated));
}

/**
 * Load all persisted reveal records.
 */
export function loadReveals(): TimelockReveal[] {
  try {
    const raw = localStorage.getItem(REVEALS_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as TimelockReveal[];
  } catch {
    return [];
  }
}

/**
 * Get the reveal record for a specific token.
 */
export function getReveal(tokenRef: string): TimelockReveal | undefined {
  return loadReveals().find((r) => r.tokenRef === tokenRef);
}

/**
 * Update the tokenRef on a reveal record once the mint is confirmed.
 * @param tempId Temporary id used before broadcast (e.g., empty string or txid placeholder)
 * @param confirmedTokenRef The actual txid:vout token ref after broadcast
 */
export function confirmReveal(tempId: string, confirmedTokenRef: string): void {
  const reveals = loadReveals();
  const idx = reveals.findIndex((r) => r.tokenRef === tempId);
  if (idx === -1) return;
  reveals[idx] = { ...reveals[idx], tokenRef: confirmedTokenRef };
  localStorage.setItem(REVEALS_STORAGE_KEY, JSON.stringify(reveals));
}

/**
 * Remove a reveal record (e.g., after successful on-chain reveal broadcast).
 */
export function deleteReveal(tokenRef: string): void {
  const updated = loadReveals().filter((r) => r.tokenRef !== tokenRef);
  localStorage.setItem(REVEALS_STORAGE_KEY, JSON.stringify(updated));
}
