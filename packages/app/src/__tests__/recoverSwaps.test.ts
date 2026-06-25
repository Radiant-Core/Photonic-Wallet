/**
 * Unit tests for recoverSwaps() — the swap analogue of discoverCovenants that
 * rebuilds a lost/never-written db.swap row from an on-chain swap-address UTXO,
 * materialises a byRef txo, and repoints the glyph so a reserved token reappears
 * in My Swaps with a working Cancel (and renders as listed, not a phantom).
 *
 * The on-chain half (indexer discovery at a non-zero vout + vout-aware cancel)
 * is proven against the real node/indexer in
 * lib/src/__tests__/swapAddressRecovery.regtest.test.ts.
 */
import "./helpers/fakeIdb"; // must be first
import { it, expect, beforeEach, vi } from "vitest";

const { findSwaps, fetchGlyph } = vi.hoisted(() => ({
  findSwaps: vi.fn(),
  fetchGlyph: vi.fn(),
}));
vi.unmock("@app/db");
vi.mock("@app/electrum/Electrum", () => ({
  electrumWorker: { value: { findSwaps, fetchGlyph } },
}));

import rjs from "@radiant-core/radiantjs";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import Outpoint from "@lib/Outpoint";
import { deriveAccountFromHdKey } from "@lib/wallet";
import { SecretBytes } from "@app/secretBytes";
import db from "@app/db";
import { electrumStatus, wallet } from "@app/signals";
import {
  ContractType,
  ElectrumStatus,
  SwapStatus,
  SmartTokenType,
} from "@app/types";
import { recoverSwaps } from "@app/swap";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks } = rjs as any;

const swapKey = PrivateKey.fromRandom(Networks.regtest);
const SWAP_ADDR = swapKey.toAddress(Networks.regtest).toString();
const MAIN_ADDR = PrivateKey.fromRandom(Networks.regtest)
  .toAddress(Networks.regtest)
  .toString();

// A reserved NFT UTXO at the swap address, at a NON-ZERO vout, as findSwaps
// would return it (refs carry `<txidBE>i<vout>`).
const SWAP_TXID = "a".repeat(64);
const REF_SHORT = "b".repeat(64) + "i0";
const REF_BE = Outpoint.fromShortInput(REF_SHORT).toString();

beforeEach(async () => {
  await db.swap.clear();
  await db.txo.clear();
  await db.glyph.clear();
  findSwaps.mockReset();
  fetchGlyph.mockReset();
  wallet.value = {
    ...wallet.value,
    address: MAIN_ADDR,
    swapAddress: SWAP_ADDR,
    net: "testnet" as any,
    mnemonic: undefined, // locked by default; dual-coin-type test sets it
    swapWif: undefined,
    locked: false,
  } as any;
  electrumStatus.value = ElectrumStatus.CONNECTED;
});

function nftReserve(tx_pos: number) {
  return {
    contractType: ContractType.NFT,
    utxo: {
      tx_hash: SWAP_TXID,
      tx_pos,
      value: 1,
      height: 100,
      refs: [{ ref: REF_SHORT, type: "single" }],
    },
  };
}

it("recreates a PENDING recovery db.swap row, materialises a byRef txo, and flags the glyph listed", async () => {
  await db.glyph.put({ ref: REF_BE, name: "Stuck NFT", tokenType: SmartTokenType.NFT, spent: 0 } as any);
  findSwaps.mockResolvedValue([nftReserve(1)]);

  await recoverSwaps();

  const swap = await db.swap.where({ txid: SWAP_TXID }).first();
  expect(swap).toBeTruthy();
  expect(swap!.status).toBe(SwapStatus.PENDING);
  expect(swap!.recovered).toBe(true);
  expect(swap!.vout).toBe(1); // the real non-zero vout, for a working Cancel
  expect(swap!.from).toBe(ContractType.NFT);
  expect(swap!.fromGlyph).toBe(REF_BE);
  expect(swap!.fromValue).toBe(1);
  expect(swap!.tx).toBe(""); // no PSRT — Cancel-only

  const txo = await db.txo.where({ txid: SWAP_TXID, vout: 1 }).first();
  expect(txo).toBeTruthy();
  expect(txo!.byRef).toBe(1);
  expect(txo!.spent).toBe(0);
  expect(txo!.contractType).toBe(ContractType.NFT);

  const glyph = await db.glyph.where({ ref: REF_BE }).first();
  expect(glyph!.swapPending).toBe(true);
  expect(glyph!.spent).toBe(0);
  expect(glyph!.lastTxoId).toBe(txo!.id);
});

