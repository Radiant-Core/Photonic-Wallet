/**
 * Radiant PSBT container — parse/serialize for the BIP-174 profile Radiant
 * Core implements (the Bitcoin ABC segwit-stripped variant, Core ~0.17 base).
 * Wire-format ground truth is Radiant Core `src/psbt.h`/`src/psbt.cpp`; this
 * module must stay byte-compatible with it so PSBTs round-trip between
 * Photonic and `walletcreatefundedpsbt`/`walletprocesspsbt`/`finalizepsbt`.
 *
 * Profile notes (deviations from mainline BIP-174):
 *  - Per-input key 0x00 (`PSBT_IN_UTXO`) holds a bare CTxOut
 *    (int64-LE value ‖ varint-len scriptPubKey) — NOT a full previous
 *    transaction. This is safe on Radiant because the FORKID sighash commits
 *    to the spent output's script and value: lying about either just produces
 *    an invalid signature.
 *  - No witness key types exist (0x01/0x05/0x08 fall through to `unknown`).
 *  - The unsigned transaction is legacy-serialized (no witness marker).
 *  - Transport is standard base64; base64url is also accepted on parse for
 *    deep-link convenience.
 *
 * Unknown key-value pairs are preserved verbatim and re-emitted so combiner
 * semantics and forward compatibility hold. Serialization writes known fields
 * in Radiant Core's emission order, so a Core-produced PSBT round-trips
 * byte-identically.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { Buffer } from "buffer";
import { PsbtError } from "./errors";
import {
  ByteReader,
  ByteWriter,
  PsbtKeyValue,
  readKeyValueMap,
  writeKeyValue,
} from "./keyvalue";
import { transactionFromHex } from "../rjsCompat";

export type { PsbtKeyValue };

export const PSBT_MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);

export const PSBT_GLOBAL_UNSIGNED_TX = 0x00;
export const PSBT_IN_UTXO = 0x00;
export const PSBT_IN_PARTIAL_SIG = 0x02;
export const PSBT_IN_SIGHASH = 0x03;
export const PSBT_IN_REDEEM_SCRIPT = 0x04;
export const PSBT_IN_BIP32_DERIVATION = 0x06;
export const PSBT_IN_FINAL_SCRIPTSIG = 0x07;

/** Cap on the unsigned transaction, mirroring node-side sanity limits. */
export const MAX_PSBT_TX_SIZE = 100_000;

const MAX_I64 = (1n << 63n) - 1n;

/** The spent output an input commits to: CTxOut under key 0x00. */
export type PsbtUtxo = {
  /** scriptPubKey hex */
  script: string;
  /** photons — bigint because amounts can exceed 2^53 */
  value: bigint;
};

export type PsbtInput = {
  utxo?: PsbtUtxo;
  /** compressed/uncompressed pubkey hex → DER sig ‖ sighash byte */
  partialSigs: Map<string, Uint8Array>;
  /** 4-byte LE uint32 on the wire */
  sighashType?: number;
  /** hex; parsed & preserved, not consumed by the P2PKH signer */
  redeemScript?: string;
  /** raw 0x06 entries (pubkey key-data + fingerprint/path value), preserved */
  bip32: PsbtKeyValue[];
  /** hex */
  finalScriptSig?: string;
  unknown: PsbtKeyValue[];
};

/**
 * Output maps are not interpreted in v1 — entries (redeem_script, bip32,
 * unknowns) are preserved verbatim, in order, for byte-identical round-trips.
 */
export type PsbtOutput = {
  entries: PsbtKeyValue[];
};

export type Psbt = {
  /** The global unsigned transaction, raw legacy-serialized hex. */
  unsignedTxHex: string;
  inputs: PsbtInput[];
  outputs: PsbtOutput[];
  /** Global entries other than the unsigned tx, preserved verbatim. */
  unknownGlobals: PsbtKeyValue[];
};

function requireEmptyKeyData(kv: PsbtKeyValue, what: string): void {
  if (kv.keyData.length > 0) {
    throw new PsbtError("INVALID_KEY", `${what} key must be a single type byte`);
  }
}

function requirePubkeyKeyData(kv: PsbtKeyValue, what: string): string {
  if (kv.keyData.length !== 33 && kv.keyData.length !== 65) {
    throw new PsbtError("INVALID_KEY", `${what} key must be a 33/65-byte pubkey`);
  }
  return bytesToHex(kv.keyData);
}

