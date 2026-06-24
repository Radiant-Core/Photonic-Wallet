/**
 * End-to-end proof, against the LIVE regtest RXinDexer, of the syncCovenants
 * fix: a royalty *listing* covenant is indexed under its zero_refs scripthash,
 * NOT the raw-script scripthash. The wallet's syncCovenants used to look it up
 * by the raw hash → listunspent returned [] → every fresh listing was wrongly
 * marked RESOLVED (vanished from the Royalty market, NFT shown owned again).
 *
 * This drives the real path: mint an NFT on regtest, move it into the royalty
 * covenant, confirm it, wait for the indexer to catch up, then ask the indexer's
 * `blockchain.scripthash.listunspent` under BOTH hashes and assert:
 *   - scriptHash(rawScript)           → does NOT surface the covenant (the bug)
 *   - scriptHash(zeroRefs(rawScript)) → DOES surface it (the fix)
 *
 * Requires the local regtest stack: radiantd RPC 127.0.0.1:17443 + RXinDexer
 * electrum TCP 127.0.0.1:50010. Gated behind REGTEST_E2E=1.
 *   REGTEST_E2E=1 npx vitest run \
 *     src/__tests__/royaltyListingScripthash.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import net from "node:net";
import { Buffer } from "buffer";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { SelectableInput } from "../coinSelect";
import {
  nftScript,
  p2pkhScript,
  parseNftScript,
  scriptHash,
  zeroRefs,
} from "../script";
import {
  buildRoyaltyListingTx,
  royaltySaleScript,
  RoyaltySaleTerms,
} from "../royaltyCovenant";
import { GLYPH_NFT } from "../protocols";
import { Utxo, SmartTokenPayload } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks } = rjs as any;

const RPC_URL = "http://127.0.0.1:17443/";
const RPC_USER = "radiantrpc";
const RPC_PASS = "613c41227c677d8bc90f5729f93604a7";
const ELECTRUM_HOST = "127.0.0.1";
const ELECTRUM_PORT = 50010;
const FEE_RATE = 10_000;
const PHOTONS = 100_000_000;

let rpcId = 0;
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization:
        "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64"),
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: rpcId++, method, params }),
  });
  const json = (await res.json()) as { result: T; error: unknown };
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

type Key = { wif: string; address: string };
function newKey(): Key {
  const pk = PrivateKey.fromRandom(Networks.regtest);
  return { wif: pk.toWIF(), address: pk.toAddress(Networks.regtest).toString() };
}
let MINE_ADDR = "";
const mine = (n = 1) => rpc("generatetoaddress", [n, MINE_ADDR]);
async function fund(address: string, rxd: number) {
  await rpc("sendtoaddress", [address, rxd]);
  await mine(1);
}
const broadcast = (hex: string) => rpc<string>("sendrawtransaction", [hex]);

type Unspent = { txid: string; vout: number; scriptPubKey: string; amount: number };
async function scanUnspents(desc: string): Promise<Unspent[]> {
  const r = await rpc<{ unspents: Unspent[] }>("scantxoutset", ["start", [{ desc }]]);
  return r.unspents || [];
}
async function rxdCoins(address: string): Promise<SelectableInput[]> {
  return (await scanUnspents(`addr(${address})`))
    .map((u) => ({
      txid: u.txid,
      vout: u.vout,
      script: u.scriptPubKey,
      value: Math.round(u.amount * PHOTONS),
    }))
    .filter((u) => u.value > 1);
}
async function utxoByScript(scriptHex: string): Promise<Utxo | null> {
  const u = (await scanUnspents(`raw(${scriptHex})`))[0];
  return u
    ? { txid: u.txid, vout: u.vout, script: scriptHex, value: Math.round(u.amount * PHOTONS) }
    : null;
}

// ── Minimal newline-delimited JSON-RPC electrum client ──────────────────────
type ElectrumUnspent = { tx_hash: string; tx_pos: number; height: number; value: number };
function electrumCall<T>(method: string, params: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const sock = net.connect(ELECTRUM_PORT, ELECTRUM_HOST);
    let buf = "";
    let id = 1;
    const pending = new Map<number, (v: any) => void>();
    const send = (m: string, p: unknown[]) => {
      const reqId = id++;
      return new Promise<any>((res) => {
        pending.set(reqId, res);
        sock.write(JSON.stringify({ id: reqId, method: m, params: p }) + "\n");
      });
    };
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
        await send("server.version", ["royalty-e2e", "1.4"]);
        const result = (await send(method, params)) as T;
        sock.end();
        resolve(result);
      } catch (e) {
        sock.end();
        reject(e as Error);
      }
    })();
  });
}
const listUnspent = (hash: string) =>
  electrumCall<ElectrumUnspent[]>("blockchain.scripthash.listunspent", [hash]);
const indexerHeight = () =>
  electrumCall<{ height: number }>("blockchain.headers.subscribe", []).then((r) => r.height);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForIndexer(target: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await indexerHeight().catch(() => -1);
    if (h >= target) return h;
    if (Date.now() > deadline) throw new Error(`indexer stuck at ${h}, want ${target}`);
    await sleep(1500);
  }
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "royalty listing is indexed under its zero_refs scripthash, not the raw hash",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const seller = newKey();
    const creator = newKey();
    await fund(seller.address, 100);

    // ── mint NFT to seller ──────────────────────────────────────────────────
    const payload = { p: [GLYPH_NFT], name: "Royalty Scripthash E2E" } as unknown as SmartTokenPayload;
    const mintRes = mintToken(
      "nft",
      { method: "direct", params: { address: seller.address }, value: 1 },
      seller.wif,
      (await rxdCoins(seller.address)) as Utxo[],
      payload,
      [],
      FEE_RATE
    );
    await broadcast(mintRes.commitTx.toString());
    await broadcast(mintRes.revealTx.toString());
    await mine(1);
    const refLE = parseNftScript(mintRes.revealTx.outputs[0].script.toHex()).ref as string;
    expect(refLE).toBeTruthy();
    const nftAtSeller = await utxoByScript(nftScript(seller.address, refLE));
    expect(nftAtSeller).toBeTruthy();

    // ── list: move the NFT into the royalty sale covenant ───────────────────
    const terms: RoyaltySaleTerms = {
      ref: refLE,
      sellerAddress: seller.address,
      sellerScript: p2pkhScript(seller.address),
      price: 10 * PHOTONS,
      royalties: [{ script: p2pkhScript(creator.address), value: 1 * PHOTONS }],
    };
    const { tx: listTx, covenantScript } = buildRoyaltyListingTx({
      sellerAddress: seller.address,
      sellerWif: seller.wif,
      rxdCoins: await rxdCoins(seller.address),
      nftUtxo: nftAtSeller as Utxo,
      terms,
      feeRate: FEE_RATE,
    });
    expect(covenantScript).toBe(royaltySaleScript(terms));
    const listTxid = await broadcast(listTx.toString());
    await mine(1);
    const nodeHeight = await rpc<number>("getblockcount");

    // The covenant UTXO the wallet records (vout 0) and tracks via syncCovenants.
    const covOutpoint = { tx_hash: listTxid, tx_pos: 0 };
    console.log("LIST OK — covenant UTXO", `${listTxid}:0`, "@height", nodeHeight);

    // ── wait for the indexer to catch up to the list block ──────────────────
    await waitForIndexer(nodeHeight);

    const rawHash = scriptHash(covenantScript); // what the OLD syncCovenants used
    const zeroHash = scriptHash(zeroRefs(covenantScript)); // what the FIX uses
    expect(rawHash).not.toBe(zeroHash); // covenant has a checksig + ref operand

    const rawUtxos = await listUnspent(rawHash);
    const zeroUtxos = await listUnspent(zeroHash);
    const inRaw = rawUtxos.some((u) => u.tx_hash === covOutpoint.tx_hash && u.tx_pos === covOutpoint.tx_pos);
    const inZero = zeroUtxos.some((u) => u.tx_hash === covOutpoint.tx_hash && u.tx_pos === covOutpoint.tx_pos);
    console.log("raw-hash listunspent:", rawUtxos.length, "found covenant:", inRaw);
    console.log("zeroRefs-hash listunspent:", zeroUtxos.length, "found covenant:", inZero);

    // The bug: the raw-script hash the old code used does NOT surface the listing.
    expect(inRaw).toBe(false);
    // The fix: the zero_refs hash (the indexer's actual key) DOES surface it →
    // syncCovenants now sees the UTXO as live and keeps the listing ACTIVE.
    expect(inZero).toBe(true);
  },
  600_000
);
