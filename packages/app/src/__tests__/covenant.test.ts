/**
 * Unit tests for the local covenant tracking added for the app-side covenant
 * integration (covenant.ts). Covers the listing-descriptor round-trip (the
 * private buy-listing sharing format) and the db tracking + reconciliation
 * (recordCovenant / syncCovenants) using the real Dexie over fake-indexeddb.
 *
 * The on-chain half (list/buy/cancel and soulbound/authority mint emission) is
 * proven against the real interpreter in lib/src/__tests__/*.regtest.test.ts.
 */
import "./helpers/fakeIdb"; // must be first: real fake-indexeddb + Dexie shims
import { it, expect, beforeEach, vi } from "vitest";
import { ElectrumStatus } from "@app/types";

vi.unmock("@app/db");

// Mock the electrum worker proxy (real module spins up a Worker, unavailable in
// jsdom). syncCovenants uses getUtxosByScriptHash; discoverCovenants also uses
// getTransaction + fetchGlyph. vi.hoisted lets the mock factory (hoisted to the
// top) reference the fns safely.
const { getUtxosByScriptHash, getTransaction, fetchGlyph } = vi.hoisted(() => ({
  getUtxosByScriptHash: vi.fn(),
  getTransaction: vi.fn(),
  fetchGlyph: vi.fn(),
}));
vi.mock("@app/electrum/Electrum", () => ({
  electrumWorker: {
    value: { getUtxosByScriptHash, getTransaction, fetchGlyph },
  },
}));

import rjs from "@radiant-core/radiantjs";
import { soulboundNftScript } from "@lib/soulbound";
import { reverseRef } from "@lib/Outpoint";
import { scriptHash as scriptToHash } from "@lib/script";
import db from "@app/db";
import { electrumStatus } from "@app/signals";
import {
  CovenantStatus,
  CovenantType,
  CovenantRecord,
  SmartTokenType,
} from "@app/types";
import {
  recordCovenant,
  syncCovenants,
  discoverCovenants,
  encodeListingDescriptor,
  decodeListingDescriptor,
  listingDescriptorFromCovenant,
  ListingDescriptor,
} from "@app/covenant";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks } = rjs as any;

// Minimal valid serialized tx (1 dummy input, 1 output) carrying `scriptHex` at
// vout 0 — enough for `new Transaction(hex).outputs[0].script`.
function makeTxHex(scriptHex: string, value: number): string {
  const valueLE = Buffer.alloc(8);
  valueLE.writeBigUInt64LE(BigInt(value));
  const scriptBuf = Buffer.from(scriptHex, "hex");
  return (
    "01000000" + // version
    "01" + // vin count
    "00".repeat(32) + // prev txid
    "ffffffff" + // prev vout
    "00" + // scriptSig len 0
    "ffffffff" + // sequence
    "01" + // vout count
    valueLE.toString("hex") +
    scriptBuf.length.toString(16).padStart(2, "0") + // scriptPubKey len (<253)
    scriptHex +
    "00000000" // locktime
  );
}

// A well-formed (non-empty) script hex; scriptHash() only needs valid hex.
const SCRIPT = "d8" + "ab".repeat(36) + "75ac";
const REF = "cd".repeat(32) + "00000000";

const baseTerms = {
  ref: "ef".repeat(32) + "00000000",
  sellerAddress: "mxSellerAddrxxxxxxxxxxxxxxxxxxx",
  sellerScript: "76a914" + "11".repeat(20) + "88ac",
  price: 1_000_000_000,
  royalties: [
    { script: "76a914" + "22".repeat(20) + "88ac", value: 50_000_000 },
  ],
};

beforeEach(async () => {
  await db.covenant.clear();
  await db.glyph.clear();
  getUtxosByScriptHash.mockReset();
  getTransaction.mockReset();
  fetchGlyph.mockReset();
  electrumStatus.value = ElectrumStatus.CONNECTED;
});

