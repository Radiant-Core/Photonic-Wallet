import { describe, it, expect } from "vitest";
import { isTokenBearing } from "../script";
import { coinSelect, fundTx } from "../coinSelect";

// 25-byte P2PKH with a configurable pubkey-hash byte
const P2PKH = (h = "00") => `76a914${h.repeat(20)}88ac`;
// 63-byte NFT singleton: d8 <ref:36> OP_DROP <P2PKH>
const NFT = `d8${"11".repeat(36)}7576a914${"00".repeat(20)}88ac`;
// 75-byte FT holder: <P2PKH> bd d0 <ref:36> <12-byte epilogue>
const FT = `76a914${"00".repeat(
  20
)}88acbdd0${"11".repeat(36)}dec0e9aa76e378e4a269e69d`;

describe("isTokenBearing", () => {
  it("plain P2PKH is not token-bearing", () => {
    expect(isTokenBearing(P2PKH("00"))).toBe(false);
  });

  it("P2PKH whose pubkey hash is all 0xd0-0xd8 bytes is NOT a false positive", () => {
    // Every payload byte is in the ref-opcode range, but the 0x14 push
    // announces them as data — an opcode-aware walker must skip them.
    expect(isTokenBearing(P2PKH("d8"))).toBe(false);
    expect(
      isTokenBearing(
        "76a914" + "d0d1d2d3d4d5d6d7d8d0d1d2d3d4d5d6d7d8d0d1" + "88ac"
      )
    ).toBe(false);
  });

  it("NFT singleton (d8) and FT holder (d0) are token-bearing", () => {
    expect(isTokenBearing(NFT)).toBe(true);
    expect(isTokenBearing(FT)).toBe(true);
  });

  it("empty and truncated scripts are not flagged", () => {
    expect(isTokenBearing("")).toBe(false);
    expect(isTokenBearing("4c")).toBe(false); // truncated OP_PUSHDATA1
  });
});

describe("coin selection refuses token UTXOs as funding (burn guard)", () => {
  const addr = "mock-address";
  const rxd = {
    txid: "aa".repeat(32),
    vout: 0,
    script: P2PKH("00"),
    value: 1_000_000,
    scriptSigSize: 107,
  };
  const nft = {
    txid: "bb".repeat(32),
    vout: 0,
    script: NFT,
    value: 1000,
    scriptSigSize: 107,
  };
  const ft = {
    txid: "cc".repeat(32),
    vout: 0,
    script: FT,
    value: 1000,
    scriptSigSize: 107,
  };
  const target = [{ script: P2PKH("22"), value: 1000 }];
  const change = P2PKH("33");

  it("fundTx throws if a token UTXO is in the discretionary funding pool", () => {
    expect(() => fundTx(addr, [nft], [], target, change, 1000)).toThrow(/burn/);
    expect(() => fundTx(addr, [ft], [], target, change, 1000)).toThrow(/burn/);
  });

  it("fundTx allows a token UTXO as an explicit requiredInput (deliberate token spend)", () => {
    expect(() =>
      fundTx(addr, [rxd], [nft], target, change, 1000)
    ).not.toThrow();
  });

  it("coinSelect throws on a discretionary token input", () => {
    expect(() => coinSelect(addr, [nft], target, change, 1000)).toThrow(/burn/);
  });
});
