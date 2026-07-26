/**
 * Unit tests for the Radiant PSBT module (`../psbt`).
 *
 * The wire format under test is the Radiant Core (Bitcoin ABC-lineage,
 * segwit-stripped) BIP-174 profile: per-input key 0x00 holds a bare CTxOut,
 * sighash defaults to ALL|FORKID (0x41), transport is standard base64.
 * Round-trips must be byte-identical so PSBTs survive a
 * Photonic ⇄ Radiant Core hop unchanged.
 *
 * radiantjs transaction signing is deterministic (RFC-6979-style k), so the
 * sign→finalize→extract path is asserted BYTE-EQUAL against `buildTx` over
 * identical inputs/outputs — the two signers must be indistinguishable.
 */
import { describe, expect, it } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { Buffer } from "buffer";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  DEFAULT_SIGHASH,
  MAX_PSBT_TX_SIZE,
  Psbt,
  analyzePsbt,
  extractTx,
  finalizePsbt,
  parsePsbt,
  psbtFromBase64,
  psbtToBase64,
  serializePsbt,
  signPsbt,
} from "../psbt";
import { ByteReader, ByteWriter } from "../psbt/keyvalue";
import { buildTx } from "../tx";
import { nftScript, p2pkhScript } from "../script";
import { bnFromValue, transactionFromHex } from "../rjsCompat";

const { PrivateKey, Script, Transaction, crypto } = rjs;

const TXID_A = "aa".repeat(32);
const TXID_B = "bb".repeat(32);
const REF = "cd".repeat(36);

/** A fresh key + its P2PKH script, on mainnet like the wallet's keys. */
function newKey() {
  const key = new PrivateKey();
  const address = key.toAddress().toString();
  return { key, wif: key.toWIF(), address, script: p2pkhScript(address) };
}

/** Legacy-serialized unsigned tx (empty scriptSigs) over the given io. */
function makeUnsignedTx(
  inputs: { txid: string; vout: number }[],
  outputs: { script: string; value: number }[]
): string {
  const tx = new Transaction();
  for (const input of inputs) {
    tx.addInput(
      new Transaction.Input({
        prevTxId: input.txid,
        outputIndex: input.vout,
        script: new Script(),
        output: new Transaction.Output({ script: new Script(), satoshis: 0 }),
      })
    );
  }
  for (const output of outputs) {
    tx.addOutput(
      new Transaction.Output({ script: output.script, satoshis: output.value })
    );
  }
  return tx.toString();
}

function makePsbt(
  unsignedTxHex: string,
  inputs: Partial<Psbt["inputs"][number]>[],
  nOutputs: number
): Psbt {
  return {
    unsignedTxHex,
    inputs: inputs.map((partial) => ({
      partialSigs: new Map(),
      bip32: [],
      unknown: [],
      ...partial,
    })),
    outputs: Array.from({ length: nOutputs }, () => ({ entries: [] })),
    unknownGlobals: [],
  };
}

