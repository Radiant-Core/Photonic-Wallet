import { Buffer } from "buffer";
import { BlockHeader as RadJSBlockHeader } from "@radiant-core/radiantjs";
import { Subscription } from "@app/types";
import { ElectrumHeaderResponse, ElectrumHeadersResponse } from "@lib/types";
import ElectrumManager from "@app/electrum/ElectrumManager";
import {
  nextBitsAserti32D,
  bitsToTarget,
  ASERT_HALF_LIFE_UPGRADE_HEIGHT,
  HALF_LIFE_V2,
} from "@lib/difficulty";
import db from "@app/db";
import { network } from "@app/signals";
// import { workerInstance } from "@app/verifier";

type BlockData = {
  hash: string;
  height: number;
  timestamp: number;
  bits: number;
};

const checkpoint: BlockData = {
  hash: "000000000000000e7fbf20f83b1b0ac4881b95da9248f746ba9d82e24ca78f05",
  height: 412000,
  timestamp: 1773685184,
  bits: 436241129,
};

// FIX 4 (header-sync DoS hardening).
//
// Serialized block-header length, in bytes / hex chars. ElectrumX returns a
// concatenated hex blob; each header is 80 bytes = 160 hex chars.
const HEADER_HEX_LEN = 160;
// ElectrumX `blockchain.block.headers` caps a single response at 2016 headers
// (one difficulty epoch). Never request — or parse — more than this per call,
// so a malicious server can't make us allocate/iterate an unbounded blob.
const MAX_HEADERS_PER_REQUEST = 2016;
// Upper bound on rollback→catchup recursion. A reorg deeper than this many
// rollbacks is treated as a hard error and surfaced rather than recursing
// forever (the original `// FIXME check for infinite loop?`).
const MAX_REORG_ITERATIONS = 200;

export class HeadersSubscription implements Subscription {
  private electrum: ElectrumManager;
  private latestBlock: BlockData;
  private pending: ElectrumHeaderResponse[];
  private catchingUp: boolean;

  constructor(electrum: ElectrumManager) {
    this.electrum = electrum;
    this.latestBlock = checkpoint;
    this.pending = [];
    this.catchingUp = false;
  }

