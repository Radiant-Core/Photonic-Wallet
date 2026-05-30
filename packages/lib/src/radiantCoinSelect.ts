/**
 * Native Radiant coin selection.
 *
 * Implements an accumulative selection strategy (worst-case O(n)) — UTXOs
 * are sorted by
 * descending "effective value" (value minus the marginal fee their input
 * adds), then accumulated until they cover outputs + fee.
 *
 * Size estimation matches Radiant transaction encoding:
 *   - 4-byte version + 4-byte locktime ............ TX_EMPTY_SIZE
 *   - per input:  32 txid + 4 vout + 4 sequence + varint(scriptLen) + script
 *   - per output: 8 value + varint(scriptLen) + script
 *   - per tx:     varint(numInputs) + varint(numOutputs)
 *
 * Radiant has no enforced dust rule; we use a 1-photon floor so any positive
 * change is recoverable.
 *
 * All values are in photons (1 RXD = 100_000_000 photons). All fee rates are
 * in photons/byte and MUST be normalized via `normalizeFeeRate()` before
 * reaching this module — `coinSelect.ts` is the single caller and clamps.
 */
import { MAX_REASONABLE_FEE_RATE } from "./feePolicy";

// --- Size constants -------------------------------------------------------
//
// R9 sign-off (verified against Radiant Core source 2026): every constant
// below matches Radiant Core's transaction serialization / policy, or is
// strictly more conservative. References:
//   - TX_EMPTY_SIZE  = 8   → CTransaction: 4-byte int32 nVersion + 4-byte
//                            uint32 nLockTime.
//   - TX_INPUT_BASE  = 40  → CTxIn: 32-byte prevout txid + 4-byte vout +
//                            4-byte nSequence (scriptSig length/bytes added
//                            separately by inputBytes()).
//   - TX_INPUT_PUBKEYHASH  = 107 → standard P2PKH unlocking script
//                            (push ~71/72-byte sig + push 33-byte pubkey).
//   - TX_OUTPUT_BASE = 8   → CTxOut nValue is an 8-byte int64 Amount.
//   - TX_OUTPUT_PUBKEYHASH = 25 → standard P2PKH scriptPubKey
//                            (OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG).
//   - TX_DUST_THRESHOLD = 1 → matches Radiant Core policy.cpp: IsDust() is
//                            true only for nValue <= 0; GetDustThreshold()
//                            returns 1 satoshi. (Radiant removed BSV's 546
//                            dust rule.) A 1-photon floor is safe + minimal.

export const TX_EMPTY_SIZE = 4 + 4; // version + locktime
export const TX_INPUT_BASE = 32 + 4 + 4; // prev_txid + prev_vout + sequence
export const TX_INPUT_PUBKEYHASH = 107; // typical P2PKH unlocking script
export const TX_OUTPUT_BASE = 8; // value
export const TX_OUTPUT_PUBKEYHASH = 25; // typical P2PKH locking script
export const TX_DUST_THRESHOLD = 1; // Radiant: no enforced dust, keep >0 floor

/**
 * Emergency cap on total fee. Catches unit-confusion bugs (e.g. paying
 * sats/kB as photons/byte) before they spend the wallet. 100 RXD is enough
 * for 20 MB at 0.5 sat/byte — far above any legitimate single tx.
 *
 * R9 sign-off: safe relative to Radiant Core (MAX_STANDARD_TX_SIZE = 20 MB;
 * 100 RXD over 20 MB ≈ 5 photons/byte, well under any reasonable rate).
 */
export const MAX_TX_FEE_PHOTONS = 100 * 100_000_000;

// --- Public input/output shapes -------------------------------------------

export interface CoinSelectInput {
  /** Hex-encoded scriptSig (for size estimation). Empty/undefined → assume P2PKH. */
  script?: string;
  value: number;
  required?: boolean;
  // Callers may carry arbitrary extra fields through selection.
  [key: string]: unknown;
}

export interface CoinSelectOutput {
  /** Hex-encoded scriptPubKey. Empty/undefined → assume P2PKH (25 bytes). */
  script?: string;
  value: number;
  [key: string]: unknown;
}

export interface CoinSelectResult<
  TIn extends CoinSelectInput,
  TOut extends CoinSelectOutput
> {
  /** Undefined if selection failed (insufficient funds). */
  inputs?: TIn[];
  /** Undefined if selection failed. Includes a change output if one was added. */
  outputs?: (TOut | { value: number; script: string })[];
  /** Always set: either the realized fee, or the projected fee on failure. */
  fee: number;
}

// --- Size helpers ---------------------------------------------------------

/** Byte length of a VarInt encoding for non-negative integer `n`. */
export function varIntSize(n: number): number {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`varIntSize: invalid input ${n}`);
  }
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

/** Hex-string → byte length (string with no `0x` prefix; even-length assumed). */
function hexByteLength(hex: string | undefined): number | null {
  if (!hex) return null;
  // Tolerate odd lengths defensively — round up rather than throwing in a
  // size-estimation path (real serialization will catch malformed scripts).
  return Math.ceil(hex.length / 2);
}

export function inputBytes(input: CoinSelectInput): number {
  const scriptLen = hexByteLength(input.script) ?? TX_INPUT_PUBKEYHASH;
  return TX_INPUT_BASE + varIntSize(scriptLen) + scriptLen;
}

