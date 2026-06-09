/**
 * Timelocked-refund swap covenant (RSWP v3, Phase 2).
 *
 * Implements the consensus-level expiry described in
 * `docs/swap-offer-expiry-cancellation.md` §4.2. The reserved swap UTXO rests
 * in a covenant with two branches:
 *
 *   - SWAP branch (anytime): byte-identical to the ordinary swap-address
 *     locking script (P2PKH for RXD, ftScript / nftScript for tokens). The
 *     maker pre-signs a spend of THIS branch with SIGHASH_SINGLE|ANYONECANPAY,
 *     exactly as today (`@lib/transfer` `partiallySigned`). A taker completes
 *     the swap by satisfying the swap branch.
 *
 *   - REFUND branch (only at/after `expiry_height`):
 *         <expiry_height> OP_CHECKLOCKTIMEVERIFY OP_DROP <inner-swap-script>
 *     The maker reclaims the reserved asset with their own key once the chain
 *     passes `expiry_height` — no counterparty needed.
 *
 * Why this shape (and why CLTV is "valid-from", not "valid-until")
 * ---------------------------------------------------------------
 * `OP_CHECKLOCKTIMEVERIFY` enforces `tx.nLockTime >= <value>` — a LOWER bound.
 * It cannot, on its own, make the swap branch INVALID after a height. So we do
 * not try to expire the swap branch on-chain; instead we add a refund branch
 * the maker can take at/after the deadline, which gives a guaranteed, cheap,
 * automatic cancellation at a chosen height (see the design doc §2 Option 1).
 * The taker-side / index-side refusal to FILL a past-expiry offer (the RSWP v3
 * `expiry_height` field, enforced in the wallet + swap index) is the
 * cooperative half; the refund covenant is the hard, self-custodial half.
 *
 * Branch selection (scriptSig suffix after the witness data):
 *   - SWAP  selector OP_1 (0x51) -> OP_IF  branch (the pre-signed maker spend)
 *   - REFUND selector OP_0 (0x00) -> OP_ELSE branch (the CLTV refund)
 *
 * The SWAP branch is placed in OP_IF so that the maker's PSRT scriptSig is
 * `<sig> <pubkey> OP_1` — the same `<sig> <pubkey>` the existing swap flow
 * produces, with a single trailing selector byte. The refund branch is the
 * OP_ELSE arm, taken with `<sig> <pubkey> OP_0` plus a spending tx whose
 * nLockTime >= expiry_height and whose input nSequence < 0xffffffff.
 *
 * IMPORTANT — covenant scope. This covenant constrains the RESERVED UTXO so
 * the maker can always reclaim after expiry. It does NOT by itself make the
 * swap branch unfillable after expiry (CLTV cannot express an upper bound on a
 * different branch). A truly atomic "swap invalid after expiry" would need a
 * transaction-locktime-introspection opcode to enforce an UPPER bound on the
 * spending tx's nLockTime; Radiant does not expose one as of this writing, so
 * the realizable mechanism is refund + cooperative refusal. See the design doc
 * §2 Option 1 and the gaps note in this module's tests.
 */

import rjs from "@radiant-core/radiantjs";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { encodeDataPush } from "@bitauth/libauth";
import { Buffer } from "buffer";
import { ftScript, nftScript, p2pkhScript } from "./script";
import { bnFromValue, setInputSequence } from "./rjsCompat";
import { normalizeFeeRate } from "./feePolicy";

const { Script, Opcode, crypto, Transaction, PrivateKey } = rjs;

/**
 * Asset type of the reserved swap UTXO. Uses the lib-native `"rxd"|"ft"|"nft"`
 * convention (same as vault.ts `VaultAssetType`) so this module has no
 * dependency on the app's numeric `ContractType` enum. The app maps its
 * `ContractType` (RXD/FT/NFT) to these strings at the call site.
 */
export type SwapAssetType = "rxd" | "ft" | "nft";

// Opcodes (hex) — see Radiant-Core src/script/{script.h,interpreter.cpp}.
const OP_DROP = "75";
const OP_IF = "63";
const OP_ELSE = "67";
const OP_ENDIF = "68";
const OP_CHECKLOCKTIMEVERIFY = "b1";

/**
 * scriptSig branch selectors a spender appends after the inner witness data
 * (`<sig> <pubkey>` for P2PKH-style inner scripts):
 *   - SWAP: take the pre-signed maker spend (OP_IF branch).
 *   - REFUND: take the CLTV refund (OP_ELSE branch).
 */
