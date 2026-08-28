/**
 * `extractMutableModAttrs` — reading a mutable glyph's CURRENT attrs off the
 * `mod` transaction that holds its singleton.
 *
 * Regression cover for the stale-target bug: a stored glyph's `attrs` are
 * decoded from the MINT reveal only, so a WAVE name re-pointed on-chain kept
 * reporting its registration-time target, and the wallet believed it still
 * "needed a target update" — auto-repointing it, at a fee, to the address it
 * already had.
 */
import { describe, it, expect } from "vitest";

import rjs from "@radiant-core/radiantjs";
import { encodeGlyphMutable, extractMutableModAttrs } from "../token";
import { mutableNftScript, p2pkhScript, parseNftScript } from "../script";
import Outpoint from "../Outpoint";

const { Script, Transaction } = rjs;

const OWNER = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const NEW_TARGET = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";

// Token ref (BE) and the mutable contract ref, which is always token ref + 1.
const MINT_TXID = "11".repeat(32);
const NFT_REF_BE = Outpoint.fromUTXO(MINT_TXID, 0).toString();
const MUT_REF_LE = Outpoint.fromUTXO(MINT_TXID, 1).reverse().toString();

/** A tx shaped like `updateWaveTarget`'s: mod scriptSig in, contract state out. */
function modTx(
  attrs: Record<string, unknown>,
  opts: { contractRef?: string; committedHash?: string } = {}
) {
  const glyph = encodeGlyphMutable("mod", { attrs }, 1, 1, 0, 0);
  const tx = new Transaction();
  tx.addInput(
    new Transaction.Input({
      prevTxId: Buffer.from("22".repeat(32), "hex"),
      outputIndex: 1,
      script: glyph.scriptSig,
      output: new Transaction.Output({
        script: Script.fromHex(p2pkhScript(OWNER)),
        satoshis: 1,
      }),
    })
  );
  // Output 0 is the re-created singleton, output 1 the contract state — the
  // helper must find the contract by ref, not by position.
  tx.addOutput(
    new Transaction.Output({
      script: Script.fromHex(p2pkhScript(OWNER)),
      satoshis: 1,
    })
  );
  tx.addOutput(
    new Transaction.Output({
      script: Script.fromHex(
        mutableNftScript(
          opts.contractRef ?? MUT_REF_LE,
          opts.committedHash ?? glyph.payloadHash
        )
      ),
      satoshis: 1,
    })
  );
  return tx;
}

// A real mainnet `mod`: the target update for first-of-the-free.rxd
// (34763132ab16bcd95e978fe60bd3dcf218a32dd4481939bf8655e0d215b16089). Kept as a
// fixture because it is the exact shape the wallet must read back — a wallet
// rebuilt from seed re-decodes the MINT payload, whose target is the address the
// name was registered to; only this mod carries where it actually points now.
const REAL_MOD_TX =
  "01000000032269149d87e3092ea4e7875e16a9bd020225add5af8a4472598aaed020aa36cb000000006a47304402205f182c77d97d0f19e205a47006c458fa885128e463674efca4322b4c6dff052e02204031d931bd942cb841e797cc806b2388009336efbcbe439d1ac4cdde4ffb73f44121037f7ff8ddbf505673408c9a610750743fb17b1ddf0fff6af4abfd604f29cf7097ffffffff434a711abd50afdbc14c504fad29b3d61016802c499990aa04576d128afe9ab6010000008803676c794c7ab90001656174747273b90005646e616d657166697273742d6f662d7468652d6672656566646f6d61696e63727864667461726765747822314a426a3372514e43555934426b4d65597255524d6d663456396e72573347386b716b7461726765745f74797065676164647265737367657870697265731a6e504c84036d6f6451510000ffffffff2269149d87e3092ea4e7875e16a9bd020225add5af8a4472598aaed020aa36cb010000006b483045022100cdec64e65903d1c77948c51e4a2cf4695fd015f545ee25952ce997756ea01bf9022051de9d7a14373271da63301507c75f4013ce8e486ed2274cd871f27d511bdb764121037f7ff8ddbf505673408c9a610750743fb17b1ddf0fff6af4abfd604f29cf7097ffffffff03010000000000000087d1a789eaf43e250eca09c2a4c3322d5ce1634b7f1063996305e26691cdc84ade8901000000202ad40924c5bb9cfec43e1dfa3167136659700f48635aab692569b7a239a065ac6dbdd8a789eaf43e250eca09c2a4c3322d5ce1634b7f1063996305e26691cdc84ade89000000007576a914bc81661916890412ff3401383102d78439da4aeb88ac0100000000000000ae20bf6c9853788961a06a0865082aaaaf9dd0deee07ac7867dc6711cc5384ff7b6475bdd8a789eaf43e250eca09c2a4c3322d5ce1634b7f1063996305e26691cdc84ade89010000007601207f818c54807e5279e2547a0124957f7701247f75887cec7b7f7701457f757801207ec0caa87e885279036d6f64876378eac0e98878ec01205579aa7e01757e8867527902736c8878cd01d852797e016a7e8778da009c9b6968547a03676c79886d6d511c5951b5e80000001976a914bc81661916890412ff3401383102d78439da4aeb88ac00000000";
