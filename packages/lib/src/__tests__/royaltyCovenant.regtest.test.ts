/**
 * On-chain regtest proof for the unstrippable royalty *listing* covenant.
 *
 * Unlike the byte-asserting royalty.test.ts (which only greps the script hex
 * for opcode bytes and never runs the interpreter), this test BROADCASTS real
 * transactions against the local v3.0.0 radiantd script interpreter and asserts
 * acceptance/rejection. It proves:
 *
 *   - LIST:  an NFT can be moved from nftScript into royaltySaleScript (the ref
 *            is carried forward; the listing confirms).
 *   - BUY (valid): a completion paying the seller AND the royalty recipient the
 *            committed amounts is ACCEPTED.
 *   - STRIP: a completion that redirects the royalty to the buyer is REJECTED.
 *   - LOW:   a completion that underpays the royalty is REJECTED.
 *   - UNDERPAY: a completion that underpays the seller is REJECTED.
 *   - CANCEL: the seller can reclaim the listed NFT with their key.
 *
 * Requires the local regtest stack (radiantd RPC 127.0.0.1:17443). Skipped by
 * default; enable with REGTEST_E2E:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/royaltyCovenant.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { buildTx } from "../tx";
import { fundTx, SelectableInput } from "../coinSelect";
import { nftScript, p2pkhScript, parseNftScript } from "../script";
import {
  royaltySaleScript,
  RoyaltySaleTerms,
  ROYALTY_BUY_SCRIPTSIG,
  buildRoyaltyListingTx,
  buildRoyaltyPurchaseTx,
  buildRoyaltyCancelTx,
} from "../royaltyCovenant";
import { GLYPH_NFT } from "../protocols";
import { Utxo, UnfinalizedInput, UnfinalizedOutput, SmartTokenPayload } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
// radiantjs ships incomplete typings for Networks.regtest / PrivateKey.fromRandom;
// cast as any for the regtest harness (runtime is correct — see test output).
const { PrivateKey, Networks, Script } = rjs as any;

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
/** Broadcast and return {ok, err}; never throws so we can assert rejection. */
async function tryBroadcast(hex: string): Promise<{ ok: boolean; err?: string }> {
  try {
    await broadcast(hex);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}

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

// Build a buy-completion tx spending the covenant with a given output layout.
function buildBuy(
  buyer: Key,
  buyerCoins: SelectableInput[],
  covUtxo: Utxo,
  payloadOutputs: UnfinalizedOutput[]
) {
  const covInput: UnfinalizedInput = { ...covUtxo, scriptSigSize: 1 }; // OP_0
  const fund = fundTx(
    buyer.address,
    buyerCoins,
    [covInput],
    payloadOutputs,
    p2pkhScript(buyer.address),
    FEE_RATE
  );
  if (!fund.funded) throw new Error("buildBuy: funding failed");
  const inputs = [covUtxo, ...fund.funding];
  const outputs = [...payloadOutputs, ...fund.change];
  return buildTx(buyer.address, buyer.wif, inputs, outputs, false, (index, script) => {
    if (index === 0) return Script.fromHex(ROYALTY_BUY_SCRIPTSIG); // OP_0 -> buy branch
    return script;
  });
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "royalty listing covenant: list → buy accepted; strip/underpay rejected; cancel works",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const seller = newKey();
    const creator = newKey(); // royalty recipient
    const buyer = newKey();
    await fund(seller.address, 100);
    await fund(buyer.address, 100);

    // ---- mint NFT to seller -------------------------------------------------
    const payload = { p: [GLYPH_NFT], name: "Royalty Covenant NFT" } as unknown as SmartTokenPayload;
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

    // ---- list: move NFT into the royalty sale covenant ----------------------
    const PRICE = 10 * PHOTONS; // seller wants 10 RXD
    const ROYALTY = 1 * PHOTONS; // 10% creator royalty (computed off-chain)
    const terms: RoyaltySaleTerms = {
      ref: refLE,
      sellerAddress: seller.address,
      sellerScript: p2pkhScript(seller.address),
      price: PRICE,
      royalties: [{ script: p2pkhScript(creator.address), value: ROYALTY }],
    };
    const { tx: listTx, covenantScript: covenant } = buildRoyaltyListingTx({
      sellerAddress: seller.address,
      sellerWif: seller.wif,
      rxdCoins: await rxdCoins(seller.address),
      nftUtxo: nftAtSeller as Utxo,
      terms,
      feeRate: FEE_RATE,
    });
    expect(covenant).toBe(royaltySaleScript(terms));
    await broadcast(listTx.toString());
    await mine(1);
    const listed = await utxoByScript(covenant);
    expect(listed).toBeTruthy();
    console.log("LIST OK — NFT moved into royalty covenant", listed!.txid + ":" + listed!.vout);

    const payOut = { script: p2pkhScript(seller.address), value: PRICE };
    const nftToBuyer = { script: nftScript(buyer.address, refLE), value: 1 };
    const royOut = { script: p2pkhScript(creator.address), value: ROYALTY };

    // ---- REJECT: royalty stripped (redirected to buyer) ---------------------
    {
      const strip = buildBuy(buyer, await rxdCoins(buyer.address), listed as Utxo, [
        payOut,
        nftToBuyer,
        { script: p2pkhScript(buyer.address), value: ROYALTY }, // wrong recipient
      ]);
      const r = await tryBroadcast(strip.toString());
      console.log("STRIP rejected:", !r.ok, r.err?.slice(0, 120));
      expect(r.ok).toBe(false);
    }

    // ---- REJECT: royalty underpaid ------------------------------------------
    {
      const low = buildBuy(buyer, await rxdCoins(buyer.address), listed as Utxo, [
        payOut,
        nftToBuyer,
        { script: p2pkhScript(creator.address), value: ROYALTY - 1 },
      ]);
      const r = await tryBroadcast(low.toString());
      console.log("LOW-ROYALTY rejected:", !r.ok, r.err?.slice(0, 120));
      expect(r.ok).toBe(false);
    }

    // ---- REJECT: seller underpaid -------------------------------------------
    {
      const under = buildBuy(buyer, await rxdCoins(buyer.address), listed as Utxo, [
        { script: p2pkhScript(seller.address), value: PRICE - 1 },
        nftToBuyer,
        royOut,
      ]);
      const r = await tryBroadcast(under.toString());
      console.log("SELLER-UNDERPAY rejected:", !r.ok, r.err?.slice(0, 120));
      expect(r.ok).toBe(false);
    }

    // ---- ACCEPT: valid buy (via the shared lib builder) ---------------------
    {
      const ok = buildRoyaltyPurchaseTx({
        buyerAddress: buyer.address,
        buyerWif: buyer.wif,
        buyerCoins: await rxdCoins(buyer.address),
        covenantUtxo: listed as Utxo,
        terms,
        feeRate: FEE_RATE,
      });
      const r = await tryBroadcast(ok.toString());
      console.log("VALID buy accepted:", r.ok, r.err?.slice(0, 200));
      expect(r.ok).toBe(true);
      await mine(1);
      expect(await utxoByScript(nftScript(buyer.address, refLE))).toBeTruthy();
      const creatorBal = (await scanUnspents(`addr(${creator.address})`)).reduce(
        (s, u) => s + Math.round(u.amount * PHOTONS),
        0
      );
      expect(creatorBal).toBeGreaterThanOrEqual(ROYALTY);
      console.log("VALID buy settled — buyer owns NFT, creator received royalty", creatorBal);
    }

    // ---- CANCEL: relist a fresh NFT and reclaim it --------------------------
    {
      const mint2 = mintToken(
        "nft",
        { method: "direct", params: { address: seller.address }, value: 1 },
        seller.wif,
        (await rxdCoins(seller.address)) as Utxo[],
        { p: [GLYPH_NFT], name: "Cancel NFT" } as unknown as SmartTokenPayload,
        [],
        FEE_RATE
      );
      await broadcast(mint2.commitTx.toString());
      await broadcast(mint2.revealTx.toString());
      await mine(1);
      const ref2 = parseNftScript(mint2.revealTx.outputs[0].script.toHex()).ref as string;
      const nft2 = await utxoByScript(nftScript(seller.address, ref2));
      const terms2: RoyaltySaleTerms = { ...terms, ref: ref2 };
      const { tx: list2, covenantScript: cov2 } = buildRoyaltyListingTx({
        sellerAddress: seller.address,
        sellerWif: seller.wif,
        rxdCoins: await rxdCoins(seller.address),
        nftUtxo: nft2 as Utxo,
        terms: terms2,
        feeRate: FEE_RATE,
      });
      await broadcast(list2.toString());
      await mine(1);
      const listed2 = await utxoByScript(cov2);
      expect(listed2).toBeTruthy();

      // Seller reclaims via the cancel (IF) branch (shared lib builder).
      const cancelTx = buildRoyaltyCancelTx({
        sellerAddress: seller.address,
        sellerWif: seller.wif,
        rxdCoins: await rxdCoins(seller.address),
        covenantUtxo: listed2 as Utxo,
        ref: ref2,
        feeRate: FEE_RATE,
      });
      const r = await tryBroadcast(cancelTx.toString());
      console.log("CANCEL accepted:", r.ok, r.err?.slice(0, 200));
      expect(r.ok).toBe(true);
      await mine(1);
      expect(await utxoByScript(nftScript(seller.address, ref2))).toBeTruthy();
      console.log("CANCEL OK — seller reclaimed the listed NFT with their key");
    }

    console.log("=== ROYALTY COVENANT REGTEST PASSED ===");
  },
  600_000
);
