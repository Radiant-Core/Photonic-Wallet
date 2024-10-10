/* eslint-disable @typescript-eslint/ban-ts-comment */
import {
  Transaction,
  // @ts-ignore
} from "@radiantblockchain/radiantjs";
import db from "@app/db";
import { ContractType, TxO } from "@app/types";
import ElectrumManager from "@app/electrum/ElectrumManager";
import { ElectrumUtxo } from "@lib/types";

export type ElectrumTxMap = {
  [key: string]: { hex: string; tx: Transaction };
};

// Update txo table for a contract type
export const buildUpdateTXOs =
  (
    electrum: ElectrumManager,
    contractType: ContractType,
    scriptBuilder: (utxo: ElectrumUtxo) => string | undefined
  ) =>
  async (
    scriptHash: string,
    newStatus: string
  ): Promise<{
    added: TxO[];
    confs: Map<number, ElectrumUtxo>;
    spent: { id: number; value: number; script: string }[];
    utxoCount?: number;
  }> => {
    const updated = await db.subscriptionStatus.update(scriptHash, {
      sync: { done: false },
    });
    if (!updated) {
      // Won't exist yet for first sync
      db.subscriptionStatus.put({
        scriptHash,
        status: "",
        contractType,
        sync: { done: false },
      });
    }

    // Check if status has changed
    const currentStatus = await db.subscriptionStatus
      .where({ scriptHash })
      .first();

    // TODO rebuild status from data instead of using stored value
    if (currentStatus?.status === newStatus) {
      console.debug("Status unchanged", newStatus, scriptHash, contractType);
      return { added: [], confs: new Map(), spent: [] };
    }
    console.debug("New status", newStatus, scriptHash, contractType);

    // Fetch unspent outputs
    const utxos = (await electrum.client?.request(
      "blockchain.scripthash.listunspent",
      scriptHash
    )) as ElectrumUtxo[];
    console.debug("Unspent", contractType, utxos);

    await db.subscriptionStatus.update(scriptHash, {
      sync: { done: false, numSynced: 0, numTotal: utxos.length },
    });

    // Check tx exists in database
    // Dedup any transactions that have multiple UTXOs for this wallet
    const newTxIds = new Set<string>();
    const newUtxos: ElectrumUtxo[] = [];
    const outpoints: string[] = []; // All UTXO outpoints
    const confs: Map<number, ElectrumUtxo> = new Map(); // Newly confirmed transactions mapped by txo id
    await Promise.all(
      utxos.map(async (utxo) => {
        outpoints.push(`${utxo.tx_hash}${utxo.tx_pos}`);
        const exist = await db.txo
          .where({ txid: utxo.tx_hash, vout: utxo.tx_pos })
          .first();
        if (!exist) {
          newTxIds.add(utxo.tx_hash);
          newUtxos.push(utxo);
        } else if (exist.id && exist.height != utxo.height) {
          confs.set(exist.id, utxo);
        }
      })
    );

    // Update spent UTXOs
    const spent = (await db.txo.where({ contractType, spent: 0 }).toArray())
      .filter(({ txid, vout }) => !outpoints.includes(`${txid}${vout}`))
      .map(({ id, value, script }) => ({ id: id as number, value, script }));
    await db.transaction("rw", db.txo, async () => {
      for (const { id } of spent) {
        await db.txo.update(id, {
          spent: 1,
        });
      }
    });

    const added = (
      await Promise.all(
        newUtxos.map(async (utxo) => {
          const script = scriptBuilder(utxo);
          if (!script) return undefined;

          // Check if this is our own tx. User won't be notified for these.
          const isOwnTx =
            (await db.broadcast.get(utxo.tx_hash)) === undefined ? 0 : 1;

          const txo: TxO = {
            txid: utxo.tx_hash,
            vout: utxo.tx_pos,
            script,
            value: utxo.value,
            // FIXME find a better way to store date
            // Maybe when block header subscription is finished it can be used
            // date: newTxs[utxo.tx_hash].raw.time || undefined,
            height: utxo.height || Infinity,
            spent: 0,
            change: isOwnTx,
            contractType,
          };

          return txo;
        })
      )
    ).filter(Boolean) as TxO[];

    // Update confirmations
    await db.transaction("rw", db.txo, async () => {
      for (const [id, utxo] of confs) {
        await db.txo.update(id, {
          height: utxo.height || Infinity,
          // date: newTxs[utxo.tx_hash].raw.time || undefined, // how to get date without fetching?
        });
      }
    });

    return { added, confs, spent, utxoCount: utxos.length };
  };
