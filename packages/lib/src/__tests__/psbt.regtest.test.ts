/**
 * On-chain regtest E2E for the Radiant PSBT module (`../psbt`).
 *
 * Proves, with real confirmed regtest transactions, that a PSBT built from
 * scratch (as a dApp would, with only a CTxOut `utxo` field per input — no
 * full previous transaction) round-trips through `signPsbt` → `finalizePsbt`
 * → `extractTx` into something `sendrawtransaction` accepts:
 *
 *   1. Single-signer: fund address A, spend one of its coins to B via a PSBT
 *      A signs and finalizes itself; confirm the balance actually moved.
 *   2. Multi-party: two inputs from two different keys (Alice, Bob), signed
 *      independently and out of order, with the half-signed PSBT crossing a
 *      base64 round-trip in between (as it would between two wallets) before
 *      the second signer completes it — proving PSBT exchange needs no
 *      combiner step for disjoint inputs.
 *
 * Requires the local regtest stack (radiantd RPC 127.0.0.1:17443). Skipped by
 * default (network-dependent); enable with the REGTEST_E2E env var:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/psbt.regtest.test.ts --testTimeout=600000
 *
 * Connection is overridable via REGTEST_RPC_URL / REGTEST_RPC_USER /
 * REGTEST_RPC_PASS (wallet RPCs need the `/wallet/<name>` uri-path). Running
 * more than one regtest file per vitest invocation needs
 * `--no-file-parallelism`: radiantd allows only one `scantxoutset` at a time.
 */
import { it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { extractTx, finalizePsbt, Psbt, psbtFromBase64, psbtToBase64, signPsbt } from "../psbt";
import { p2pkhScript } from "../script";
import { SelectableInput } from "../coinSelect";

/* eslint-disable @typescript-eslint/no-explicit-any */
// radiantjs ships incomplete typings for Networks.regtest / PrivateKey.fromRandom;
// cast as any for the regtest harness (runtime is correct — see test output).
const { PrivateKey, Networks, Transaction, Script } = rjs as any;

const RPC_URL = process.env.REGTEST_RPC_URL || "http://127.0.0.1:17443/";
const RPC_USER = process.env.REGTEST_RPC_USER || "radiantrpc";
const RPC_PASS =
  process.env.REGTEST_RPC_PASS || "613c41227c677d8bc90f5729f93604a7";
const PHOTONS = 100_000_000;

type Unspent = { txid: string; vout: number; scriptPubKey: string; amount: number };

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
async function addrBalance(address: string): Promise<number> {
  return (await scanUnspents(`addr(${address})`)).reduce(
    (s, u) => s + Math.round(u.amount * PHOTONS),
    0
  );
}

/** Build an unsigned, legacy-serialized tx hex — the shape a dApp would hand
 * the wallet, with every scriptSig empty. */
function buildUnsignedTx(
  inputs: { txid: string; vout: number }[],
  outputs: { script: string; value: number }[]
): string {
  const tx = new Transaction();
  for (const input of inputs) {
    tx.addInput(
      new Transaction.Input({
        prevTxId: input.txid,
        outputIndex: input.vout,
        script: new Script(),
        output: new Transaction.Output({ script: new Script(), satoshis: 0 }),
      })
    );
  }
  for (const output of outputs) {
    tx.addOutput(new Transaction.Output({ script: output.script, satoshis: output.value }));
  }
  return tx.toString();
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "single-signer: PSBT spend of A's coin to B, signed and broadcast by A alone",
  async () => {
    console.log("\n=== regtest height:", await rpc("getblockcount"));
    MINE_ADDR = await rpc<string>("getnewaddress");

    const A = newKey();
    const B = newKey();
    await fund(A.address, 10);

    const coins = await rxdCoins(A.address);
    expect(coins.length).toBeGreaterThan(0);
    const coin = coins[0];
    const sendValue = Math.floor(coin.value * 0.5);

    const unsignedTxHex = buildUnsignedTx(
      [{ txid: coin.txid, vout: coin.vout }],
      [{ script: p2pkhScript(B.address), value: sendValue }]
    );
    const psbt: Psbt = {
      unsignedTxHex,
      inputs: [
        {
          utxo: { script: coin.script, value: BigInt(coin.value) },
          partialSigs: new Map(),
          bip32: [],
          unknown: [],
        },
      ],
      outputs: [{ entries: [] }],
      unknownGlobals: [],
    };

    const { psbt: signed, signedIndexes } = signPsbt(psbt, A.wif);
    expect(signedIndexes).toEqual([0]);
    const { psbt: finalized, complete } = finalizePsbt(signed);
    expect(complete).toBe(true);

    const hex = extractTx(finalized);
    const txid = await broadcast(hex);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    await mine(1);

    const balB = await addrBalance(B.address);
    expect(balB).toBe(sendValue);
    console.log("single-signer PSBT confirmed:", txid);
  },
  120_000
);

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "multi-party: two independently-signed inputs cross a base64 hop, no combiner needed",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");

    const alice = newKey();
    const bob = newKey();
    const dest = newKey();
    await fund(alice.address, 5);
    await fund(bob.address, 5);

    const [aliceCoin] = await rxdCoins(alice.address);
    const [bobCoin] = await rxdCoins(bob.address);
    expect(aliceCoin).toBeTruthy();
    expect(bobCoin).toBeTruthy();

    const totalIn = aliceCoin.value + bobCoin.value;
    const fee = 2000;
    const sendValue = totalIn - fee;

    const unsignedTxHex = buildUnsignedTx(
      [
        { txid: aliceCoin.txid, vout: aliceCoin.vout },
        { txid: bobCoin.txid, vout: bobCoin.vout },
      ],
      [{ script: p2pkhScript(dest.address), value: sendValue }]
    );
    const psbt: Psbt = {
      unsignedTxHex,
      inputs: [
        {
          utxo: { script: aliceCoin.script, value: BigInt(aliceCoin.value) },
          partialSigs: new Map(),
          bip32: [],
          unknown: [],
        },
        {
          utxo: { script: bobCoin.script, value: BigInt(bobCoin.value) },
          partialSigs: new Map(),
          bip32: [],
          unknown: [],
        },
      ],
      outputs: [{ entries: [] }],
      unknownGlobals: [],
    };

    // Alice signs her input only; the half-signed PSBT is handed to Bob the
    // way it would be between two wallets — as a base64 string.
    const afterAlice = signPsbt(psbt, alice.wif);
    expect(afterAlice.signedIndexes).toEqual([0]);
    expect(finalizePsbt(afterAlice.psbt).complete).toBe(false);

    const rehydrated = psbtFromBase64(psbtToBase64(afterAlice.psbt));
    const afterBob = signPsbt(rehydrated, bob.wif);
    expect(afterBob.signedIndexes).toEqual([1]);

    const { psbt: finalized, complete } = finalizePsbt(afterBob.psbt);
    expect(complete).toBe(true);

    const hex = extractTx(finalized);
    const txid = await broadcast(hex);
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
    await mine(1);

    const balDest = await addrBalance(dest.address);
    expect(balDest).toBe(sendValue);
    console.log("multi-party PSBT confirmed:", txid);
  },
  120_000
);
