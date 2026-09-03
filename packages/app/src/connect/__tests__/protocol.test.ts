/**
 * Unit tests for the connect wire format (`../protocol`). Pure parsing/encoding
 * — no crypto, no React. Covers the three accepted transports (bare challenge,
 * JSON envelope, base64url envelope), version/type guards, the challenge safety
 * guards, display-field sanitization, and the recognized-challenge badge.
 */
import { it, expect, describe } from "vitest";
import {
  parseSignRequest,
  parseConnectRequest,
  isRecognizedConnectChallenge,
  parseCanonDeclaration,
  canonDeclarationFromDocument,
  buildAnchorResult,
  buildAnchorCallbackUrl,
  buildCallbackUrl,
  buildSignResult,
  encodeSignResult,
  encodeReqParam,
  extractChallengeNonce,
  buildPsbtResult,
  buildPsbtCallbackUrl,
  encodePsbtResult,
  buildMintResult,
  buildMintCallbackUrl,
  encodeMintResult,
  buildSwapOfferResult,
  buildSwapOfferCallbackUrl,
  encodeSwapOfferResult,
  buildSwapAcceptResult,
  buildSwapAcceptCallbackUrl,
  encodeSwapAcceptResult,
  buildSwapCancelResult,
  buildSwapCancelCallbackUrl,
  encodeSwapCancelResult,
  buildRejectCallbackUrl,
  classifyConnectError,
  buildErrorCallbackUrl,
  MAX_PSBT_LEN,
  MAX_CALLBACK_URL_LEN,
  MAX_MINT_DATA_LEN,
  MINT_ALLOWED_MIME_TYPES,
  CONNECT_PROTOCOL,
  CONNECT_VERSION,
  type SignRequest,
  type PsbtSignRequest,
  type MintRequest,
  type SwapOfferRequest,
  type SwapAcceptRequest,
  type SwapCancelRequest,
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

// A plausible base64 payload (real PSBT magic bytes) — the protocol layer
// only validates charset/length here, never PSBT structure (that's `@lib/psbt`'s
// job), so any base64-charset string exercises these guards.
const SAMPLE_PSBT_B64 = "cHNidP8BAAoCAAAAAAAAAAAAAAA=";

describe("parseConnectRequest — psbt-sign-request envelope", () => {
  it("accepts a minimal envelope (psbt only)", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "psbt-sign-request", psbt: SAMPLE_PSBT_B64 })
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "psbt-sign-request") {
      expect(r.request.psbt).toBe(SAMPLE_PSBT_B64);
      expect(r.request.broadcast).toBe(false);
      expect(r.request.protocol).toBe(CONNECT_PROTOCOL);
      expect(r.request.v).toBe(CONNECT_VERSION);
    } else {
      throw new Error("expected a psbt-sign-request");
    }
  });

  it("accepts a full envelope and sanitizes display fields", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "psbt-sign-request",
        psbt: SAMPLE_PSBT_B64,
        broadcast: true,
        id: "req-1",
        origin: "https://app.glyphgalaxy.com",
        app: "GlyphGalaxy",
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "psbt-sign-request") {
      expect(r.request.broadcast).toBe(true);
      expect(r.request.id).toBe("req-1");
      expect(r.request.origin).toBe("https://app.glyphgalaxy.com");
      expect(r.request.app).toBe("GlyphGalaxy");
    } else {
      throw new Error("expected a psbt-sign-request");
    }
  });

  it.each([undefined, "true", 1, "yes"])(
    "only the literal boolean true opts into broadcast (got %j)",
    (broadcast) => {
      const r = parseConnectRequest(
        JSON.stringify({ t: "psbt-sign-request", psbt: SAMPLE_PSBT_B64, broadcast })
      );
      expect(r.ok && r.request.t === "psbt-sign-request" && r.request.broadcast).toBe(
        false
      );
    }
  );

  it("rejects a request missing psbt", () => {
    const r = parseConnectRequest(JSON.stringify({ t: "psbt-sign-request" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing a psbt/);
  });

  it("rejects a psbt field that isn't base64", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "psbt-sign-request", psbt: "not base64!! spaces" })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a psbt field over MAX_PSBT_LEN", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "psbt-sign-request", psbt: "A".repeat(MAX_PSBT_LEN + 1) })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too long/);
  });

  it("rejects an unsupported version / protocol, same as sign-request", () => {
    const badVersion = parseConnectRequest(
      JSON.stringify({ t: "psbt-sign-request", v: 2, psbt: SAMPLE_PSBT_B64 })
    );
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) expect(badVersion.error).toMatch(/version/);

    const badProtocol = parseConnectRequest(
      JSON.stringify({
        t: "psbt-sign-request",
        protocol: "evil-wallet",
        psbt: SAMPLE_PSBT_B64,
      })
    );
    expect(badProtocol.ok).toBe(false);
    if (!badProtocol.ok) expect(badProtocol.error).toMatch(/protocol/);
  });

  it("still rejects unrelated unsupported request types", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "sign-tx", psbt: SAMPLE_PSBT_B64 })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/request type/);
  });

  it("binds the callback to the declared origin, same rule as sign-request", () => {
    const kept = parseConnectRequest(
      JSON.stringify({
        t: "psbt-sign-request",
        psbt: SAMPLE_PSBT_B64,
        origin: "https://surf.rxd.zone",
        callback: "https://surf.rxd.zone/psbt-callback",
      })
    );
    expect(kept.ok && kept.request.t === "psbt-sign-request" && kept.request.callback).toBe(
      "https://surf.rxd.zone/psbt-callback"
    );

    const dropped = parseConnectRequest(
      JSON.stringify({
        t: "psbt-sign-request",
        psbt: SAMPLE_PSBT_B64,
        origin: "https://surf.rxd.zone",
        callback: "https://evil.example/steal",
      })
    );
    expect(
      dropped.ok && dropped.request.t === "psbt-sign-request" && dropped.request.callback
    ).toBeUndefined();
  });

  it("round-trips via encodeReqParam / encodePsbtReqParam", () => {
    const req: PsbtSignRequest = {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "psbt-sign-request",
      psbt: SAMPLE_PSBT_B64,
      broadcast: true,
      id: "abc",
    };
    const param = encodeReqParam(req);
    expect(param).not.toMatch(/[+/=]/);
    const r = parseConnectRequest(param);
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "psbt-sign-request") {
      expect(r.request.psbt).toBe(SAMPLE_PSBT_B64);
      expect(r.request.broadcast).toBe(true);
      expect(r.request.id).toBe("abc");
    } else {
      throw new Error("expected a psbt-sign-request");
    }
  });
});

