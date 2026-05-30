import { describe, it, expect } from "vitest";
import { hexToBytes, bytesToHex, concatBytes } from "@noble/hashes/utils";
import {
  dsha256,
  dsha512_256,
  extractMerkleRoot,
  hashBlockHeader,
  readNBits,
  verifyHeaderTarget,
  verifyMerkleProof,
  computeMerkleRootFromProof,
  verifyTxInclusion,
  BLOCK_HEADER_SIZE,
} from "../spv";

// ────────────────────────────────────────────────────────────────────────
// Bitcoin genesis block — used ONLY for the algorithm-independent paths.
//
// Radiant keeps Bitcoin's 80-byte header layout and Bitcoin-style SHA256d
// txids/Merkle tree, so the genesis block is a valid vector for Merkle-root
// extraction and the single-tx Merkle proof. It is NOT valid for the block
// HASH / PoW path, because Radiant changed that to double SHA-512/256 — see
// the RADIANT_* vector below for those.
// ────────────────────────────────────────────────────────────────────────
const GENESIS_HEADER_HEX =
  "0100000000000000000000000000000000000000000000000000000000000000000000003b" +
  "a3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff" +
  "001d1dac2b7c";
const GENESIS_HEADER = hexToBytes(GENESIS_HEADER_HEX);
const GENESIS_MERKLE_ROOT =
  "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";
// Genesis has a single transaction, so the coinbase txid == the Merkle root.
const GENESIS_COINBASE_TXID = GENESIS_MERKLE_ROOT;

// ────────────────────────────────────────────────────────────────────────
// Real Radiant mainnet block vector (height 433392), captured from a live
// ElectrumX server. Exercises the Radiant-specific block-header hash
// (double SHA-512/256) + PoW target check + Merkle-root extraction.
// ────────────────────────────────────────────────────────────────────────
const RADIANT_HEADER_HEX =
  "00000020f57f317b1ae83abf89c63982775cb8095cab09f469010bb65200000000000000" +
  "fe808acd3db05e2b285984e961282919e0bc6aed3f93092fb48b05eabe8e6bb7d8351a6a" +
  "d283001a54cedec7";
const RADIANT_HEADER = hexToBytes(RADIANT_HEADER_HEX);
const RADIANT_BLOCK_HASH =
  "000000000000002c4d1d189cd66e21bdf1a0048a5f41b93c5add0d4035209c89";
const RADIANT_MERKLE_ROOT =
  "b76b8ebeea058bb42f09933fed6abce019292861e98459282b5eb03dcd8a80fe";

// ────────────────────────────────────────────────────────────────────────
// Independent reference Merkle-tree builder (display-hex in/out), used to
// generate proofs the module-under-test must then verify. Deliberately a
// separate code path from spv.ts's folding logic.
// ────────────────────────────────────────────────────────────────────────
// Widest typed-array element type — accepts both ArrayBuffer- and
// ArrayBufferLike-backed Uint8Arrays (noble vs Uint8Array.from), sidestepping
// the TS 5.7 typed-array generic friction.
type Bytes = Uint8Array<ArrayBufferLike>;

const rev = (b: Bytes): Bytes => Uint8Array.from(b).reverse();
const toInternal = (displayHex: string): Bytes => rev(hexToBytes(displayHex));
const toDisplay = (internal: Bytes) => bytesToHex(rev(internal));

function buildTree(leavesDisplay: string[]): {
  levels: Bytes[][];
  root: string;
} {
  const leaves: Bytes[] = leavesDisplay.map(toInternal);
  const levels: Bytes[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: Bytes[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const left = cur[i];
      const right = i + 1 < cur.length ? cur[i + 1] : cur[i]; // duplicate last if odd
      next.push(dsha256(concatBytes(left, right)));
    }
    levels.push(next);
    cur = next;
  }
  return { levels, root: toDisplay(cur[0]) };
}

function proofFor(
  levels: Bytes[][],
  index: number
): { merkle: string[]; pos: number } {
  const merkle: string[] = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const isRight = i & 1;
    const siblingIdx = isRight ? i - 1 : i + 1;
    const sibling = siblingIdx < level.length ? level[siblingIdx] : level[i];
    merkle.push(toDisplay(sibling));
    i = Math.floor(i / 2);
  }
  return { merkle, pos: index };
}

