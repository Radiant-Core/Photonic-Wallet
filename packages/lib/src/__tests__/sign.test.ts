/**
 * Unit tests for the out-of-band message-signing primitive (`../sign`).
 *
 * These cover exactly the contract an external dApp relies on (see
 * GlyphGalaxy `docs/WALLET_CONNECT_SCOPE.md`): a Photonic-produced signature
 * over a namespaced challenge must verify with radiantjs `Message.verify`
 * (the verifier the dApp/indexer actually runs), and every failure mode
 * (tamper, wrong address, malformed sig, control chars) must behave safely.
 *
 * NOTE: `Message.sign` is NON-deterministic (random k). Tests therefore assert
 * *verification*, never byte-equality of two signatures.
 */
import { it, expect, describe } from "vitest";
import rjs from "@radiant-core/radiantjs";
import {
  signMessage,
  signMessageWithWif,
  verifyMessage,
  hasControlChars,
  MAX_MESSAGE_LENGTH,
} from "../sign";

const { Message, PrivateKey } = rjs;

const CHALLENGE = "glyphgalaxy:wallet-connect:v1:sess-abc123:deadbeefdeadbeef";

describe("signMessage / verifyMessage", () => {
  it("round-trips: a signed challenge verifies against its own address", () => {
    const key = new PrivateKey();
    const signed = signMessage(CHALLENGE, key);

    expect(signed.message).toBe(CHALLENGE);
    expect(signed.address).toBe(key.toAddress().toString());
    expect(signed.pubkey).toBe(key.toPublicKey().toString());
    expect(verifyMessage(CHALLENGE, signed.address, signed.signature)).toBe(
      true
    );
  });

  it("is verifiable by radiantjs Message.verify (the dApp's exact verifier)", () => {
    const key = new PrivateKey();
    const signed = signMessage(CHALLENGE, key);
    // The recoverable signature carries the pubkey; the verifier provides none.
    expect(Message.verify(CHALLENGE, signed.address, signed.signature)).toBe(
      true
    );
  });

  it("signMessageWithWif matches signMessage and yields the WIF's address", () => {
    const key = new PrivateKey();
    const wif = key.toWIF();
    const signed = signMessageWithWif(CHALLENGE, wif);

    expect(signed.address).toBe(PrivateKey.fromWIF(wif).toAddress().toString());
    expect(verifyMessage(CHALLENGE, signed.address, signed.signature)).toBe(
      true
    );
  });

  it("is non-deterministic but both signatures verify", () => {
    const key = new PrivateKey();
    const a = signMessage(CHALLENGE, key);
    const b = signMessage(CHALLENGE, key);
    expect(a.signature).not.toBe(b.signature);
    expect(verifyMessage(CHALLENGE, a.address, a.signature)).toBe(true);
    expect(verifyMessage(CHALLENGE, b.address, b.signature)).toBe(true);
  });

  it("rejects a tampered message", () => {
    const key = new PrivateKey();
    const signed = signMessage(CHALLENGE, key);
    expect(
      verifyMessage(`${CHALLENGE}x`, signed.address, signed.signature)
    ).toBe(false);
  });

  it("rejects a signature checked against the wrong address", () => {
    const signer = new PrivateKey();
    const other = new PrivateKey();
    const signed = signMessage(CHALLENGE, signer);
    expect(
      verifyMessage(CHALLENGE, other.toAddress().toString(), signed.signature)
    ).toBe(false);
  });

  it("returns false (does not throw) on a malformed signature", () => {
    const key = new PrivateKey();
    const addr = key.toAddress().toString();
    expect(verifyMessage(CHALLENGE, addr, "not-base64!!")).toBe(false);
    expect(verifyMessage(CHALLENGE, addr, "")).toBe(false);
    // base64 but not a valid 65-byte recoverable sig
    expect(verifyMessage(CHALLENGE, addr, "aGVsbG8=")).toBe(false);
  });

  it("returns false on malformed/empty inputs without throwing", () => {
    expect(verifyMessage("", "addr", "sig")).toBe(false);
    expect(verifyMessage(CHALLENGE, "not-an-address", "aGVsbG8=")).toBe(false);
  });
});

describe("assertSignableMessage (via signMessage)", () => {
  it("rejects an empty message", () => {
    const key = new PrivateKey();
    expect(() => signMessage("", key)).toThrow(/non-empty/);
  });

  it("rejects a message over MAX_MESSAGE_LENGTH", () => {
    const key = new PrivateKey();
    const tooLong = "a".repeat(MAX_MESSAGE_LENGTH + 1);
    expect(() => signMessage(tooLong, key)).toThrow(/MAX_MESSAGE_LENGTH/);
  });

  it("rejects a message containing control characters", () => {
    const key = new PrivateKey();
    const withNul = `glyph${String.fromCharCode(0)}auth`;
    expect(() => signMessage(withNul, key)).toThrow(/control characters/);
    const withNewline = `line1${String.fromCharCode(10)}line2`;
    expect(() => signMessage(withNewline, key)).toThrow(/control characters/);
  });

  it("accepts a normal namespaced challenge of reasonable length", () => {
    const key = new PrivateKey();
    expect(() => signMessage(CHALLENGE, key)).not.toThrow();
  });
});

describe("hasControlChars", () => {
  it("detects C0 control chars and DEL", () => {
    expect(hasControlChars("clean-text:123")).toBe(false);
    expect(hasControlChars(`a${String.fromCharCode(0)}b`)).toBe(true);
    expect(hasControlChars(`a${String.fromCharCode(31)}b`)).toBe(true);
    expect(hasControlChars(`a${String.fromCharCode(127)}b`)).toBe(true);
    expect(hasControlChars(`a${String.fromCharCode(32)}b`)).toBe(false); // space ok
  });
});
