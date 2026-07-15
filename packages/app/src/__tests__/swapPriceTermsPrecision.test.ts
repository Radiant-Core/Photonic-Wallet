/**
 * Guard: `parsePriceTerms` must never return a SILENTLY ROUNDED price.
 *
 * Photon amounts are JS `number` throughout the wallet, but the price_terms
 * wire format carries a full 8-byte unsigned value. Above 2^53 a number cannot
 * hold an integer exactly, so the old decode loop
 * (`value = value * 256 + bytes[j]`) rounded without any signal — 2^53+1
 * decoded as 2^53, and 2^64-1 decoded ~385 photons high.
 *
 * Severity is LOW and this is not a live exploit: price_terms is maker-authored
 * (so attacker-controllable), but a rounded value lands in output[0], which is
 * precisely what the maker's SIGHASH_SINGLE signature commits to — the node
 * would reject the completed transaction anyway, and funding a swap near this
 * bound needs >90M RXD. The guard converts a silent wrong number into a clear
 * rejection at the parse boundary.
 */
import { describe, it, expect } from "vitest";
import { parsePriceTerms, encodePriceTerms } from "@app/swapBroadcast";

/** Encode an 8-byte LE value + script as the legacy single-output form. */
function legacyTerms(value: bigint, scriptHex: string): string {
  let r = value;
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += Number(r & 0xffn)
      .toString(16)
      .padStart(2, "0");
    r >>= 8n;
  }
  return out + scriptHex;
}

const SCRIPT = "76a914" + "11".repeat(20) + "88ac";
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER); // 2^53 - 1

describe("parsePriceTerms value precision", () => {
  it("parses a realistic price exactly", () => {
    const parsed = parsePriceTerms(legacyTerms(7_000_000n, SCRIPT));
    expect(parsed).not.toBeNull();
    expect(parsed!.value).toBe(7_000_000);
    expect(parsed!.script).toBe(SCRIPT);
  });

  it("parses right up to the exact-representation boundary (2^53-1)", () => {
    const parsed = parsePriceTerms(legacyTerms(MAX_SAFE, SCRIPT));
    expect(parsed).not.toBeNull();
    expect(parsed!.value).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a value one above the boundary rather than rounding it", () => {
    // Old behaviour: returned 9007199254740992 (2^53), silently wrong.
    expect(parsePriceTerms(legacyTerms(MAX_SAFE + 2n, SCRIPT))).toBeNull();
  });

  it("rejects a full 8-byte max value rather than rounding it", () => {
    // Old behaviour: returned 18446744073709552000, ~385 photons high.
    expect(parsePriceTerms(legacyTerms(2n ** 64n - 1n, SCRIPT))).toBeNull();
  });

  it("never returns a value that is not an exact integer", () => {
    for (const v of [
      1n,
      7_000_000n,
      MAX_SAFE,
      MAX_SAFE + 2n,
      2n ** 60n,
      2n ** 64n - 1n,
    ]) {
      const parsed = parsePriceTerms(legacyTerms(v, SCRIPT));
      if (parsed) {
        expect(Number.isSafeInteger(parsed.value)).toBe(true);
        // The returned number must equal the encoded value exactly.
        expect(BigInt(parsed.value)).toBe(v);
      }
    }
  });
});

describe("encodePriceTerms value range", () => {
  it("round-trips a realistic price", () => {
    const parsed = parsePriceTerms(encodePriceTerms(SCRIPT, 7_000_000));
    expect(parsed!.value).toBe(7_000_000);
  });

  it("refuses to encode an unrepresentable value", () => {
    expect(() => encodePriceTerms(SCRIPT, 2 ** 53 + 2)).toThrow();
    expect(() => encodePriceTerms(SCRIPT, -1)).toThrow();
  });
});
