/**
 * Authority chain verification tests.
 *
 * Guards the audit fix: verifyAuthorityChain used to do
 * `authorityTokens.find(() => true)`, accepting ANY authority-looking token for
 * ANY claimed issuer. It now requires a real ref match between the token's `by`
 * reference and the authority's on-chain ref.
 */
import { describe, it, expect } from "vitest";
import {
  verifyAuthorityChain,
  createAuthority,
  AuthorityCandidate,
} from "../authority";
import { GlyphV2Metadata } from "../v2metadata";
import { GLYPH_NFT } from "../protocols";
import { reverseRef } from "../Outpoint";

const AUTH_REF = "aa".repeat(32) + "00000000"; // 36-byte ref (BE form)
const OTHER_REF = "bb".repeat(32) + "00000000";

function refBytes(refHex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(refHex, "hex"));
}

function tokenIssuedBy(refHex: string): GlyphV2Metadata {
  return {
    v: 2,
    p: [GLYPH_NFT],
    name: "Collection Item",
    by: [refBytes(refHex)],
  } as unknown as GlyphV2Metadata;
}

const authority: AuthorityCandidate = {
  ref: AUTH_REF,
  metadata: createAuthority("issuer-address", { name: "Collection Authority" }),
};

describe("verifyAuthorityChain", () => {
  it("accepts a token whose `by` matches the authority ref", () => {
    const r = verifyAuthorityChain(tokenIssuedBy(AUTH_REF), [authority]);
    expect(r.valid).toBe(true);
    expect(r.authority?.ref).toBe(AUTH_REF);
  });

  it("matches regardless of ref byte orientation", () => {
    // Token stores the issuer ref in the reversed (LE script) orientation.
    const r = verifyAuthorityChain(tokenIssuedBy(reverseRef(AUTH_REF)), [
      authority,
    ]);
    expect(r.valid).toBe(true);
  });

  it("REJECTS a forged claim: token presents a DIFFERENT authority", () => {
    // The exploit the audit found: previously this passed via find(() => true).
    const r = verifyAuthorityChain(tokenIssuedBy(OTHER_REF), [authority]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/no authority token matches/i);
  });

  it("REJECTS when there are no authority candidates", () => {
    const r = verifyAuthorityChain(tokenIssuedBy(AUTH_REF), []);
    expect(r.valid).toBe(false);
  });

  it("REJECTS a token with no issuer reference", () => {
    const noBy = { v: 2, p: [GLYPH_NFT], name: "Orphan" } as GlyphV2Metadata;
    const r = verifyAuthorityChain(noBy, [authority]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/no issuer reference/i);
  });

  it("REJECTS when the matched authority is expired", () => {
    const expired: AuthorityCandidate = {
      ref: AUTH_REF,
      metadata: createAuthority("issuer-address", {
        name: "Expired Authority",
        expires: "2000-01-01T00:00:00.000Z",
      }),
    };
    const r = verifyAuthorityChain(tokenIssuedBy(AUTH_REF), [expired]);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/expired/i);
  });

  it("picks the correct authority out of several candidates", () => {
    const decoy: AuthorityCandidate = {
      ref: OTHER_REF,
      metadata: createAuthority("someone-else", { name: "Unrelated Authority" }),
    };
    const r = verifyAuthorityChain(tokenIssuedBy(AUTH_REF), [decoy, authority]);
    expect(r.valid).toBe(true);
    expect(r.authority?.ref).toBe(AUTH_REF);
  });
});
