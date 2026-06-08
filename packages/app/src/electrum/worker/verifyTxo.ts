/**
 * Worker-side txo verification helpers (audit R14 / findings M3, M4, token-id).
 *
 * Three concerns live here, all about NOT trusting the Electrum server:
 *
 *  1. `validateElectrumUtxo` — runtime validation of the JSON the server
 *     returns from `blockchain.scripthash.listunspent` (FIX 3 / M3). Numeric
 *     fields are attacker-controlled until checked; we assert they are
 *     non-negative safe integers within sane ranges before they are summed
 *     into balances or used as array/DB positions.
 *
 *  2. `verifyTxoInclusion` — SPV Merkle-inclusion verification of a confirmed
 *     txo against the locally PoW-validated header chain (FIX 1 / R14). A txo
 *     the server *claims* is confirmed is only marked `verified` once a Merkle
 *     proof checks out against a stored header. Degrades gracefully: any
 *     failure (no get_merkle support, no header yet, bad proof) returns
 *     `false` and never throws.
 *
 *  3. `verifyFtRefCommitment` — cross-check that the on-chain output script at
 *     the claimed outpoint actually commits to the server-annotated token ref
 *     (FIX 2). The server tells us *which* token a UTXO is via `refs[0].ref`;
 *     we re-derive the expected FT script from the claimed ref + address and
 *     compare it byte-for-byte to the real output script in the raw (hash-
 *     verified) transaction.
 */
import { Transaction } from "@radiant-core/radiantjs";
import db from "@app/db";
import { ElectrumUtxo } from "@lib/types";
import { verifyTxInclusion } from "@lib/spv";
import { verifyTransactionHash, hexToBytes } from "@lib/crypto";
import { ftScript, parseFtScript } from "@lib/script";
import type { ElectrumRequester } from "@app/verifier";

/**
 * Maximum plausible per-output value, in photons (M3 sanity cap).
 *
 * Radiant's total supply is 21,000,000,000 RXD × 1e8 photons = 2.1e18, which
 * is far above `Number.MAX_SAFE_INTEGER` (~9.007e15). Any single honest UTXO
 * is orders of magnitude smaller, so we cap the *per-entry* sanity check at
 * `Number.MAX_SAFE_INTEGER`: anything larger can't be represented exactly as a
 * JS number anyway (so summing it would corrupt the balance) and is rejected.
 */
export const MAX_MONEY_PHOTONS = Number.MAX_SAFE_INTEGER;

/** A non-negative, exactly-representable integer (rejects NaN/Infinity/floats). */
function isSafeNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Validate a single `listunspent` entry from the server before any of its
 * numeric fields are trusted (FIX 3 / M3).
 *
 * Returns true only when:
 *   - `tx_hash` is a 64-char hex string,
 *   - `tx_pos`, `height` are non-negative safe integers,
 *   - `value` is a non-negative safe integer ≤ MAX_MONEY_PHOTONS.
 *
 * `height === 0` is the standard ElectrumX convention for "in mempool /
 * unconfirmed" and is allowed (callers map 0 → unconfirmed). Offending
 * entries are skipped by the caller rather than summed into balances.
 */
export function validateElectrumUtxo(utxo: unknown): utxo is ElectrumUtxo {
  if (!utxo || typeof utxo !== "object") return false;
  const u = utxo as Record<string, unknown>;

  if (typeof u.tx_hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(u.tx_hash)) {
    return false;
  }
  if (!isSafeNonNegInt(u.tx_pos)) return false;
  if (!isSafeNonNegInt(u.height)) return false;
  if (!isSafeNonNegInt(u.value) || (u.value as number) > MAX_MONEY_PHOTONS) {
    return false;
  }
  return true;
}

/**
 * SPV-verify that a confirmed txo is genuinely included in the chain
 * (FIX 1 / R14).
 *
 * `height` here is the server-supplied confirmation height. We never trust it
 * for balance purposes — instead we ask the server for a Merkle proof and
 * check it against the header we already downloaded and PoW-validated at that
 * height (`db.header`). Honest servers produce a valid proof, so honest coins
 * verify exactly as before; a lying server either can't produce a proof or
 * produces one that fails against our own header.
 *
 * Graceful degradation: returns `false` (unverified) and never throws on any
 * failure — missing get_merkle support, header not yet synced, malformed or
 * mismatched proof. Callers treat `false` as "don't count as confirmed yet".
 */
