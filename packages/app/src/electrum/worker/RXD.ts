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
import setSubscriptionStatus, {
  setSubscriptionError,
} from "./setSubscriptionStatus";
import { Worker } from "./electrumWorker";
import { consolidationCheck } from "./consolidationCheck";
import { updateRxdBalances } from "@app/utxos";
import { arrayChunks } from "@lib/util";
import { SyncRetry } from "./syncRetry";

export class RXDWorker implements Subscription {
  protected worker: Worker;
  protected updateTXOs: ElectrumStatusUpdate;
  private electrum: ElectrumManager;
  protected lastReceivedStatus: string;
  protected ready = true;
  protected receivedStatuses: string[] = [];
  protected address = "";
  protected scriptHash = "";
  // Backoff + circuit breaker so a persistent failure neither hammers the
  // server in a tight loop nor spins the UI "syncing" forever (see syncRetry).
  protected retry = new SyncRetry();
  // Set when the server throttled our subscribe with "excessive resource
  // usage". Once tripped, future register() calls skip subscribe and go
  // straight to manual sync (listunspent polling) — retrying the same
  // subscribe on every reconnect just re-triggers the throttle.
  protected subscribeFailed = false;

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
    let retryDelay = 0;

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
      // Full sync succeeded — clear the failure streak and any error state.
      this.retry.reset();
    } catch (err) {
      console.warn("[RXD] subscription update failed:", err);
      // Queue this status so the next ready window retries it.
      if (status) this.receivedStatuses.push(status);
      failed = true;
      retryDelay = this.retry.fail();
      // After repeated consecutive failures, surface an error sync state so the
      // UI stops showing an indefinite "syncing" spinner. We keep retrying
      // (backed off, capped) so the wallet still recovers on its own when the
      // underlying condition clears.
      if (this.retry.tripped) {
        await setSubscriptionError(scriptHash, ContractType.RXD);
      }
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
        // Exponential backoff after a failure; retry immediately when the
        // requeue is just draining a status that arrived while we were busy.
        if (failed) setTimeout(retry, retryDelay);
        else retry();
      }
    }

    consolidationCheck();
  }

  async register(address: string) {
    this.scriptHash = p2pkhScriptHash(address as string);
    this.address = address;

    // If the onOpen resubscribe loop already re-subscribed us (reconnect
    // with existing subscription), skip — avoids duplicate subscribe requests.
    if (this.electrum.client?.isSubscribed("blockchain.scripthash", this.scriptHash)) {
      console.debug("[RXD] Already subscribed, skipping register");
      return;
    }

    // Reset the throttle flag — we're on a new server (isSubscribed() returned
    // false because the new ElectrumWS instance has an empty subscription map).
    // The new server doesn't have accumulated per-IP cost, so try subscribing.
    this.subscribeFailed = false;

    try {
      await this.electrum.client?.subscribe(
        "blockchain.scripthash",
        this.onSubscriptionReceived.bind(this) as ElectrumCallback,
        this.scriptHash
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("excessive resource usage")) {
        console.warn(
          "[RXD] Subscription throttled (excessive resource usage), switching to manual sync"
        );
        this.subscribeFailed = true;
        // Remove from the WS client's subscription map so onOpen won't
        // re-attempt the subscribe on reconnect.
        try {
          await this.electrum.client?.unsubscribe(
            "blockchain.scripthash",
            this.scriptHash
          );
        } catch {
          // unsubscribe may fail if the subscription was never accepted — ignore
        }
      } else {
        console.warn(
          "[RXD] Subscription failed, falling back to manual sync:",
          error
        );
      }
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