it("listing descriptor round-trips and rejects malformed input", () => {
  const d: ListingDescriptor = {
    ref: REF,
    name: "Test NFT",
    covenantUtxo: { txid: "aa".repeat(32), vout: 0, script: SCRIPT, value: 1 },
    terms: baseTerms,
  };
  const encoded = encodeListingDescriptor(d);
  expect(typeof encoded).toBe("string");
  const decoded = decodeListingDescriptor(encoded);
  expect(decoded).toEqual(d);

  expect(() => decodeListingDescriptor("not-base64-json")).toThrow();
  // Valid base64 JSON but wrong shape.
  expect(() =>
    decodeListingDescriptor(btoa(JSON.stringify({ foo: 1 })))
  ).toThrow();
});

it("recordCovenant inserts ACTIVE and dedups on [txid+vout]", async () => {
  const id1 = await recordCovenant({
    type: CovenantType.ROYALTY_LISTING,
    ref: REF,
    txid: "bb".repeat(32),
    vout: 0,
    script: SCRIPT,
    value: 1,
    ownerAddress: "mxOwner",
    terms: baseTerms,
  });
  const row = (await db.covenant.get(id1)) as CovenantRecord;
  expect(row.status).toBe(CovenantStatus.ACTIVE);
  expect(typeof row.date).toBe("number");

  // Same outpoint → update, not a second row.
  const id2 = await recordCovenant({
    type: CovenantType.ROYALTY_LISTING,
    ref: REF,
    txid: "bb".repeat(32),
    vout: 0,
    script: SCRIPT,
    value: 1,
    ownerAddress: "mxOwner",
    terms: { ...baseTerms, price: 2_000_000_000 },
  });
  expect(id2).toBe(id1);
  expect(await db.covenant.count()).toBe(1);
  const updated = (await db.covenant.get(id1)) as CovenantRecord;
  expect(updated.terms?.price).toBe(2_000_000_000);
});

it("listingDescriptorFromCovenant builds a descriptor (or undefined without terms)", async () => {
  const id = await recordCovenant({
    type: CovenantType.ROYALTY_LISTING,
    ref: REF,
    txid: "cc".repeat(32),
    vout: 1,
    script: SCRIPT,
    value: 1,
    ownerAddress: "mxOwner",
    terms: baseTerms,
  });
  const cov = (await db.covenant.get(id)) as CovenantRecord;
  const d = listingDescriptorFromCovenant(cov, "Named");
  expect(d?.name).toBe("Named");
  expect(d?.covenantUtxo.txid).toBe("cc".repeat(32));
  expect(d?.terms.price).toBe(baseTerms.price);

  const soulbound = { ...cov, terms: undefined };
  expect(listingDescriptorFromCovenant(soulbound)).toBeUndefined();
});

it("syncCovenants resolves a listing whose covenant UTXO is gone and clears the glyph flag", async () => {
  // Glyph for the listed token, flagged pending.
  await db.glyph.put({
    ref: REF,
    tokenType: SmartTokenType.NFT,
    spent: 1,
    fresh: 0,
    name: "Listed",
    type: "object",
    description: "",
    author: "",
    container: "",
    attrs: {},
    swapPending: true,
  });
  const id = await recordCovenant({
    type: CovenantType.ROYALTY_LISTING,
    ref: REF,
    txid: "dd".repeat(32),
    vout: 0,
    script: SCRIPT,
    value: 1,
    ownerAddress: "mxOwner",
    terms: baseTerms,
  });

  // Indexer reports the covenant UTXO no longer unspent (bought/cancelled).
  getUtxosByScriptHash.mockResolvedValue([]);
  await syncCovenants();

  const row = (await db.covenant.get(id)) as CovenantRecord;
  expect(row.status).toBe(CovenantStatus.RESOLVED);
  const glyph = await db.glyph.where({ ref: REF }).first();
  expect(glyph?.swapPending).toBe(false);
});

