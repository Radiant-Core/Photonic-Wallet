/**
 * Local tracking for tokens resting in on-chain covenants.
 *
 * The NFT subscription only discovers tokens in the plain zero-ref `nftScript`
 * template (RXinDexer indexes those by owner). A token moved into a covenant —
 * a royalty *listing* (`royaltySaleScript`), a *soulbound* mint
 * (`soulboundNftScript`), or an *authority-gated* mint (`authorityGatedNftScript`)
 * — rests in a scriptPubKey with the singleton ref baked in, so it has a unique
 * scripthash the by-owner subscription never sees and would otherwise vanish
 * from the wallet.
 *
 * Until the indexer is taught to recognise these patterns and index them by
 * owner (see docs/covenants-royalty-soulbound-authority.md §5.1), the wallet
 * tracks them locally here, exactly the way PSRT swaps are tracked in
 * `db.swap` + `syncSwaps`. `recordCovenant` is called by the flows that create a
 * covenant UTXO (list / soulbound mint / authority mint); `syncCovenants`
 * reconciles each ACTIVE covenant against the chain and marks it RESOLVED once
 * its UTXO is spent (bought, cancelled, burned, or moved).
 */
import { signal } from "@preact/signals-react";
import { scriptHash as scriptToHash } from "@lib/script";
import { soulboundNftScript, parseSoulboundRef } from "@lib/soulbound";
import {
  authorityGatedNftScript,
  parseAuthorityGatedScript,
} from "@lib/authority";
import { reverseRef } from "@lib/Outpoint";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — radiantjs ships partial types
import { Transaction } from "@radiant-core/radiantjs";
import {
  ElectrumStatus,
  ContractType,
  CovenantRecord,
  CovenantStatus,
  CovenantType,
  CovenantRoyaltyTerms,
} from "./types";
import db from "./db";
import { electrumWorker } from "./electrum/Electrum";
import { electrumStatus } from "./signals";

const ZERO_REF = "00".repeat(36);

/**
 * A shareable royalty listing. The royalty covenant needs no maker signature —
 * a buyer only needs the covenant UTXO and the committed terms to build a valid
 * purchase (buildRoyaltyPurchaseTx). The seller exports this descriptor (the way
 * a PSRT swap exports its hex) and the buyer imports it on the marketplace's
 * "Buy a listing" box.
 */
export interface ListingDescriptor {
  ref: string; // token ref, BE display form
  name?: string;
  covenantUtxo: { txid: string; vout: number; script: string; value: number };
  terms: CovenantRoyaltyTerms;
}

export function encodeListingDescriptor(d: ListingDescriptor): string {
  // base64(JSON) — compact, copy-pasteable, no signature material inside.
  return btoa(JSON.stringify(d));
}

export function decodeListingDescriptor(s: string): ListingDescriptor {
  let obj: unknown;
  try {
    obj = JSON.parse(atob(s.trim()));
  } catch {
    throw new Error("Invalid listing descriptor");
  }
  const d = obj as ListingDescriptor;
  if (
    !d ||
    typeof d.ref !== "string" ||
    !d.covenantUtxo ||
    typeof d.covenantUtxo.txid !== "string" ||
    typeof d.covenantUtxo.vout !== "number" ||
    typeof d.covenantUtxo.script !== "string" ||
    typeof d.covenantUtxo.value !== "number" ||
    !d.terms ||
    !Array.isArray(d.terms.royalties)
  ) {
    throw new Error("Malformed listing descriptor");
  }
  return d;
}

/** Build the shareable descriptor for an active royalty listing record. */
export function listingDescriptorFromCovenant(
  cov: CovenantRecord,
  name?: string
): ListingDescriptor | undefined {
  if (!cov.terms) return undefined;
  return {
    ref: cov.ref,
    name,
    covenantUtxo: {
      txid: cov.txid,
      vout: cov.vout,
      script: cov.script,
      value: cov.value,
    },
    terms: cov.terms,
  };
}

/**
 * Make a covenant-held token render in the wallet NFT grid.
 *
 * The grid only shows glyphs that have `spent:0`, a `lastTxoId`, AND a matching
 * `db.txo` row (see Wallet.tsx). A covenant token is never produced by the
 * by-owner NFT subscription (it rests in a covenant script, not the plain
 * nftScript), so it has no txo and would be invisible. We synthesise a `byRef`
 * txo for the covenant UTXO and link the glyph to it — the same shape
 * reconcileRefTrackedNfts uses for mutable singletons. `byRef:1` + the glyph's
 * `swapPending` flag keep the scripthash sweep from re-marking it spent.
 */