export const SWAP_REFUND_SWAP_SELECTOR = "51"; // OP_1  -> OP_IF
export const SWAP_REFUND_REFUND_SELECTOR = "00"; // OP_0 -> OP_ELSE

/**
 * Block heights below this are treated as block heights by CLTV/nLockTime;
 * at or above it they are UNIX timestamps. The swap expiry is always a block
 * HEIGHT, so we reject any value at/above the threshold to avoid the maker
 * accidentally encoding a timestamp the covenant would interpret as a height
 * mismatch. (Same constant as vault.ts LOCKTIME_THRESHOLD.)
 */
export const SWAP_EXPIRY_LOCKTIME_THRESHOLD = 500_000_000;

/** nSequence that enables nLockTime/CLTV (must be < 0xFFFFFFFF). */
export const SWAP_REFUND_SEQUENCE = 0xfffffffe;

/**
 * Minimally-encode a non-negative block height as a CScriptNum push.
 * Little-endian, minimal length, with a 0x00 pad if the top bit is set so the
 * value is never read as negative. Mirrors vault.ts `encodeLocktime`.
 */
export function encodeExpiryHeight(height: number): Buffer {
  if (!Number.isInteger(height) || height < 1) {
    throw new Error("expiry_height must be a positive integer block height");
  }
  if (height >= SWAP_EXPIRY_LOCKTIME_THRESHOLD) {
    throw new Error(
      `expiry_height must be a block height below ${SWAP_EXPIRY_LOCKTIME_THRESHOLD} (got ${height})`
    );
  }
  const bytes: number[] = [];
  let n = height;
  while (n > 0) {
    bytes.push(n & 0xff);
    n >>= 8;
  }
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(0x00);
  }
  return Buffer.from(bytes);
}

/** Length-prefixed data push of an arbitrary byte string given as hex. */
function pushData(hex: string): string {
  return bytesToHex(encodeDataPush(Buffer.from(hex, "hex")));
}

/**
 * Build the inner swap-address locking script for a given contract type. This
 * is byte-identical to the script the existing (v2) swap flow reserves the
 * asset into, so the maker's SIGHASH_SINGLE|ANYONECANPAY pre-signature over the
 * SWAP branch is produced exactly as today.
 *
 *   - RXD: p2pkhScript(swapAddress)
 *   - FT:  ftScript(swapAddress, refLE)
 *   - NFT: nftScript(swapAddress, refLE)
 */
export function innerSwapScript(
  assetType: SwapAssetType,
  swapAddress: string,
  refLE?: string
): string {
  if (assetType === "rxd") {
    return p2pkhScript(swapAddress);
  }
  if (!refLE || refLE.length !== 72) {
    throw new Error("token swap refund covenant requires a 72-hex-char refLE");
  }
  return assetType === "ft"
    ? ftScript(swapAddress, refLE)
    : nftScript(swapAddress, refLE);
}

export type SwapRefundTerms = {
  /** Asset type of the reserved asset ("rxd" | "ft" | "nft"). */
  assetType: SwapAssetType;
  /** Maker's swap-subaccount address (the inner P2PKH owner). */
  swapAddress: string;
  /** Absolute block height at/after which the maker can take the refund. */
  expiryHeight: number;
  /** For FT/NFT: 36-byte little-endian token ref (72 hex chars). */
  refLE?: string;
};

/**
 * Build the timelocked-refund swap covenant scriptPubKey (RSWP v3).
 *
 * Layout:
 *   OP_IF
 *     <inner-swap-script>                       // SWAP branch (anytime)
 *   OP_ELSE
 *     <expiry_height> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *     <inner-swap-script>                        // REFUND branch (>= expiry)
 *   OP_ENDIF
 *
 * Both branches END in the inner swap script (P2PKH-style + token rules), so:
 *   - the maker's SWAP-branch pre-signature is a normal P2PKH-shaped scriptSig
 *     (`<sig> <pubkey>`) over the FULL covenant scriptPubKey — i.e. the sighash
 *     covers the whole covenant (the script being executed), exactly as for any
 *     native covenant spend; the OP_1 selector is then appended so the
 *     interpreter takes the OP_IF branch and the inner P2PKH check runs. In
 *     practice the maker produces this with `partiallySigned(...)` against a
 *     UTXO whose `script` is the covenant script, then `appendSwapSelector`.
 *   - the REFUND branch additionally requires nLockTime >= expiry_height via
 *     CLTV before reaching the same inner script.
 *
 * The result is round-tripped through the radiantjs parser to guarantee
 * well-formed bytes (matching royaltyCovenant.ts / soulbound.ts).
 */
