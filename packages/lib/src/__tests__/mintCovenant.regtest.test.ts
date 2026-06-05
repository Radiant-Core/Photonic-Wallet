/**
 * On-chain regtest proof for the NEW mint-time covenant emission in
 * mint.ts `createRevealOutputs` / `mintToken` (the app-side integration step).
 *
 * The existing soulbound.regtest / authority.regtest tests prove the *scripts*
 * by minting a plain NFT and then moving/locking it. This test proves the
 * *emission path*: that `mintToken(..., covenant)` directly produces a valid,
 * broadcastable commit+reveal that locks the freshly minted NFT into the
 * covenant in one shot — which is what the wallet does from Mint.tsx.
 *
 *   - SOULBOUND mint: the reveal output rests in soulboundNftScript(owner, ref),
 *     not the plain nftScript. Accepted on-chain.
 *   - AUTHORITY-GATED mint: co-spending the genuine authority token, the reveal
 *     output rests in authorityGatedNftScript and the authority token is
 *     preserved. Accepted on-chain.
 *
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/mintCovenant.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { fundTx, SelectableInput } from "../coinSelect";
import { nftScript, p2pkhScript, parseNftScript } from "../script";
import { soulboundNftScript, parseSoulboundRef } from "../soulbound";
import { authorityGatedNftScript } from "../authority";
import { GLYPH_NFT } from "../protocols";
import Outpoint from "../Outpoint";
import { Utxo, SmartTokenPayload } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks } = rjs as any;

const RPC_URL = "http://127.0.0.1:17443/";
const RPC_USER = "radiantrpc";
const RPC_PASS = "613c41227c677d8bc90f5729f93604a7";
const FEE_RATE = 10_000;
const PHOTONS = 100_000_000;

let rpcId = 0;
async function rpc<T = unknown>(
  method: string,
  params: unknown[] = []
): Promise<T> {
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
  if (json.error)
    throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}
type Key = { wif: string; address: string };
function newKey(): Key {
  const pk = PrivateKey.fromRandom(Networks.regtest);
  return {
    wif: pk.toWIF(),
    address: pk.toAddress(Networks.regtest).toString(),
  };
}
let MINE_ADDR = "";
const mine = (n = 1) => rpc("generatetoaddress", [n, MINE_ADDR]);
async function fund(address: string, rxd: number) {
  await rpc("sendtoaddress", [address, rxd]);
  await mine(1);
}
const broadcast = (hex: string) => rpc<string>("sendrawtransaction", [hex]);
async function tryBroadcast(
  hex: string
): Promise<{ ok: boolean; err?: string }> {
  try {
    await broadcast(hex);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}
type Unspent = {
  txid: string;
  vout: number;
  scriptPubKey: string;
  amount: number;
};
async function scanUnspents(desc: string): Promise<Unspent[]> {
  const r = await rpc<{ unspents: Unspent[] }>("scantxoutset", [
    "start",
    [{ desc }],
  ]);
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
    ? {
        txid: u.txid,
        vout: u.vout,
        script: scriptHex,
        value: Math.round(u.amount * PHOTONS),
      }
    : null;
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "mint emission: soulbound and authority-gated NFTs are minted directly into their covenants",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const owner = newKey();
    await fund(owner.address, 100);

    // ---- SOULBOUND: mint directly into the soulbound covenant ---------------
    {
      const res = mintToken(
        "nft",
        { method: "direct", params: { address: owner.address }, value: 1 },
        owner.wif,
        (await rxdCoins(owner.address)) as Utxo[],
        {
          p: [GLYPH_NFT],
          name: "Soulbound (minted)",
        } as unknown as SmartTokenPayload,
        [],
        FEE_RATE,
        undefined,
        { soulbound: true }
      );
      const c = await tryBroadcast(res.commitTx.toString());
      expect(c.ok).toBe(true);
      const r = await tryBroadcast(res.revealTx.toString());
      console.log("SOULBOUND mint accepted:", r.ok, r.err?.slice(0, 160));
      expect(r.ok).toBe(true);
      await mine(1);

      const refLE = Outpoint.fromUTXO(res.commitTx.id, 0).reverse().toString();
      // The reveal's NFT output is the soulbound covenant, not plain nftScript.
      const soul = soulboundNftScript(owner.address, refLE);
      expect(parseSoulboundRef(res.revealTx.outputs[0].script.toHex())).toBe(
        refLE
      );
      expect(await utxoByScript(soul)).toBeTruthy();
      expect(await utxoByScript(nftScript(owner.address, refLE))).toBeNull();
      console.log(
        "SOULBOUND OK — NFT rests in the soulbound covenant, not plain nftScript"
      );
    }

    // ---- AUTHORITY-GATED: mint a gated item co-spending the authority -------
    {
      // 1) mint a plain authority token
      const authRes = mintToken(
        "nft",
        { method: "direct", params: { address: owner.address }, value: 1 },
        owner.wif,
        (await rxdCoins(owner.address)) as Utxo[],
        {
          p: [GLYPH_NFT],
          name: "Collection Authority",
        } as unknown as SmartTokenPayload,
        [],
        FEE_RATE
      );
      await broadcast(authRes.commitTx.toString());
      await broadcast(authRes.revealTx.toString());
      await mine(1);
      const authRefLE = parseNftScript(
        authRes.revealTx.outputs[0].script.toHex()
      ).ref as string;
      const authUtxo = (await utxoByScript(
        nftScript(owner.address, authRefLE)
      )) as Utxo;
      expect(authUtxo).toBeTruthy();

      // 2) mint the gated item, co-spending the authority token
      const itemRes = mintToken(
        "nft",
        { method: "direct", params: { address: owner.address }, value: 1 },
        owner.wif,
        (await rxdCoins(owner.address)) as Utxo[],
        {
          p: [GLYPH_NFT],
          name: "Gated Item (minted)",
        } as unknown as SmartTokenPayload,
        [],
        FEE_RATE,
        undefined,
        { authority: { ref: authRefLE, utxo: authUtxo } }
      );
      await broadcast(itemRes.commitTx.toString());
      const r = await tryBroadcast(itemRes.revealTx.toString());
      console.log("AUTHORITY-GATED mint accepted:", r.ok, r.err?.slice(0, 200));
      expect(r.ok).toBe(true);
      await mine(1);

      const itemRefLE = Outpoint.fromUTXO(itemRes.commitTx.id, 0)
        .reverse()
        .toString();
      const gated = authorityGatedNftScript(
        owner.address,
        itemRefLE,
        authRefLE
      );
      expect(await utxoByScript(gated)).toBeTruthy();
      // The authority token survived (re-created as an output).
      expect(
        await utxoByScript(nftScript(owner.address, authRefLE))
      ).toBeTruthy();
      console.log(
        "AUTHORITY-GATED OK — gated item minted; authority token preserved"
      );
    }

    console.log("=== MINT COVENANT EMISSION REGTEST PASSED ===");
  },
  600_000
);
