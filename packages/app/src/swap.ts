import { signal } from "@preact/signals-react";
import { fundTx, SelectableInput } from "@lib/coinSelect";
import {
  ContractType,
  ElectrumStatus,
  SwapError,
  SwapMode,
  SwapStatus,
} from "./types";
import db from "./db";
import { ftScript, nftScript, p2pkhScript } from "@lib/script";
import Outpoint, { reverseRef } from "@lib/Outpoint";
import { buildTx } from "@lib/tx";
import { UnfinalizedInput, ElectrumUtxo } from "@lib/types";
import { electrumWorker } from "./electrum/Electrum";
import { wallet, feeRate, electrumStatus } from "./signals";
import { materializeCovenantUtxo } from "./covenant";

export const cancelSwap = async (
  contractType: ContractType,
  txid: string,
  value: number,
  glyphRef?: string,
  // Output index of the reserved swap-address UTXO being reclaimed. Defaults to
  // 0 for the legacy single-output reserve, but a token can be reserved at a
  // non-zero vout (e.g. an NFT whose ref output is index 1) — spending vout 0
  // in that case references a non-existent outpoint and the node rejects the
  // cancel with "Missing inputs". Callers pass the real vout.
  vout = 0
) => {
  const coins: SelectableInput[] = await db.txo
    .where({ contractType: ContractType.RXD, spent: 0 })
    .toArray();

  // Move reserved RXD and tokens back to spendable address
  if (contractType === ContractType.RXD) {
    const fromScript = p2pkhScript(wallet.value.swapAddress);
    const changeScript = p2pkhScript(wallet.value.address);
    const inputs: UnfinalizedInput[] = [
      { txid, vout, value, script: fromScript },
    ];
    const fund = fundTx(
      wallet.value.address,
      coins,
      inputs,
      [],
      changeScript,
      feeRate.value
    );
    if (!fund.funded) {
      throw new SwapError("Failed to fund");
    }
    inputs.push(...fund.funding);
    const outputs = fund.change;

    const privKey = wallet.value.wif!.toString();
    const swapPrivKey = wallet.value.swapWif!.toString();
    const rawTx = buildTx(
      wallet.value.address,
      [swapPrivKey, ...fund.funding.map(() => privKey)],
      inputs,
      outputs,
      false
    ).toString();
    const cancelTxid = await electrumWorker.value.broadcast(rawTx);
    db.broadcast.put({
      txid: cancelTxid,
      date: Date.now(),
      description: "rxd_swap_cancel",
    });
  } else {
    const ftSwap = contractType === ContractType.FT;
    const refLE = reverseRef(glyphRef as string);
    const fromScript = ftSwap
      ? ftScript(wallet.value.swapAddress, refLE)
      : nftScript(wallet.value.swapAddress, refLE);
    const toScript = ftSwap
      ? ftScript(wallet.value.address, refLE)
      : nftScript(wallet.value.address, refLE);
    const changeScript = p2pkhScript(wallet.value.address);
    const inputs: SelectableInput[] = [
      {
        txid,
        vout,
        value,
        script: fromScript,
        required: true,
      },
    ];
    const outputs = [{ script: toScript, value }];
    const fund = fundTx(
      wallet.value.address,
      coins,
      inputs,
      outputs,
      changeScript,
      feeRate.value
    );
    if (!fund.funded) {
      throw new SwapError("Failed to fund");
    }
    inputs.push(...fund.funding);
    outputs.push(...fund.change);

    const privKey = wallet.value.wif!.toString();
    const swapPrivKey = wallet.value.swapWif!.toString();
    const rawTx = buildTx(
      wallet.value.address,
      [swapPrivKey, ...fund.funding.map(() => privKey)],
      inputs,
      outputs,
      false
    ).toString();
    const cancelTxid = await electrumWorker.value.broadcast(rawTx);
    db.broadcast.put({
      txid: cancelTxid,
      date: Date.now(),
      description: ftSwap ? "ft_swap_cancel" : "nft_swap_cancel",
    });
    await db.glyph.where({ ref: glyphRef }).modify({
      swapPending: false,
    });
  }
};

export const loading = signal(false);

export const syncSwaps = async () => {
  if (loading.value === true) {
    return;
  }

  loading.value = true;
  try {
    if (electrumStatus.value !== ElectrumStatus.CONNECTED) return;
    const activeSwaps = new Map(
      (await electrumWorker.value.findSwaps(wallet.value.swapAddress)).map(
        (swap) => [swap.utxo.tx_hash, swap]
      )
    );

    // This could be improved. Currently there's no simple way to get the tx spending the output from ElectrumX so we
    // can't tell if it's really completed or cancelled. This is only a problem if the user cancelled from another wallet
    // because the status will be updated immediately when cancelling.
    const dbSwaps = await db.swap
      .where({ status: SwapStatus.PENDING })
      .toArray();
    for (const swap of dbSwaps) {
      if (!activeSwaps.has(swap.txid) && swap.id) {
        db.swap.update(swap.id, { status: SwapStatus.COMPLETE });
        if (swap.fromGlyph) {
          await db.glyph.where({ ref: swap.fromGlyph }).modify({
            swapPending: false,
          });
        }
      }
    }
  } catch (e) {
    // Background reconciliation — log for diagnosis rather than toasting on
    // every transient electrum hiccup (which would spam the user). The loop
    // retries on the next poll.
    console.error("[swap] reconcile failed", e);
  } finally {
    loading.value = false;
  }
};

