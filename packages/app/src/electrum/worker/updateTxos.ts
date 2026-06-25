/* eslint-disable @typescript-eslint/ban-ts-comment */
import {
  Transaction,
  // @ts-ignore
} from "@radiant-core/radiantjs";
import db from "@app/db";
import { ContractType, TxO } from "@app/types";
import ElectrumManager from "@app/electrum/ElectrumManager";
import { ElectrumUtxo } from "@lib/types";
import { validateElectrumUtxo, verifyTxoInclusion } from "./verifyTxo";
import { backfillHeaders } from "./Headers";
import { updateFtBalances } from "@app/utxos";
import { readBlockTime } from "@lib/spv";

export type ElectrumTxMap = {
  [key: string]: { hex: string; tx: Transaction };
};

/**
 * Per-utxo async on-chain validation hook (FIX 2 / token identity).
 *
 * `buildUpdateTXOs` derives the txo script purely from server-supplied data.
 * For contract types where the server *also* tells us which token a UTXO is
 * (FT `refs[0].ref`), the caller passes a validator that fetches the raw
 * (hash-verified) tx and confirms the on-chain output script commits to the
 * claimed ref. Returning false skips the UTXO so a spoofed token never counts
 * toward a balance. Omitted for RXD/NFT where no extra server annotation is
 * trusted beyond the script itself.
 */
export type ScriptValidator = (
  utxo: ElectrumUtxo,
  derivedScript: string
) => Promise<boolean>;

/**
 * TxO plus the SPV verification flag (FIX 1 / R14).
 *
 * `TxO` lives in the out-of-scope `@app/types`, so the `verified` column is
 * declared here as a structural extension and persisted as an extra Dexie
 * field (Dexie stores unindexed properties transparently). `verified === 1`
 * means a Merkle proof for this txo checked out against our locally
 * PoW-validated header chain; `0`/undefined means unverified (either still
 * unconfirmed, or the server could not or would not prove inclusion).
 */
export type VerifiableTxO = TxO & { verified?: 0 | 1 };

