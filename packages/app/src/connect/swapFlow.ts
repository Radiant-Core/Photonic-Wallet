/**
 * Non-React glue between the connect swap requests (`swap-offer-request`,
 * `swap-accept-request`) and the wallet's own state. Mirrors
 * `packages/app/src/pages/Swap.tsx` (maker: reserve + PSRT) and
 * `packages/app/src/pages/SwapLoad.tsx` (taker: complete + broadcast) as
 * closely as possible, so a connect-driven swap behaves identically to one
 * the user made by hand through those pages — same reservation move, same
 * PSRT construction, same output ordering, same royalty handling.
 *
 * v1 scope: NFT-for-RXD only (matches the private-offer marketplace use
 * case this was built for). Reservation ("offer") always broadcasts a real
 * transaction moving the NFT to the swap subaccount — `mode: "private"`
 * only means no on-chain *advertisement*, not that nothing is broadcast.
 */
import rjs from "@radiant-core/radiantjs";
import Big from "big.js";
import { bytesToHex } from "@noble/hashes/utils";
import db from "@app/db";
import { electrumWorker } from "@app/electrum/Electrum";
import { feeRate as feeRateSignal } from "@app/signals";
import { broadcastSwapCompletion } from "@app/swapActivity";
import { cancelSwap } from "@app/swap";
import { updateRxdBalances, updateWalletUtxos } from "@app/utxos";
import opfs from "@app/opfs";
import { ContractType, SmartToken, SmartTokenType, SwapMode, SwapStatus } from "@app/types";
import Outpoint, { reverseRef } from "@lib/Outpoint";
import {
  nftScript,
  p2pkhScript,
  parseFtScript,
  parseNftScript,
  parseP2pkhScript,
} from "@lib/script";
import { fundTx, SelectableInput } from "@lib/coinSelect";
import { findTokenOutput, buildTx } from "@lib/tx";
import { partiallySigned, transferNonFungible } from "@lib/transfer";
import { buildSwapCompletionOutputs } from "@lib/swapOutputs";
import {
  buildRoyaltyOutputs,
  parseRoyalty,
  RoyaltyTerms,
} from "@lib/royaltyTerms";
import { decodeGlyph } from "@lib/token";
import type { UnfinalizedOutput, Utxo } from "@lib/types";
import type {
  SwapAcceptRequest,
  SwapCancelRequest,
  SwapOfferRequest,
} from "@app/connect/protocol";

const { Address, Transaction } = rjs;

export class SwapFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapFlowError";
  }
}

// Decimal-safe RXD -> photons conversion (mirrors Swap.tsx's rxdToPhotons):
// plain `rxd * 1e8` on a JS float can yield a non-integer photon value.
function rxdToPhotons(rxd: number): number {
  return Number(Big(rxd).times(100000000).round(0, 0).toString());
}

// Inverse of the above, for echoing back the amount actually committed
// on-chain (photons are always the source of truth) rather than a caller's
// raw request value, which could carry more decimal precision than a whole
// photon count allows.
function photonsToRxd(photons: number): number {
  return Number(Big(photons).div(100000000).toString());
}

function parseScript(script: string) {
  return (
    (
      [
        [ContractType.RXD, parseP2pkhScript],
        [ContractType.FT, parseFtScript],
        [ContractType.NFT, parseNftScript],
      ] as [ContractType, (script: string) => { address: string }][]
    ).reduce<[ContractType, { address: string; ref?: string }] | undefined>(
      (acc, [contractType, fn]) => {
        if (acc) return acc;
        const parsed = fn(script);
        return parsed.address ? [contractType, parsed] : undefined;
      },
      undefined
    ) || [undefined, undefined]
  );
}

async function fetchToken(ref: string): Promise<SmartToken | undefined> {
  const result = await db.glyph.where({ ref }).first();
  if (result) return result;
  return electrumWorker.value.fetchGlyph(ref);
}

async function getTokenRoyalty(glyph: SmartToken): Promise<RoyaltyTerms | null> {
  if (!glyph.revealOutpoint) return null;
  try {
    const reveal = Outpoint.fromString(glyph.revealOutpoint);
    const txid = reveal.getTxid();
    let hex = await opfs.getTx(txid);
    if (!hex) {
      hex = await electrumWorker.value.getTransaction(txid);
      if (hex) await opfs.putTx(txid, hex);
    }
    if (!hex) return null;
    const tx = new Transaction(hex);
    const input = tx.inputs[reveal.getVout()];
    if (!input?.script) return null;
    const decoded = decodeGlyph(input.script);
    if (!decoded) return null;
    return parseRoyalty(decoded.payload);
  } catch {
    return null;
  }
}

