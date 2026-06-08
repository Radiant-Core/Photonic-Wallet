/**
 * LIVE end-to-end proof that the RXinDexer indexer makes covenant-held tokens
 * discoverable under the SAME owner-stable scripthash that
 * `discoverCovenants()` (packages/app/src/covenant.ts) computes.
 *
 * This closes the last gap: the app `discoverCovenants` unit test proves the
 * adopt/verify logic with mocks; this proves the indexer actually returns the
 * covenant UTXO when queried with `scriptHash(soulboundNftScript(owner, ZERO))`
 * / `scriptHash(authorityGatedNftScript(owner, ZERO, ZERO))` — i.e. RXinDexer's
 * generic `zero_refs()` collapses each covenant template to one owner scripthash.
 *
 * Requires the local regtest stack: radiantd RPC 127.0.0.1:17443 + RXinDexer
 * ElectrumX TCP 127.0.0.1:50010 (synced to that node). Enable with REGTEST_E2E:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/covenantDiscovery.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import net from "node:net";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { buildTx } from "../tx";
import { fundTx, SelectableInput } from "../coinSelect";
import { nftScript, p2pkhScript, parseNftScript, scriptHash } from "../script";
import { soulboundNftScript } from "../soulbound";
import { authorityGatedNftScript } from "../authority";
import { GLYPH_NFT } from "../protocols";
import { Utxo, SmartTokenPayload } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks } = rjs as any;

const RPC_URL = "http://127.0.0.1:17443/";
const RPC_USER = "radiantrpc";
const RPC_PASS = "613c41227c677d8bc90f5729f93604a7";
const ELX_HOST = "127.0.0.1";
const ELX_PORT = 50010;
const FEE_RATE = 10_000;
const PHOTONS = 100_000_000;
const ZERO_REF = "00".repeat(36);

let rpcId = 0;
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64"),
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: rpcId++, method, params }),
  });
  const json = (await res.json()) as { result: T; error: unknown };
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

// Newline-delimited ElectrumX TCP JSON-RPC (one request/socket), same as
// nftReceive.regtest.test.ts.
async function elx<T = unknown>(method: string, params: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const sock = net.connect(ELX_PORT, ELX_HOST, () => {
      sock.write(JSON.stringify({ id: 1, method, params }) + "\n");
    });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`ELX ${method} timeout`));
    }, 10_000);
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        sock.end();
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          if (msg.error) reject(new Error(`ELX ${method}: ${JSON.stringify(msg.error)}`));
          else resolve(msg.result as T);
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", reject);
  });
}
type ElxUtxo = { tx_hash: string; tx_pos: number; height: number; value: number };
const listUnspent = (sh: string) =>
  elx<ElxUtxo[]>("blockchain.scripthash.listunspent", [sh]);
async function waitUnspent(sh: string, want: number, tries = 25): Promise<ElxUtxo[]> {
  let last: ElxUtxo[] = [];
  for (let i = 0; i < tries; i++) {
    last = await listUnspent(sh).catch(() => [] as ElxUtxo[]);
    if (last.length >= want) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
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
    .map((u) => ({ txid: u.txid, vout: u.vout, script: u.scriptPubKey, value: Math.round(u.amount * PHOTONS) }))
    .filter((u) => u.value > 1);
}
async function utxoByScript(scriptHex: string): Promise<Utxo | null> {
  const u = (await scanUnspents(`raw(${scriptHex})`))[0];
  return u ? { txid: u.txid, vout: u.vout, script: scriptHex, value: Math.round(u.amount * PHOTONS) } : null;
}
function moveNft(coins: SelectableInput[], nft: Utxo, addr: string, wif: string, dest: string) {
  const fund = fundTx(addr, coins, [nft], [{ script: dest, value: 1 }], p2pkhScript(addr), FEE_RATE);
  if (!fund.funded) throw new Error("moveNft funding failed");
  return buildTx(addr, wif, [nft, ...fund.funding], [{ script: dest, value: 1 }, ...fund.change], false);
}
async function mintNft(key: Key, name: string): Promise<{ refLE: string; utxo: Utxo }> {
  const res = mintToken(
    "nft",
    { method: "direct", params: { address: key.address }, value: 1 },
    key.wif,
    (await rxdCoins(key.address)) as Utxo[],
    { p: [GLYPH_NFT], name } as unknown as SmartTokenPayload,
    [],
    FEE_RATE
  );
  await broadcast(res.commitTx.toString());
  await broadcast(res.revealTx.toString());
  await mine(1);
  const refLE = parseNftScript(res.revealTx.outputs[0].script.toHex()).ref as string;
  return { refLE, utxo: (await utxoByScript(nftScript(key.address, refLE))) as Utxo };
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "indexer indexes soulbound + authority covenants under the owner-stable scripthash discoverCovenants() uses",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");

    // ── SOULBOUND ──────────────────────────────────────────────────────────
    const owner = newKey();
    await fund(owner.address, 100);
    const sb = await mintNft(owner, "Discovery Soulbound");
    const soulScript = soulboundNftScript(owner.address, sb.refLE);
    await broadcast(
      moveNft(await rxdCoins(owner.address), sb.utxo, owner.address, owner.wif, soulScript).toString()
    );
    await mine(1);

    // The exact scripthash discoverCovenants() computes for this owner.
    const soulOwnerHash = scriptHash(soulboundNftScript(owner.address, ZERO_REF));
    const found = await waitUnspent(soulOwnerHash, 1);
    console.log("SOULBOUND: indexer listunspent(owner-stable hash) =>", found.length, found[0]);
    expect(found.length).toBe(1);
    // It is the soulbound UTXO we created.
    const live = await utxoByScript(soulScript);
    expect(found[0].tx_hash).toBe(live!.txid);
    expect(found[0].tx_pos).toBe(live!.vout);

    // And it is NOT under the plain nftScript scripthash anymore (it moved into
    // the covenant) — i.e. the per-template owner scripthash is the right target.
    const plainHash = scriptHash(nftScript(owner.address, ZERO_REF));
    const plain = await listUnspent(plainHash).catch(() => [] as ElxUtxo[]);
    expect(plain.some((u) => u.tx_hash === live!.txid && u.tx_pos === live!.vout)).toBe(false);
    console.log("SOULBOUND OK — discoverable by owner-stable covenant scripthash, not the plain one");

    // ── AUTHORITY-GATED ────────────────────────────────────────────────────
    const issuer = newKey();
    await fund(issuer.address, 100);
    const auth = await mintNft(issuer, "Discovery Authority");
    const item = await mintNft(issuer, "Discovery Gated Item");
    const gated = authorityGatedNftScript(issuer.address, item.refLE, auth.refLE);
    // Minting a gated output requires the authority token in the inputs.
    {
      const inputs = [item.utxo, auth.utxo];
      const outputs = [
        { script: gated, value: 1 },
        { script: nftScript(issuer.address, auth.refLE), value: 1 },
      ];
      const f = fundTx(issuer.address, await rxdCoins(issuer.address), inputs, outputs, p2pkhScript(issuer.address), FEE_RATE);
      expect(f.funded).toBe(true);
      await broadcast(
        buildTx(issuer.address, issuer.wif, [...inputs, ...f.funding], [...outputs, ...f.change], false).toString()
      );
      await mine(1);
    }
    const authOwnerHash = scriptHash(authorityGatedNftScript(issuer.address, ZERO_REF, ZERO_REF));
    const gatedFound = await waitUnspent(authOwnerHash, 1);
    console.log("AUTHORITY: indexer listunspent(owner-stable hash) =>", gatedFound.length, gatedFound[0]);
    const liveGated = await utxoByScript(gated);
    expect(gatedFound.some((u) => u.tx_hash === liveGated!.txid && u.tx_pos === liveGated!.vout)).toBe(true);
    console.log("AUTHORITY OK — gated item discoverable by owner-stable covenant scripthash");

    console.log("=== COVENANT DISCOVERY (LIVE INDEXER) PASSED ===");
  },
  600_000
);
