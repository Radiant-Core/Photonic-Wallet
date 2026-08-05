/* eslint-disable @typescript-eslint/ban-ts-comment */
/**
 * Chain-derived activity backfill for restored wallets.
 *
 * The History page reads `db.broadcast`, which is written locally at broadcast
 * time — so a wallet restored from seed starts with no sends, and the live UTXO
 * sync (`recordReceivedActivity`) can only reconstruct receives that are still
 * unspent. Worse, with an empty broadcast table the wallet's own pre-restore
 * change outputs are indistinguishable from incoming coins and get logged as
 * phantom "Received" entries.
 *
 * This module rebuilds the timeline from `blockchain.scripthash.get_history`
 * on the wallet's two p2pkh addresses (main + swap): each history tx is fetched
 * (hash-verified), classified as send / receive / self by comparing input
 * signer pubkeys and output scripts against the wallet's pubkey hashes, dated
 * from the locally PoW-validated header chain, and written to `db.broadcast`.
 *
 * Semantics:
 * - Own broadcast-time records are authoritative and never overwritten. Only
 *   receive-typed entries (`*_receive`) may be corrected, and only when the
 *   chain proves the wallet signed an input (a phantom receive of our own
 *   change, or a receive whose token kind was mislabeled).
 * - Classification is display-level truth, not protocol-level: a swap fill is
 *   recognised by the ANYONECANPAY sighash on our pre-signed input, but vault
 *   claims and other covenant self-spends land on neutral labels
 *   ("consolidate" / "chain_activity") rather than guessing.
 * - Entries are only written once their block time is known (header present),
 *   so backlog lands at its true timeline position and the notification
 *   mount-time gate never fires a toast storm. Header-missing txs are retried
 *   on the next run.
 * - Runs are incremental and idempotent: after the first complete pass per
 *   address (latched in `db.kvp`), later runs only process txids missing from
 *   `db.broadcast` — which also catches receives that were spent while the
 *   wallet was closed and so never appear in `listunspent`.
 */
import {
  Transaction,
  crypto as rjsCrypto,
  // @ts-ignore
} from "@radiant-core/radiantjs";
import db from "@app/db";
import ElectrumManager from "@app/electrum/ElectrumManager";
import {
  p2pkhScript,
  p2pkhScriptHash,
  parseP2pkhScript,
  parseNftScript,
  parseFtScript,
} from "@lib/script";
import { glyphMagicBytesHex } from "@lib/token";
import { verifyTransactionHash, hexToBytes, bytesToHex } from "@lib/crypto";
import { readBlockTime } from "@lib/spv";
import { backfillHeaders } from "./Headers";

/** Thrown (as Error message) when get_history itself fails — callers must
 *  treat the sweep as incomplete, never as an empty history. */
export const HISTORY_SCAN_FAILED = "HISTORY_SCAN_FAILED";

export interface HistoryBackfillResult {
  /** Distinct txids across both address histories. */
  total: number;
  /** Txids examined this run (missing or reclassifiable entries). */
  examined: number;
  /** New activity entries written. */
  recorded: number;
  /** Phantom / mislabeled receive entries corrected to the chain truth. */
  reclassified: number;
  /** Transient skips (header not yet available, tx fetch failed) — retried
   *  on the next run and latch-blocking. */
  skipped: number;
  /** Txs that deterministically produced no entry (unparseable / no
   *  detectable wallet involvement). Not latch-blocking. */
  unclassified: number;
  /** Work list was capped at MAX_TXS_PER_RUN; the next run continues. */
  truncated: boolean;
  /** True when every entry is settled — the per-address latch was stored. */
  complete: boolean;
}

const EMPTY_RESULT: HistoryBackfillResult = {
  total: 0,
  examined: 0,
  recorded: 0,
  reclassified: 0,
  skipped: 0,
  unclassified: 0,
  truncated: false,
  complete: true,
};

