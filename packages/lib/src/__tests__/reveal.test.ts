import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import {
  createRevealProof,
  parseRevealProof,
  validateReveal,
  estimateRevealOutputSize,
  buildRevealTx,
  REVEAL_MARKER,
  REVEAL_VERSION,
  type RevealProof,
} from "../reveal";
import { GLYPH_TIMELOCK } from "../protocols";
import rjs from "@radiant-core/radiantjs";

const { Script, PrivateKey, Transaction } = rjs;

// ============================================================================
// Fixtures
// ============================================================================

const makeCEK = (fill = 0xab) => new Uint8Array(32).fill(fill);
const TOKEN_REF = "a".repeat(64) + ":0";

// Deterministic WIF for signing tests (testnet-safe dummy)
const TEST_WIF = new PrivateKey().toWIF();
const TEST_ADDR = new PrivateKey(TEST_WIF).toAddress().toString();

// ============================================================================
// createRevealProof
// ============================================================================

describe("createRevealProof", () => {
  it("builds a well-formed reveal proof + OP_RETURN script", () => {
    const cek = makeCEK();
    const { script, proof } = createRevealProof(TOKEN_REF, cek);

    expect(proof.v).toBe(REVEAL_VERSION);
    expect(proof.p).toEqual([GLYPH_TIMELOCK]);
    expect(proof.action).toBe("reveal");
    expect(proof.token_ref).toBe(TOKEN_REF);
    expect(proof.cek).toBe(bytesToHex(cek));
    expect(proof.cek_hash).toBe(`sha256:${bytesToHex(sha256(cek))}`);

    // Script starts with OP_RETURN
    const scriptObj = new Script(script);
    expect(scriptObj.chunks[0].opcodenum).toBe(rjs.Opcode.OP_RETURN);
  });

  it("includes optional hint when provided", () => {
    const { proof } = createRevealProof(TOKEN_REF, makeCEK(), {
      hint: "My birthday present",
    });
    expect(proof.hint).toBe("My birthday present");
  });

  it("rejects a CEK of the wrong length", () => {
    expect(() =>
      createRevealProof(TOKEN_REF, new Uint8Array(16))
    ).toThrow(/32 bytes/);
  });

  it("rejects an invalid token_ref", () => {
    expect(() =>
      createRevealProof("not-a-ref", makeCEK())
    ).toThrow(/token_ref/);
  });

  it("rejects a CEK that doesn't match a provided commitment hash", () => {
    const cek = makeCEK(0xab);
    const wrongHash =
      "sha256:" + bytesToHex(sha256(makeCEK(0xcd))); // hash of a different CEK
    expect(() =>
      createRevealProof(TOKEN_REF, cek, { cekHash: wrongHash })
    ).toThrow(/does not match/);
  });

  it("accepts a provided commitment hash that matches the CEK", () => {
    const cek = makeCEK();
    const hash = "sha256:" + bytesToHex(sha256(cek));
    const { proof } = createRevealProof(TOKEN_REF, cek, { cekHash: hash });
    expect(proof.cek_hash).toBe(hash);
  });
});

// ============================================================================
// parseRevealProof
// ============================================================================

describe("parseRevealProof", () => {
  it("round-trips a reveal proof via its OP_RETURN script", () => {
    const cek = makeCEK();
    const { script, proof } = createRevealProof(TOKEN_REF, cek, {
      hint: "hello",
    });
    const parsed = parseRevealProof(script);
    expect(parsed).toEqual(proof);
  });

  it("returns undefined for a non-reveal script", () => {
    const s = new Script()
      .add(rjs.Opcode.OP_RETURN)
      .add(Buffer.from("aabbcc", "hex"))
      .toHex();
    expect(parseRevealProof(s)).toBeUndefined();
  });

  it("returns undefined when marker is wrong (e.g. burn marker 0x06)", () => {
    const badScript = new Script()
      .add(rjs.Opcode.OP_RETURN)
      .add(Buffer.from("676c79", "hex")) // gly magic
      .add(Buffer.from([REVEAL_VERSION]))
      .add(Buffer.from([0x06])) // burn marker
      .add(Buffer.from("a0", "hex"))
      .toHex();
    expect(parseRevealProof(badScript)).toBeUndefined();
  });

  it("accepts an rjs.Script input (not just hex string)", () => {
    const { script } = createRevealProof(TOKEN_REF, makeCEK());
    const scriptObj = new Script(script);
    expect(parseRevealProof(scriptObj)).toBeDefined();
  });
});

// ============================================================================
// validateReveal
// ============================================================================