export function swapRefundScript(terms: SwapRefundTerms): string {
  const inner = innerSwapScript(
    terms.assetType,
    terms.swapAddress,
    terms.refLE
  );
  const expiryPush = pushData(encodeExpiryHeight(terms.expiryHeight).toString("hex"));

  const hex =
    OP_IF +
    inner +
    OP_ELSE +
    expiryPush +
    OP_CHECKLOCKTIMEVERIFY +
    OP_DROP +
    inner +
    OP_ENDIF;

  return Script.fromHex(hex).toHex();
}

// Parser. Layout: 63 <inner> 67 <expiryPush(1..6B)> b1 75 <inner> 68
//
// Both <inner> blocks are byte-identical. We parse structurally rather than
// with a backreferenced regex: JS's non-greedy `(.*?)...\1` combination
// backtracks unreliably on hex strings (the engine settles the first group at
// the minimal boundary and cannot re-expand it to satisfy the backreference),
// so a structural split is both correct and clearer. The unique anchor is the
// `67 <expiry-push> b1 75` marker (OP_ELSE <expiry> CLTV DROP) that only the
// covenant wrapper introduces; the inner swap scripts never contain a bare
// `b175` immediately preceded by an OP_ELSE + minimal push.

const OP_IF_HEX = "63";
const OP_ELSE_HEX = "67";
const OP_ENDIF_HEX = "68";
const CLTV_DROP_HEX = "b175";

/**
 * Recover the inner swap script + expiry height from a covenant scriptPubKey.
 * Returns null when the script is not a well-formed swap-refund covenant
 * (including when the two inner branches are not byte-identical).
 */
export function parseSwapRefundScript(scriptHex: string): {
  innerScript: string;
  expiryHeight: number;
} | null {
  const hex = scriptHex.toLowerCase();
  if (!hex.startsWith(OP_IF_HEX) || !hex.endsWith(OP_ENDIF_HEX)) return null;

  // Try each possible expiry-push length (1..6 data bytes -> push opcode is the
  // length byte itself for minimal pushes of <= 75 bytes). For each candidate,
  // locate the `67 <lenByte><data> b175` marker and check the two halves match.
  for (let dataLen = 1; dataLen <= 6; dataLen++) {
    const pushHexLen = (1 + dataLen) * 2; // opcode byte + data bytes, in hex chars
    // Scan for the OP_ELSE that begins the marker. The first inner branch sits
    // between OP_IF (offset 2) and this OP_ELSE.
    for (
      let elsePos = 2;
      elsePos + 2 + pushHexLen + CLTV_DROP_HEX.length <= hex.length;
      elsePos += 2
    ) {
      if (hex.slice(elsePos, elsePos + 2) !== OP_ELSE_HEX) continue;
      const pushStart = elsePos + 2;
      const pushHex = hex.slice(pushStart, pushStart + pushHexLen);
      const lenByte = parseInt(pushHex.slice(0, 2), 16);
      if (lenByte !== dataLen) continue; // minimal push opcode == data length
      const cltvStart = pushStart + pushHexLen;
      if (hex.slice(cltvStart, cltvStart + CLTV_DROP_HEX.length) !== CLTV_DROP_HEX)
        continue;

      const firstInner = hex.slice(2, elsePos);
      const secondInner = hex.slice(
        cltvStart + CLTV_DROP_HEX.length,
        hex.length - OP_ENDIF_HEX.length
      );
      if (!firstInner || firstInner !== secondInner) continue;

      const dataHex = pushHex.slice(2);
      const bytes = Buffer.from(dataHex, "hex");
      let height = 0;
      for (let i = bytes.length - 1; i >= 0; i--) {
        height = height * 256 + bytes[i];
      }
      return { innerScript: firstInner, expiryHeight: height };
    }
  }
  return null;
}

export function isSwapRefundScript(scriptHex: string): boolean {
  return parseSwapRefundScript(scriptHex) !== null;
}

/**
 * Build the scriptSig for the REFUND branch: `<sig> <pubkey> OP_0`.
 *
 * The caller must additionally:
 *   - set the spending input's nSequence to SWAP_REFUND_SEQUENCE, and
 *   - set the spending tx nLockTime >= expiry_height,
 * or the covenant's CLTV check will fail.
 *
 * `sigBuf` is the DER signature WITH its 1-byte sighash type already appended
 * (i.e. the same bytes used in a standard P2PKH scriptSig).
 */