describe("parseSignRequest — legacy alias narrows to sign-request only", () => {
  it("errors when handed a psbt-sign-request envelope", () => {
    const r = parseSignRequest(
      JSON.stringify({ t: "psbt-sign-request", psbt: SAMPLE_PSBT_B64 })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/request type/);
  });
});

describe("buildPsbtResult / encodePsbtResult", () => {
  it("builds a psbt-return result, echoing the id", () => {
    const result = buildPsbtResult(
      { id: "req-1" },
      { psbt: SAMPLE_PSBT_B64, complete: false }
    );
    expect(result).toMatchObject({
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "psbt-sign-result",
      id: "req-1",
      psbt: SAMPLE_PSBT_B64,
      complete: false,
    });
    expect("txid" in result).toBe(false);
    expect(JSON.parse(encodePsbtResult(result))).toEqual(result);
  });

  it("builds a txid-return result and omits id when absent", () => {
    const result = buildPsbtResult(
      {},
      { txid: "ab".repeat(32), complete: true }
    );
    expect("id" in result).toBe(false);
    expect("psbt" in result).toBe(false);
    expect(result.txid).toBe("ab".repeat(32));
    expect(result.complete).toBe(true);
  });
});

describe("buildPsbtCallbackUrl", () => {
  it("returns a txid fragment when broadcast completed", () => {
    const url = buildPsbtCallbackUrl(
      { callback: "https://surf.rxd.zone/cb" },
      { id: "req-1", txid: "ab".repeat(32), complete: true }
    );
    expect(url).toBe(
      `https://surf.rxd.zone/cb#id=req-1&txid=${"ab".repeat(32)}&complete=true`
    );
  });

  it("returns a psbt fragment when returning a signed PSBT", () => {
    const url = buildPsbtCallbackUrl(
      { callback: "https://surf.rxd.zone/cb" },
      { psbt: SAMPLE_PSBT_B64, complete: false }
    );
    expect(url).toBe(
      `https://surf.rxd.zone/cb#psbt=${encodeURIComponent(SAMPLE_PSBT_B64)}&complete=false`
    );
  });

  it("puts the result in the fragment, never the query", () => {
    const url = buildPsbtCallbackUrl(
      { callback: "https://surf.rxd.zone/cb" },
      { txid: "ab".repeat(32), complete: true }
    )!;
    expect(url.indexOf("#")).toBeGreaterThan(-1);
    expect(url.slice(0, url.indexOf("#"))).not.toMatch(/[?&]/);
  });

  it("returns undefined when the request has no callback", () => {
    expect(
      buildPsbtCallbackUrl({}, { txid: "ab".repeat(32), complete: true })
    ).toBeUndefined();
  });

  it("returns undefined rather than truncate when the composed URL is too large", () => {
    const url = buildPsbtCallbackUrl(
      { callback: "https://surf.rxd.zone/cb" },
      { psbt: "A".repeat(MAX_CALLBACK_URL_LEN), complete: false }
    );
    expect(url).toBeUndefined();
  });
});

const SAMPLE_IMAGE_B64 = "aGVsbG8gd29ybGQ="; // "hello world" — content is opaque to the protocol layer

