import { p2pkhScript, p2pkhScriptHash } from "@lib/script";
import {
  Subscription,
  ContractType,
  ElectrumCallback,
  ElectrumStatusUpdate,
} from "@app/types";
import { buildUpdateTXOs } from "./updateTxos";
import db from "@app/db";
import ElectrumManager from "@app/electrum/ElectrumManager";
import setSubscriptionStatus from "./setSubscriptionStatus";
import { Worker } from "./electrumWorker";
import { consolidationCheck } from "./consolidationCheck";
import { updateRxdBalances } from "@app/utxos";
import { arrayChunks } from "@lib/util";

// Delay before re-running a sync that just failed. Without it a congested or
// timing-out socket gets retried in a tight loop, piling more requests onto
// the connection that's already failing (the Safari sync-storm feedback loop).
const RETRY_BACKOFF_MS = 3000;

export class RXDWorker implements Subscription {
  protected worker: Worker;
  protected updateTXOs: ElectrumStatusUpdate;
  private electrum: ElectrumManager;
  protected lastReceivedStatus: string;
  protected ready = true;
  protected receivedStatuses: string[] = [];
  protected address = "";
  protected scriptHash = "";

  constructor(worker: Worker, electrum: ElectrumManager) {
    this.worker = worker;
    this.electrum = electrum;
    this.updateTXOs = buildUpdateTXOs(this.electrum, ContractType.RXD, () =>
      p2pkhScript(this.address)
    );
    this.lastReceivedStatus = "";
  }

  async syncPending() {
    if (this.ready && this.receivedStatuses.length > 0) {
      const lastStatus = this.receivedStatuses.pop();
      this.receivedStatuses = [];
      if (lastStatus) {
        await this.onSubscriptionReceived(this.scriptHash, lastStatus);
      }
    }
  }

  async manualSync() {
    if (this.ready) {
      this.receivedStatuses = [];
      await this.onSubscriptionReceived(this.scriptHash, "", true);
    }
  }

  async onSubscriptionReceived(
    scriptHash: string,
    status: string,
    manual = false
  ) {
    // Same subscription can be returned twice
    if (!manual && status === this.lastReceivedStatus) {
      return;
    }

    if (
      !this.ready ||
      // Consolidation is advisory (ConsolidationModal prompts the user) and the
      // consolidate() routine already pauses syncing via setActive(false). It
      // must NOT gate normal receive syncing here — otherwise incoming tokens
      // stay queued/invisible while the wallet holds >20 UTXOs until a manual
      // sync. Only defer while the worker is inactive (the queue drains on
      // reactivation via setActive(true) / syncPending).
      (!manual && !this.worker.active)
    ) {
      this.receivedStatuses.push(status);
      return;
    }

    this.ready = false;
    this.lastReceivedStatus = status;
    let failed = false;

    // R10 follow-up: electrum requests reject pending promises when the
    // socket closes mid-flight (heavy-history accounts trigger this when
    // the server returns "excessive resource usage" and drops the
    // connection). Without this try/finally the rejection escapes as
    // an unhandled promise and `this.ready` stays false forever — every
    // subsequent sync is silently skipped.
    try {
      const { added } = await this.updateTXOs(scriptHash, status, manual);

      // Batch insert txos to avoid Safari IndexedDB "out of memory" errors
      // from too many concurrent transactions
      const chunks = arrayChunks(added, 1000);
      for (const chunk of chunks) {
        await db.transaction("rw", db.txo, async () => {
          await db.txo.bulkPut(chunk);
        });
      }

      updateRxdBalances(this.address);

      setSubscriptionStatus(scriptHash, status, false, ContractType.RXD);
    } catch (err) {
      console.warn("[RXD] subscription update failed:", err);
      // Queue this status so the next ready window retries it.
      if (status) this.receivedStatuses.push(status);
      failed = true;
    } finally {
      this.ready = true;
    }

    if (this.receivedStatuses.length > 0) {
      const lastStatus = this.receivedStatuses.pop();
      this.receivedStatuses = [];
      if (lastStatus) {
        const retry = () =>
          this.onSubscriptionReceived(scriptHash, lastStatus).catch((e) =>
            console.warn("[RXD] requeued sync failed:", e)
          );
        // Back off after a failure; retry immediately when the requeue is just
        // draining a status that arrived while we were busy.
        if (failed) setTimeout(retry, RETRY_BACKOFF_MS);
        else retry();
      }
    }

    consolidationCheck();
  }

  async register(address: string) {
    this.scriptHash = p2pkhScriptHash(address as string);
    this.address = address;

    try {
      await this.electrum.client?.subscribe(
        "blockchain.scripthash",
        this.onSubscriptionReceived.bind(this) as ElectrumCallback,
        this.scriptHash
      );
    } catch (error) {
      console.warn(
        "[RXD] Subscription failed, falling back to manual sync:",
        error
      );
      try {
        await this.onSubscriptionReceived(
          this.scriptHash,
          "manual-fallback",
          true
        );
        console.debug("[RXD] Manual fallback sync completed");
      } catch (fallbackError) {
        console.warn("[RXD] Manual fallback also failed:", fallbackError);
      }
    }
  }
}
