/**
 * Non-React glue for the connect `anchor-request` flow: publishing a signed
 * Canon declaration on-chain as a `cnd1` commit+reveal pair, self-funded from
 * the wallet's own RXD UTXOs (never dApp-specified inputs — same rule as
 * minting).
 *
 * The carrier mirrors a Glyph mint's mechanics with a minimal, non-token
 * commit script: `OP_HASH256 <sha256d(payload)> OP_EQUALVERIFY OP_DUP
 * OP_HASH160 <wallet pkh> OP_EQUALVERIFY OP_CHECKSIG`, revealed by a
 * push-only scriptSig `<sig> <pubkey> <payload>` where the payload is
 * `"cnd1" ‖ the document's exact JSON bytes`. Nothing is minted; the wallet
 * only pays the fee (the document certifies itself through the signmessage
 * signature inside it — verified here before anything is built, because an
 * anchor is permanent). Broadcast order and the missing-inputs retry mirror
 * `mintFlow.ts`.
 */
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import rjs from "@radiant-core/radiantjs";
import db from "@app/db";
import { electrumWorker } from "@app/electrum/Electrum";
import { feeRate as feeRateSignal } from "@app/signals";
import { ContractType } from "@app/types";
import { updateRxdBalances } from "@app/utxos";
import { buildTx } from "@lib/tx";
import { fundTx } from "@lib/coinSelect";
import { p2pkhScript, pushDataSize } from "@lib/script";
import { normalizeFeeRate } from "@lib/feePolicy";
import { verifyMessage } from "@lib/sign";
import { canonDeclarationFromDocument } from "@app/connect/protocol";
import type { AnchorRequest } from "@app/connect/protocol";
import type { UnfinalizedInput, UnfinalizedOutput } from "@lib/types";

const { Address, Script } = rjs;

export class AnchorRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorRequestError";
  }
}

const ANCHOR_MAGIC = Uint8Array.from([0x63, 0x6e, 0x64, 0x31]); // "cnd1"
const DUST_PHOTONS = 546;