  async catchup(reorgDepth = 0) {
    this.catchingUp = true;
    console.debug("Catching up block headers");
    try {
      // FIX 4: bound the rollback→catchup recursion. A reorg deeper than
      // MAX_REORG_ITERATIONS rollbacks is almost certainly a malicious or
      // broken server feeding us a header chain that never reconciles. Give up
      // with a surfaced error instead of recursing (and re-requesting) forever.
      if (reorgDepth > MAX_REORG_ITERATIONS) {
        this.catchingUp = false;
        throw new Error(
          `[Headers] reorg did not resolve after ${MAX_REORG_ITERATIONS} rollbacks; aborting catchup`
        );
      }

      const fetchFromHeight = this.latestBlock.height;
      const fetchToHeight =
        this.pending[0]?.height || this.latestBlock.height + 1000;

      // FIX 4: never request more than one ElectrumX response can hold. The
      // server interprets the second arg as a count (we shift one extra to
      // align with our +1 indexing below). Clamp it to the protocol max so a
      // crafted `pending[0].height` can't make us ask for (and parse) an
      // unbounded number of headers.
      const requestedCount = Math.min(
        Math.max(fetchToHeight - fetchFromHeight, 0),
        MAX_HEADERS_PER_REQUEST
      );

      const response = (await this.electrum.client?.request(
        "blockchain.block.headers",
        fetchFromHeight,
        requestedCount
      )) as ElectrumHeadersResponse;

      // FIX 4: reject an oversized / malformed response before parsing. A hex
      // blob longer than MAX_HEADERS_PER_REQUEST headers (or not a clean
      // multiple of the header length) is not something an honest server
      // returns for our bounded request — refuse it rather than allocating a
      // huge array from `.match()`.
      const hex = typeof response?.hex === "string" ? response.hex : "";
      const maxHexLen = MAX_HEADERS_PER_REQUEST * HEADER_HEX_LEN;
      if (hex.length > maxHexLen) {
        this.catchingUp = false;
        throw new Error(
          `[Headers] oversized headers response: ${hex.length} hex chars > cap ${maxHexLen}`
        );
      }
      if (hex.length % HEADER_HEX_LEN !== 0) {
        this.catchingUp = false;
        throw new Error(
          `[Headers] malformed headers response: ${hex.length} hex chars not a multiple of ${HEADER_HEX_LEN}`
        );
      }

      // Split 80 byte header hex strings
      const headers = hex.match(/.{160}/g) || [];

      // Check the first header returned matches our last header
      // If not, there must be a reorg
      const first = headers.shift();
      if (first) {
        const firstHeader = RadJSBlockHeader.fromString(first);
        if (this.latestBlock.hash !== firstHeader.hash) {
          // Reorg. We need to find where the last good header is.
          // Go back 10 blocks and reattempt — bounded by reorgDepth (FIX 4).
          await this.rollback();
          await this.catchup(reorgDepth + 1);
          return;
        }
        console.debug("No reorg found");
      }

      console.debug("Processing catchup headers");

      const heightBefore = this.latestBlock.height;
      headers.forEach((hex, index) => {
        this.processHeader({
          height: fetchFromHeight + index + 1, // Add one because first header was shifted
          hex,
        });
      });

      // Check if we have caught up
      if (
        this.pending.length &&
        this.latestBlock.height < this.pending[0].height - 1
      ) {
        // FIX 4: if this iteration made no forward progress (server returned no
        // usable headers past our tip), don't recurse forever waiting to reach
        // the pending height — treat it as a stalled catchup and surface it.
        // Honest servers always advance the tip here.
        if (this.latestBlock.height <= heightBefore) {
          this.catchingUp = false;
          throw new Error(
            `[Headers] catchup stalled at height ${heightBefore} (no progress toward ${this.pending[0].height}); aborting`
          );
        }
        console.debug("Still not caught up");
        // Preserve the reorg counter across forward-progress recursion so a
        // server that alternates "reorg, advance one, reorg, …" can't bypass
        // the cap (FIX 4).
        await this.catchup(reorgDepth);
        return;
      }

      // Process the headers received from the subscription
      await this.processPending();

      this.catchingUp = false;
      console.debug("Finished catching up");
    } catch (error) {
      // The header fetch can reject when the socket is congested (the request
      // times out) or drops mid-catchup. Clear the in-progress flag so the
      // next header notification — or a syncPending — retries, instead of
      // leaving catchup permanently wedged (catchingUp stuck true) or letting
      // the rejection escape as an unhandled promise. `pending` is preserved,
      // so the queued tip heights are picked up on the retry.
      this.catchingUp = false;
      console.warn("[Headers] catchup failed, will retry on next header:", error);
    }
  }

  async syncPending() {}
  async manualSync() {}

  async processPending() {
    console.debug("Processing pending headers");
    while (this.pending.length > 0) {
      this.processHeader(this.pending.shift() as ElectrumHeaderResponse);
    }
  }

  async register() {
    // Get the latest block from the database, otherwise checkpoint will be used
    this.latestBlock = await this.getLatestBlock();

    this.electrum.client?.subscribe("blockchain.headers", (response) => {
      const raw = response as ElectrumHeaderResponse;
      const header = RadJSBlockHeader.fromString(raw.hex);
      const { height } = raw;
      console.debug(`Header received height ${height}`);

      const prevHash = Buffer.from(header.prevHash).reverse().toString("hex");

      if (
        height > this.latestBlock.height + 1 || // Reorg
        height < this.latestBlock.height || // Catchup
        (height === this.latestBlock.height &&
          header.hash !== this.latestBlock.hash) || // Latest hash incorrect
        (height === this.latestBlock.height + 1 &&
          prevHash !== this.latestBlock.hash) // Latest hash incorrect
      ) {
        this.pending.push(raw);
        if (!this.catchingUp) {
          // Fire-and-forget, but never let a catchup rejection surface as an
          // unhandled promise (catchup swallows its own errors; this is belt
          // and braces).
          this.catchup().catch((err) => {
            this.catchingUp = false;
            console.warn("[Headers] catchup error:", err);
          });
        }
      } else if (this.latestBlock.hash === header.hash) {
        console.debug("Header already in database");
      } else {
        this.processHeader(raw);
      }
    });
  }

