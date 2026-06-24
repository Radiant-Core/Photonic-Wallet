/**
 * zero_refs scripthash parity.
 *
 * RXinDexer keys a checksig-bearing UTXO's scripthash on the script with every
 * 36-byte input-ref OPERAND zeroed (electrumx/lib/script.py `Script.zero_refs`).
 * A `listunspent` lookup that hashes the RAW script (real ref operand) therefore
 * queries a scripthash the indexer never populates and gets back [] — which is
 * exactly the bug that made `syncCovenants` wrongly mark every fresh royalty
 * listing RESOLVED on its first poll (gone from the royalty market; NFT shown as
 * owned again). These assertions pin the helper that fixes it.
 */
import { describe, it, expect } from "vitest";
import { zeroRefs, scriptHash, p2pkhScript } from "../script";
import { royaltySaleScript } from "../royaltyCovenant";

const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const REF = "a".repeat(72); // 36-byte LE singleton ref

const terms = {
  ref: REF,
  sellerAddress: ADDR,
  sellerScript: p2pkhScript(ADDR),
  price: 100_000,
  royalties: [{ script: p2pkhScript(ADDR), value: 5_000 }],
};

describe("zeroRefs (indexer scripthash parity)", () => {
  const script = royaltySaleScript(terms);

  it("zeroes the leading OP_PUSHINPUTREFSINGLETON operand of a royalty listing", () => {
    // The covenant starts with d8 <ref:72hex> 75 …
    expect(script.startsWith("d8" + REF + "75")).toBe(true);
    const zeroed = zeroRefs(script);
    // … and the 36-byte ref operand is wiped (the covenant gates on a seller
    // sig in its cancel branch, so requiresSig is true and the ref is zeroed).
    expect(zeroed.startsWith("d8" + "0".repeat(72) + "75")).toBe(true);
    expect(zeroed).not.toBe(script);
  });

  it("makes the scripthash match what the indexer stores (NOT the raw hash)", () => {
    // The old syncCovenants hashed the raw script — a scripthash the indexer
    // never populates. The two MUST differ, or the bug would not have bitten.
    expect(scriptHash(zeroRefs(script))).not.toBe(scriptHash(script));
  });

  it("is a no-op for a checksig script with no ref operands (plain P2PKH)", () => {
    const p2pkh = p2pkhScript(ADDR);
    expect(zeroRefs(p2pkh)).toBe(p2pkh);
  });

  it("leaves a ref-bearing script with no checksig unchanged", () => {
    // d8 <ref> OP_DROP — carries a ref operand but no signature gate, so the
    // indexer indexes it verbatim and zeroRefs must not touch it.
    const noSig = "d8" + REF + "75";
    expect(zeroRefs(noSig)).toBe(noSig);
  });
});