// Update txo table for a contract type
export const buildUpdateTXOs =
  (
    electrum: ElectrumManager,
    contractType: ContractType,
    scriptBuilder: (utxo: ElectrumUtxo) => string | undefined,
    scriptValidator?: ScriptValidator
  ) =>
  async (
    scriptHash: string,
    newStatus: string,
    manual: boolean
  ): Promise<{
    added: TxO[];
    confs: Map<number, ElectrumUtxo>;
    conflict: Map<number, string>; // Anything changed from spent back to unspent
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
    if (!manual) {
      const currentStatus = await db.subscriptionStatus
        .where({ scriptHash })
        .first();

      // TODO rebuild status from data instead of using stored value
      if (currentStatus?.status === newStatus) {
        console.debug("Status unchanged", newStatus, scriptHash, contractType);
        return { added: [], confs: new Map(), conflict: new Map(), spent: [] };
      }
      console.debug("New status", newStatus, scriptHash, contractType);
    }

    // Fetch unspent outputs
    console.debug("Calling listunspent");
    const rawUtxos = (await electrum.client?.request(
      "blockchain.scripthash.listunspent",
      scriptHash
    )) as unknown[];
    console.debug("Unspent", contractType, rawUtxos);

    // FIX 3 (M3): validate every server-supplied entry BEFORE any numeric
    // field is trusted. Reject (skip) entries with non-integer / negative /
    // out-of-range value, height, or tx_pos, or a malformed tx_hash, instead
    // of summing garbage into balances or using bad array/DB positions.
    const utxos: ElectrumUtxo[] = [];
    for (const candidate of Array.isArray(rawUtxos) ? rawUtxos : []) {
      if (validateElectrumUtxo(candidate)) {
        utxos.push(candidate);
      } else {
        console.warn(
          "[updateTxos] Rejecting malformed listunspent entry",
          candidate
        );
      }
    }

    // Check tx exists in database
    // Dedup any transactions that have multiple UTXOs for this wallet
    const newTxIds = new Set<string>();
    const newUtxos: ElectrumUtxo[] = [];
    const outpoints: string[] = []; // All UTXO outpoints
    const confs: Map<number, ElectrumUtxo> = new Map(); // Newly confirmed transactions mapped by txo id
    const conflict: Map<number, string> = new Map(); // Anything changed from spent back to unspent

    // Check if txo table is empty so queries can be skipped
    const emptyTxoTable = (await db.txo.where({ contractType }).count()) === 0;
    // Serialize to avoid Safari IndexedDB "out of memory" from concurrent transactions
    for (const utxo of utxos) {
      outpoints.push(`${utxo.tx_hash}${utxo.tx_pos}`);
      const exist = emptyTxoTable
        ? false
        : await db.txo.where({ txid: utxo.tx_hash, vout: utxo.tx_pos }).first();
      if (!exist) {
        newTxIds.add(utxo.tx_hash);
        newUtxos.push(utxo);
      } else if (
        exist.id &&
        exist.height != utxo.height // Reset spent if necessary
      ) {
        confs.set(exist.id, utxo);
      } else if (exist.id && exist.spent === 1) {
        conflict.set(exist.id, exist.script);
      }
    }

    // Update spent UTXOs
    const spent = emptyTxoTable
      ? []
      : (await db.txo.where({ contractType, spent: 0 }).toArray())
          // Ref-tracked UTXOs (mutable-NFT / WAVE singletons under auth
          // covenants) never appear in this address' scripthash listunspent, so
          // their absence here does NOT mean spent. They're reconciled by ref in
          // the NFT worker (reconcileRefTrackedNfts); exclude them from the sweep.
          .filter((txo) => txo.byRef !== 1)
          .filter(({ txid, vout }) => !outpoints.includes(`${txid}${vout}`))
          .map(({ id, value, script }) => ({
            id: id as number,
            value,
            script,
          }));
    if (spent.length) {
      await db.transaction("rw", db.txo, async () => {
        for (const { id } of spent) {
          await db.txo.update(id, {
            spent: 1,
          });
        }
      });
    }

    // Ensure the header chain reaches down to the oldest confirmed coin we're
    // about to SPV-verify. The forward header sync never fetches below its
    // pinned checkpoint, so without this a coin confirmed before the
    // checkpoint is unprovable forever and stays "pending". No-op when the
    // chain already covers the height.
    const minNewHeight = newUtxos.reduce(
      (min, utxo) => (utxo.height > 0 ? Math.min(min, utxo.height) : min),
      Infinity
    );
    if (Number.isFinite(minNewHeight)) {
      await backfillHeaders(electrum, minNewHeight);
    }

    // Serialize to avoid Safari IndexedDB "out of memory" from concurrent transactions
    const added: VerifiableTxO[] = [];
    for (const utxo of newUtxos) {
      const script = scriptBuilder(utxo);
      if (!script) continue;

      // FIX 2 (token identity): for contract types that carry a server-supplied
      // token annotation (FT refs[0].ref), confirm the on-chain output script
      // actually commits to the claimed ref before counting it. A failed check
      // means the server lied about which token this UTXO is — skip it.
      if (scriptValidator) {
        // Contract: a THROW is transient (e.g. the validator couldn't fetch the
        // raw tx — socket dropped); let it propagate so the whole sync fails and
        // retries with backoff. Do NOT swallow it: skipping the UTXO here while
        // the caller goes on to persist the subscription status would strand the
        // token un-retryably (the next sync sees "status unchanged" and never
        // re-pulls). A returned `false` is a deterministic rejection (the server
        // mislabeled the token) — skip just this UTXO; the rest of the sync is
        // still valid.
        const ok = await scriptValidator(utxo, script);
        if (!ok) {
          console.warn(
            "[updateTxos] On-chain ref mismatch, skipping UTXO",
            utxo.tx_hash,
            utxo.tx_pos
          );
          continue;
        }
      }

      // Check if this is our own tx. User won't be notified for these.
      const isOwnTx =
        (await db.broadcast.get(utxo.tx_hash)) === undefined ? 0 : 1;

      // FIX 1 (R14): a server-claimed confirmation height is NOT trusted on its
      // own. Only mark the txo verified once a Merkle proof checks out against
      // our locally PoW-validated header at that height. Unverified-but-claimed-
      // confirmed coins are stored with height=Infinity-equivalent semantics
      // (verified:0) so balance code surfaces them as pending, not confirmed.
      // Graceful degradation: verifyTxoInclusion never throws — on no-proof /
      // no-header / bad-proof it returns false and the coin stays unverified.
      const height = utxo.height || Infinity;
      const verified =
        height !== Infinity &&
        (await verifyTxoInclusion(electrum.client, utxo.tx_hash, utxo.height))
          ? 1
          : 0;

      const txo: VerifiableTxO = {
        txid: utxo.tx_hash,
        vout: utxo.tx_pos,
        script,
        value: utxo.value,
        // FIXME find a better way to store date
        // Maybe when block header subscription is finished it can be used
        // date: newTxs[utxo.tx_hash].raw.time || undefined,
        height,
        spent: 0,
        change: isOwnTx,
        contractType,
        verified,
      };

      added.push(txo);
    }

    if (!emptyTxoTable) {
      // SPV-verify the changed confirmations BEFORE opening the write
      // transaction. verifyTxoInclusion makes a network round-trip
      // (blockchain.transaction.get_merkle) and reads db.header; awaiting any
      // non-db.txo promise *inside* the db.transaction below lets IndexedDB
      // auto-commit it, so the next db.txo.update throws
      // "TransactionInactiveError: Transaction has already completed or failed"
      // — which fails the whole sync and (because the status is requeued) loops
      // forever. Only triggers on wallets that have a coin newly transitioning
      // to a confirmed height, which is why it's intermittent.
      //
      // FIX 1 (R14): a txo transitioning to (or between) confirmed heights must
      // be re-verified against the header chain. `confs` only contains txos
      // whose height actually changed, so already-verified txos at an unchanged
      // height aren't re-proven every sync.
      const confUpdates: { id: number; height: number; verified: 0 | 1 }[] = [];
      for (const [id, utxo] of confs) {
        const height = utxo.height || Infinity;
        const verified =
          height !== Infinity &&
          (await verifyTxoInclusion(electrum.client, utxo.tx_hash, utxo.height))
            ? 1
            : 0;
        confUpdates.push({ id, height, verified });
      }

      // Update confirmations and conflicting utxos in a single short
      // transaction that performs ONLY db.txo writes (no foreign awaits inside).
      await db.transaction("rw", db.txo, async () => {
        for (const { id, height, verified } of confUpdates) {
          await db.txo.update(id, {
            height,
            spent: 0,
            verified,
            // date: newTxs[utxo.tx_hash].raw.time || undefined, // how to get date without fetching?
          } as Partial<VerifiableTxO>);
        }
        for (const [id] of conflict) {
          await db.txo.update(id, {
            spent: 0,
          });
        }
      });
    }

    // FIX 1 (R14) — re-verify stragglers. A confirmed coin inserted while the
    // header chain hadn't synced to its height yet would have been stored
    // `verified:0` and, since its height never changes, would never reappear in
    // `confs` to get re-proven. Sweep the unspent, confirmed-but-unverified txos
    // for this contract type each sync and retry the Merkle proof now that more
    // headers may be available. Cheap: only touches txos still pending
    // verification, and verified ones are never re-proven.
    if (!emptyTxoTable) {
      await reverifyPendingTxos(electrum, contractType);
    }

    // Record incoming coins/tokens as activity so the unified timeline
    // (History page + notifications) reflects receives, not just our own sends.
    await recordReceivedActivity(added, contractType);

    return { added, confs, conflict, spent, utxoCount: utxos.length };
  };