/** Synthesize an 80-byte header that embeds a given Merkle root (no valid PoW). */
function headerWithMerkleRoot(rootDisplay: string): Uint8Array {
  const h = new Uint8Array(BLOCK_HEADER_SIZE);
  h.set(toInternal(rootDisplay), 36);
  return h;
}

// Deterministic fake txids: dsha256("tx" + i), as display hex.
function fakeTxid(i: number): string {
  return toDisplay(dsha256(new TextEncoder().encode(`tx${i}`)));
}

describe("genesis block — algorithm-independent paths (SHA256d Merkle)", () => {
  it("extractMerkleRoot matches the genesis Merkle root", () => {
    expect(extractMerkleRoot(GENESIS_HEADER)).toBe(GENESIS_MERKLE_ROOT);
  });

  it("readNBits reads the genesis nBits (0x1d00ffff)", () => {
    expect(readNBits(GENESIS_HEADER)).toBe(0x1d00ffff);
  });

  it("single-tx block: Merkle proof with empty branch returns the root", () => {
    // Genesis Merkle tree uses SHA256d, which Radiant also uses for txids.
    expect(
      verifyMerkleProof(
        { txid: GENESIS_COINBASE_TXID, merkle: [], pos: 0 },
        GENESIS_MERKLE_ROOT
      )
    ).toBe(true);
  });

  it("Merkle-only inclusion (PoW off) passes for the genesis coinbase", () => {
    const result = verifyTxInclusion({
      txid: GENESIS_COINBASE_TXID,
      merkle: [],
      pos: 0,
      header: GENESIS_HEADER,
      checkPow: false,
    });
    expect(result.valid).toBe(true);
  });
});

describe("Radiant header — real mainnet vector (block 433392, SHA512-256d PoW)", () => {
  it("hashBlockHeader matches the real Radiant block hash", () => {
    // The genuine Radiant hash — proves we use double SHA-512/256, not
    // SHA256d. (A SHA256d hash here would NOT have the leading zeros.)
    expect(hashBlockHeader(RADIANT_HEADER)).toBe(RADIANT_BLOCK_HASH);
  });

  it("extractMerkleRoot matches the real Radiant Merkle root", () => {
    expect(extractMerkleRoot(RADIANT_HEADER)).toBe(RADIANT_MERKLE_ROOT);
  });

  it("verifyHeaderTarget accepts the real Radiant header (valid PoW)", () => {
    expect(verifyHeaderTarget(RADIANT_HEADER)).toBe(true);
  });

  it("verifyHeaderTarget rejects a header with a mutated nonce", () => {
    const mutated = Uint8Array.from(RADIANT_HEADER);
    mutated[79] ^= 0xff; // flip nonce — hash will exceed target
    expect(verifyHeaderTarget(mutated)).toBe(false);
  });

  it("dsha512_256 differs from dsha256 (guards against hash mix-up)", () => {
    const a = bytesToHex(dsha512_256(RADIANT_HEADER));
    const b = bytesToHex(dsha256(RADIANT_HEADER));
    expect(a).not.toBe(b);
  });
});