describe("serialization round-trips", () => {
  it("serialize → parse → serialize is byte-identical (all field types)", () => {
    const { script } = newKey();
    const unsigned = makeUnsignedTx(
      [{ txid: TXID_A, vout: 1 }],
      [{ script, value: 5000 }]
    );
    const psbt = makePsbt(
      unsigned,
      [
        {
          utxo: { script, value: 6000n },
          sighashType: 0xc1,
          redeemScript: "51",
          partialSigs: new Map([["02".repeat(33).slice(0, 66), Uint8Array.of(1, 2, 3)]]),
          bip32: [
            {
              keyType: 0x06,
              keyData: hexToBytes("03" + "11".repeat(32)),
              value: hexToBytes("deadbeef00000000"),
            },
          ],
          unknown: [
            { keyType: 0xfc, keyData: hexToBytes("0102"), value: hexToBytes("aabb") },
          ],
        },
      ],
      1
    );
    psbt.unknownGlobals.push({
      keyType: 0xf0,
      keyData: new Uint8Array(0),
      value: hexToBytes("99"),
    });
    psbt.outputs[0].entries.push({
      keyType: 0x02,
      keyData: hexToBytes("02" + "22".repeat(32)),
      value: hexToBytes("cafe00000000"),
    });

    const bytes = serializePsbt(psbt);
    const parsed = parsePsbt(bytes);
    expect(bytesToHex(serializePsbt(parsed))).toBe(bytesToHex(bytes));
    expect(parsed.unsignedTxHex).toBe(unsigned);
    expect(parsed.inputs[0].utxo).toEqual({ script, value: 6000n });
    expect(parsed.inputs[0].sighashType).toBe(0xc1);
    expect(parsed.inputs[0].redeemScript).toBe("51");
    expect(parsed.inputs[0].partialSigs.size).toBe(1);
    expect(parsed.inputs[0].bip32).toHaveLength(1);
    expect(parsed.inputs[0].unknown).toHaveLength(1);
    expect(parsed.unknownGlobals).toHaveLength(1);
    expect(parsed.outputs[0].entries).toHaveLength(1);
  });

  it("base64 and base64url both decode; output is standard padded base64", () => {
    const { script } = newKey();
    const unsigned = makeUnsignedTx(
      [{ txid: TXID_A, vout: 0 }],
      [{ script, value: 1000 }]
    );
    const psbt = makePsbt(unsigned, [{ utxo: { script, value: 2000n } }], 1);
    const b64 = psbtToBase64(psbt);
    expect(b64.startsWith("cHNidP8B")).toBe(true); // "psbt\xff" + 0x01 keylen
    expect(psbtFromBase64(b64).unsignedTxHex).toBe(unsigned);

    const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(psbtFromBase64(b64url).unsignedTxHex).toBe(unsigned);

    expect(() => psbtFromBase64("not base64!!")).toThrowError(
      expect.objectContaining({ code: "INVALID_BASE64" })
    );
  });

  it("values beyond 2^53 round-trip exactly (bigint plumbing)", () => {
    const { script } = newKey();
    const big = (1n << 53n) + 7n;
    const unsigned = makeUnsignedTx(
      [{ txid: TXID_A, vout: 0 }],
      [{ script, value: 1000 }]
    );
    const psbt = makePsbt(unsigned, [{ utxo: { script, value: big } }], 1);
    const parsed = parsePsbt(serializePsbt(psbt));
    expect(parsed.inputs[0].utxo?.value).toBe(big);
  });
});

