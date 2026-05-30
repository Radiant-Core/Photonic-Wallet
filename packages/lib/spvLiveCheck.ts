/**
 * Manual live-chain SPV verification harness (NOT a CI test — hits the network).
 *
 * Connects to a real Radiant Electrum server and exercises the ACTUAL
 * `spv.ts` code paths against live chain data:
 *   1. get the tip header,
 *   2. pull a real coinbase txid + Merkle branch via id_from_pos,
 *   3. verifyTxInclusion against the real block header (+ PoW),
 *   4. negative controls (tampered txid / tampered header).
 *
 * This caught the original SHA256d-vs-SHA512-256d header-hash bug that the
 * unit tests (which used a Bitcoin vector) missed. Re-run it after any change
 * to spv.ts, difficulty.ts, or if Radiant consensus/Electrum behaviour shifts.
 *
 * It lives at the package root (outside `src/`) so it is excluded from the
 * build, typecheck, lint, and vitest globs. Node can't run the lib's
 * extensionless TS imports directly, so bundle + run with esbuild:
 *
 *   node_modules/.pnpm/esbuild@*\/node_modules/esbuild/bin/esbuild \
 *     packages/lib/spvLiveCheck.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/spvcheck.mjs && node /tmp/spvcheck.mjs
 */
import {
  verifyTxInclusion,
  hashBlockHeader,
  extractMerkleRoot,
  verifyHeaderTarget,
} from "./src/spv.ts";
import { hexToBytes } from "@noble/hashes/utils";

const ENDPOINT = "wss://electrumx.radiantcore.org";

type RpcResolver = { resolve: (v: unknown) => void; reject: (e: Error) => void };

function makeClient(url: string) {
  const ws = new WebSocket(url);
  const pending = new Map<number, RpcResolver>();
  let nextId = 1;
  let buffer = "";

  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WS error")));
  });

  const handle = (msg: { id?: number; error?: unknown; result?: unknown }) => {
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };

  ws.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data as unknown;
    let chunk: string;
    if (typeof d === "string") chunk = d;
    else if (d instanceof ArrayBuffer) chunk = new TextDecoder().decode(d);
    else if (ArrayBuffer.isView(d))
      chunk = new TextDecoder().decode(d as ArrayBufferView);
    else chunk = String(d);

    // ElectrumX over WebSocket sends each JSON response as its own frame
    // (no newline delimiter). Try parsing the whole frame first; fall back
    // to newline-splitting for servers that batch.
    const trimmed = chunk.trim();
    try {
      handle(JSON.parse(trimmed));
      return;
    } catch {
      /* not a single complete object — try line framing below */
    }
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore partial */
      }
    }
  });

  function request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const id = nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(payload);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 20000);
    });
  }

  return { ready, request, close: () => ws.close() };
}

function log(ok: boolean, msg: string) {
  console.log(`${ok ? "✓ PASS" : "✗ FAIL"}  ${msg}`);
  if (!ok) process.exitCode = 1;
}

// Watchdog: never let the process hang. Forces exit (flushing stdout) so we
// always see partial progress even if a request stalls.
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: forcing exit after 40s");
  process.exit(2);
}, 40000);

