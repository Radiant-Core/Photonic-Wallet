import { describe, it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import {
  encodeExpiryHeight,
  innerSwapScript,
  swapRefundScript,
  isSwapRefundScript,
  parseSwapRefundScript,
  buildRefundScriptSig,
  appendSwapSelector,
  isOfferExpiredByHeight,
  SWAP_REFUND_SWAP_SELECTOR,
  SWAP_REFUND_REFUND_SELECTOR,
  SWAP_EXPIRY_LOCKTIME_THRESHOLD,
} from "../swapRefundCovenant";
import { p2pkhScript, ftScript, nftScript } from "../script";

const { Script } = rjs;

// Regtest/mainnet P2PKH address (radiantjs compatible).
const swapAddress = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
// Dummy 36-byte ref in little-endian hex (72 chars).
const refLE = "a1".repeat(36);

describe("encodeExpiryHeight", () => {
  it("minimally encodes a small height (LE, no pad)", () => {
    // 410000 = 0x064190 -> LE bytes 90 41 06 ; top bit of 0x06 clear -> 3 bytes
    expect(encodeExpiryHeight(410000).toString("hex")).toBe("904106");
  });

  it("pads when the top bit of the last byte is set", () => {
    // 0x80 = 128 -> LE 80 ; top bit set -> append 00
    expect(encodeExpiryHeight(128).toString("hex")).toBe("8000");
  });

  it("rejects zero / negative / non-integer", () => {
    expect(() => encodeExpiryHeight(0)).toThrow();
    expect(() => encodeExpiryHeight(-1)).toThrow();
    expect(() => encodeExpiryHeight(1.5)).toThrow();
  });

  it("rejects a value at/above the timestamp threshold", () => {
    expect(() => encodeExpiryHeight(SWAP_EXPIRY_LOCKTIME_THRESHOLD)).toThrow();
  });
});

describe("innerSwapScript", () => {
  it("RXD inner script is exactly p2pkhScript(swapAddress)", () => {
    expect(innerSwapScript("rxd", swapAddress)).toBe(
      p2pkhScript(swapAddress)
    );
  });

  it("FT inner script is exactly ftScript(swapAddress, ref)", () => {
    expect(innerSwapScript("ft", swapAddress, refLE)).toBe(
      ftScript(swapAddress, refLE)
    );
  });

  it("NFT inner script is exactly nftScript(swapAddress, ref)", () => {
    expect(innerSwapScript("nft", swapAddress, refLE)).toBe(
      nftScript(swapAddress, refLE)
    );
  });

  it("token inner script requires a 72-hex ref", () => {
    expect(() => innerSwapScript("ft", swapAddress)).toThrow();
    expect(() => innerSwapScript("nft", swapAddress, "ab")).toThrow();
  });
});

describe("swapRefundScript layout + round-trip", () => {
  it("RXD: IF <inner> ELSE <expiry> CLTV DROP <inner> ENDIF", () => {
    const expiryHeight = 410000;
    const inner = p2pkhScript(swapAddress);
    const script = swapRefundScript({
      assetType: "rxd",
      swapAddress,
      expiryHeight,
    });

    // Exact wire bytes: 63 <inner> 67 03 904106 b1 75 <inner> 68
    const expected =
      "63" + inner + "67" + "03904106" + "b175" + inner + "68";
    expect(script).toBe(expected);

    // radiantjs accepts it as a well-formed script.
    expect(() => Script.fromHex(script)).not.toThrow();
  });

  it("FT covenant round-trips through the parser", () => {
    const expiryHeight = 555_555;
    const inner = ftScript(swapAddress, refLE);
    const script = swapRefundScript({
      assetType: "ft",
      swapAddress,
      expiryHeight,
      refLE,
    });
    expect(isSwapRefundScript(script)).toBe(true);
    const parsed = parseSwapRefundScript(script);
    expect(parsed).not.toBeNull();
    expect(parsed!.expiryHeight).toBe(expiryHeight);
    expect(parsed!.innerScript).toBe(inner);
  });

  it("NFT covenant round-trips and preserves the singleton ref", () => {
    const expiryHeight = 1_048_576; // needs 3 bytes
    const inner = nftScript(swapAddress, refLE);
    const script = swapRefundScript({
      assetType: "nft",
      swapAddress,
      expiryHeight,
      refLE,
    });
    const parsed = parseSwapRefundScript(script);
    expect(parsed!.expiryHeight).toBe(expiryHeight);
    expect(parsed!.innerScript).toBe(inner);
    // The singleton ref must still be embedded (consensus carries it forward).
    expect(parsed!.innerScript.includes(refLE)).toBe(true);
  });
});

describe("parse rejects non-covenant scripts", () => {
  it("returns null / false for a plain P2PKH", () => {
    const plain = p2pkhScript(swapAddress);
    expect(isSwapRefundScript(plain)).toBe(false);
    expect(parseSwapRefundScript(plain)).toBeNull();
  });

  it("returns null for a covenant whose two inner branches differ", () => {
    // Hand-craft IF <innerA> ELSE <expiry> CLTV DROP <innerB> ENDIF where
    // innerA != innerB. Such a script is NOT a valid refund covenant.
    const a = p2pkhScript(swapAddress);
    const b = p2pkhScript("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2");
    const tampered = "63" + a + "67" + "03904106" + "b175" + b + "68";
    expect(isSwapRefundScript(tampered)).toBe(false);
    expect(parseSwapRefundScript(tampered)).toBeNull();
  });
});

describe("scriptSig builders / selectors", () => {
  it("refund scriptSig is <sig> <pubkey> OP_0", () => {
    const sig = Buffer.from("30" + "44" + "00".repeat(0x44) + "41", "hex"); // dummy DER+type
    const pub = Buffer.from("02" + "ab".repeat(32), "hex");
    const ss = buildRefundScriptSig(sig, pub);
    // Must END in the OP_0 selector (0x00) after sig+pubkey pushes.
    expect(ss.endsWith("00")).toBe(true);
    expect(ss).toContain(pub.toString("hex"));
  });

  it("swap selector appends OP_1 to a pre-signed inner scriptSig", () => {
    // A minimal valid push-only scriptSig: push 1 byte 0xab.
    const innerSig = "01ab";
    const ss = appendSwapSelector(innerSig);
    expect(ss).toBe("01ab51"); // ...<innerSig> 51 (OP_1)
    expect(SWAP_REFUND_SWAP_SELECTOR).toBe("51");
    expect(SWAP_REFUND_REFUND_SELECTOR).toBe("00");
  });
});

describe("isOfferExpiredByHeight", () => {
  it("v2 offers (no expiry_height) are never expired", () => {
    expect(isOfferExpiredByHeight(undefined, 500_000)).toBe(false);
    expect(isOfferExpiredByHeight(0, 500_000)).toBe(false);
  });

  it("not expired before the height, expired at/after it", () => {
    expect(isOfferExpiredByHeight(410_000, 409_999)).toBe(false);
    expect(isOfferExpiredByHeight(410_000, 410_000)).toBe(true);
    expect(isOfferExpiredByHeight(410_000, 410_001)).toBe(true);
  });

  it("unknown chain tip is treated as not-expired (fail-open, like soft expiry)", () => {
    expect(isOfferExpiredByHeight(410_000, 0)).toBe(false);
    expect(isOfferExpiredByHeight(410_000, NaN)).toBe(false);
  });
});