export async function verifyTxoInclusion(
  electrum: ElectrumRequester | undefined,
  txid: string,
  height: number
): Promise<boolean> {
  // Unconfirmed (mempool) coins have no block to prove inclusion in.
  if (!electrum || !Number.isSafeInteger(height) || height <= 0) {
    return false;
  }

  let proof: { block_height: number; merkle: string[]; pos: number };
  try {
    proof = await electrum.request<{
      block_height: number;
      merkle: string[];
      pos: number;
    }>("blockchain.transaction.get_merkle", txid, height);
  } catch {
    // Server doesn't support get_merkle, or the request failed. Degrade.
    return false;
  }

  // M3: validate the proof's numeric fields before use.
  if (
    !proof ||
    !Number.isSafeInteger(proof.block_height) ||
    proof.block_height <= 0 ||
    !Array.isArray(proof.merkle) ||
    !proof.merkle.every((h) => typeof h === "string") ||
    !Number.isSafeInteger(proof.pos) ||
    proof.pos < 0
  ) {
    return false;
  }

  // Look up the header we already downloaded + PoW-validated for that height.
  const headerRow = await db.header
    .where("height")
    .equals(proof.block_height)
    .first();
  if (!headerRow || headerRow.reorg) {
    return false;
  }

  const result = verifyTxInclusion({
    txid,
    merkle: proof.merkle,
    pos: proof.pos,
    header: new Uint8Array(headerRow.buffer),
    checkPow: true,
  });
  return result.valid;
}

/**
 * Cross-check that the on-chain output at `utxo`'s outpoint commits to the
 * server-claimed token ref (FIX 2).
 *
 * The server annotates each FT UTXO with `refs[0].ref` telling us which token
 * it is, but that annotation is unauthenticated. We fetch the raw transaction
 * (hash-verified against its txid, so its bytes are trustworthy), read the
 * output script at `tx_pos`, parse the ref the script actually commits to
 * (via `OP_PUSHINPUTREF`), and require it to equal the claimed ref. Equivalent
 * to rebuilding the expected `ftScript(address, ref)` and comparing.
 *
 * Returns true when the on-chain script matches the claimed ref. Returns false
 * (skip / flag the token) on any mismatch, parse failure, or fetch/verify
 * error — never throws.
 *
 * @param claimedScript The FT script the wallet derived from the claimed ref
 *                      (== `ftScript(address, reverse(refs[0].ref))`).
 */
export async function verifyFtRefCommitment(
  electrum: ElectrumRequester | undefined,
  utxo: ElectrumUtxo,
  address: string,
  claimedScript: string
): Promise<boolean> {
  if (!electrum) return false;

  // The claimed ref (LE) committed in the script we built from server data.
  const { ref: claimedRefLE } = parseFtScript(claimedScript);
  if (!claimedRefLE) return false;

  let rawTx: string;
  try {
    rawTx = await electrum.request<string>(
      "blockchain.transaction.get",
      utxo.tx_hash
    );
  } catch {
    return false;
  }
  if (!rawTx) return false;

  // The raw tx must hash to the claimed txid before we trust any of its bytes
  // (same guard used for tx fetches elsewhere — see getTransaction / NFT.ts).
  try {
    if (!verifyTransactionHash(hexToBytes(rawTx), utxo.tx_hash)) {
      return false;
    }
  } catch {
    return false;
  }

  let onChainScriptHex: string;
  try {
    const tx = new Transaction(rawTx);
    const output = tx.outputs[utxo.tx_pos];
    if (!output) return false;
    onChainScriptHex = output.script.toHex() as string;
  } catch {
    return false;
  }

  // Parse the ref the on-chain FT script actually commits to.
  const { ref: onChainRefLE } = parseFtScript(onChainScriptHex);
  if (!onChainRefLE) return false;

  // Compare on-chain ref to the server-claimed ref. Both are LE hex here.
  if (onChainRefLE.toLowerCase() !== claimedRefLE.toLowerCase()) {
    return false;
  }

  // Belt-and-braces: rebuilding the expected script from the on-chain ref and
  // our address must reproduce the exact on-chain script. This also pins the
  // P2PKH (address) portion, so a server can't swap the recipient either.
  //
  // `onChainRefLE` is returned by parseFtScript in the SAME byte orientation it
  // is embedded in the script, and ftScript() embeds the ref it is given
  // verbatim — so the ref must be passed through as-is. Do NOT reverseRef() it:
  // that flips it to big-endian, the rebuilt script never matches, and EVERY
  // legitimate FT UTXO is silently rejected (skipped in updateTxos), so FT
  // balances vanish ecosystem-wide while NFT/RXD/WAVE (no such check) are fine.
  try {
    const expected = ftScript(address, onChainRefLE);
    if (expected.toLowerCase() !== onChainScriptHex.toLowerCase()) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}
