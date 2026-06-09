/**
 * Unit tests for the connect wire format (`../protocol`). Pure parsing/encoding
 * — no crypto, no React. Covers the three accepted transports (bare challenge,
 * JSON envelope, base64url envelope), version/type guards, the challenge safety
 * guards, display-field sanitization, and the recognized-challenge badge.
 */
import { it, expect, describe } from "vitest";
import {
  parseSignRequest,
  isRecognizedConnectChallenge,
  buildSignResult,
  encodeSignResult,
  encodeReqParam,
  CONNECT_PROTOCOL,
  CONNECT_VERSION,
  type SignRequest,
} from "../protocol";

const CHALLENGE = "glyphgalaxy:wallet-connect:v1:sess-abc123:deadbeefdeadbeef";

describe("parseSignRequest — bare challenge", () => {
  it("accepts a bare challenge string", () => {
    const r = parseSignRequest(CHALLENGE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.challenge).toBe(CHALLENGE);
      expect(r.request.protocol).toBe(CONNECT_PROTOCOL);
      expect(r.request.v).toBe(CONNECT_VERSION);
      expect(r.request.t).toBe("sign-request");
      expect(r.request.origin).toBeUndefined();
    }
  });

  it("trims surrounding whitespace from a bare challenge", () => {
    const r = parseSignRequest(`\n  ${CHALLENGE}  \n`);
    expect(r.ok && r.request.challenge).toBe(CHALLENGE);
  });

  it("rejects empty / whitespace-only input", () => {
    expect(parseSignRequest("").ok).toBe(false);
    expect(parseSignRequest("   \n ").ok).toBe(false);
  });

  it("rejects a challenge with control characters", () => {
    const bad = `glyph${String.fromCharCode(0)}auth`;
    const r = parseSignRequest(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/control characters/);
  });

  it("rejects an over-long challenge", () => {
    const r = parseSignRequest("a".repeat(5000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too long/);
  });
});

describe("parseSignRequest — JSON envelope", () => {
  it("accepts a full envelope and sanitizes display fields", () => {
    const r = parseSignRequest(
      JSON.stringify({
        protocol: CONNECT_PROTOCOL,
        v: 1,
        t: "sign-request",
        challenge: CHALLENGE,
        id: "req-1",
        origin: "https://app.glyphgalaxy.com",
        app: "GlyphGalaxy",
        address: "16hsngnxdvrBSrAzksiFguCbK5t6gQMxcR",
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.challenge).toBe(CHALLENGE);
      expect(r.request.id).toBe("req-1");
      expect(r.request.origin).toBe("https://app.glyphgalaxy.com");
      expect(r.request.app).toBe("GlyphGalaxy");
      expect(r.request.address).toBe("16hsngnxdvrBSrAzksiFguCbK5t6gQMxcR");
    }
  });

  it("accepts a minimal envelope (challenge only)", () => {
    const r = parseSignRequest(JSON.stringify({ challenge: CHALLENGE }));
    expect(r.ok && r.request.challenge).toBe(CHALLENGE);
  });

  it("drops a malformed origin (whitespace) but keeps the request", () => {
    const r = parseSignRequest(
      JSON.stringify({ challenge: CHALLENGE, origin: "not a url with spaces" })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.origin).toBeUndefined();
  });

  it("drops a malformed address but keeps the request", () => {
    const r = parseSignRequest(
      JSON.stringify({ challenge: CHALLENGE, address: "bad addr!!" })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.address).toBeUndefined();
  });

  it("rejects an unsupported version", () => {
    const r = parseSignRequest(JSON.stringify({ v: 2, challenge: CHALLENGE }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version/);
  });

  it("rejects an unsupported request type", () => {
    const r = parseSignRequest(
      JSON.stringify({ t: "sign-tx", challenge: CHALLENGE })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/request type/);
  });

  it("rejects an unsupported protocol", () => {
    const r = parseSignRequest(
      JSON.stringify({ protocol: "evil-wallet", challenge: CHALLENGE })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/protocol/);
  });

  it("rejects an envelope with a control-char challenge", () => {
    const r = parseSignRequest(
      JSON.stringify({ challenge: `x${String.fromCharCode(7)}y` })
    );
    expect(r.ok).toBe(false);
  });
});

describe("parseSignRequest — base64url envelope + round-trip", () => {
  it("round-trips encodeReqParam → parseSignRequest", () => {
    const req: SignRequest = {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "sign-request",
      challenge: CHALLENGE,
      id: "abc",
      origin: "https://app.glyphgalaxy.com",
    };
    const param = encodeReqParam(req);
    expect(param).not.toMatch(/[+/=]/); // base64url, no padding
    const r = parseSignRequest(param);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.challenge).toBe(CHALLENGE);
      expect(r.request.id).toBe("abc");
      expect(r.request.origin).toBe("https://app.glyphgalaxy.com");
    }
  });
});

describe("isRecognizedConnectChallenge", () => {
  it("matches the namespaced wallet-connect shape", () => {
    expect(isRecognizedConnectChallenge(CHALLENGE)).toBe(true);
    expect(
      isRecognizedConnectChallenge("glyphgalaxy:plot-auth:v2:deadbeef")
    ).toBe(false);
    expect(isRecognizedConnectChallenge("just some text")).toBe(false);
    expect(isRecognizedConnectChallenge("")).toBe(false);
  });
});

describe("buildSignResult / encodeSignResult", () => {
  it("builds and serializes a result, echoing the id", () => {
    const result = buildSignResult(
      { id: "req-1" },
      { address: "1addr", pubkey: "02pub", signature: "sigbase64" }
    );
    expect(result).toMatchObject({
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "sign-result",
      id: "req-1",
      address: "1addr",
      pubkey: "02pub",
      signature: "sigbase64",
    });
    const json = encodeSignResult(result);
    expect(JSON.parse(json)).toEqual(result);
  });

  it("omits id when the request had none", () => {
    const result = buildSignResult(
      {},
      { address: "1addr", pubkey: "02pub", signature: "sig" }
    );
    expect("id" in result).toBe(false);
  });
});
