import rjs from "@radiant-core/radiantjs";
import coinSelect, { accumulateInputs, SelectableInput } from "./coinSelect";
import { ftScript, nftScript, p2pkhScript } from "./script";
import { buildTx } from "./tx";
import { UnfinalizedInput, UnfinalizedOutput } from "./types";

const { PrivateKey, crypto } = rjs;

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferError";
    Object.setPrototypeOf(this, TransferError.prototype);
  }
}

export function transferFungible(
  coins: SelectableInput[],
  tokens: SelectableInput[],
  refLE: string,
  fromAddress: string,
  toAddress: string,
  value: number,
  feeRate: number,
  wif: string
) {
  const fromScript = ftScript(fromAddress, refLE);
  const toScript = ftScript(toAddress, refLE);
  const rxdChangeScript = p2pkhScript(fromAddress);

  if (!toScript || !fromScript || !rxdChangeScript) {
    throw new TransferError("Invalid address");
  }

  const accum = accumulateInputs(tokens, value);

  if (accum.sum < value) {
    throw new TransferError("Insufficient token balance");
  }

  const outputs = [{ script: toScript, value }];
  if (accum.sum > value) {
    // Create FT change output
    outputs.push({ script: fromScript, value: accum.sum - value });
  }

  // R17: the original FIXME asked whether `coinSelect` was sizing inputs
  // by the spent UTXO's scriptPubKey (wrong) instead of its scriptSig
  // (right). R0's `coinSelect.ts` rewrite at line 134 now ignores the
  // input's stored `script` field and constructs a dummy scriptSig of
  // length `scriptSigSize ?? TX_INPUT_PUBKEYHASH (107)` — correct for
  // both plain RXD/P2PKH inputs and FT/NFT inputs spent via the
  // P2PKH-shaped scriptSig path. The FIXME is no longer applicable.
  const selected = coinSelect(
    fromAddress,
    [...accum.inputs, ...coins],
    outputs,
    rxdChangeScript,
    feeRate
  );

  if (!selected.inputs?.length) {
    throw new TransferError("Insufficient funds");
  }

  const privKey = PrivateKey.fromString(wif);

  return {
    tx: buildTx(
      fromAddress,
      privKey.toString(),
      selected.inputs,
      selected.outputs,
      false
    ),
    selected,
  };
}

export function transferFungibleToMany(
  coins: SelectableInput[],
  tokens: SelectableInput[],
  refLE: string,
  fromAddress: string,
  toAddress: string[],
  value: number[],
  feeRate: number,
  wif: string
) {
  if (value.length !== toAddress.length) {
    throw new TransferError("Invalid values");
  }

  const fromScript = ftScript(fromAddress, refLE);
  const toScript = toAddress.map((addr) => ftScript(addr, refLE));
  const rxdChangeScript = p2pkhScript(fromAddress);

  if (toScript.some((addr) => !addr) || !fromScript || !rxdChangeScript) {
    throw new TransferError("Invalid address");
  }

  const total = value.reduce((a, b) => a + b, 0);
  const accum = accumulateInputs(tokens, total);

  if (accum.sum < total) {
    throw new TransferError("Insufficient token balance");
  }

  const outputs = toScript.map((script, index) => ({
    script,
    value: value[index],
  }));
  if (accum.sum > total) {
    // Create FT change output
    outputs.push({ script: fromScript, value: accum.sum - total });
  }

  const selected = coinSelect(
    fromAddress,
    [...accum.inputs, ...coins],
    outputs,
    rxdChangeScript,
    feeRate
  );

  if (!selected.inputs?.length) {
    throw new TransferError("Insufficient funds");
  }

  const privKey = PrivateKey.fromString(wif);

  return {
    tx: buildTx(
      fromAddress,
      privKey.toString(),
      selected.inputs,
      selected.outputs,
      false
    ),
    selected,
  };
}

// Upper bound on the number of inputs a single batch/sweep transaction may
// consume. Keeps the signed transaction well within relay size limits and the
// browser's signing budget. A wallet with more spendable UTXOs than this should
// consolidate first (Settings → consolidation) or send in parts.
export const MAX_BATCH_INPUTS = 500;

export type BatchFtInput = {
  // Little-endian token ref.
  refLE: string;
  // All spendable UTXOs of this token type (the full balance is sent).
  utxos: SelectableInput[];
};

export type BatchNftInput = {
  // Little-endian singleton ref.
  refLE: string;
  utxo: SelectableInput;
};

/**
 * Build a single transaction that sends several tokens to ONE recipient.
 *
 * - Each fungible token type is consolidated into one output carrying its full
 *   selected balance (sum of its UTXOs).
 * - Each non-fungible token becomes its own singleton output.
 * - RXD coins fund the fee.
 *
 * Two modes:
 * - Batch send (default): RXD funds only the fee; change returns to the sender.
 * - Sweep (`options.sweep`): every RXD coin is consumed and the leftover
 *   (total RXD − fee) is sent to the recipient, emptying the wallet of ordinary
 *   RXD / FT / NFT UTXOs. The fee is computed automatically from the final
 *   transaction size.
 *
 * Note on covenants: each FT/NFT covenant validates independently per ref, so
 * combining many token types (and RXD) in one transaction is safe — see the
 * per-ref CODESCRIPTHASHVALUESUM / singleton checks in `script.ts`.
 */