export function outputBytes(output: CoinSelectOutput): number {
  const scriptLen =
    hexByteLength(output.script ?? undefined) ?? TX_OUTPUT_PUBKEYHASH;
  return TX_OUTPUT_BASE + varIntSize(scriptLen) + scriptLen;
}

export function transactionBytes(
  inputs: CoinSelectInput[],
  outputs: CoinSelectOutput[]
): number {
  let total = TX_EMPTY_SIZE;
  total += varIntSize(inputs.length);
  total += varIntSize(outputs.length);
  for (const i of inputs) total += inputBytes(i);
  for (const o of outputs) total += outputBytes(o);
  return total;
}

function sumValues(items: { value: number }[]): number {
  let s = 0;
  for (const i of items) {
    if (
      !Number.isFinite(i.value) ||
      i.value < 0 ||
      !Number.isInteger(i.value)
    ) {
      return Number.NaN;
    }
    s += i.value;
  }
  return s;
}

function ceilFee(feeRate: number, bytes: number): number {
  return Math.ceil(feeRate * bytes);
}

// --- Selection algorithm --------------------------------------------------

/**
 * Accumulative coin selection. Honors `required: true` inputs unconditionally.
 *
 * Returns `{ fee }` only (no inputs/outputs) if selection failed. Callers
 * MUST check for `result.inputs` before treating the result as a success.
 */
export function radiantCoinSelect<
  TIn extends CoinSelectInput,
  TOut extends CoinSelectOutput
>(
  utxos: TIn[],
  outputs: TOut[],
  feeRate: number,
  changeScript: string
): CoinSelectResult<TIn, TOut> {
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    return { fee: 0 };
  }

  // 1. Partition required vs. discretionary inputs.
  const required: TIn[] = [];
  const discretionary: TIn[] = [];
  for (const u of utxos) {
    (u.required ? required : discretionary).push(u);
  }

  // 2. Sort discretionary by descending effective value.
  discretionary.sort((a, b) => {
    const aScore = a.value - feeRate * inputBytes(a);
    const bScore = b.value - feeRate * inputBytes(b);
    return bScore - aScore;
  });

  // 3. Seed the accumulator with all required inputs.
  const selected: TIn[] = required.slice();
  let bytesAccum = transactionBytes(selected, outputs);
  const outSum = sumValues(outputs);
  if (!Number.isFinite(outSum)) {
    return { fee: 0 };
  }
  let inAccum = sumValues(selected);
  if (!Number.isFinite(inAccum)) {
    return { fee: 0 };
  }

  let fee = ceilFee(feeRate, bytesAccum);
  if (inAccum >= outSum + fee) {
    return finalize(selected, outputs, feeRate, changeScript);
  }

  // 4. Walk discretionary inputs in sorted order.
  for (let i = 0; i < discretionary.length; ++i) {
    const utxo = discretionary[i];
    const utxoBytes = inputBytes(utxo);
    const utxoFee = feeRate * utxoBytes;

    // Skip detrimental inputs (they cost more in fee than they bring in).
    if (utxoFee > utxo.value) {
      if (i === discretionary.length - 1) {
        return { fee: ceilFee(feeRate, bytesAccum + utxoBytes) };
      }
      continue;
    }

    selected.push(utxo);
    bytesAccum += utxoBytes;
    inAccum += utxo.value;

    fee = ceilFee(feeRate, bytesAccum);
    if (inAccum < outSum + fee) continue;

    return finalize(selected, outputs, feeRate, changeScript);
  }

  // 5. Insufficient funds.
  return { fee: ceilFee(feeRate, bytesAccum) };
}

function finalize<TIn extends CoinSelectInput, TOut extends CoinSelectOutput>(
  inputs: TIn[],
  outputs: TOut[],
  feeRate: number,
  changeScript: string
): CoinSelectResult<TIn, TOut> {
  // Probe whether a change output is worth adding.
  const baseBytes = transactionBytes(inputs, outputs);
  const blankOutputBytes = outputBytes({ value: 0 });
  const feeWithChange = feeRate * (baseBytes + blankOutputBytes);
  const remainderWithChange =
    sumValues(inputs) - (sumValues(outputs) + feeWithChange);

  // Build the final outputs list, optionally appending change.
  const finalOutputs: (TOut | { value: number; script: string })[] =
    outputs.slice();
  if (remainderWithChange > TX_DUST_THRESHOLD) {
    // Change value rounded down by 1 photon to absorb integer fee rounding
    // without underfunding.
    finalOutputs.push({
      value: Math.round(remainderWithChange) - 1,
      script: changeScript,
    });
  }

  const realizedFee = sumValues(inputs) - sumValues(finalOutputs);
  if (!Number.isFinite(realizedFee)) {
    return { fee: ceilFee(feeRate, baseBytes) };
  }

  const fee = Math.ceil(realizedFee);

  // Emergency cap — catches unit-confusion bugs before they spend the wallet.
  if (fee > MAX_TX_FEE_PHOTONS) {
    throw new Error(
      `radiantCoinSelect: fee ${fee} photons exceeds emergency cap ${MAX_TX_FEE_PHOTONS}`
    );
  }

  // Defense-in-depth: also cap implied rate. If a caller bypasses
  // normalizeFeeRate() and somehow produces an absurd rate, this trips.
  const impliedRate = fee / baseBytes;
  if (impliedRate > MAX_REASONABLE_FEE_RATE * 5) {
    throw new Error(
      `radiantCoinSelect: implied rate ${impliedRate} photons/byte is unreasonable`
    );
  }

  return { inputs, outputs: finalOutputs, fee };
}
