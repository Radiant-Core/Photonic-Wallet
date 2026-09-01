/**
 * Pure inspection of a PSBT for the approval UI: per-input/-output rows with
 * ownership flags, totals, fee (when every prevout is known), and typed
 * warnings. Ownership is injected by the caller (`ownScripts`) because this
 * module cannot touch the wallet database; the app derives the set from
 * `p2pkhScript(wallet.address)` plus its `txo` table.
 */
import rjs from "@radiant-core/radiantjs";
import { Buffer } from "buffer";
import { readDataOutput, type DataOutput } from "../dataOutput";
import { MAX_REASONABLE_FEE_RATE } from "../feePolicy";
import { transactionFromHex } from "../rjsCompat";
import {
  isTokenBearing,
  p2pkhScriptSigSize,
  parseP2pkhScript,
} from "../script";
import { NetworkKey } from "../types";
import { Psbt } from "./psbt";
import { DEFAULT_SIGHASH } from "./sign";

const { Address, Networks } = rjs;

export type PsbtWarning =
  | "TOKEN_BEARING_INPUT"
  | "UNKNOWN_PREVOUT"
  | "FEE_UNKNOWN"
  | "HIGH_FEE"
  | "SIGHASH_NONE"
  | "SIGHASH_SINGLE"
  | "SIGHASH_SINGLE_UNMATCHED"
  | "SIGHASH_ANYONECANPAY"
  | "MISSING_FORKID"
  | "ALREADY_SIGNED";

export type PsbtInputSummary = {
  txid: string;
  vout: number;
  script?: string;
  value?: bigint;
  address?: string;
  mine: boolean;
  tokenBearing: boolean;
  sighashType: number;
  hasPartialSig: boolean;
  finalized: boolean;
};

export type PsbtOutputSummary = {
  script: string;
  value: bigint;
  address?: string;
  mine: boolean;
  tokenBearing: boolean;
  /**
   * Present when this output is an `OP_RETURN` data carrier.
   *
   * A data output pays nobody, so its value says nothing; the payload is the
   * whole of what it does, and it is permanent. Described rather than
   * interpreted - see ../dataOutput.
   */
  data?: DataOutput;
};

export type PsbtAnalysis = {
  inputs: PsbtInputSummary[];
  outputs: PsbtOutputSummary[];
  /** Sum of known input values; undefined when any prevout is unknown. */
  totalIn?: bigint;
  totalOut: bigint;
  fee?: bigint;
  /** Size the tx will have once every pending input carries a P2PKH sig. */
  estSignedSize: number;
  /** photons per byte; undefined while the fee is unknown. */
  feeRate?: number;
  warnings: PsbtWarning[];
};

export type AnalyzeContext = {
  /** scriptPubKey hexes the wallet controls (for mine/change detection). */
  ownScripts?: Set<string>;
  /** Network used to render addresses; omitted ⇒ mainnet. */
  net?: NetworkKey;
};

function scriptToAddress(script: string, net: NetworkKey): string | undefined {
  const { address: pkh } = parseP2pkhScript(script);
  if (!pkh) return undefined;
  try {
    return Address.fromPublicKeyHash(
      Buffer.from(pkh, "hex"),
      Networks[net]
    ).toString();
  } catch {
    return undefined;
  }
}

export function analyzePsbt(psbt: Psbt, ctx?: AnalyzeContext): PsbtAnalysis {
  const net: NetworkKey = ctx?.net ?? "mainnet";
  const ownScripts = ctx?.ownScripts ?? new Set<string>();
  const tx = transactionFromHex(psbt.unsignedTxHex);
  const warnings = new Set<PsbtWarning>();

  const outputs: PsbtOutputSummary[] = tx.outputs.map((o) => {
    const script = o.script.toHex();
    const data = readDataOutput(script);
    return {
      script,
      // BN → string → bigint keeps values beyond 2^53 exact.
      value: BigInt(o.satoshisBN.toString()),
      address: scriptToAddress(script, net),
      mine: ownScripts.has(script),
      tokenBearing: isTokenBearing(script),
      ...(data === undefined ? {} : { data }),
    };
  });
  const totalOut = outputs.reduce((sum, o) => sum + o.value, 0n);

  let totalIn: bigint | undefined = 0n;
  const inputs: PsbtInputSummary[] = tx.inputs.map((txin, i) => {
    const pin = psbt.inputs[i];
    const utxo = pin?.utxo;
    const sighashType = pin?.sighashType ?? DEFAULT_SIGHASH;
    const finalized = pin?.finalScriptSig !== undefined;
    const hasPartialSig = (pin?.partialSigs.size ?? 0) > 0;

    if (!utxo) {
      totalIn = undefined;
      warnings.add("UNKNOWN_PREVOUT");
    } else {
      if (totalIn !== undefined) totalIn += utxo.value;
      if (isTokenBearing(utxo.script)) warnings.add("TOKEN_BEARING_INPUT");
    }
    if (finalized || hasPartialSig) warnings.add("ALREADY_SIGNED");

    const base = sighashType & 0x1f;
    if (!(sighashType & 0x40)) warnings.add("MISSING_FORKID");
    if (base === 0x02) warnings.add("SIGHASH_NONE");
    if (base === 0x03) {
      warnings.add("SIGHASH_SINGLE");
      if (i >= tx.outputs.length) warnings.add("SIGHASH_SINGLE_UNMATCHED");
    }
    if (sighashType & 0x80) warnings.add("SIGHASH_ANYONECANPAY");

    return {
      txid: txin.prevTxId.toString("hex"),
      vout: txin.outputIndex,
      script: utxo?.script,
      value: utxo?.value,
      address: utxo ? scriptToAddress(utxo.script, net) : undefined,
      mine: utxo ? ownScripts.has(utxo.script) : false,
      tokenBearing: utxo ? isTokenBearing(utxo.script) : false,
      sighashType,
      hasPartialSig,
      finalized,
    };
  });

  // Unsigned inputs carry a 1-byte empty-script length; a P2PKH signature
  // replaces that with ~1 + 107 bytes, so each pending input adds ~107.
  const unsignedSize = psbt.unsignedTxHex.length / 2;
  const estSignedSize =
    unsignedSize +
    psbt.inputs.reduce((sum, pin) => {
      if (pin.finalScriptSig !== undefined) {
        return sum + pin.finalScriptSig.length / 2;
      }
      return sum + p2pkhScriptSigSize;
    }, 0);

  let fee: bigint | undefined;
  let feeRate: number | undefined;
  if (totalIn !== undefined) {
    fee = totalIn - totalOut;
    feeRate = Number(fee) / estSignedSize;
    // Mirror feeCheck's 20% slack over the reference ceiling.
    if (feeRate > MAX_REASONABLE_FEE_RATE * 1.2) warnings.add("HIGH_FEE");
  } else {
    warnings.add("FEE_UNKNOWN");
  }

  return {
    inputs,
    outputs,
    totalIn,
    totalOut,
    fee,
    estSignedSize,
    feeRate,
    warnings: [...warnings],
  };
}
