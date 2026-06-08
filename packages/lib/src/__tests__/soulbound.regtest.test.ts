/**
 * On-chain regtest proof for the soulbound (non-transferable) NFT covenant.
 *
 * Executes the v3.0.0 interpreter (not byte-asserts). Proves:
 *   - An NFT can be locked into the soulbound covenant.
 *   - The owner CAN re-lock it to themselves (MOVE path accepted).
 *   - The owner CANNOT transfer it to a different recipient (REJECTED).
 *   - The owner CANNOT re-lock it into a plain transferable nftScript (REJECTED).
 *   - (BURN path) the owner can destroy the token if the node permits singleton
 *     burn; otherwise that sub-assertion is logged and skipped.
 *
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/soulbound.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { mintToken } from "../mint";
import { buildTx } from "../tx";
import { fundTx, SelectableInput } from "../coinSelect";
import { nftScript, p2pkhScript, parseNftScript } from "../script";
import { soulboundNftScript } from "../soulbound";
import { GLYPH_NFT } from "../protocols";
import { Utxo, UnfinalizedInput, UnfinalizedOutput, SmartTokenPayload } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
// radiantjs ships incomplete typings for Networks.regtest / PrivateKey.fromRandom;
// cast as any for the regtest harness (runtime is correct — see test output).
const { PrivateKey, Networks, Opcode } = rjs as any;

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
    .map((u) => ({ txid: u.txid, vout: u.vout, script: u.scriptPubKey, value: Math.round(u.amount * PHOTONS) }))
    .filter((u) => u.value > 1);
}
async function utxoByScript(scriptHex: string): Promise<Utxo | null> {
  const u = (await scanUnspents(`raw(${scriptHex})`))[0];
  return u ? { txid: u.txid, vout: u.vout, script: scriptHex, value: Math.round(u.amount * PHOTONS) } : null;
}

function moveNft(ownerCoins: SelectableInput[], nftUtxo: Utxo, ownerAddress: string, ownerWif: string, destScript: string) {
  const fund = fundTx(ownerAddress, ownerCoins, [nftUtxo], [{ script: destScript, value: 1 }], p2pkhScript(ownerAddress), FEE_RATE);
  if (!fund.funded) throw new Error("moveNft: funding failed");
  return buildTx(ownerAddress, ownerWif, [nftUtxo, ...fund.funding], [{ script: destScript, value: 1 }, ...fund.change], false);
}

// Spend a soulbound covenant with the given selector + output layout.
function spendSoulbound(
  owner: Key,
  ownerCoins: SelectableInput[],
  covUtxo: Utxo,
  selector: number, // Opcode.OP_1 (move) or Opcode.OP_0 (burn)
  payloadOutputs: UnfinalizedOutput[]
) {
  const covInput: UnfinalizedInput = { ...covUtxo, scriptSigSize: 112 };
  const fund = fundTx(owner.address, ownerCoins, [covInput], payloadOutputs, p2pkhScript(owner.address), FEE_RATE);
  if (!fund.funded) throw new Error("spendSoulbound: funding failed");
  return buildTx(
    owner.address,
    owner.wif,
    [covUtxo, ...fund.funding],
    [...payloadOutputs, ...fund.change],
    false,
    (index, script) => (index === 0 ? script.add(selector) : script)
  );
}

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "soulbound covenant: lock → owner self-move accepted; transfer-away rejected",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    const owner = newKey();
    const other = newKey();
    await fund(owner.address, 100);

    // Owner-stability for indexer discovery: the soulbound script must carry
    // exactly ONE ref operand (the leading singleton). The indexer's zero_refs()
    // zeroes INPUT_REF_OP operands but NOT PUSHDATA, so a second literal ref
    // would make every token hash uniquely (undiscoverable by owner). Two
    // soulbound scripts for the same owner must therefore be identical except
    // for the 72 hex chars immediately after the leading d8.
    {
      const rA = "11".repeat(32) + "00000000";
      const rB = "22".repeat(32) + "00000000";
      const sA = soulboundNftScript(owner.address, rA);
      const sB = soulboundNftScript(owner.address, rB);
      expect(sA.slice(0, 2)).toBe("d8");
      expect(sA.slice(2, 74)).toBe(rA);
      expect(sB.slice(2, 74)).toBe(rB);
      expect(sA.slice(74)).toBe(sB.slice(74)); // no other ref bytes differ
    }

    // mint NFT to owner
    const mintRes = mintToken(
      "nft",
      { method: "direct", params: { address: owner.address }, value: 1 },
      owner.wif,
      (await rxdCoins(owner.address)) as Utxo[],
      { p: [GLYPH_NFT], name: "Soulbound NFT" } as unknown as SmartTokenPayload,
      [],
      FEE_RATE
    );
    await broadcast(mintRes.commitTx.toString());
    await broadcast(mintRes.revealTx.toString());
    await mine(1);
    const refLE = parseNftScript(mintRes.revealTx.outputs[0].script.toHex()).ref as string;
    const nftAtOwner = await utxoByScript(nftScript(owner.address, refLE));
    expect(nftAtOwner).toBeTruthy();

    // lock into soulbound covenant
    const soul = soulboundNftScript(owner.address, refLE);
    await broadcast(moveNft(await rxdCoins(owner.address), nftAtOwner as Utxo, owner.address, owner.wif, soul).toString());
    await mine(1);
    let locked = await utxoByScript(soul);
    expect(locked).toBeTruthy();
    console.log("LOCK OK — NFT in soulbound covenant", locked!.txid + ":" + locked!.vout);

    // REJECT: owner tries to transfer to `other` (plain nftScript)
    {
      const away = spendSoulbound(owner, await rxdCoins(owner.address), locked as Utxo, Opcode.OP_1, [
        { script: nftScript(other.address, refLE), value: 1 },
      ]);
      const r = await tryBroadcast(away.toString());
      console.log("TRANSFER-AWAY (to other) rejected:", !r.ok, r.err?.slice(0, 120));
      expect(r.ok).toBe(false);
    }

    // REJECT: owner tries to re-lock into a plain transferable nftScript(owner)
    {
      const escape = spendSoulbound(owner, await rxdCoins(owner.address), locked as Utxo, Opcode.OP_1, [
        { script: nftScript(owner.address, refLE), value: 1 },
      ]);
      const r = await tryBroadcast(escape.toString());
      console.log("ESCAPE-TO-PLAIN rejected:", !r.ok, r.err?.slice(0, 120));
      expect(r.ok).toBe(false);
    }

    // ACCEPT: owner re-locks to the SAME soulbound script (self-custody move)
    {
      const selfMove = spendSoulbound(owner, await rxdCoins(owner.address), locked as Utxo, Opcode.OP_1, [
        { script: soul, value: 1 },
      ]);
      const r = await tryBroadcast(selfMove.toString());
      console.log("SELF-MOVE accepted:", r.ok, r.err?.slice(0, 200));
      expect(r.ok).toBe(true);
      await mine(1);
      locked = await utxoByScript(soul);
      expect(locked).toBeTruthy(); // still soulbound, still owner
    }

    // BURN: try to destroy the singleton. May be rejected if the node forbids
    // singleton burn — that's acceptable; log it either way.
    {
      const burn = spendSoulbound(owner, await rxdCoins(owner.address), locked as Utxo, Opcode.OP_0, [
        { script: p2pkhScript(owner.address), value: 1 },
      ]);
      const r = await tryBroadcast(burn.toString());
      console.log("BURN path accepted:", r.ok, r.err?.slice(0, 160));
      if (r.ok) {
        await mine(1);
        expect(await utxoByScript(soul)).toBeNull();
      }
    }

    console.log("=== SOULBOUND COVENANT REGTEST PASSED ===");
  },
  600_000
);