describe("parseConnectRequest — mint-request envelope", () => {
  it("accepts a minimal envelope (name + embedded main only)", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        name: "My NFT",
        main: { mime: "image/png", data: SAMPLE_IMAGE_B64 },
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "mint-request") {
      expect(r.request.name).toBe("My NFT");
      expect(r.request.main).toEqual({ mime: "image/png", data: SAMPLE_IMAGE_B64 });
      expect(r.request.description).toBeUndefined();
      expect(r.request.attrs).toBeUndefined();
    } else {
      throw new Error("expected a mint-request");
    }
  });

  it("accepts a full envelope with description, license, attrs, feeRate", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        name: "Realm Sword",
        description: "A legendary blade",
        license: "CC0",
        attrs: { rarity: "legendary", power: 42, tradeable: true },
        main: { mime: "image/png", data: SAMPLE_IMAGE_B64 },
        feeRate: 15000,
        id: "req-1",
        origin: "https://realm.rxd",
        app: "Realm",
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "mint-request") {
      expect(r.request.description).toBe("A legendary blade");
      expect(r.request.license).toBe("CC0");
      expect(r.request.attrs).toEqual({
        rarity: "legendary",
        power: 42,
        tradeable: true,
      });
      expect(r.request.feeRate).toBe(15000);
      expect(r.request.id).toBe("req-1");
      expect(r.request.origin).toBe("https://realm.rxd");
      expect(r.request.app).toBe("Realm");
    } else {
      throw new Error("expected a mint-request");
    }
  });

  it("accepts a remote (url) main instead of embedded data", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        name: "Remote NFT",
        main: { mime: "image/png", url: "https://realm.rxd/assets/sword.png" },
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "mint-request") {
      expect(r.request.main).toEqual({
        mime: "image/png",
        url: "https://realm.rxd/assets/sword.png",
      });
    } else {
      throw new Error("expected a mint-request");
    }
  });

  it("rejects a request missing a name", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "mint-request", main: { mime: "image/png", data: SAMPLE_IMAGE_B64 } })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing a name/);
  });

  it("rejects a request missing main content", () => {
    const r = parseConnectRequest(JSON.stringify({ t: "mint-request", name: "X" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/main content/);
  });

  it("rejects a disallowed mime type", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        name: "X",
        main: { mime: "application/x-executable", data: SAMPLE_IMAGE_B64 },
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unsupported mime type/);
  });

  it("accepts every MIME type in the allow-list", () => {
    for (const mime of MINT_ALLOWED_MIME_TYPES) {
      const r = parseConnectRequest(
        JSON.stringify({ t: "mint-request", name: "X", main: { mime, data: SAMPLE_IMAGE_B64 } })
      );
      expect(r.ok, mime).toBe(true);
    }
  });

  it("rejects main.data that isn't valid base64", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        name: "X",
        main: { mime: "image/png", data: "not base64!! spaces" },
      })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects main.data over MAX_MINT_DATA_LEN", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        name: "X",
        main: { mime: "image/png", data: "A".repeat(MAX_MINT_DATA_LEN + 1) },
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large/);
  });

  it("rejects a non-http(s) main.url", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        name: "X",
        // eslint-disable-next-line no-script-url
        main: { mime: "image/png", url: "javascript:alert(1)" },
      })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects main with neither data nor url", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "mint-request", name: "X", main: { mime: "image/png" } })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/data or a url/);
  });

  it("caps attrs to string/number/boolean values via filterAttrs, dropping the rest", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        name: "X",
        main: { mime: "image/png", data: SAMPLE_IMAGE_B64 },
        attrs: { ok: "yes", nested: { a: 1 }, arr: [1, 2], long: "x".repeat(200) },
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "mint-request") {
      expect(r.request.attrs).toEqual({ ok: "yes" });
    } else {
      throw new Error("expected a mint-request");
    }
  });

  it("rejects a feeRate that isn't a positive number", () => {
    for (const feeRate of [-1, 0, "1000", NaN]) {
      const r = parseConnectRequest(
        JSON.stringify({
          t: "mint-request",
          name: "X",
          main: { mime: "image/png", data: SAMPLE_IMAGE_B64 },
          feeRate,
        })
      );
      expect(r.ok, JSON.stringify(feeRate)).toBe(false);
    }
  });

  it("rejects an unsupported version / protocol, same as other request types", () => {
    const badVersion = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        v: 2,
        name: "X",
        main: { mime: "image/png", data: SAMPLE_IMAGE_B64 },
      })
    );
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) expect(badVersion.error).toMatch(/version/);
  });

  it("binds the callback to the declared origin, same rule as other request types", () => {
    const kept = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        name: "X",
        main: { mime: "image/png", data: SAMPLE_IMAGE_B64 },
        origin: "https://realm.rxd",
        callback: "https://realm.rxd/mint-callback",
      })
    );
    expect(
      kept.ok && kept.request.t === "mint-request" && kept.request.callback
    ).toBe("https://realm.rxd/mint-callback");

    const dropped = parseConnectRequest(
      JSON.stringify({
        t: "mint-request",
        name: "X",
        main: { mime: "image/png", data: SAMPLE_IMAGE_B64 },
        origin: "https://realm.rxd",
        callback: "https://evil.example/steal",
      })
    );
    expect(
      dropped.ok && dropped.request.t === "mint-request" && dropped.request.callback
    ).toBeUndefined();
  });

  it("round-trips via encodeReqParam", () => {
    const req: MintRequest = {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "mint-request",
      name: "Realm Sword",
      main: { mime: "image/png", data: SAMPLE_IMAGE_B64 },
      id: "abc",
    };
    const param = encodeReqParam(req);
    expect(param).not.toMatch(/[+/=]/);
    const r = parseConnectRequest(param);
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "mint-request") {
      expect(r.request.name).toBe("Realm Sword");
      expect(r.request.id).toBe("abc");
    } else {
      throw new Error("expected a mint-request");
    }
  });
});

describe("buildMintResult / encodeMintResult", () => {
  it("builds a broadcast mint result, echoing the id", () => {
    const result = buildMintResult(
      { id: "req-1" },
      {
        broadcast: true,
        commitTxid: "aa".repeat(32),
        revealTxid: "bb".repeat(32),
        ref: "cc".repeat(36),
      }
    );
    expect(result).toMatchObject({
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "mint-result",
      id: "req-1",
      broadcast: true,
      commitTxid: "aa".repeat(32),
      revealTxid: "bb".repeat(32),
      ref: "cc".repeat(36),
    });
    expect("commitHex" in result).toBe(false);
    expect(JSON.parse(encodeMintResult(result))).toEqual(result);
  });

  it("builds a dry-run mint result with hex instead of txids", () => {
    const result = buildMintResult(
      {},
      {
        broadcast: false,
        commitHex: "aa".repeat(20),
        revealHex: "bb".repeat(20),
        ref: "cc".repeat(36),
      }
    );
    expect(result.broadcast).toBe(false);
    expect(result.commitHex).toBe("aa".repeat(20));
    expect(result.revealHex).toBe("bb".repeat(20));
    expect("commitTxid" in result).toBe(false);
    expect("revealTxid" in result).toBe(false);
    expect("id" in result).toBe(false);
  });
});

