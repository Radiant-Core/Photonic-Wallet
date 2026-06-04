/**
 * On-chain regtest verification that UNCONFIRMED (mempool) receives are
 * discoverable by the wallet — i.e. a token shows up as "pending" before the
 * block confirms, not only after.
 *
 * The wallet discovers receives via
 *   blockchain.scripthash.listunspent( <owner scripthash> )
 * and (for NFT/FT) rebuilds the output script from each utxo's `refs`. For this
 * to surface a mempool receive, the indexer must, for unconfirmed outputs:
 *   1. key the utxo under the owner's zero-ref scripthash (so the owner query
 *      finds it), and
 *   2. populate `refs` (so the wallet can rebuild the contract script).
 *
 * This proves both, for RXD and NFT. Note: ElectrumX refreshes its mempool view
 * on an interval (~seconds), so the assertion polls — a too-fast query returns
 * empty simply because the indexer hasn't ingested the mempool tx yet.
 *
 * Requires the local regtest stack: radiantd RPC 127.0.0.1:17443 +
 * RXinDexer ElectrumX TCP 127.0.0.1:50010. Enable with REGTEST_E2E:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/mempoolReceive.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import net from "node:net";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { transferNonFungible } from "../transfer";
import { SelectableInput } from "../coinSelect";
import {
  nftScript,
  nftScriptHash,
  p2pkhScriptHash,
  parseNftScript,
} from "../script";
import { GLYPH_NFT } from "../protocols";
import { Utxo, SmartTokenPayload } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks } = rjs as any;

const RPC_URL = "http://127.0.0.1:17443/";
const RPC_USER = "radiantrpc";
const RPC_PASS = "613c41227c677d8bc90f5729f93604a7";
const FEE_RATE = 10_000;
const PHOTONS = 100_000_000;

let rpcId = 0;
async function rpc<T = any>(method: string, params: any[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      authorization:
        "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64"),
    },
    body: JSON.stringify({ id: rpcId++, method, params }),
  });
  const j = (await res.json()) as any;
  if (j.error) throw new Error(`RPC ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

type ElxUtxo = {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
  refs?: { ref: string; type: string }[];
};
function elx<T = any>(method: string, params: any[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = net.connect(50010, "127.0.0.1", () =>
      s.write(JSON.stringify({ id: 1, method, params }) + "\n")
    );
    let b = "";
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error(method + " timeout"));
    }, 15000);
    s.on("data", (d) => {
      b += d.toString();
      const n = b.indexOf("\n");
      if (n >= 0) {
        clearTimeout(t);
        s.end();
        const j = JSON.parse(b.slice(0, n));
        j.error
          ? reject(new Error(JSON.stringify(j.error)))
          : resolve(j.result);
      }
    });
    s.on("error", reject);
  });
}
// Poll listunspent until non-empty (mempool ingest is interval-driven).
async function waitUnspent(sh: string, tries = 20): Promise<ElxUtxo[]> {
  for (let i = 0; i < tries; i++) {
    const lu = await elx<ElxUtxo[]>("blockchain.scripthash.listunspent", [
      sh,
    ]).catch(() => [] as ElxUtxo[]);
    if (lu.length) return lu;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
}

const newKey = () => {
  const pk = PrivateKey.fromRandom(Networks.regtest);
  return {
    wif: pk.toWIF(),
    address: pk.toAddress(Networks.regtest).toString(),
  };
};
let MINE = "";
const mine = (n = 1) => rpc("generatetoaddress", [n, MINE]);
async function rxdCoins(a: string): Promise<SelectableInput[]> {
  const r = await rpc("scantxoutset", ["start", [{ desc: `addr(${a})` }]]);
  return (r.unspents || [])
    .map((u: any) => ({
      txid: u.txid,
      vout: u.vout,
      script: u.scriptPubKey,
      value: Math.round(u.amount * PHOTONS),
    }))
    .filter((u: any) => u.value > 1);
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "unconfirmed RXD receive is visible under the owner scripthash (height 0)",
  async () => {
    MINE = await rpc("getnewaddress");
    const B = newKey();
    const txid = await rpc("sendtoaddress", [B.address, 4]); // NO mine
    console.log("unconfirmed RXD send", txid);
    const lu = await waitUnspent(p2pkhScriptHash(B.address));
    console.log("RXD listunspent (pre-mine):", JSON.stringify(lu));
    expect(lu.length).toBe(1);
    expect(lu[0].height).toBe(0); // unconfirmed -> wallet stores as Infinity
    expect(lu[0].value).toBe(4 * PHOTONS);
  },
  600_000
);

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "unconfirmed NFT receive is visible under the owner scripthash WITH refs",
  async () => {
    MINE = await rpc("getnewaddress");
    const A = newKey();
    const B = newKey();
    await rpc("sendtoaddress", [A.address, 100]);
    await mine(1);

    // Mint an NFT to A (confirmed).
    const mintRes = mintToken(
      "nft",
      { method: "direct", params: { address: A.address }, value: 1 },
      A.wif,
      (await rxdCoins(A.address)) as Utxo[],
      { p: [GLYPH_NFT], name: "Mempool Recv" } as unknown as SmartTokenPayload,
      [],
      FEE_RATE
    );
    await rpc("sendrawtransaction", [mintRes.commitTx.toString()]);
    await rpc("sendrawtransaction", [mintRes.revealTx.toString()]);
    await mine(1);
    const refLE = parseNftScript(mintRes.revealTx.outputs[0].script.toHex())
      .ref as string;

    // Transfer A -> B, leave UNCONFIRMED (no mine).
    const sc = nftScript(A.address, refLE);
    const scan = await rpc("scantxoutset", ["start", [{ desc: `raw(${sc})` }]]);
    const u = scan.unspents[0];
    const { tx } = transferNonFungible(
      await rxdCoins(A.address),
      {
        txid: u.txid,
        vout: u.vout,
        script: sc,
        value: Math.round(u.amount * PHOTONS),
      } as Utxo,
      refLE,
      A.address,
      B.address,
      FEE_RATE,
      A.wif
    );
    const txid = await rpc("sendrawtransaction", [tx.toString()]);
    console.log("unconfirmed NFT transfer", txid);

    // The receiving wallet's discovery query — must return the NFT with refs.
    const lu = await waitUnspent(nftScriptHash(B.address));
    console.log("NFT listunspent (pre-mine):", JSON.stringify(lu));
    expect(lu.length).toBe(1);
    expect(lu[0].height).toBe(0); // unconfirmed -> wallet renders as pending
    // refs must be populated so the wallet can rebuild nftScript(B, ref).
    expect(lu[0].refs && lu[0].refs.length).toBeTruthy();
    expect(lu[0].refs![0].type).toBe("single");
  },
  600_000
);
