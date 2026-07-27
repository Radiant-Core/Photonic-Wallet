/**
 * Regtest fixture generator for the connect `swap-accept-request` approval
 * screen's creator-royalty line.
 *
 * The royalty line could not be verified against mainnet: no live NFT carries
 * an enforced royalty (the 55 most recent glyph payloads have no `royalty`
 * key), and minting one on mainnet costs real funds. So this mints an NFT
 * WITH enforced royalty terms on regtest and prints a PSRT spending it, ready
 * to paste into a `swap-accept-request` deep link.
 *
 * It is a fixture generator rather than an assertion test — the thing being
 * verified is what a human sees on the approval screen, which lives in the
 * app, not here. It still asserts the on-chain preconditions the panel
 * depends on, so a failure here means the fixture is bad rather than the UI.
 *
 * Requires the local regtest stack: radiantd RPC 127.0.0.1:17443 +
 * RXinDexer ElectrumX TCP 127.0.0.1:50010. Enable with REGTEST_E2E:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/royaltyPreview.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { SelectableInput } from "../coinSelect";
import { parseNftScript } from "../script";
import { GLYPH_NFT } from "../protocols";
import { parseRoyalty } from "../royaltyTerms";
import { Utxo, SmartTokenPayload } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks, Transaction, Script } = rjs as any;

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

let MINE_ADDR = "";
const mine = (n = 1) => rpc("generatetoaddress", [n, MINE_ADDR]);
const broadcast = (hex: string) => rpc<string>("sendrawtransaction", [hex]);

async function rxdCoins(address: string): Promise<SelectableInput[]> {
  const r = await rpc<{
    unspents: { txid: string; vout: number; scriptPubKey: string; amount: number }[];
  }>("scantxoutset", ["start", [{ desc: `addr(${address})` }]]);
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
  "mints an enforced-royalty NFT and emits a PSRT for the approval screen",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const pk = PrivateKey.fromRandom(Networks.regtest);
    const seller = { wif: pk.toWIF(), address: pk.toAddress(Networks.regtest).toString() };
    const creator = PrivateKey.fromRandom(Networks.regtest)
      .toAddress(Networks.regtest)
      .toString();

    await rpc("sendtoaddress", [seller.address, 100]);
    await mine(1);

    // 7.5% enforced royalty, no splits — the simple case the panel renders as
    // a single "Creator royalty" line.
    const royalty = {
      enforced: true,
      bps: 750,
      address: creator,
      minimum: 0,
      maximum: null as number | null,
      splits: [] as { address: string; bps: number }[],
    };
    const payload = {
      p: [GLYPH_NFT],
      name: "Royalty Preview NFT",
      desc: "Regtest fixture for the swap-accept royalty line.",
      royalty,
    } as unknown as SmartTokenPayload;

    // Sanity: the terms must survive parseRoyalty, or the panel would show
    // nothing no matter how the UI behaves.
    const parsed = parseRoyalty(payload as unknown);
    expect(parsed?.enforced).toBe(true);
    expect(parsed?.bps).toBe(750);

    const mintRes = mintToken(
      "nft",
      { method: "direct", params: { address: seller.address }, value: 1 },
      seller.wif,
      (await rxdCoins(seller.address)) as Utxo[],
      payload,
      [],
      FEE_RATE
    );
    const commitTxid = await broadcast(mintRes.commitTx.toString());
    const revealTxid = await broadcast(mintRes.revealTx.toString());
    await mine(1);

    // Locate the NFT output in the reveal — that outpoint is what a PSRT's
    // single input spends, and what `previewSwapAccept` reads to identify the
    // item and its royalty.
    const revealTx = new Transaction(mintRes.revealTx.toString());
    let nftVout = -1;
    revealTx.outputs.forEach((o: any, i: number) => {
      if (parseNftScript(o.script.toHex()).ref) nftVout = i;
    });
    expect(nftVout).toBeGreaterThanOrEqual(0);

    const priceSats = 20 * PHOTONS; // 20 RXD -> 7.5% = 1.5 RXD royalty
    const psrt = new Transaction();
    psrt.uncheckedAddInput(
      new Transaction.Input({
        prevTxId: Buffer.from(revealTxid, "hex"),
        outputIndex: nftVout,
        script: Script.empty(),
        output: revealTx.outputs[nftVout],
      })
    );
    psrt.addOutput(
      new Transaction.Output({
        script: Script.buildPublicKeyHashOut(seller.address),
        satoshis: priceSats,
      })
    );

    console.log("\n=== ROYALTY PREVIEW FIXTURE ===");
    console.log("commitTxid   ", commitTxid);
    console.log("revealTxid   ", revealTxid);
    console.log("nftVout      ", nftVout);
    console.log("ref          ", mintRes.ref.toString());
    console.log("sellerAddr   ", seller.address);
    console.log("creatorAddr  ", creator);
    console.log("priceRxd     ", priceSats / PHOTONS);
    console.log("expectRoyalty", (priceSats * 750) / 10000 / PHOTONS, "RXD");
    console.log("PSRT_HEX     ", psrt.toString());
    console.log("=== END FIXTURE ===\n");
  },
  600_000
);
