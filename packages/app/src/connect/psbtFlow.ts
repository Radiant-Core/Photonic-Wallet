/**
 * Non-React glue between the connect PSBT flow and the wallet's own state:
 * database-backed ownership/spent checks, best-effort prevout resolution for
 * external inputs, signing, and the finalize-or-broadcast decision. Kept out
 * of `Connect.tsx` so the approval UI stays declarative.
 *
 * `@lib/psbt`'s `analyzePsbt` is pure and only knows what the PSBT itself
 * declares; this module is where that gets cross-checked against what the
 * wallet actually has on record (`db.txo`) and, for informational purposes
 * only, against the chain (`electrumWorker.getTransaction`).
 */
import {
  DEFAULT_ALLOWED_SIGHASHES,
  Psbt,
  PsbtAnalysis,
  PsbtError,
  analyzePsbt,
  extractTx,
  finalizePsbt,
  psbtToBase64,
  signPsbt,
} from "@lib/psbt";
import { p2pkhScript } from "@lib/script";
import rjs from "@radiant-core/radiantjs";
import db from "@app/db";
import { electrumWorker } from "@app/electrum/Electrum";
import { wallet } from "@app/signals";
import { ContractType, TxO } from "@app/types";

const { Transaction } = rjs;

export type PsbtInputEnrichment = {
  index: number;
  /** The wallet's own record for this outpoint, if it has one. */
  dbRecord?: TxO;
  /** The PSBT's declared utxo disagrees with what the wallet has on record. */
  scriptMismatch: boolean;
  /** The wallet already considers this outpoint spent (racing mempool?). */
  alreadySpent: boolean;
};

export type EnrichedPsbt = {
  /** Owned inputs missing a utxo field are backfilled from `db.txo`; inputs
   * with no wallet or chain data available are left as-is. Pass this, not
   * the original, to `signPsbt`. */
  psbt: Psbt;
  analysis: PsbtAnalysis;
  inputs: PsbtInputEnrichment[];
  /** Non-empty ⇒ approval must be blocked; each entry is a user-facing reason. */
  blockers: string[];
  /** How many of the wallet's own inputs are ready to be (re-)signed. */
  signableCount: number;
};

/**
 * Look up an outpoint's chain data for display purposes only (fee
 * estimation on an external input the PSBT didn't attach a utxo for, and
 * that isn't in `db.txo` either). Never used for signing — signPsbt only
 * trusts `db.txo`-backed script/value for inputs it recognizes as the
 * wallet's own, never a network-fetched value for someone else's input.
 * `getTransaction` hash-verifies the response against `txid`, so a
 * malicious server can at worst withhold data, not lie about it.
 */
async function tryFetchPrevout(
  txid: string,
  vout: number
): Promise<{ script: string; value: bigint } | undefined> {
  try {
    const hex = await electrumWorker.value.getTransaction(txid);
    if (!hex) return undefined;
    const output = new Transaction(hex).outputs[vout];
    if (!output) return undefined;
    return {
      script: output.script.toHex(),
      value: BigInt(output.satoshisBN.toString()),
    };
  } catch {
    return undefined;
  }
}