describe("Merkle proof verification against a reference tree", () => {
  // Cover even/odd leaf counts to exercise the odd-duplication rule.
  for (const n of [1, 2, 3, 4, 5, 7, 8, 13]) {
    it(`verifies every leaf in a ${n}-leaf tree`, () => {
      const leaves = Array.from({ length: n }, (_, i) => fakeTxid(i));
      const { levels, root } = buildTree(leaves);
      for (let i = 0; i < n; i++) {
        const { merkle, pos } = proofFor(levels, i);
        expect(verifyMerkleProof({ txid: leaves[i], merkle, pos }, root)).toBe(
          true
        );
        // computeMerkleRootFromProof should reproduce the root directly too.
        expect(computeMerkleRootFromProof({ txid: leaves[i], merkle, pos })).toBe(
          root
        );
      }
    });
  }

  it("rejects a proof with a tampered sibling", () => {
    const leaves = Array.from({ length: 6 }, (_, i) => fakeTxid(i));
    const { levels, root } = buildTree(leaves);
    const { merkle, pos } = proofFor(levels, 2);
    const tampered = [...merkle];
    // Flip one hex char in the first sibling.
    tampered[0] =
      (tampered[0][0] === "a" ? "b" : "a") + tampered[0].slice(1);
    expect(verifyMerkleProof({ txid: leaves[2], merkle: tampered, pos }, root)).toBe(
      false
    );
  });

  it("rejects a proof with the wrong position", () => {
    const leaves = Array.from({ length: 6 }, (_, i) => fakeTxid(i));
    const { levels, root } = buildTree(leaves);
    const { merkle } = proofFor(levels, 2);
    // pos 3 instead of 2 → folds on the wrong side.
    expect(verifyMerkleProof({ txid: leaves[2], merkle, pos: 3 }, root)).toBe(
      false
    );
  });

  it("rejects a proof for a txid that isn't in the tree", () => {
    const leaves = Array.from({ length: 4 }, (_, i) => fakeTxid(i));
    const { levels, root } = buildTree(leaves);
    const { merkle, pos } = proofFor(levels, 1);
    expect(
      verifyMerkleProof({ txid: fakeTxid(999), merkle, pos }, root)
    ).toBe(false);
  });
});

describe("verifyMerkleProof — malformed input is rejected, not thrown", () => {
  const root = buildTree([fakeTxid(0), fakeTxid(1)]).root;
  it("negative position", () => {
    expect(verifyMerkleProof({ txid: fakeTxid(0), merkle: [], pos: -1 }, root)).toBe(
      false
    );
  });
  it("non-integer position", () => {
    expect(verifyMerkleProof({ txid: fakeTxid(0), merkle: [], pos: 1.5 }, root)).toBe(
      false
    );
  });
  it("malformed txid hex", () => {
    expect(verifyMerkleProof({ txid: "zzzz", merkle: [], pos: 0 }, root)).toBe(
      false
    );
  });
  it("malformed sibling hex", () => {
    expect(
      verifyMerkleProof({ txid: fakeTxid(0), merkle: ["nothex"], pos: 0 }, root)
    ).toBe(false);
  });
});

describe("verifyTxInclusion", () => {
  it("passes for a valid proof against a synthetic header (PoW off)", () => {
    const leaves = Array.from({ length: 5 }, (_, i) => fakeTxid(i));
    const { levels, root } = buildTree(leaves);
    const { merkle, pos } = proofFor(levels, 3);
    const header = headerWithMerkleRoot(root);
    const result = verifyTxInclusion({
      txid: leaves[3],
      merkle,
      pos,
      header,
      checkPow: false,
    });
    expect(result.valid).toBe(true);
  });

  it("fails with merkle-mismatch when the proof doesn't match the header root", () => {
    const leaves = Array.from({ length: 5 }, (_, i) => fakeTxid(i));
    const { levels } = buildTree(leaves);
    const { merkle, pos } = proofFor(levels, 3);
    const wrongHeader = headerWithMerkleRoot(fakeTxid(123));
    const result = verifyTxInclusion({
      txid: leaves[3],
      merkle,
      pos,
      header: wrongHeader,
      checkPow: false,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("merkle-mismatch");
  });

  it("fails with bad-header-size for a wrong-length header", () => {
    const result = verifyTxInclusion({
      txid: fakeTxid(0),
      merkle: [],
      pos: 0,
      header: new Uint8Array(40),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad-header-size");
  });

  it("fails with bad-pow when PoW check is on and the header isn't mined", () => {
    const leaves = [fakeTxid(0), fakeTxid(1)];
    const { levels, root } = buildTree(leaves);
    const { merkle, pos } = proofFor(levels, 0);
    const header = headerWithMerkleRoot(root); // nBits = 0 → invalid target
    const result = verifyTxInclusion({
      txid: leaves[0],
      merkle,
      pos,
      header,
      checkPow: true,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad-pow");
  });

  it("fails with malformed-proof for a negative position", () => {
    const header = headerWithMerkleRoot(fakeTxid(0));
    const result = verifyTxInclusion({
      txid: fakeTxid(0),
      merkle: [],
      pos: -5,
      header,
      checkPow: false,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("malformed-proof");
  });
});
