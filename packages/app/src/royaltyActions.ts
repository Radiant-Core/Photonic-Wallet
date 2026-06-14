/**
 * Reusable royalty-covenant buy/cancel actions.
 *
 * Extracted from Market.tsx so the unified Market hub (and the legacy Market page
 * during transition) share one audited path. The covenant enforces price +
 * royalty on-chain, so a buy needs no maker signature — just the covenant UTXO
 * and the committed terms (carried by the ListingDescriptor). Callers handle the
 * wallet-lock prompt and toasts; these helpers assume an unlocked wallet and
 * throw on failure.
 */
import db from "@app/db";
import { ContractType, CovenantStatus } from "@app/types";
import type { CovenantRecord } from "@app/types";
import { SelectableInput } from "@lib/coinSelect";
import {
  buildRoyaltyPurchaseTx,
  buildRoyaltyCancelTx,
  RoyaltySaleTerms,
} from "@lib/royaltyCovenant";
import { reverseRef } from "@lib/Outpoint";
import type { ListingDescriptor } from "@app/covenant";
import { electrumWorker } from "@app/electrum/Electrum";
import { wallet, feeRate } from "@app/signals";
import { updateRxdBalances } from "@app/utxos";

export class WalletLockedError extends Error {
  constructor() {
    super("Wallet is locked");
    this.name = "WalletLockedError";
  }
}

async function rxdCoins(): Promise<SelectableInput[]> {
  return db.txo.where({ contractType: ContractType.RXD, spent: 0 }).toArray();
}

async function postSpendSync(): Promise<void> {
  try {
    await electrumWorker.value.manualSync();
    await updateRxdBalances(wallet.value.address);
  } catch (err) {
    console.debug("[royalty] post-spend sync failed", err);
  }
}

/**
 * Buy a royalty listing. Pays the seller + creator royalty the committed amounts
 * (covenant-enforced) and delivers the NFT to the buyer. Returns the txid.
 */
export async function executeRoyaltyBuy(
  descriptor: ListingDescriptor
): Promise<string> {
  if (wallet.value.locked || !wallet.value.wif) throw new WalletLockedError();
  const tx = buildRoyaltyPurchaseTx({
    buyerAddress: wallet.value.address,
    buyerWif: wallet.value.wif.toString(),
    buyerCoins: await rxdCoins(),
    covenantUtxo: descriptor.covenantUtxo,
    terms: descriptor.terms as RoyaltySaleTerms,
    feeRate: feeRate.value,
  });
  const txid = (await electrumWorker.value.broadcast(tx.toString())) || tx.id;
  await db.broadcast.put({ txid, date: Date.now(), description: "royalty_buy" });

  // If we happen to hold this listing locally (e.g. self-buy in testing),
  // resolve it so it leaves "My Listings".
  const local = await db.covenant
    .where("[txid+vout]")
    .equals([descriptor.covenantUtxo.txid, descriptor.covenantUtxo.vout])
    .first()
    .catch(() => undefined);
  if (local?.id) {
    await db.covenant.update(local.id, { status: CovenantStatus.RESOLVED });
  }
  await postSpendSync();
  return txid;
}

/**
 * Cancel a royalty listing the wallet owns, reclaiming the NFT via the covenant's
 * seller-only cancel branch. Returns the txid.
 */
export async function executeRoyaltyCancel(
  cov: CovenantRecord
): Promise<string> {
  if (wallet.value.locked || !wallet.value.wif) throw new WalletLockedError();
  const tx = buildRoyaltyCancelTx({
    sellerAddress: wallet.value.address,
    sellerWif: wallet.value.wif.toString(),
    rxdCoins: await rxdCoins(),
    covenantUtxo: {
      txid: cov.txid,
      vout: cov.vout,
      script: cov.script,
      value: cov.value,
    },
    ref: reverseRef(cov.ref),
    feeRate: feeRate.value,
  });
  const txid = (await electrumWorker.value.broadcast(tx.toString())) || tx.id;
  await db.broadcast.put({
    txid,
    date: Date.now(),
    description: "royalty_cancel",
  });
  if (cov.id) {
    await db.covenant.update(cov.id, { status: CovenantStatus.RESOLVED });
  }
  await db.glyph
    .where({ ref: cov.ref })
    .modify({ swapPending: false })
    .catch(() => undefined);
  await postSpendSync();
  return txid;
}