  processHeader(raw: ElectrumHeaderResponse) {
    if (!network) {
      throw new Error("Network must be provided");
    }

    const { height, hex } = raw as ElectrumHeaderResponse;
    console.debug(`Processing header height ${height}`);
    const buffer = Buffer.from(hex, "hex").buffer;

    // Select anchor and half-life based on whether we are past the upgrade height
    const anchorV2 = network.value.anchorV2;
    const useV2 = height >= ASERT_HALF_LIFE_UPGRADE_HEIGHT && anchorV2;
    const anchor = useV2 ? anchorV2 : network.value.anchor;
    const halfLife = useV2 ? HALF_LIFE_V2 : undefined;

    const nextBits = nextBitsAserti32D(
      anchor.bits,
      this.latestBlock.timestamp - anchor.prevTime,
      this.latestBlock.height - anchor.height,
      halfLife
    );

    const header = RadJSBlockHeader.fromString(hex);

    const target = bitsToTarget(nextBits);
    const hitTarget = BigInt(`0x${header.hash}`) <= target;
    const valid =
      Buffer.from(header.prevHash).reverse().toString("hex") ===
        this.latestBlock.hash &&
      header.validProofOfWork() &&
      hitTarget;

    if (!valid) {
      console.debug(`Invalid header received at height ${height}`);
      return;
    }

    db.header.put({
      hash: header.hash,
      height,
      reorg: false,
      buffer,
    });

    this.latestBlock = {
      hash: header.hash,
      height,
      timestamp: header.timestamp,
      bits: header.bits,
    };
  }

  async rollback() {
    // Set the last 10 headers to reorg
    // If we went too far, the database update will fix it when a matching key is found
    const { height } = this.latestBlock;
    console.debug(`Rolling back from ${height}`);

    await db.header
      .where("height")
      .aboveOrEqual(height - 9)
      .modify({ reorg: true });
    this.latestBlock = await this.getLatestBlock();
  }

  async getLatestBlock() {
    const dbBlock = await db.header
      .orderBy("height")
      .filter((block) => !block.reorg)
      .last();
    if (dbBlock) {
      const header = RadJSBlockHeader.fromString(
        Buffer.from(dbBlock.buffer).toString("hex")
      );
      return {
        hash: header.hash,
        height: dbBlock.height,
        timestamp: header.timestamp,
        bits: header.bits,
      };
    } else {
      return checkpoint;
    }
  }
}

// ---------------------------------------------------------------------------
// Backward header backfill (pre-checkpoint SPV).
//
// The forward sync above only ever extends the header chain from the pinned
// checkpoint toward the tip, so a coin confirmed BELOW the checkpoint can
// never find its block header locally: verifyTxoInclusion fails on every
// sync and the coin is surfaced as "pending" forever (R14 made confirmed =
// SPV-verified). backfillHeaders walks the chain DOWNWARD from the earliest
// trusted header in bounded chunks, validating each chunk by prev-hash
// linkage up to that trusted anchor. The anchor hash commits to its entire
// ancestry, so linkage alone is sufficient — no backward ASERT target
// recomputation is needed; per-header PoW is still checked as cheap sanity.
// A chunk is persisted only after the whole chunk links, so db.header never
// holds an unvalidated header.
// ---------------------------------------------------------------------------

/**
 * Serialize backfill runs. Concurrent FT/NFT/RXD syncs all funnel through
 * reverifyPendingTxos and may request overlapping ranges; chaining them keeps
 * exactly one fetch loop alive and lets each run see the previous run's
 * headers in its own coverage check.
 */
let backfillChain: Promise<void> = Promise.resolve();

/**
 * Extend the locally stored header chain downward until it covers
 * `targetHeight`, so SPV proofs for coins confirmed at or above that height
 * can be checked. No-op when headers already reach that far. Never throws —
 * on any failure (disconnected, malformed or truncated response, linkage or
 * PoW mismatch) it logs, leaves the remaining range unfetched, and lets the
 * caller's next sync retry.
 *
 * `chunkSize` exists for tests; it is clamped to the ElectrumX protocol cap.
 */
