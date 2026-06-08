/**
 * Glyph v2 Soulbound (Non-Transferable) Token Support
 * Reference: Glyph v2 Token Standard Section 8.7
 */

import rjs from "@radiant-core/radiantjs";
import { bytesToHex } from "@noble/hashes/utils";
import { encodeDataPush } from "@bitauth/libauth";
import { GlyphV2Policy } from "./v2metadata";

const { Script, Address } = rjs;

// Opcodes (hex) — see Radiant-Core src/script/{script.h,interpreter.cpp}.
const OP_DROP = "75";
const OP_IF = "63";
const OP_ELSE = "67";
const OP_ENDIF = "68";
const OP_DUP = "76";
const OP_HASH160 = "a9";
const OP_EQUAL = "87";
const OP_EQUALVERIFY = "88";
const OP_NUMEQUAL = "9c";
const OP_VERIFY = "69";
const OP_SWAP = "7c";
const OP_1 = "51";
const OP_CHECKSIGVERIFY = "ad";
const OP_0 = "00";
const OP_INPUTINDEX = "c0";
const OP_PUSHINPUTREFSINGLETON = "d8"; // 36-byte immediate ref
const OP_REFOUTPUTCOUNT_OUTPUTS = "de"; // pop ref -> push #outputs carrying it
const OP_CODESCRIPTBYTECODE_UTXO = "e9"; // pop index -> push input code script
const OP_CODESCRIPTBYTECODE_OUTPUT = "ea"; // pop index -> push output code script

function pushData(hex: string): string {
  return bytesToHex(encodeDataPush(Buffer.from(hex, "hex")));
}

/**
 * scriptSig branch selectors a spender appends after `<sig> <pubkey>`:
 *  - MOVE: re-lock the NFT to the SAME soulbound script (self-custody move).
 *  - BURN: destroy the singleton (no output may carry its ref).
 */
export const SOULBOUND_MOVE_SELECTOR = "51"; // OP_1 -> OP_IF branch
export const SOULBOUND_BURN_SELECTOR = "00"; // OP_0 -> OP_ELSE branch

/**
 * Create a soulbound (non-transferable) NFT covenant.
 *
 * The previous implementation was a plain `OP_PUSHINPUTREFSINGLETON <ref>
 * OP_DROP` + P2PKH — i.e. an ordinary owner-spendable NFT that placed NO
 * constraint on the destination, so a "soulbound" token could be sent to anyone
 * (audit finding). This version actually enforces non-transferability on-chain.
 *
 * To spend, the owner must sign (P2PKH against `ownerAddress`) AND pick one of
 * two paths via the scriptSig selector:
 *
 *   MOVE (selector OP_1): output[0]'s code script must be byte-identical to this
 *     input's code script (induction via OP_CODESCRIPTBYTECODE). Because the
 *     owner pkh and ref are baked into that code, the NFT can only ever re-lock
 *     to the SAME soulbound script for the SAME owner — never to a different
 *     recipient and never to a plain transferable nftScript.
 *
 *   BURN (selector OP_0): the singleton ref must appear in zero outputs
 *     (OP_REFOUTPUTCOUNT_OUTPUTS == 0), destroying the token.
 *
 * Proven on regtest in soulbound.regtest.test.ts: an owner self-move is
 * accepted, a transfer to any other recipient is REJECTED, and a spend by a
 * non-owner is REJECTED.
 */
