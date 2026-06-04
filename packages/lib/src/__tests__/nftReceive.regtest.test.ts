/**
 * On-chain regtest reproduction for "sent NFT doesn't show up in the receiving
 * wallet".
 *
 * The receiving wallet discovers NFTs by calling
 *   blockchain.scripthash.listunspent( nftScriptHash(address) )
 * where nftScriptHash(addr) = scriptHash(nftScript(addr, ZERO_REF)) — an
 * owner-only template. So the wallet ONLY sees a received NFT if the indexer
 * (RXinDexer/ElectrumX) indexes the transferred NFT output under the new
 * owner's zero-ref scripthash.
 *
 * This test mints an NFT to A, sends it to B, and asserts the ElectrumX
 * listunspent for B's NFT scripthash reports the NFT (and A's no longer does).
 * If B's stays empty, the bug is server-side (indexer), not the wallet.
 *
 * Requires the local regtest stack: radiantd RPC 127.0.0.1:17443 +
 * RXinDexer ElectrumX TCP 127.0.0.1:50010. Enable with REGTEST_E2E:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/nftReceive.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import net from "node:net";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { transferNonFungible } from "../transfer";
import { SelectableInput } from "../coinSelect";
import { nftScript, nftScriptHash, parseNftScript } from "../script";
import { reverseRef } from "../Outpoint";
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

// Minimal newline-delimited ElectrumX TCP JSON-RPC client (one request/socket).
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

// Poll listunspent until it reports `want` entries (indexer needs a beat after
// the block is mined). Returns the final list.
async function waitUnspent(sh: string, want: number, tries = 20): Promise<ElxUtxo[]> {
  let last: ElxUtxo[] = [];
  for (let i = 0; i < tries; i++) {
    last = await listUnspent(sh).catch(() => [] as ElxUtxo[]);
    if (last.length === want) return last;
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
async function fund(address: string, amt: number) {
  await rpc("sendtoaddress", [address, amt]);
  await mine(1);
}
const broadcast = (hex: string) => rpc<string>("sendrawtransaction", [hex]);
async function rxdCoins(address: string): Promise<SelectableInput[]> {
  const r = await rpc<{ unspents: { txid: string; vout: number; scriptPubKey: string; amount: number }[] }>(
    "scantxoutset",
    ["start", [{ desc: `addr(${address})` }]]
  );
  return (r.unspents || [])
    .map((u) => ({
      txid: u.txid,
      vout: u.vout,
      script: u.scriptPubKey,
      value: Math.round(u.amount * PHOTONS),
    }))
    .filter((u) => u.value > 1);
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "receiving wallet's NFT scripthash listunspent reports a transferred NFT",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const A = newKey();
    const B = newKey();
    await fund(A.address, 100);

    // Mint NFT to A.
    const payload = { p: [GLYPH_NFT], name: "Recv NFT" } as unknown as SmartTokenPayload;
    const mintRes = mintToken(
      "nft",
      { method: "direct", params: { address: A.address }, value: 1 },
      A.wif,
      (await rxdCoins(A.address)) as Utxo[],
      payload,
      [],
      FEE_RATE
    );
    await broadcast(mintRes.commitTx.toString());
    await broadcast(mintRes.revealTx.toString());
    await mine(1);
    const refLE = parseNftScript(mintRes.revealTx.outputs[0].script.toHex()).ref as string;
    console.log("minted NFT ref", reverseRef(refLE));

    // Sanity: the indexer reports the NFT under A's NFT scripthash (the wallet's
    // own-tokens view). This is the same listunspent the receiver uses.
    const aShBefore = await waitUnspent(nftScriptHash(A.address), 1);
    console.log("A NFT scripthash listunspent (after mint):", aShBefore.length);
    expect(aShBefore.length).toBe(1);

    // Transfer A -> B.
    const { tx } = transferNonFungible(
      await rxdCoins(A.address),
      { ...(await firstNftUtxo(A.address, refLE)) } as Utxo,
      refLE,
      A.address,
      B.address,
      FEE_RATE,
      A.wif
    );
    await broadcast(tx.toString());
    await mine(1);

    // The receiving wallet's discovery query.
    const bSh = nftScriptHash(B.address);
    const bUnspent = await waitUnspent(bSh, 1);
    const aShAfter = await listUnspent(nftScriptHash(A.address)).catch(() => []);
    console.log(
      "AFTER transfer -> B NFT scripthash listunspent:",
      bUnspent.length,
      "| A:",
      aShAfter.length
    );

    // The bug: B's NFT scripthash returns nothing, so the NFT never appears in
    // the receiving wallet.
    expect(bUnspent.length).toBe(1);
    expect(aShAfter.length).toBe(0);
  },
  600_000
);

// Helper: the on-chain NFT utxo at an address for a ref (via scantxoutset).
async function firstNftUtxo(address: string, refLE: string): Promise<Utxo> {
  const scriptHex = nftScript(address, refLE);
  const r = await rpc<{ unspents: { txid: string; vout: number; amount: number }[] }>(
    "scantxoutset",
    ["start", [{ desc: `raw(${scriptHex})` }]]
  );
  const u = (r.unspents || [])[0];
  if (!u) throw new Error("NFT utxo not found for A");
  return { txid: u.txid, vout: u.vout, script: scriptHex, value: Math.round(u.amount * PHOTONS) };
}