export type SwapOfferOutcome = {
  psrt: string;
  reserveTxid: string;
  reserveVout: number;
  swapAddress: string;
  ref: string;
  payoutAddress: string;
  priceRxd: number;
};

/**
 * Reserve `req.ref` (an NFT owned by the wallet) into the swap subaccount
 * and build a private-mode PSRT offering it for `req.priceRxd`. The
 * reservation is a REAL on-chain transaction, broadcast immediately —
 * `mode: "private"` only means no advertisement is published, not that
 * nothing moves.
 */
export async function createSwapOffer(
  req: SwapOfferRequest,
  wif: string,
  swapWif: string,
  address: string,
  swapAddress: string
): Promise<SwapOfferOutcome> {
  if (req.mode !== "private") {
    throw new SwapFlowError('only "private" mode is supported');
  }

  const refLE = reverseRef(req.ref);
  const glyph = await db.glyph.where({ ref: req.ref }).first();
  if (!glyph) {
    throw new SwapFlowError("this token was not found in your wallet");
  }
  if (glyph.tokenType !== SmartTokenType.NFT) {
    throw new SwapFlowError("only NFT offers are supported");
  }
  if (glyph.swapPending) {
    throw new SwapFlowError("this token already has a pending swap offer");
  }

  try {
    await electrumWorker.value.manualSync();
  } catch (error) {
    console.debug("[swapFlow] pre-offer UTXO refresh failed", error);
  }
  const coins: SelectableInput[] = await db.txo
    .where({ contractType: ContractType.RXD, spent: 0 })
    .toArray();

  const fromScript = nftScript(address, refLE);
  const nft = await db.txo.where({ script: fromScript, spent: 0 }).first();
  if (!nft) {
    throw new SwapFlowError("could not find the token's on-chain UTXO");
  }

  const { tx, selected } = transferNonFungible(
    coins,
    nft,
    refLE,
    address,
    swapAddress,
    feeRateSignal.value,
    wif
  );

  const reserveTxid = await electrumWorker.value.broadcast(tx.toString());

  // The reservation is now irreversible and already on-chain. Everything
  // below this point — activity logging, local UTXO/balance bookkeeping —
  // is best-effort: none of it is needed to hand the dApp a valid offer, so
  // a failure here shouldn't surface as a request error (the connect error
  // callback would tell the dApp the whole request failed, when in fact the
  // NFT is already reserved). Worst case the wallet's own "Pending Swaps"
  // view is stale until the next on-chain discovery sweep (`recoverSwaps`).
  try {
    await db.broadcast.put({
      txid: reserveTxid,
      date: Date.now(),
      description: "nft_swap_prepare",
    });

    const changeScript = p2pkhScript(address);
    await updateWalletUtxos(
      ContractType.NFT,
      fromScript,
      changeScript,
      reserveTxid,
      selected.inputs,
      selected.outputs
    );
    if (glyph.id) {
      await db.glyph.update(glyph.id, { swapPending: true });
    }
    await updateRxdBalances(address);
  } catch (error) {
    console.error(
      "[swapFlow] post-reservation bookkeeping failed (offer already reserved on-chain)",
      error
    );
  }

  const priceRxdPhotons = rxdToPhotons(req.priceRxd);
  const psrtOutput = { script: p2pkhScript(address), value: priceRxdPhotons };

  const found = findTokenOutput(tx, refLE);
  if (found.vout === undefined || !found.output) {
    // Should never happen — `tx` is the exact transaction just broadcast —
    // but if it does, the reservation is already irreversible; mention the
    // txid so the offer can still be recovered/cancelled manually.
    throw new SwapFlowError(
      `reservation broadcast as ${reserveTxid}, but could not locate its swap output to build the offer`
    );
  }

  const input = {
    txid: tx.id,
    vout: found.vout,
    script: found.output.script.toHex(),
    value: found.output.satoshis,
  };
  const rawPsrt = partiallySigned(swapAddress, input, psrtOutput, swapWif).toString();

  // Persist the offer locally, exactly like the local Swap page does
  // (packages/app/src/pages/Swap.tsx) — without this row the offer is
  // invisible in Pending Swaps (SwapPending.tsx reads `db.swap`) and
  // uncancellable through the normal UI until the next on-chain discovery
  // sweep (`recoverSwaps`) resynthesizes a degraded stub that's lost the
  // negotiated price. Writing it now means the wallet's own "Cancel" button
  // works immediately, with the real price, the moment the offer is created.
  // Best-effort like the bookkeeping above: the PSRT is already valid and
  // about to be returned to the caller regardless of whether this write
  // succeeds.
  try {
    await db.swap.put({
      txid: tx.id,
      vout: found.vout,
      swapAddress,
      tx: rawPsrt,
      from: ContractType.NFT,
      fromGlyph: req.ref,
      fromValue: found.output.satoshis,
      to: ContractType.RXD,
      toGlyph: null,
      toValue: priceRxdPhotons,
      status: SwapStatus.PENDING,
      date: Date.now(),
      mode: SwapMode.PRIVATE,
    });
  } catch (error) {
    console.error(
      "[swapFlow] failed to persist db.swap row for a successful offer (still returning it to the caller)",
      error
    );
  }

  return {
    psrt: rawPsrt,
    reserveTxid: tx.id,
    reserveVout: found.vout,
    swapAddress,
    ref: req.ref,
    payoutAddress: address,
    // Echo the amount actually committed in the PSRT output, not the raw
    // request value — see `photonsToRxd`.
    priceRxd: photonsToRxd(priceRxdPhotons),
  };
}