function parseUtxoValue(value: Uint8Array): PsbtUtxo {
  const reader = new ByteReader(value);
  const photons = reader.readUInt64LE();
  if (photons > MAX_I64) {
    throw new PsbtError("VALUE_OUT_OF_RANGE", "utxo value exceeds int64");
  }
  const script = reader.readVarSlice();
  if (!reader.eof()) {
    throw new PsbtError("TRAILING_DATA", "trailing bytes after utxo CTxOut");
  }
  return { script: bytesToHex(script), value: photons };
}

function serializeUtxoValue(utxo: PsbtUtxo): Uint8Array {
  if (utxo.value < 0n || utxo.value > MAX_I64) {
    throw new PsbtError("VALUE_OUT_OF_RANGE", "utxo value exceeds int64");
  }
  const writer = new ByteWriter();
  writer.writeUInt64LE(utxo.value);
  writer.writeVarSlice(hexToBytes(utxo.script));
  return writer.toBytes();
}

function parseInputMap(entries: PsbtKeyValue[]): PsbtInput {
  const input: PsbtInput = {
    partialSigs: new Map(),
    bip32: [],
    unknown: [],
  };
  for (const kv of entries) {
    switch (kv.keyType) {
      case PSBT_IN_UTXO:
        requireEmptyKeyData(kv, "input utxo");
        input.utxo = parseUtxoValue(kv.value);
        break;
      case PSBT_IN_PARTIAL_SIG: {
        const pubkey = requirePubkeyKeyData(kv, "partial signature");
        if (kv.value.length === 0) {
          throw new PsbtError("INVALID_KEY", "empty partial signature");
        }
        input.partialSigs.set(pubkey, kv.value);
        break;
      }
      case PSBT_IN_SIGHASH: {
        requireEmptyKeyData(kv, "sighash");
        if (kv.value.length !== 4) {
          throw new PsbtError("INVALID_KEY", "sighash value must be 4 bytes");
        }
        input.sighashType = new ByteReader(kv.value).readUInt32LE();
        break;
      }
      case PSBT_IN_REDEEM_SCRIPT:
        requireEmptyKeyData(kv, "redeem script");
        input.redeemScript = bytesToHex(kv.value);
        break;
      case PSBT_IN_BIP32_DERIVATION:
        requirePubkeyKeyData(kv, "bip32 derivation");
        input.bip32.push(kv);
        break;
      case PSBT_IN_FINAL_SCRIPTSIG:
        requireEmptyKeyData(kv, "final scriptSig");
        input.finalScriptSig = bytesToHex(kv.value);
        break;
      default:
        input.unknown.push(kv);
    }
  }
  return input;
}

/**
 * Emit an input map in Radiant Core's order: utxo; then (only while not yet
 * finalized) partial sigs, sighash, redeem script, bip32; then the final
 * scriptSig; then unknowns.
 */
function writeInputMap(writer: ByteWriter, input: PsbtInput): void {
  if (input.utxo) {
    writeKeyValue(writer, {
      keyType: PSBT_IN_UTXO,
      keyData: new Uint8Array(0),
      value: serializeUtxoValue(input.utxo),
    });
  }
  if (!input.finalScriptSig) {
    for (const [pubkey, sig] of input.partialSigs) {
      writeKeyValue(writer, {
        keyType: PSBT_IN_PARTIAL_SIG,
        keyData: hexToBytes(pubkey),
        value: sig,
      });
    }
    if (input.sighashType !== undefined) {
      const value = new ByteWriter();
      value.writeUInt32LE(input.sighashType);
      writeKeyValue(writer, {
        keyType: PSBT_IN_SIGHASH,
        keyData: new Uint8Array(0),
        value: value.toBytes(),
      });
    }
    if (input.redeemScript !== undefined) {
      writeKeyValue(writer, {
        keyType: PSBT_IN_REDEEM_SCRIPT,
        keyData: new Uint8Array(0),
        value: hexToBytes(input.redeemScript),
      });
    }
    for (const kv of input.bip32) writeKeyValue(writer, kv);
  }
  if (input.finalScriptSig !== undefined) {
    writeKeyValue(writer, {
      keyType: PSBT_IN_FINAL_SCRIPTSIG,
      keyData: new Uint8Array(0),
      value: hexToBytes(input.finalScriptSig),
    });
  }
  for (const kv of input.unknown) writeKeyValue(writer, kv);
  writer.writeUInt8(0x00);
}

