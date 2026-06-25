/**
 * On-chain proof (live regtest) for the dual-coin-type swap recovery fix.
 *
 * A coin-type-resolution mismatch can move a swap-listed NFT to the OTHER coin
 * type's swap address (`m/44'/<other>'/0'/0/1`) while the wallet's main/spend
 * keys stay on its resolved coin type. The fix derives the swap (address, key)
 * for BOTH coin types from the one seed, finds the reserve at whichever address
 * holds it, and cancels it back to the (resolved coin type's) main address.
 *
 * This drives the real chain with ONE mnemonic:
 *   - wallet "is" coin type 0: main = deriveAccount(hd, 0).address
 *   - the NFT got stranded at coin type 512's swap address (the bug)
 *   - assert the indexer lists it at nftScriptHash(swap512) and NOT at swap0
 *   - cancel it: spend swap512's UTXO signed with swap512's key, funded by main0,
 *     output to nftScript(main0) — and assert the NFT returns to main0.
 *
 * Requires the regtest stack (radiantd 17443 + RXinDexer electrum 50010). Gated
 * behind REGTEST_E2E=1.
 */
import { it, expect } from "vitest";
import net from "node:net";
import { Buffer } from "buffer";
import { mnemonicToSeedSync, generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { mintToken } from "../mint";
import { buildTx } from "../tx";
import { fundTx, SelectableInput } from "../coinSelect";
import { deriveAccountFromHdKey } from "../wallet";
import { nftScript, nftScriptHash, p2pkhScript, parseNftScript } from "../script";
import { GLYPH_NFT } from "../protocols";
import { Utxo, UnfinalizedOutput, SmartTokenPayload } from "../types";

const RPC_URL = "http://127.0.0.1:17443/";
const AUTH = "Basic " + Buffer.from("radiantrpc:613c41227c677d8bc90f5729f93604a7").toString("base64");
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
let MINE_ADDR = "";
const mine = (n = 1) => rpc("generatetoaddress", [n, MINE_ADDR]);
async function rxdCoins(address: string): Promise<SelectableInput[]> {
  const r = await rpc<{ unspents: any[] }>("scantxoutset", ["start", [{ desc: `addr(${address})` }]]);
  return (r.unspents || [])
    .map((u) => ({ txid: u.txid, vout: u.vout, script: u.scriptPubKey, value: Math.round(u.amount * PHOTONS) }))
    .filter((u) => u.value > 1);
}
async function utxoByScript(scriptHex: string): Promise<Utxo | null> {
  const r = await rpc<{ unspents: any[] }>("scantxoutset", ["start", [{ desc: `raw(${scriptHex})` }]]);
  const u = (r.unspents || [])[0];
  return u ? { txid: u.txid, vout: u.vout, script: scriptHex, value: Math.round(u.amount * PHOTONS) } : null;
}
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
        try { msg = JSON.parse(line); } catch { continue; }
        const cb = pending.get(msg.id);
        if (cb) { pending.delete(msg.id); cb(msg.error ? Promise.reject(new Error(JSON.stringify(msg.error))) : msg.result); }
      }
    });
    (async () => {
      try {
        await send("server.version", ["cointype", "1.4"]);
        const r = (await send(method, params)) as T;
        sock.end();
        resolve(r);
      } catch (e) { sock.end(); reject(e as Error); }
    })();
  });
}
type ElUnspent = { tx_hash: string; tx_pos: number; refs?: { ref: string }[] };
const listUnspent = (sh: string) => electrumCall<ElUnspent[]>("blockchain.scripthash.listunspent", [sh]);
const indexerHeight = () => electrumCall<{ height: number }>("blockchain.headers.subscribe", []).then((r) => r.height);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForIndexer(target: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await indexerHeight().catch(() => -1);
    if (h >= target) return;
    if (Date.now() > deadline) throw new Error(`indexer stuck at ${h}`);
    await sleep(1500);
  }
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "NFT stranded at the other coin type's swap address is discoverable and cancellable with that coin type's key",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(generateMnemonic(wordlist)));
    // The wallet's resolved coin type is 0; the bug stranded the NFT at coin
    // type 512's swap address.
    const acct0 = deriveAccountFromHdKey(hd, "testnet" as any, 0);
    const acct512 = deriveAccountFromHdKey(hd, "testnet" as any, 512);
    const mainAddr = acct0.address; // wallet main (resolved coin type)
    const mainWif = (acct0.privKey as any).toWIF();
    const swap0 = acct0.swapAddress; // resolved coin type's swap address
    const swap512 = acct512.swapAddress; // the OTHER coin type's swap address
    const swap512Wif = (acct512.swapPrivKey as any).toWIF();
    expect(swap0).not.toBe(swap512); // distinct per coin type

    await rpc("sendtoaddress", [mainAddr, 100]);
    await mine(1);

    // mint an NFT to the wallet main
    const payload = { p: [GLYPH_NFT], name: "CoinType Strand" } as unknown as SmartTokenPayload;
    const m = mintToken(
      "nft",
      { method: "direct", params: { address: mainAddr }, value: 1 },
      mainWif,
      (await rxdCoins(mainAddr)) as Utxo[],
      payload,
      [],
      FEE_RATE
    );
    await broadcast(m.commitTx.toString());
    await broadcast(m.revealTx.toString());
    await mine(1);
    const refLE = parseNftScript(m.revealTx.outputs[0].script.toHex()).ref as string;
    const nftAtMain = await utxoByScript(nftScript(mainAddr, refLE));
    expect(nftAtMain).toBeTruthy();

    // BUG: list moves the NFT to coin type 512's swap address (output index 1)
    const dummy: UnfinalizedOutput = { script: p2pkhScript(mainAddr), value: 1000 };
    const nftToSwap512: UnfinalizedOutput = { script: nftScript(swap512, refLE), value: 1 };
    const mf = fundTx(mainAddr, await rxdCoins(mainAddr), [nftAtMain as Utxo], [dummy, nftToSwap512], p2pkhScript(mainAddr), FEE_RATE);
    if (!mf.funded) throw new Error("move funding failed");
    const moveTx = buildTx(mainAddr, mainWif, [nftAtMain as Utxo, ...mf.funding], [dummy, nftToSwap512, ...mf.change], false);
    const moveTxid = await broadcast(moveTx.toString());
    await mine(1);
    const height = await rpc<number>("getblockcount");
    await waitForIndexer(height);

    // the reserve is at swap512 (NOT swap0) — only a both-coin-type scan finds it
    const atSwap512 = (await listUnspent(nftScriptHash(swap512))).some((u) => u.tx_hash === moveTxid && u.tx_pos === 1);
    const atSwap0 = (await listUnspent(nftScriptHash(swap0))).some((u) => u.tx_hash === moveTxid);
    console.log("NFT at swap512:", atSwap512, "| at swap0:", atSwap0);
    expect(atSwap512).toBe(true);
    expect(atSwap0).toBe(false); // wallet.value.swapAddress (swap0) would miss it

    // CANCEL: spend swap512's reserve with swap512's key, funded by main0, back to main0
    const nftInput: SelectableInput = {
      txid: moveTxid, vout: 1, value: 1, script: nftScript(swap512, refLE), required: true,
    };
    const cancelOut: UnfinalizedOutput = { script: nftScript(mainAddr, refLE), value: 1 };
    const cf = fundTx(mainAddr, await rxdCoins(mainAddr), [nftInput], [cancelOut], p2pkhScript(mainAddr), FEE_RATE);
    if (!cf.funded) throw new Error("cancel funding failed");
    const cancelTx = buildTx(
      mainAddr,
      [swap512Wif, ...cf.funding.map(() => mainWif)],
      [nftInput as Utxo, ...cf.funding],
      [cancelOut, ...cf.change],
      false
    );
    const cancelTxid = await broadcast(cancelTx.toString());
    await mine(1);
    console.log("cancel accepted:", cancelTxid);

    const backAtMain = await utxoByScript(nftScript(mainAddr, refLE));
    expect(backAtMain).toBeTruthy();
    expect(backAtMain!.txid).toBe(cancelTxid);
  },
  600_000
);
