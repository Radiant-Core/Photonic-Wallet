import { describe, it, expect } from "vitest";
import { GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE } from "../protocols";
import {
  isWaveDuplicate,
  getWaveDuplicateWarning,
  isWaveNameGlyph,
  getWaveDisplay,
} from "../wave";

describe("isWaveDuplicate", () => {
  it("flags a duplicate WAVE token (indexer `protocols` shape)", () => {
    expect(
      isWaveDuplicate({
        protocols: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE],
        is_wave_duplicate: true,
      })
    ).toBe(true);
  });

  it("flags a duplicate WAVE token (stored-glyph `p` shape)", () => {
    // Regression guard for the `.protocols` vs `.p` footgun: stored glyphs
    // carry the protocol list as `p`, and must still be detected.
    expect(
      isWaveDuplicate({
        p: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE],
        is_wave_duplicate: true,
      })
    ).toBe(true);
  });

  it("does NOT flag a mutable but non-WAVE token", () => {
    // Regression guard for the original bug: the check used `includes(5)`
    // (GLYPH_MUT) instead of GLYPH_WAVE (11), so any mutable token with the
    // duplicate flag was wrongly treated as a duplicate WAVE name.
    expect(
      isWaveDuplicate({
        protocols: [GLYPH_NFT, GLYPH_MUT],
        is_wave_duplicate: true,
      })
    ).toBe(false);
  });

  it("does NOT flag a canonical WAVE token (flag not set)", () => {
    expect(
      isWaveDuplicate({
        protocols: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE],
        is_wave_duplicate: false,
      })
    ).toBe(false);
  });

  it("returns false for missing / malformed input", () => {
    expect(isWaveDuplicate(null)).toBe(false);
    expect(isWaveDuplicate(undefined)).toBe(false);
    expect(isWaveDuplicate("nope")).toBe(false);
    expect(isWaveDuplicate({})).toBe(false);
    expect(isWaveDuplicate({ is_wave_duplicate: true })).toBe(false);
  });
});

describe("getWaveDuplicateWarning", () => {
  it("returns a warning string for a duplicate WAVE token", () => {
    const warning = getWaveDuplicateWarning({
      protocols: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE],
      is_wave_duplicate: true,
    });
    expect(warning).toContain("DUPLICATE WAVE NAME");
  });

  it("returns null for non-duplicates", () => {
    expect(
      getWaveDuplicateWarning({
        protocols: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE],
        is_wave_duplicate: false,
      })
    ).toBeNull();
    expect(getWaveDuplicateWarning({ protocols: [GLYPH_NFT, GLYPH_MUT] })).toBeNull();
  });
});

describe("isWaveNameGlyph", () => {
  it("is true when glyph.p includes GLYPH_WAVE", () => {
    expect(isWaveNameGlyph({ p: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE] })).toBe(true);
  });

  it("is false for a non-WAVE glyph", () => {
    expect(isWaveNameGlyph({ p: [GLYPH_NFT, GLYPH_MUT] })).toBe(false);
  });

  it("is false for null / undefined / missing p", () => {
    expect(isWaveNameGlyph(null)).toBe(false);
    expect(isWaveNameGlyph(undefined)).toBe(false);
    expect(isWaveNameGlyph({})).toBe(false);
  });
});

describe("getWaveDisplay", () => {
  it("extracts name/domain/full/target/expires for a WAVE glyph", () => {
    expect(
      getWaveDisplay({
        p: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE],
        attrs: { name: "alice", domain: "rxd", target: "addr1", expires: 1893456000 },
      })
    ).toEqual({
      name: "alice",
      domain: "rxd",
      full: "alice.rxd",
      target: "addr1",
      expires: 1893456000,
    });
  });

  it("defaults domain to rxd and target to empty string", () => {
    expect(
      getWaveDisplay({
        p: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE],
        attrs: { name: "bob" },
      })
    ).toEqual({
      name: "bob",
      domain: "rxd",
      full: "bob.rxd",
      target: "",
      expires: undefined,
    });
  });

  it("returns null when not a WAVE name or no name attr", () => {
    expect(getWaveDisplay({ p: [GLYPH_NFT, GLYPH_MUT] })).toBeNull();
    expect(getWaveDisplay({ p: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE], attrs: {} })).toBeNull();
    expect(getWaveDisplay(null)).toBeNull();
  });

  it("treats a non-numeric expires as undefined", () => {
    const display = getWaveDisplay({
      p: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE],
      attrs: { name: "carol", expires: "not-a-number" },
    });
    expect(display?.expires).toBeUndefined();
  });
});