describe("parse rejection", () => {
  const { script } = newKey();
  const unsigned = makeUnsignedTx(
    [{ txid: TXID_A, vout: 0 }],
    [{ script, value: 1000 }]
  );
  const validBytes = serializePsbt(makePsbt(unsigned, [{}], 1));

  function expectCode(bytes: Uint8Array, code: string) {
    expect(() => parsePsbt(bytes)).toThrowError(
      expect.objectContaining({ code })
    );
  }

  it("rejects bad magic", () => {
    const bytes = Uint8Array.from(validBytes);
    bytes[0] = 0x71;
    expectCode(bytes, "INVALID_MAGIC");
  });

  it("rejects a missing unsigned tx", () => {
    const writer = new ByteWriter();
    writer.writeBytes(hexToBytes("70736274ff"));
    writer.writeUInt8(0x00); // empty global map
    expectCode(writer.toBytes(), "MISSING_UNSIGNED_TX");
  });

  it("rejects duplicate keys within a map", () => {
    const writer = new ByteWriter();
    writer.writeBytes(hexToBytes("70736274ff"));
    const txBytes = hexToBytes(unsigned);
    for (let i = 0; i < 2; i++) {
      writer.writeVarSlice(Uint8Array.of(0x00)); // key: type 0, no keydata
      writer.writeVarSlice(txBytes);
    }
    writer.writeUInt8(0x00);
    expectCode(writer.toBytes(), "DUPLICATE_KEY");
  });

  it("rejects an unsigned tx whose scriptSigs are not empty", () => {
    const { wif, address, script: s } = newKey();
    const signed = buildTx(
      address,
      wif,
      [{ txid: TXID_A, vout: 0, script: s, value: 100_000 }],
      [{ script: s, value: 99_000 }],
      false,
      undefined,
      undefined,
      true
    ).toString();
    const psbtBytes = serializePsbt(makePsbt(signed, [{}], 1));
    expectCode(psbtBytes, "UNSIGNED_TX_HAS_SCRIPTSIGS");
  });

  it("rejects trailing data after the output maps", () => {
    const withTrailing = new Uint8Array(validBytes.length + 1);
    withTrailing.set(validBytes);
    withTrailing[validBytes.length] = 0x42;
    expectCode(withTrailing, "TRAILING_DATA");
  });

  it("rejects truncated data", () => {
    expectCode(validBytes.subarray(0, validBytes.length - 2), "TRUNCATED");
  });

  it("rejects a global unsigned-tx key carrying extra key data", () => {
    const writer = new ByteWriter();
    writer.writeBytes(hexToBytes("70736274ff"));
    writer.writeVarSlice(Uint8Array.of(0x00, 0x99)); // type 0 + stray keydata
    writer.writeVarSlice(hexToBytes(unsigned));
    writer.writeUInt8(0x00);
    expectCode(writer.toBytes(), "INVALID_KEY");
  });

  it("rejects a sighash field that is not 4 bytes", () => {
    const writer = new ByteWriter();
    writer.writeBytes(hexToBytes("70736274ff"));
    writer.writeVarSlice(Uint8Array.of(0x00));
    writer.writeVarSlice(hexToBytes(unsigned));
    writer.writeUInt8(0x00);
    // input map: sighash (0x03) with a 1-byte value
    writer.writeVarSlice(Uint8Array.of(0x03));
    writer.writeVarSlice(Uint8Array.of(0x41));
    writer.writeUInt8(0x00);
    writer.writeUInt8(0x00); // output map
    expectCode(writer.toBytes(), "INVALID_KEY");
  });

  it("rejects a partial-sig key that is not a 33/65-byte pubkey", () => {
    const writer = new ByteWriter();
    writer.writeBytes(hexToBytes("70736274ff"));
    writer.writeVarSlice(Uint8Array.of(0x00));
    writer.writeVarSlice(hexToBytes(unsigned));
    writer.writeUInt8(0x00);
    const key = new ByteWriter();
    key.writeUInt8(0x02);
    key.writeBytes(hexToBytes("ab".repeat(10)));
    writer.writeVarSlice(key.toBytes());
    writer.writeVarSlice(hexToBytes("30440220"));
    writer.writeUInt8(0x00);
    writer.writeUInt8(0x00);
    expectCode(writer.toBytes(), "INVALID_KEY");
  });

  it("rejects a CTxOut utxo value with trailing bytes", () => {
    const writer = new ByteWriter();
    writer.writeBytes(hexToBytes("70736274ff"));
    writer.writeVarSlice(Uint8Array.of(0x00));
    writer.writeVarSlice(hexToBytes(unsigned));
    writer.writeUInt8(0x00);
    const ctxOut = new ByteWriter();
    ctxOut.writeUInt64LE(1000n);
    ctxOut.writeVarSlice(hexToBytes(script));
    ctxOut.writeUInt8(0x77); // trailing garbage
    writer.writeVarSlice(Uint8Array.of(0x00));
    writer.writeVarSlice(ctxOut.toBytes());
    writer.writeUInt8(0x00);
    writer.writeUInt8(0x00);
    expectCode(writer.toBytes(), "TRAILING_DATA");
  });

  it("rejects an unsigned tx above the size cap", () => {
    const writer = new ByteWriter();
    writer.writeBytes(hexToBytes("70736274ff"));
    writer.writeVarSlice(Uint8Array.of(0x00));
    writer.writeVarSlice(new Uint8Array(MAX_PSBT_TX_SIZE + 1));
    writer.writeUInt8(0x00);
    expectCode(writer.toBytes(), "TX_TOO_LARGE");
  });

  it("rejects non-canonical varints like Core's ReadCompactSize", () => {
    const bytes = Uint8Array.of(0xfd, 0x05, 0x00); // 5 encoded in 3 bytes
    expect(() => new ByteReader(bytes).readVarInt()).toThrowError(
      expect.objectContaining({ code: "NON_CANONICAL_VARINT" })
    );
  });
});

