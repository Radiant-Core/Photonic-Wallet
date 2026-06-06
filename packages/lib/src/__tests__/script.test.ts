import { describe, it, expect } from "vitest";
import {
  scriptHash,
  p2pkhScript,
  payToScript,
  isP2pkh,
  p2pkhScriptHash,
  nftScript,
  nftAuthScript,
  parseNftScript,
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

describe("parseNftScript — plain AND auth-covenant singletons", () => {
  // A round-trippable plain NFT singleton built by the lib.
  const REF_LE =
    "1111111111111111111111111111111111111111111111111111111111111111" +
    "00000000";

  it("parses a plain nftScript (OP_PUSHINPUTREFSINGLETON ref OP_DROP P2PKH)", () => {
    const script = nftScript(VALID_P2PKH, REF_LE);
    const { ref, address } = parseNftScript(script);
    expect(ref).toBe(REF_LE);
    expect(address).toBeDefined();
    // The trailing P2PKH must match the address' pay-to script tail.
    expect(script.endsWith(`76a914${address}88ac`)).toBe(true);
  });

  it("parses the auth-covenant singleton an nftAuthScript produces", () => {
    // nftAuthScript wraps the singleton in OP_REQUIREINPUTREF <mutRef>
    // <scriptSigHash> OP_2DROP … OP_STATESEPARATOR. A WAVE-name target update is
    // FORCED to emit this form, and parseNftScript must still recover the
    // singleton ref + owner address from it (else the name is invisible).
    const mutRef =
      "2222222222222222222222222222222222222222222222222222222222222222" +
      "01000000";
    const scriptSigHash =
      "3333333333333333333333333333333333333333333333333333333333333333";
    const script = nftAuthScript(VALID_P2PKH, REF_LE, [
      { ref: mutRef, scriptSigHash },
    ]);
    const { ref, address } = parseNftScript(script);
    expect(ref).toBe(REF_LE);
    expect(address).toBeDefined();
    expect(script.endsWith(`76a914${address}88ac`)).toBe(true);
  });

  it("parses the REAL on-chain 12345.rxd auth singleton (tx f7a46…:0)", () => {
    // Verbatim scriptPubKey of the live, unspent singleton recovered from
    // mainnet. Owner h160 2242acad…0777 = address 1489r9fYzC9VgueuT16CPWiRRx4HKacYbB.
    const onchain =
      "d12a6ba388042adc00cecc8ba1de854140a677348a42cc300d78d8459bbbaae9" +
      "4b01000000207024aa3c21305d88691f9d4aaa4d88dedbf0a6e8e73cf79c629b" +
      "833348078f086dbdd82a6ba388042adc00cecc8ba1de854140a677348a42cc30" +
      "0d78d8459bbbaae94b000000007576a9142242acad9e3089b7e7b54387c79ce9" +
      "c77010077788ac";
    const { ref, address } = parseNftScript(onchain);
    expect(ref).toBe(
      "2a6ba388042adc00cecc8ba1de854140a677348a42cc300d78d8459bbbaae94b" +
        "00000000"
    );
    expect(address).toBe("2242acad9e3089b7e7b54387c79ce9c770100777");
  });

  it("rejects a non-NFT script", () => {
    expect(parseNftScript(p2pkhScript(VALID_P2PKH)).ref).toBeUndefined();
    expect(parseNftScript("deadbeef").ref).toBeUndefined();
  });
});
