// Shared (de)serialization for vault "recovery info" — the small, shareable
// blob a sender hands to a recipient so they can import and claim a gifted /
// inherited / vesting-to-others vault WITHOUT decrypting the on-chain
// OP_RETURN. Verification is trustless and lives in the lib
// (`verifyVaultRecoveryInfo`); this module only handles the wire format.
import { VaultRecord } from "@app/types";
import { VaultRecoveryInfo } from "@lib/vault";

export const RECOVERY_INFO_TYPE = "photonic-vault-recovery";
export const BACKUP_TYPE = "photonic-vault-backup";

/**
 * Which kind of payload was pasted:
 *   - "recovery": a per-vault gift blob ({type: photonic-vault-recovery})
 *   - "backup":   a full wallet backup export ({type: photonic-vault-backup}) —
 *                 it also lists vaults the user SENT to others, which won't
 *                 import (they're locked to the recipient, not this wallet)
 *   - "list":     a bare array or untyped/single entry
 *   - "unknown":  not parseable JSON
 */
export type RecoveryPayloadKind = "recovery" | "backup" | "list" | "unknown";

/** Project a stored vault record down to the shareable recovery tuple. */
export function recordToRecoveryInfo(r: VaultRecord): VaultRecoveryInfo {
  return {
    txid: r.txid,
    vout: r.vout,
    assetType: r.assetType,
    mode: r.mode,
    locktime: r.locktime,
    ref: r.ref,
    label: r.label,
    recipientAddress: r.recipientAddress,
  };
}

/** Serialize one or more vault records into a recovery blob (pretty JSON). */
export function serializeRecoveryInfo(records: VaultRecord[]): string {
  return JSON.stringify(
    {
      type: RECOVERY_INFO_TYPE,
      version: 1,
      vaults: records.map(recordToRecoveryInfo),
    },
    null,
    2
  );
}

function coerceEntry(e: unknown): VaultRecoveryInfo | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  if (
    typeof o.txid !== "string" ||
    typeof o.vout !== "number" ||
    (o.assetType !== "rxd" && o.assetType !== "nft" && o.assetType !== "ft") ||
    (o.mode !== "block" && o.mode !== "time") ||
    typeof o.locktime !== "number"
  ) {
    return null;
  }
  return {
    txid: o.txid,
    vout: o.vout,
    assetType: o.assetType,
    mode: o.mode,
    locktime: o.locktime,
    ref: typeof o.ref === "string" ? o.ref : undefined,
    label: typeof o.label === "string" ? o.label : undefined,
    recipientAddress:
      typeof o.recipientAddress === "string" ? o.recipientAddress : undefined,
  };
}

/**
 * Parse pasted recovery text into a typed payload. Tolerant of:
 *   - `{ type, version, vaults: [...] }`  (recovery blob OR a full backup file)
 *   - a bare array of entries
 *   - a single entry object
 * Entries missing required fields are dropped (verification is the real gate).
 */
export function parseRecoveryPayload(text: string): {
  kind: RecoveryPayloadKind;
  entries: VaultRecoveryInfo[];
} {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: "unknown", entries: [] };
  }
  let kind: RecoveryPayloadKind = "unknown";
  let arr: unknown[] = [];
  if (Array.isArray(data)) {
    kind = "list";
    arr = data;
  } else if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    kind =
      o.type === RECOVERY_INFO_TYPE
        ? "recovery"
        : o.type === BACKUP_TYPE
        ? "backup"
        : "list";
    arr = Array.isArray(o.vaults) ? (o.vaults as unknown[]) : [data];
  }
  const entries = arr
    .map(coerceEntry)
    .filter((e): e is VaultRecoveryInfo => e !== null);
  return { kind, entries };
}

/** Convenience wrapper returning just the entries (verification is the gate). */
export function parseRecoveryInfo(text: string): VaultRecoveryInfo[] {
  return parseRecoveryPayload(text).entries;
}