export type SwapAcceptPreview = {
  priceRxd: number;
  /** Undefined when the offered token couldn't be resolved (network hiccup,
   * unindexed, or not actually an NFT offer) — the approval screen falls
   * back to showing price-only in that case. */
  glyph?: SmartToken;
  /**
   * The enforced creator royalty `acceptSwapOffer` will add to the completion
   * transaction, in RXD — a real charge to the taker on top of the price, so
   * the approval screen must show it. Undefined when the token carries no
   * enforced royalty, or when it couldn't be resolved (in which case the
   * screen says so rather than implying zero).
   */
  royaltyRxd?: number;
  /**
   * True when the royalty lookup itself failed, as opposed to resolving to
   * "no enforced royalty". Lets the panel distinguish "nothing owed" from
   * "we don't know yet" instead of showing a misleadingly low total.
   */
  royaltyUnknown?: boolean;
};

/**
 * Total enforced royalty for a sale, in RXD, or undefined when nothing is
 * owed. Pure, and deliberately routed through the same `buildRoyaltyOutputs`
 * that `acceptSwapOffer` uses to build the actual outputs — summing the real
 * outputs is what keeps the figure shown on the approval screen from drifting
 * from the amount the taker is actually charged (bps, minimum/maximum
 * clamping and split rounding all included for free).
 *
 * Throws whatever `buildRoyaltyOutputs` throws (e.g. an invalid royalty
 * payout address); callers treat that as "royalty unknown".
 */
export function royaltyTotalRxd(
  royalty: RoyaltyTerms | null,
  pricePhotons: number
): number | undefined {
  if (!royalty?.enforced) return undefined;
  const total = buildRoyaltyOutputs(royalty, pricePhotons).reduce(
    (sum, output) => sum + output.value,
    0
  );
  return total > 0 ? photonsToRxd(total) : undefined;
}

/**
 * Resolve what a `swap-accept-request`'s PSRT is actually buying, for the
 * approval screen — read-only, no signing, no broadcast, no wallet UTXOs
 * touched. A PSRT only carries a price by itself (a single RXD output); to
 * show the actual item being purchased this looks up the PSRT's single
 * input's prevout (the reserved swap-subaccount NFT output) the same way
 * `acceptSwapOffer` does before it starts moving funds, so what the user is
 * shown matches what they're about to approve. Best-effort: any failure
 * (malformed PSRT, prevout no longer resolvable, network hiccup) degrades to
 * price-only rather than blocking the approval screen — `acceptSwapOffer`
 * re-validates everything for real when the user actually approves.
 *
 * Also resolves the enforced creator royalty, because the taker pays it on
 * top of the price: showing price alone understates what approving actually
 * costs. It is computed by running the same `buildRoyaltyOutputs` call
 * `acceptSwapOffer` uses, so the figure shown cannot drift from the outputs
 * that actually get built.
 */
