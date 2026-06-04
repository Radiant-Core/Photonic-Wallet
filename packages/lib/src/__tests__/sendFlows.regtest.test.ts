/**
 * On-chain regtest E2E for the wallet's token movement primitives — the tx
 * builders that SendFungible / SendDigitalObject / MeltFungible drive.
 *
 * Proves, with real confirmed regtest transactions:
 *   1. FT send: A mints 1000 FT, sends 300 to B → B holds 300, A holds 700.
 *   2. FT melt: A melts the remaining 700 → the FT output is gone on-chain.
 *   3. NFT send: A mints an NFT, sends it to B → NFT is at B, gone from A.
 *
 * The component fixes only changed *when* local Dexie state is updated relative
 * to broadcast (and added a confirm step); the tx bytes are unchanged. This
 * test pins the on-chain half — that the exact @lib calls still produce valid,
 * accepted transactions that move/destroy the assets as expected. The local
 * Dexie-state half is covered by app/src/__tests__/sendFlows.state.test.ts.
 *
 * Requires the local regtest stack (radiantd RPC 127.0.0.1:17443). Skipped by
 * default; enable with REGTEST_E2E:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/sendFlows.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { transferFungible, transferNonFungible } from "../transfer";
import coinSelect, { SelectableInput } from "../coinSelect";
import { buildTx } from "../tx";
import {
  ftScript,
  nftScript,
  p2pkhScript,
  parseFtScript,
  parseNftScript,
} from "../script";
import { reverseRef } from "../Outpoint";
import { GLYPH_FT, GLYPH_NFT } from "../protocols";
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

async function mintFt(A: Key, supply: number) {
  const payload = {
    p: [GLYPH_FT],
    name: "E2E FT",
    ticker: "E2E",
  } as unknown as SmartTokenPayload;
  const res = mintToken(
    "ft",
    { method: "direct", params: { address: A.address }, value: supply },
    A.wif,
    (await rxdCoins(A.address)) as Utxo[],
    payload,
    [],
    FEE_RATE
  );
  await broadcast(res.commitTx.toString());
  await broadcast(res.revealTx.toString());
  await mine(1);
  const refLE = parseFtScript(res.revealTx.outputs[0].script.toHex())
    .ref as string;
  return refLE;
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "FT send + melt: tokens move to B, change stays at A, then melt destroys it",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const A = newKey();
    const B = newKey();
    await fund(A.address, 100);

    const SUPPLY = 1000;
    const refLE = await mintFt(A, SUPPLY);
    const fromScript = ftScript(A.address, refLE);
    expect((await utxoByScript(fromScript))?.value).toBe(SUPPLY);
    console.log("minted", SUPPLY, "FT to A; ref", reverseRef(refLE));

    // --- FT send: 300 A -> B ------------------------------------------------
    const SEND = 300;
    const ftTokens = [
      { ...(await utxoByScript(fromScript)) } as SelectableInput,
    ];
    const { tx: sendTx } = transferFungible(
      await rxdCoins(A.address),
      ftTokens,
      refLE,
      A.address,
      B.address,
      SEND,
      FEE_RATE,
      A.wif
    );
    await broadcast(sendTx.toString());
    await mine(1);
    expect((await utxoByScript(ftScript(B.address, refLE)))?.value).toBe(SEND);
    expect((await utxoByScript(ftScript(A.address, refLE)))?.value).toBe(
      SUPPLY - SEND
    );
    console.log(`FT send OK: B=${SEND}, A change=${SUPPLY - SEND}`);

    // --- FT melt: destroy A's remaining 700 (replicates MeltFungible) -------
    const changeScript = p2pkhScript(A.address);
    const meltTokens = await utxoByScript(ftScript(A.address, refLE));
    const required: SelectableInput[] = [
      { ...(meltTokens as Utxo), required: true },
    ];
    const selected = coinSelect(
      A.address,
      [...required, ...(await rxdCoins(A.address))],
      [],
      changeScript,
      FEE_RATE
    );
    const meltRaw = buildTx(
      A.address,
      A.wif,
      selected.inputs,
      selected.outputs,
      false
    ).toString();
    await broadcast(meltRaw);
    await mine(1);
    expect(await utxoByScript(ftScript(A.address, refLE))).toBeNull();
    console.log("FT melt OK: token output destroyed on-chain");
  },
  600_000
);

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "NFT send: NFT moves to B and is gone from A",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const A = newKey();
    const B = newKey();
    await fund(A.address, 100);

    const payload = {
      p: [GLYPH_NFT],
      name: "E2E NFT",
    } as unknown as SmartTokenPayload;
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

    const refLE = parseNftScript(mintRes.revealTx.outputs[0].script.toHex())
      .ref as string;
    const nftAtA = await utxoByScript(nftScript(A.address, refLE));
    expect(nftAtA).toBeTruthy();
    console.log("minted NFT to A; ref", reverseRef(refLE));

    const { tx } = transferNonFungible(
      await rxdCoins(A.address),
      nftAtA as Utxo,
      refLE,
      A.address,
      B.address,
      FEE_RATE,
      A.wif
    );
    await broadcast(tx.toString());
    await mine(1);

    expect(await utxoByScript(nftScript(B.address, refLE))).toBeTruthy();
    expect(await utxoByScript(nftScript(A.address, refLE))).toBeNull();
    console.log("NFT send OK: NFT now at B, gone from A");
  },
  600_000
);
