/**
 * txProtocol — the gate in front of transaction signing.
 *
 * Discipline mirrors protocol.test.ts (hostile input in, verdict out, never
 * throw), plus the two things that page never needed: an origin ALLOWLIST that
 * must resist the same bypass shapes the callback binding resists, and a
 * response MAC that must match Xetch's verifier byte-for-byte. The round-trip
 * tests run against @xetch/bridge-kit itself — the same code Xetch runs — so
 * "matches" is asserted, not assumed.
 */
import { describe, it, expect } from "vitest";
import {
  makeSignRequest,
  verifyResponse,
  type SignRequest,
} from "@xetch/bridge-kit";
import {
  ALLOWED_SIGN_ORIGINS,
  isAllowedSignOrigin,
  parseSignParam,
  buildBridgeReturnUrl,
  makeBridgeResponse,
  describeSignAction,
} from "../txProtocol";

const NOW = 1_800_000_000; // fixed unix seconds so expiry is deterministic

/** A well-formed request as Xetch would build it (bridge-kit's own factory). */
function goodRequest(overrides: Partial<SignRequest> = {}): SignRequest {
  const req = makeSignRequest({
    origin: "https://xetch.net",
    sessionId: "sess-1",
    address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
    core: { p: "xetch", v: 1, t: "like", ts: NOW, parent: "a".repeat(64), n: "n1" },
    now: NOW,
  });
  return { ...req, ...overrides };
}

