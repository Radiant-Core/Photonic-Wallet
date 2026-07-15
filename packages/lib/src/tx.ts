import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import rjs from "@radiant-core/radiantjs";
import { Buffer } from "buffer";
import { UnfinalizedOutput, Utxo } from "./types";
import { parseNftScript } from "./script";
import { MAX_REASONABLE_FEE_RATE } from "./feePolicy";
import { bnFromValue } from "./rjsCompat";

// ESM compatibility
const { Script, PrivateKey, Transaction, crypto } = rjs;
type Script = rjs.Script;

export const buildTx = (
  address: string,
  wif: string | string[],
  inputs: Utxo[],
  outputs: UnfinalizedOutput[],
  addChangeOutput = true,
  setInputScriptCallback?: (index: number, script: Script) => Script | void,
  sighashFlags?: number,
  skipFeeCheck?: boolean
) => {
  const tx = new Transaction();
  const p2pkh = Script.fromAddress(address).toHex();

  // Keys can be given as an array if inputs are from different addresses
  const privKeys: rjs.PrivateKey[] = (Array.isArray(wif) ? wif : [wif]).map(
    PrivateKey.fromWIF
  );

  inputs.forEach((input, index) => {
    if (input.script) {
      tx.addInput(
        new Transaction.Input({
          prevTxId: input.txid,
          outputIndex: input.vout,
          script: new Script(),
          output: new Transaction.Output({
            script: input.script,
            satoshis: input.value,
          }),
        })
      );
      tx.setInputScript(index, (tx, output) => {
        const privKey = privKeys[index] || privKeys[0];
        const sigType =
          (sighashFlags || crypto.Signature.SIGHASH_ALL) |
          crypto.Signature.SIGHASH_FORKID; // Always enforce fork id
        const sig = Transaction.Sighash.sign(
          tx,
          privKey,
          sigType,
          index,
          output.script,
          // Pass value as string to get around bn.js safe number limit.
          bnFromValue(`${output.satoshis}`)
        );
        const spendScript = Script.empty()
          .add(Buffer.concat([sig.toBuffer(), Buffer.from([sigType])]))
          .add(privKey.toPublicKey().toBuffer());
        if (setInputScriptCallback) {
          // TODO refactor uses of this to only use return value
          const script = setInputScriptCallback(index, spendScript);
          if (script) {
            return script.toString();
          }
        }
        return spendScript.toString();
      });
    } else {
      tx.from({
        // privKey,
        address,
        txId: input.txid,
        outputIndex: input.vout,
        script: p2pkh,
        satoshis: input.value,
      });
    }
  });

  outputs.forEach(({ script, value }) => {
    tx.addOutput(
      new Transaction.Output({
        script,
        satoshis: value,
      })
    );
  });
  if (addChangeOutput) {
    tx.change(address);
  }
  tx.sign(privKeys[0]);
  tx.seal();

  if (!skipFeeCheck) {
    feeCheck(tx, MAX_REASONABLE_FEE_RATE);
  }

  return tx;
};

export function txId(tx: string) {
  return bytesToHex(
    Buffer.from(sha256(sha256(Buffer.from(tx, "hex")))).reverse()
  );
}

/**
 * Upper-bound sanity check on the fee a signed transaction will pay.
 *
 * This is a guard against unit-confusion bugs (paying sats/kB when we mean
 * photons/byte, etc.) — not a relay-policy enforcement. Compares the actual
 * fee against `size * referenceFeeRate` and throws if actual is more than
 * 20% above that reference. Pass `MAX_REASONABLE_FEE_RATE` from feePolicy.ts
 * unless you have a specific reason to use a different ceiling.
 */
export function feeCheck(tx: rjs.Transaction, referenceFeeRate: number) {
  const size = tx.toString().length / 2;
  const expected = size * referenceFeeRate;
  const actual = tx.getFee();

  if (actual > expected && !((actual - expected) / expected < 0.2)) {
    throw new Error("Failed fee check");
  }
}

/**
 * Result of `findTokenOutput`: a discriminated union so the type system forces
 * callers to guard. `vout` and `output` are always both present or both
 * undefined — reading `output` without narrowing is a type error.
 *
 * Note `vout` can legitimately be 0, so callers must test `vout === undefined`,
 * NOT `!vout` — the latter treats a token at output index 0 as not-found.
 */
export type FoundTokenOutput =
  | { vout: number; output: rjs.Transaction["outputs"][number] }
  | { vout: undefined; output: undefined };

/**
 * Locate the output in `tx` holding the token identified by `refLE`.
 *
 * Previously this returned `{ vout, output }` on success but
 * `{ index: undefined, output: undefined }` on failure — two different shapes,
 * and the failure one named the index `index` rather than `vout`. Every caller
 * happened to survive that only because destructuring the absent `vout` key
 * yields `undefined` anyway. Normalised to a single shape so the next caller
 * isn't trapped by it.
 */
export function findTokenOutput(
  tx: rjs.Transaction,
  refLE: string,
  parseFn: (script: string) => Partial<{ ref: string }> = parseNftScript
): FoundTokenOutput {
  const vout = tx.outputs.findIndex(
    (output: { script: { toHex: () => string } }) => {
      const { ref } = parseFn(output.script.toHex());
      return ref === refLE;
    }
  );

  if (vout >= 0) {
    return { vout, output: tx.outputs[vout] };
  }

  return { vout: undefined, output: undefined };
}
