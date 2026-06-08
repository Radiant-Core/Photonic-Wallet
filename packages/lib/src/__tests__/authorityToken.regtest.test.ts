/**
 * End-to-end proof that the NFT-creation flow's "Authority token" output is a
 * real, recognised authority token.
 *
 * Mints an NFT with the EXACT payload shape Mint.tsx now produces when the
 * "Make this an Authority token" toggle is on — `p:[GLYPH_NFT, GLYPH_AUTHORITY]`
 * plus `attrs:{ issuer, ... }` — then confirms:
 *   1. it confirms on-chain (a plain mint; no special permission needed),
 *   2. the on-chain reveal decodes back with GLYPH_AUTHORITY + issuer (so the
 *      wallet classifies it as an authority and lists it under "Authority
 *      gating"), and
 *   3. verifyAuthorityChain accepts an item that references it as its issuer.
 *
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/authorityToken.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { hexToBytes } from "@noble/hashes/utils";
import { mintToken } from "../mint";
import { decodeGlyph } from "../token";
import { parseNftScript } from "../script";
import { reverseRef } from "../Outpoint";
import { verifyAuthorityChain, AuthorityCandidate } from "../authority";
import { GLYPH_NFT, GLYPH_AUTHORITY } from "../protocols";
import { GlyphV2Metadata } from "../v2metadata";
import { Utxo, SmartTokenPayload } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks } = rjs as any;

const RPC_URL = "http://127.0.0.1:17443/";
const RPC_USER = "radiantrpc";
const RPC_PASS = "613c41227c677d8bc90f5729f93604a7";
const FEE_RATE = 10_000;
const PHOTONS = 100_000_000;

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
async function rxdCoins(address: string): Promise<Utxo[]> {
  const r = await rpc<{ unspents: Unspent[] }>("scantxoutset", ["start", [{ desc: `addr(${address})` }]]);
  return (r.unspents || [])
    .map((u) => ({ txid: u.txid, vout: u.vout, script: u.scriptPubKey, value: Math.round(u.amount * PHOTONS) }))
    .filter((u) => u.value > 1);
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "authority token minted via the NFT flow decodes as AUTHORITY and verifies an issued item",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const issuer = newKey();
    await fund(issuer.address, 100);

    // Exactly what Mint.tsx assembles for an Authority token.
    const payload = {
      p: [GLYPH_NFT, GLYPH_AUTHORITY],
      name: "My Collection Authority",
      attrs: {
        issuer: issuer.address,
        scope: "my-collection",
        permissions: ["mint"],
        revocable: true,
      },
    } as unknown as SmartTokenPayload;

    const res = mintToken(
      "nft",
      { method: "direct", params: { address: issuer.address }, value: 1 },
      issuer.wif,
      await rxdCoins(issuer.address),
      payload,
      [],
      FEE_RATE
    );
    await broadcast(res.commitTx.toString());
    const revealId = await broadcast(res.revealTx.toString());
    await mine(1);
    const conf = await rpc<{ confirmations?: number }>("getrawtransaction", [revealId, true]);
    expect((conf.confirmations || 0) >= 1).toBe(true);

    const refLE = parseNftScript(res.revealTx.outputs[0].script.toHex()).ref as string;
    const authorityRefBE = reverseRef(refLE);

    // (2) Decode the reveal payload exactly as the wallet does → it's an authority.
    const decoded = decodeGlyph(res.revealTx.inputs[0].script);
    expect(decoded).toBeTruthy();
    const meta = decoded!.payload as unknown as GlyphV2Metadata;
    expect(meta.p).toContain(GLYPH_AUTHORITY);
    expect(meta.p).toContain(GLYPH_NFT);
    expect((meta.attrs as { issuer?: string }).issuer).toBe(issuer.address);
    console.log("AUTHORITY token decoded on-chain:", meta.name, "p=", meta.p);

    // (3) An item that references this authority verifies; a forged one does not.
    const item = {
      v: 2,
      p: [GLYPH_NFT],
      name: "Collection Item #1",
      by: [hexToBytes(refLE)], // issuer ref, LE bytes (as the mint encodes `by`)
    } as unknown as GlyphV2Metadata;
    const candidate: AuthorityCandidate = { ref: authorityRefBE, metadata: meta };

    expect(verifyAuthorityChain(item, [candidate]).valid).toBe(true);

    const forged = {
      v: 2,
      p: [GLYPH_NFT],
      by: [hexToBytes("ee".repeat(32) + "00000000")],
    } as unknown as GlyphV2Metadata;
    expect(verifyAuthorityChain(forged, [candidate]).valid).toBe(false);

    console.log("=== AUTHORITY TOKEN (NFT FLOW) E2E PASSED ===");
  },
  600_000
);
