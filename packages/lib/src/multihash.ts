/**
 * R25 — Minimal CID/multihash parser + verifier.
 *
 * The wallet downloads encrypted blobs from IPFS gateways and previously
 * verified them by recomputing SHA-256 and comparing against an
 * out-of-band `expectedHash` parameter. That trusts whoever sets
 * `expectedHash`, doesn't verify the CID itself, and hard-codes one hash
 * algorithm even though IPFS supports many. R25 fixes both: parse the
 * CID's multihash, dispatch on the declared hash function, allowlist
 * just the two functions we trust, and reject everything else before
 * the bytes ever enter the pipeline.
 *
 * Spec references:
 *   - CIDv0:  base58btc multihash, always sha2-256/32. Always starts "Qm".
 *   - CIDv1:  multibase + version + codec + multihash. Common multibase
 *             is base32 ("b...") for nft.storage / web3.storage output.
 *   - multihash codes (subset we care about):
 *               0x12       sha2-256       (32-byte digest)
 *               0xb220     blake2b-256    (32-byte digest)
 *
 * We deliberately do NOT pull in `multiformats` or `cids` as deps —
 * they bring ~80 KB of transitive code and an additional supply-chain
 * surface for ~120 LOC of parsing. The pinning policy from R19 already
 * caps `@scure/base` (which we use for the multibase decoding).
 */
import { sha256 } from "@noble/hashes/sha256";
import { blake2b } from "@noble/hashes/blake2b";
import { base58, base32 } from "@scure/base";

/** Multihash function codes we trust. */
export const ALLOWED_MULTIHASH_CODES = {
  SHA2_256: 0x12,
  BLAKE2B_256: 0xb220,
} as const;

export type MultihashAlgo = keyof typeof ALLOWED_MULTIHASH_CODES;

export interface ParsedMultihash {
  /** Multihash function code (uvarint). */
  code: number;
  /** Digest byte length declared in the multihash header. */
  digestLength: number;
  /** Raw digest bytes (length === digestLength). */
  digest: Uint8Array;
  /** Mapped algorithm name if the code is on the allowlist. */
  algo: MultihashAlgo;
}

/** Read a single uvarint from `bytes` starting at `offset`. */
function readUvarint(
  bytes: Uint8Array,
  offset: number
): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const byte = bytes[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: pos };
    }
    shift += 7;
    if (shift > 28) {
      throw new Error("uvarint too large");
    }
  }
  throw new Error("uvarint truncated");
}

/**
 * Parse a CID string and return its multihash component. Throws if the
 * CID is malformed, if the multibase prefix is unsupported, or if the
 * multihash function code isn't on `ALLOWED_MULTIHASH_CODES`.
 *
 * Supported encodings:
 *   - CIDv0  (raw "Qm..." base58btc)        → implicit sha2-256
 *   - CIDv1  base32 ("b..." lowercase)      → any allowed multihash
 */
export function parseCidMultihash(cid: string): ParsedMultihash {
  if (typeof cid !== "string" || cid.length < 4) {
    throw new Error(`Invalid CID: ${cid}`);
  }

  // CIDv0: bare base58btc multihash, always sha2-256/32.
  if (cid.startsWith("Qm") && cid.length === 46) {
    const bytes = base58.decode(cid);
    return parseMultihashBytes(bytes);
  }

  // CIDv1: multibase-prefixed. We only accept base32 ("b...") which is
  // what nft.storage / web3.storage emit by default and what IPFS HTTP
  // gateways canonicalise to.
  if (cid.startsWith("b")) {
    const decoded = base32.decode(
      cid.slice(1).toUpperCase() + padBase32(cid.slice(1).length)
    );
    // CIDv1 = [version uvarint] [codec uvarint] [multihash]
    const { value: version, next: afterVersion } = readUvarint(decoded, 0);
    if (version !== 1) {
      throw new Error(`Unsupported CID version: ${version}`);
    }
    const { next: afterCodec } = readUvarint(decoded, afterVersion);
    return parseMultihashBytes(decoded.subarray(afterCodec));
  }

  throw new Error(
    `Unsupported CID encoding (only CIDv0 and base32 CIDv1 accepted): ${cid.substring(
      0,
      8
    )}…`
  );
}

/**
 * Parse raw multihash bytes (no multibase / no CID version/codec).
 * Validates structure + allowlists the function code.
 */
export function parseMultihashBytes(bytes: Uint8Array): ParsedMultihash {
  const { value: code, next: afterCode } = readUvarint(bytes, 0);
  const { value: digestLength, next: afterLen } = readUvarint(bytes, afterCode);
  if (bytes.length - afterLen !== digestLength) {
    throw new Error(
      `Multihash length mismatch: header says ${digestLength}, got ${
        bytes.length - afterLen
      }`
    );
  }
  const algo = (
    Object.entries(ALLOWED_MULTIHASH_CODES) as [MultihashAlgo, number][]
  ).find(([, c]) => c === code)?.[0];
  if (!algo) {
    throw new Error(
      `Multihash function 0x${code.toString(16)} is not on the allowlist (R25)`
    );
  }
  return {
    code,
    digestLength,
    digest: bytes.subarray(afterLen, afterLen + digestLength),
    algo,
  };
}

/**
 * Compute the digest of `data` using the multihash's declared algorithm.
 * Caller compares the result to `mh.digest` with constant-time equality.
 */
export function digestForMultihash(
  mh: ParsedMultihash,
  data: Uint8Array
): Uint8Array {
  switch (mh.algo) {
    case "SHA2_256":
      return sha256(data);
    case "BLAKE2B_256":
      return blake2b(data, { dkLen: 32 });
  }
}

/**
 * Verify that `data` hashes to the multihash declared by `cid`. Throws
 * on any mismatch — never returns false. The throw shape lets callers
 * keep their existing try/catch loops.
 */
export function verifyCidContent(cid: string, data: Uint8Array): void {
  const mh = parseCidMultihash(cid);
  const actual = digestForMultihash(mh, data);
  if (!constantTimeEqual(actual, mh.digest)) {
    throw new Error(
      `CID content verification failed (${
        mh.algo
      }): downloaded bytes do not match ${cid.substring(0, 12)}…`
    );
  }
}

/** Constant-time byte comparison. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Right-pad a base32 string to a multiple of 8 so `@scure/base.base32` accepts it. */
function padBase32(len: number): string {
  const rem = len % 8;
  if (rem === 0) return "";
  return "=".repeat(8 - rem);
}
