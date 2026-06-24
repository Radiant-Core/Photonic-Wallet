/**
 * On-chain proof (live regtest) for the swap-address recovery fix.
 *
 * When an NFT is listed for atomic swap it is moved to nftScript(swapAddress) and
 * can land at a NON-ZERO output index. The wallet recovers such a reserved NFT by
 * (a) discovering it via the indexer's listunspent at nftScriptHash(swapAddress)
 * — which must return its real tx_pos and ref — and (b) cancelling it by spending
 * that exact outpoint. The old cancel hardcoded vout 0, so a token reserved at
 * vout 1 was uncancellable ("Missing inputs"). This drives the real chain:
 *   1. mint an NFT to the main key,
 *   2. move it to nftScript(swapAddress) at OUTPUT INDEX 1 (dummy at index 0),
 *   3. assert the indexer lists it at the swap scripthash with tx_pos===1 + ref,
 *   4. assert a cancel spending vout 0 is REJECTED (the bug's failure),
 *   5. assert a cancel spending vout 1 (swap key) is ACCEPTED and returns the NFT
 *      to nftScript(mainAddress).
 *
 * Requires the local regtest stack: radiantd RPC 127.0.0.1:17443 + RXinDexer
 * electrum TCP 127.0.0.1:50010. Gated behind REGTEST_E2E=1.
 */
import { it, expect } from "vitest";
import net from "node:net";
import { Buffer } from "buffer";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { buildTx } from "../tx";
import { fundTx, SelectableInput } from "../coinSelect";
import {
  nftScript,
  nftScriptHash,
  p2pkhScript,
  parseNftScript,
} from "../script";
import { reverseRef } from "../Outpoint";
import { GLYPH_NFT } from "../protocols";
import { Utxo, UnfinalizedOutput, SmartTokenPayload } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks } = rjs as any;
const RPC_URL = "http://127.0.0.1:17443/";
const AUTH =
  "Basic " +
  Buffer.from("radiantrpc:613c41227c677d8bc90f5729f93604a7").toString("base64");
const ELECTRUM = { host: "127.0.0.1", port: 50010 };
const FEE_RATE = 10_000;
const PHOTONS = 100_000_000;