describe("buildMintCallbackUrl", () => {
  it("puts broadcast/commitTxid/revealTxid/ref in the fragment, never the query", () => {
    const url = buildMintCallbackUrl(
      { callback: "https://realm.rxd/cb" },
      {
        id: "req-1",
        broadcast: true,
        commitTxid: "aa".repeat(32),
        revealTxid: "bb".repeat(32),
        ref: "cc".repeat(36),
      }
    );
    expect(url).toBe(
      `https://realm.rxd/cb#id=req-1&broadcast=true&ref=${"cc".repeat(36)}&commitTxid=${"aa".repeat(32)}&revealTxid=${"bb".repeat(32)}`
    );
  });

  it("puts commitHex/revealHex in the fragment for a dry run", () => {
    const url = buildMintCallbackUrl(
      { callback: "https://realm.rxd/cb" },
      { broadcast: false, commitHex: "aa".repeat(10), revealHex: "bb".repeat(10), ref: "cc".repeat(36) }
    );
    expect(url).toContain("broadcast=false");
    expect(url).toContain(`commitHex=${"aa".repeat(10)}`);
    expect(url).toContain(`revealHex=${"bb".repeat(10)}`);
    expect(url).not.toContain("commitTxid=");
  });

  it("returns undefined when the request has no callback", () => {
    expect(
      buildMintCallbackUrl(
        {},
        {
          broadcast: true,
          commitTxid: "aa".repeat(32),
          revealTxid: "bb".repeat(32),
          ref: "cc".repeat(36),
        }
      )
    ).toBeUndefined();
  });

  it("returns undefined rather than truncate when the composed URL is too large", () => {
    const url = buildMintCallbackUrl(
      { callback: "https://realm.rxd/cb" },
      {
        broadcast: true,
        commitTxid: "aa".repeat(32),
        revealTxid: "bb".repeat(32),
        ref: "c".repeat(MAX_CALLBACK_URL_LEN),
      }
    );
    expect(url).toBeUndefined();
  });
});

const SAMPLE_REF = "ab".repeat(36); // 72 hex chars: 32-byte txid + 4-byte vout
const SAMPLE_PSRT_HEX = "aa".repeat(50); // even-length hex; content is opaque to protocol.ts

describe("parseConnectRequest — swap-offer-request envelope", () => {
  it("accepts a minimal envelope", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "swap-offer-request",
        ref: SAMPLE_REF,
        priceRxd: 10,
        mode: "private",
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "swap-offer-request") {
      expect(r.request.ref).toBe(SAMPLE_REF);
      expect(r.request.priceRxd).toBe(10);
      expect(r.request.mode).toBe("private");
    } else {
      throw new Error("expected a swap-offer-request");
    }
  });

  it("lowercases the ref", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "swap-offer-request",
        ref: SAMPLE_REF.toUpperCase(),
        priceRxd: 10,
        mode: "private",
      })
    );
    expect(r.ok && r.request.t === "swap-offer-request" && r.request.ref).toBe(
      SAMPLE_REF
    );
  });

  it("rejects a missing or malformed ref", () => {
    for (const ref of [undefined, "not-a-ref", "ab".repeat(35), "ab".repeat(37)]) {
      const r = parseConnectRequest(
        JSON.stringify({ t: "swap-offer-request", ref, priceRxd: 10, mode: "private" })
      );
      expect(r.ok, JSON.stringify(ref)).toBe(false);
    }
  });

  it("rejects a non-positive or non-numeric priceRxd", () => {
    for (const priceRxd of [-1, 0, "10", NaN]) {
      const r = parseConnectRequest(
        JSON.stringify({ t: "swap-offer-request", ref: SAMPLE_REF, priceRxd, mode: "private" })
      );
      expect(r.ok, JSON.stringify(priceRxd)).toBe(false);
    }
  });

  it('rejects "broadcast" mode with a specific message', () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "swap-offer-request",
        ref: SAMPLE_REF,
        priceRxd: 10,
        mode: "broadcast",
      })
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not yet supported/);
  });

  it("rejects a missing mode", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "swap-offer-request", ref: SAMPLE_REF, priceRxd: 10 })
    );
    expect(r.ok).toBe(false);
  });

  it("binds the callback to the declared origin, same rule as other request types", () => {
    const kept = parseConnectRequest(
      JSON.stringify({
        t: "swap-offer-request",
        ref: SAMPLE_REF,
        priceRxd: 10,
        mode: "private",
        origin: "https://realm.rxd",
        callback: "https://realm.rxd/cb",
      })
    );
    expect(
      kept.ok && kept.request.t === "swap-offer-request" && kept.request.callback
    ).toBe("https://realm.rxd/cb");

    const dropped = parseConnectRequest(
      JSON.stringify({
        t: "swap-offer-request",
        ref: SAMPLE_REF,
        priceRxd: 10,
        mode: "private",
        origin: "https://realm.rxd",
        callback: "https://evil.example/steal",
      })
    );
    expect(
      dropped.ok && dropped.request.t === "swap-offer-request" && dropped.request.callback
    ).toBeUndefined();
  });

  it("round-trips via encodeReqParam", () => {
    const req: SwapOfferRequest = {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "swap-offer-request",
      ref: SAMPLE_REF,
      priceRxd: 10,
      mode: "private",
      id: "abc",
    };
    const param = encodeReqParam(req);
    const r = parseConnectRequest(param);
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "swap-offer-request") {
      expect(r.request.ref).toBe(SAMPLE_REF);
      expect(r.request.id).toBe("abc");
    } else {
      throw new Error("expected a swap-offer-request");
    }
  });
});

const SAMPLE_RESERVE_TXID = "cc".repeat(32);
const SAMPLE_SWAP_ADDRESS = "16hsngnxdvrBSrAzksiFguCbK5t6gQMxcR";
const SAMPLE_PAYOUT_ADDRESS = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const SAMPLE_PRICE_RXD = 12.5;

function sampleOfferOutcome(overrides: Partial<{
  psrt: string;
  reserveTxid: string;
  reserveVout: number;
  swapAddress: string;
  ref: string;
  payoutAddress: string;
  priceRxd: number;
}> = {}) {
  return {
    psrt: SAMPLE_PSRT_HEX,
    reserveTxid: SAMPLE_RESERVE_TXID,
    reserveVout: 0,
    swapAddress: SAMPLE_SWAP_ADDRESS,
    ref: SAMPLE_REF,
    payoutAddress: SAMPLE_PAYOUT_ADDRESS,
    priceRxd: SAMPLE_PRICE_RXD,
    ...overrides,
  };
}