it("recovers an FT reserve as a Cancel-able record WITHOUT materialising a byRef txo", async () => {
  // A byRef FT txo would be summed/swept by FT balance + consolidation paths
  // (which exclude byRef only on the main sweep), so FT swaps are tracked by the
  // db.swap record alone.
  findSwaps.mockResolvedValue([
    {
      contractType: ContractType.FT,
      utxo: { tx_hash: SWAP_TXID, tx_pos: 1, value: 500, height: 100, refs: [{ ref: REF_SHORT, type: "normal" }] },
    },
  ]);

  await recoverSwaps();

  const swap = await db.swap.where({ txid: SWAP_TXID }).first();
  expect(swap).toBeTruthy();
  expect(swap!.from).toBe(ContractType.FT);
  expect(swap!.recovered).toBe(true);
  expect(swap!.vout).toBe(1);
  expect(swap!.fromValue).toBe(500);
  // No byRef txo for the FT reserve — it must NOT enter balance/consolidation.
  expect(await db.txo.where({ txid: SWAP_TXID }).count()).toBe(0);
});

it("is idempotent — a second pass does not duplicate the record", async () => {
  await db.glyph.put({ ref: REF_BE, name: "Stuck NFT", tokenType: SmartTokenType.NFT, spent: 0 } as any);
  findSwaps.mockResolvedValue([nftReserve(1)]);

  await recoverSwaps();
  await recoverSwaps();

  expect(await db.swap.where({ txid: SWAP_TXID }).count()).toBe(1);
});

it("skips a UTXO already tracked by an existing db.swap row", async () => {
  findSwaps.mockResolvedValue([nftReserve(1)]);
  await db.swap.put({
    txid: SWAP_TXID,
    vout: 1,
    tx: "deadbeef",
    from: ContractType.NFT,
    fromGlyph: REF_BE,
    fromValue: 1,
    to: ContractType.RXD,
    toGlyph: null,
    toValue: 0,
    status: SwapStatus.PENDING,
    date: 1,
  } as any);

  await recoverSwaps();

  const rows = await db.swap.where({ txid: SWAP_TXID }).toArray();
  expect(rows.length).toBe(1);
  expect(rows[0].tx).toBe("deadbeef"); // original untouched, not overwritten
  expect(rows[0].recovered).toBeUndefined();
});

it("scans BOTH coin-type swap addresses (unlocked) and records the holding address", async () => {
  // Wallet is unlocked: its mnemonic lets recoverSwaps derive the swap address
  // under each coin type. The NFT is stranded at coin type 0's swap address
  // (the OTHER one) while the resolved swap address is coin type 512's.
  const MNEMONIC =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  const swap0 = deriveAccountFromHdKey(hd, "testnet" as any, 0).swapAddress;
  const swap512 = deriveAccountFromHdKey(hd, "testnet" as any, 512).swapAddress;
  expect(swap0).not.toBe(swap512);

  wallet.value = {
    ...wallet.value,
    address: MAIN_ADDR,
    swapAddress: swap512, // resolved coin type
    net: "testnet" as any,
    mnemonic: SecretBytes.fromString(MNEMONIC),
    locked: false,
  } as any;

  // findSwaps returns the reserve ONLY for the OTHER coin type's swap address.
  findSwaps.mockImplementation(async (addr: string) =>
    addr === swap0
      ? [
          {
            contractType: ContractType.NFT,
            utxo: { tx_hash: SWAP_TXID, tx_pos: 1, value: 1, height: 100, refs: [{ ref: REF_SHORT, type: "single" }] },
          },
        ]
      : []
  );
  await db.glyph.put({ ref: REF_BE, name: "Stranded", tokenType: SmartTokenType.NFT, spent: 0 } as any);

  await recoverSwaps();

  // It scanned both addresses (resolved + both coin types -> {swap512, swap0}).
  const scanned = findSwaps.mock.calls.map((c: any[]) => c[0]);
  expect(scanned).toContain(swap0);
  expect(scanned).toContain(swap512);

  const swap = await db.swap.where({ txid: SWAP_TXID }).first();
  expect(swap).toBeTruthy();
  expect(swap!.swapAddress).toBe(swap0); // the address that actually holds it
  expect(swap!.recovered).toBe(true);
});

it("does nothing when disconnected or without a swap address", async () => {
  findSwaps.mockResolvedValue([nftReserve(1)]);
  electrumStatus.value = ElectrumStatus.DISCONNECTED;
  await recoverSwaps();
  expect(findSwaps).not.toHaveBeenCalled();

  electrumStatus.value = ElectrumStatus.CONNECTED;
  wallet.value = { ...wallet.value, swapAddress: "" } as any;
  await recoverSwaps();
  expect(findSwaps).not.toHaveBeenCalled();
});