/** Entries the chain is allowed to correct; everything else in db.broadcast
 *  was written by this wallet's own flows and is authoritative. */
const RECLASSIFIABLE = new Set(["rxd_receive", "ft_receive", "nft_receive"]);

/** Raw-tx fetches per run. Newest-first, so the most relevant history lands
 *  immediately; an over-cap wallet completes across runs via the incremental
 *  top-up (recorded txids are skipped on the next pass). */
const MAX_TXS_PER_RUN = 500;
const BATCH_SIZE = 25;
const BATCH_DELAY_MS = 25;

const KVP_KEY = "historyBackfill";

type BackfillLatch = Record<string, { completedAt: number }>;

export interface HistoryTxClassification {
  /** One of the EXACT keys in @app/activity (plus neutral "chain_activity"). */
  description: string;
  /** Photons, matching the conventions of the live entries. */
  amount?: number;
}

const SIGHASH_ANYONECANPAY = 0x80;

/** Derive the p2pkh hash160 set for the wallet's addresses. */
export function ownPkhsForAddresses(addresses: string[]): Set<string> {
  const pkhs = new Set<string>();
  for (const address of addresses) {
    try {
      // parseP2pkhScript's `address` capture is the 20-byte hash160 hex.
      const { address: pkh } = parseP2pkhScript(p2pkhScript(address));
      if (pkh) pkhs.add(pkh);
    } catch {
      // Invalid address — leave it out; get_history would fail on it anyway.
    }
  }
  return pkhs;
}

/**
 * Classify one raw transaction from the wallet's point of view.
 *
 * Input ownership: any scriptSig chunk that is a 33/65-byte pubkey whose
 * hash160 is one of ours proves this wallet signed (p2pkh, token, and
 * commit-reveal spends all unlock with `<sig> <pubkey>` pushes). Output
 * ownership: exact-parse against the plain p2pkh, NFT singleton, and FT
 * script shapes. Unparseable output scripts (OP_RETURN, covenants, vaults,
 * swaps) count as external value — paying into one is a send.
 *
 * Returns null only for unparseable txs or txs with no detectable wallet
 * involvement (deterministic — retrying cannot improve it).
 */