export const materializeCovenantUtxo = async (o: {
  ref: string; // BE display form
  txid: string;
  vout: number;
  script: string;
  value: number;
  height?: number;
}): Promise<void> => {
  const height = o.height && o.height > 0 ? o.height : Infinity;
  const existing = await db.txo
    .where({ txid: o.txid, vout: o.vout })
    .first()
    .catch(() => undefined);
  let txoId: number;
  if (existing?.id !== undefined) {
    await db.txo.update(existing.id, {
      script: o.script,
      value: o.value,
      height,
      spent: 0,
      contractType: ContractType.NFT,
      byRef: 1,
    });
    txoId = existing.id;
  } else {
    txoId = (await db.txo.put({
      txid: o.txid,
      vout: o.vout,
      script: o.script,
      value: o.value,
      height,
      spent: 0,
      contractType: ContractType.NFT,
      byRef: 1,
    })) as number;
  }
  await db.glyph
    .where({ ref: o.ref })
    .modify({ lastTxoId: txoId, spent: 0, swapPending: true })
    .catch(() => undefined);
};

/** Insert/replace a covenant record. Dedups on the unique [txid+vout] index. */
export const recordCovenant = async (
  record: Omit<CovenantRecord, "id" | "status" | "date"> &
    Partial<Pick<CovenantRecord, "status" | "date">>
): Promise<number> => {
  const existing = await db.covenant
    .where("[txid+vout]")
    .equals([record.txid, record.vout])
    .first()
    .catch(() => undefined);
  const full: CovenantRecord = {
    status: CovenantStatus.ACTIVE,
    date: Date.now(),
    ...record,
  };
  if (existing?.id) {
    await db.covenant.update(existing.id, full);
    return existing.id;
  }
  return (await db.covenant.put(full)) as number;
};

export const loading = signal(false);

/**
 * Reconcile ACTIVE covenants against the chain. A covenant whose UTXO is no
 * longer unspent has been resolved (listing bought/cancelled, soulbound
 * burned/moved). When a listing resolves we clear the swap-pending-style flag
 * on its glyph; cancellation returns the NFT to `nftScript(owner)`, which the
 * ordinary subscription re-discovers.
 */
export const syncCovenants = async () => {
  if (loading.value) return;
  loading.value = true;
  try {
    if (electrumStatus.value !== ElectrumStatus.CONNECTED) return;
    const active = await db.covenant
      .where({ status: CovenantStatus.ACTIVE })
      .toArray();
    if (active.length === 0) return;

    // Group outpoints by scripthash so we make one listunspent call per script.
    for (const cov of active) {
      let unspent: { tx_hash: string; tx_pos: number }[] = [];
      try {
        unspent = (await electrumWorker.value.getUtxosByScriptHash(
          scriptToHash(cov.script)
        )) as { tx_hash: string; tx_pos: number }[];
      } catch {
        // Transient lookup failure — leave the covenant ACTIVE and retry later.
        continue;
      }
      const stillThere = unspent.some(
        (u) => u.tx_hash === cov.txid && u.tx_pos === cov.vout
      );
      if (!stillThere && cov.id) {
        await db.covenant.update(cov.id, { status: CovenantStatus.RESOLVED });
        if (cov.ref) {
          await db.glyph
            .where({ ref: cov.ref })
            .modify({ swapPending: false })
            .catch(() => undefined);
        }
      }
    }
  } catch (e) {
    // Background reconciliation — log for diagnosis rather than toasting on
    // every transient electrum hiccup (which would spam the user). The loop
    // retries on the next poll.
    console.error("[covenant] reconcile failed", e);
  } finally {
    loading.value = false;
  }
};

