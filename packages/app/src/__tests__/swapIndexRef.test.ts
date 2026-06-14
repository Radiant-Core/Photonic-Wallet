/**
 * Pins the ref-format bridge between RXinDexer's global swap-index feed and the
 * wallet's per-token swap lookups. RXinDexer emits display refs (`<txid_be>_<vout>`
 * via `_format_ref`); the wallet hashes the 72-hex `glyph.ref` form (txid big-endian
 * + 4-byte big-endian vout) to derive the node swapindex tokenid. Getting the byte
 * order wrong here silently routes a discovered listing to the WRONG (or no) token
 * book — and palindromic fixtures would hide it, so the txid below is asymmetric.
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

  it("produces the exact glyph.ref form the node tokenid is hashed from", () => {
    // The converted ref, hashed via refHash, must equal the tokenid the wallet
    // already uses to query owned tokens' orders (assetToSwapTokenId). If these
    // ever diverge, deep-linked listings would resolve to the wrong book.
    const ref72 = swapIndexRefToRef(`${TXID}_7`)!;
    expect(ref72).toBe(`${TXID}00000007`);
    expect(Outpoint.fromString(ref72).refHash()).toBe(
      assetToSwapTokenId(ContractType.NFT, ref72)
    );
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
