/**
 * Glyph v2 Timelock Reveal Transaction Builder (REP-3009 / Phase 5)
 *
 * Publishes a CEK (content-encryption key) on-chain after a timelock expires,
 * allowing anyone to decrypt previously-locked encrypted content.
 *
 * On-chain format (models `burn.ts` pattern):
 *   OP_RETURN <gly> <0x02> <0x09> <CBOR(RevealProof)>
 *   where 0x09 matches GLYPH_TIMELOCK protocol id (action-marker reuse).
 *
 * Note on privacy: publishing a reveal makes the content publicly decryptable.
 * The CEK is embedded directly in the OP_RETURN payload — this is the intended
 * behaviour of a timelock reveal.
 *
 * @see burn.ts for the action-marker pattern
 * @see timelock.ts for commitment/hash helpers + local reveal persistence
 */

import rjs from "@radiant-core/radiantjs";
import { encode, decode } from "cbor-x";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { Buffer } from "buffer";
import { Utxo, UnfinalizedInput, UnfinalizedOutput } from "./types";
import { GLYPH_TIMELOCK } from "./protocols";
import { glyphMagicBytesBuffer } from "./token";
import { p2pkhScript } from "./script";
import { fundTx } from "./coinSelect";
import { buildTx } from "./tx";

const { Script, Opcode } = rjs;

// ============================================================================
// Types
// ============================================================================

/**
 * Reveal proof embedded in the OP_RETURN output of a reveal transaction.
 * CBOR-encoded on-chain; deterministic field ordering.
 */
export type RevealProof = {
  /** Format version (currently 2 to match burn-proof versioning) */
  v: number;
  /** Protocols — [GLYPH_TIMELOCK] */
  p: number[];
  /** Action string — always "reveal" */
  action: "reveal";
  /** Token reference this reveal unlocks ("txid:vout") */
  token_ref: string;
  /** Revealed CEK — 32 bytes hex (lowercase) */
  cek: string;
  /** SHA256(cek) as "sha256:<hex>" — must match on-chain commitment */
  cek_hash: string;
  /** Optional hint string that was committed alongside the timelock */
  hint?: string;
};

export type RevealResult = {
  tx: rjs.Transaction;
  txid: string;
  proof: RevealProof;
  /** Change returned to the sender (excluding the OP_RETURN output) */
  photonsReturned: number;
};

/** Byte marker for reveal proofs (matches GLYPH_TIMELOCK protocol id) */
export const REVEAL_MARKER = 0x09;

/** CBOR version byte (matches burn-proof pattern) */
export const REVEAL_VERSION = 0x02;

// ============================================================================
// Proof script construction
// ============================================================================

/**
 * Build the OP_RETURN script carrying a reveal proof.
 *
 * @param tokenRef Token reference ("txid:vout") the reveal unlocks
 * @param cek Raw 32-byte CEK to publish (do NOT pass if you still want privacy)
 * @param options Optional extras (hint, explicit cek_hash override)
 */
export function createRevealProof(
  tokenRef: string,
  cek: Uint8Array,
  options: { hint?: string; cekHash?: string } = {}
): { script: string; proof: RevealProof } {
  if (cek.length !== 32) {
    throw new Error(`CEK must be 32 bytes, got ${cek.length}`);
  }
  if (!/^[0-9a-fA-F]{64}:[0-9]+$/.test(tokenRef)) {
    throw new Error(`Invalid token_ref — expected "txid:vout", got "${tokenRef}"`);
  }

  const cekHex = bytesToHex(cek);
  const computedHashHex = bytesToHex(sha256(cek));
  const cekHash = options.cekHash ?? `sha256:${computedHashHex}`;

  // If an explicit commitment hash was provided, verify it matches
  if (options.cekHash) {
    const expected = options.cekHash.replace(/^sha256:/i, "").toLowerCase();
    if (expected !== computedHashHex) {
      throw new Error(
        `CEK does not match provided commitment hash (expected ${expected}, got ${computedHashHex})`
      );
    }
  }

  const proof: RevealProof = {
    v: REVEAL_VERSION,
    p: [GLYPH_TIMELOCK],
    action: "reveal",
    token_ref: tokenRef,
    cek: cekHex,
    cek_hash: cekHash,
    ...(options.hint ? { hint: options.hint } : {}),
  };

  const encodedProof = encode(proof);

  const script = new Script()
    .add(Opcode.OP_RETURN)
    .add(glyphMagicBytesBuffer)
    .add(Buffer.from([REVEAL_VERSION]))
    .add(Buffer.from([REVEAL_MARKER]))
    .add(encodedProof)
    .toHex();

  return { script, proof };
}

// ============================================================================
// Transaction builder
// ============================================================================

/**
 * Build a timelock reveal transaction that publishes the CEK on-chain.
 *
 * The caller is responsible for confirming the timelock has expired;
 * this builder does not consult the chain.
 *
 * @param address Broadcaster's p2pkh address (funds + change)
 * @param wif Private key in WIF format
 * @param params.tokenRef Token ref ("txid:vout") being revealed
 * @param params.cek Raw 32-byte CEK bytes
 * @param params.hint Optional hint (must match on-chain commitment if set)
 * @param params.cekHash Optional commitment hash for validation (recommended)
 * @param utxos Wallet UTXOs for funding
 * @param feeRate Fee rate in sats/kB (default 10_000)
 */