/** Encode exactly as Xetch's bridge-link does (b64url of UTF-8 JSON). */
function encodeParam(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("origin allowlist", () => {
  it("allows exactly the pinned first-party origins", () => {
    for (const o of ALLOWED_SIGN_ORIGINS) expect(isAllowedSignOrigin(o)).toBe(true);
  });

  it.each([
    ["subdomain suffix", "https://xetch.net.evil.example"],
    ["prefix", "https://notxetch.net"],
    ["subdomain", "https://app.xetch.net"],
    ["scheme downgrade", "http://xetch.net"],
    ["explicit port", "https://xetch.net:8443"],
    ["userinfo trick", "https://xetch.net@evil.example"],
    ["trailing slash (not an origin)", "https://xetch.net/"],
    ["trailing dot host", "https://xetch.net."],
    ["case variant kept strict", "https://XETCH.NET"],
    ["empty", ""],
  ])("rejects %s", (_label, origin) => {
    expect(isAllowedSignOrigin(origin)).toBe(false);
  });

  it("admits localhost ONLY when the dev flag is passed", () => {
    expect(isAllowedSignOrigin("http://localhost:5273")).toBe(false);
    expect(isAllowedSignOrigin("http://localhost:5273", { dev: true })).toBe(true);
    expect(isAllowedSignOrigin("http://127.0.0.1:8080", { dev: true })).toBe(true);
    // dev flag must not loosen anything beyond loopback
    expect(isAllowedSignOrigin("http://192.168.1.10:5273", { dev: true })).toBe(false);
    expect(isAllowedSignOrigin("https://evil.example", { dev: true })).toBe(false);
    expect(isAllowedSignOrigin("http://localhost.evil.example", { dev: true })).toBe(false);
  });
});

describe("parseSignParam — hostile input", () => {
  it("accepts a genuine Xetch-encoded request", () => {
    const r = parseSignParam(encodeParam(goodRequest()), { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.origin).toBe("https://xetch.net");
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["not base64", "!!!!"],
    ["base64 of not-json", encodeParam("just a string").slice(0, 8)],
    ["json array", encodeParam([1, 2, 3])],
    ["json scalar", encodeParam(42)],
  ])("refuses %s without throwing", (_l, raw) => {
    const r = parseSignParam(raw as string | null, { now: NOW });
    expect(r.ok).toBe(false);
  });

  it("refuses a structurally valid request from a foreign origin", () => {
    const r = parseSignParam(encodeParam(goodRequest({ origin: "https://evil.example" })), { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/origin/);
  });

  it("refuses an expired request (bridge-kit's own expiry gate)", () => {
    const r = parseSignParam(encodeParam(goodRequest()), { now: NOW + 3600 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expired/);
  });

  it("refuses a request whose namespace or version is wrong", () => {
    expect(parseSignParam(encodeParam({ ...goodRequest(), ns: "glyphgalaxy:sign:v1" }), { now: NOW }).ok).toBe(false);
    expect(parseSignParam(encodeParam({ ...goodRequest(), v: 2 }), { now: NOW }).ok).toBe(false);
  });

  it("refuses amounts smuggled into the request only if the contract does — and it does not carry them at all", () => {
    // The contract has no amount fields; extra keys must not create any.
    const r = parseSignParam(
      encodeParam({ ...goodRequest(), payments: [{ address: "evil", value: "999999999" }], fee: "1" }),
      { now: NOW },
    );
    // Parse may accept (unknown keys ignored) — but the typed result must not expose them.
    if (r.ok) {
      expect((r.req as unknown as Record<string, unknown>).payments).toBeUndefined();
      expect((r.req as unknown as Record<string, unknown>).fee).toBeUndefined();
    }
  });
});

describe("response round-trip against Xetch's own verifier", () => {
  it("an ok response we build verifies on the Xetch side (MAC, nonce, txid)", async () => {
    const req = goodRequest();
    const res = await makeBridgeResponse(req, { txid: "b".repeat(64), status: "ok" });
    const verdict = await verifyResponse(req, res);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.value.txid).toBe("b".repeat(64));
  });

  it("rejected/expired responses verify and carry an empty txid", async () => {
    const req = goodRequest();
    for (const status of ["rejected", "expired"] as const) {
      const res = await makeBridgeResponse(req, { txid: "", status });
      const verdict = await verifyResponse(req, res);
      expect(verdict.ok).toBe(true);
    }
  });

  it("a response MAC'd for one request does not verify against another", async () => {
    const req1 = goodRequest();
    const req2 = goodRequest({ }); // fresh nonce + replyKey from the factory
    const res = await makeBridgeResponse(req1, { txid: "c".repeat(64), status: "ok" });
    const verdict = await verifyResponse(req2, res);
    expect(verdict.ok).toBe(false);
  });

  it("tampering with the txid after MACing is detected", async () => {
    const req = goodRequest();
    const res = await makeBridgeResponse(req, { txid: "d".repeat(64), status: "ok" });
    const verdict = await verifyResponse(req, { ...res, txid: "e".repeat(64) });
    expect(verdict.ok).toBe(false);
  });
});

describe("buildBridgeReturnUrl", () => {
  it("targets <origin>/wallet-return with the payload only in the fragment", async () => {
    const req = goodRequest();
    const res = await makeBridgeResponse(req, { txid: "", status: "rejected" });
    const url = buildBridgeReturnUrl(req, res);
    expect(url.startsWith("https://xetch.net/wallet-return#")).toBe(true);
    const beforeHash = url.slice(0, url.indexOf("#"));
    expect(beforeHash).not.toContain("?");
    expect(beforeHash).not.toContain("&");
  });

  it("THROWS on a non-allowlisted origin — reaching it means the gate was bypassed", async () => {
    const req = goodRequest({ origin: "https://evil.example" });
    const res = await makeBridgeResponse(goodRequest(), { txid: "", status: "rejected" });
    expect(() => buildBridgeReturnUrl(req, res)).toThrow(/refusing/);
  });
});

describe("describeSignAction", () => {
  it("names each supported action in plain words", () => {
    const base = { p: "xetch" as const, v: 1 as const, ts: NOW, n: "x" };
    expect(describeSignAction({ ...base, t: "like", parent: "p" })).toMatch(/Like/);
    expect(describeSignAction({ ...base, t: "like", parent: "p", meta: { vote: 1 } })).toMatch(/Vote/);
    expect(describeSignAction({ ...base, t: "follow", target: "1Addr" })).toMatch(/Follow 1Addr/);
    expect(describeSignAction({ ...base, t: "branch", parent: "p" })).toMatch(/Repost/);
    expect(describeSignAction({ ...base, t: "branch", parent: "p", text: "hot take" })).toMatch(/Quote/);
    expect(describeSignAction({ ...base, t: "post", text: "hello" })).toMatch(/Publish a post/);
  });

  it("truncates long text instead of flooding the approval screen", () => {
    const base = { p: "xetch" as const, v: 1 as const, ts: NOW, n: "x" };
    const label = describeSignAction({ ...base, t: "post", text: "y".repeat(500) });
    expect(label.length).toBeLessThan(120);
    expect(label).toContain("…");
  });
});
