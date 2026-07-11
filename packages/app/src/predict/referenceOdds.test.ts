import { describe, it, expect } from "vitest";
import { parseReference } from "./referenceOdds";

const SLUG = "will-rxd-reach-1-dollar";

describe("parseReference", () => {
  it("accepts a poly:/polymarket: prefix", () => {
    expect(parseReference(`poly:${SLUG}`)).toEqual({
      provider: "polymarket",
      slug: SLUG,
    });
    expect(parseReference(`polymarket:${SLUG}`)?.slug).toBe(SLUG);
  });

  it("accepts a bare kebab-case slug", () => {
    expect(parseReference(SLUG)).toEqual({ provider: "polymarket", slug: SLUG });
  });

  it("takes the last path segment of a polymarket.com URL", () => {
    expect(parseReference(`https://polymarket.com/market/${SLUG}`)?.slug).toBe(
      SLUG
    );
    expect(
      parseReference(`https://polymarket.com/event/some-event/${SLUG}`)?.slug
    ).toBe(SLUG);
    expect(parseReference(`https://www.polymarket.com/market/${SLUG}`)?.slug).toBe(
      SLUG
    );
  });

  it("rejects non-Polymarket hosts (anti-SSRF: never fetch arbitrary URLs)", () => {
    expect(parseReference("https://evil.example.com/market/foo")).toBeNull();
    expect(
      parseReference("https://polymarket.com.evil.example/market/foo")
    ).toBeNull();
    expect(parseReference("http://gamma-api.polymarket.com/x")).toBeNull(); // not the site host
  });

  it("rejects malformed / unsafe slugs", () => {
    expect(parseReference("")).toBeNull();
    expect(parseReference("   ")).toBeNull();
    expect(parseReference("not a slug!!")).toBeNull();
    expect(parseReference("a")).toBeNull(); // too short
    expect(parseReference("poly:bad slug")).toBeNull();
    expect(parseReference("../../etc/passwd")).toBeNull();
  });

  it("lower-cases slugs", () => {
    expect(parseReference("Will-RXD-Reach-1-Dollar")?.slug).toBe(
      "will-rxd-reach-1-dollar"
    );
  });
});