describe("buildSwapOfferResult / encodeSwapOfferResult / buildSwapOfferCallbackUrl", () => {
  it("builds and serializes a result, echoing the id", () => {
    const result = buildSwapOfferResult({ id: "req-1" }, sampleOfferOutcome());
    expect(result).toMatchObject({
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "swap-offer-result",
      id: "req-1",
      psrt: SAMPLE_PSRT_HEX,
      reserveTxid: SAMPLE_RESERVE_TXID,
      reserveVout: 0,
      swapAddress: SAMPLE_SWAP_ADDRESS,
      ref: SAMPLE_REF,
      payoutAddress: SAMPLE_PAYOUT_ADDRESS,
      priceRxd: SAMPLE_PRICE_RXD,
    });
    expect(JSON.parse(encodeSwapOfferResult(result))).toEqual(result);
  });

  it("puts the reserve outpoint, swapAddress, ref, payoutAddress, priceRxd, and psrt in the fragment, never the query", () => {
    const url = buildSwapOfferCallbackUrl(
      { callback: "https://realm.rxd/cb" },
      sampleOfferOutcome()
    )!;
    expect(url.indexOf("#")).toBeGreaterThan(-1);
    expect(url.slice(0, url.indexOf("#"))).not.toMatch(/[?&]/);
    expect(url).toContain(`reserveTxid=${SAMPLE_RESERVE_TXID}`);
    expect(url).toContain("reserveVout=0");
    expect(url).toContain(`swapAddress=${SAMPLE_SWAP_ADDRESS}`);
    expect(url).toContain(`ref=${SAMPLE_REF}`);
    expect(url).toContain(`payoutAddress=${SAMPLE_PAYOUT_ADDRESS}`);
    expect(url).toContain(`priceRxd=${SAMPLE_PRICE_RXD}`);
  });

  it("returns undefined rather than truncate when the composed URL is too large", () => {
    const url = buildSwapOfferCallbackUrl(
      { callback: "https://realm.rxd/cb" },
      sampleOfferOutcome({ psrt: "a".repeat(MAX_CALLBACK_URL_LEN) })
    );
    expect(url).toBeUndefined();
  });
});

describe("parseConnectRequest — swap-accept-request envelope", () => {
  it("accepts a minimal envelope (psrt only)", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "swap-accept-request", psrt: SAMPLE_PSRT_HEX })
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "swap-accept-request") {
      expect(r.request.psrt).toBe(SAMPLE_PSRT_HEX);
      expect(r.request.feeRxd).toBeUndefined();
      expect(r.request.feeAddress).toBeUndefined();
    } else {
      throw new Error("expected a swap-accept-request");
    }
  });

  it("accepts a full envelope with feeRxd + feeAddress", () => {
    const r = parseConnectRequest(
      JSON.stringify({
        t: "swap-accept-request",
        psrt: SAMPLE_PSRT_HEX,
        feeRxd: 0.25,
        feeAddress: "16hsngnxdvrBSrAzksiFguCbK5t6gQMxcR",
      })
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "swap-accept-request") {
      expect(r.request.feeRxd).toBe(0.25);
      expect(r.request.feeAddress).toBe("16hsngnxdvrBSrAzksiFguCbK5t6gQMxcR");
    } else {
      throw new Error("expected a swap-accept-request");
    }
  });

  it("rejects a request missing psrt", () => {
    const r = parseConnectRequest(JSON.stringify({ t: "swap-accept-request" }));
    expect(r.ok).toBe(false);
  });

  it("rejects psrt that isn't valid hex", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "swap-accept-request", psrt: "not hex zz" })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects odd-length psrt hex", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "swap-accept-request", psrt: "abc" })
    );
    expect(r.ok).toBe(false);
  });

  it("rejects feeRxd without feeAddress, and vice versa", () => {
    const r1 = parseConnectRequest(
      JSON.stringify({ t: "swap-accept-request", psrt: SAMPLE_PSRT_HEX, feeRxd: 1 })
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/together/);

    const r2 = parseConnectRequest(
      JSON.stringify({
        t: "swap-accept-request",
        psrt: SAMPLE_PSRT_HEX,
        feeAddress: "16hsngnxdvrBSrAzksiFguCbK5t6gQMxcR",
      })
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/together/);
  });

  it("rejects a non-positive feeRxd or malformed feeAddress", () => {
    const badFee = parseConnectRequest(
      JSON.stringify({
        t: "swap-accept-request",
        psrt: SAMPLE_PSRT_HEX,
        feeRxd: 0,
        feeAddress: "16hsngnxdvrBSrAzksiFguCbK5t6gQMxcR",
      })
    );
    expect(badFee.ok).toBe(false);

    const badAddr = parseConnectRequest(
      JSON.stringify({
        t: "swap-accept-request",
        psrt: SAMPLE_PSRT_HEX,
        feeRxd: 1,
        feeAddress: "not an address!!",
      })
    );
    expect(badAddr.ok).toBe(false);
  });

  it("rejects a feeAddress that passes the charset check but fails base58check", () => {
    // The last character is altered, so the checksum no longer matches. This
    // is charset-legal and was previously accepted here, only blowing up
    // later inside `p2pkhScript` — after the user had already approved.
    const corrupted = parseConnectRequest(
      JSON.stringify({
        t: "swap-accept-request",
        psrt: SAMPLE_PSRT_HEX,
        feeRxd: 1,
        feeAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb",
      })
    );
    expect(corrupted.ok).toBe(false);
    expect(!corrupted.ok && corrupted.error).toMatch(/feeAddress/);
  });

  it("accepts a testnet feeAddress — network is not this layer's call", () => {
    // Parsing is network-agnostic on purpose; swapFlow does the
    // wallet-network comparison, where the wallet's network is known.
    const testnet = parseConnectRequest(
      JSON.stringify({
        t: "swap-accept-request",
        psrt: SAMPLE_PSRT_HEX,
        feeRxd: 1,
        feeAddress: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",
      })
    );
    expect(testnet.ok).toBe(true);
  });

  it("binds the callback to the declared origin, same rule as other request types", () => {
    const kept = parseConnectRequest(
      JSON.stringify({
        t: "swap-accept-request",
        psrt: SAMPLE_PSRT_HEX,
        origin: "https://realm.rxd",
        callback: "https://realm.rxd/cb",
      })
    );
    expect(
      kept.ok && kept.request.t === "swap-accept-request" && kept.request.callback
    ).toBe("https://realm.rxd/cb");

    const dropped = parseConnectRequest(
      JSON.stringify({
        t: "swap-accept-request",
        psrt: SAMPLE_PSRT_HEX,
        origin: "https://realm.rxd",
        callback: "https://evil.example/steal",
      })
    );
    expect(
      dropped.ok && dropped.request.t === "swap-accept-request" && dropped.request.callback
    ).toBeUndefined();
  });

  it("round-trips via encodeReqParam", () => {
    const req: SwapAcceptRequest = {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "swap-accept-request",
      psrt: SAMPLE_PSRT_HEX,
      id: "abc",
    };
    const param = encodeReqParam(req);
    const r = parseConnectRequest(param);
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "swap-accept-request") {
      expect(r.request.psrt).toBe(SAMPLE_PSRT_HEX);
      expect(r.request.id).toBe("abc");
    } else {
      throw new Error("expected a swap-accept-request");
    }
  });
});