export function classifyHistoryTx(
  rawTxHex: string,
  ownPkhs: Set<string>
): HistoryTxClassification | null {
  let tx: InstanceType<typeof Transaction>;
  try {
    tx = new Transaction(rawTxHex);
  } catch {
    return null;
  }

  // ---- outputs: wallet vs external, split by kind ----
  let walletRxd = 0;
  let walletFt = 0;
  let walletNft = 0;
  let walletNftCount = 0;
  let walletFtCount = 0;
  let otherRxd = 0;
  let otherFt = 0;
  let otherNftCount = 0;
  let otherFtCount = 0;

  for (const out of tx.outputs) {
    let hex: string;
    try {
      hex = out.script.toHex();
    } catch {
      continue;
    }
    const sats: number = out.satoshis ?? 0;

    const nft = parseNftScript(hex);
    if (nft.ref && nft.address) {
      if (ownPkhs.has(nft.address)) {
        walletNftCount++;
        walletNft += sats;
      } else {
        otherNftCount++;
      }
      continue;
    }
    const ft = parseFtScript(hex);
    if (ft.ref && ft.address) {
      if (ownPkhs.has(ft.address)) {
        walletFtCount++;
        walletFt += sats;
      } else {
        otherFtCount++;
        otherFt += sats;
      }
      continue;
    }
    const { address: pkh } = parseP2pkhScript(hex);
    if (pkh && ownPkhs.has(pkh)) {
      walletRxd += sats;
    } else {
      // Plain p2pkh to someone else, or a script we don't recognise
      // (covenant, vault, OP_RETURN…) — external either way.
      otherRxd += sats;
    }
  }

  // ---- inputs: did this wallet sign, and how ----
  let ownsInput = false;
  let ownsAnyonecanpayInput = false;
  let glyphInput = false;

  for (const input of tx.inputs) {
    let chunks: { buf?: Uint8Array }[] = [];
    let hex = "";
    try {
      hex = input.script?.toHex() ?? "";
      chunks = (input.script?.chunks ?? []) as { buf?: Uint8Array }[];
    } catch {
      continue; // coinbase / unparseable scriptSig
    }
    if (!glyphInput && hex.includes(glyphMagicBytesHex)) glyphInput = true;

    let inputIsOurs = false;
    for (const chunk of chunks) {
      const buf = chunk.buf;
      if (!buf || (buf.length !== 33 && buf.length !== 65)) continue;
      // 65 bytes is also an uncompressed pubkey — but a DER signature starts
      // 0x30, a pubkey 0x02/0x03/0x04, so hashing a sig here can only produce
      // a random non-match, never a false positive. Re-wrap the Buffer result:
      // noble's bytesToHex rejects cross-realm Uint8Array subclasses.
      const pkh = bytesToHex(
        new Uint8Array(rjsCrypto.Hash.sha256ripemd160(Buffer.from(buf)))
      );
      if (ownPkhs.has(pkh)) {
        inputIsOurs = true;
        break;
      }
    }
    if (!inputIsOurs) continue;
    ownsInput = true;

    // A pre-signed swap input carries ANYONECANPAY in its sighash byte —
    // that's how a counterparty could complete the tx. DER sigs start 0x30.
    for (const chunk of chunks) {
      const buf = chunk.buf;
      if (!buf || buf.length < 8 || buf[0] !== 0x30) continue;
      if ((buf[buf.length - 1] & SIGHASH_ANYONECANPAY) !== 0) {
        ownsAnyonecanpayInput = true;
      }
      break;
    }
  }

  if (!ownsInput) {
    // Pure receive (or a tx we can't tie to the wallet at all).
    if (walletNftCount > 0)
      return { description: "nft_receive", amount: walletNft || undefined };
    if (walletFtCount > 0)
      return { description: "ft_receive", amount: walletFt || undefined };
    if (walletRxd > 0) return { description: "rxd_receive", amount: walletRxd };
    return null;
  }

  const externalTokens = otherNftCount > 0 || otherFtCount > 0;
  if (externalTokens || otherRxd > 0) {
    // Wallet signed and value/tokens left the wallet. A completed swap is a
    // two-party tx where our side was pre-signed with ANYONECANPAY.
    if (ownsAnyonecanpayInput) return { description: "rxd_swap" };
    if (otherNftCount > 0) return { description: "nft_send" };
    if (otherFtCount > 0)
      return { description: "ft_send", amount: otherFt || undefined };
    return { description: "rxd_send", amount: otherRxd || undefined };
  }

  // Self-transfer: everything came back to the wallet.
  if (glyphInput && walletNftCount > 0)
    return { description: "nft_mint", amount: walletNft || undefined };
  if (glyphInput && walletFtCount > 0)
    return { description: "ft_mint", amount: walletFt || undefined };
  if (walletNftCount === 0 && walletFtCount === 0)
    return { description: "consolidate" };
  // Token self-move (swap-address shuffle, WAVE update, covenant op…) — a
  // neutral entry beats a wrong label. Renders as generic "Transaction".
  return { description: "chain_activity" };
}

/** Vault-style single-retry request: cold ElectrumX caches on heavy addresses
 *  routinely blow the first call's timeout; the retry then returns quickly.
 *  Returns undefined when both attempts fail. */
async function requestWithRetry(
  electrum: ElectrumManager,
  method: string,
  params: (string | number)[],
  contextTag: string,
  backoffMs = 500
): Promise<unknown> {
  try {
    return await electrum.client?.request(method, ...params);
  } catch (firstErr) {
    await new Promise((r) => setTimeout(r, backoffMs));
    try {
      return await electrum.client?.request(method, ...params);
    } catch (secondErr) {
      console.warn(
        `[HistoryBackfill] ${method} failed twice for ${contextTag}:`,
        secondErr,
        "(first error:",
        firstErr,
        ")"
      );
      return undefined;
    }
  }
}

