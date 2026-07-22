/**
 * scriptToP2pkhAddress — the recipient-decode gate for tx signing.
 *
 * The point of this test is the SPOOF case: prove that a scriptSig-shaped
 * locking script (`<push sig> <push pubkey>`, which is anyone-can-spend) is
 * REFUSED, even though radiantjs's own `toAddress()` would happily map it to an
 * honest-looking P2PKH address via its input-classification fallback. That
 * fallback is the vulnerability this module exists to close.
 */
import { describe, it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { scriptToP2pkhAddress } from "../scriptDecode";

const { PrivateKey, Script } = rjs;

// A deterministic key so the vectors are stable. 0x01*32 is a valid secp256k1
// scalar; network "testnet" gives an m/n… address.
const priv = PrivateKey.fromBuffer(Buffer.from("01".repeat(32), "hex"), "testnet");
const pub = priv.toPublicKey();
const address = priv.toAddress().toString();

// A canonical P2PKH OUTPUT for that key: 76a914 <h160> 88ac.
const p2pkhOut = Script.buildPublicKeyHashOut(priv.toAddress()).toHex();

// The spoof: a scriptSig shape used as a LOCKING script. First push looks like a
// DER sig (starts 0x30), second push is the real 33-byte compressed pubkey.
const fakeSig = Buffer.concat([Buffer.from([0x30, 0x44]), Buffer.alloc(68, 0x01)]);
const spoof = Script.empty().add(fakeSig).add(pub.toBuffer()).toHex();

describe("scriptToP2pkhAddress", () => {
  it("decodes a genuine P2PKH output to its address", () => {
    expect(scriptToP2pkhAddress(p2pkhOut, "testnet")).toBe(address);
  });

  it("REFUSES a scriptSig-shaped (anyone-can-spend) locking script", () => {
    expect(scriptToP2pkhAddress(spoof, "testnet")).toBeNull();
  });

  it("PROVES the vulnerability it closes: rjs's raw toAddress() is fooled by the spoof", () => {
    // rjs falls back to INPUT classification and reports the HONEST address for
    // the anyone-can-spend script — exactly the confusion our gate blocks. This
    // asserts the threat is real, so a future refactor can't quietly reintroduce
    // it by dropping the parseP2pkhScript gate.
    const loose = new Script(spoof).toAddress("testnet");
    expect(loose ? loose.toString() : null).toBe(address);
  });

  it("refuses P2SH, bare, empty, and garbage scripts (fail-closed)", () => {
    const p2sh = "a914" + "11".repeat(20) + "87"; // OP_HASH160 <20> OP_EQUAL
    expect(scriptToP2pkhAddress(p2sh, "testnet")).toBeNull();
    expect(scriptToP2pkhAddress("", "testnet")).toBeNull();
    expect(scriptToP2pkhAddress("6a04deadbeef", "testnet")).toBeNull(); // OP_RETURN
    expect(scriptToP2pkhAddress("zzzz", "testnet")).toBeNull();
    // A p2pkh output template but truncated h160 must not match the anchored regex.
    expect(scriptToP2pkhAddress("76a914" + "22".repeat(19) + "88ac", "testnet")).toBeNull();
  });

  it("is case-insensitive on the hex input", () => {
    expect(scriptToP2pkhAddress(p2pkhOut.toUpperCase(), "testnet")).toBe(address);
  });
});
