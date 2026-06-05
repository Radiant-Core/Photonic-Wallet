/**
 * Unstrippable royalty *listing* covenant (Glyph v2).
 *
 * Design (chosen 2026-06-04): a **sale/listing covenant** with **seller-committed
 * fixed amounts**. This is the sound, MUL/DIV-free realisation of REP-3012's
 * intent. See REP/royalty-covenant-notes.md for the full rationale.
 *
 * Lifecycle
 * ---------
 *   - REST: the NFT lives in the ordinary `nftScript(owner, ref)` (P2PKH-gated
 *     singleton). Wallet discovery is unchanged.
 *   - LIST: the owner moves the NFT into `royaltySaleScript(...)`. The covenant
 *     *is* the new scriptPubKey and carries the same singleton `ref` forward, so
 *     it is still the same NFT (the consensus ref-conservation rule forces the
 *     ref into an output on every spend — the same mechanism `nftScript` relies
 *     on).
 *   - BUY: anyone may spend the covenant UTXO *iff* the spending tx pays the
 *     seller and the royalty recipient(s) the exact (or greater) amounts the
 *     seller baked in at list time. No maker signature is required — the
 *     covenant itself is the authorisation.
 *   - CANCEL: the seller may reclaim the NFT at any time with their key
 *     (bypasses the payment checks).
 *
 * Why this binds the price to a *seller* commitment (audit goal b)
 * ----------------------------------------------------------------
 * `P` (seller payout) and `R` (royalty) are *constants compiled into the
 * covenant scriptPubKey* by the seller's wallet at list time. The buyer spends
 * that exact UTXO; they cannot change `P`, `R`, the seller's payout script, or
 * the royalty recipient script without spending a *different* UTXO. So the
 * "sale price" is whatever the seller committed to — not a value the buyer
 * chooses in an output (which was the H4/REP-3012 flaw).
 *
 * Why no on-chain MUL/DIV (avoids the rxdc OP_2MUL/OP_2DIV miscompile)
 * -------------------------------------------------------------------
 * `R = floor(P * bps / 10000)` (clamped by min/max) is computed **off-chain**
 * by the wallet at list time and embedded as a literal. The covenant only does
 * equality/`>=` checks against constants — there is no arithmetic in the
 * script, so the known MUL/DIV lowering bug cannot apply here.
 *
 * Canonical buy-completion output layout (matches SwapLoad.tsx + the in-flight
 * maker-payment-at-output[0] ordering fix):
 *
 *   output[0] = seller payout  (script == sellerScript, value >= P)
 *   output[1] = NFT to buyer    (ordinary nftScript(buyer, ref); ref preserved
 *               by consensus — the covenant does not pin this index)
 *   output[2..2+n-1] = royalty recipient(s) (script == royaltyScript[i],
 *               value >= R[i])
 *   output[2+n..]    = buyer funding change
 *
 * Honest scope (documented limitation)
 * ------------------------------------
 * This covenant makes royalty unstrippable *by the buyer* for any listing, and
 * a compliant wallet always lists using the creator's recorded royalty terms.
 * It does **not** stop a malicious *seller* using non-wallet software from
 * crafting a non-compliant listing (R=0, or royalty paid to themselves), nor a
 * holder gifting the NFT out-of-band with no sale. Closing those requires
 * inducting the creator's terms into the NFT itself (the "always-on" / hybrid
 * design) — deliberately out of scope for this listing-covenant model.
 */

import rjs from "@radiant-core/radiantjs";
import { bytesToHex } from "@noble/hashes/utils";
import { encodeDataPush } from "@bitauth/libauth";
import { nftScript, p2pkhScript, pushMinimal } from "./script";
import { fundTx, SelectableInput } from "./coinSelect";
import { buildTx } from "./tx";
import { Utxo, UnfinalizedInput, UnfinalizedOutput } from "./types";

const { Script, Address, Opcode } = rjs;