describe("buildSwapAcceptResult / encodeSwapAcceptResult / buildSwapAcceptCallbackUrl", () => {
  it("builds and serializes a result, echoing the id", () => {
    const result = buildSwapAcceptResult({ id: "req-1" }, { txid: "aa".repeat(32) });
    expect(result).toMatchObject({
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "swap-accept-result",
      id: "req-1",
      txid: "aa".repeat(32),
    });
    expect(JSON.parse(encodeSwapAcceptResult(result))).toEqual(result);
  });

  it("omits id when the request had none", () => {
    const result = buildSwapAcceptResult({}, { txid: "aa".repeat(32) });
    expect("id" in result).toBe(false);
  });

  it("puts the txid in the fragment, never the query", () => {
    const url = buildSwapAcceptCallbackUrl(
      { callback: "https://realm.rxd/cb" },
      { txid: "aa".repeat(32) }
    )!;
    expect(url.indexOf("#")).toBeGreaterThan(-1);
    expect(url.slice(0, url.indexOf("#"))).not.toMatch(/[?&]/);
  });

  it("returns undefined when the request has no callback", () => {
    expect(
      buildSwapAcceptCallbackUrl({}, { txid: "aa".repeat(32) })
    ).toBeUndefined();
  });
});

describe("parseConnectRequest — swap-cancel-request envelope", () => {
  it("accepts a minimal envelope (ref only)", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "swap-cancel-request", ref: SAMPLE_REF })
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "swap-cancel-request") {
      expect(r.request.ref).toBe(SAMPLE_REF);
    } else {
      throw new Error("expected a swap-cancel-request");
    }
  });

  it("lowercases the ref", () => {
    const r = parseConnectRequest(
      JSON.stringify({ t: "swap-cancel-request", ref: SAMPLE_REF.toUpperCase() })
    );
    expect(r.ok && r.request.t === "swap-cancel-request" && r.request.ref).toBe(
      SAMPLE_REF
    );
  });

  it("rejects a missing or malformed ref", () => {
    for (const ref of [undefined, "not-a-ref", "ab".repeat(35), "ab".repeat(37)]) {
      const r = parseConnectRequest(
        JSON.stringify({ t: "swap-cancel-request", ref })
      );
      expect(r.ok, JSON.stringify(ref)).toBe(false);
    }
  });

  it("rejects an unsupported version / protocol, same as other request types", () => {
    const badVersion = parseConnectRequest(
      JSON.stringify({ t: "swap-cancel-request", v: 2, ref: SAMPLE_REF })
    );
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) expect(badVersion.error).toMatch(/version/);
  });

  it("binds the callback to the declared origin, same rule as other request types", () => {
    const kept = parseConnectRequest(
      JSON.stringify({
        t: "swap-cancel-request",
        ref: SAMPLE_REF,
        origin: "https://realm.rxd",
        callback: "https://realm.rxd/cb",
      })
    );
    expect(
      kept.ok && kept.request.t === "swap-cancel-request" && kept.request.callback
    ).toBe("https://realm.rxd/cb");

    const dropped = parseConnectRequest(
      JSON.stringify({
        t: "swap-cancel-request",
        ref: SAMPLE_REF,
        origin: "https://realm.rxd",
        callback: "https://evil.example/steal",
      })
    );
    expect(
      dropped.ok && dropped.request.t === "swap-cancel-request" && dropped.request.callback
    ).toBeUndefined();
  });

  it("round-trips via encodeReqParam", () => {
    const req: SwapCancelRequest = {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "swap-cancel-request",
      ref: SAMPLE_REF,
      id: "abc",
    };
    const param = encodeReqParam(req);
    const r = parseConnectRequest(param);
    expect(r.ok).toBe(true);
    if (r.ok && r.request.t === "swap-cancel-request") {
      expect(r.request.ref).toBe(SAMPLE_REF);
      expect(r.request.id).toBe("abc");
    } else {
      throw new Error("expected a swap-cancel-request");
    }
  });
});

describe("buildSwapCancelResult / encodeSwapCancelResult / buildSwapCancelCallbackUrl", () => {
  it("builds and serializes a result, echoing the id", () => {
    const result = buildSwapCancelResult({ id: "req-1" }, { txid: "dd".repeat(32) });
    expect(result).toMatchObject({
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "swap-cancel-result",
      id: "req-1",
      txid: "dd".repeat(32),
    });
    expect(JSON.parse(encodeSwapCancelResult(result))).toEqual(result);
  });

  it("omits id when the request had none", () => {
    const result = buildSwapCancelResult({}, { txid: "dd".repeat(32) });
    expect("id" in result).toBe(false);
  });

  it("puts the txid in the fragment, never the query", () => {
    const url = buildSwapCancelCallbackUrl(
      { callback: "https://realm.rxd/cb" },
      { txid: "dd".repeat(32) }
    )!;
    expect(url.indexOf("#")).toBeGreaterThan(-1);
    expect(url.slice(0, url.indexOf("#"))).not.toMatch(/[?&]/);
  });

  it("returns undefined when the request has no callback", () => {
    expect(
      buildSwapCancelCallbackUrl({}, { txid: "dd".repeat(32) })
    ).toBeUndefined();
  });
});