/** Block time in ms from the locally validated header chain, or undefined
 *  when the header isn't stored (yet). */
async function blockTimeMs(height: number): Promise<number | undefined> {
  try {
    const header = await db.header.where("height").equals(height).first();
    if (header?.buffer) {
      const seconds = readBlockTime(new Uint8Array(header.buffer));
      if (seconds > 0) return seconds * 1000;
    }
  } catch (e) {
    console.warn("[HistoryBackfill] could not read block time", height, e);
  }
  return undefined;
}

let running = false;

/**
 * Rebuild `db.broadcast` activity from on-chain history for the given
 * addresses (main + swap). See the module doc for semantics. Throws
 * HISTORY_SCAN_FAILED when a history listing cannot be loaded at all, so
 * callers never latch a failed scan as complete.
 */
export async function backfillHistory(
  electrum: ElectrumManager,
  addresses: string[]
): Promise<HistoryBackfillResult> {
  const scanAddresses = addresses.filter(Boolean);
  if (scanAddresses.length === 0) return { ...EMPTY_RESULT };
  if (running) {
    console.warn("[HistoryBackfill] already in progress, skipping");
    return { ...EMPTY_RESULT, complete: false };
  }
  running = true;
  try {
    return await runBackfill(electrum, scanAddresses);
  } finally {
    running = false;
  }
}