// Opcodes used (hex) — see Radiant-Core src/script/interpreter.cpp.
const OP_DROP = "75";
const OP_IF = "63";
const OP_ELSE = "67";
const OP_ENDIF = "68";
const OP_DUP = "76";
const OP_HASH160 = "a9";
const OP_EQUALVERIFY = "88";
const OP_CHECKSIG = "ac";
const OP_VERIFY = "69";
const OP_1 = "51";
const OP_PUSHINPUTREFSINGLETON = "d8"; // takes a 36-byte immediate ref
const OP_OUTPUTVALUE = "cc"; // unary: pop index -> push value (CScriptNum)
const OP_OUTPUTBYTECODE = "cd"; // unary: pop index -> push scriptPubKey bytes
const OP_GREATERTHANOREQUAL = "a2";

// Minimal push of an output index (0..16 -> single OP_N byte via pushMinimal).
const idx = (n: number) => pushMinimal(n);

// Length-prefixed data push of an arbitrary byte string given as hex.
function pushData(hex: string): string {
  return bytesToHex(encodeDataPush(Buffer.from(hex, "hex")));
}

export type RoyaltyRecipientOutput = {
  /** Full destination scriptPubKey hex (usually a P2PKH). */
  script: string;
  /** Minimum photons that must be paid to `script`. */
  value: number;
};

export type RoyaltySaleTerms = {
  /** 36-byte little-endian singleton ref of the NFT being listed. */
  ref: string;
  /** Seller address — used for the cancel path (pkh) and the default payout. */
  sellerAddress: string;
  /** Destination scriptPubKey for the seller's payout (output[0]). */
  sellerScript: string;
  /** Photons the seller must receive at output[0] (the committed price). */
  price: number;
  /**
   * Royalty recipients, paid at output[2], output[3], ... in order. The values
   * are absolute photon amounts the seller's wallet computed from the NFT's
   * recorded royalty (`floor(price*bps/10000)`, clamped) at list time.
   */
  royalties: RoyaltyRecipientOutput[];
};

/**
 * Build the royalty *listing/sale* covenant scriptPubKey.
 *
 * The returned hex is meant to be used as the NFT output's scriptPubKey when the
 * seller lists the token for sale (move from `nftScript` into this covenant).
 */
export function royaltySaleScript(terms: RoyaltySaleTerms): string {
  if (terms.ref.length !== 72) {
    throw new Error(
      `royaltySaleScript: ref must be 36 bytes (72 hex chars), got ${terms.ref.length}`
    );
  }
  if (!Number.isInteger(terms.price) || terms.price < 1) {
    throw new Error("royaltySaleScript: price must be a positive integer");
  }
  if (terms.royalties.length === 0) {
    throw new Error("royaltySaleScript: at least one royalty output required");
  }

  const sellerPkh = Address.fromString(terms.sellerAddress).hashBuffer.toString(
    "hex"
  );
  if (sellerPkh.length !== 40) {
    throw new Error("royaltySaleScript: seller pkh must be 20 bytes");
  }

  // Cancel path: standard P2PKH(seller).
  const cancelBranch =
    OP_DUP + OP_HASH160 + pushData(sellerPkh) + OP_EQUALVERIFY + OP_CHECKSIG;

  // Buy path: enforce seller payout at output[0] and royalties at output[2..].
  let buyBranch =
    // output[0].scriptPubKey == sellerScript
    idx(0) +
    OP_OUTPUTBYTECODE +
    pushData(terms.sellerScript) +
    OP_EQUALVERIFY +
    // output[0].value >= price
    idx(0) +
    OP_OUTPUTVALUE +
    pushMinimal(terms.price) +
    OP_GREATERTHANOREQUAL +
    OP_VERIFY;

  terms.royalties.forEach((r, i) => {
    if (!Number.isInteger(r.value) || r.value < 1) {
      throw new Error(
        `royaltySaleScript: royalty[${i}] value must be a positive integer`
      );
    }
    const outIndex = 2 + i; // royalties start at output[2] (NFT is at output[1])
    buyBranch +=
      idx(outIndex) +
      OP_OUTPUTBYTECODE +
      pushData(r.script) +
      OP_EQUALVERIFY +
      idx(outIndex) +
      OP_OUTPUTVALUE +
      pushMinimal(r.value) +
      OP_GREATERTHANOREQUAL +
      OP_VERIFY;
  });
  buyBranch += OP_1;

  const hex =
    OP_PUSHINPUTREFSINGLETON +
    terms.ref +
    OP_DROP +
    OP_IF +
    cancelBranch +
    OP_ELSE +
    buyBranch +
    OP_ENDIF;

  // Round-trip through the radiantjs parser to guarantee the bytes are a
  // well-formed script (and to surface any push-encoding mistakes early).
  return Script.fromHex(hex).toHex();
}