describe("buildRejectCallbackUrl", () => {
  it("puts rejected=true and the id in the fragment, never the query", () => {
    const url = buildRejectCallbackUrl({
      callback: "https://realm.rxd/cb",
      id: "req-1",
    });
    expect(url).toBe("https://realm.rxd/cb#id=req-1&rejected=true");
  });

  it("omits id when the request had none", () => {
    const url = buildRejectCallbackUrl({ callback: "https://realm.rxd/cb" });
    expect(url).toBe("https://realm.rxd/cb#rejected=true");
  });

  it("returns undefined when the request has no callback", () => {
    expect(buildRejectCallbackUrl({})).toBeUndefined();
    expect(buildRejectCallbackUrl({ id: "req-1" })).toBeUndefined();
  });

  it("returns undefined rather than truncate when the composed URL is too large", () => {
    const url = buildRejectCallbackUrl({
      callback: "https://realm.rxd/cb",
      id: "x".repeat(MAX_CALLBACK_URL_LEN),
    });
    expect(url).toBeUndefined();
  });
});

describe("classifyConnectError", () => {
  it("classifies a locked-wallet message", () => {
    expect(classifyConnectError(new Error("Wallet is locked — unable to sign")).code).toBe(
      "locked"
    );
    expect(classifyConnectError(new Error("wallet unlock required")).code).toBe("locked");
  });

  it("classifies an insufficient-funds message", () => {
    expect(classifyConnectError(new Error("Insufficient funds for this transaction")).code).toBe(
      "insufficient_funds"
    );
    expect(classifyConnectError(new Error("not enough funds available")).code).toBe(
      "insufficient_funds"
    );
  });

  it("classifies an already-spent message", () => {
    // Verbatim message from swapFlow.ts's acceptSwapOffer — the "offer
    // already spent" case the error callback exists for in the first place.
    expect(
      classifyConnectError(
        new Error("this offer has already been completed or cancelled")
      ).code
    ).toBe("already_spent");
    expect(classifyConnectError(new Error("swap already cancelled")).code).toBe(
      "already_spent"
    );
  });

  it("classifies a not-found message", () => {
    // Verbatim message from swapFlow.ts's cancelSwapOffer.
    expect(
      classifyConnectError(
        new Error("could not find a pending offer for that token")
      ).code
    ).toBe("not_found");
    expect(classifyConnectError(new Error("could not resolve the token")).code).toBe(
      "not_found"
    );
  });

  it("classifies an invalid-request message", () => {
    expect(classifyConnectError(new Error("only image/png is supported")).code).toBe(
      "invalid_request"
    );
    // Verbatim message from swapFlow.ts's acceptSwapOffer.
    expect(
      classifyConnectError(
        new Error("psrt must have exactly one input and one output")
      ).code
    ).toBe("invalid_request");
  });

  it("falls back to unknown for an unrecognized message", () => {
    expect(classifyConnectError(new Error("something went sideways")).code).toBe("unknown");
  });

  it("stringifies a non-Error throw and still returns a code", () => {
    const result = classifyConnectError("wallet is locked");
    expect(result.code).toBe("locked");
    expect(result.message).toBe("wallet is locked");
  });
});

describe("buildErrorCallbackUrl", () => {
  it("puts error and message in the fragment, never the query", () => {
    const url = buildErrorCallbackUrl(
      { callback: "https://realm.rxd/cb", id: "req-1" },
      { code: "insufficient_funds", message: "Not enough RXD to cover the fee" }
    );
    expect(url).toBe(
      "https://realm.rxd/cb#id=req-1&error=insufficient_funds&message=" +
        encodeURIComponent("Not enough RXD to cover the fee")
    );
    expect(url!.indexOf("#")).toBeGreaterThan(-1);
    expect(url!.slice(0, url!.indexOf("#"))).not.toMatch(/[?&]/);
  });

  it("omits id when the request had none", () => {
    const url = buildErrorCallbackUrl(
      { callback: "https://realm.rxd/cb" },
      { code: "locked", message: "Wallet is locked" }
    );
    expect(url).toBe(
      "https://realm.rxd/cb#error=locked&message=" +
        encodeURIComponent("Wallet is locked")
    );
  });

  it("returns undefined when the request has no callback", () => {
    expect(
      buildErrorCallbackUrl({}, { code: "unknown", message: "oops" })
    ).toBeUndefined();
  });

  it("returns undefined rather than truncate when the composed URL is too large", () => {
    const url = buildErrorCallbackUrl(
      { callback: "https://realm.rxd/cb" },
      { code: "unknown", message: "x".repeat(MAX_CALLBACK_URL_LEN) }
    );
    expect(url).toBeUndefined();
  });
});

