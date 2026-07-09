/* eslint-disable @typescript-eslint/ban-ts-comment */
import {
  nftScriptHash,
  parseDelegateBurnScript,
  parseDelegateBaseScript,
  parseNftScript,
  nftScript,
  p2pkhScript,
} from "@lib/script";
import {
  Subscription,
  ContractType,
  ElectrumCallback,
  ElectrumStatusUpdate,
  TxO,
  SmartToken,
  SmartTokenType,
} from "@app/types";
import { buildUpdateTXOs } from "./updateTxos";
import { verifyTxoInclusion } from "./verifyTxo";
import db from "@app/db";
import Outpoint, { reverseRef } from "@lib/Outpoint";
import { verifyTransactionHash, hexToBytes } from "@lib/crypto";
import {
  extractRevealPayload,
  filterAttrs,
  isImmutableToken,
} from "@lib/token";
import {
  Transaction,
  // @ts-ignore
} from "@radiant-core/radiantjs";
import { bytesToHex } from "@noble/hashes/utils";
import ElectrumManager from "@app/electrum/ElectrumManager";
import opfs from "@app/opfs";
import setSubscriptionStatus, {
  setSubscriptionError,
} from "./setSubscriptionStatus";
import { arrayChunks, batchRequests } from "@lib/util";
import { GLYPH_FT, GLYPH_NFT, GLYPH_MUT } from "@lib/protocols";
import { Worker } from "./electrumWorker";
import { consolidationCheck } from "./consolidationCheck";
import { SyncRetry } from "./syncRetry";

// 512 KiB on-chain content limit (matches GLYPH_INSCRIPTION_MAX_SIZE / mintEmbedMaxBytes)
const fileSizeLimit = 524_288;

// Reveal-payload decode version. Stamped onto every glyph row `saveGlyph` writes
// (`dv`). The sync re-decodes any owned NFT whose row predates the current
// version exactly once, so fields added to the decoder later (here: the Glyph v2
// `royalty`/`policy` covenant metadata) are backfilled onto rows minted/synced
// by an older build. Without this, a stale row keeps `royalty === undefined`,
// the wallet only offers a royalty-free swap, and the creator is never paid.
// Bump this whenever `saveGlyph` starts persisting a new field existing rows need.
export const GLYPH_DECODE_VERSION = 1;

type TxIdHeight = {
  tx_hash: string;
  height: number;
};
type SingletonGetResponse = [TxIdHeight, TxIdHeight];

const toString = (str: unknown) => (typeof str === "string" ? str : "");

const filterRels = (reveal: Uint8Array[], commit: string[]) =>
  (reveal as Uint8Array[])
    .filter((rel) => rel instanceof Uint8Array)
    .map((rel) => bytesToHex(rel))
    .filter((rel) => commit.includes(rel))
    .map((rel) => Outpoint.fromString(rel).reverse().ref());

export class NFTWorker implements Subscription {
  protected worker: Worker;
  protected updateTXOs: ElectrumStatusUpdate;
  protected electrum: ElectrumManager;
  protected lastReceivedStatus: string;
  protected receivedStatuses: string[] = [];
  protected ready = true;
  protected address = "";
  // Backoff + circuit breaker shared by NFT and FT (FTWorker extends this) so a
  // persistent failure neither hammers the server nor spins "syncing" forever.
  protected retry = new SyncRetry();
  // Set when the server throttled our subscribe with "excessive resource
  // usage". Once tripped, future register() calls skip subscribe and go
  // straight to manual sync — retrying on every reconnect re-triggers the
  // throttle.
  protected subscribeFailed = false;
  protected scriptHash = "";