async function main() {
  console.log(`Connecting to ${ENDPOINT} ...`);
  const c = makeClient(ENDPOINT);
  await Promise.race([
    c.ready,
    new Promise((_, rej) => setTimeout(() => rej(new Error("open timeout")), 12000)),
  ]);
  console.log("Connected.\n");

  const version = await c.request("server.version", ["spv-live-check", "1.4"]);
  console.log("server.version:", JSON.stringify(version));

  // 1. Tip header via subscribe.
  const tip = (await c.request("blockchain.headers.subscribe", [])) as {
    height: number;
    hex: string;
  };
  console.log(`\nTip height: ${tip.height}`);

  // Verify the tip header itself: PoW + that our block-hash matches what the
  // server would report (endianness sanity against live data).
  const tipHeader = hexToBytes(tip.hex);
  log(verifyHeaderTarget(tipHeader), `tip header satisfies its own PoW`);
  console.log(`  tip block hash:   ${hashBlockHeader(tipHeader)}`);
  console.log(`  tip merkle root:  ${extractMerkleRoot(tipHeader)}`);

  // 2. Choose a matured height a few blocks below tip and fetch its header.
  const H = tip.height - 6;
  const headerHex = (await c.request("blockchain.block.header", [H])) as string;
  const header = hexToBytes(headerHex);
  console.log(`\nBlock ${H} header fetched (${header.length} bytes)`);
  console.log(`  block hash:   ${hashBlockHeader(header)}`);
  console.log(`  merkle root:  ${extractMerkleRoot(header)}`);
  log(verifyHeaderTarget(header), `block ${H} header satisfies its own PoW`);

  // 3. Get the coinbase tx (pos 0) of block H WITH its Merkle branch.
  //    ElectrumX: blockchain.transaction.id_from_pos(height, pos, merkle=true)
  //    → { tx_hash, merkle: [...] }
  const idfp = (await c.request("blockchain.transaction.id_from_pos", [
    H,
    0,
    true,
  ])) as { tx_hash: string; merkle: string[] };
  console.log(`\nCoinbase txid @ ${H}:0 = ${idfp.tx_hash}`);
  console.log(`  merkle branch length: ${idfp.merkle.length}`);

  // 4. THE REAL TEST: verify inclusion of the live coinbase tx against the
  //    live header, including PoW.
  const good = verifyTxInclusion({
    txid: idfp.tx_hash,
    merkle: idfp.merkle,
    pos: 0,
    header,
    checkPow: true,
  });
  log(
    good.valid,
    `verifyTxInclusion accepts the real coinbase tx in block ${H} (reason: ${
      good.reason ?? "none"
    })`
  );

  // 5. Negative control: tamper the txid → must be rejected.
  const tamperedTxid =
    (idfp.tx_hash[0] === "a" ? "b" : "a") + idfp.tx_hash.slice(1);
  const badTx = verifyTxInclusion({
    txid: tamperedTxid,
    merkle: idfp.merkle,
    pos: 0,
    header,
    checkPow: true,
  });
  log(
    !badTx.valid && badTx.reason === "merkle-mismatch",
    `tampered txid is rejected (reason: ${badTx.reason})`
  );

  // 6. Negative control: verify against the WRONG block header (tip instead
  //    of H) → merkle root won't match.
  const wrongHeader = verifyTxInclusion({
    txid: idfp.tx_hash,
    merkle: idfp.merkle,
    pos: 0,
    header: tipHeader,
    checkPow: true,
  });
  log(
    !wrongHeader.valid && wrongHeader.reason === "merkle-mismatch",
    `proof against the wrong block header is rejected (reason: ${wrongHeader.reason})`
  );

  // 7. Also verify a deeper tx position if the block has more than one tx.
  try {
    const idfp1 = (await c.request("blockchain.transaction.id_from_pos", [
      H,
      1,
      true,
    ])) as { tx_hash: string; merkle: string[] };
    const pos1 = verifyTxInclusion({
      txid: idfp1.tx_hash,
      merkle: idfp1.merkle,
      pos: 1,
      header,
      checkPow: true,
    });
    log(
      pos1.valid,
      `verifyTxInclusion accepts tx at position 1 (${idfp1.tx_hash.slice(
        0,
        16
      )}…)`
    );
  } catch (e) {
    console.log(
      `  (block ${H} has only a coinbase tx — skipping position-1 check: ${
        (e as Error).message
      })`
    );
  }

  c.close();
  clearTimeout(watchdog);
  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error("HARNESS ERROR:", e);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(watchdog);
    // Give stdout a tick to flush, then exit so a lingering socket can't hang us.
    setTimeout(() => process.exit(process.exitCode ?? 0), 200);
  });
