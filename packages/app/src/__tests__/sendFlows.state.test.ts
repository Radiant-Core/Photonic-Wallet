/**
 * Local Dexie-state regression tests for the send / melt / transfer fixes.
 *
 * These assert the *post-broadcast* DB-update sequences the fixed components
 * now run (SendRXD / SendFungible / SendDigitalObject / MeltFungible) leave the
 * wallet's local state correct — coins spent, glyph removed, balances refreshed
 * — rather than stale until the next background sync. They use the real
 * `@app/db` (Dexie over fake-indexeddb) and the real `@app/utxos` functions,
 * with realistic `selected` inputs/outputs (the shape coinSelect returns).
 *
 * The on-chain half — that the tx builders produce valid, accepted regtest
 * transactions — is covered by lib/src/__tests__/sendFlows.regtest.test.ts.
 *
 * No network: runs in the normal suite.
 */
import "./helpers/fakeIdb"; // must be first: real fake-indexeddb + Dexie shims
import { it, expect, beforeEach, vi } from "vitest";
vi.unmock("@app/db");

import rjs from "@radiant-core/radiantjs";
import { ftScript, nftScript, p2pkhScript } from "@lib/script";
import { reverseRef } from "@lib/Outpoint";
import { UnfinalizedInput } from "@lib/types";

import db from "@app/db";
import {
  updateWalletUtxos,
  updateRxdBalances,
  updateFtBalances,
} from "@app/utxos";
import { ContractType, SmartTokenType, TxO, SmartToken } from "@app/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks } = rjs as any;

const addr = () =>
  PrivateKey.fromRandom(Networks.regtest)
    .toAddress(Networks.regtest)
    .toString();

// A 36-byte little-endian ref (txid+index); exact value is irrelevant as long
// as ftScript/nftScript embed it and parseFtScript round-trips it.
const refLE = "ab".repeat(32) + "00000000";

const balanceTotal = async (id: string): Promise<number> => {
  const b = await db.balance.get(id);
  return b ? (b.confirmed || 0) + (b.unconfirmed || 0) : 0;
};
const sumUnspentRxd = async (): Promise<number> => {
  let sum = 0;
  await db.txo
    .where({ contractType: ContractType.RXD, spent: 0 })
    .each((t: TxO) => (sum += t.value));
  return sum;
};
async function putTxo(row: Omit<TxO, "id">): Promise<TxO> {
  const r = { ...row } as TxO;
  r.id = (await db.txo.put(r)) as number;
  return r;
}
// Mirror coinSelect's output: each selected input carries the original row
// under `.utxo` (updateWalletUtxos marks spent via input.utxo.id).
const asInput = (row: TxO) => ({ ...row, utxo: row });
// updateWalletUtxos reads only output.script/value and uses the array index as
// vout; txid/vout here are placeholders to satisfy the UnfinalizedInput type.
const out = (script: string, value: number): UnfinalizedInput => ({
  script,
  value,
  txid: "",
  vout: 0,
});

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await Promise.all([db.txo.clear(), db.glyph.clear(), db.balance.clear()]);
});

it("RXD send: marks the input spent, records change, refreshes the balance", async () => {
  const A = addr();
  const B = addr();
  const changeScript = p2pkhScript(A);

  const coin = await putTxo({
    contractType: ContractType.RXD,
    script: changeScript,
    value: 100_000_000,
    txid: "c".repeat(64),
    vout: 0,
    spent: 0,
    height: 1,
  });
  await updateRxdBalances(A);
  expect(await balanceTotal(A)).toBe(100_000_000);

  // Send 5 RXD to B (fee 1000). Same post-broadcast sequence as SendRXD.
  const txid = "d".repeat(64);
  const selected = {
    inputs: [asInput(coin)],
    outputs: [out(p2pkhScript(B), 5_000_000), out(changeScript, 94_999_000)],
  };
  await updateWalletUtxos(
    ContractType.RXD,
    changeScript,
    changeScript,
    txid,
    selected.inputs,
    selected.outputs
  );
  await updateRxdBalances(A);

  expect((await db.txo.get(coin.id!))?.spent).toBe(1); // input spent
  const after = await balanceTotal(A);
  expect(after).toBe(await sumUnspentRxd()); // not stale
  expect(after).toBe(94_999_000); // == the recorded change
});