let rpcId = 0;
async function rpc<T = any>(method: string, params: any[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: AUTH },
    body: JSON.stringify({ jsonrpc: "1.0", id: rpcId++, method, params }),
  });
  const j = (await res.json()) as any;
  if (j.error) throw new Error(`RPC ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const broadcast = (hex: string) => rpc<string>("sendrawtransaction", [hex]);
async function tryBroadcast(hex: string) {
  try {
    await broadcast(hex);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, err: String(e) };
  }
}
type Key = { wif: string; address: string };
function newKey(): Key {
  const pk = PrivateKey.fromRandom(Networks.regtest);
  return { wif: pk.toWIF(), address: pk.toAddress(Networks.regtest).toString() };
}
let MINE_ADDR = "";
const mine = (n = 1) => rpc("generatetoaddress", [n, MINE_ADDR]);
async function rxdCoins(address: string): Promise<SelectableInput[]> {
  const r = await rpc<{ unspents: any[] }>("scantxoutset", [
    "start",
    [{ desc: `addr(${address})` }],
  ]);
  return (r.unspents || [])
    .map((u) => ({
      txid: u.txid,
      vout: u.vout,
      script: u.scriptPubKey,
      value: Math.round(u.amount * PHOTONS),
    }))
    .filter((u) => u.value > 1);
}
async function utxoByScript(scriptHex: string): Promise<Utxo | null> {
  const r = await rpc<{ unspents: any[] }>("scantxoutset", [
    "start",
    [{ desc: `raw(${scriptHex})` }],
  ]);
  const u = (r.unspents || [])[0];
  return u
    ? {
        txid: u.txid,
        vout: u.vout,
        script: scriptHex,
        value: Math.round(u.amount * PHOTONS),
      }
    : null;
}

// minimal electrum client (newline-delimited JSON-RPC)
function electrumCall<T>(method: string, params: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const sock = net.connect(ELECTRUM.port, ELECTRUM.host);
    let buf = "";
    let id = 1;
    const pending = new Map<number, (v: any) => void>();
    const send = (m: string, p: unknown[]) =>
      new Promise<any>((res) => {
        const rid = id++;
        pending.set(rid, res);
        sock.write(JSON.stringify({ id: rid, method: m, params: p }) + "\n");
      });
    sock.setTimeout(20_000, () => reject(new Error("electrum timeout")));
    sock.on("error", reject);
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg.error ? Promise.reject(new Error(JSON.stringify(msg.error))) : msg.result);
        }
      }
    });
    (async () => {
      try {
        await send("server.version", ["swaprec", "1.4"]);
        const r = (await send(method, params)) as T;
        sock.end();
        resolve(r);
      } catch (e) {
        sock.end();
        reject(e as Error);
      }
    })();
  });
}
type ElUnspent = { tx_hash: string; tx_pos: number; value: number; refs?: { ref: string }[] };
const listUnspent = (sh: string) =>
  electrumCall<ElUnspent[]>("blockchain.scripthash.listunspent", [sh]);
const indexerHeight = () =>
  electrumCall<{ height: number }>("blockchain.headers.subscribe", []).then((r) => r.height);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForIndexer(target: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await indexerHeight().catch(() => -1);
    if (h >= target) return;
    if (Date.now() > deadline) throw new Error(`indexer stuck at ${h}, want ${target}`);
    await sleep(1500);
  }
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "swap-address NFT at vout 1 is indexer-discoverable and cancellable only at its real vout",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const main = newKey();
    const swap = newKey(); // the wallet's separate swap-address key
    await rpc("sendtoaddress", [main.address, 100]);
    await mine(1);

    // ── mint an NFT to the main address ─────────────────────────────────────
    const payload = { p: [GLYPH_NFT], name: "Swap Recovery E2E" } as unknown as SmartTokenPayload;
    const m = mintToken(
      "nft",
      { method: "direct", params: { address: main.address }, value: 1 },
      main.wif,
      (await rxdCoins(main.address)) as Utxo[],
      payload,
      [],
      FEE_RATE
    );
    await broadcast(m.commitTx.toString());
    await broadcast(m.revealTx.toString());
    await mine(1);
    const refLE = parseNftScript(m.revealTx.outputs[0].script.toHex()).ref as string;
    const nftAtMain = await utxoByScript(nftScript(main.address, refLE));
    expect(nftAtMain).toBeTruthy();

    // ── "list for swap": move the NFT to nftScript(swapAddress) at OUTPUT 1 ──
    // A dummy p2pkh at index 0 forces the NFT to vout 1 (the bug's scenario).
    const dummy: UnfinalizedOutput = { script: p2pkhScript(main.address), value: 1000 };
    const nftToSwap: UnfinalizedOutput = {
      script: nftScript(swap.address, refLE),
      value: 1,
    };
    const moveFund = fundTx(
      main.address,
      await rxdCoins(main.address),
      [nftAtMain as Utxo],
      [dummy, nftToSwap],
      p2pkhScript(main.address),
      FEE_RATE
    );
    if (!moveFund.funded) throw new Error("move funding failed");
    const moveTx = buildTx(
      main.address,
      main.wif,
      [nftAtMain as Utxo, ...moveFund.funding],
      [dummy, nftToSwap, ...moveFund.change],
      false
    );
    const moveTxid = await broadcast(moveTx.toString());
    await mine(1);
    const height = await rpc<number>("getblockcount");
    // NFT is now at moveTxid:1 (output index 1).
    expect(moveTx.outputs[1].script.toHex()).toBe(nftScript(swap.address, refLE));

    // ── the indexer must surface it at nftScriptHash(swapAddress) w/ tx_pos 1 ─
    await waitForIndexer(height);
    const swapSh = nftScriptHash(swap.address);
    const unspent = await listUnspent(swapSh);
    const found = unspent.find((u) => u.tx_hash === moveTxid && u.tx_pos === 1);
    console.log("indexer found reserved NFT:", !!found, "tx_pos:", found?.tx_pos, "refs:", JSON.stringify(found?.refs));
    expect(found).toBeTruthy(); // findSwaps/recoverSwaps can discover it
    expect(found!.tx_pos).toBe(1); // at a NON-ZERO vout
    expect(JSON.stringify(found!.refs || [])).toContain(reverseRef(refLE).slice(0, 16));

    // ── cancel built against vout 0 (the OLD hardcode) must be REJECTED ──────
    // vout 0 is the dummy p2pkh (no ref); rebuilding the NFT at the main address
    // has no input carrying the ref → consensus rejects.
    const cancelOut: UnfinalizedOutput = {
      script: nftScript(main.address, refLE),
      value: 1,
    };
    {
      const wrongInput = {
        txid: moveTxid,
        vout: 0,
        value: 1000,
        script: p2pkhScript(main.address),
      };
      const fund0 = fundTx(main.address, await rxdCoins(main.address), [wrongInput as any], [cancelOut], p2pkhScript(main.address), FEE_RATE);
      const bad = buildTx(
        main.address,
        [main.wif, ...fund0.funding.map(() => main.wif)],
        [wrongInput as Utxo, ...fund0.funding],
        [cancelOut, ...fund0.change],
        false
      );
      const r = await tryBroadcast(bad.toString());
      console.log("vout-0 cancel rejected:", !r.ok, r.ok ? "" : (r.err || "").slice(0, 90));
      expect(r.ok).toBe(false);
    }

    // ── cancel against the REAL vout 1, signed with the SWAP key, is ACCEPTED ─
    const nftInput: SelectableInput = {
      txid: moveTxid,
      vout: 1,
      value: 1,
      script: nftScript(swap.address, refLE),
      required: true,
    };
    const fund1 = fundTx(
      main.address,
      await rxdCoins(main.address),
      [nftInput],
      [cancelOut],
      p2pkhScript(main.address),
      FEE_RATE
    );
    if (!fund1.funded) throw new Error("cancel funding failed");
    const good = buildTx(
      main.address,
      // NFT input signed with the SWAP key; funding with the main key.
      [swap.wif, ...fund1.funding.map(() => main.wif)],
      [nftInput as Utxo, ...fund1.funding],
      [cancelOut, ...fund1.change],
      false
    );
    const cancelTxid = await broadcast(good.toString());
    await mine(1);
    console.log("vout-1 cancel accepted:", cancelTxid);

    // ── NFT is back at nftScript(mainAddress) ───────────────────────────────
    const backAtMain = await utxoByScript(nftScript(main.address, refLE));
    expect(backAtMain).toBeTruthy();
    expect(backAtMain!.txid).toBe(cancelTxid);
  },
  600_000
);