// Its token ref, and the two addresses involved.
const REAL_REF =
  "89de4ac8cd9166e205639963107f4b63e15c2d32c3a4c209ca0e253ef4ea89a700000000";
const REAL_OWNER = "1JBj3rQNCUY4BkMeYrURMmf4V9nrW3G8kq";
const REGISTERED_TO = "1CPfirXZahPrTb93QouwBfKDoz1ykfcBb7";

describe("extractMutableModAttrs", () => {
  it("reads the live target off a real mainnet WAVE-name mod", () => {
    const tx = new Transaction(REAL_MOD_TX);
    const attrs = extractMutableModAttrs(tx, REAL_REF);

    // The mint payload says REGISTERED_TO; the chain says REAL_OWNER. A wallet
    // that only decodes the reveal reports the stale one, flags the name as
    // needing a target update, and re-points it at a fee to the address it
    // already has.
    expect(attrs?.target).toBe(REAL_OWNER);
    expect(attrs?.target).not.toBe(REGISTERED_TO);
    expect(attrs?.name).toBe("first-of-the-free");
    expect(attrs?.domain).toBe("rxd");
    expect(attrs?.expires).toBe(1850756228);

    // The singleton in the same tx rests under the auth-covenant form a target
    // update is forced to produce, still paying the owner.
    const singleton = tx.outputs
      .map((o: { script: { toHex(): string } }) => o.script.toHex())
      .find((h: string) => parseNftScript(h).ref);
    expect(singleton?.endsWith(p2pkhScript(REAL_OWNER))).toBe(true);
  });

  it("returns the attrs a mod payload committed for this ref", () => {
    const attrs = extractMutableModAttrs(
      modTx({
        name: "alice",
        domain: "rxd",
        target: NEW_TARGET,
        target_type: "address",
        expires: 1850000000,
      }),
      NFT_REF_BE
    );

    expect(attrs?.target).toBe(NEW_TARGET);
    expect(attrs?.name).toBe("alice");
    expect(attrs?.expires).toBe(1850000000);
  });

  it("rejects a payload that does not hash to the committed state", () => {
    // Any input can push glyph-shaped bytes. Only the payload the contract
    // output commits to is the real state — otherwise a crafted tx could
    // rewrite a name's target in the local db.
    const tx = modTx(
      { name: "alice", domain: "rxd", target: NEW_TARGET },
      { committedHash: "ff".repeat(32) }
    );
    expect(extractMutableModAttrs(tx, NFT_REF_BE)).toBeUndefined();
  });

  it("ignores a mod belonging to a DIFFERENT ref", () => {
    const other = Outpoint.fromUTXO("33".repeat(32), 1).reverse().toString();
    const tx = modTx(
      { name: "bob", domain: "rxd", target: NEW_TARGET },
      { contractRef: other }
    );
    expect(extractMutableModAttrs(tx, NFT_REF_BE)).toBeUndefined();
  });

  it("returns undefined for a tx carrying no mutable state (a plain transfer)", () => {
    const tx = new Transaction();
    tx.addOutput(
      new Transaction.Output({
        script: Script.fromHex(p2pkhScript(OWNER)),
        satoshis: 1,
      })
    );
    expect(extractMutableModAttrs(tx, NFT_REF_BE)).toBeUndefined();
  });

  it("returns undefined rather than empty attrs, so callers keep what they have", () => {
    expect(extractMutableModAttrs(modTx({}), NFT_REF_BE)).toBeUndefined();
  });

  it("returns undefined for a malformed ref instead of throwing", () => {
    expect(
      extractMutableModAttrs(modTx({ name: "alice" }), "nope")
    ).toBeUndefined();
  });
});