it("FT send: FT balance drops to the change; RXD balance refreshes", async () => {
  const A = addr();
  const B = addr();
  const ref = reverseRef(refLE);
  const fromScript = ftScript(A, refLE);

  const ftRow = await putTxo({
    contractType: ContractType.FT,
    script: fromScript,
    value: 1000,
    txid: "e".repeat(64),
    vout: 0,
    spent: 0,
    height: 1,
  });
  await db.glyph.put({
    tokenType: SmartTokenType.FT,
    ref,
    lastTxoId: ftRow.id,
    spent: 0,
    fresh: 0,
    name: "E2E FT",
    type: "object",
    description: "",
    author: "",
    container: "",
    attrs: {},
    height: 1,
  } as SmartToken);
  const rxd = await putTxo({
    contractType: ContractType.RXD,
    script: p2pkhScript(A),
    value: 100_000_000,
    txid: "f".repeat(64),
    vout: 0,
    spent: 0,
    height: 1,
  });
  await updateFtBalances(new Set([fromScript]));
  await updateRxdBalances(A);
  expect(await balanceTotal(ref)).toBe(1000);
  const rxdBefore = await balanceTotal(A);

  // Send 300 FT to B; 700 FT change to A; RXD change to A.
  const txid = "1".repeat(64);
  const selected = {
    inputs: [asInput(ftRow), asInput(rxd)],
    outputs: [
      out(ftScript(B, refLE), 300),
      out(fromScript, 700),
      out(p2pkhScript(A), 99_999_000),
    ],
  };
  // Same post-broadcast sequence as SendFungible.confirmBroadcast.
  await updateWalletUtxos(
    ContractType.FT,
    fromScript,
    p2pkhScript(A),
    txid,
    selected.inputs,
    selected.outputs
  );
  await updateFtBalances(new Set([fromScript]));
  await updateRxdBalances(A);

  expect((await db.txo.get(ftRow.id!))?.spent).toBe(1);
  expect(await balanceTotal(ref)).toBe(700); // FT balance == change, not stale 1000
  const rxdAfter = await balanceTotal(A);
  expect(rxdAfter).toBe(await sumUnspentRxd());
  expect(rxdAfter).toBeLessThan(rxdBefore);
});

it("FT melt: FT balance drops to 0 (was stale before the fix)", async () => {
  const A = addr();
  const ref = reverseRef(refLE);
  const fromScript = ftScript(A, refLE);

  const ftRow = await putTxo({
    contractType: ContractType.FT,
    script: fromScript,
    value: 500,
    txid: "2".repeat(64),
    vout: 0,
    spent: 0,
    height: 1,
  });
  await db.glyph.put({
    tokenType: SmartTokenType.FT,
    ref,
    lastTxoId: ftRow.id,
    spent: 0,
    fresh: 0,
    name: "E2E MELT",
    type: "object",
    description: "",
    author: "",
    container: "",
    attrs: {},
    height: 1,
  } as SmartToken);
  const rxd = await putTxo({
    contractType: ContractType.RXD,
    script: p2pkhScript(A),
    value: 100_000_000,
    txid: "3".repeat(64),
    vout: 0,
    spent: 0,
    height: 1,
  });
  await updateFtBalances(new Set([fromScript]));
  expect(await balanceTotal(ref)).toBe(500);

  // Melt: spend FT + RXD, no FT output (only RXD change).
  const txid = "4".repeat(64);
  const selected = {
    inputs: [asInput(ftRow), asInput(rxd)],
    outputs: [out(p2pkhScript(A), 100_000_499)],
  };
  // Same post-broadcast sequence as MeltFungible.
  await updateWalletUtxos(
    ContractType.FT,
    fromScript,
    p2pkhScript(A),
    txid,
    selected.inputs,
    selected.outputs
  );
  await updateFtBalances(new Set([fromScript]));
  await updateRxdBalances(A);

  expect((await db.txo.get(ftRow.id!))?.spent).toBe(1);
  expect(await balanceTotal(ref)).toBe(0); // before the fix this stayed at 500
});

it("NFT send: glyph marked spent, NFT input spent, RXD balance refreshed", async () => {
  const A = addr();
  const B = addr();
  const ref = reverseRef(refLE);
  const changeScript = p2pkhScript(A);

  const nftRow = await putTxo({
    contractType: ContractType.NFT,
    script: nftScript(A, refLE),
    value: 1,
    txid: "5".repeat(64),
    vout: 0,
    spent: 0,
    height: 1,
  });
  await db.glyph.put({
    tokenType: SmartTokenType.NFT,
    ref,
    lastTxoId: nftRow.id,
    spent: 0,
    fresh: 0,
    name: "E2E NFT",
    type: "object",
    description: "",
    author: "",
    container: "",
    attrs: {},
    height: 1,
  } as SmartToken);
  const rxd = await putTxo({
    contractType: ContractType.RXD,
    script: changeScript,
    value: 100_000_000,
    txid: "6".repeat(64),
    vout: 0,
    spent: 0,
    height: 1,
  });
  await updateRxdBalances(A);
  const rxdBefore = await balanceTotal(A);
  expect((await db.glyph.get({ ref }))?.spent).toBe(0);

  // Cross-send: NFT to B, RXD change to A. Same sequence as SendDigitalObject.
  const txid = "7".repeat(64);
  const selected = {
    inputs: [asInput(nftRow), asInput(rxd)],
    outputs: [out(nftScript(B, refLE), 1), out(changeScript, 99_999_000)],
  };
  await db.glyph.where({ lastTxoId: nftRow.id }).modify({ spent: 1 });
  await updateWalletUtxos(
    ContractType.RXD,
    changeScript,
    changeScript,
    txid,
    selected.inputs,
    selected.outputs
  );
  await updateRxdBalances(A);

  // The grid filters on glyph.spent — the NFT leaves the wallet immediately.
  expect((await db.glyph.get({ ref }))?.spent).toBe(1);
  expect((await db.txo.get(nftRow.id!))?.spent).toBe(1);
  const rxdAfter = await balanceTotal(A);
  expect(rxdAfter).toBe(await sumUnspentRxd());
  expect(rxdAfter).toBeLessThan(rxdBefore);
});
