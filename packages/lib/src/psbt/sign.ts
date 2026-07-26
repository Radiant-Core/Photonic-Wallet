/**
 * Signer / finalizer / extractor roles for the Radiant PSBT profile.
 *
 * Signing MUST go through `rjs.Transaction.Sighash.sign` (the same call
 * `buildTx` uses): Radiant's FORKID sighash preimage carries an extra
 * push-ref-aware `hashOutputHashes` field that radiantjs implements and a
 * hand-rolled BIP-143 preimage would get wrong.
 *
 * v1 policy, mirroring Radiant Core's `SignPSBTInput` where it applies:
 *  - an input is only signable when its `utxo` (CTxOut) field is present;
 *  - only plain P2PKH inputs matching the provided key are signed;
 *  - FORKID is mandatory; SIGHASH_NONE is refused (outputs could be swapped
 *    after signing); ALL/SINGLE ± ANYONECANPAY are allowed;
 *  - transactions spending token-bearing UTXOs are refused outright unless
 *    explicitly overridden — co-signing one risks burning someone's tokens.
 */
import rjs from "@radiant-core/radiantjs";
import { Buffer } from "buffer";
import { bnFromValue, transactionFromHex } from "../rjsCompat";
import { isTokenBearing, p2pkhScript, parseP2pkhScript } from "../script";
import { PsbtError } from "./errors";
import { Psbt, PsbtInput } from "./psbt";

const { PrivateKey, PublicKey, Script, Transaction, crypto } = rjs;

const SIGHASH_ALL = 0x01;
const SIGHASH_NONE = 0x02;
const SIGHASH_SINGLE = 0x03;
const SIGHASH_FORKID = 0x40;
const SIGHASH_ANYONECANPAY = 0x80;

export const DEFAULT_SIGHASH = SIGHASH_ALL | SIGHASH_FORKID; // 0x41

export const DEFAULT_ALLOWED_SIGHASHES: readonly number[] = [
  SIGHASH_ALL | SIGHASH_FORKID,
  SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_ANYONECANPAY,
  SIGHASH_SINGLE | SIGHASH_FORKID,
  SIGHASH_SINGLE | SIGHASH_FORKID | SIGHASH_ANYONECANPAY,
];

export type SkipReason =
  | "not-mine"
  | "already-signed"
  | "finalized"
  | "no-prevout";

export type SignPsbtResult = {
  /** A new Psbt object with our signatures added; the input is not mutated. */
  psbt: Psbt;
  signedIndexes: number[];
  skipped: { index: number; reason: SkipReason }[];
};

export type SignPsbtOptions = {
  allowedSighashes?: readonly number[];
  /** Override the refusal to participate in txs spending token UTXOs. */
  allowTokenBearingInputs?: boolean;
};

/**
 * Verify an existing partial signature actually validates for this input,
 * rather than trusting a pubkey-hash match alone. A PSBT — from a
 * multi-party combiner flow, or simply malformed/malicious — can carry
 * garbage bytes in a signature slot that happens to claim our own pubkey;
 * without this check that garbage would be silently treated as "already
 * signed" (skipped in `signPsbt`) or assembled straight into a `finalScriptSig`
 * (`finalizePsbt`), reporting a transaction as `complete` when it isn't
 * validly signed at all.
 */
function isValidPartialSig(
  tx: ReturnType<typeof transactionFromHex>,
  index: number,
  utxo: { script: string; value: bigint },
  pubkeyHex: string,
  sigBytes: Uint8Array
): boolean {
  try {
    const sig = crypto.Signature.fromTxFormat(Buffer.from(sigBytes));
    return Transaction.Sighash.verify(
      tx,
      sig,
      PublicKey.fromHex(pubkeyHex),
      index,
      Script.fromHex(utxo.script),
      bnFromValue(utxo.value.toString())
    );
  } catch {
    return false;
  }
}

function cloneInput(input: PsbtInput): PsbtInput {
  return {
    ...input,
    partialSigs: new Map(input.partialSigs),
    bip32: [...input.bip32],
    unknown: [...input.unknown],
  };
}

function clonePsbt(psbt: Psbt): Psbt {
  return {
    unsignedTxHex: psbt.unsignedTxHex,
    inputs: psbt.inputs.map(cloneInput),
    outputs: psbt.outputs.map((o) => ({ entries: [...o.entries] })),
    unknownGlobals: [...psbt.unknownGlobals],
  };
}

/**
 * Sign every input the given key controls (utxo script === our P2PKH script).
 * Throws on policy violations; inputs that are simply not ours are skipped.
 */