/**
 * The scriptSig branch-selector a buyer supplies to take the BUY path. The
 * covenant requires no signature on this path — just a single OP_0 (false) to
 * drive OP_IF into OP_ELSE.
 */
export const ROYALTY_BUY_SCRIPTSIG = "00"; // OP_0

/**
 * Recompute the canonical buy-completion outputs the covenant will accept, so
 * the wallet's completion path stays in lockstep with the on-chain check.
 *
 *   [ sellerPayout(0), nftToBuyer(1), ...royalties(2..) ]
 *
 * Buyer funding/change is appended by the caller after these.
 */
export function buildRoyaltySaleOutputs(
  terms: RoyaltySaleTerms,
  nftToBuyerScript: string,
  nftValue: number
): RoyaltyRecipientOutput[] {
  return [
    { script: terms.sellerScript, value: terms.price },
    { script: nftToBuyerScript, value: nftValue },
    ...terms.royalties.map((r) => ({ script: r.script, value: r.value })),
  ];
}

// Parser: recognise a listed NFT and recover its terms for display/completion.
// Layout: d8<ref72>75 63 <cancel> 67 <buy> 68
const SALE_RE = /^d8([0-9a-f]{72})7563((?:.|\n)*?)67((?:.|\n)*)68$/;

export function isRoyaltySaleScript(scriptHex: string): boolean {
  return SALE_RE.test(scriptHex);
}

/**
 * Extract the singleton ref from a sale covenant (cheap check used by wallet
 * discovery to map a listed UTXO back to its NFT).
 */
export function parseRoyaltySaleRef(scriptHex: string): string | undefined {
  const m = scriptHex.match(SALE_RE);
  return m?.[1];
}

/**
 * Default royalty-amount computation (floor(price*bps/10000), clamped). Kept
 * here so listing builders compute `R` identically to the swap-completion path.
 */
export function computeRoyaltyAmount(
  price: number,
  bps: number,
  minimum = 0,
  maximum: number | null = null
): number {
  const raw = Math.floor((price * bps) / 10000);
  let clamped = Math.max(raw, minimum);
  if (maximum !== null) clamped = Math.min(clamped, maximum);
  return clamped;
}

/**
 * Convenience: build sale terms from an NFT's recorded royalty metadata so a
 * compliant wallet always lists honouring the creator's terms.
 */
export function royaltyTermsFromMetadata(opts: {
  ref: string;
  sellerAddress: string;
  price: number;
  royalty: {
    bps: number;
    address: string;
    minimum?: number;
    maximum?: number | null;
    splits?: Array<{ address: string; bps: number }>;
  };
}): RoyaltySaleTerms {
  const { ref, sellerAddress, price, royalty } = opts;
  const total = computeRoyaltyAmount(
    price,
    royalty.bps,
    royalty.minimum ?? 0,
    royalty.maximum ?? null
  );

  const royalties: RoyaltyRecipientOutput[] = [];
  if (royalty.splits && royalty.splits.length > 0) {
    let remaining = total;
    royalty.splits.forEach((s, i) => {
      const last = i === royalty.splits!.length - 1;
      const amt = last ? remaining : Math.floor((total * s.bps) / royalty.bps);
      remaining -= amt;
      if (amt > 0) royalties.push({ script: p2pkhScript(s.address), value: amt });
    });
  } else if (total > 0) {
    royalties.push({ script: p2pkhScript(royalty.address), value: total });
  }

  return {
    ref,
    sellerAddress,
    sellerScript: p2pkhScript(sellerAddress),
    price,
    royalties,
  };
}

// ───────────────────────────── transaction builders ─────────────────────────
// Shared by the wallet and the regtest proof so there is a single, tested code
// path for list / purchase / cancel.

/**
 * LIST: move an NFT from its ordinary `nftScript` UTXO into the royalty sale
 * covenant. Returns the signed transaction; broadcast it to publish the listing.
 * The covenant scriptPubKey is `royaltySaleScript(terms)`.
 */
