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
// jsdom). syncCovenants only calls getUtxosByScriptHash. vi.hoisted lets the
// mock factory (hoisted to the top) reference the fn safely.
const { getUtxosByScriptHash } = vi.hoisted(() => ({
  getUtxosByScriptHash: vi.fn(),
}));
vi.mock("@app/electrum/Electrum", () => ({
  electrumWorker: { value: { getUtxosByScriptHash } },
}));

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
  encodeListingDescriptor,
  decodeListingDescriptor,
  listingDescriptorFromCovenant,
  ListingDescriptor,
} from "@app/covenant";

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