function sha256d(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

/** `"cnd1" ‖ exact document bytes` and its sha256d anchor identity. */
export function anchorPayload(document: string): { payload: Uint8Array; docHash: string } {
  const docBytes = new TextEncoder().encode(document);
  const payload = new Uint8Array(ANCHOR_MAGIC.length + docBytes.length);
  payload.set(ANCHOR_MAGIC, 0);
  payload.set(docBytes, ANCHOR_MAGIC.length);
  return { payload, docHash: bytesToHex(sha256d(payload)) };
}

/**
 * `OP_HASH256 <docHash> OP_EQUALVERIFY OP_DUP OP_HASH160 <pkh>
 * OP_EQUALVERIFY OP_CHECKSIG` — hex. No ref opcodes; nothing is minted.
 */
export function anchorCommitScript(docHashHex: string, address: string): string {
  const pkh = bytesToHex(Address.fromString(address).hashBuffer);
  return `aa20${docHashHex}8876a914${pkh}88ac`;
}

export interface AnchorOutcome {
  broadcast: boolean;
  docHash: string;
  commitTxid?: string;
  revealTxid?: string;
  commitHex?: string;
  revealHex?: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isMissingInputsError(error: unknown): boolean {
  return error instanceof Error && /missing inputs/i.test(error.message);
}

export async function anchorFromRequest(
  req: AnchorRequest,
  wif: string,
  address: string
): Promise<AnchorOutcome> {
  const parsed = canonDeclarationFromDocument(req.document);
  if (!parsed) {
    throw new AnchorRequestError("document is not a well-formed signed Canon declaration");
  }
  // An anchor is permanent — never publish a document whose signature does
  // not verify against the signer address inside it.
  if (!verifyMessage(parsed.challenge, parsed.declaration.signer, parsed.signature)) {
    throw new AnchorRequestError(
      "the declaration's signature does not verify against its signer address"
    );
  }

  const { payload, docHash } = anchorPayload(req.document);
  const commitScript = anchorCommitScript(docHash, address);
  const p2pkh = p2pkhScript(address);
  const feeRate = normalizeFeeRate(req.feeRate ?? feeRateSignal.value);

  // Reveal: one input (outpoint 36 + scriptSig [72+1 sig, 33+1 pubkey,
  // payload push] + varints + sequence), one dust output back to the wallet.
  const revealScriptSigSize = 73 + 34 + pushDataSize(payload.length) + payload.length;
  const revealSize = 4 + 1 + 36 + 3 + revealScriptSigSize + 4 + 1 + 8 + 1 + 25 + 4;
  const revealFee = Math.ceil(revealSize * feeRate);
  const commitValue = DUST_PHOTONS + revealFee;

  try {
    await electrumWorker.value.manualSync();
  } catch (error) {
    console.debug("[anchorFlow] pre-anchor UTXO refresh failed", error);
  }
  const coins = await db.txo
    .where({ contractType: ContractType.RXD, spent: 0 })
    .toArray();

  const commitOutputs: UnfinalizedOutput[] = [{ script: commitScript, value: commitValue }];
  const inputs: UnfinalizedInput[] = [];
  const { funding, change, fee } = fundTx(address, coins, inputs, commitOutputs, p2pkh, feeRate);
  if (fee === 0) {
    throw new AnchorRequestError("insufficient RXD to fund the anchor transactions");
  }
  inputs.push(...funding);

  const commitTx = buildTx(address, wif, inputs, commitOutputs.concat(change), false);

  const revealTx = buildTx(
    address,
    wif,
    [{ txid: commitTx.id, vout: 0, script: commitScript, value: commitValue }],
    [{ script: p2pkh, value: DUST_PHOTONS }],
    false,
    // The payload push goes LAST so it is on top of the stack when the commit
    // script's OP_HASH256 runs; the sig+pubkey below it feed the p2pkh tail.
    (_index, spendScript) => spendScript.add(Buffer.from(payload)),
    undefined,
    // The reveal deliberately pays exactly for its own bytes; the payload can
    // make the pre-sized fee look high to the generic overpay heuristic.
    true
  );

  if (req.broadcast === false) {
    return {
      broadcast: false,
      docHash,
      commitHex: commitTx.toString(),
      revealHex: revealTx.toString(),
    };
  }

  const commitTxid = await electrumWorker.value.broadcast(commitTx.toString());
  try {
    await db.broadcast.put({ txid: commitTxid, date: Date.now(), description: "canon_anchor" });
  } catch (error) {
    console.error("[anchorFlow] failed to log commit broadcast (commit already succeeded)", error);
  }
  try {
    await electrumWorker.value.manualSync();
  } catch (error) {
    console.debug("[anchorFlow] post-commit UTXO refresh failed", error);
  }
  try {
    await updateRxdBalances(address);
  } catch (error) {
    console.error("[anchorFlow] post-commit balance refresh failed", error);
  }

  let revealTxid: string;
  try {
    revealTxid = await electrumWorker.value.broadcast(revealTx.toString());
  } catch (error) {
    if (!isMissingInputsError(error)) {
      throw new AnchorRequestError(
        `commit broadcast as ${commitTxid}, but the reveal failed to broadcast: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    console.debug("[anchorFlow] reveal returned Missing inputs; refreshing and retrying");
    await electrumWorker.value.manualSync();
    await wait(1500);
    revealTxid = await electrumWorker.value.broadcast(revealTx.toString());
  }

  try {
    await db.broadcast.put({ txid: revealTxid, date: Date.now(), description: "canon_anchor" });
    await electrumWorker.value.manualSync();
    await updateRxdBalances(address);
  } catch (error) {
    console.debug("[anchorFlow] post-reveal bookkeeping failed (anchor succeeded)", error);
  }

  return { broadcast: true, docHash, commitTxid, revealTxid };
}