export function buildRefundScriptSig(
  sigBufWithType: Buffer,
  pubKeyBuf: Buffer
): string {
  return Script.empty()
    .add(sigBufWithType)
    .add(pubKeyBuf)
    .add(Opcode.OP_0)
    .toHex();
}

/**
 * Build the scriptSig for the SWAP branch: `<sig> <pubkey> OP_1`.
 *
 * `swapInnerScriptSig` is the maker's pre-signed P2PKH-style scriptSig over the
 * inner script (e.g. the bytes from `partiallySigned(...).inputs[0].script`).
 * We append the OP_1 selector so the interpreter takes the OP_IF branch.
 */
export function appendSwapSelector(swapInnerScriptSigHex: string): string {
  return Script.fromHex(swapInnerScriptSigHex).add(Opcode.OP_1).toHex();
}

// ============================================================================
// Refund-claim transaction builder (maker auto-reclaim at/after expiry)
// ============================================================================

export type SwapRefundUtxo = {
  txid: string;
  vout: number;
  value: number;
  /** The full covenant output script hex (== swapRefundScript(terms)). */
  covenantScript: string;
};

export type SwapRefundFundingUtxo = {
  txid: string;
  vout: number;
  script: string;
  value: number;
};

/**
 * Build the maker's REFUND-branch claim transaction.
 *
 * Spends the reserved swap-refund covenant UTXO back to the maker via the
 * OP_ELSE arm. The spending tx:
 *   - sets nLockTime = expiry_height (so CLTV's `nLockTime >= expiry` passes
 *     once the chain is at/after that height);
 *   - sets the covenant input's nSequence < 0xffffffff (CLTV requires a
 *     non-final input);
 *   - signs the inner P2PKH-style script with the maker's swap key and supplies
 *     `<sig> <pubkey> OP_0` (the REFUND selector) as the scriptSig.
 *
 * The covenant IS the output script (native, not P2SH), so no redeem script is
 * revealed — exactly like spending an ftScript / nftScript / royalty covenant.
 *
 * For RXD the fee is taken from the reclaimed value when no funding is given.
 * For FT/NFT the asset value must be preserved, so `fundingUtxos` (plain P2PKH
 * RXD coins from the maker) are REQUIRED to pay the fee, and a change output is
 * returned to `makerAddress`.
 *
 * @param refundUtxo       the covenant UTXO to reclaim
 * @param terms            the covenant terms (asset type, expiry, swap address, ref)
 * @param toScript         destination scriptPubKey for the reclaimed asset
 *                         (e.g. p2pkhScript / ftScript / nftScript at the maker)
 * @param swapWif          the maker's SWAP-subaccount private key (signs the inner)
 * @param feeRate          photons/byte (clamped to the network floor)
 * @param fundingUtxos     plain RXD coins to pay the fee (required for FT/NFT)
 * @param makerAddress     destination for fee change (required when funding)
 * @param fundingWif       key for the funding inputs (defaults to swapWif)
 */
