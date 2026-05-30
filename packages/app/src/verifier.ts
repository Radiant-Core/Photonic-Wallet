/**
 * SPV transaction-inclusion verification (audit finding R14 / M4).
 *
 * The cryptographic core lives in `@lib/spv` (pure, unit-tested). This module
 * is the app-side orchestration: it fetches a Merkle branch proof from the
 * Electrum server and checks it against the block header the wallet has
 * already downloaded and validated.
 *
 * Why this matters: `@lib/crypto::verifyTransactionHash` only proves the
 * server returned bytes that hash to the requested txid — not that the
 * transaction was ever mined. A malicious Electrum server could fabricate a
 * well-formed transaction and report it "confirmed". Checking a Merkle proof
 * against our own validated header chain closes that gap.
 *
 * Trust model: `Headers.ts` extends a PoW-validated header chain from a
 * pinned checkpoint (verifying prevHash continuity + target on every header).
 * Given that chain, a valid Merkle proof to a stored header's root proves the
 * transaction is genuinely in the main chain at that height. The remaining
 * assumption is the checkpoint itself, which ships in the build.
 */
import db from "@app/db";
import { verifyTxInclusion } from "@lib/spv";

/**
 * Minimal structural interface for the Electrum client. Matches
 * `ElectrumWS.request` so either the manager's client or a worker client
 * satisfies it without importing the concrete class.
 */
export interface ElectrumRequester {
  request<ResponseType = unknown>(
    method: string,
    ...params: (boolean | string | number | (string | number)[])[]
  ): Promise<ResponseType>;
}

/** ElectrumX `blockchain.transaction.get_merkle` response shape. */
interface GetMerkleResponse {
  block_height: number;
  merkle: string[];
  pos: number;
}

export type TxVerification =
  | { status: "verified"; blockHeight: number }
  | {
      status: "unverified";
      /** Why verification did not succeed. */
      reason:
        | "no-proof" // server returned no/invalid merkle response
        | "no-header" // we don't have the block header at that height
        | "header-reorged" // stored header is flagged as part of a reorg
        | "merkle-mismatch" // proof doesn't match the header's merkle root
        | "bad-pow" // stored header fails its own PoW check
        | "malformed-proof"
        | "error"; // request threw
    };

/**
 * Verify that `txid` is included in the chain via a Merkle proof checked
 * against a locally-stored, PoW-validated block header.
 *
 * @param electrum  An Electrum client (`ElectrumManager.client` or a worker client).
 * @param txid      Transaction id (display/big-endian hex).
 * @param height    Optional known confirmation height — lets the server skip
 *                  a lookup. If omitted, the server resolves it.
 */
export async function verifyTransactionInclusion(
  electrum: ElectrumRequester,
  txid: string,
  height?: number
): Promise<TxVerification> {
  let proof: GetMerkleResponse;
  try {
    proof =
      typeof height === "number"
        ? await electrum.request<GetMerkleResponse>(
            "blockchain.transaction.get_merkle",
            txid,
            height
          )
        : await electrum.request<GetMerkleResponse>(
            "blockchain.transaction.get_merkle",
            txid
          );
  } catch {
    return { status: "unverified", reason: "error" };
  }

  if (
    !proof ||
    typeof proof.block_height !== "number" ||
    !Array.isArray(proof.merkle) ||
    typeof proof.pos !== "number"
  ) {
    return { status: "unverified", reason: "no-proof" };
  }

  // Look up the header we already downloaded + validated for that height.
  const headerRow = await db.header
    .where("height")
    .equals(proof.block_height)
    .first();

  if (!headerRow) {
    return { status: "unverified", reason: "no-header" };
  }
  if (headerRow.reorg) {
    return { status: "unverified", reason: "header-reorged" };
  }

  const result = verifyTxInclusion({
    txid,
    merkle: proof.merkle,
    pos: proof.pos,
    header: new Uint8Array(headerRow.buffer),
    checkPow: true,
  });

  if (result.valid) {
    return { status: "verified", blockHeight: proof.block_height };
  }

  switch (result.reason) {
    case "merkle-mismatch":
      return { status: "unverified", reason: "merkle-mismatch" };
    case "bad-pow":
      return { status: "unverified", reason: "bad-pow" };
    case "malformed-proof":
    case "bad-header-size":
    default:
      return { status: "unverified", reason: "malformed-proof" };
  }
}

/** Human-readable explanation for a verification result, for UI display. */
export function explainVerification(result: TxVerification): string {
  if (result.status === "verified") {
    return `SPV-verified in block ${result.blockHeight}`;
  }
  switch (result.reason) {
    case "no-proof":
      return "Server did not return a Merkle proof (transaction may be unconfirmed).";
    case "no-header":
      return "Block header not yet downloaded — try again after header sync.";
    case "header-reorged":
      return "The block containing this transaction was reorganised.";
    case "merkle-mismatch":
      return "Merkle proof does not match the block header — server may be untrustworthy.";
    case "bad-pow":
      return "Stored block header failed proof-of-work validation.";
    case "malformed-proof":
      return "Malformed Merkle proof from server.";
    case "error":
    default:
      return "Could not reach the server to verify inclusion.";
  }
}
