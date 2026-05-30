/**
 * SPV (Simplified Payment Verification) primitives.
 *
 * Audit context: R14 / finding M4. Previously the wallet only checked that
 * the bytes returned by `blockchain.transaction.get` hash to the requested
 * txid (`crypto.ts::verifyTransactionHash`). That proves the server didn't
 * corrupt the transaction, but NOT that the transaction is actually in the
 * chain — a malicious Electrum server could fabricate a well-formed but
 * never-mined transaction and report it as confirmed.
 *
 * This module adds the missing piece: verify a transaction's **inclusion**
 * in a block via a Merkle branch proof, checked against a block header the
 * wallet already tracks (see `packages/app/src/electrum/worker/Headers.ts`,
 * which downloads + reorg-checks the header chain from a pinned checkpoint).
 *
 * Everything here is pure and synchronous — no network, no storage — so it
 * is fully unit-testable. The app-side orchestration (fetch the Merkle
 * proof via Electrum, look up the stored header) lives in
 * `packages/app/src/verifier.ts`.
 *
 * ## Byte order
 *
 * Bitcoin/Radiant hashes have two representations:
 *   - **internal**  little-endian, used for hashing
 *   - **display**   big-endian hex, what users/Electrum/explorers show
 *
 * `blockchain.transaction.get_merkle` returns the txid and sibling hashes in
 * display order, and the block header embeds the Merkle root in internal
 * order. We hash in internal order and convert at the boundaries. Helpers
 * below make the conversions explicit so endianness bugs are visible.
 *
 * ## Two hash functions — important
 *
 * Radiant forked Bitcoin but **changed the block-header proof-of-work hash**
 * to double SHA-512/256 (`Hash.sha512_256sha512_256` in radiantjs), while
 * keeping Bitcoin-style double-SHA-256 for transaction ids and the Merkle
 * tree. So:
 *   - Block-header hash / PoW target  → `dsha512_256`  (Radiant-specific)
 *   - Txid / Merkle branch folding    → `dsha256`      (Bitcoin-style)
 * Using the wrong one for the header makes every real Radiant header fail
 * its PoW check (verified against the live chain).
 */
import { sha256 } from "@noble/hashes/sha256";
import { sha512_256 } from "@noble/hashes/sha512";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";
import { bitsToTarget } from "./difficulty";

/** Serialized block-header length, in bytes. */
export const BLOCK_HEADER_SIZE = 80;

/** Byte offset of the 32-byte Merkle root within a serialized header. */
const MERKLE_ROOT_OFFSET = 36;

/** Byte offset of the 4-byte little-endian nBits within a serialized header. */
const NBITS_OFFSET = 72;

/** Double SHA-256 — Radiant txid + Merkle-tree hash (Bitcoin-style). */
export function dsha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/** Double SHA-512/256 — Radiant block-header / proof-of-work hash. */
export function dsha512_256(data: Uint8Array): Uint8Array {
  return sha512_256(sha512_256(data));
}

function reverseBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

/** Display (big-endian) hex → internal (little-endian) bytes. */
function displayHexToInternal(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`Invalid 32-byte hash hex: ${hex}`);
  }
  return reverseBytes(hexToBytes(clean.toLowerCase()));
}

/** Internal (little-endian) bytes → display (big-endian) hex. */
function internalToDisplayHex(bytes: Uint8Array): string {
  return bytesToHex(reverseBytes(bytes));
}

/**
 * Extract the Merkle root from a serialized 80-byte block header.
 * Returns display (big-endian) hex — comparable to txids and explorer output.
 */
export function extractMerkleRoot(header: Uint8Array): string {
  if (header.length !== BLOCK_HEADER_SIZE) {
    throw new Error(
      `Block header must be ${BLOCK_HEADER_SIZE} bytes; got ${header.length}`
    );
  }
  return internalToDisplayHex(
    header.slice(MERKLE_ROOT_OFFSET, MERKLE_ROOT_OFFSET + 32)
  );
}

/**
 * Compute the block hash of a serialized 80-byte header, using Radiant's
 * double SHA-512/256 (NOT Bitcoin's double-SHA-256). Returns display
 * (big-endian) hex — matches what radiantjs `BlockHeader.id` / explorers show.
 */
export function hashBlockHeader(header: Uint8Array): string {
  if (header.length !== BLOCK_HEADER_SIZE) {
    throw new Error(
      `Block header must be ${BLOCK_HEADER_SIZE} bytes; got ${header.length}`
    );
  }
  return internalToDisplayHex(dsha512_256(header));
}