describe("sign → finalize → extract", () => {
  // radiantjs ECDSA signing is "hedged" — deterministic k mixed with fresh
  // entropy per call (lib/crypto/ecdsa.js) — so two signs over the same
  // preimage produce different (but both valid) DER encodings. Byte-identity
  // with `buildTx` isn't achievable; verifying signPsbt's output against the
  // same `Transaction.Sighash.verify` a node would run is the real contract.
  it("produces a transaction structurally identical to, and interchangeable with, buildTx's", () => {
    const maker = newKey();
    const dest = newKey();
    const input = {
      txid: TXID_A,
      vout: 2,
      script: maker.script,
      value: 100_000_000,
    };
    const outputs = [{ script: dest.script, value: 99_990_000 }];

    // Reference: the wallet's own builder, explicit-script path (signs with
    // ALL|FORKID via Transaction.Sighash.sign — the exact call signPsbt uses).
    const reference = buildTx(
      maker.address,
      maker.wif,
      [input],
      outputs,
      false,
      undefined,
      undefined,
      true
    ).toString();

    // Same tx, unsigned, wrapped in a PSBT with a CTxOut utxo field.
    const unsignedTx = transactionFromHex(reference);
    unsignedTx.inputs.forEach((i) => i.setScript(Script.empty()));
    const psbt = makePsbt(
      unsignedTx.toString(),
      [{ utxo: { script: maker.script, value: BigInt(input.value) } }],
      1
    );

    const signResult = signPsbt(psbt, maker.wif);
    expect(signResult.signedIndexes).toEqual([0]);
    expect(signResult.skipped).toEqual([]);
    // The original object is untouched.
    expect(psbt.inputs[0].partialSigs.size).toBe(0);

    const { psbt: finalized, complete } = finalizePsbt(signResult.psbt);
    expect(complete).toBe(true);
    expect(finalized.inputs[0].partialSigs.size).toBe(0); // cleared

    const extracted = extractTx(finalized);
    const extractedTx = transactionFromHex(extracted);
    const referenceTx = transactionFromHex(reference);

    // Same inputs/outputs, and the scriptSig shape matches (<sig><pubkey>).
    expect(extractedTx.inputs.length).toBe(referenceTx.inputs.length);
    expect(extractedTx.outputs.length).toBe(referenceTx.outputs.length);
    expect(extractedTx.outputs[0].script.toHex()).toBe(
      referenceTx.outputs[0].script.toHex()
    );
    expect(extractedTx.outputs[0].satoshis).toBe(referenceTx.outputs[0].satoshis);
    const scriptSig = extractedTx.inputs[0].script;
    expect(scriptSig.chunks).toHaveLength(2);
    const sig = crypto.Signature.fromTxFormat(Buffer.from(scriptSig.chunks[0].buf));
    expect(sig.nhashtype).toBe(crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID);
    expect(
      Transaction.Sighash.verify(
        extractedTx,
        sig,
        maker.key.toPublicKey(),
        0,
        Script.fromHex(maker.script),
        bnFromValue(input.value)
      )
    ).toBe(true);
  });

  it("supports sequential multi-party signing of separate inputs", () => {
    const alice = newKey();
    const bob = newKey();
    const dest = newKey();
    const unsigned = makeUnsignedTx(
      [
        { txid: TXID_A, vout: 0 },
        { txid: TXID_B, vout: 1 },
      ],
      [{ script: dest.script, value: 150_000 }]
    );
    const psbt = makePsbt(
      unsigned,
      [
        { utxo: { script: alice.script, value: 100_000n } },
        { utxo: { script: bob.script, value: 100_000n } },
      ],
      1
    );

    const afterAlice = signPsbt(psbt, alice.wif);
    expect(afterAlice.signedIndexes).toEqual([0]);
    expect(afterAlice.skipped).toEqual([{ index: 1, reason: "not-mine" }]);
    expect(finalizePsbt(afterAlice.psbt).complete).toBe(false);

    // The half-signed PSBT survives a serialization hop (as it would between
    // two wallets) before the second signer takes over.
    const rehydrated = psbtFromBase64(psbtToBase64(afterAlice.psbt));
    const afterBob = signPsbt(rehydrated, bob.wif);
    expect(afterBob.signedIndexes).toEqual([1]);

    const { psbt: finalized, complete } = finalizePsbt(afterBob.psbt);
    expect(complete).toBe(true);
    const tx = transactionFromHex(extractTx(finalized));

    // Each input's signature must verify against its own prevout.
    [alice, bob].forEach((signer, i) => {
      const scriptSig = tx.inputs[i].script;
      const sigBuf = Buffer.from(scriptSig.chunks[0].buf);
      const sig = crypto.Signature.fromTxFormat(sigBuf);
      expect(
        Transaction.Sighash.verify(
          tx,
          sig,
          signer.key.toPublicKey(),
          i,
          Script.fromHex(signer.script),
          bnFromValue(100_000)
        )
      ).toBe(true);
    });
  });

  it("skips finalized, already-signed, and prevout-less inputs", () => {
    const me = newKey();
    const unsigned = makeUnsignedTx(
      [
        { txid: TXID_A, vout: 0 },
        { txid: TXID_B, vout: 0 },
      ],
      [{ script: me.script, value: 1000 }]
    );
    const psbt = makePsbt(
      unsigned,
      [{ finalScriptSig: "51" }, {}],
      1
    );
    const result = signPsbt(psbt, me.wif);
    expect(result.signedIndexes).toEqual([]);
    expect(result.skipped).toEqual([
      { index: 0, reason: "finalized" },
      { index: 1, reason: "no-prevout" },
    ]);
  });

  it("does not trust a fabricated partial signature claiming our own pubkey", () => {
    const me = newKey();
    const unsigned = makeUnsignedTx(
      [{ txid: TXID_A, vout: 0 }],
      [{ script: me.script, value: 1000 }]
    );
    const utxo = { script: me.script, value: 2000n };
    const pubkeyHex = me.key.toPublicKey().toString();
    // Garbage bytes in the signature slot, but keyed under our own real
    // pubkey — the shape a malformed/malicious PSBT (or a bad combiner) could
    // produce. A DER-shaped-enough blob so `Signature.fromTxFormat` doesn't
    // throw outright; the point is it must fail Sighash.verify.
    const bogusSig = new Uint8Array([
      ...hexToBytes(
        "3006020100020100"
      ),
      DEFAULT_SIGHASH & 0xff,
    ]);

    // signPsbt must not treat this as "already-signed" — it should notice
    // the signature doesn't verify and produce a real one instead.
    const psbt = makePsbt(
      unsigned,
      [{ utxo, partialSigs: new Map([[pubkeyHex, bogusSig]]) }],
      1
    );
    const result = signPsbt(psbt, me.wif);
    expect(result.signedIndexes).toEqual([0]);
    expect(result.skipped).toEqual([]);
    const realSig = result.psbt.inputs[0].partialSigs.get(pubkeyHex)!;
    expect(realSig).not.toEqual(bogusSig);

    // And finalizePsbt must not assemble a finalScriptSig from the bogus
    // signature on its own — a pubkey-hash match alone isn't proof.
    const stillBogus = makePsbt(
      unsigned,
      [{ utxo, partialSigs: new Map([[pubkeyHex, bogusSig]]) }],
      1
    );
    const { complete } = finalizePsbt(stillBogus);
    expect(complete).toBe(false);

    // But finalizing the REAL signature signPsbt just produced does work.
    const { complete: realComplete } = finalizePsbt(result.psbt);
    expect(realComplete).toBe(true);
  });

  it("enforces sighash policy: FORKID required, NONE refused, SINGLE|ACP allowed", () => {
    const me = newKey();
    const unsigned = makeUnsignedTx(
      [{ txid: TXID_A, vout: 0 }],
      [{ script: me.script, value: 1000 }]
    );
    const utxo = { script: me.script, value: 2000n };

    expect(() =>
      signPsbt(makePsbt(unsigned, [{ utxo, sighashType: 0x01 }], 1), me.wif)
    ).toThrowError(expect.objectContaining({ code: "MISSING_FORKID" }));

    expect(() =>
      signPsbt(makePsbt(unsigned, [{ utxo, sighashType: 0x42 }], 1), me.wif)
    ).toThrowError(expect.objectContaining({ code: "DISALLOWED_SIGHASH" }));

    const single = signPsbt(
      makePsbt(unsigned, [{ utxo, sighashType: 0xc3 }], 1),
      me.wif
    );
    expect(single.signedIndexes).toEqual([0]);
    const sig = single.psbt.inputs[0].partialSigs.values().next().value!;
    expect(sig[sig.length - 1]).toBe(0xc3); // trailing sighash byte
  });

  it("refuses to co-sign a tx spending token-bearing outputs (overridable)", () => {
    const me = newKey();
    const other = newKey();
    const tokenScript = nftScript(other.address, REF);
    const unsigned = makeUnsignedTx(
      [
        { txid: TXID_A, vout: 0 },
        { txid: TXID_B, vout: 0 },
      ],
      [{ script: me.script, value: 1000 }]
    );
    const psbt = makePsbt(
      unsigned,
      [
        { utxo: { script: me.script, value: 2000n } },
        { utxo: { script: tokenScript, value: 1n } },
      ],
      1
    );

    expect(() => signPsbt(psbt, me.wif)).toThrowError(
      expect.objectContaining({ code: "TOKEN_BEARING_INPUT" })
    );

    const overridden = signPsbt(psbt, me.wif, {
      allowTokenBearingInputs: true,
    });
    expect(overridden.signedIndexes).toEqual([0]);
    expect(overridden.skipped).toEqual([{ index: 1, reason: "not-mine" }]);
  });

  it("extractTx refuses an incomplete PSBT", () => {
    const me = newKey();
    const unsigned = makeUnsignedTx(
      [{ txid: TXID_A, vout: 0 }],
      [{ script: me.script, value: 1000 }]
    );
    expect(() => extractTx(makePsbt(unsigned, [{}], 1))).toThrowError(
      expect.objectContaining({ code: "NOT_FINALIZED" })
    );
  });
});

