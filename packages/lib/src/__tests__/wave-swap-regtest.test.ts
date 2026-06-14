/**
 * On-chain regtest E2E for the WAVE-name marketplace.
 *
 * Proves, with real confirmed regtest transactions:
 *   1. Mint a WAVE name (mutable NFT + companion mutable contract) to A.
 *   2. Atomic private swap: A partially-signs (SIGHASH_SINGLE|ANYONECANPAY)
 *      "give NFT, want N RXD"; B completes + broadcasts. B gets the name, A
 *      gets the RXD, in one tx — A never signed B's inputs.
 *   3. B re-points the name's target to itself by co-spending the acquired
 *      NFT + the name's mutable contract UTXO with NO key from A. This is the
 *      load-bearing proof that the mutable covenant is NFT-gated, not
 *      seller-keyed (the basis for safely selling names).
 *
 * Requires the local regtest stack (radiantd RPC 127.0.0.1:17443). Skipped by
 * default (network-dependent); enable with the REGTEST_E2E env var:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/wave-swap-regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { transferNonFungible, partiallySigned } from "../transfer";
import { buildTx } from "../tx";
import { fundTx, SelectableInput } from "../coinSelect";
import {
  nftScript,
  nftAuthScript,
  mutableNftScript,
  p2pkhScript,
  parseNftScript,
  parseMutableScript,
} from "../script";
import { encodeGlyphMutable } from "../token";
import { createWaveNameMetadata } from "../wave";
import { Utxo, UnfinalizedInput, SmartTokenPayload } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
// radiantjs ships incomplete typings for Networks.regtest / PrivateKey.fromRandom;
// cast as any for the regtest harness (runtime is correct — see test output).
const { PrivateKey, Networks, Transaction } = rjs as any;

const RPC_URL = "http://127.0.0.1:17443/";
const RPC_USER = "radiantrpc";
const RPC_PASS = "613c41227c677d8bc90f5729f93604a7";
const FEE_RATE = 10_000;
const PHOTONS = 100_000_000;

type Unspent = {
  txid: string;
  vout: number;
  scriptPubKey: string;
  amount: number;
};

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
      script: u.scriptPubKey as string,
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
async function addrBalance(address: string): Promise<number> {
  return (await scanUnspents(`addr(${address})`)).reduce(
    (s, u) => s + Math.round(u.amount * PHOTONS),
    0
  );
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "WAVE name: mint → atomic swap A→B → buyer re-points target (covenant)",
  async () => {
    console.log("\n=== regtest height:", await rpc("getblockcount"));
    MINE_ADDR = await rpc<string>("getnewaddress");

    const A = newKey();
    const Aswap = newKey();
    const B = newKey();
    console.log("A     :", A.address);
    console.log("A_swap:", Aswap.address);
    console.log("B     :", B.address);

    expect(
      (await rpc<{ isvalid: boolean }>("validateaddress", [A.address])).isvalid
    ).toBe(true);

    await fund(A.address, 100);
    await fund(B.address, 100);
    console.log("funded A & B with 100 RXD each\n");

    // ---- STEP 1: mint a WAVE name to A -----------------------------------
    const NAME = `e2e${Date.now().toString().slice(-7)}.rxd`;
    const meta = createWaveNameMetadata(NAME, A.address, {
      target: A.address,
      desc: `regtest e2e ${NAME}`,
    });
    const mintRes = mintToken(
      "nft",
      { method: "direct", params: { address: A.address }, value: 1 },
      A.wif,
      (await rxdCoins(A.address)) as Utxo[],
      meta,
      [],
      FEE_RATE
    );
    const commitId = await broadcast(mintRes.commitTx.toString());
    const revealId = await broadcast(mintRes.revealTx.toString());
    await mine(1);

    const nftScriptHex = mintRes.revealTx.outputs[0].script.toHex();
    const mutScriptHex = mintRes.revealTx.outputs[1].script.toHex();
    const refLE = parseNftScript(nftScriptHex).ref as string;
    const mutRefLE = parseMutableScript(mutScriptHex).ref as string;
    console.log("minted", NAME, "\n  commit", commitId, "\n  reveal", revealId);
    console.log("  refLE", refLE, "\n  mutRefLE", mutRefLE);
    expect(refLE).toBeTruthy();
    expect(mutRefLE).toBeTruthy();

    const nftAtA = await utxoByScript(nftScript(A.address, refLE));
    const mutUtxo = await utxoByScript(mutScriptHex);
    console.log("  NFT@A:", !!nftAtA, "| mutable contract:", !!mutUtxo);
    expect(nftAtA).toBeTruthy();
    expect(mutUtxo).toBeTruthy();
    console.log("STEP 1 OK — name minted; NFT + mutable contract confirmed\n");

    // ---- STEP 2: atomic private swap A → B (NFT for 5 RXD) ---------------
    // 2a. A moves the NFT into its swap subaccount address.
    const moveAcoins = await rxdCoins(A.address);
    const { tx: moveTx } = transferNonFungible(
      moveAcoins,
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
    console.log(
      "2a: NFT moved to A_swap",
      nftAtSwap!.txid + ":" + nftAtSwap!.vout
    );

    // 2b. A partially-signs: spend NFT@swap, require output0 = 5 RXD to A.
    const PRICE = 5 * PHOTONS;
    const psrtRaw = partiallySigned(
      Aswap.address,
      nftAtSwap as UnfinalizedInput,
      { script: p2pkhScript(A.address), value: PRICE },
      Aswap.wif
    ).toString();
    const psrt = new Transaction(psrtRaw);
    const makerScriptSig = psrt.inputs[0].script; // pre-signed SINGLE|ANYONECANPAY
    console.log("2b: A produced partially-signed swap (wants 5 RXD)");

    // 2c. B completes: keep maker NFT input at index 0 + maker payment at
    // output 0 (SIGHASH_SINGLE), add NFT→B output, fund with B's RXD.
    const aBalBefore = await addrBalance(A.address);
    const makerInput: UnfinalizedInput = { ...(nftAtSwap as Utxo) };
    const payOut = { script: p2pkhScript(A.address), value: PRICE };
    const nftToB = {
      script: nftScript(B.address, refLE),
      value: nftAtSwap!.value,
    };
    const bFund = fundTx(
      B.address,
      await rxdCoins(B.address),
      [makerInput],
      [payOut, nftToB],
      p2pkhScript(B.address),
      FEE_RATE
    );
    expect(bFund.funded).toBe(true);
    // fundTx.funding excludes required inputs — prepend the maker NFT input.
    const swapInputs = [makerInput, ...bFund.funding];
    const swapOutputs = [payOut, nftToB, ...bFund.change];
    const swapTx = buildTx(
      B.address,
      B.wif,
      swapInputs,
      swapOutputs,
      false,
      (index, script) => (index === 0 ? makerScriptSig : script)
    );
    const swapId = await broadcast(swapTx.toString());
    await mine(1);

    const nftAtB = await utxoByScript(nftScript(B.address, refLE));
    const aBalAfter = await addrBalance(A.address);
    console.log("2c: swap broadcast", swapId);
    console.log(
      "  NFT@B:",
      !!nftAtB,
      "| A balance +",
      (aBalAfter - aBalBefore) / PHOTONS,
      "RXD"
    );
    expect(nftAtB).toBeTruthy();
    expect(aBalAfter - aBalBefore).toBe(PRICE);
    console.log(
      "STEP 2 OK — atomic swap settled: B owns the name, A got 5 RXD\n"
    );

    // ---- STEP 3: B re-points target to itself (NFT-gated covenant) -------
    // B holds the NFT; the mutable contract is a covenant requiring only the
    // NFT singleton (no A key). Co-spend NFT + mutable UTXO to set target=B.
    const mutNow = await utxoByScript(mutScriptHex);
    expect(mutNow).toBeTruthy();
    const payload: Partial<SmartTokenPayload> = {
      attrs: {
        name: NAME.split(".")[0],
        domain: "rxd",
        target: B.address,
        target_type: "address",
      },
    };
    // outputs = [nftOutput(0), mutContractOutput(1)] → indices 1,1,0,0
    const glyph = encodeGlyphMutable("mod", payload, 1, 1, 0, 0);
    const mutOutScript = mutableNftScript(mutRefLE, glyph.payloadHash);
    const nftOutScript = nftAuthScript(B.address, refLE, [
      { ref: mutRefLE, scriptSigHash: glyph.scriptSigHash },
    ]);
    const nftInput: UnfinalizedInput = { ...(nftAtB as Utxo) };
    const mutInput: UnfinalizedInput = {
      ...(mutNow as Utxo),
      scriptSigSize: mutOutScript.length / 2,
    };
    const reFund = fundTx(
      B.address,
      await rxdCoins(B.address),
      [nftInput, mutInput],
      [
        { script: nftOutScript, value: nftInput.value },
        { script: mutOutScript, value: mutInput.value },
      ],
      p2pkhScript(B.address),
      FEE_RATE
    );
    expect(reFund.funded).toBe(true);
    // Prepend required inputs (fundTx.funding is only the selected B coins).
    const reInputs = [nftInput, mutInput, ...reFund.funding];
    const reOutputs = [
      { script: nftOutScript, value: nftInput.value },
      { script: mutOutScript, value: mutInput.value },
      ...reFund.change,
    ];
    const repointTx = buildTx(
      B.address,
      B.wif,
      reInputs,
      reOutputs,
      false,
      (index, script) => {
        if (index === 1) {
          script.set({ chunks: [] });
          script.add(glyph.scriptSig);
        }
        return script;
      }
    );
    const repointId = await broadcast(repointTx.toString());
    await mine(1);
    const conf = await rpc<{ confirmations?: number }>("getrawtransaction", [
      repointId,
      true,
    ]);
    console.log(
      "3: repoint broadcast",
      repointId,
      "confirmations:",
      conf.confirmations
    );
    expect((conf.confirmations || 0) >= 1).toBe(true);
    // The mutable contract moved (was re-created with the new state); B's auth
    // NFT output exists. The node ACCEPTED B's spend of the covenant using
    // only B's key — proof the mutable target is NFT-gated, not seller-keyed.
    const newNft = await utxoByScript(nftOutScript);
    console.log("  new auth-NFT output present:", !!newNft);
    console.log(
      "STEP 3 OK — buyer B re-pointed",
      NAME,
      "to its own address with NO seller key\n"
    );
    console.log("=== WAVE-NAME MARKETPLACE E2E PASSED ===");
  },
  600_000
);
