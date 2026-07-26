/**
 * Typed errors for the Radiant PSBT module.
 *
 * Every parse/sign/finalize failure carries a stable {@link PsbtErrorCode} so
 * callers (UI, protocol layer, tests) can branch on the cause without string
 * matching. Messages are human-readable and safe to display.
 */

export type PsbtErrorCode =
  // Container / serialization
  | "INVALID_MAGIC"
  | "TRUNCATED"
  | "TRAILING_DATA"
  | "NON_CANONICAL_VARINT"
  | "DUPLICATE_KEY"
  | "INVALID_KEY"
  | "INVALID_BASE64"
  // Global map / unsigned tx
  | "MISSING_UNSIGNED_TX"
  | "INVALID_UNSIGNED_TX"
  | "INPUT_INDEX_OUT_OF_RANGE"
  | "UNSIGNED_TX_HAS_SCRIPTSIGS"
  | "TX_TOO_LARGE"
  | "VALUE_OUT_OF_RANGE"
  // Signing / finalizing
  | "MISSING_UTXO"
  | "TOKEN_BEARING_INPUT"
  | "MISSING_FORKID"
  | "DISALLOWED_SIGHASH"
  | "NOT_FINALIZED";

export class PsbtError extends Error {
  constructor(
    public readonly code: PsbtErrorCode,
    message?: string
  ) {
    super(message ?? code);
    this.name = "PsbtError";
  }
}