export function soulboundNftScript(ownerAddress: string, ref: string): string {
  if (ref.length !== 72) {
    throw new Error(
      `soulboundNftScript: ref must be 36 bytes (72 hex chars), got ${ref.length}`
    );
  }
  const pkh = Address.fromString(ownerAddress).hashBuffer.toString("hex");
  if (pkh.length !== 40) {
    throw new Error("soulboundNftScript: owner pkh must be 20 bytes");
  }

  // Owner authorisation (P2PKH, VERIFY form) — required on both paths.
  const ownerAuth =
    OP_DUP + OP_HASH160 + pushData(pkh) + OP_EQUALVERIFY + OP_CHECKSIGVERIFY;

  // MOVE branch (selector OP_1): drop the ref, require the owner's signature,
  // then output[0] code == this input's code (induction → re-lock to the SAME
  // soulbound script for the SAME owner).
  const moveBranch =
    OP_DROP +
    ownerAuth +
    OP_0 +
    OP_CODESCRIPTBYTECODE_OUTPUT +
    OP_INPUTINDEX +
    OP_CODESCRIPTBYTECODE_UTXO +
    OP_EQUAL;

  // BURN branch (selector OP_0): consume the on-stack singleton ref to assert it
  // appears in zero outputs (token destroyed), then require the owner's signature.
  const burnBranch =
    OP_REFOUTPUTCOUNT_OUTPUTS +
    OP_0 +
    OP_NUMEQUAL +
    OP_VERIFY +
    ownerAuth +
    OP_1;

  // The leading singleton ref is the ONLY ref operand in the whole script (no
  // second literal push). The indexer's zero_refs() zeroes INPUT_REF_OP operands
  // (not PUSHDATA), so keeping the ref solely in OP_PUSHINPUTREFSINGLETON makes
  // every owner's soulbound token collapse to ONE owner-stable scripthash —
  // discoverable by a per-owner subscription, not just local tracking. OP_SWAP
  // lifts the scriptSig selector above the pushed ref so OP_IF consumes it.
  const hex =
    OP_PUSHINPUTREFSINGLETON +
    ref +
    OP_SWAP +
    OP_IF +
    moveBranch +
    OP_ELSE +
    burnBranch +
    OP_ENDIF;

  // Round-trip to guarantee well-formed bytes.
  return Script.fromHex(hex).toHex();
}

// Recognise a soulbound covenant and recover its ref (for wallet discovery).
const SOULBOUND_RE = /^d8([0-9a-f]{72})7c63(?:.|\n)*68$/;
export function isSoulboundScript(scriptHex: string): boolean {
  return SOULBOUND_RE.test(scriptHex);
}
export function parseSoulboundRef(scriptHex: string): string | undefined {
  return scriptHex.match(SOULBOUND_RE)?.[1];
}

/**
 * Validate soulbound policy
 */
export function validateSoulboundPolicy(policy?: GlyphV2Policy): {
  valid: boolean;
  error?: string;
} {
  if (!policy) {
    return { valid: true }; // No policy means transferable
  }

  if (policy.transferable === false) {
    // Soulbound token - ensure it's properly configured
    return { valid: true };
  }

  return { valid: true };
}

/**
 * Check if token is soulbound
 */
export function isSoulbound(policy?: GlyphV2Policy): boolean {
  return policy?.transferable === false;
}

/**
 * Validate soulbound transfer (should only allow burns)
 */
export function validateSoulboundTransfer(
  tx: rjs.Transaction,
  tokenRef: string,
  ownerAddress: string
): { valid: boolean; error?: string; isBurn: boolean } {
  // Check if token ref exists in any output
  let tokenFoundInOutput = false;
  let outputOwner: string | undefined;

  for (const output of tx.outputs) {
    const script = output.script.toHex();

    // Check if this output contains the token ref
    if (script.includes(tokenRef)) {
      tokenFoundInOutput = true;

      // Extract output address
      try {
        outputOwner = output.script.toAddress()?.toString();
      } catch {
        // Couldn't extract address
      }
      break;
    }
  }

  if (!tokenFoundInOutput) {
    // Token not in outputs = burn operation
    return { valid: true, isBurn: true };
  }

  // Token exists in output - verify it goes back to same owner
  if (outputOwner !== ownerAddress) {
    return {
      valid: false,
      error: `Soulbound token can only be transferred back to owner or burned. Output owner: ${outputOwner}, Expected: ${ownerAddress}`,
      isBurn: false,
    };
  }

  return { valid: true, isBurn: false };
}

/**
 * Create soulbound policy
 */
export function createSoulboundPolicy(options?: {
  renderable?: boolean;
  executable?: boolean;
  nsfw?: boolean;
}): GlyphV2Policy {
  return {
    transferable: false,
    renderable: options?.renderable ?? true,
    executable: options?.executable ?? false,
    nsfw: options?.nsfw ?? false,
  };
}