/**
 * Description string written to `db.broadcast` for an incoming UTXO, keyed by
 * contract type. Mirrors the receive entries classified in `@app/activity`.
 * Returns undefined for contract types that aren't surfaced as receives.
 */
function receiveDescription(contractType: ContractType): string | undefined {
  switch (contractType) {
    case ContractType.RXD:
      return "rxd_receive";
    case ContractType.FT:
      return "ft_receive";
    case ContractType.NFT:
      return "nft_receive";
    default:
      return undefined;
  }
}

/**
 * Persist a receive activity entry for each newly-discovered incoming txo.
 *
 * Incoming = `change === 0` (the tx was not broadcast by this wallet). The
 * timestamp is taken from the confirming block header when available (so a
 * restored wallet's backlog lands at its true position in the timeline and
 * doesn't fire a toast storm — see ActivityNotifications mount-time gating);
 * unconfirmed coins fall back to "now". Entries are keyed by txid in
 * `db.broadcast`, so this is idempotent across re-syncs and de-dupes multiple
 * UTXOs belonging to the same received transaction.
 */
async function recordReceivedActivity(
  added: TxO[],
  contractType: ContractType
): Promise<void> {
  const description = receiveDescription(contractType);
  if (!description) return;

  const seen = new Set<string>();
  for (const txo of added) {
    if (txo.change !== 0) continue; // skip our own change outputs
    if (seen.has(txo.txid)) continue;
    seen.add(txo.txid);

    // Don't overwrite an existing entry (e.g. our own broadcast record, or a
    // receive already logged on a previous sync).
    if (await db.broadcast.get(txo.txid)) continue;

    let date = Date.now();
    const height = txo.height;
    if (height !== undefined && Number.isFinite(height) && height > 0) {
      try {
        const header = await db.header.where("height").equals(height).first();
        if (header?.buffer) {
          const seconds = readBlockTime(new Uint8Array(header.buffer));
          if (seconds > 0) date = seconds * 1000;
        }
      } catch (e) {
        console.warn("[updateTxos] could not read block time for receive", e);
      }
    }

    await db.broadcast.put({ txid: txo.txid, description, date });
  }
}