export function transferBatch(
  coins: SelectableInput[],
  fts: BatchFtInput[],
  nfts: BatchNftInput[],
  fromAddress: string,
  toAddress: string,
  feeRate: number,
  wif: string,
  options: { sweep?: boolean } = {}
) {
  const { sweep = false } = options;
  const senderChangeScript = p2pkhScript(fromAddress);
  const recipientScript = p2pkhScript(toAddress);

  if (!senderChangeScript || !recipientScript) {
    throw new TransferError("Invalid address");
  }

  const requiredInputs: SelectableInput[] = [];
  const outputs: { script: string; value: number }[] = [];

  // FT groups: one consolidated output per token type, carrying the full
  // selected balance. No FT change is produced (the entire balance moves).
  for (const ft of fts) {
    const toScript = ftScript(toAddress, ft.refLE);
    if (!toScript) {
      throw new TransferError("Invalid address");
    }
    let sum = 0;
    for (const u of ft.utxos) {
      requiredInputs.push({ ...u, required: true });
      sum += u.value;
    }
    // Skip a token type with no value rather than emitting a zero-value output.
    if (sum <= 0) continue;
    outputs.push({ script: toScript, value: sum });
  }

  // NFTs: one singleton output each, preserving the NFT's photon value.
  for (const nft of nfts) {
    const toScript = nftScript(toAddress, nft.refLE);
    if (!toScript) {
      throw new TransferError("Invalid address");
    }
    requiredInputs.push({ ...nft.utxo, required: true });
    outputs.push({ script: toScript, value: nft.utxo.value });
  }

  // A batch send must move at least one token. A sweep may legitimately have
  // no token outputs (an RXD-only wallet) — the recipient still receives all
  // RXD via the change output below.
  if (!outputs.length && !(options.sweep && coins.length)) {
    throw new TransferError("Nothing to send");
  }

  // Sweep consumes every RXD coin (leftover → recipient via the change script).
  // A batch send treats RXD as discretionary funding for the fee, returning
  // change to the sender.
  const rxdInputs: SelectableInput[] = sweep
    ? coins.map((c) => ({ ...c, required: true }))
    : coins.slice();
  const changeScript = sweep ? recipientScript : senderChangeScript;

  // Guard against an unreasonably large transaction. For a sweep every coin is
  // required; for a batch send only the token inputs are guaranteed-spent.
  const guaranteedInputs = sweep
    ? requiredInputs.length + rxdInputs.length
    : requiredInputs.length;
  if (guaranteedInputs > MAX_BATCH_INPUTS) {
    throw new TransferError(
      `Too many coins for a single transaction (${guaranteedInputs} > ${MAX_BATCH_INPUTS}). ` +
        `Consolidate your wallet first or send in smaller batches.`
    );
  }

  const selected = coinSelect(
    fromAddress,
    [...requiredInputs, ...rxdInputs],
    outputs,
    changeScript,
    feeRate
  );

  if (!selected.inputs?.length) {
    throw new TransferError("Insufficient funds");
  }

  const privKey = PrivateKey.fromString(wif);

  return {
    tx: buildTx(
      fromAddress,
      privKey.toString(),
      selected.inputs,
      selected.outputs,
      false
    ),
    selected,
  };
}

/**
 * Sweep all ordinary RXD / FT / NFT UTXOs to a single recipient, emptying the
 * wallet. Thin wrapper over `transferBatch` with `sweep: true` — the fee is
 * deducted automatically and the remaining RXD is sent to the recipient.
 */
export function sweepAll(
  coins: SelectableInput[],
  fts: BatchFtInput[],
  nfts: BatchNftInput[],
  fromAddress: string,
  toAddress: string,
  feeRate: number,
  wif: string
) {
  return transferBatch(coins, fts, nfts, fromAddress, toAddress, feeRate, wif, {
    sweep: true,
  });
}

export function transferNonFungible(
  coins: SelectableInput[],
  nft: SelectableInput,
  refLE: string,
  fromAddress: string,
  toAddress: string,
  feeRate: number,
  wif: string
) {
  const required: SelectableInput = { ...nft, required: true, script: "" };
  const inputs: SelectableInput[] = [required, ...coins.slice()];

  const changeScript = p2pkhScript(fromAddress);
  const script = nftScript(toAddress, refLE);

  if (!script || !changeScript) {
    throw new TransferError("Invalid address");
  }

  const selected = coinSelect(
    fromAddress,
    inputs,
    [{ script, value: nft.value }],
    changeScript,
    feeRate
  );
  if (!selected.inputs?.length) {
    throw new TransferError("Insufficient funds");
  }

  selected.inputs[0].script = nft.script;

  return {
    tx: buildTx(fromAddress, wif, selected.inputs, selected.outputs, false),
    selected,
  };
}

export function transferRadiant(
  coins: SelectableInput[],
  fromAddress: string,
  toScript: string,
  value: number,
  feeRate: number,
  wif: string
) {
  const changeScript = p2pkhScript(fromAddress);

  if (!toScript || !changeScript) {
    throw new TransferError("Invalid address");
  }

  const selected = coinSelect(
    fromAddress,
    coins,
    [{ script: toScript, value }],
    changeScript,
    feeRate
  );

  if (!selected.inputs?.length) {
    throw new TransferError("Insufficient funds");
  }

  return {
    tx: buildTx(fromAddress, wif, selected.inputs, selected.outputs, false),
    selected,
  };
}

export function partiallySigned(
  address: string, // Not needed. Need to refactor buildTx.
  input: UnfinalizedInput,
  output: UnfinalizedOutput,
  wif: string
) {
  const flags =
    crypto.Signature.SIGHASH_SINGLE |
    crypto.Signature.SIGHASH_ANYONECANPAY |
    crypto.Signature.SIGHASH_FORKID;
  return buildTx(
    address,
    wif,
    [input],
    [output],
    false,
    undefined,
    flags,
    true
  );
}