export async function enrichPsbt(psbt: Psbt): Promise<EnrichedPsbt> {
  const address = wallet.value.address;
  const ownScript = address ? p2pkhScript(address) : undefined;
  const ownScripts = ownScript ? new Set([ownScript]) : new Set<string>();

  // First pass: txid/vout for every input, regardless of whether the PSBT
  // attached a utxo field, so we know what to look up.
  const preview = analyzePsbt(psbt);

  const inputs: PsbtInputEnrichment[] = [];
  const backfilledInputs = await Promise.all(
    psbt.inputs.map(async (input, index) => {
      const { txid, vout } = preview.inputs[index];
      const dbRecord = await db.txo
        .where("[txid+vout]")
        .equals([txid, vout])
        .first()
        .catch(() => undefined);

      let scriptMismatch = false;
      let backfilled = input;
      if (dbRecord) {
        if (input.utxo) {
          scriptMismatch =
            input.utxo.script !== dbRecord.script ||
            input.utxo.value !== BigInt(dbRecord.value);
        } else if (dbRecord.contractType === ContractType.RXD) {
          // Updater role: our own unsigned input is missing its utxo field —
          // fill it in from what the wallet has on record so signPsbt (which
          // requires `utxo` to sign) has something to work with.
          backfilled = {
            ...input,
            utxo: { script: dbRecord.script, value: BigInt(dbRecord.value) },
          };
        }
      } else if (!input.utxo) {
        // Not ours and the PSBT didn't attach a utxo — best-effort fetch
        // purely so the approval screen can show a real fee instead of
        // "unknown". signPsbt will still skip this input (`not-mine`).
        const fetched = await tryFetchPrevout(txid, vout);
        if (fetched) backfilled = { ...input, utxo: fetched };
      }

      inputs.push({
        index,
        dbRecord,
        scriptMismatch,
        alreadySpent: dbRecord?.spent === 1,
      });

      return backfilled;
    })
  );

  const backfilledPsbt: Psbt = { ...psbt, inputs: backfilledInputs };
  const analysis = analyzePsbt(backfilledPsbt, {
    ownScripts,
    net: wallet.value.net,
  });

  const blockers: string[] = [];
  if (analysis.warnings.includes("TOKEN_BEARING_INPUT")) {
    blockers.push(
      "This transaction spends a token-bearing input. Signing could destroy a token, so Photonic refuses to co-sign it."
    );
  }
  if (analysis.warnings.includes("MISSING_FORKID")) {
    blockers.push(
      "This transaction requests a signature type Radiant doesn't allow (missing SIGHASH_FORKID)."
    );
  }
  const mismatched = inputs.filter((i) => i.scriptMismatch);
  if (mismatched.length > 0) {
    blockers.push(
      "The transaction's declared amount or script for one of your inputs doesn't match what your wallet has on record. Refusing to sign."
    );
  }

  const allFinalized = analysis.inputs.every((i) => i.finalized);
  // How many of the wallet's own inputs still need a NEW signature this
  // approval — used for the "N of your inputs will be signed" display text.
  const signableCount = analysis.inputs.filter(
    (i, idx) => i.mine && !i.finalized && !i.hasPartialSig && !inputs[idx].scriptMismatch
  ).length;
  // Whether ANY input belongs to the wallet at all, regardless of whether
  // it's already signed — a PSBT whose own inputs are already validly
  // signed (just not yet finalized, e.g. mid multi-party hand-off) still has
  // a legitimate stake here and shouldn't be refused as "not yours".
  const mineCount = analysis.inputs.filter(
    (i, idx) => i.mine && !inputs[idx].scriptMismatch
  ).length;
  if (mineCount === 0 && !allFinalized) {
    blockers.push("None of this transaction's inputs belong to your wallet.");
  }

  return { psbt: backfilledPsbt, analysis, inputs, blockers, signableCount };
}

export type PsbtSignOutcome = {
  /** Base64 PSBT — present unless a broadcast succeeded. */
  psbt?: string;
  /** Present once a broadcast has been accepted by the network. */
  txid?: string;
  complete: boolean;
  /** Set when `broadcast` was requested, the tx was complete, but the
   * broadcast itself failed — the signed PSBT is still returned so nothing
   * is lost. */
  broadcastError?: string;
};

/**
 * Sign the wallet's own inputs, finalize what can be finalized, and either
 * hand back the (possibly still partial) PSBT or — only when `broadcast` is
 * requested and every input ends up signed — extract and broadcast,
 * returning a txid instead.
 *
 * Throws `PsbtError` for policy violations (token-bearing input, disallowed
 * sighash, etc.) — the caller is expected to catch and display it; nothing
 * is signed or sent in that case.
 */
export async function signAndMaybeBroadcast(
  psbt: Psbt,
  wif: string,
  opts: { broadcast: boolean }
): Promise<PsbtSignOutcome> {
  const { psbt: signed } = signPsbt(psbt, wif, {
    allowedSighashes: DEFAULT_ALLOWED_SIGHASHES,
  });
  const { psbt: finalized, complete } = finalizePsbt(signed);

  if (!opts.broadcast || !complete) {
    return { psbt: psbtToBase64(finalized), complete };
  }

  try {
    const hex = extractTx(finalized);
    const txid = (await electrumWorker.value.broadcast(hex)) || undefined;
    if (!txid) {
      // Server accepted a tx it already had (returns "") — the PSBT's own
      // txid is still the right answer to hand back.
      return { psbt: psbtToBase64(finalized), complete: true };
    }
    return { txid, complete: true };
  } catch (err) {
    return {
      psbt: psbtToBase64(finalized),
      complete: true,
      broadcastError: err instanceof Error ? err.message : String(err),
    };
  }
}

export { PsbtError };
