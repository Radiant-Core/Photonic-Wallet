/**
 * Non-React glue between the connect `mint-request` flow and the wallet's
 * own state: turning a validated {@link MintRequest} into a Glyph NFT
 * payload, self-funding it from the wallet's own RXD UTXOs (never
 * dApp-specified inputs — see `docs/psbt.md`'s design notes on why PSBT
 * doesn't fit minting), and broadcasting the resulting commit+reveal pair.
 *
 * Mirrors `packages/app/src/pages/Mint.tsx`'s own NFT-mint path as closely as
 * possible — same `mintToken` call, same commit-then-reveal broadcast order,
 * same "missing inputs" retry — so a connect-driven mint behaves identically
 * to one the user made by hand. The one deliberate difference: MIME types and
 * embedded-content size are enforced here too (`protocol.ts`'s
 * `MINT_ALLOWED_MIME_TYPES` / `MAX_MINT_DATA_LEN`), because this content is
 * dApp-controlled, not the user's own file picker.
 */
import { Buffer } from "buffer";
import { mintEmbedMaxBytes } from "@app/config.json";
import db from "@app/db";
import { electrumWorker } from "@app/electrum/Electrum";
import { feeRate as feeRateSignal } from "@app/signals";
import { ContractType } from "@app/types";
import { updateRxdBalances } from "@app/utxos";
import { mintToken } from "@lib/mint";
import { embeddableContentBytes } from "@app/svgSanitize";
import { GLYPH_NFT } from "@lib/protocols";
import type {
  SmartTokenEmbeddedFile,
  SmartTokenPayload,
  SmartTokenRemoteFile,
} from "@lib/types";
import type { MintRequest } from "@app/connect/protocol";

export class MintRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintRequestError";
  }
}

/** base64/base64url → bytes, tolerant of the URL-safe alphabet. */
function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

/**
 * Build the Glyph v2 NFT payload for a validated mint request. Pure aside
 * from throwing `MintRequestError` on oversized content — no key access, no
 * network, no database.
 */
export function buildMintPayload(req: MintRequest): SmartTokenPayload {
  let main: SmartTokenEmbeddedFile | SmartTokenRemoteFile;

  if ("data" in req.main) {
    const bytes = base64ToBytes(req.main.data);
    if (bytes.length > mintEmbedMaxBytes) {
      throw new MintRequestError(
        `main content exceeds the ${mintEmbedMaxBytes / 1024}KB on-chain limit`
      );
    }
    // Shared with MintRequestPanel's preview so the user cannot be shown one
    // set of bytes and have another written on-chain.
    main = { t: req.main.mime, b: embeddableContentBytes(req.main.mime, bytes) };
  } else {
    main = { t: req.main.mime, u: req.main.url };
  }

  return {
    v: 2,
    p: [GLYPH_NFT],
    name: req.name,
    ...(req.description ? { desc: req.description } : {}),
    ...(req.license ? { license: req.license } : {}),
    ...(req.attrs ? { attrs: req.attrs } : {}),
    main,
  } as SmartTokenPayload;
}

function isMissingInputsError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.toLowerCase().includes("missing inputs");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type MintOutcome = {
  broadcast: boolean;
  ref: string;
  commitTxid?: string;
  revealTxid?: string;
  commitHex?: string;
  revealHex?: string;
};

/**
 * Fund, build, and sign an NFT mint for `req`, using the wallet's own RXD
 * UTXOs — the dApp never specifies which coins to spend. Broadcasts unless
 * `req.broadcast === false` (a dry run), in which case the built-and-signed
 * commit/reveal hex is returned for inspection instead — nothing is sent,
 * nothing changes on-chain. Throws on insufficient funds (surfaced from
 * `mintToken`'s `fundTx` as a plain Error) or a `MintRequestError` for
 * oversized content.
 */
export async function mintFromRequest(
  req: MintRequest,
  wif: string,
  address: string
): Promise<MintOutcome> {
  const payload = buildMintPayload(req);

  try {
    await electrumWorker.value.manualSync();
  } catch (error) {
    console.debug("[mintFlow] pre-mint UTXO refresh failed", error);
  }
  const coins = await db.txo
    .where({ contractType: ContractType.RXD, spent: 0 })
    .toArray();

  const feeRate = req.feeRate ?? feeRateSignal.value;
  const { commitTx, revealTx, ref } = mintToken(
    "nft",
    { method: "direct", params: { address }, value: 1 },
    wif,
    coins,
    payload,
    [],
    feeRate
  );

  if (req.broadcast === false) {
    return {
      broadcast: false,
      ref: ref.toString(),
      commitHex: commitTx.toString(),
      revealHex: revealTx.toString(),
    };
  }

  const commitTxid = await electrumWorker.value.broadcast(commitTx.toString());

  // The commit is now irreversible and already on-chain. Activity logging
  // and balance refreshes are best-effort from here: none of it is needed
  // to complete the mint, so a failure here shouldn't surface as a request
  // error (the connect error callback would tell the caller the whole mint
  // failed, when in fact the commit already succeeded).
  try {
    await db.broadcast.put({
      txid: commitTxid,
      date: Date.now(),
      description: "nft_mint",
    });
  } catch (error) {
    console.error(
      "[mintFlow] failed to log commit broadcast activity (commit already succeeded)",
      error
    );
  }

  try {
    await electrumWorker.value.manualSync();
  } catch (error) {
    console.debug("[mintFlow] post-commit UTXO refresh failed", error);
  }
  try {
    await updateRxdBalances(address);
  } catch (error) {
    console.error(
      "[mintFlow] post-commit balance refresh failed (commit already succeeded)",
      error
    );
  }

  let revealTxid: string;
  try {
    revealTxid = await electrumWorker.value.broadcast(revealTx.toString());
  } catch (error) {
    if (!isMissingInputsError(error)) {
      // Unlike the bookkeeping above, this one really is unrecoverable here
      // — there is no valid MintOutcome without a revealTxid. Mention the
      // already-broadcast commit so the caller isn't left with just a
      // generic failure for what is actually a stuck commit-without-reveal.
      throw new MintRequestError(
        `commit broadcast as ${commitTxid}, but the reveal transaction failed to broadcast: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    console.debug(
      "[mintFlow] Reveal broadcast returned Missing inputs; refreshing UTXOs and retrying"
    );
    await electrumWorker.value.manualSync();
    await wait(1500);
    try {
      revealTxid = await electrumWorker.value.broadcast(revealTx.toString());
    } catch (retryError) {
      throw new MintRequestError(
        `commit broadcast as ${commitTxid}, but the reveal transaction failed to broadcast after retrying: ${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`
      );
    }
  }

  try {
    await db.broadcast.put({
      txid: revealTxid,
      date: Date.now(),
      description: "nft_mint",
    });
  } catch (error) {
    console.error(
      "[mintFlow] failed to log reveal broadcast activity (reveal already succeeded)",
      error
    );
  }

  try {
    await electrumWorker.value.manualSync();
  } catch (error) {
    console.debug("[mintFlow] post-reveal UTXO refresh failed", error);
  }
  try {
    await updateRxdBalances(address);
  } catch (error) {
    console.error(
      "[mintFlow] post-reveal balance refresh failed (reveal already succeeded)",
      error
    );
  }

  return { broadcast: true, commitTxid, revealTxid, ref: ref.toString() };
}