export function buildSwapRefundClaimTx(
  refundUtxo: SwapRefundUtxo,
  terms: SwapRefundTerms,
  toScript: string,
  swapWif: string,
  feeRate: number,
  fundingUtxos: SwapRefundFundingUtxo[] = [],
  makerAddress?: string,
  fundingWif?: string
): { rawTx: string; txid: string } {
  const expected = swapRefundScript(terms);
  if (refundUtxo.covenantScript.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      "buildSwapRefundClaimTx: covenantScript does not match terms (refusing to sign a mismatched covenant)"
    );
  }

  const effectiveFeeRate = normalizeFeeRate(feeRate);
  const swapKey = PrivateKey.fromWIF(swapWif);
  const swapPub = swapKey.toPublicKey();
  const fundKey = PrivateKey.fromWIF(fundingWif || swapWif);
  const fundPub = fundKey.toPublicKey();

  const isRxd = terms.assetType === "rxd";
  const hasFunding = fundingUtxos.length > 0;
  if (!isRxd && !hasFunding) {
    throw new Error(
      "buildSwapRefundClaimTx: FT/NFT refund must preserve asset value — provide fundingUtxos for the fee"
    );
  }
  if (hasFunding && !makerAddress) {
    throw new Error(
      "buildSwapRefundClaimTx: makerAddress is required to return fee change when funding"
    );
  }

  const tx = new Transaction();
  tx.nLockTime = terms.expiryHeight;

  // Covenant input (index 0). The on-chain scriptPubKey IS the covenant script.
  const covInput = new Transaction.Input({
    prevTxId: refundUtxo.txid,
    outputIndex: refundUtxo.vout,
    script: new Script(),
    output: new Transaction.Output({
      script: refundUtxo.covenantScript,
      satoshis: refundUtxo.value,
    }),
  });
  setInputSequence(covInput, SWAP_REFUND_SEQUENCE);
  tx.addInput(covInput);

  // Funding inputs (plain P2PKH).
  for (const u of fundingUtxos) {
    tx.from({
      address: makerAddress as string,
      txId: u.txid,
      outputIndex: u.vout,
      script: u.script,
      satoshis: u.value,
    });
  }

  // Sizing: covenant scriptSig ≈ <sig 72> <pubkey 33> + selector ≈ 107+1; each
  // funding input ≈ 107. Header/output overhead per claimVaultTx.
  const totalFunding = fundingUtxos.reduce((s, u) => s + u.value, 0);
  const estSize =
    10 +
    (41 + 108) + // covenant input
    fundingUtxos.length * (41 + 107) +
    9 +
    (toScript.length / 2) + // primary output
    (hasFunding ? 9 + 25 : 0); // change output
  const fee = Math.ceil(Math.ceil(estSize * 1.1) * effectiveFeeRate);

  // Primary (reclaimed asset) output.
  const primaryValue = isRxd && !hasFunding ? refundUtxo.value - fee : refundUtxo.value;
  if (primaryValue <= 0) {
    throw new Error("buildSwapRefundClaimTx: refund value too small to cover fee");
  }
  tx.addOutput(
    new Transaction.Output({ script: toScript, satoshis: primaryValue })
  );

  // Fee change (only when funded).
  if (hasFunding && makerAddress) {
    const change = totalFunding - fee;
    if (change > 546) {
      tx.addOutput(
        new Transaction.Output({
          script: Script.fromAddress(makerAddress).toHex(),
          satoshis: change,
        })
      );
    }
  }

  const sigType =
    crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID;

  // Sign the covenant input against the FULL covenant script (the script that
  // executes is the covenant; the inner P2PKH check runs after CLTV+DROP).
  const covSig = Transaction.Sighash.sign(
    tx,
    swapKey,
    sigType,
    0,
    Script.fromHex(refundUtxo.covenantScript),
    bnFromValue(`${refundUtxo.value}`)
  );
  const covScriptSig = buildRefundScriptSig(
    Buffer.concat([covSig.toBuffer(), Buffer.from([sigType])]),
    swapPub.toBuffer()
  );
  tx.inputs[0].setScript(Script.fromHex(covScriptSig));

  // Sign funding inputs (standard P2PKH).
  for (let i = 1; i < tx.inputs.length; i++) {
    const out = tx.inputs[i].output;
    if (!out) throw new Error(`funding input ${i} missing output`);
    const sig = Transaction.Sighash.sign(
      tx,
      fundKey,
      sigType,
      i,
      out.script,
      bnFromValue(`${out.satoshis}`)
    );
    tx.inputs[i].setScript(
      Script.empty()
        .add(Buffer.concat([sig.toBuffer(), Buffer.from([sigType])]))
        .add(fundPub.toBuffer())
    );
  }

  const rawTx = tx.toString();
  const txidHex = bytesToHex(
    Buffer.from(sha256(sha256(Buffer.from(rawTx, "hex")))).reverse()
  );
  return { rawTx, txid: txidHex };
}

/**
 * Resolve the on-chain swap-refund covenant address (P2... wrapper is NOT
 * used — the covenant IS the output script, like ftScript/nftScript/the
 * royalty covenant). Returned for convenience where a script hash is needed.
 */
export function swapRefundScriptHash(terms: SwapRefundTerms): string {
  const outputScript = swapRefundScript(terms);
  return Buffer.from(
    crypto.Hash.sha256(Buffer.from(outputScript, "hex"))
  )
    .reverse()
    .toString("hex");
}

/**
 * Whether an RSWP v3 offer is past its on-chain expiry given the current chain
 * tip. A `0`/falsy `expiryHeight` means "no expiry" (a v2 offer) and is never
 * expired. Mirrors the soft-expiry helpers in app/src/swapExpiry.ts but keys
 * off the consensus `expiry_height` rather than offer age.
 */
export function isOfferExpiredByHeight(
  expiryHeight: number | undefined,
  currentHeight: number
): boolean {
  if (!expiryHeight || expiryHeight <= 0) return false;
  if (!Number.isFinite(currentHeight) || currentHeight <= 0) return false;
  return currentHeight >= expiryHeight;
}
