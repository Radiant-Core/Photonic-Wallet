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
  buildCallbackUrl,
  buildSignResult,
  encodeSignResult,
  encodeReqParam,
  extractChallengeNonce,
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

describe("parseSignRequest — callback origin-binding", () => {
  const withCallback = (fields: Record<string, unknown>) =>
    parseSignRequest(JSON.stringify({ challenge: CHALLENGE, ...fields }));

  it("keeps a callback whose origin matches the envelope origin", () => {
    const r = withCallback({
      origin: "https://surf.rxd.zone",
      callback: "https://surf.rxd.zone/auth/photonic-callback",
    });
    expect(r.ok && r.request.callback).toBe(
      "https://surf.rxd.zone/auth/photonic-callback"
    );
  });

  it("keeps a matching callback when the origin is given as a bare host", () => {
    const r = withCallback({
      origin: "surf.rxd.zone",
      callback: "https://surf.rxd.zone/cb",
    });
    expect(r.ok && r.request.callback).toBe("https://surf.rxd.zone/cb");
  });

  it("drops a callback pointing at a different origin", () => {
    // The attack this binding exists for: site A routing site B's signature
    // to an attacker-controlled callback.
    const r = withCallback({
      origin: "https://surf.rxd.zone",
      callback: "https://evil.example/steal",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.callback).toBeUndefined();
  });

  it("drops a callback that differs only by host suffix, scheme, or port", () => {
    const cases = [
      "https://surf.rxd.zone.evil.example/cb",
      "https://notsurf.rxd.zone/cb",
      "http://surf.rxd.zone/cb",
      "https://surf.rxd.zone:8443/cb",
    ];
    for (const callback of cases) {
      const r = withCallback({ origin: "https://surf.rxd.zone", callback });
      expect(r.ok && r.request.callback, callback).toBeUndefined();
    }
  });

  it("drops a callback when the envelope declares no origin to bind to", () => {
    const r = withCallback({ callback: "https://surf.rxd.zone/cb" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.callback).toBeUndefined();
  });

  it("drops non-http(s), relative, and credentialed callbacks", () => {
    const cases = [
      // The literal IS the test: this is the scheme the parser must refuse.
      // eslint-disable-next-line no-script-url
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/auth/photonic-callback",
      "https://user:pass@surf.rxd.zone/cb",
    ];
    for (const callback of cases) {
      const r = withCallback({ origin: "https://surf.rxd.zone", callback });
      expect(r.ok && r.request.callback, callback).toBeUndefined();
    }
  });

  it("strips any fragment the callback arrives with — we own the fragment", () => {
    const r = withCallback({
      origin: "https://surf.rxd.zone",
      callback: "https://surf.rxd.zone/cb#already-here",
    });
    expect(r.ok && r.request.callback).toBe("https://surf.rxd.zone/cb");
  });

  it("keeps the request when the callback is malformed", () => {
    const r = withCallback({
      origin: "https://surf.rxd.zone",
      callback: "not a url",
    });
    expect(r.ok && r.request.challenge).toBe(CHALLENGE);
    expect(r.ok && r.request.callback).toBeUndefined();
  });
});

describe("extractChallengeNonce", () => {
  it("takes the segment after the wallet-connect version", () => {
    expect(
      extractChallengeNonce("radiant:wallet-connect:v1:abc123:SURF.RXD sign-in")
    ).toBe("abc123");
  });

  it("returns undefined for an unrecognized challenge", () => {
    expect(extractChallengeNonce("just some text")).toBeUndefined();
    expect(extractChallengeNonce("")).toBeUndefined();
  });
});

describe("buildCallbackUrl", () => {
  const SIGNED = {
    address: "14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i",
    signature:
      "IHdStUu1KegHDyNSnHtD+yRS+A3/0P4xGlyu8yF/HLg9Tjek8tliTbCjbqy1Xi4cMwJuVHQbMBGo5fsPpmZ3W6s=",
  };

  it("matches the contract's test vector", () => {
    const url = buildCallbackUrl(
      {
        challenge: "radiant:wallet-connect:v1:abc123:SURF.RXD sign-in | …",
        callback: "https://surf.rxd.zone/auth/photonic-callback",
      },
      SIGNED
    );
    expect(url).toBe(
      "https://surf.rxd.zone/auth/photonic-callback#nonce=abc123&address=14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i&signature=IHdStUu1KegHDyNSnHtD%2ByRS%2BA3%2F0P4xGlyu8yF%2FHLg9Tjek8tliTbCjbqy1Xi4cMwJuVHQbMBGo5fsPpmZ3W6s%3D"
    );
  });

  it("puts the result in the fragment, never the query", () => {
    const url = buildCallbackUrl(
      { challenge: CHALLENGE, callback: "https://surf.rxd.zone/cb" },
      SIGNED
    )!;
    expect(url.indexOf("#")).toBeGreaterThan(-1);
    expect(url.slice(0, url.indexOf("#"))).not.toMatch(/[?&]/);
    expect(url.split("#")[1]).toContain("signature=");
  });

  it("omits the nonce when the challenge carries none", () => {
    const url = buildCallbackUrl(
      { challenge: "freeform text", callback: "https://surf.rxd.zone/cb" },
      SIGNED
    );
    expect(url).not.toContain("nonce=");
    expect(url).toContain("address=");
  });

  it("returns undefined when the request has no callback", () => {
    expect(buildCallbackUrl({ challenge: CHALLENGE }, SIGNED)).toBeUndefined();
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