  constructor(worker: Worker, electrum: ElectrumManager) {
    this.worker = worker;
    this.electrum = electrum;
    this.updateTXOs = buildUpdateTXOs(
      this.electrum,
      ContractType.NFT,
      (utxo) => {
        const ref = Outpoint.fromShortInput(utxo.refs?.[0]?.ref)
          .reverse()
          .toString();
        if (!ref) return undefined;
        return nftScript(this.address, ref);
      }
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

    // R10 follow-up: electrum requests reject pending promises on socket
    // close (the heavy-history "excessive resource usage" path drops the
    // socket mid-fetch). Wrap the body so the rejection doesn't escape
    // as an unhandled promise — and so `this.ready` is restored in
    // `finally` so the next sync attempt isn't permanently skipped.
    try {
      const { added, confs, spent } = await this.updateTXOs(
        scriptHash,
        status,
        manual
      );

      const existingRefs: { [key: string]: SmartToken } = {};
      const newRefs: { [key: string]: TxO } = {};
      const scriptRefMap: { [key: string]: string } = {};
      for (const txo of added) {
        const { ref: refLE } = parseNftScript(txo.script);
        if (!refLE) continue;
        const ref = reverseRef(refLE);
        scriptRefMap[txo.script] = ref;
        const glyph = ref && (await db.glyph.get({ ref }));
        if (glyph && (glyph.dv ?? 0) >= GLYPH_DECODE_VERSION) {
          existingRefs[ref] = glyph;
        } else {
          // New token, OR a known row from a decoder that predates the current
          // GLYPH_DECODE_VERSION — re-decode so v2 covenant metadata
          // (royalty/policy) is backfilled. saveGlyph preserves the existing
          // row's identity + ownership state, so re-decoding an owned token
          // can't make it vanish. Runs at most once per row (then `dv` is set).
          newRefs[ref] = txo;
        }
      }

      const { related, accepted } = await this.addTokens(newRefs);
      await this.addRelated(related);

      // Insert txos and glyphs
      // IndexedDB doesn't seem to like lots of inserts at once so batch them
      const chunks = arrayChunks(added, 10000);
      for (const chunk of chunks) {
        await db.transaction("rw", db.txo, db.glyph, async () => {
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
      }

      // Update any NFTs that have been transferred.
      //
      // A token can be *moved* rather than *sent away*: a WAVE-name target
      // update (and similar covenant respends) co-spends the singleton and
      // re-creates it at a new outpoint in the SAME tx. That new UTXO is in
      // `added` above and the glyph was relinked to it (lastTxoId updated),
      // so the `where({ lastTxoId })` match below normally skips it. Guard
      // explicitly too: never flag a glyph spent when its ref still has a
      // live UTXO this pass — otherwise the name vanishes from the wallet
      // even though it's still owned on-chain.
      const liveRefs = new Set(Object.values(scriptRefMap));
      await db.transaction("rw", db.glyph, async () => {
        for (const lastTxo of spent) {
          const movedGlyphs = await db.glyph
            .where({ lastTxoId: lastTxo.id })
            .toArray();
          for (const g of movedGlyphs) {
            if (g.ref && liveRefs.has(g.ref)) continue; // moved, not spent
            // Ref-tracked NFTs never appear in this address' NFT listunspent, so
            // the scripthash sweep must NOT decide their fate:
            //  - mutable singletons (GLYPH_MUT, incl. WAVE) respend under an auth
            //    covenant on every state/target update → reconcileRefTrackedNfts()
            //    tracks them by ref (blockchain.ref.get), hiding only on a proven
            //    transfer away.
            //  - covenant-escrowed NFTs (listed / soulbound mint) rest in a
            //    covenant script and carry swapPending → syncCovenants() is the
            //    authority on when they resolve.
            if (g.p?.includes(GLYPH_MUT) || g.swapPending) continue;
            if (g.id !== undefined) {
              await db.glyph.update(g.id, { spent: 1 });
            }
          }
        }
      });

      // Update heights
      await db.transaction("rw", db.glyph, async () => {
        for (const [lastTxoId, conf] of confs) {
          await db.glyph
            .where({ lastTxoId })
            .modify({ height: conf.height || Infinity });
        }
      });

      // Mutable-NFT (incl. WAVE) recovery / tracking by ref. A state/target
      // update re-creates the singleton under an auth covenant script that is
      // NOT in this address' NFT listunspent, so the scripthash sync above can
      // neither see nor relink it (and a rescan can't recover it). Resolve each
      // mutable NFT's live location via blockchain.ref.get and re-attach the
      // moved singleton (or hide it only on a proven transfer away). Wrapped so
      // a failure never breaks the main sync.
      try {
        await this.reconcileRefTrackedNfts();
      } catch (e) {
        console.warn("[NFT] ref-tracked NFT reconcile failed:", e);
      }

      setSubscriptionStatus(scriptHash, status, false, ContractType.NFT);
      // Full sync succeeded — clear the failure streak and any error state.
      this.retry.reset();
    } catch (err) {
      console.warn("[NFT] subscription update failed:", err);
      // Queue the status so a future ready window retries it.
      if (status) this.receivedStatuses.push(status);
      failed = true;
      retryDelay = this.retry.fail();
      // After repeated consecutive failures, surface an error sync state so the
      // UI stops showing an indefinite "syncing" spinner. We keep retrying
      // (backed off, capped) so the wallet recovers on its own when the
      // condition clears.
      if (this.retry.tripped) {
        await setSubscriptionError(scriptHash, ContractType.NFT);
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
            console.warn("[NFT] requeued sync failed:", e)
          );
        // Exponential backoff after a failure; retry immediately when the
        // requeue is just draining a status that arrived while we were busy.
        if (failed) setTimeout(retry, retryDelay);
        else retry();
      }
    }

    consolidationCheck();
  }

  /**
   * Reconcile mutable-NFT singletons (GLYPH_MUT, which includes WAVE names) by
   * ref instead of by scripthash.
   *
   * A mutable NFT's state/target update is forced (by the mutable covenant) to
   * re-create its NFT singleton under an auth script
   * (`OP_REQUIREINPUTREF <mutRef> <scriptSigHash> OP_2DROP … OP_PUSHINPUTREFSINGLETON
   * <ref> OP_DROP <P2PKH>`). RXinDexer keys every UTXO by `sha256(zero_refs(script))`,
   * and `zero_refs` preserves the auth preamble + scriptSig-hash push, so the
   * singleton lands under a per-update scripthash this wallet never subscribes
   * to. It is therefore invisible to `blockchain.scripthash.listunspent` (so a
   * normal sync/rescan can never see or relink it), even though the token is
   * alive on-chain and still owned by us. (Covenant-escrowed NFTs — listed /
   * soulbound — are handled separately by covenant.ts/syncCovenants.)
   *
   * The token's `ref` is stable, so we track it the reliable way: resolve the
   * live location with `blockchain.ref.get(ref)`, confirm the current output is
   * a singleton for that ref paying to one of our addresses, and re-attach it
   * (upsert a ref-tracked `byRef` txo + un-hide the glyph). We hide ONLY on
   * proof of a transfer away (the singleton found at its current location paying
   * to a different address); transient/ambiguous lookups leave the row visible.
   *
   * Cost control: a glyph that already has a healthy ref-tracked txo
   * (spent:0 + byRef) was reconciled on a prior pass and is skipped, so steady
   * state makes no network calls — only stale/lost/just-seeded glyphs do a
   * `ref.get` (+ an OPFS-cached tx fetch).
   */
  async reconcileRefTrackedNfts() {
    const glyphs = await db.glyph
      .filter((g) => !!g.p?.includes(GLYPH_MUT))
      .toArray();
    if (!glyphs.length) return;

    const ourTail = p2pkhScript(this.address); // 76a914<our h160>88ac

    for (const g of glyphs) {
      if (!g.ref || g.id === undefined) continue;

      // Skip the network round-trip for glyphs already healthy & ref-tracked
      // (reconciled on a prior pass). Only re-confirm stale/lost ones — e.g. a
      // just-seeded recovery (spent:1), or a row whose linked txo isn't a live
      // byRef singleton.
      //
      // A confirmed height is part of "healthy": a glyph first reconciled while
      // its singleton was still in the mempool stored the byRef txo at
      // height:Infinity (ref.get height 0). byRef singletons never appear in
      // this address' listunspent, so the updateTxos confs path can't heal them
      // — `reconcileRefTrackedNfts` is their ONLY height source. Without the
      // height check below, such a glyph would be treated as "done" and latch at
      // height:Infinity forever, showing PENDING even after the tx confirms.
      // Keep re-resolving until we've recorded a real (non-Infinity) height.
      if (g.spent === 0 && g.lastTxoId !== undefined) {
        const cur = await db.txo.get(g.lastTxoId);
        if (
          cur &&
          cur.spent === 0 &&
          cur.byRef === 1 &&
          cur.height !== Infinity
        )
          continue;
      }

      // Resolve the live location of this singleton ref.
      let refResult: { tx_hash: string; height: number }[] | undefined;
      try {
        refResult = (await this.electrum.client?.request(
          "blockchain.ref.get",
          g.ref
        )) as { tx_hash: string; height: number }[];
      } catch (e) {
        console.warn("[NFT] ref.get failed for mutable NFT", g.ref, e);
        continue; // transient — leave existing state untouched
      }

      if (!refResult?.length) {
        // Ambiguous: ref.get returned nothing — could be a transient server
        // hiccup or a not-yet-indexed update. NEVER hide on this: a target
        // update must not make the name vanish. Leave the row as-is. A genuine
        // burn/melt is recorded spent:1 by the burn/melt handler itself.
        continue;
      }

      const current = refResult[refResult.length - 1];
      const loc = current.tx_hash;

      // Fetch (hash-verified, OPFS-cached) the tx holding the current location.
      let hex = await opfs.getTx(loc);
      if (!hex) {
        hex = (await this.electrum.client?.request(
          "blockchain.transaction.get",
          loc
        )) as string;
        if (hex) {
          try {
            if (verifyTransactionHash(hexToBytes(hex), loc)) {
              await opfs.putTx(loc, hex);
            } else {
              console.error(
                `[NFT] SECURITY: tx hash mismatch for wave location ${loc}`
              );
              hex = "";
            }
          } catch {
            hex = "";
          }
        }
      }
      if (!hex) continue;

      const tx = new Transaction(hex);

      // Find the singleton output for THIS ref at the current location. Track
      // separately whether it pays to us vs. to a different address, so we only
      // ever hide on POSITIVE evidence of a transfer away — never on a transient
      // fetch/parse miss, which must not make a name the user still owns vanish.
      let foundOurs:
        | { vout: number; script: string; value: number }
        | undefined;
      let foundForRefElsewhere = false;
      for (let i = 0; i < tx.outputs.length; i++) {
        const scriptHex = tx.outputs[i].script.toHex() as string;
        const { ref: refLE } = parseNftScript(scriptHex);
        if (!refLE || reverseRef(refLE) !== g.ref) continue;
        if (scriptHex.endsWith(ourTail)) {
          foundOurs = {
            vout: i,
            script: scriptHex,
            value: tx.outputs[i].satoshis as number,
          };
          break;
        }
        foundForRefElsewhere = true; // singleton for this ref, but not our key
      }

      if (!foundOurs) {
        // Only hide when we POSITIVELY saw this name's singleton pay to another
        // address (sold/transferred). If no singleton for this ref was found at
        // the current location (transient fetch/parse miss, or an in-flight
        // update), leave the row visible — a target update must never hide it.
        if (foundForRefElsewhere && g.spent !== 1) {
          await db.glyph.update(g.id, { spent: 1 });
        }
        continue;
      }
      const found = foundOurs;

      // Upsert the ref-tracked singleton txo. `byRef:1` keeps the scripthash
      // sweep (updateTxos) from re-marking it spent on the next sync.
      const existing = await db.txo
        .where({ txid: loc, vout: found.vout })
        .first();

      // Resolve the confirmation height. blockchain.ref.get reports height 0 not
      // only for genuinely-mempool singletons but ALSO for confirmed ones whose
      // height the indexer hasn't resolved yet (RXinDexer ref.get cache lag). A
      // raw 0 here stores the byRef txo at height:Infinity, and because byRef
      // singletons never reappear in listunspent to be healed, the NFT/name then
      // shows "Unconfirmed" forever. So when ref.get gives no height, try to
      // recover the real one, and never regress a height we already recorded.
      let height = current.height && current.height > 0 ? current.height : 0;
      if (!height) {
        height = await this.resolveSingletonHeight(loc);
      }
      const finalHeight =
        height > 0
          ? height
          : existing?.height !== undefined
          ? existing.height
          : Infinity;

      let txoId: number;
      if (existing?.id !== undefined) {
        await db.txo.update(existing.id, {
          script: found.script,
          value: found.value,
          height: finalHeight,
          spent: 0,
          contractType: ContractType.NFT,
          byRef: 1,
        });
        txoId = existing.id;
      } else {
        txoId = (await db.txo.put({
          txid: loc,
          vout: found.vout,
          script: found.script,
          value: found.value,
          height: finalHeight,
          spent: 0,
          contractType: ContractType.NFT,
          byRef: 1,
        })) as number;
      }

      if (g.lastTxoId !== txoId || g.spent !== 0 || g.height !== finalHeight) {
        await db.glyph.update(g.id, {
          lastTxoId: txoId,
          spent: 0,
          height: finalHeight,
        });
      }
    }
  }

  /**
   * Recover the confirmed block height of a ref-tracked singleton location when
   * `blockchain.ref.get` reports height 0.
   *
   * ref.get returns 0 both for genuinely-mempool singletons and for confirmed
   * ones whose height the indexer hasn't caught up on yet — the two are
   * indistinguishable from ref.get alone. So we ask the daemon (via the indexer)
   * for the tx's confirmation count, derive the height against our locally-synced
   * header tip, then PROVE that height with a Merkle proof. Requiring the proof
   * means a transient client/daemon tip mismatch (an off-by-one while still
   * catching up) can never persist a wrong height: an unprovable candidate
   * returns 0 and the caller leaves the singleton unconfirmed, to be retried on
   * the next sync. Genuinely-mempool txs (no confirmations) also return 0.
   */
  protected async resolveSingletonHeight(loc: string): Promise<number> {
    try {
      const verbose = (await this.electrum.client?.request(
        "blockchain.transaction.get",
        loc,
        true
      )) as { confirmations?: number } | undefined;
      const confs = verbose?.confirmations;
      if (typeof confs !== "number" || confs < 1) return 0; // mempool / unknown

      const tip = await db.header.orderBy("height").last();
      if (!tip || typeof tip.height !== "number") return 0;

      const candidate = tip.height - confs + 1;
      if (candidate <= 0) return 0;

      // Only trust the candidate once its Merkle proof checks out against our
      // own PoW-validated header — otherwise we were lagging the chain; stay
      // unconfirmed and retry next sync rather than store a wrong height.
      const proven = await verifyTxoInclusion(
        this.electrum.client,
        loc,
        candidate
      );
      return proven ? candidate : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Recover a WAVE name into this wallet by name.
   *
   * Needed when the local glyph row is gone (e.g. a wallet rebuild) AND the
   * name rests under an auth-covenant singleton (post target-update) that never
   * appears in this address' NFT `listunspent`. Such a name can't be discovered
   * by the ordinary sync at all, so we seed it from the chain:
   *
   *  1. Resolve the name on the indexer to its registration outpoint. NOTE the
   *     indexer returns the REGISTRATION (mint) txid as the ref — NOT the
   *     singleton's funding-outpoint ref that `blockchain.ref.get` keys on.
   *  2. Fetch the mint tx and read the singleton output to derive the REAL
   *     singleton ref (the funding outpoint embedded after OP_PUSHINPUTREFSINGLETON).
   *  3. `fetchGlyph(realRef)` seeds the glyph row from the reveal, then
   *     `reconcileRefTrackedNfts()` attaches the live singleton (auth or plain) and
   *     un-hides it iff it pays to one of our addresses.
   *
   * Returns whether the name is now owned & visible, with a reason on failure.
   */
  async recoverWaveName(
    name: string,
    regRef: string
  ): Promise<{
    recovered: boolean;
    name: string;
    ref?: string;
    reason?: string;
  }> {
    const bareName = (name || "").toLowerCase().split(".")[0].trim();
    if (!bareName) return { recovered: false, name, reason: "Empty name" };
    // `regRef` is the indexer's registration outpoint for the name, resolved by
    // the caller (electrumWorker.recoverWaveName) which has the connected-server
    // + RXinDexer WSS fallback. NOTE it's the MINT outpoint, NOT the singleton's
    // funding-outpoint ref that ref.get keys on — we derive the real ref below.
    if (!regRef) {
      return {
        recovered: false,
        name: bareName,
        reason: "Name not found on the indexer",
      };
    }

    // resolve() returns the registration outpoint as "<mintTxid>_<vout>".
    const mintTxid = regRef.split("_")[0];
    if (!mintTxid || mintTxid.length !== 64) {
      return {
        recovered: false,
        name: bareName,
        reason: "Unexpected registration ref from indexer",
      };
    }

    // 2. Fetch the mint tx (hash-verified, OPFS-cached) and derive the REAL
    //    singleton ref from its singleton output.
    let hex = await opfs.getTx(mintTxid);
    if (!hex) {
      hex = (await this.electrum.client?.request(
        "blockchain.transaction.get",
        mintTxid
      )) as string;
      if (hex) {
        try {
          if (verifyTransactionHash(hexToBytes(hex), mintTxid)) {
            await opfs.putTx(mintTxid, hex);
          } else {
            hex = "";
          }
        } catch {
          hex = "";
        }
      }
    }
    if (!hex) {
      return {
        recovered: false,
        name: bareName,
        reason: "Could not fetch the registration transaction",
      };
    }

    const tx = new Transaction(hex);
    let singletonRefBE: string | undefined;
    for (const o of tx.outputs) {
      const { ref: refLE } = parseNftScript(o.script.toHex());
      if (refLE) {
        singletonRefBE = reverseRef(refLE);
        break;
      }
    }
    if (!singletonRefBE) {
      return {
        recovered: false,
        name: bareName,
        reason: "No singleton output in the registration transaction",
      };
    }

    // 3. Seed the glyph row, then reconcile by ref to attach the live singleton.
    await this.fetchGlyph(singletonRefBE);
    await this.reconcileRefTrackedNfts();

    const g = await db.glyph.get({ ref: singletonRefBE });
    if (g && g.spent === 0) {
      return { recovered: true, name: bareName, ref: singletonRefBE };
    }
    return {
      recovered: false,
      name: bareName,
      ref: singletonRefBE,
      reason: g
        ? "Found on-chain but not owned by this wallet"
        : "Could not index the name",
    };
  }

  async register(address: string) {
    this.scriptHash = nftScriptHash(address as string);
    this.address = address;

    // If the onOpen resubscribe loop already re-subscribed us (reconnect
    // with existing subscription), skip — avoids duplicate subscribe requests.
    if (this.electrum.client?.isSubscribed("blockchain.scripthash", this.scriptHash)) {
      console.debug("[NFT] Already subscribed, skipping register");
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
          "[NFT] Subscription throttled (excessive resource usage), switching to manual sync"
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
        console.warn("[NFT] Subscription failed:", error);
      }
      try {
        await this.onSubscriptionReceived(
          this.scriptHash,
          "manual-fallback",
          true
        );
        console.debug("[NFT] Manual fallback sync completed");
      } catch (fallbackError) {
        console.warn("[NFT] Manual fallback also failed:", fallbackError);
      }
    }
  }

  /**
   * Add new glyphs to the database
   *
   * @param refs TxOs containing glyph data
   * @param txMap Map of new transactions returned from ElectrumX
   * @returns glyphs added to the database and any related refs that were found
   */
  async addTokens(refs: {
    [key: string]: TxO | undefined;
  }): Promise<{ accepted: { [key: string]: SmartToken }; related: string[] }> {
    const refEntries = Object.entries(refs);
    console.debug("Adding tokens", Object.keys(refs).length);

    // Get reveal transaction ids for all tokens
    // Reveal txids indexed by ref
    const fresh: string[] = []; // Keep track of which refs are fresh mints
    const refReveals = await batchRequests<[string, TxO | undefined], string>(
      refEntries,
      6,
      async ([ref, txo]) => {
        const result = (await this.electrum.client?.request(
          "blockchain.ref.get",
          ref
        )) as SingletonGetResponse;
        console.debug("ref.get", ref, result);
        const revealTxId = result.length ? result[0].tx_hash : "";

        // Check if this is freshly minted
        if (txo?.txid === revealTxId) {
          fresh.push(ref);
        }

        return [ref, revealTxId];
      }
    );

    // Dedup reveal txids
    const revealTxIds = Array.from(
      new Set(Object.values(refReveals) as string[])
    ).filter(Boolean);
    const foundDelegates = new Set<string>();

    // Fetch reveals, object is indexed by txid
    // Serialize to avoid Safari IndexedDB "out of memory" from concurrent transactions
    const revealTxResults: [
      string,
      { tx: Transaction; delegates: string[] }
    ][] = [];
    for (const revealTxId of revealTxIds) {
      // Check if it's cached
      let hex = await opfs.getTx(revealTxId);

      if (!hex) {
        hex = (await this.electrum.client?.request(
          "blockchain.transaction.get",
          revealTxId
        )) as string;

        // SECURITY FIX (C5): Verify transaction hash matches txid
        // This prevents transaction poisoning from malicious servers
        if (hex) {
          try {
            const txBytes = hexToBytes(hex);
            if (!verifyTransactionHash(txBytes, revealTxId)) {
              console.error(
                `[NFT] SECURITY ALERT: Transaction hash mismatch for reveal ${revealTxId}`
              );
              hex = ""; // Clear to skip processing
            }
          } catch (verifyError) {
            console.error(
              `[NFT] Transaction verification failed for ${revealTxId}:`,
              verifyError
            );
            hex = ""; // Clear to skip processing
          }
        }

        // Store in cache only if verification passed
        if (hex) {
          await opfs.putTx(revealTxId, hex);
        }
      }

      if (hex) {
        const tx = new Transaction(hex);

        // Look for delegate burn
        const delegates = tx.outputs
          .map(
            (o: { script: { toHex: () => string } }) =>
              parseDelegateBurnScript(o.script.toHex()) as string
          )
          .filter(Boolean);
        if (delegates.length) console.debug(`Found delegates`, delegates);
        delegates.forEach(foundDelegates.add, foundDelegates);

        // Also save delegates so we don't need to look for them again later in saveGlyph
        revealTxResults.push([revealTxId, { tx, delegates }]);
      } else {
        console.warn("Reveal tx not found", revealTxId);
      }
    }
    const revealTxs = Object.fromEntries(revealTxResults);

    // Fetch any delegate refs that were found
    // Serialize to avoid Safari IndexedDB "out of memory" from concurrent transactions
    const delegateRefResults: [string, string[]][] = [];
    for (const delegateRef of Array.from(foundDelegates)) {
      // Check if it's cached
      // FIXME should this use txid instead of ref?
      const refBE = Outpoint.fromString(delegateRef).reverse();
      let hex = await opfs.getTx(refBE.toString());

      // Fetch
      if (!hex) {
        hex = (await this.electrum.client?.request(
          "blockchain.transaction.get",
          refBE.getTxid()
        )) as string;

        // SECURITY FIX (C5): Verify transaction hash matches txid
        // This prevents transaction poisoning from malicious servers
        if (hex) {
          try {
            const txBytes = hexToBytes(hex);
            if (!verifyTransactionHash(txBytes, refBE.getTxid())) {
              console.error(
                `[NFT] SECURITY ALERT: Transaction hash mismatch for ref ${refBE.getTxid()}`
              );
              hex = ""; // Clear to skip processing
            }
          } catch (verifyError) {
            console.error(
              `[NFT] Transaction verification failed for ${refBE.getTxid()}:`,
              verifyError
            );
            hex = ""; // Clear to skip processing
          }
        }

        // Store in cache only if verification passed
        if (hex) await opfs.putTx(refBE.toString(), hex);
      }

      if (hex) {
        const tx = new Transaction(hex);
        const requiredRefs = parseDelegateBaseScript(
          tx.outputs[refBE.getVout()].script.toHex()
        );
        if (requiredRefs.length) {
          delegateRefResults.push([delegateRef, requiredRefs]);
        }
      }
    }
    const delegateRefMap = Object.fromEntries(delegateRefResults);

    if (Object.keys(delegateRefMap).length) {
      console.debug("Delegate refs", delegateRefMap);
    }

    const accepted: { [key: string]: SmartToken } = {};
    // Serialize to avoid Safari IndexedDB "out of memory" from concurrent transactions
    const relatedArrs: string[][] = [];
    for (const [ref, txo] of refEntries) {
      const delegatedRefs =
        revealTxs[refReveals[ref]]?.delegates.flatMap(
          (r) => delegateRefMap[r]
        ) || [];
      const revealTx = revealTxs[refReveals[ref]]?.tx;
      // Will be undefined if the token wasn't found
      if (!revealTx) {
        relatedArrs.push([]);
        continue;
      }
      const { related, valid, glyph } = await this.saveGlyph(
        ref,
        txo,
        revealTx,
        delegatedRefs,
        fresh.includes(ref)
      );
      if (valid && glyph) {
        accepted[glyph.ref] = glyph;
      }
      relatedArrs.push(related);
    }

    // Flatten and dedup related arrays
    const related = Array.from(new Set(relatedArrs.flat()));

    return { accepted, related };
  }

  // Decode a glyph and save to the database. Return the name so the user can be notified
  async saveGlyph(
    ref: string,
    receivedTxo: TxO | undefined, // Received txo can be undefined when token is an author or container dependency
    reveal: Transaction,
    delegatedRefs: string[],
    fresh: boolean
  ): Promise<{ related: string[]; valid?: boolean; glyph?: SmartToken }> {
    const { revealIndex, glyph } = extractRevealPayload(ref, reveal.inputs);
    if (!glyph) {
      console.info("Unrecognised token");
      return { related: [], valid: false };
    }

    let location = undefined;
    if (
      glyph.payload.loc !== undefined &&
      Number.isInteger(glyph.payload.loc)
    ) {
      // Location is set to a ref vout. Get the payload and merge.
      const vout = glyph.payload.loc as number;
      const op = Outpoint.fromString(ref);
      const linkedRef = Outpoint.fromUTXO(op.getTxid(), vout).toString();
      const linked = extractRevealPayload(linkedRef, reveal.inputs);
      if (linked.revealIndex >= 0 && linked.glyph?.payload) {
        glyph.payload = { ...linked.glyph.payload, ...glyph.payload };
        glyph.embeddedFiles = {
          ...linked.glyph.embeddedFiles,
          ...glyph.embeddedFiles,
        };
        glyph.remoteFiles = {
          ...linked.glyph.remoteFiles,
          ...glyph.remoteFiles,
        };
        location = linkedRef;
      }
    }

    const related: string[] = [];
    const { payload, embeddedFiles, remoteFiles } = glyph;

    const protocols = payload.p;

    const contract = protocols.includes(GLYPH_FT)
      ? "ft"
      : protocols.includes(GLYPH_NFT)
      ? "nft"
      : undefined;

    if (!contract) {
      console.info("Unregognised protocol");
      return { related: [], valid: false };
    }
    const { in: containers, by: authors } = payload;
    // Map token protocol to enum
    const tokenType =
      SmartTokenType[contract.toUpperCase() as keyof typeof SmartTokenType];

    // Look for related tokens in outputs
    const outputTokens = reveal.outputs
      .map(
        (o: { script: { toHex: () => string } }) =>
          parseNftScript(o.script.toHex()).ref
      ) // TODO handle FT, dat
      .filter(Boolean) as string[];
    // Validate any author and container properties
    const allRefs = [...delegatedRefs, ...outputTokens];
    const container = containers ? filterRels(containers, allRefs)[0] : "";
    const author = authors ? filterRels(authors, allRefs)[0] : "";

    const type = toString(payload.type) || "object";
    const immutable = isImmutableToken(payload);

    const remote = remoteFiles.main;
    // Support dual-file tokens: use preview for thumbnails, fallback to main
    const embedSource = embeddedFiles.preview || embeddedFiles.main;
    const embed =
      embedSource && embedSource.b.length <= fileSizeLimit
        ? embedSource
        : undefined;

    // Containers and authors will be fetched later
    if (container) related.push(container);
    if (author) related.push(author);

    const ticker =
      typeof payload.ticker === "string"
        ? payload.ticker.substring(0, 20)
        : undefined;
    const name = toString(payload.name).substring(0, 80);
    const record: SmartToken = {
      dv: GLYPH_DECODE_VERSION,
      p: protocols,
      ref,
      tokenType,
      ticker,
      revealOutpoint: Outpoint.fromUTXO(reveal.id, revealIndex).toString(),
      spent: receivedTxo ? 0 : 1, // If not owned by user then set as spent
      fresh: fresh ? 1 : 0,
      type,
      immutable,
      location,
      name,
      description: toString(payload.desc).substring(0, 1000),
      author,
      container,
      attrs: payload.attrs ? filterAttrs(payload.attrs) : {},
      // TODO store files in OPFS instead of IndexedDB
      embed,
      remote,
      height: receivedTxo?.height || Infinity,
      // Encrypted NFT fields — persisted so decryption UI can retrieve them
      ...(payload.crypto !== undefined ? { crypto: payload.crypto } : {}),
      ...(payload.main !== undefined ? { main: payload.main } : {}),
      // FT decimals (Glyph v2 §9.4): default 8 (1 photon = 1 token unit).
      ...((payload as { decimals?: number }).decimals !== undefined
        ? { decimals: (payload as { decimals?: number }).decimals }
        : {}),
      // Glyph v2 covenant metadata — persisted so the royalty-listing flow can
      // recover the creator's recorded terms and badges reflect enforced
      // royalty / soulbound policy. (Cast: SmartTokenPayload allows arbitrary
      // v2 fields but doesn't type royalty/policy.)
      ...((payload as { royalty?: unknown }).royalty !== undefined
        ? { royalty: (payload as { royalty?: SmartToken["royalty"] }).royalty }
        : {}),
      ...((payload as { policy?: unknown }).policy !== undefined
        ? { policy: (payload as { policy?: SmartToken["policy"] }).policy }
        : {}),
    };

    // Merge onto any existing row instead of inserting a duplicate (the `&ref`
    // unique index would otherwise reject a re-decode). This makes saveGlyph
    // idempotent so the metadata backfill (and fetchGlyph refresh) can re-run
    // over a known token. When the re-decode has no received txo — fetchGlyph
    // passes `undefined` — preserve the prior row's ownership/visibility state
    // so an owned NFT isn't regressed to spent/unowned and vanish from the grid.
    const prior = await db.glyph.get({ ref }).catch(() => undefined);
    if (prior?.id !== undefined) {
      record.id = prior.id;
      if (prior.swapPending !== undefined)
        record.swapPending = prior.swapPending;
      record.fresh = prior.fresh; // don't re-flash the "fresh mint" state
      if (!receivedTxo) {
        record.spent = prior.spent;
        record.height = prior.height;
        record.lastTxoId = prior.lastTxoId;
        record.location = prior.location ?? record.location;
      }
    }
    record.id = (await db.glyph.put(record)) as number;

    return {
      related,
      valid: true,
      glyph: record,
    };
  }

  async addRelated(related: string[]) {
    // Check if there are any new related tokens to fetch
    // Serialize to avoid Safari IndexedDB "out of memory" from concurrent transactions
    const newRelated: string[] = [];
    for (const ref of related) {
      const exists = await db.glyph.get({ ref });
      if (!exists) {
        newRelated.push(ref);
      }
    }

    // Fetch containers and authors
    if (newRelated.length > 0) {
      console.debug("Fetching related", newRelated);
      console.debug(`Existing related: ${related.length - newRelated.length}`);

      // Fetch new related tokens. A TxO is not needed for these since they are not owned by this user
      // Only a glyph record is needed for displaying the author and container names
      const relatedRefs = newRelated.map((ref) => [ref, undefined]);

      await this.addTokens(Object.fromEntries(relatedRefs));
    }
  }

  // Fetch a glyph, add it to the database and return the id
  async fetchGlyph(refBE: string) {
    const { accepted } = await this.addTokens({ [refBE]: undefined });
    if (accepted[refBE]) {
      return accepted[refBE];
    }
    return undefined;
  }
}