export async function previewSwapAccept(
  req: Pick<SwapAcceptRequest, "psrt">
): Promise<SwapAcceptPreview | null> {
  let psrtTx: InstanceType<typeof Transaction>;
  try {
    psrtTx = new Transaction(req.psrt);
  } catch {
    return null;
  }
  if (psrtTx.inputs.length !== 1 || psrtTx.outputs.length !== 1) return null;

  const pricePhotons = psrtTx.outputs[0].satoshis;
  const priceRxd = photonsToRxd(pricePhotons);

  const txid = bytesToHex(psrtTx.inputs[0].prevTxId);
  const vout = psrtTx.inputs[0].outputIndex;
  try {
    const hex = await electrumWorker.value.getTransaction(txid);
    if (!hex) {
      console.debug(
        `[swapFlow] previewSwapAccept: no transaction found for reserved outpoint ${txid}:${vout}`
      );
      return { priceRxd };
    }
    const prevOutput = new Transaction(hex).outputs[vout];
    if (!prevOutput) {
      console.debug(
        `[swapFlow] previewSwapAccept: outpoint ${txid}:${vout} has no output at that index`
      );
      return { priceRxd };
    }
    const [from, fromParams] = parseScript(prevOutput.script.toHex());
    if (from !== ContractType.NFT) {
      console.debug(
        `[swapFlow] previewSwapAccept: reserved output ${txid}:${vout} is not an NFT script (got ${String(
          from
        )})`
      );
      return { priceRxd };
    }
    const ref = reverseRef(fromParams?.ref as string);
    const glyph = await fetchToken(ref);
    if (!glyph) {
      console.debug(
        `[swapFlow] previewSwapAccept: could not resolve glyph metadata for ref ${ref}`
      );
      // Without the glyph there is no reveal outpoint to read royalty terms
      // from, so the royalty is genuinely unknown rather than absent.
      return { priceRxd, royaltyUnknown: true };
    }

    // Kept in its own try/catch so an unparseable or invalid-address royalty
    // only costs us the royalty line, not the resolved item above it.
    let royaltyRxd: number | undefined;
    let royaltyUnknown: boolean | undefined;
    try {
      royaltyRxd = royaltyTotalRxd(await getTokenRoyalty(glyph), pricePhotons);
    } catch (error) {
      console.debug(
        `[swapFlow] previewSwapAccept: could not resolve royalty for ref ${ref}`,
        error
      );
      royaltyUnknown = true;
    }

    return { priceRxd, glyph, royaltyRxd, royaltyUnknown };
  } catch (error) {
    console.debug(
      `[swapFlow] previewSwapAccept: failed to resolve reserved outpoint ${txid}:${vout}`,
      error
    );
    return { priceRxd };
  }
}

/**
 * Refuse a marketplace fee address that belongs to a different chain than the
 * wallet.
 *
 * `cleanPayoutAddress` (protocol.ts) already proved the address decodes, but
 * being network-agnostic transport code it cannot know which chain the wallet
 * is on. The comparison is made against the wallet's OWN address rather than a
 * network signal, so the two can never disagree.
 *
 * A cross-network fee address is a marketplace misconfiguration: the payout
 * lands on a hash160 the operator is probably not watching on this chain, and
 * the purchase is irreversible once broadcast. Cheap to check, so check it.
 */
export function assertFeeAddressNetwork(
  walletAddress: string,
  feeAddress: string | undefined
): void {
  if (!feeAddress) return;
  const walletNet = Address.fromString(walletAddress).network.name;
  const feeNet = Address.fromString(feeAddress).network.name;
  if (walletNet !== feeNet) {
    throw new SwapFlowError(
      `the marketplace fee address is a ${feeNet} address but this wallet is on ${walletNet}`
    );
  }
}

export type SwapAcceptOutcome = { txid: string };

/**
 * Complete and broadcast a maker's NFT-for-RXD PSRT, optionally appending a
 * marketplace fee output alongside any enforced creator royalty. Always
 * broadcasts — there is no "return unsigned" option, matching the
 * mint-request flow.
 */