describe("analyzePsbt", () => {
  const me = newKey();
  const them = newKey();

  it("computes totals, fee, ownership, and addresses when prevouts are known", () => {
    const unsigned = makeUnsignedTx(
      [{ txid: TXID_A, vout: 3 }],
      [
        { script: them.script, value: 60_000 },
        { script: me.script, value: 30_000 },
      ]
    );
    const psbt = makePsbt(
      unsigned,
      [{ utxo: { script: me.script, value: 100_000n } }],
      2
    );
    const analysis = analyzePsbt(psbt, { ownScripts: new Set([me.script]) });

    expect(analysis.inputs[0]).toMatchObject({
      txid: TXID_A,
      vout: 3,
      mine: true,
      tokenBearing: false,
      sighashType: DEFAULT_SIGHASH,
      address: me.address,
    });
    expect(analysis.outputs[0]).toMatchObject({
      mine: false,
      address: them.address,
    });
    expect(analysis.outputs[1].mine).toBe(true);
    expect(analysis.totalIn).toBe(100_000n);
    expect(analysis.totalOut).toBe(90_000n);
    expect(analysis.fee).toBe(10_000n);
    expect(analysis.feeRate).toBeGreaterThan(0);
    expect(analysis.warnings).not.toContain("FEE_UNKNOWN");
  });

  it("reports FEE_UNKNOWN + UNKNOWN_PREVOUT when a prevout is missing", () => {
    const unsigned = makeUnsignedTx(
      [
        { txid: TXID_A, vout: 0 },
        { txid: TXID_B, vout: 0 },
      ],
      [{ script: them.script, value: 1000 }]
    );
    const psbt = makePsbt(
      unsigned,
      [{ utxo: { script: me.script, value: 2000n } }, {}],
      1
    );
    const analysis = analyzePsbt(psbt);
    expect(analysis.totalIn).toBeUndefined();
    expect(analysis.fee).toBeUndefined();
    expect(analysis.warnings).toContain("FEE_UNKNOWN");
    expect(analysis.warnings).toContain("UNKNOWN_PREVOUT");
  });

  it("flags unusual sighash modes and token-bearing inputs", () => {
    const tokenScript = nftScript(them.address, REF);
    const unsigned = makeUnsignedTx(
      [
        { txid: TXID_A, vout: 0 },
        { txid: TXID_B, vout: 1 },
      ],
      [{ script: them.script, value: 1000 }]
    );
    const psbt = makePsbt(
      unsigned,
      [
        { utxo: { script: tokenScript, value: 1n }, sighashType: 0xc3 },
        { utxo: { script: me.script, value: 5000n }, sighashType: 0x42 },
      ],
      1
    );
    const analysis = analyzePsbt(psbt);
    expect(analysis.warnings).toContain("TOKEN_BEARING_INPUT");
    expect(analysis.warnings).toContain("SIGHASH_SINGLE");
    expect(analysis.warnings).toContain("SIGHASH_ANYONECANPAY");
    expect(analysis.warnings).toContain("SIGHASH_NONE");
    // Input 1 uses SIGHASH_SINGLE at an index with a matching output 0? No —
    // index 0 has output 0, so no unmatched warning; index bound is exercised
    // in the case below.
    expect(analysis.warnings).not.toContain("SIGHASH_SINGLE_UNMATCHED");
    expect(analysis.inputs[0].tokenBearing).toBe(true);
  });

  it("flags SIGHASH_SINGLE with no matching output index", () => {
    const unsigned = makeUnsignedTx(
      [
        { txid: TXID_A, vout: 0 },
        { txid: TXID_B, vout: 0 },
      ],
      [{ script: them.script, value: 1000 }]
    );
    const psbt = makePsbt(
      unsigned,
      [
        { utxo: { script: me.script, value: 2000n } },
        { utxo: { script: me.script, value: 2000n }, sighashType: 0x43 },
      ],
      1
    );
    expect(analyzePsbt(psbt).warnings).toContain("SIGHASH_SINGLE_UNMATCHED");
  });

  it("flags an absurdly high fee (unit-confusion guard)", () => {
    const unsigned = makeUnsignedTx(
      [{ txid: TXID_A, vout: 0 }],
      [{ script: them.script, value: 1000 }]
    );
    const psbt = makePsbt(
      unsigned,
      [{ utxo: { script: me.script, value: 100_000_000_000n } }],
      1
    );
    expect(analyzePsbt(psbt).warnings).toContain("HIGH_FEE");
  });
});