export function signPsbt(
  psbt: Psbt,
  wif: string,
  opts?: SignPsbtOptions
): SignPsbtResult {
  const allowed = opts?.allowedSighashes ?? DEFAULT_ALLOWED_SIGHASHES;
  const privKey = PrivateKey.fromWIF(wif);
  const pubkeyHex = privKey.toPublicKey().toString();
  const ownScript = p2pkhScript(privKey.toAddress().toString());

  const tx = transactionFromHex(psbt.unsignedTxHex);
  if (tx.inputs.length !== psbt.inputs.length) {
    throw new PsbtError(
      "INVALID_UNSIGNED_TX",
      "input map count does not match unsigned tx"
    );
  }

  if (!opts?.allowTokenBearingInputs) {
    for (const [i, input] of psbt.inputs.entries()) {
      if (input.utxo && isTokenBearing(input.utxo.script)) {
        throw new PsbtError(
          "TOKEN_BEARING_INPUT",
          `input ${i} spends a token-bearing output`
        );
      }
    }
  }

  const out = clonePsbt(psbt);
  const signedIndexes: number[] = [];
  const skipped: { index: number; reason: SkipReason }[] = [];

  out.inputs.forEach((input, index) => {
    if (input.finalScriptSig !== undefined) {
      skipped.push({ index, reason: "finalized" });
      return;
    }
    if (!input.utxo) {
      skipped.push({ index, reason: "no-prevout" });
      return;
    }
    if (input.utxo.script !== ownScript) {
      skipped.push({ index, reason: "not-mine" });
      return;
    }
    const existingSig = input.partialSigs.get(pubkeyHex);
    if (
      existingSig &&
      isValidPartialSig(tx, index, input.utxo, pubkeyHex, existingSig)
    ) {
      skipped.push({ index, reason: "already-signed" });
      return;
    }
    // No existing signature, or an invalid one (garbage claiming our pubkey)
    // — either way, produce a real one below, overwriting anything bogus.

    const sighash = input.sighashType ?? DEFAULT_SIGHASH;
    if (!(sighash & SIGHASH_FORKID)) {
      throw new PsbtError(
        "MISSING_FORKID",
        `input ${index} requests a sighash without SIGHASH_FORKID`
      );
    }
    if ((sighash & 0x1f) === SIGHASH_NONE || !allowed.includes(sighash)) {
      throw new PsbtError(
        "DISALLOWED_SIGHASH",
        `input ${index} requests disallowed sighash 0x${sighash.toString(16)}`
      );
    }

    const sig = Transaction.Sighash.sign(
      tx,
      privKey,
      sighash,
      index,
      Script.fromHex(input.utxo.script),
      // String form dodges bn.js's 2^53 safe-integer limit.
      bnFromValue(input.utxo.value.toString())
    );
    input.partialSigs.set(
      pubkeyHex,
      Uint8Array.from(
        Buffer.concat([sig.toBuffer(), Buffer.from([sighash & 0xff])])
      )
    );
    signedIndexes.push(index);
  });

  return { psbt: out, signedIndexes, skipped };
}

/**
 * Finalize every P2PKH input that has a matching partial signature:
 * `final_scriptSig = <DER‖sighashByte> <pubkey>`, clearing the now-redundant
 * signing fields (BIP-174 finalizer semantics). Inputs that cannot be
 * finalized are left untouched. `complete` is true when every input carries a
 * final scriptSig.
 */
export function finalizePsbt(psbt: Psbt): { psbt: Psbt; complete: boolean } {
  const out = clonePsbt(psbt);
  const tx = transactionFromHex(out.unsignedTxHex);

  out.inputs.forEach((input, index) => {
    if (input.finalScriptSig !== undefined) return;
    if (!input.utxo) return;
    const { address: pkh } = parseP2pkhScript(input.utxo.script);
    if (!pkh) return; // not P2PKH — some other finalizer's job

    for (const [pubkeyHex, sig] of input.partialSigs) {
      const hash = crypto.Hash.sha256ripemd160(Buffer.from(pubkeyHex, "hex"));
      if (Buffer.from(hash).toString("hex") !== pkh) continue;
      // Confirm the signature actually validates before finalizing on it —
      // a pubkey-hash match alone doesn't prove the bytes in this slot are a
      // real signature (see `isValidPartialSig`).
      if (!isValidPartialSig(tx, index, input.utxo, pubkeyHex, sig)) continue;
      input.finalScriptSig = Script.empty()
        .add(Buffer.from(sig))
        .add(Buffer.from(pubkeyHex, "hex"))
        .toHex();
      input.partialSigs = new Map();
      input.sighashType = undefined;
      input.redeemScript = undefined;
      input.bip32 = [];
      break;
    }
  });

  const complete = out.inputs.every((i) => i.finalScriptSig !== undefined);
  return { psbt: out, complete };
}

/**
 * Extract the fully-signed network transaction (raw hex). Throws
 * NOT_FINALIZED if any input still lacks a final scriptSig.
 */
export function extractTx(psbt: Psbt): string {
  const tx = transactionFromHex(psbt.unsignedTxHex);
  if (tx.inputs.length !== psbt.inputs.length) {
    throw new PsbtError(
      "INVALID_UNSIGNED_TX",
      "input map count does not match unsigned tx"
    );
  }
  psbt.inputs.forEach((input, i) => {
    if (input.finalScriptSig === undefined) {
      throw new PsbtError("NOT_FINALIZED", `input ${i} is not finalized`);
    }
    tx.inputs[i].setScript(Script.fromHex(input.finalScriptSig));
  });
  return tx.toString();
}