it("discoverCovenants adopts an owned soulbound UTXO and un-hides its glyph", async () => {
  // A real, valid address so soulboundNftScript() can build its P2PKH branches.
  const owner = PrivateKey.fromRandom(Networks.testnet)
    .toAddress(Networks.testnet)
    .toString();
  const refLE = "ab".repeat(32) + "00000000";
  const refBE = reverseRef(refLE);
  const soulScript = soulboundNftScript(owner, refLE);
  const txid = "f0".repeat(32);

  // Pre-seed a HIDDEN glyph row (as if seen once then lost from the active set).
  await db.glyph.put({
    ref: refBE,
    tokenType: SmartTokenType.NFT,
    spent: 1,
    fresh: 0,
    name: "Soulbound",
    type: "object",
    description: "",
    author: "",
    container: "",
    attrs: {},
    swapPending: false,
  });

  // Indexer returns the soulbound UTXO under the owner-stable scripthash; the
  // authority sweep's scripthash returns nothing.
  const soulHash = scriptToHash(soulboundNftScript(owner, "00".repeat(36)));
  getUtxosByScriptHash.mockImplementation(async (sh: string) =>
    sh === soulHash ? [{ tx_hash: txid, tx_pos: 0, height: 50, value: 1 }] : []
  );
  getTransaction.mockResolvedValue(makeTxHex(soulScript, 1));
  fetchGlyph.mockResolvedValue(undefined);

  await discoverCovenants(owner);

  // A covenant record was adopted...
  const cov = await db.covenant.where({ ref: refBE }).first();
  expect(cov?.type).toBe(CovenantType.SOULBOUND);
  expect(cov?.txid).toBe(txid);
  expect(cov?.script).toBe(soulScript);
  expect(cov?.status).toBe(CovenantStatus.ACTIVE);
  // ...a byRef txo was synthesised for the covenant UTXO (so the grid renders it)...
  const txo = await db.txo.where({ txid, vout: 0 }).first();
  expect(txo).toBeTruthy();
  expect(txo?.value).toBe(1);
  expect(txo?.height).toBe(50);
  expect(txo?.byRef).toBe(1);
  // ...and the glyph is visible, linked to that txo, and flagged covenant-held.
  const glyph = await db.glyph.where({ ref: refBE }).first();
  expect(glyph?.spent).toBe(0);
  expect(glyph?.swapPending).toBe(true);
  expect(glyph?.lastTxoId).toBe(txo?.id);

  // Idempotent: a second sweep doesn't create a duplicate (outpoint known).
  await discoverCovenants(owner);
  expect(await db.covenant.where({ ref: refBE }).count()).toBe(1);
});

it("discoverCovenants ignores a UTXO whose script isn't our covenant", async () => {
  const owner = PrivateKey.fromRandom(Networks.testnet)
    .toAddress(Networks.testnet)
    .toString();
  const attacker = PrivateKey.fromRandom(Networks.testnet)
    .toAddress(Networks.testnet)
    .toString();
  // A soulbound script for a DIFFERENT owner (rebuild check must reject it).
  const foreign = soulboundNftScript(attacker, "cc".repeat(32) + "00000000");
  getUtxosByScriptHash.mockResolvedValue([
    { tx_hash: "ab".repeat(32), tx_pos: 0, height: 1, value: 1 },
  ]);
  getTransaction.mockResolvedValue(makeTxHex(foreign, 1));

  await discoverCovenants(owner);
  expect(await db.covenant.count()).toBe(0);
});

it("syncCovenants leaves a listing ACTIVE while its covenant UTXO is still unspent", async () => {
  const id = await recordCovenant({
    type: CovenantType.ROYALTY_LISTING,
    ref: REF,
    txid: "ee".repeat(32),
    vout: 2,
    script: SCRIPT,
    value: 1,
    ownerAddress: "mxOwner",
    terms: baseTerms,
  });
  getUtxosByScriptHash.mockResolvedValue([
    { tx_hash: "ee".repeat(32), tx_pos: 2, height: 100, value: 1 },
  ]);
  await syncCovenants();
  const row = (await db.covenant.get(id)) as CovenantRecord;
  expect(row.status).toBe(CovenantStatus.ACTIVE);
});