/**
 * Recover the wallet's OWN open swaps that have NO local db.swap record.
 *
 * Listing a token for swap moves it to nftScript/ftScript(swapAddress) (or
 * reserves RXD at p2pkh(swapAddress)) and writes the db.swap row LAST — after
 * the reserve and advertisement broadcasts. A crash/close before that put, a
 * wiped/half-synced IndexedDB, or listing on another device therefore leaves the
 * asset reserved on-chain with NO local tracking: invisible as owned, no Cancel
 * anywhere, and a stale glyph pointer that breaks re-listing ("Missing inputs").
 * `syncSwaps` only REAPS existing rows; it never recreates one. This scans the
 * swap address (findSwaps) and, for any reserved UTXO without a db.swap row,
 * recreates a PENDING recovery record (enough to Cancel) and — for an NFT —
 * materialises a byRef txo and repoints the glyph (swapPending) so it renders as
 * listed instead of a phantom. The covenant analogue is discoverCovenants.
 *
 * Only NFTs are materialised: a fungible reserve is a byRef FT txo, which the
 * FT balance/consolidation paths would sum/sweep (they exclude byRef only on the
 * main sweep), so FT swaps are tracked by the db.swap record alone.
 *
 * Idempotent and safe to run on every connect/resync: a UTXO that already has a
 * db.swap row (incl. one created by a previous recovery) is skipped. A
 * module-level guard prevents two overlapping runs (connect sweep + Resync) from
 * racing the non-atomic check-then-insert and double-inserting a record.
 */
let recovering = false;
export const recoverSwaps = async () => {
  const swapAddress = wallet.value.swapAddress;
  if (!swapAddress) return;
  if (electrumStatus.value !== ElectrumStatus.CONNECTED) return;
  if (recovering) return;
  recovering = true;
  try {
    let found: { contractType: ContractType; utxo: ElectrumUtxo }[] = [];
    try {
      found = await electrumWorker.value.findSwaps(swapAddress);
    } catch {
      return; // transient lookup failure — retry on the next sweep
    }

    for (const { contractType, utxo } of found) {
      // Skip anything already tracked (incl. a prior recovery). Dedup by txid to
      // match SwapMissing / the existing reaper. On a query error, assume tracked
      // so we never create a duplicate.
      const tracked = await db.swap
        .where({ txid: utxo.tx_hash })
        .count()
        .catch(() => 1);
      if (tracked > 0) continue;

      const refShort = utxo.refs?.[0]?.ref;
      let refBE: string | undefined;
      if (refShort) {
        try {
          refBE = Outpoint.fromShortInput(refShort).toString();
        } catch {
          refBE = undefined;
        }
      }

      // Recreate a minimal PENDING record — enough to surface in My Swaps and
      // Cancel. No PSRT (`tx: ""`); the want side is unknown so it defaults to RXD.
      // `recovered: true` and no `mode` keep it out of the broadcast "My Offers"
      // panel (which needs full offer data) while still showing in Pending swaps.
      await db.swap.put({
        txid: utxo.tx_hash,
        vout: utxo.tx_pos,
        tx: "",
        from: contractType,
        fromGlyph: refBE ?? null,
        fromValue: utxo.value,
        to: ContractType.RXD,
        toGlyph: null,
        toValue: 0,
        status: SwapStatus.PENDING,
        date: Date.now(),
        recovered: true,
      });

      // Seed glyph metadata if this wallet has never seen the token, so My Swaps
      // (and, for an NFT, the grid) can show a name.
      if (refBE && contractType !== ContractType.RXD) {
        const glyph = await db.glyph
          .where({ ref: refBE })
          .first()
          .catch(() => undefined);
        if (!glyph) {
          try {
            await electrumWorker.value.fetchGlyph(refBE);
          } catch {
            // Metadata is best-effort; the swap record above still tracks it.
          }
        }
      }

      // Materialise ONLY for an NFT: repoint the glyph to the live swap-address
      // UTXO (byRef txo + swapPending) so it renders as listed, not a phantom
      // with a spent main-address pointer. NFTs are not value-summed, so a byRef
      // NFT txo is safe — unlike an FT reserve (see the note above).
      if (refBE && contractType === ContractType.NFT) {
        const refLE = reverseRef(refBE);
        await materializeCovenantUtxo({
          ref: refBE,
          txid: utxo.tx_hash,
          vout: utxo.tx_pos,
          script: nftScript(swapAddress, refLE),
          value: utxo.value,
          height: utxo.height,
        });
      }
    }
  } finally {
    recovering = false;
  }
};