/** Read the little-endian nBits (compact target) field from a header. */
export function readNBits(header: Uint8Array): number {
  if (header.length !== BLOCK_HEADER_SIZE) {
    throw new Error(
      `Block header must be ${BLOCK_HEADER_SIZE} bytes; got ${header.length}`
    );
  }
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return dv.getUint32(NBITS_OFFSET, true);
}

/**
 * Verify a header satisfies its own proof-of-work: the block hash, read as a
 * big-endian integer, must be ≤ the target encoded in nBits.
 *
 * This proves the header is a valid PoW header in isolation. It does NOT by
 * itself prove the header belongs to the main chain at a given height —
 * that comes from the header-chain continuity the Headers worker maintains
 * from the pinned checkpoint. Use both together.
 */
export function verifyHeaderTarget(header: Uint8Array): boolean {
  try {
    const target = bitsToTarget(readNBits(header));
    if (target <= 0n) return false;
    const hashValue = BigInt("0x" + hashBlockHeader(header));
    return hashValue <= target;
  } catch {
    return false;
  }
}

/**
 * A Merkle inclusion proof as returned by ElectrumX
 * `blockchain.transaction.get_merkle`.
 */
export interface MerkleProof {
  /** Transaction id being proven, display (big-endian) hex. */
  txid: string;
  /** Sibling hashes from leaf → root, display (big-endian) hex. */
  merkle: string[];
  /** 0-based position of the transaction within the block. */
  pos: number;
}

/**
 * Fold a Merkle branch proof up to its root.
 *
 * At each level the low bit of the running index selects which side the
 * current node is on: bit 0 → current is the left child (hash current ||
 * sibling), bit 1 → current is the right child (hash sibling || current).
 * The index is shifted right after each level.
 *
 * Returns the computed root in display (big-endian) hex.
 */
export function computeMerkleRootFromProof(proof: MerkleProof): string {
  if (!Number.isInteger(proof.pos) || proof.pos < 0) {
    throw new Error(`Invalid Merkle position: ${proof.pos}`);
  }
  let current = displayHexToInternal(proof.txid);
  let index = proof.pos;
  for (const siblingHex of proof.merkle) {
    const sibling = displayHexToInternal(siblingHex);
    current =
      (index & 1) === 0
        ? dsha256(concatBytes(current, sibling))
        : dsha256(concatBytes(sibling, current));
    index = Math.floor(index / 2);
  }
  return internalToDisplayHex(current);
}

/**
 * Verify a Merkle branch proof against an expected root.
 *
 * Returns false (never throws) for malformed input so callers can treat a
 * verification failure and a malformed proof identically — both mean "not
 * proven".
 */
export function verifyMerkleProof(
  proof: MerkleProof,
  expectedMerkleRoot: string
): boolean {
  try {
    const root = computeMerkleRootFromProof(proof);
    return root.toLowerCase() === expectedMerkleRoot.toLowerCase();
  } catch {
    return false;
  }
}

/** Result of a full transaction-inclusion check. */
export interface InclusionResult {
  /** True only if the transaction is proven to be in the given header's block. */
  valid: boolean;
  /** Machine-readable failure reason when `valid` is false. */
  reason?:
    | "bad-header-size"
    | "merkle-mismatch"
    | "bad-pow"
    | "malformed-proof";
}

/**
 * Verify that a transaction is included in the block described by `header`.
 *
 * Combines the Merkle inclusion proof (txid is in the block whose Merkle
 * root the header commits to) with an optional proof-of-work check on the
 * header itself.
 *
 * Trust model: this proves inclusion in *some* valid-PoW block whose Merkle
 * root matches. The caller must independently establish that `header` is the
 * main-chain header at the claimed height (the Headers worker does this by
 * extending a verified chain from the pinned checkpoint). With both, a
 * malicious server cannot forge a confirmation.
 */
export function verifyTxInclusion(params: {
  txid: string;
  merkle: string[];
  pos: number;
  header: Uint8Array;
  /** Verify the header's own PoW. Default true. */
  checkPow?: boolean;
}): InclusionResult {
  const { txid, merkle, pos, header, checkPow = true } = params;

  if (header.length !== BLOCK_HEADER_SIZE) {
    return { valid: false, reason: "bad-header-size" };
  }

  if (checkPow && !verifyHeaderTarget(header)) {
    return { valid: false, reason: "bad-pow" };
  }

  let merkleRoot: string;
  try {
    merkleRoot = extractMerkleRoot(header);
  } catch {
    return { valid: false, reason: "bad-header-size" };
  }

  if (!Number.isInteger(pos) || pos < 0) {
    return { valid: false, reason: "malformed-proof" };
  }

  if (!verifyMerkleProof({ txid, merkle, pos }, merkleRoot)) {
    return { valid: false, reason: "merkle-mismatch" };
  }

  return { valid: true };
}