describe("validateReveal", () => {
  // Helper: build a tx with just a reveal OP_RETURN output (no inputs required
  // for parsing / validation)
  const buildTxWithReveal = (script: string): rjs.Transaction => {
    const tx = new Transaction();
    tx.addOutput(
      new Transaction.Output({
        script: new Script(script),
        satoshis: 0,
      })
    );
    return tx;
  };

  it("validates a well-formed reveal tx", () => {
    const cek = makeCEK();
    const cekHash = "sha256:" + bytesToHex(sha256(cek));
    const { script } = createRevealProof(TOKEN_REF, cek);
    const tx = buildTxWithReveal(script);

    const result = validateReveal(tx, TOKEN_REF, cekHash);
    expect(result.valid).toBe(true);
    expect(result.proof?.cek).toBe(bytesToHex(cek));
  });

  it("rejects when token_ref does not match", () => {
    const { script } = createRevealProof(TOKEN_REF, makeCEK());
    const tx = buildTxWithReveal(script);
    const other = "b".repeat(64) + ":0";
    const result = validateReveal(tx, other);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Token ref mismatch/);
  });

  it("rejects when CEK does not match on-chain commitment", () => {
    const cek = makeCEK(0xab);
    const { script } = createRevealProof(TOKEN_REF, cek);
    const tx = buildTxWithReveal(script);
    const wrongCommitment = "sha256:" + bytesToHex(sha256(makeCEK(0xcd)));
    const result = validateReveal(tx, TOKEN_REF, wrongCommitment);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/commitment/);
  });

  it("rejects a tx with multiple reveal outputs", () => {
    const { script } = createRevealProof(TOKEN_REF, makeCEK());
    const tx = new Transaction();
    tx.addOutput(new Transaction.Output({ script: new Script(script), satoshis: 0 }));
    tx.addOutput(new Transaction.Output({ script: new Script(script), satoshis: 0 }));
    const result = validateReveal(tx, TOKEN_REF);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Multiple/);
  });

  it("rejects a tx with no reveal output", () => {
    const tx = new Transaction();
    tx.addOutput(
      new Transaction.Output({
        script: new Script().add(rjs.Opcode.OP_RETURN).add(Buffer.from("00")),
        satoshis: 0,
      })
    );
    const result = validateReveal(tx, TOKEN_REF);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/No reveal proof/);
  });
});

// ============================================================================
// buildRevealTx
// ============================================================================

describe("buildRevealTx", () => {
  // Build a fake UTXO owned by TEST_ADDR
  const fakeUtxo = () => ({
    txid: "f".repeat(64),
    vout: 0,
    value: 100_000_000, // 1 RXD
    script: rjs.Script.fromAddress(TEST_ADDR).toHex(),
  });

  it("builds a signed reveal tx with OP_RETURN + change output", () => {
    const cek = makeCEK();
    const result = buildRevealTx(
      TEST_ADDR,
      TEST_WIF,
      { tokenRef: TOKEN_REF, cek },
      [fakeUtxo()]
    );

    expect(result.txid).toBeDefined();
    expect(result.proof.action).toBe("reveal");
    expect(result.proof.token_ref).toBe(TOKEN_REF);

    // First output must be the reveal OP_RETURN
    const firstOutScript = result.tx.outputs[0].script.toHex();
    expect(parseRevealProof(firstOutScript)).toBeDefined();

    // Change output exists
    expect(result.tx.outputs.length).toBeGreaterThanOrEqual(2);
    expect(result.photonsReturned).toBeGreaterThan(0);
  });

  it("round-trips: built tx passes validateReveal", () => {
    const cek = makeCEK();
    const cekHash = "sha256:" + bytesToHex(sha256(cek));
    const result = buildRevealTx(
      TEST_ADDR,
      TEST_WIF,
      { tokenRef: TOKEN_REF, cek, cekHash },
      [fakeUtxo()]
    );

    const validation = validateReveal(result.tx, TOKEN_REF, cekHash);
    expect(validation.valid).toBe(true);
  });

  it("throws when UTXOs are insufficient to pay the fee", () => {
    const tinyUtxo = { ...fakeUtxo(), value: 1 };
    expect(() =>
      buildRevealTx(
        TEST_ADDR,
        TEST_WIF,
        { tokenRef: TOKEN_REF, cek: makeCEK() },
        [tinyUtxo]
      )
    ).toThrow(/fund/i);
  });
});

// ============================================================================
// estimateRevealOutputSize
// ============================================================================

describe("estimateRevealOutputSize", () => {
  it("returns a positive byte count", () => {
    expect(estimateRevealOutputSize()).toBeGreaterThan(0);
  });

  it("grows with a longer hint", () => {
    const noHint = estimateRevealOutputSize();
    const withHint = estimateRevealOutputSize("a".repeat(50));
    expect(withHint).toBeGreaterThan(noHint);
  });
});
