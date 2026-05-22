import {
  radiantCoinSelect,
  type CoinSelectInput,
  type CoinSelectResult,
} from "./radiantCoinSelect";
import { UnfinalizedInput, UnfinalizedOutput, Utxo } from "./types";
import { normalizeFeeRate } from "./feePolicy";

export type SelectableInput = UnfinalizedInput & {
  required?: boolean;
  utxo?: unknown;
};

// Convert a target object to a UTXO with txid and vout properties
export const targetToUtxo = (
  target: UnfinalizedOutput[],
  txid: string,
  voutStart = 0
): Utxo[] =>
  target.map((t, i) => ({
    txid: txid,
    vout: voutStart + i,
    ...t,
  }));

export function coinSelect(
  address: string,
  utxos: SelectableInput[],
  target: {
    script: string;
    value: number;
  }[],
  changeScript: string,
  feeRate: number
): {
  inputs: SelectableInput[];
  outputs: UnfinalizedInput[];
  fee: number;
  remaining: SelectableInput[];
} {
  const safeFeeRate = normalizeFeeRate(feeRate);

  // Shape rows for the selector: it estimates size from `script` (hex).
  // We feed scriptSig as `script` for input-byte sizing, and stash the original
  // scriptPubKey under a separate key so we can restore it after selection.
  type Row = CoinSelectInput & {
    address: string;
    txid: string;
    vout: number;
    scriptPubKey: string;
    utxo: SelectableInput;
  };
  const inputs: Row[] = utxos.map((u) => ({
    address,
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    required: u.required || false,
    // The selector uses `script` for size estimation only — it does not
    // interpret semantics, so feeding scriptSig (the unlocking script that
    // affects input size) is correct.
    script: u.scriptSig,
    scriptPubKey: u.script,
    utxo: u,
  }));

  const selected: CoinSelectResult<Row, { script: string; value: number }> =
    radiantCoinSelect(inputs, target, safeFeeRate, changeScript);

  // Failure path: caller contract is { inputs: undefined, fee } — surface that
  // shape so call sites can branch on `!selected.inputs?.length`.
  if (!selected.inputs?.length) {
    return {
      inputs: [] as SelectableInput[],
      outputs: (selected.outputs ?? []) as UnfinalizedInput[],
      fee: selected.fee,
      remaining: utxos,
    };
  }

  // Re-shape: swap scriptPubKey back into `script`, the field downstream
  // transaction builders read.
  const finalInputs: SelectableInput[] = selected.inputs.map((row) => {
    const { scriptPubKey, script: _scriptSig, ...rest } = row;
    void _scriptSig;
    return { ...rest, script: scriptPubKey } as unknown as SelectableInput;
  });

  // Remove spent UTXOs by identity (the row carries the original through `utxo`).
  const spent = new Set(selected.inputs.map((r) => r.utxo));
  const remaining = utxos.filter((u) => !spent.has(u));

  return {
    inputs: finalInputs,
    outputs: (selected.outputs ?? []) as UnfinalizedInput[],
    fee: selected.fee,
    remaining,
  };
}

/**
 * Select coins to fund a transaction
 * This is used to create a separate funding transaction which will be used to fund the next transaction
 * Returns:
 * - Funding UTXOs
 * - Unspent outputs with funding UTXOs removed
 * - Change UTXO
 * - Fee
 */
export function fundTx(
  address: string,
  utxos: UnfinalizedInput[],
  requiredInputs: UnfinalizedInput[],
  target: UnfinalizedOutput[],
  changeScript: string,
  feeRate: number
) {
  const safeFeeRate = normalizeFeeRate(feeRate);
  const required = requiredInputs.map((i) => ({ ...i, required: true }));

  type Row = CoinSelectInput & {
    address: string;
    txid: string;
    vout: number;
    utxo: UnfinalizedInput;
  };
  const inputs: Row[] = ([...required, ...utxos] as SelectableInput[]).map(
    (u) => ({
      address,
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      required: u.required || false,
      // Dummy scriptSig sized to scriptSigSize (or empty → P2PKH default).
      script: u.scriptSigSize ? "00".repeat(u.scriptSigSize) : "",
      utxo: u,
    })
  );

  const selected = radiantCoinSelect(inputs, target, safeFeeRate, changeScript);

  if (!selected.inputs) {
    return {
      funded: false,
      funding: [],
      remaining: utxos,
      change: [],
      fee: 0,
    };
  }

  // Find funding inputs (non-required entries actually used).
  const remaining = [...utxos];
  const funding = selected.inputs
    .filter((input) => !input.required)
    .map((input) => {
      const found = utxos.find(
        (u) => u.txid === input.txid && u.vout === input.vout
      );

      if (!found) {
        throw Error("Coin selection failed");
      }

      remaining.splice(remaining.indexOf(found), 1);
      return found;
    });

  // Change outputs are anything beyond the caller-supplied targets.
  const change = (selected.outputs ?? []).slice(target.length);

  return { funded: true, funding, remaining, change, fee: selected.fee };
}

export function updateUnspent(
  { remaining, change }: { remaining: Utxo[]; change: UnfinalizedOutput[] },
  changeTxid: string,
  changeVoutStart: number
) {
  return [...remaining, ...targetToUtxo(change, changeTxid, changeVoutStart)];
}

export function accumulateInputs(utxos: SelectableInput[], amount: number) {
  let sum = 0;
  let index = 0;
  const inputs: SelectableInput[] = [];

  while (sum < amount && index < utxos.length) {
    const utxo = utxos[index];
    sum += utxo.value;
    inputs.push({ ...utxo, required: true });
    index++;
  }

  return { inputs, sum };
}

export default coinSelect;
