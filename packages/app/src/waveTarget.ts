import { wallet, feeRate } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import db from "@app/db";
import { TxO, ContractType } from "@app/types";
import Outpoint from "@lib/Outpoint";
import { encodeGlyphMutable } from "@lib/token";
import { fundTx } from "@lib/coinSelect";
import {
  mutableNftScript,
  nftAuthScript,
  p2pkhScript,
  parseMutableScript,
} from "@lib/script";
import { buildTx, findTokenOutput } from "@lib/tx";
import { SmartTokenPayload, UnfinalizedInput } from "@lib/types";
import { Transaction } from "@radiant-core/radiantjs";

/**
 * Re-point a WAVE name to a new target by co-spending the name's NFT singleton
 * and its mutable contract UTXO (ref + 1). The mutable contract is a covenant
 * gated on the NFT singleton (not the owner's key), so whoever holds the NFT
 * can perform this update — which is what lets a buyer claim a name they just
 * acquired in a swap.
 *
 * Extracted verbatim from WaveNames.tsx's handleUpdateTarget so it can be
 * reused outside the names page. Throws on failure; callers handle toasts and
 * local db.glyph updates.
 *
 * @param name Full name string (e.g. "alice.rxd"); the bare label is derived.
 * @returns the broadcast transaction id
 */
export async function updateWaveTarget(opts: {
  ref: string;
  txoId: number;
  name: string;
  domain: string;
  newTarget: string;
}): Promise<string> {
  const { ref, txoId, name, domain, newTarget } = opts;

  if (!wallet.value.wif) {
    throw new Error("Wallet locked");
  }

  // Get the NFT UTXO
  const txo = (await db.txo.get({ id: txoId })) as TxO;
  if (!txo) {
    throw new Error("Token UTXO not found");
  }

  // Get NFT ref and calculate mutable contract ref
  const nftRefBE = Outpoint.fromString(ref);
  const nftRefLE = nftRefBE.reverse().toString();
  const { txid: nftTxid, vout: refVout } = nftRefBE.toObject();

  // Mutable contract ref is always token ref + 1
  const mutRefBE = Outpoint.fromUTXO(nftTxid, refVout + 1);
  const mutRefLE = mutRefBE.reverse().toString();

  // Fetch current location of the mutable contract UTXO
  const refResponse = await electrumWorker.value.getRef(mutRefBE.toString());
  if (!refResponse?.length) {
    throw new Error("Mutable contract UTXO not found");
  }
  const location = refResponse[refResponse.length - 1].tx_hash;
  const hex = await electrumWorker.value.getTransaction(location);
  const refTx = new Transaction(hex);

  const { vout: mutVout, output: mutOutput } = findTokenOutput(
    refTx,
    mutRefLE,
    parseMutableScript
  );

  if (mutVout === undefined || !mutOutput) {
    throw new Error("Could not locate mutable contract output");
  }

  // Build updated payload - only updating target
  const payload: Partial<SmartTokenPayload> = {
    attrs: {
      name: name.split(".")[0],
      domain,
      target: newTarget,
      target_type: "address",
    },
  };

  // outputs = [nftOutput (0), mutContractOutput (1)] — the indices below
  // must match that ordering:
  // contractOutputIndex=1 (mutable contract is output 1)
  // refHashIndex=1, refIndex=0
  // tokenOutputIndex=0 (NFT token is output 0)
  const glyph = encodeGlyphMutable("mod", payload, 1, 1, 0, 0);
  const mutOutputScript = mutableNftScript(mutRefLE, glyph.payloadHash);
  const nftOutputScript = nftAuthScript(wallet.value.address, nftRefLE, [
    { ref: mutRefLE, scriptSigHash: glyph.scriptSigHash },
  ]);

  const nftInput: UnfinalizedInput = { ...txo };
  const mutInput: UnfinalizedInput = {
    txid: refTx.id,
    vout: mutVout,
    script: mutOutput.script.toHex(),
    value: mutOutput.satoshis,
    scriptSigSize: mutOutputScript.length / 2,
  };

  const nftOutput = { script: nftOutputScript, value: txo.value };
  const mutContractOutput = {
    script: mutOutputScript,
    value: mutInput.value,
  };

  const inputs: UnfinalizedInput[] = [nftInput, mutInput];
  const outputs = [nftOutput, mutContractOutput];

  // Get RXD UTXOs for funding
  const rxdUtxos = await db.txo
    .where({ contractType: ContractType.RXD, spent: 0 })
    .toArray();

  const p2pkh = p2pkhScript(wallet.value.address);
  const fund = fundTx(
    wallet.value.address,
    rxdUtxos,
    inputs,
    outputs,
    p2pkh,
    feeRate.value
  );

  if (!fund.funded) {
    throw new Error("Insufficient funds for transaction fee");
  }

  inputs.push(...fund.funding);
  outputs.push(...fund.change);

  const rawTx = buildTx(
    wallet.value.address,
    wallet.value.wif.toString(),
    inputs,
    outputs,
    false,
    (index, script) => {
      if (index === 1) {
        // Mutable contract input: replace p2pkh scriptSig with glyph scriptSig
        script.set({ chunks: [] });
        script.add(glyph.scriptSig);
      }
    }
  ).toString();

  const txid = await electrumWorker.value.broadcast(rawTx);
  await db.broadcast.put({
    txid,
    date: Date.now(),
    description: "wave_name_update",
  });

  return txid;
}