async function runBackfill(
  electrum: ElectrumManager,
  addresses: string[]
): Promise<HistoryBackfillResult> {
  const ownPkhs = ownPkhsForAddresses(addresses);

  // ---- 1. Full history across both addresses, deduped by txid ----
  const heightByTxid = new Map<string, number>();
  for (const address of addresses) {
    const history = (await requestWithRetry(
      electrum,
      "blockchain.scripthash.get_history",
      [p2pkhScriptHash(address)],
      `history:${address}`
    )) as { tx_hash: string; height: number }[] | undefined;
    if (history === undefined) {
      // Retries exhausted — a failed scan must never read as an empty one.
      throw new Error(HISTORY_SCAN_FAILED);
    }
    for (const entry of history) {
      if (typeof entry?.tx_hash !== "string") continue;
      const height = typeof entry.height === "number" ? entry.height : 0;
      const prev = heightByTxid.get(entry.tx_hash);
      // Confirmed height wins over mempool 0/-1 (same tx can differ per
      // address view mid-confirmation).
      if (prev === undefined || (prev <= 0 && height > 0)) {
        heightByTxid.set(entry.tx_hash, height);
      }
    }
  }

  const total = heightByTxid.size;
  if (total === 0) {
    await storeLatch(addresses);
    return { ...EMPTY_RESULT };
  }

  // First run (any address not yet latched) also re-examines receive-typed
  // entries: the UTXO sync may already have logged the wallet's own
  // pre-restore change as phantom receives, and chain truth corrects them.
  const latch = ((await db.kvp.get(KVP_KEY)) as BackfillLatch | undefined) ?? {};
  const firstRun = addresses.some((a) => !latch[a]);

  // ---- 2. Work list: missing entries (+ reclassifiable ones on first run) ----
  const work: { txid: string; height: number }[] = [];
  for (const [txid, height] of heightByTxid) {
    const existing = await db.broadcast.get(txid);
    if (!existing) {
      work.push({ txid, height });
    } else if (firstRun && RECLASSIFIABLE.has(existing.description)) {
      work.push({ txid, height });
    }
  }

  // Newest first — unconfirmed (height <= 0) ahead of everything.
  const sortHeight = (h: number) => (h > 0 ? h : Number.MAX_SAFE_INTEGER);
  work.sort((a, b) => sortHeight(b.height) - sortHeight(a.height));

  const truncated = work.length > MAX_TXS_PER_RUN;
  const slice = truncated ? work.slice(0, MAX_TXS_PER_RUN) : work;

  if (slice.length === 0) {
    await storeLatch(addresses);
    return { ...EMPTY_RESULT, total };
  }

  console.log(
    `[HistoryBackfill] ${slice.length}/${total} history tx(s) to examine` +
      (truncated ? " (capped; next run continues)" : "")
  );

  // ---- 3. Headers down to the oldest confirmed tx we'll date ----
  const minHeight = slice.reduce(
    (min, w) => (w.height > 0 ? Math.min(min, w.height) : min),
    Infinity
  );
  if (Number.isFinite(minHeight)) {
    await backfillHeaders(electrum, minHeight);
  }

  // ---- 4. Fetch, classify, date, write ----
  let recorded = 0;
  let reclassified = 0;
  let skipped = 0;
  let unclassified = 0;
  let examined = 0;

  for (const { txid, height } of slice) {
    examined++;
    if (examined % BATCH_SIZE === 0) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
    if (examined % 250 === 0) {
      console.log(
        `[HistoryBackfill] examined ${examined}/${slice.length} tx(s)…`
      );
    }

    const rawTx = (await requestWithRetry(
      electrum,
      "blockchain.transaction.get",
      [txid],
      `tx:${txid}`
    )) as string | undefined;
    if (typeof rawTx !== "string" || rawTx.length === 0) {
      skipped++;
      continue;
    }

    // Malicious-server guard: same hash gate as worker.getTransaction.
    try {
      if (!verifyTransactionHash(hexToBytes(rawTx), txid)) {
        console.warn(`[HistoryBackfill] tx hash mismatch for ${txid}`);
        skipped++;
        continue;
      }
    } catch {
      skipped++;
      continue;
    }

    const cls = classifyHistoryTx(rawTx, ownPkhs);
    if (!cls) {
      unclassified++;
      continue;
    }

    // Only write once the true block time is known, so backlog lands at its
    // real timeline position (and can't trigger the notification toast gate).
    let date: number | undefined;
    if (height > 0) {
      date = await blockTimeMs(height);
      if (date === undefined) {
        skipped++; // header not stored yet — retried next run
        continue;
      }
    } else {
      date = Date.now(); // genuinely in the mempool right now
    }

    // Re-check at write time: the live UTXO sync runs concurrently and may
    // have logged this txid since the work list was built. Own broadcast
    // records stay authoritative; receive-typed entries yield to chain truth.
    const existing = await db.broadcast.get(txid);
    if (existing) {
      if (!RECLASSIFIABLE.has(existing.description)) continue;
      if (existing.description === cls.description) continue;
      await db.broadcast.put({
        txid,
        description: cls.description,
        date,
        amount: cls.amount,
      });
      reclassified++;
      continue;
    }

    await db.broadcast.put({
      txid,
      description: cls.description,
      date,
      amount: cls.amount,
    });
    recorded++;
  }

  // ---- 5. Latch only a fully settled pass ----
  const complete = !truncated && skipped === 0;
  if (complete) {
    await storeLatch(addresses);
  }

  console.log(
    `[HistoryBackfill] done: ${recorded} recorded, ${reclassified} corrected, ` +
      `${skipped} skipped, ${unclassified} unclassified` +
      (complete ? " (complete)" : " (incomplete — will retry)")
  );

  return {
    total,
    examined,
    recorded,
    reclassified,
    skipped,
    unclassified,
    truncated,
    complete,
  };
}

async function storeLatch(addresses: string[]): Promise<void> {
  const latch =
    ((await db.kvp.get(KVP_KEY)) as BackfillLatch | undefined) ?? {};
  const completedAt = Date.now();
  for (const address of addresses) {
    latch[address] = { completedAt };
  }
  await db.kvp.put(latch, KVP_KEY);
}