describe("parseCanonDeclaration", () => {
  const REF = "ab".repeat(32) + "00000000";
  const MSG =
    "canon-declaration|v1|radiant-mainnet|signer=14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i|" +
    "issued=2026-09-02T14:43:29.677Z|expires=2027-12-31T00:00:00.000Z|" +
    `declares=creator:${REF}:CraigD%20Profile|revokes=-|comment=-`;

  it("parses the canonical single-line message", () => {
    const parsed = parseCanonDeclaration(MSG);
    expect(parsed).toBeDefined();
    expect(parsed!.version).toBe(1);
    expect(parsed!.network).toBe("radiant-mainnet");
    expect(parsed!.signer).toBe("14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i");
    expect(parsed!.declares).toEqual([
      { kind: "creator", ref: REF, label: "CraigD Profile" },
    ]);
    expect(parsed!.revokes).toEqual([]);
    expect(parsed!.expires).toBe("2027-12-31T00:00:00.000Z");
    expect(parsed!.comment).toBeUndefined();
  });

  it("keeps the terminal comment whole, pipes included", () => {
    const parsed = parseCanonDeclaration(
      MSG.replace("comment=-", "comment=a|b|c")
    );
    expect(parsed!.comment).toBe("a|b|c");
  });

  it("parses revocations and no-expiry", () => {
    const parsed = parseCanonDeclaration(
      "canon-declaration|v1|radiant-mainnet|signer=14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i|" +
        "issued=2026-09-02T14:43:29.677Z|expires=never|declares=|" +
        `revokes=${REF}|comment=-`
    );
    expect(parsed!.declares).toEqual([]);
    expect(parsed!.revokes).toEqual([REF]);
    expect(parsed!.expires).toBeUndefined();
  });

  it("rejects everything that is not the exact shape", () => {
    expect(parseCanonDeclaration("just some text")).toBeUndefined();
    expect(parseCanonDeclaration("")).toBeUndefined();
    // Wrong magic, missing fields, bad kind, bad ref, empty document.
    expect(parseCanonDeclaration(MSG.replace("canon-declaration", "canon"))).toBeUndefined();
    expect(parseCanonDeclaration(MSG.replace("|revokes=-", ""))).toBeUndefined();
    expect(parseCanonDeclaration(MSG.replace("creator:", "owner:"))).toBeUndefined();
    // "work" is a valid third kind (standalone NFTs with nothing to derive from).
    expect(parseCanonDeclaration(MSG.replace("creator:", "work:"))?.declares[0]?.kind).toBe("work");
    expect(parseCanonDeclaration(MSG.replace(REF, "ff".repeat(10)))).toBeUndefined();
    expect(
      parseCanonDeclaration(MSG.replace(`declares=creator:${REF}:CraigD%20Profile`, "declares="))
    ).toBeUndefined();
    // A recognized wallet-connect challenge is not a declaration.
    expect(
      parseCanonDeclaration("glyphgalaxy:wallet-connect:v1:sess:nonce")
    ).toBeUndefined();
  });

  it("v1 is display-recognition only; v2 also matches the connect badge", () => {
    expect(isRecognizedConnectChallenge(MSG)).toBe(false);
    expect(parseCanonDeclaration(MSG)).toBeDefined();
    const V2 =
      "canon-declaration:wallet-connect:v2:radiant-mainnet:" +
      "signer=14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i|issued=2026-09-02T14:43:29.677Z|" +
      `expires=never|declares=creator:${REF}:CraigD%20Profile|revokes=-|comment=a|b`;
    expect(isRecognizedConnectChallenge(V2)).toBe(true);
    const parsed = parseCanonDeclaration(V2);
    expect(parsed).toBeDefined();
    expect(parsed!.version).toBe(2);
    expect(parsed!.declares[0]!.label).toBe("CraigD Profile");
    expect(parsed!.expires).toBeUndefined();
    expect(parsed!.comment).toBe("a|b");
    // The nonce slot echoes just the network — short and harmless.
    expect(extractChallengeNonce(V2)).toBe("radiant-mainnet");
  });
});

describe("anchor-request", () => {
  const REF2 = "cd".repeat(32) + "00000000";
  const DOC = JSON.stringify({
    format: "canon-declaration",
    version: 2,
    network: "radiant-mainnet",
    signer: "14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i",
    declares: [{ kind: "creator", ref: REF2, label: "CraigD Profile" }],
    issuedAt: "2026-09-02T14:43:29.677Z",
    signature: "IF9v",
  });

  it("canonDeclarationFromDocument rebuilds the v2 challenge", () => {
    const out = canonDeclarationFromDocument(DOC);
    expect(out).toBeDefined();
    expect(out!.challenge).toBe(
      "canon-declaration:wallet-connect:v2:radiant-mainnet:" +
        "signer=14XmXG3dSBWZUukGT3xzS9zxpiZ53vgx1i|issued=2026-09-02T14:43:29.677Z|" +
        `expires=never|declares=creator:${REF2}:CraigD%20Profile|revokes=-|comment=-`
    );
    expect(out!.declaration.version).toBe(2);
    expect(out!.signature).toBe("IF9v");
  });

  it("rejects malformed documents", () => {
    expect(canonDeclarationFromDocument("{not json")).toBeUndefined();
    expect(canonDeclarationFromDocument(DOC.replace('"version":2', '"version":3'))).toBeUndefined();
    expect(canonDeclarationFromDocument(DOC.replace(REF2, "beef"))).toBeUndefined();
    expect(canonDeclarationFromDocument(DOC.replace('"signature":"IF9v"', '"signature":5'))).toBeUndefined();
  });

  it("envelope round-trips through parseConnectRequest", () => {
    const parsed = parseConnectRequest(
      JSON.stringify({
        protocol: "photonic-connect",
        v: 1,
        t: "anchor-request",
        document: DOC,
        origin: "https://canon.rxd.zone",
        callback: "https://canon.rxd.zone/declaration",
      })
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.t).toBe("anchor-request");
    if (parsed.request.t !== "anchor-request") return;
    expect(parsed.request.document).toBe(DOC);
    expect(parsed.request.broadcast).toBe(true);
    expect(parsed.request.callback).toBe("https://canon.rxd.zone/declaration");
  });

  it("refuses an envelope whose document is not a signed declaration", () => {
    const parsed = parseConnectRequest(
      JSON.stringify({ protocol: "photonic-connect", v: 1, t: "anchor-request", document: "{}" })
    );
    expect(parsed.ok).toBe(false);
  });

  it("builds results and callback URLs", () => {
    const result = buildAnchorResult(
      { id: "x1" },
      { broadcast: true, docHash: "ab".repeat(32), commitTxid: "11".repeat(32), revealTxid: "22".repeat(32) }
    );
    expect(result.t).toBe("anchor-result");
    const url = buildAnchorCallbackUrl(
      { callback: "https://canon.rxd.zone/declaration" },
      result
    );
    expect(url).toContain("#id=x1&broadcast=true&docHash=");
    expect(url).toContain("revealTxid=" + "22".repeat(32));
  });
});
