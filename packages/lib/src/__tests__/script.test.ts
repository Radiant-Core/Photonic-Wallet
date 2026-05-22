import { describe, it, expect } from "vitest";
import {
  scriptHash,
  p2pkhScript,
  payToScript,
  isP2pkh,
  p2pkhScriptHash,
  nftScript,
} from "../script";

// Real Satoshi-era P2PKH address (radiantjs-compatible Base58check).
const VALID_P2PKH = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

describe("scriptHash", () => {
  it("hashes a non-empty hex string and returns 64 hex chars", () => {
    const h = scriptHash("76a914" + "00".repeat(20) + "88ac");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws on empty input — guards against silent-empty-script bugs", () => {
    // The audit (R18) flagged that callers fed "" into scriptHash, producing
    // a meaningless constant. The guard must trip instead.
    expect(() => scriptHash("")).toThrow(/empty script/);
  });
});

describe("p2pkhScript / payToScript / nftScript — error propagation (R18)", () => {
  it("p2pkhScript returns a valid script for a real address", () => {
    const s = p2pkhScript(VALID_P2PKH);
    expect(s).toMatch(/^76a914[0-9a-f]{40}88ac$/);
  });

  it('p2pkhScript THROWS on invalid input (previously returned "")', () => {
    expect(() => p2pkhScript("not-an-address")).toThrow(/invalid address/i);
    expect(() => p2pkhScript("")).toThrow(/invalid address/i);
  });

  it("payToScript THROWS on invalid input", () => {
    expect(() => payToScript("definitely-not-a-real-address")).toThrow(
      /invalid address/i
    );
  });

  it("nftScript THROWS on bad ref/address", () => {
    expect(() => nftScript(VALID_P2PKH, "not-hex")).toThrow(
      /invalid address\/ref/i
    );
  });

  it("p2pkhScriptHash propagates the throw end-to-end", () => {
    // The whole point of R18: a buggy caller can no longer subscribe to a
    // meaningless dead script hash via a "" sentinel.
    expect(() => p2pkhScriptHash("garbage")).toThrow();
  });
});

describe("isP2pkh — still returns false (correct semantics)", () => {
  it("returns true for a real P2PKH address", () => {
    expect(isP2pkh(VALID_P2PKH)).toBe(true);
  });

  it("returns false for invalid input — boolean predicate, not throwing", () => {
    // isP2pkh is documented as a validation predicate; the try/catch → false
    // is intentional and must NOT be changed to throw.
    expect(isP2pkh("not-an-address")).toBe(false);
    expect(isP2pkh("")).toBe(false);
  });
});