/**
 * Retry SPV inclusion verification for unspent, confirmed txos that are still
 * flagged unverified (FIX 1 / R14). Idempotent and bounded — verified txos are
 * skipped, and each call only re-proves what remains pending.
 *
 * When a txo flips to verified, its balance must be recomputed (it now counts
 * as confirmed). RXD recomputes its balance unconditionally after every sync,
 * so only FT needs an explicit refresh here, keyed by the affected scripts.
 */
async function reverifyPendingTxos(
  electrum: ElectrumManager,
  contractType: ContractType
): Promise<void> {
  const pending = (await db.txo
    .where({ contractType, spent: 0 })
    .toArray()) as VerifiableTxO[];

  const toVerify = pending.filter(
    (txo) =>
      txo.id !== undefined &&
      txo.height !== undefined &&
      txo.height !== Infinity &&
      txo.verified !== 1
  );
  if (toVerify.length === 0) return;

  // Headers below the pinned checkpoint are never fetched by the forward
  // catchup, so a coin confirmed before it could otherwise never be proven:
  // verifyTxoInclusion finds no header, returns false, and the coin is
  // surfaced as "pending" on every sync, forever. Extend the header chain
  // down to the oldest height we're about to prove first (no-op when the
  // chain already covers it).
  const minHeight = toVerify.reduce(
    (min, txo) => Math.min(min, txo.height as number),
    Infinity
  );
  if (Number.isFinite(minHeight)) {
    await backfillHeaders(electrum, minHeight);
  }

  const changedScripts = new Set<string>();
  for (const txo of toVerify) {
    const ok = await verifyTxoInclusion(
      electrum.client,
      txo.txid,
      txo.height as number
    );
    if (ok) {
      await db.txo.update(
        txo.id as number,
        {
          verified: 1,
        } as Partial<VerifiableTxO>
      );
      changedScripts.add(txo.script);
    }
  }

  if (changedScripts.size === 0) return;

  // Recompute balances so the freshly-verified coins move from pending to
  // confirmed. FT balances are per-script and need an explicit nudge here. RXD
  // and NFT don't: RXDWorker calls updateRxdBalances(address) unconditionally
  // after every sync (so any flipped RXD straggler is reflected on this same
  // pass), and NFTs don't use the value-balance table.
  if (contractType === ContractType.FT) {
    await updateFtBalances(changedScripts);
  }
}