/**
 * Discover covenant-held tokens this wallet OWNS from the indexer — the
 * cross-device / re-import counterpart to local `recordCovenant` tracking.
 *
 * Why this works without any indexer change: RXinDexer indexes every UTXO under
 * `sha256(zero_refs(script))`, and `zero_refs` zeroes every input-ref OPERAND in
 * any CHECKSIG-bearing script. The *soulbound* and *authority-gated* covenants
 * carry their ref(s) only in `OP_PUSHINPUTREFSINGLETON`/`OP_REQUIREINPUTREF`
 * (no second literal push), so every one of an owner's tokens of a given
 * covenant template collapses to ONE owner-stable scripthash — exactly the
 * scripthash of the template built with a zero ref. We subscribe-by-poll to
 * those two scripthashes and adopt anything found that we don't already track.
 *
 * Royalty *listings* are intentionally excluded: their terms (price, royalty
 * amount/recipient) are baked into the script and are NOT zeroed, so each
 * listing has a unique scripthash that can't be enumerated by owner. Listings
 * are recovered from local tracking (`db.covenant`) + their shareable
 * descriptors instead.
 *
 * Each candidate is verified by rebuilding the covenant from `(this address,
 * parsed ref)` and byte-comparing it to the actual on-chain output script, so a
 * hostile/buggy indexer can't inject foreign or malformed entries.
 */
export const discoverCovenants = async (address: string) => {
  if (!address) return;
  if (electrumStatus.value !== ElectrumStatus.CONNECTED) return;
  const worker = electrumWorker.value;

  const templates: {
    type: CovenantType;
    scriptHash: string;
    // Returns the LE ref iff `script` is genuinely our covenant for `address`.
    verify: (script: string) => string | undefined;
  }[] = [
    {
      type: CovenantType.SOULBOUND,
      scriptHash: scriptToHash(soulboundNftScript(address, ZERO_REF)),
      verify: (script) => {
        const ref = parseSoulboundRef(script);
        return ref && soulboundNftScript(address, ref) === script
          ? ref
          : undefined;
      },
    },
    {
      type: CovenantType.AUTHORITY_GATED,
      scriptHash: scriptToHash(
        authorityGatedNftScript(address, ZERO_REF, ZERO_REF)
      ),
      verify: (script) => {
        const { ref, authorityRef } = parseAuthorityGatedScript(script);
        return ref &&
          authorityRef &&
          authorityGatedNftScript(address, ref, authorityRef) === script
          ? ref
          : undefined;
      },
    },
  ];

  for (const t of templates) {
    let utxos: {
      tx_hash: string;
      tx_pos: number;
      value: number;
      height: number;
    }[] = [];
    try {
      utxos = (await worker.getUtxosByScriptHash(t.scriptHash)) as typeof utxos;
    } catch {
      continue; // transient — retry next sweep
    }

    for (const u of utxos) {
      const known = await db.covenant
        .where("[txid+vout]")
        .equals([u.tx_hash, u.tx_pos])
        .first()
        .catch(() => undefined);

      // Already tracked: just heal visibility + height (no tx fetch needed).
      if (known) {
        await materializeCovenantUtxo({
          ref: known.ref,
          txid: u.tx_hash,
          vout: u.tx_pos,
          script: known.script,
          value: u.value,
          height: u.height,
        });
        continue;
      }

      // Fetch the tx (hash-verified by the worker) and read the real script.
      let script: string | undefined;
      try {
        const hex = await worker.getTransaction(u.tx_hash);
        if (!hex) continue;
        script = new Transaction(hex).outputs[u.tx_pos]?.script?.toHex();
      } catch {
        continue;
      }
      if (!script) continue;

      const refLE = t.verify(script);
      if (!refLE) continue; // not our covenant / tampered — never adopt

      const refBE = reverseRef(refLE);

      // Seed glyph metadata if we've never seen this token.
      const existing = await db.glyph
        .where({ ref: refBE })
        .first()
        .catch(() => undefined);
      if (!existing) {
        try {
          await worker.fetchGlyph(refBE);
        } catch {
          // Metadata is best-effort; the covenant row below still records it.
        }
      }

      await recordCovenant({
        type: t.type,
        ref: refBE,
        txid: u.tx_hash,
        vout: u.tx_pos,
        script,
        value: u.value,
        ownerAddress: address,
      });

      // Synthesise the txo + link the glyph so the token renders in the grid.
      await materializeCovenantUtxo({
        ref: refBE,
        txid: u.tx_hash,
        vout: u.tx_pos,
        script,
        value: u.value,
        height: u.height,
      });
    }
  }
};
