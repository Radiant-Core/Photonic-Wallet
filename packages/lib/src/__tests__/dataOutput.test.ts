/**
 * Describing an OP_RETURN payload for the approval screen.
 *
 * The rule these tests hold the module to: describe, never interpret, and never
 * offer text that could misrepresent itself. A payload is supplied by whoever
 * built the request, so every branch here is reachable by an app that wants it
 * to be.
 */
import { describe, expect, it } from "vitest";

import { readDataOutput } from "../dataOutput";

/** A real mainnet HashMark v1 record: magic, header, 32-byte digest. */
const HASHMARK_V1 =
  "6a08484153484d41524b02010120" +
  "e2c55efb34b6e9d6db008ee72d56bf86456ab3f55ae76488ff677fda88df1f1e";

describe("readDataOutput", () => {
  it("ignores anything that is not a data output", () => {
    // A plain P2PKH locking script.
    expect(
      readDataOutput("76a91426ba056431ec69cf27eabeaab250d99ddbd895d288ac"),
    ).toBeUndefined();
    expect(readDataOutput("")).toBeUndefined();
    expect(readDataOutput("zz")).toBeUndefined();
  });

  it("describes a real HashMark record without interpreting it", () => {
    const data = readDataOutput(HASHMARK_V1);
    expect(data).toBeDefined();
    expect(data!.size).toBe(46);
    expect(data!.pushes).toHaveLength(3);
    // The magic reads as text; the digest does not, and is not forced to.
    expect(data!.pushes![0]!.text).toBe("HASHMARK");
    expect(data!.pushes![2]!.text).toBeUndefined();
    expect(data!.pushes![2]!.hex).toHaveLength(64);
  });

  it("always reports the raw payload, even when pushes parse", () => {
    const data = readDataOutput(HASHMARK_V1);
    expect(data!.payloadHex).toBe(HASHMARK_V1.slice(2));
  });

  it("falls back to raw hex when the payload is not push-structured", () => {
    // OP_RETURN followed by OP_DUP, which is legal and not a push.
    const data = readDataOutput("6a76");
    expect(data).toBeDefined();
    expect(data!.pushes).toBeUndefined();
    expect(data!.payloadHex).toBe("76");
  });

  it("falls back to raw hex on a truncated push rather than guessing", () => {
    // Claims 4 bytes, supplies 2.
    const data = readDataOutput("6a04dead");
    expect(data!.pushes).toBeUndefined();
    expect(data!.payloadHex).toBe("04dead");
  });

  it("offers no text for bytes that are not valid UTF-8", () => {
    const data = readDataOutput("6a02fffe");
    expect(data!.pushes![0]!.text).toBeUndefined();
    expect(data!.pushes![0]!.hex).toBe("fffe");
  });

  it("offers no text for a push that could reorder its own display", () => {
    // "ab" + U+202E RIGHT-TO-LEFT OVERRIDE, valid UTF-8 and displayable -
    // which is exactly why it must not be offered as text.
    const bidi = Buffer.from("ab\u202E", "utf8").toString("hex");
    const push = (bidi.length / 2).toString(16).padStart(2, "0");
    const data = readDataOutput("6a" + push + bidi);
    expect(data!.pushes![0]!.text).toBeUndefined();
    expect(data!.pushes![0]!.hex).toBe(bidi);
  });

  it("offers no text for a push carrying a newline", () => {
    // A newline in a rendered payload can fabricate a line that looks like a
    // field of its own.
    const data = readDataOutput("6a0361_0a62".replace("_", ""));
    expect(data!.pushes![0]!.text).toBeUndefined();
  });

  it("refuses to describe an implausible number of pushes", () => {
    const payload = "0141".repeat(40); // 40 single-byte pushes
    const data = readDataOutput("6a" + payload);
    expect(data!.pushes).toBeUndefined();
    expect(data!.payloadHex).toBe(payload);
  });

  it("never throws, whatever bytes it is given", () => {
    const seeds = ["6a", "6a4c", "6a4d01", "6a4e00000001", "6aff", "6a00"];
    for (const hex of seeds) {
      expect(() => readDataOutput(hex)).not.toThrow();
    }
  });
});
