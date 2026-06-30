import { SmartToken, ContractType, ElectrumCallback, TxO } from "@app/types";
import { NFTWorker } from "./NFT";
import { buildUpdateTXOs } from "./updateTxos";
import ElectrumManager from "@app/electrum/ElectrumManager";
import { ftScript, ftScriptHash, parseFtScript } from "@lib/script";
import db from "@app/db";
import Outpoint, { reverseRef } from "@lib/Outpoint";
import setSubscriptionStatus, {
  setSubscriptionError,
} from "./setSubscriptionStatus";
import { Worker } from "./electrumWorker";
import { consolidationCheck } from "./consolidationCheck";
import { updateFtBalances } from "@app/utxos";
import { arrayChunks } from "@lib/util";
import { verifyFtRefCommitment } from "./verifyTxo";

export class FTWorker extends NFTWorker {
  protected ready = true;
  protected receivedStatuses: string[] = [];
  protected address = "";

  constructor(worker: Worker, electrum: ElectrumManager) {
    super(worker, electrum);
    this.updateTXOs = buildUpdateTXOs(
      this.electrum,
      ContractType.FT,
      (utxo) => {
        const ref = Outpoint.fromShortInput(utxo.refs?.[0]?.ref)
          .reverse()
          .toString();
        if (!ref) return undefined;
        return ftScript(this.address, ref);
      },
      // FIX 2 (token identity): the FT script above is derived from the
      // server's unauthenticated `refs[0].ref` annotation. Cross-check it
      // against the actual on-chain output script before the token's value is
      // counted — a malicious server must not be able to mislabel which token
      // a UTXO belongs to. Mismatches are skipped in updateTxos.
      (utxo, derivedScript) =>
        verifyFtRefCommitment(
          this.electrum.client,
          utxo,
          this.address,
          derivedScript
        )
    );
  }

  async onSubscriptionReceived(
    scriptHash: string,
    status: string,
    manual = false
  ) {
    // Early-return checks run BEFORE the work try/finally so the finally
    // doesn't accidentally flip `this.ready` back to `true` when the
    // !ready guard intentionally bailed out.
    // Same subscription can be returned twice
    if (!manual && status === this.lastReceivedStatus) {
      console.debug("Duplicate subscription received", status);
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

    try {
      const { added, spent } = await this.updateTXOs(
        scriptHash,
        status,
        manual
      );

      // TODO there is some duplication in NFT and FT classes

      const existingRefs: { [key: string]: SmartToken } = {};
      const newRefs: { [key: string]: TxO } = {};
      const scriptRefMap: { [key: string]: string } = {};
      const glyphCache = new Map<string, [string, SmartToken | undefined]>();
      for (const txo of added) {
        if (!glyphCache.has(txo.script)) {
          const { ref: refLE } = parseFtScript(txo.script);
          if (!refLE) continue;
          const ref = reverseRef(refLE);
          scriptRefMap[txo.script] = ref;
          glyphCache.set(txo.script, [
            ref,
            ref ? await db.glyph.get({ ref }) : undefined,
          ]);
        }
        const [ref, glyph] = glyphCache.get(txo.script) as [
          string,
          SmartToken | undefined
        ];
        if (glyph) {
          existingRefs[ref] = glyph;
        } else {
          newRefs[ref] = txo;
        }
      }

      const { related, accepted } = await this.addTokens(newRefs);
      await this.addRelated(related);

      // This next part can take a long time for large wallets so show the progress bar
      let numSynced = 0;
      const updateProgress = async () => {
        await db.subscriptionStatus.update(scriptHash, {
          sync: {
            done: false,
            error: false,
            numSynced,
            numTotal: added.length,
          },
        });
      };

      // Insert txos and glyphs
      // IndexedDB doesn't seem to like lots of inserts at once so batch them
      const chunks = arrayChunks(added, 10000);
      for (const chunk of chunks) {
        await db.transaction("rw", db.txo, db.glyph, async () => {
          console.debug("Adding transactions", chunk.length);
          const ids = (await db.txo.bulkPut(chunk, undefined, {
            allKeys: true,
          })) as number[];
          const newGlyphs = new Map<string, SmartToken>();
          chunk.map((txo, index) => {
            const ref = scriptRefMap[txo.script];
            if (!newGlyphs.has(ref)) {
              newGlyphs.set(ref, existingRefs[ref] || accepted[ref]);
            }
            const glyph = newGlyphs.get(ref);
            if (glyph) {
              glyph.lastTxoId = ids[index];
              glyph.spent = 0;
            }
          });
          const validGlyphs = Array.from(newGlyphs.values()).filter(Boolean);
          for (const validGlyph of validGlyphs) {
            await db.glyph.put(validGlyph);
          }
        });
        numSynced += chunk.length;
        await updateProgress();
      }

      const touched = new Set([
        ...added.map(({ script }) => script),
        ...spent.map(({ script }) => script),
      ]);

      updateFtBalances(touched);

      setSubscriptionStatus(scriptHash, status, false, ContractType.FT);
      // Full sync succeeded — clear the failure streak and any error state.
      this.retry.reset();
    } catch (error) {
      // R10 follow-up: on socket close the in-flight electrum request
      // rejects. Log it, mark the subscription failed, and let `finally`
      // restore `ready` so the next sync isn't permanently skipped.
      console.warn("[FT] subscription update failed:", error);
      if (status) this.receivedStatuses.push(status);
      failed = true;
      retryDelay = this.retry.fail();
      // After repeated consecutive failures, surface an error sync state so the
      // UI stops showing an indefinite "syncing" spinner. We keep retrying
      // (backed off, capped) so the wallet recovers on its own when the
      // condition clears. Not persisting a status keeps the next retry a real
      // re-sync (status stays != newStatus).
      if (this.retry.tripped) {
        await setSubscriptionError(scriptHash, ContractType.FT);
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
            console.warn("[FT] requeued sync failed:", e)
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
    this.scriptHash = ftScriptHash(address as string);
    this.address = address;

    // If the server previously throttled our subscribe with "excessive
    // resource usage", don't retry it — go straight to manual sync.
    if (this.subscribeFailed) {
      console.debug("[FT] Subscribe previously throttled, using manual sync");
      try {
        await this.onSubscriptionReceived(
          this.scriptHash,
          "manual-fallback",
          true
        );
        console.debug("[FT] Manual fallback sync completed");
      } catch (fallbackError) {
        console.warn("[FT] Manual fallback also failed:", fallbackError);
      }
      return;
    }

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
          "[FT] Subscription throttled (excessive resource usage), switching to manual sync"
        );
        this.subscribeFailed = true;
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
          "[FT] Subscription failed, falling back to manual sync:",
          error
        );
      }
      // Subscription may fail for large histories, but listunspent still works
      try {
        await this.onSubscriptionReceived(
          this.scriptHash,
          "manual-fallback",
          true
        );
        console.debug("[FT] Manual fallback sync completed");
      } catch (fallbackError) {
        console.warn("[FT] Manual fallback also failed:", fallbackError);
      }
    }
  }
}
