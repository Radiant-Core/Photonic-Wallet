/**
 * On-chain regtest E2E for the SwapLoad NFT→RXD completion path (audit fix R2).
 *
 * The swap MAKER partially-signs SIGHASH_SINGLE|ANYONECANPAY: a single input
 * (their reserved NFT) committing to output[0] = the RXD payment they want.
 * SIGHASH_SINGLE binds the signing input to the output at the SAME INDEX, and
 * the completion reuses the maker's scriptSig VERBATIM at input index 0.
 * Therefore the maker payment MUST stay at output[0].
 *
 * This test broadcasts the EXACT output construction SwapLoad.tsx produces and
 * proves on-chain:
 *   POSITIVE — canonical [payment(0), nft(1), royalty(2+), change] is ACCEPTED
 *              and confirms; the maker is paid, the buyer gets the NFT, and the
 *              royalty recipients are paid. (The fixed layout.)
 *   NEGATIVE — the OLD buggy layout [nft(0), payment(1), …], reusing the same
 *              maker scriptSig at input 0, is REJECTED by the node because the
 *              maker's SIGHASH_SINGLE signature no longer matches output[0].
 *              (Proves the pre-fix reorder really broke NFT-for-RXD swaps.)
 *
 * Requires the local regtest stack (radiantd RPC 127.0.0.1:17443). Enable with:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/swap-load-flow.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { transferNonFungible, partiallySigned } from "../transfer";
import { buildTx } from "../tx";
import { fundTx, SelectableInput } from "../coinSelect";
import { nftScript, p2pkhScript, parseNftScript } from "../script";
import { createWaveNameMetadata } from "../wave";
import { Utxo, UnfinalizedInput, UnfinalizedOutput } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
// radiantjs ships incomplete typings for Networks.regtest / PrivateKey.fromRandom;
// cast as any for the regtest harness (runtime is correct — see test output).
const { PrivateKey, Networks, Transaction } = rjs as any;

const RPC_URL = "http://127.0.0.1:17443/";
const RPC_USER = "radiantrpc";
const RPC_PASS = "613c41227c677d8bc90f5729f93604a7";
const FEE_RATE = 10_000;
const PHOTONS = 100_000_000;

type Unspent = { txid: string; vout: number; scriptPubKey: string; amount: number };

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
async function addrBalance(address: string): Promise<number> {
  return (await scanUnspents(`addr(${address})`)).reduce(
    (s, u) => s + Math.round(u.amount * PHOTONS),
    0
  );
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "SwapLoad NFT→RXD: canonical [payment,nft,royalty] accepted; old [nft,payment] reorder rejected",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    if ((await rpc<number>("getbalance")) < 250) await rpc("generatetoaddress", [110, MINE_ADDR]);

    const A = newKey(); // maker
    const Aswap = newKey(); // maker swap subaccount
    const B = newKey(); // taker / buyer
    const royA = newKey(); // royalty recipient 1
    const royB = newKey(); // royalty recipient 2
    await fund(A.address, 100);
    await fund(B.address, 100);

    // --- Mint an NFT to A, then move it into A's swap subaccount ----------
    const NAME = `swp${Date.now().toString().slice(-7)}.rxd`;
    const meta = createWaveNameMetadata(NAME, A.address, { target: A.address, desc: NAME });
    const mintRes = mintToken(
      "nft",
      { method: "direct", params: { address: A.address }, value: 1 },
      A.wif,
      (await rxdCoins(A.address)) as Utxo[],
      meta,
      [],
      FEE_RATE
    );
    await broadcast(mintRes.commitTx.toString());
    await broadcast(mintRes.revealTx.toString());
    await mine(1);
    const refLE = parseNftScript(mintRes.revealTx.outputs[0].script.toHex()).ref as string;
    const nftAtA = await utxoByScript(nftScript(A.address, refLE));
    expect(nftAtA).toBeTruthy();

    const { tx: moveTx } = transferNonFungible(
      await rxdCoins(A.address),
      nftAtA as Utxo,
      refLE,
      A.address,
      Aswap.address,
      FEE_RATE,
      A.wif
    );
    await broadcast(moveTx.toString());
    await mine(1);
    const nftAtSwap = await utxoByScript(nftScript(Aswap.address, refLE));
    expect(nftAtSwap).toBeTruthy();

    // --- Maker partially-signs: spend NFT@swap, require output0 = PRICE to A
    const PRICE = 5 * PHOTONS;
    const ROY_A = Math.round(0.2 * PHOTONS);
    const ROY_B = Math.round(0.1 * PHOTONS);
    const psrt = new Transaction(
      partiallySigned(
        Aswap.address,
        nftAtSwap as UnfinalizedInput,
        { script: p2pkhScript(A.address), value: PRICE },
        Aswap.wif
      ).toString()
    );
    const makerScriptSig = psrt.inputs[0].script; // pre-signed SINGLE|ANYONECANPAY @ input 0

    // --- Build the buyer-completed output set (mirrors SwapLoad.tsx) -------
    const makerInput: UnfinalizedInput = { ...(nftAtSwap as Utxo) };
    const payOut: UnfinalizedOutput = { script: p2pkhScript(A.address), value: PRICE };
    const nftToB: UnfinalizedOutput = { script: nftScript(B.address, refLE), value: nftAtSwap!.value };
    const royaltyOuts: UnfinalizedOutput[] = [
      { script: p2pkhScript(royA.address), value: ROY_A },
      { script: p2pkhScript(royB.address), value: ROY_B },
    ];

    // Canonical SwapLoad layout: [payment, nft, ...royalties], change appended.
    const canonicalOutputs = [payOut, nftToB, ...royaltyOuts];
    const bFund = fundTx(
      B.address,
      await rxdCoins(B.address),
      [makerInput],
      canonicalOutputs,
      p2pkhScript(B.address),
      FEE_RATE
    );
    expect(bFund.funded).toBe(true);
    const swapInputs = [makerInput, ...bFund.funding];

    // ===================== NEGATIVE (old buggy reorder) =====================
    // [nft(0), payment(1), ...royalties], maker scriptSig reused at input 0.
    // The maker's SIGHASH_SINGLE sig commits to output[0]=payment, but here
    // output[0]=nft → invalid → node MUST reject. Rejected tx spends nothing,
    // so the same inputs remain available for the positive broadcast below.
    const buggyOutputs = [nftToB, payOut, ...royaltyOuts, ...bFund.change];
    const buggyTx = buildTx(
      B.address,
      B.wif,
      swapInputs,
      buggyOutputs,
      false,
      (index, script) => (index === 0 ? makerScriptSig : script)
    );
    let rejected = false;
    let rejectMsg = "";
    try {
      await broadcast(buggyTx.toString());
    } catch (err) {
      rejected = true;
      rejectMsg = (err as Error).message;
    }
    expect(rejected).toBe(true); // old layout is invalid on-chain
    console.log("NEGATIVE ok — node rejected old [nft,payment] layout:", rejectMsg.slice(0, 160));

    // ===================== POSITIVE (fixed canonical layout) ================
    const aBefore = await addrBalance(A.address);
    const swapOutputs = [payOut, nftToB, ...royaltyOuts, ...bFund.change];
    const swapTx = buildTx(
      B.address,
      B.wif,
      swapInputs,
      swapOutputs,
      false,
      (index, script) => (index === 0 ? makerScriptSig : script)
    );
    const swapId = await broadcast(swapTx.toString()); // must NOT throw
    await mine(1);

    const conf = await rpc<{ confirmations?: number }>("getrawtransaction", [swapId, true]);
    expect((conf.confirmations || 0) >= 1).toBe(true);

    const nftAtB = await utxoByScript(nftScript(B.address, refLE));
    expect(nftAtB).toBeTruthy(); // buyer received the NFT
    expect((await addrBalance(A.address)) - aBefore).toBe(PRICE); // maker paid exactly PRICE
    expect(await addrBalance(royA.address)).toBe(ROY_A); // royalties paid
    expect(await addrBalance(royB.address)).toBe(ROY_B);

    console.log(
      `POSITIVE ok — swap ${swapId.slice(0, 12)}… confirmed: B owns NFT, A +${PRICE / PHOTONS} RXD, ` +
        `royalties ${ROY_A / PHOTONS}/${ROY_B / PHOTONS} RXD paid. Maker payment stayed at output[0].`
    );
  },
  600_000
);