export function backfillHeaders(
  electrum: ElectrumManager,
  targetHeight: number,
  chunkSize = MAX_HEADERS_PER_REQUEST
): Promise<void> {
  const run = backfillChain.then(() =>
    doBackfillHeaders(electrum, targetHeight, chunkSize)
  );
  // doBackfillHeaders never rejects, but never let the chain die regardless.
  backfillChain = run.catch(() => {});
  return run;
}

async function doBackfillHeaders(
  electrum: ElectrumManager,
  targetHeight: number,
  chunkSize: number
): Promise<void> {
  try {
    if (!Number.isSafeInteger(targetHeight) || targetHeight < 0) {
      return;
    }
    const maxPerRequest = Math.max(
      2,
      Math.min(chunkSize, MAX_HEADERS_PER_REQUEST)
    );

    // The earliest stored, non-reorged header is trusted: it either chains up
    // to headers validated by the forward sync, or was itself linkage-checked
    // by a previous backfill chunk. Fall back to the pinned checkpoint for a
    // fresh database.
    let anchor = await getEarliestTrustedBlock();

    // Terminates: every iteration moves `anchor.height` down by at least one
    // (start < anchor.height always), and a server that won't or can't supply
    // a full, linking chunk aborts the loop instead of stalling it.
    while (anchor.height > targetHeight) {
      const start = Math.max(
        targetHeight,
        anchor.height - (maxPerRequest - 1)
      );
      // Request the anchor height too — the fetched chunk must reproduce the
      // anchor hash for the linkage walk below to prove anything.
      const count = anchor.height - start + 1;

      const response = (await electrum.client?.request(
        "blockchain.block.headers",
        start,
        count
      )) as ElectrumHeadersResponse;

      // Deep-history requests must return exactly the requested chunk; a
      // truncated, padded, or malformed response is refused, not linked.
      const hex = typeof response?.hex === "string" ? response.hex : "";
      if (hex.length !== count * HEADER_HEX_LEN) {
        console.warn(
          `[Headers] backfill aborted: requested ${count} headers from ${start}, got ${
            hex.length / HEADER_HEX_LEN
          }`
        );
        return;
      }

      const chunk = hex.match(/.{160}/g) || [];
      const parsed = chunk.map((headerHex) =>
        RadJSBlockHeader.fromString(headerHex)
      );

      // The top of the chunk must BE our trusted anchor header.
      if (parsed[count - 1].hash !== anchor.hash) {
        console.warn(
          `[Headers] backfill aborted: header at ${anchor.height} does not match the trusted chain`
        );
        return;
      }

      // Walk down: each header must be the parent of the (already linked)
      // header above it, and carry valid PoW for its own claimed target.
      for (let i = count - 2; i >= 0; i--) {
        const parentOfAbove = Buffer.from(parsed[i + 1].prevHash)
          .reverse()
          .toString("hex");
        if (parsed[i].hash !== parentOfAbove || !parsed[i].validProofOfWork()) {
          console.warn(
            `[Headers] backfill aborted: header at ${
              start + i
            } failed linkage/PoW validation`
          );
          return;
        }
      }

      await db.header.bulkPut(
        chunk.map((headerHex, i) => {
          const bytes = Buffer.from(headerHex, "hex");
          return {
            hash: parsed[i].hash,
            height: start + i,
            reorg: false,
            // Slice to exactly the 80 header bytes — Buffer.from may pool
            // small allocations, so .buffer alone can be a shared pool far
            // larger than the header.
            buffer: bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            ),
          };
        })
      );

      console.debug(
        `[Headers] backfilled headers ${start}..${anchor.height - 1}`
      );
      anchor = { height: start, hash: parsed[0].hash };
    }
  } catch (error) {
    console.warn("[Headers] backfill failed, will retry on next sync:", error);
  }
}

async function getEarliestTrustedBlock(): Promise<{
  height: number;
  hash: string;
}> {
  const dbBlock = await db.header
    .orderBy("height")
    .filter((block) => !block.reorg)
    .first();
  if (dbBlock) {
    return { height: dbBlock.height, hash: dbBlock.hash };
  }
  return { height: checkpoint.height, hash: checkpoint.hash };
}