export async function acceptSwapOffer(
  req: SwapAcceptRequest,
  wif: string,
  address: string
): Promise<SwapAcceptOutcome> {
  const psrtTx = new Transaction(req.psrt);
  if (psrtTx.inputs.length !== 1 || psrtTx.outputs.length !== 1) {
    throw new SwapFlowError("psrt must have exactly one input and one output");
  }

  assertFeeAddressNetwork(address, req.feeAddress);

  const txid = bytesToHex(psrtTx.inputs[0].prevTxId);
  const vout = psrtTx.inputs[0].outputIndex;
  const hex = await electrumWorker.value.getTransaction(txid);
  if (!hex) {
    throw new SwapFlowError("could not fetch the offer's reserved transaction");
  }
  const prevTx = new Transaction(hex);
  const prevOutput = prevTx.outputs[vout];
  if (!prevOutput) {
    throw new SwapFlowError("invalid offer: reserved output not found");
  }

  const isUnspent = await electrumWorker.value.isUtxoUnspent(
    txid,
    vout,
    prevOutput.script.toHex()
  );
  if (!isUnspent) {
    throw new SwapFlowError("this offer has already been completed or cancelled");
  }

  const [from, fromParams] = parseScript(prevOutput.script.toHex());
  if (from !== ContractType.NFT) {
    throw new SwapFlowError("only NFT offers are supported");
  }
  const refLE = fromParams?.ref as string;
  const fromGlyph = await fetchToken(reverseRef(refLE));
  if (!fromGlyph) {
    throw new SwapFlowError("could not resolve the offered token's metadata");
  }

  const toScriptHex = psrtTx.outputs[0].script.toHex();
  const [to] = parseScript(toScriptHex);
  if (to !== ContractType.RXD) {
    throw new SwapFlowError("only RXD-priced offers are supported");
  }

  const fromValue = prevOutput.satoshis;
  const toValue = psrtTx.outputs[0].satoshis;
  const outputScript = nftScript(address, refLE);

  const makerPayment: UnfinalizedOutput = { script: toScriptHex, value: toValue };
  const assetToTaker: UnfinalizedOutput = { script: outputScript, value: fromValue };

  const royaltyOutputs: UnfinalizedOutput[] = [];
  const royalty = await getTokenRoyalty(fromGlyph);
  if (royalty?.enforced) {
    royaltyOutputs.push(...buildRoyaltyOutputs(royalty, toValue));
  }

  const platformFeeOutputs: UnfinalizedOutput[] = [];
  if (req.feeRxd && req.feeAddress) {
    platformFeeOutputs.push({
      script: p2pkhScript(req.feeAddress),
      value: rxdToPhotons(req.feeRxd),
    });
  }

  const outputs = buildSwapCompletionOutputs({
    makerPayment,
    assetToTaker,
    royaltyOutputs,
    platformFeeOutputs,
  });

  const coins: SelectableInput[] = await db.txo
    .where({ contractType: ContractType.RXD, spent: 0 })
    .toArray();
  const inputs: Utxo[] = [
    { txid, vout, script: prevOutput.script.toHex(), value: fromValue },
  ];

  const changeScript = p2pkhScript(address);
  const fund = fundTx(address, coins, inputs, outputs, changeScript, feeRateSignal.value);
  if (!fund.funded) {
    throw new SwapFlowError("failed to fund the completion transaction");
  }
  inputs.push(...fund.funding);
  outputs.push(...fund.change);

  const tx = buildTx(address, wif, inputs, outputs, false, (index, script) => {
    if (index === 0) return psrtTx.inputs[0].script;
    return script;
  });

  const txidResult = await broadcastSwapCompletion(tx.toString());
  return { txid: txidResult };
}

export type SwapCancelOutcome = { txid: string };

/**
 * Cancel a pending offer identified by `req.ref`, reclaiming the reserved
 * NFT back to the wallet's main address. Looks the offer up in `db.swap`
 * (populated by `createSwapOffer`) rather than requiring the caller to know
 * the reservation outpoint — the wallet already tracks one pending swap per
 * glyph, so the ref alone is enough to identify which offer to cancel.
 * Requires the wallet to be unlocked (`cancelSwap` reads the signing keys
 * from wallet state directly, matching how the local Swap page's own Cancel
 * button works).
 */
export async function cancelSwapOffer(
  req: SwapCancelRequest
): Promise<SwapCancelOutcome> {
  // `fromGlyph` isn't an indexed field (db.ts's `swap` schema only indexes
  // `status`/`txid`/`mode`), so filter in JS rather than `.where()` on it.
  const pending = await db.swap.where({ status: SwapStatus.PENDING }).toArray();
  const swap = pending.find((s) => s.fromGlyph === req.ref);
  if (!swap) {
    throw new SwapFlowError("could not find a pending offer for that token");
  }

  const txid = await cancelSwap(
    swap.from,
    swap.txid,
    swap.fromValue,
    swap.fromGlyph ?? undefined,
    swap.vout ?? 0,
    swap.swapAddress
  );
  if (swap.id !== undefined) {
    await db.swap.update(swap.id, { status: SwapStatus.CANCEL });
  }

  return { txid };
}
