/**
 * Radiant PSBT — BIP-174 profile byte-compatible with Radiant Core
 * (`walletcreatefundedpsbt` / `walletprocesspsbt` / `finalizepsbt`).
 * See `docs/psbt.md` for the wire-format specification.
 */
export { PsbtError, type PsbtErrorCode } from "./errors";
export type { PsbtKeyValue } from "./keyvalue";
export {
  MAX_PSBT_TX_SIZE,
  PSBT_GLOBAL_UNSIGNED_TX,
  PSBT_IN_BIP32_DERIVATION,
  PSBT_IN_FINAL_SCRIPTSIG,
  PSBT_IN_PARTIAL_SIG,
  PSBT_IN_REDEEM_SCRIPT,
  PSBT_IN_SIGHASH,
  PSBT_IN_UTXO,
  PSBT_MAGIC,
  inputPrevout,
  parsePsbt,
  psbtFromBase64,
  psbtToBase64,
  serializePsbt,
  type Psbt,
  type PsbtInput,
  type PsbtOutput,
  type PsbtUtxo,
} from "./psbt";
export {
  DEFAULT_ALLOWED_SIGHASHES,
  DEFAULT_SIGHASH,
  extractTx,
  finalizePsbt,
  signPsbt,
  type SignPsbtOptions,
  type SignPsbtResult,
  type SkipReason,
} from "./sign";
export {
  analyzePsbt,
  type AnalyzeContext,
  type PsbtAnalysis,
  type PsbtInputSummary,
  type PsbtOutputSummary,
  type PsbtWarning,
} from "./analyze";