export function buildRoyaltyListingTx(opts: {
  sellerAddress: string;
  sellerWif: string;
  rxdCoins: SelectableInput[];
  nftUtxo: Utxo; // the NFT at nftScript(seller, ref)
  terms: RoyaltySaleTerms;
  feeRate: number;
}): { tx: rjs.Transaction; covenantScript: string } {
  const covenantScript = royaltySaleScript(opts.terms);
  const fund = fundTx(
    opts.sellerAddress,
    opts.rxdCoins,
    [opts.nftUtxo],
    [{ script: covenantScript, value: opts.nftUtxo.value }],
    p2pkhScript(opts.sellerAddress),
    opts.feeRate
  );
  if (!fund.funded) throw new Error("buildRoyaltyListingTx: funding failed");
  const tx = buildTx(
    opts.sellerAddress,
    opts.sellerWif,
    [opts.nftUtxo, ...fund.funding],
    [{ script: covenantScript, value: opts.nftUtxo.value }, ...fund.change],
    false
  );
  return { tx, covenantScript };
}

/**
 * BUY: spend a royalty-covenant UTXO, paying the seller and royalty recipient(s)
 * the committed amounts and delivering the NFT to the buyer. The covenant
 * enforces the payment outputs on-chain, so a completion that strips/underpays
 * royalties is rejected by consensus.
 *
 * Output layout (matches SwapLoad's canonical ordering):
 *   [ sellerPayout(0), nftToBuyer(1), ...royalties(2..), ...buyer change ]
 */
export function buildRoyaltyPurchaseTx(opts: {
  buyerAddress: string;
  buyerWif: string;
  buyerCoins: SelectableInput[];
  covenantUtxo: Utxo; // the listed NFT (royaltySaleScript) UTXO
  terms: RoyaltySaleTerms;
  feeRate: number;
}): rjs.Transaction {
  const nftToBuyer = nftScript(opts.buyerAddress, opts.terms.ref);
  const payload = buildRoyaltySaleOutputs(
    opts.terms,
    nftToBuyer,
    opts.covenantUtxo.value
  );
  const covInput: UnfinalizedInput = { ...opts.covenantUtxo, scriptSigSize: 1 };
  const fund = fundTx(
    opts.buyerAddress,
    opts.buyerCoins,
    [covInput],
    payload,
    p2pkhScript(opts.buyerAddress),
    opts.feeRate
  );
  if (!fund.funded) throw new Error("buildRoyaltyPurchaseTx: funding failed");
  return buildTx(
    opts.buyerAddress,
    opts.buyerWif,
    [opts.covenantUtxo, ...fund.funding],
    [...payload, ...fund.change],
    false,
    (index, script) =>
      index === 0 ? Script.fromHex(ROYALTY_BUY_SCRIPTSIG) : script
  );
}

/**
 * CANCEL: the seller reclaims a listed NFT (bypasses payment) using the cancel
 * branch — scriptSig `<sig> <pubkey> OP_1`. Returns the NFT to `nftScript(seller)`.
 */
export function buildRoyaltyCancelTx(opts: {
  sellerAddress: string;
  sellerWif: string;
  rxdCoins: SelectableInput[];
  covenantUtxo: Utxo;
  ref: string;
  feeRate: number;
}): rjs.Transaction {
  const reclaim: UnfinalizedOutput = {
    script: nftScript(opts.sellerAddress, opts.ref),
    value: opts.covenantUtxo.value,
  };
  const covInput: UnfinalizedInput = {
    ...opts.covenantUtxo,
    scriptSigSize: 112,
  };
  const fund = fundTx(
    opts.sellerAddress,
    opts.rxdCoins,
    [covInput],
    [reclaim],
    p2pkhScript(opts.sellerAddress),
    opts.feeRate
  );
  if (!fund.funded) throw new Error("buildRoyaltyCancelTx: funding failed");
  return buildTx(
    opts.sellerAddress,
    opts.sellerWif,
    [opts.covenantUtxo, ...fund.funding],
    [reclaim, ...fund.change],
    false,
    // Cancel branch: append OP_1 to the standard <sig> <pubkey> scriptSig.
    (index, script) => (index === 0 ? script.add(Opcode.OP_1) : script)
  );
}