export function buildRevealTx(
  address: string,
  wif: string,
  params: {
    tokenRef: string;
    cek: Uint8Array;
    hint?: string;
    cekHash?: string;
  },
  utxos: Utxo[],
  feeRate: number = 10000
): RevealResult {
  const { script: revealScript, proof } = createRevealProof(
    params.tokenRef,
    params.cek,
    { hint: params.hint, cekHash: params.cekHash }
  );

  const p2pkh = p2pkhScript(address);
  const inputs: UnfinalizedInput[] = [];
  const outputs: UnfinalizedOutput[] = [
    { script: revealScript, value: 0 },
  ];

  const { funding, change, fee } = fundTx(
    address,
    utxos,
    inputs,
    outputs,
    p2pkh,
    feeRate
  );

  if (fee === 0) {
    throw new Error("Couldn't fund reveal transaction (insufficient UTXOs)");
  }

  inputs.push(...funding);
  outputs.push(...change);

  const tx = buildTx(address, wif, inputs, outputs, false);
  const photonsReturned = change.reduce((sum, c) => sum + c.value, 0);

  return {
    tx,
    txid: tx.id,
    proof,
    photonsReturned,
  };
}

// ============================================================================
// Parsing & validation
// ============================================================================

/**
 * Parse a reveal proof from an OP_RETURN script.
 * Returns `undefined` if the script is not a valid Glyph reveal proof.
 */
export function parseRevealProof(script: string | rjs.Script): RevealProof | undefined {
  try {
    const scriptObj = typeof script === "string" ? new Script(script) : script;
    const chunks = scriptObj.chunks;

    if (chunks.length < 5 || chunks[0].opcodenum !== Opcode.OP_RETURN) {
      return undefined;
    }

    // Validate magic bytes
    const magic = Buffer.from(chunks[1].buf || []).toString("hex");
    if (magic !== "676c79") return undefined;

    // Validate version byte
    if (chunks[2].buf?.[0] !== REVEAL_VERSION) return undefined;

    // Validate marker
    if (chunks[3].buf?.[0] !== REVEAL_MARKER) return undefined;

    const payload = chunks[4].buf;
    if (!payload) return undefined;

    const proof = decode(Buffer.from(payload)) as RevealProof;

    // Basic shape validation
    if (
      typeof proof !== "object" ||
      proof.action !== "reveal" ||
      typeof proof.token_ref !== "string" ||
      typeof proof.cek !== "string" ||
      typeof proof.cek_hash !== "string"
    ) {
      return undefined;
    }

    return proof;
  } catch {
    return undefined;
  }
}

/**
 * Validate a reveal transaction against expected token ref + commitment hash.
 *
 * Checks performed:
 *  - Exactly one OP_RETURN output containing a well-formed reveal proof
 *  - Proof.token_ref matches expected
 *  - Proof.cek_hash matches on-chain commitment (if provided)
 *  - sha256(proof.cek) == proof.cek_hash (self-consistency)
 */
export function validateReveal(
  tx: rjs.Transaction,
  expectedTokenRef: string,
  expectedCekHash?: string
): { valid: boolean; error?: string; proof?: RevealProof } {
  // Find reveal proof output (OP_RETURN with our marker)
  let proof: RevealProof | undefined;
  for (const out of tx.outputs) {
    const parsed = parseRevealProof(out.script);
    if (parsed) {
      if (proof) {
        return { valid: false, error: "Multiple reveal proof outputs found" };
      }
      proof = parsed;
    }
  }

  if (!proof) {
    return { valid: false, error: "No reveal proof output found" };
  }

  if (proof.token_ref !== expectedTokenRef) {
    return {
      valid: false,
      error: `Token ref mismatch: expected ${expectedTokenRef}, got ${proof.token_ref}`,
      proof,
    };
  }

  // Self-consistency: CEK must hash to cek_hash
  const cekBytes = hexToBytes(proof.cek);
  if (cekBytes.length !== 32) {
    return {
      valid: false,
      error: `CEK must be 32 bytes, got ${cekBytes.length}`,
      proof,
    };
  }

  const actualHashHex = bytesToHex(sha256(cekBytes));
  const claimedHash = proof.cek_hash.replace(/^sha256:/i, "").toLowerCase();
  if (actualHashHex !== claimedHash) {
    return {
      valid: false,
      error: `CEK hash self-consistency failed: sha256(cek)=${actualHashHex} but proof claims ${claimedHash}`,
      proof,
    };
  }

  // Cross-check against on-chain commitment if provided
  if (expectedCekHash) {
    const expected = expectedCekHash.replace(/^sha256:/i, "").toLowerCase();
    if (actualHashHex !== expected) {
      return {
        valid: false,
        error: `CEK does not match on-chain commitment: expected ${expected}, got ${actualHashHex}`,
        proof,
      };
    }
  }

  return { valid: true, proof };
}

// ============================================================================
// Size estimation
// ============================================================================

/**
 * Estimate the byte size of a reveal OP_RETURN output.
 * Useful for fee previews before building the tx.
 */
export function estimateRevealOutputSize(hint?: string): number {
  // Dummy 32-byte CEK for sizing
  const dummyCek = new Uint8Array(32);
  const { script } = createRevealProof(
    "00".repeat(32) + ":0",
    dummyCek,
    hint ? { hint } : {}
  );
  // Each hex char = 4 bits, divide by 2 for bytes; add 8 bytes for output header (value + varint scriptlen)
  return script.length / 2 + 8;
}
