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
import setSubscriptionStatus from "./setSubscriptionStatus";
import { arrayChunks, batchRequests } from "@lib/util";
import { GLYPH_FT, GLYPH_NFT, GLYPH_WAVE } from "@lib/protocols";
import { Worker } from "./electrumWorker";
import { consolidationCheck } from "./consolidationCheck";

// 500KB size limit
const fileSizeLimit = 500_000;

// Delay before re-running a sync that just failed, so a congested/timing-out
// socket isn't retried in a tight loop (the Safari sync-storm feedback loop).
const RETRY_BACKOFF_MS = 3000;

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
        if (glyph) {
          existingRefs[ref] = glyph;
        } else {
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
            // WAVE names rest under per-update auth covenant scripts that never
            // appear in this address' NFT listunspent, so the scripthash sweep
            // must NOT mark them spent — reconcileWaveNames() tracks them by ref
            // (blockchain.ref.get) and is the sole authority on their state.
            if (g.p?.includes(GLYPH_WAVE)) continue;
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

      // WAVE-name recovery / tracking by ref. A target update re-creates the
      // name's singleton under an auth covenant script that is NOT in this
      // address' NFT listunspent, so the scripthash sync above can neither see
      // nor relink it (and a rescan can't recover it). Resolve each wave name's
      // live location via blockchain.ref.get and re-attach the moved singleton
      // (or mark it gone). Wrapped so a failure never breaks the main sync.
      try {
        await this.reconcileWaveNames();
      } catch (e) {
        console.warn("[NFT] wave-name reconcile failed:", e);
      }

      setSubscriptionStatus(scriptHash, status, false, ContractType.NFT);
    } catch (err) {
      console.warn("[NFT] subscription update failed:", err);
      // Queue the status so a future ready window retries it.
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
            console.warn("[NFT] requeued sync failed:", e)
          );
        // Back off after a failure; retry immediately when the requeue is just
        // draining a status that arrived while we were busy.
        if (failed) setTimeout(retry, RETRY_BACKOFF_MS);
        else retry();
      }
    }

    consolidationCheck();
  }

  /**
   * Reconcile WAVE-name singletons by ref instead of by scripthash.
   *
   * A WAVE-name target update is forced (by the mutable-target covenant) to
   * re-create the name's NFT singleton under an auth script
   * (`OP_REQUIREINPUTREF <mutRef> <scriptSigHash> OP_2DROP … OP_PUSHINPUTREFSINGLETON
   * <ref> OP_DROP <P2PKH>`). RXinDexer keys every UTXO by `sha256(zero_refs(script))`,
   * and `zero_refs` preserves the auth preamble + scriptSig-hash push, so the
   * singleton lands under a per-update scripthash this wallet never subscribes
   * to. It is therefore invisible to `blockchain.scripthash.listunspent`
   * (so a normal sync/rescan can never see or recover it), even though the name
   * is alive on-chain and still owned by us.
   *
   * The name's `ref` is stable, so we track it the reliable way: resolve the
   * live location with `blockchain.ref.get(ref)`, confirm the current output is
   * a singleton for that ref paying to one of our addresses, and re-attach it
   * (upsert a ref-tracked `byRef` txo + un-hide the glyph). If the ref has no
   * live location (burned) or it moved to someone else (transferred), hide it.
   *
   * Bounded by the number of WAVE names held (typically small); the per-name
   * tx fetch is OPFS-cached, so steady state is one cheap `ref.get` per name.
   */
  async reconcileWaveNames() {
    const waveGlyphs = await db.glyph
      .filter((g) => !!g.p?.includes(GLYPH_WAVE))
      .toArray();
    if (!waveGlyphs.length) return;

    const ourTail = p2pkhScript(this.address); // 76a914<our h160>88ac

    for (const g of waveGlyphs) {
      if (!g.ref || g.id === undefined) continue;

      // Resolve the live location of this singleton ref.
      let refResult: { tx_hash: string; height: number }[] | undefined;
      try {
        refResult = (await this.electrum.client?.request(
          "blockchain.ref.get",
          g.ref
        )) as { tx_hash: string; height: number }[];
      } catch (e) {
        console.warn("[NFT] ref.get failed for wave name", g.ref, e);
        continue; // transient — leave existing state untouched
      }

      if (!refResult?.length) {
        // No live ref location: the name was burned/melted. Hide it.
        if (g.spent !== 1) await db.glyph.update(g.id, { spent: 1 });
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

      // Find the singleton output for this ref (plain OR auth) that pays to us.
      let found: { vout: number; script: string; value: number } | undefined;
      for (let i = 0; i < tx.outputs.length; i++) {
        const scriptHex = tx.outputs[i].script.toHex() as string;
        const { ref: refLE, address } = parseNftScript(scriptHex);
        if (!refLE || !address) continue;
        if (reverseRef(refLE) !== g.ref) continue;
        if (!scriptHex.endsWith(ourTail)) continue; // not owned by us
        found = {
          vout: i,
          script: scriptHex,
          value: tx.outputs[i].satoshis as number,
        };
        break;
      }

      if (!found) {
        // Live ref, but the singleton no longer pays to us (transferred away).
        if (g.spent !== 1) await db.glyph.update(g.id, { spent: 1 });
        continue;
      }

      const height = current.height || Infinity;

      // Upsert the ref-tracked singleton txo. `byRef:1` keeps the scripthash
      // sweep (updateTxos) from re-marking it spent on the next sync.
      const existing = await db.txo
        .where({ txid: loc, vout: found.vout })
        .first();
      let txoId: number;
      if (existing?.id !== undefined) {
        await db.txo.update(existing.id, {
          script: found.script,
          value: found.value,
          height,
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
          height,
          spent: 0,
          contractType: ContractType.NFT,
          byRef: 1,
        })) as number;
      }

      if (g.lastTxoId !== txoId || g.spent !== 0 || g.height !== height) {
        await db.glyph.update(g.id, {
          lastTxoId: txoId,
          spent: 0,
          height,
        });
      }
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
   *     `reconcileWaveNames()` attaches the live singleton (auth or plain) and
   *     un-hides it iff it pays to one of our addresses.
   *
   * Returns whether the name is now owned & visible, with a reason on failure.
   */
  async recoverWaveName(name: string): Promise<{
    recovered: boolean;
    name: string;
    ref?: string;
    reason?: string;
  }> {
    const bareName = (name || "").toLowerCase().split(".")[0].trim();
    if (!bareName) return { recovered: false, name, reason: "Empty name" };

    // 1. Resolve name -> registration ref via the indexer.
    let regRef: string | undefined;
    try {
      const res = (await this.electrum.client?.request(
        "wave.resolve",
        bareName
      )) as { ref?: string } | null;
      regRef = res?.ref ?? undefined;
    } catch (e) {
      console.warn("[NFT] recover: wave.resolve failed", e);
    }
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
    await this.reconcileWaveNames();

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

    try {
      await this.electrum.client?.subscribe(
        "blockchain.scripthash",
        this.onSubscriptionReceived.bind(this) as ElectrumCallback,
        this.scriptHash
      );
    } catch (error) {
      console.warn("[NFT] Subscription failed:", error);
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
      embedSource && embedSource.b.length < fileSizeLimit
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
