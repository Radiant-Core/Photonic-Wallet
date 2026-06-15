/**
 * Pins the ref-format bridge between RXinDexer's global swap-index feed and the
 * wallet's per-token swap lookups. RXinDexer emits display refs (`<txid_be>_<vout>`
 * via `_format_ref`); the wallet converts those to the 72-hex `glyph.ref` form
 * (txid big-endian + 4-byte big-endian vout) and then derives the swap tokenid by
 * hashing the *little-endian* (script-operand) ref — NOT the BE form. The canonical
 * RSWP tokenid (node `-swapindex`, RXinDexer `swap_index.py`, RadiantSwap
 * `rswp.swapTokenId`) is `sha256(ref_36)` where `ref_36` is the little-endian
 * outpoint pushed by OP_PUSHINPUTREF. Getting the byte order wrong silently routes a
 * discovered listing to the WRONG (or no) token book — and palindromic fixtures
 * would hide it, so the txid below is asymmetric.
 */
import { describe, it, expect } from "vitest";
import Outpoint from "@lib/Outpoint";
import { ContractType } from "@app/types";
import { assetToSwapTokenId, swapIndexRefToRef } from "@app/swapBroadcast";

// Asymmetric 64-hex txid (NOT a reversal-palindrome) so byte-order mistakes surface.
const TXID = "0011223344556677889900aabbccddeeff00112233445566778899aabbccddee";

describe("swapIndexRefToRef", () => {
  it("appends the vout as a 4-byte big-endian hex suffix, txid unchanged", () => {
    expect(swapIndexRefToRef(`${TXID}_3`)).toBe(`${TXID}00000003`);
    expect(swapIndexRefToRef(`${TXID}_0`)).toBe(`${TXID}00000000`);
    expect(swapIndexRefToRef(`${TXID}_258`)).toBe(`${TXID}00000102`);
  });

  it("derives the same swap tokenid the wallet queries with (sha256 of the LE ref)", () => {
    // The converted ref, run through assetToSwapTokenId, must equal sha256 of the
    // little-endian (reversed) ref — the form the node/RXinDexer/RadiantSwap all
    // hash. If this ever reverts to hashing the BE form, deep-linked listings
    // resolve to the wrong book.
    const ref72 = swapIndexRefToRef(`${TXID}_7`)!;
    expect(ref72).toBe(`${TXID}00000007`);
    expect(assetToSwapTokenId(ContractType.NFT, ref72)).toBe(
      Outpoint.fromString(ref72).reverse().refHash()
    );
    // Guard against a regression to the BE form.
    expect(assetToSwapTokenId(ContractType.NFT, ref72)).not.toBe(
      Outpoint.fromString(ref72).refHash()
    );
  });

  it("matches the canonical on-chain want_tokenid (ground-truth vector)", () => {
    // Real mainnet RSWP buy order (2026-06-14): the offer wants token
    // eef6f61e…:1, and the node's swapindex reports want_tokenid 2b568707…d589.
    // assetToSwapTokenId of the BE glyph.ref must reproduce that exact id.
    const refBE =
      "eef6f61ead482020eb15a68fb01a60543d86e711a4c055c356a8b8e458d1927300000001";
    expect(assetToSwapTokenId(ContractType.FT, refBE)).toBe(
      "2b568707d767f6fa3947ff11ec06f69414d3615882715e0b1492bf5c5d80d589"
    );
    // Type only gates the RXD short-circuit, never the hash.
    expect(assetToSwapTokenId(ContractType.NFT, refBE)).toBe(
      assetToSwapTokenId(ContractType.FT, refBE)
    );
  });

  it("returns the RXD sentinel for RXD / empty refs", () => {
    expect(assetToSwapTokenId(ContractType.RXD, undefined)).toBe("00".repeat(32));
    expect(assetToSwapTokenId(ContractType.FT, null)).toBe("00".repeat(32));
  });

  it("returns null for RXD (no ref) and malformed inputs", () => {
    expect(swapIndexRefToRef(null)).toBeNull();
    expect(swapIndexRefToRef(undefined)).toBeNull();
    expect(swapIndexRefToRef("")).toBeNull();
    expect(swapIndexRefToRef(TXID)).toBeNull(); // no "_vout"
    expect(swapIndexRefToRef(`${TXID}_x`)).toBeNull(); // non-numeric vout
    expect(swapIndexRefToRef(`zz${TXID.slice(2)}_1`)).toBeNull(); // non-hex txid
    expect(swapIndexRefToRef(`${TXID.slice(0, 63)}_1`)).toBeNull(); // short txid
  });
});
