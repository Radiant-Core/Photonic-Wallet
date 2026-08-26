import { describe, it, expect } from "vitest";

import rjs from "@radiant-core/radiantjs";
import {
  encodeGlyph,
  encodeGlyphMutable,
  decodeGlyphWithPayloadHash,
} from "../token";
import { mutableNftScript, parseMutableScript } from "../script";

const { Script } = rjs;

const MOD_ATTRS = {
  name: "alice",
  domain: "rxd",
  target: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  target_type: "address",
  expires: 1850000000,
};

const MUT_REF_LE = "ab".repeat(36);

describe("decodeGlyphWithPayloadHash", () => {
  it("recovers the payload and the hash a mutable contract commits to", () => {
    // The state hash a `mod` scriptSig produces must equal the one the
    // contract output carries — that binding is what makes a mod payload
    // trustworthy when it's read back off-chain.
    const glyph = encodeGlyphMutable("mod", { attrs: MOD_ATTRS }, 1, 1, 0, 0);

    const decoded = decodeGlyphWithPayloadHash(glyph.scriptSig);
    expect(decoded).toBeDefined();
    expect(decoded?.payloadHash).toBe(glyph.payloadHash);
    expect(decoded?.payload.attrs).toEqual(MOD_ATTRS);

    const contractOutput = mutableNftScript(MUT_REF_LE, glyph.payloadHash);
    expect(parseMutableScript(contractOutput)).toEqual({
      hash: glyph.payloadHash,
      ref: MUT_REF_LE,
    });
  });

  it("hashes the RAW payload bytes, not a re-encode of the decoded object", () => {
    // decodeGlyph re-parses the payload (files split out, `p` normalized), so
    // re-encoding it would not reproduce the committed hash. Guard that the
    // hash comes from the original push.
    const glyph = encodeGlyphMutable(
      "mod",
      { attrs: MOD_ATTRS, extra: "field decodeGlyph moves into meta" },
      1,
      1,
      0,
      0
    );
    expect(decodeGlyphWithPayloadHash(glyph.scriptSig)?.payloadHash).toBe(
      glyph.payloadHash
    );
  });

  it("reads a plain (non-mutable) reveal payload too", () => {
    const { revealScriptSig, payloadHash } = encodeGlyph({ attrs: MOD_ATTRS });
    const decoded = decodeGlyphWithPayloadHash(Script.fromHex(revealScriptSig));
    expect(decoded?.payloadHash).toBe(payloadHash);
    expect(decoded?.payload.attrs).toEqual(MOD_ATTRS);
  });

  it("returns undefined for a script with no glyph payload", () => {
    expect(
      decodeGlyphWithPayloadHash(
        Script.fromASM("OP_DUP OP_HASH160 " + "11".repeat(20) + " OP_EQUAL")
      )
    ).toBeUndefined();
  });
});
