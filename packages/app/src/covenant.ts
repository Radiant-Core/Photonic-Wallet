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
import {
  ElectrumStatus,
  CovenantRecord,
  CovenantStatus,
  CovenantRoyaltyTerms,
} from "./types";
import db from "./db";
import { electrumWorker } from "./electrum/Electrum";
import { electrumStatus } from "./signals";

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
