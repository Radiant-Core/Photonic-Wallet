/**
 * R25 — Multihash / CID verification tests.
 *
 * Covers:
 *   - CIDv0 (base58btc, implicit sha2-256) parse + verify round-trip.
 *   - CIDv1 base32 sha2-256 parse + verify round-trip.
 *   - Tampered content is rejected (the headline acceptance from R25).
 *   - Multihash functions outside the allowlist are rejected before
 *     any hashing happens.
 *   - Malformed CID inputs throw.
 *
 * CIDs are constructed deterministically from a known plaintext so
 * the test doesn't depend on external CID-construction libraries.
 */
import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { base58, base32 } from "@scure/base";

import {
  parseCidMultihash,
  parseMultihashBytes,
  verifyCidContent,
  ALLOWED_MULTIHASH_CODES,
} from "../multihash";

/** Build a CIDv0 ("Qm…") from raw bytes by hashing then base58-encoding. */
function makeCidV0(content: Uint8Array): string {
  const digest = sha256(content);
  // multihash = [code uvarint = 0x12][len uvarint = 0x20][32-byte digest]
  const mh = new Uint8Array(2 + digest.length);
  mh[0] = 0x12;
  mh[1] = 0x20;
  mh.set(digest, 2);
  return base58.encode(mh);
}

/** Build a CIDv1 (raw codec 0x55) base32-encoded from raw bytes. */
function makeCidV1Raw(content: Uint8Array): string {
  const digest = sha256(content);
  const mh = new Uint8Array(2 + digest.length);
  mh[0] = 0x12;
  mh[1] = 0x20;
  mh.set(digest, 2);
  // CIDv1 = [version=0x01][codec=0x55 raw][multihash]
  const cid = new Uint8Array(2 + mh.length);
  cid[0] = 0x01;
  cid[1] = 0x55;
  cid.set(mh, 2);
  // base32 lowercase, multibase prefix 'b', strip padding.
  return "b" + base32.encode(cid).replace(/=+$/, "").toLowerCase();
}

describe("R25 — parseCidMultihash", () => {
  it("parses a CIDv0 as sha2-256/32", () => {
    const content = new TextEncoder().encode("hello world");
    const cid = makeCidV0(content);
    const mh = parseCidMultihash(cid);
    expect(mh.code).toBe(ALLOWED_MULTIHASH_CODES.SHA2_256);
    expect(mh.algo).toBe("SHA2_256");
    expect(mh.digestLength).toBe(32);
    expect(Array.from(mh.digest)).toEqual(Array.from(sha256(content)));
  });

  it("parses a CIDv1 base32 raw codec as sha2-256/32", () => {
    const content = new TextEncoder().encode("payload-v1");
    const cid = makeCidV1Raw(content);
    const mh = parseCidMultihash(cid);
    expect(mh.code).toBe(ALLOWED_MULTIHASH_CODES.SHA2_256);
    expect(mh.algo).toBe("SHA2_256");
    expect(Array.from(mh.digest)).toEqual(Array.from(sha256(content)));
  });

  it("rejects a multihash function code outside the allowlist", () => {
    // Code 0x1b = keccak-256 — common, not on our allowlist.
    const digest = new Uint8Array(32).fill(0xaa);
    const mh = new Uint8Array(2 + digest.length);
    mh[0] = 0x1b;
    mh[1] = 0x20;
    mh.set(digest, 2);
    expect(() => parseMultihashBytes(mh)).toThrow(/not on the allowlist/);
  });

  it("rejects unsupported CID encodings", () => {
    expect(() => parseCidMultihash("z123fakecid")).toThrow(
      /Unsupported CID encoding/
    );
  });

  it("throws on a truncated multihash", () => {
    // header claims 32 bytes but provides 8
    const mh = new Uint8Array([0x12, 0x20, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => parseMultihashBytes(mh)).toThrow(/length mismatch/);
  });

  it("throws on empty / malformed CID strings", () => {
    expect(() => parseCidMultihash("")).toThrow(/Invalid CID/);
    expect(() => parseCidMultihash("ab")).toThrow(/Invalid CID/);
  });
});

describe("R25 — verifyCidContent", () => {
  it("accepts content that hashes to the CID's multihash (CIDv0)", () => {
    const content = new TextEncoder().encode("CIDv0 round-trip content");
    const cid = makeCidV0(content);
    expect(() => verifyCidContent(cid, content)).not.toThrow();
  });

  it("accepts content that hashes to the CID's multihash (CIDv1)", () => {
    const content = new TextEncoder().encode("CIDv1 round-trip content");
    const cid = makeCidV1Raw(content);
    expect(() => verifyCidContent(cid, content)).not.toThrow();
  });

  it("REJECTS a tampered blob (acceptance test from R25)", () => {
    const content = new TextEncoder().encode("the original on-chain blob");
    const cid = makeCidV0(content);
    // Flip a single byte — a single-bit tamper of the gateway response.
    const tampered = new Uint8Array(content);
    tampered[0] ^= 0x01;
    expect(() => verifyCidContent(cid, tampered)).toThrow(
      /CID content verification failed/
    );
  });

  it("REJECTS content longer than the original even if prefix matches", () => {
    const content = new TextEncoder().encode("short");
    const cid = makeCidV0(content);
    const padded = new Uint8Array([...content, ...new Array(10).fill(0)]);
    expect(() => verifyCidContent(cid, padded)).toThrow(
      /CID content verification failed/
    );
  });
});
