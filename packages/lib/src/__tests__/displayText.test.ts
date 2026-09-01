/**
 * Display sanitisation for untrusted request text.
 *
 * The attack these guard against needs no invalid UTF-8 and no control
 * character: a bidirectional override reverses the visual order of everything
 * after it, so an approval screen can read as one thing while the bytes say
 * another. `cleanString` in the connect protocol accepts such a string
 * happily, because by its own rules there is nothing wrong with it.
 */
import { describe, expect, it } from "vitest";

import { hasUnsafeDisplayChars, sanitizeForDisplay } from "../displayText";

const RLO = "\u202E"; // U+202E right-to-left override
const PDF = "\u202C"; // U+202C pop directional formatting
const LRI = "\u2066"; // U+2066 left-to-right isolate
const ZWSP = "\u200B"; // U+200B zero-width space
const BOM = "\uFEFF"; // U+FEFF zero-width no-break space
const ZWJ = "\u200D"; // U+200D zero-width joiner
const ZWNJ = "\u200C"; // U+200C zero-width non-joiner
const C1 = "\u0085"; // U+0085 next line, a C1 control
const REPLACEMENT = "\uFFFD";

describe("hasUnsafeDisplayChars", () => {
  it("passes ordinary text, including non-Latin scripts and emoji", () => {
    for (const text of [
      "Photonic Wallet",
      "https://hashmark.rxd.zone",
      "\u0645\u062D\u0641\u0638\u0629",
      "\u30A6\u30A9\u30EC\u30C3\u30C8",
      "a" + ZWJ + "b",
      "a" + ZWNJ + "b",
    ]) {
      expect(hasUnsafeDisplayChars(text)).toBe(false);
    }
  });

  it("catches every class of hiding or reordering character", () => {
    for (const text of [
      "app" + RLO + "moc.live",
      "app" + PDF,
      "app" + LRI,
      "app" + ZWSP + "name",
      BOM + "app",
      "app" + C1 + "name",
      "line" + String.fromCharCode(0x2028) + "break",
    ]) {
      expect(hasUnsafeDisplayChars(text)).toBe(true);
    }
  });

  it("is not left stateful by a previous call", () => {
    // A /g/ regex carries lastIndex between calls. Two identical calls must
    // give identical answers, or the second request of a session renders
    // differently from the first.
    const hostile = "app" + RLO + "x";
    expect(hasUnsafeDisplayChars(hostile)).toBe(true);
    expect(hasUnsafeDisplayChars(hostile)).toBe(true);
    expect(hasUnsafeDisplayChars(hostile)).toBe(true);
  });
});

describe("sanitizeForDisplay", () => {
  it("leaves ordinary text byte-identical", () => {
    const text = "GlyphGalaxy - https://example.org";
    expect(sanitizeForDisplay(text)).toBe(text);
  });

  it("replaces rather than strips, so removal stays visible", () => {
    // Stripping would render "gpj.exe" as innocuous text. The user must be
    // able to see that something was taken out.
    const hostile = "invoice" + RLO + "fdp.exe";
    const clean = sanitizeForDisplay(hostile);
    expect(clean).not.toContain(RLO);
    expect(clean).toContain(REPLACEMENT);
    expect(clean).toBe("invoice" + REPLACEMENT + "fdp.exe");
  });

  it("replaces every occurrence, not just the first", () => {
    expect(sanitizeForDisplay(RLO + "a" + RLO + "b" + RLO)).toBe(
      REPLACEMENT + "a" + REPLACEMENT + "b" + REPLACEMENT
    );
  });

  it("keeps joiners, so emoji and Indic text survive", () => {
    const family = "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67";
    expect(sanitizeForDisplay(family)).toBe(family);
    expect(sanitizeForDisplay("a" + ZWNJ + "b")).toBe("a" + ZWNJ + "b");
  });

  it("never changes the length of the signed message it is not applied to", () => {
    // Guards the module contract: sanitisation is display-only. Callers must
    // pass the original string to the signer, never this output.
    const original = "photonic:wallet-connect:v1:nonce:label";
    expect(sanitizeForDisplay(original)).toBe(original);
  });
});