/** Count of inputs/outputs in the unsigned tx, plus the scriptSig-empty check. */
function inspectUnsignedTx(hex: string): { nInputs: number; nOutputs: number } {
  let tx: ReturnType<typeof transactionFromHex>;
  try {
    tx = transactionFromHex(hex);
  } catch (err) {
    throw new PsbtError("INVALID_UNSIGNED_TX", `unparseable unsigned tx: ${err}`);
  }
  for (const input of tx.inputs) {
    if (input.script && input.script.toHex() !== "") {
      throw new PsbtError(
        "UNSIGNED_TX_HAS_SCRIPTSIGS",
        "unsigned tx must have empty scriptSigs"
      );
    }
  }
  return { nInputs: tx.inputs.length, nOutputs: tx.outputs.length };
}

export function parsePsbt(bytes: Uint8Array): Psbt {
  const reader = new ByteReader(bytes);
  const magic = reader.readBytes(PSBT_MAGIC.length);
  if (!PSBT_MAGIC.every((b, i) => magic[i] === b)) {
    throw new PsbtError("INVALID_MAGIC", "not a PSBT (bad magic)");
  }

  const globals = readKeyValueMap(reader);
  let unsignedTxHex: string | undefined;
  const unknownGlobals: PsbtKeyValue[] = [];
  for (const kv of globals) {
    if (kv.keyType === PSBT_GLOBAL_UNSIGNED_TX) {
      requireEmptyKeyData(kv, "global unsigned tx");
      if (kv.value.length > MAX_PSBT_TX_SIZE) {
        throw new PsbtError("TX_TOO_LARGE", "unsigned tx exceeds size cap");
      }
      unsignedTxHex = bytesToHex(kv.value);
    } else {
      unknownGlobals.push(kv);
    }
  }
  if (unsignedTxHex === undefined) {
    throw new PsbtError("MISSING_UNSIGNED_TX", "PSBT has no unsigned tx");
  }
  const { nInputs, nOutputs } = inspectUnsignedTx(unsignedTxHex);

  const inputs: PsbtInput[] = [];
  for (let i = 0; i < nInputs; i++) {
    inputs.push(parseInputMap(readKeyValueMap(reader)));
  }
  const outputs: PsbtOutput[] = [];
  for (let i = 0; i < nOutputs; i++) {
    outputs.push({ entries: readKeyValueMap(reader) });
  }
  if (!reader.eof()) {
    throw new PsbtError("TRAILING_DATA", "trailing bytes after output maps");
  }

  return { unsignedTxHex, inputs, outputs, unknownGlobals };
}

export function serializePsbt(psbt: Psbt): Uint8Array {
  const writer = new ByteWriter();
  writer.writeBytes(PSBT_MAGIC);

  writeKeyValue(writer, {
    keyType: PSBT_GLOBAL_UNSIGNED_TX,
    keyData: new Uint8Array(0),
    value: hexToBytes(psbt.unsignedTxHex),
  });
  for (const kv of psbt.unknownGlobals) writeKeyValue(writer, kv);
  writer.writeUInt8(0x00);

  for (const input of psbt.inputs) writeInputMap(writer, input);
  for (const output of psbt.outputs) {
    for (const kv of output.entries) writeKeyValue(writer, kv);
    writer.writeUInt8(0x00);
  }
  return writer.toBytes();
}

/**
 * Decode a base64 (or base64url) PSBT. Whitespace is tolerated at the edges;
 * the payload itself must be clean base64.
 */
export function psbtFromBase64(b64: string): Psbt {
  const s = b64.trim();
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    throw new PsbtError("INVALID_BASE64", "not base64");
  }
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bytes = Uint8Array.from(Buffer.from(padded, "base64"));
  // Buffer silently truncates malformed base64; a length check catches it.
  if (bytes.length !== Math.floor((padded.replace(/=/g, "").length * 3) / 4)) {
    throw new PsbtError("INVALID_BASE64", "malformed base64");
  }
  return parsePsbt(bytes);
}

/** Standard (padded) base64, matching Radiant Core's `EncodeBase64`. */
export function psbtToBase64(psbt: Psbt): string {
  return Buffer.from(serializePsbt(psbt)).toString("base64");
}

/** The declared spent output for input `i`, if the PSBT carries one. */
export function inputPrevout(psbt: Psbt, i: number): PsbtUtxo | undefined {
  return psbt.inputs[i]?.utxo;
}
