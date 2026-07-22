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
  signRequest,
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
  signedPayloadDetails,
  decodeSendProposal,
  describeSend,
  XETCH_SIGN_ADDRESS,
} from "../txProtocol";

const NOW = 1_800_000_000; // fixed unix seconds so expiry is deterministic

// Xetch's DEV request-signing key — the canonical BIP-39 vector at the testnet
// path, which derives XETCH_SIGN_ADDRESS.testnet. Tests pin `net: "testnet"`
// and sign with this, exercising the real provenance gate. Hardcoded (not
// derived) so the Photonic app test needs no @radiant-core/sdk import; these
// are the well-known vector, safe to expose. The prod mainnet WIF is secret
// and never in code.
const devSigner = {
  wif: "cTk9NhxTCzfbsB4psto8C9ChaavWf6oysufiKHU5j4zhTxG9mZsc",
  address: "moMfswEJUgX3VK6LWBgFvZsXzHHxZHxJ1f",
};
const ATTACKER_WIF = "cVqn3rEVEEXc2Gq6zDdXLZVNFBcpCjoch7VQytSMH3wQ7Uufvv26"; // canonical vector idx 1
/** Sign a request as Xetch would (server side) so parse's provenance gate passes. */
const signGood = (req: Omit<SignRequest, "xsig">) => signRequest(req, devSigner.wif);
/** Standard parse opts: testnet pin + fixed clock + dev (the testnet pin is a
 *  public key, so it's only honoured in dev builds — mirrors the prod page). */
const OPTS = { net: "testnet" as const, now: NOW, dev: true };

/** A well-formed, Xetch-SIGNED request (what a real request looks like on the wire). */
function goodRequest(overrides: Partial<SignRequest> = {}): SignRequest {
  const req = makeSignRequest({
    origin: "https://xetch.net",
    sessionId: "sess-1",
    address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
    core: { p: "xetch", v: 1, t: "like", ts: NOW, parent: "a".repeat(64), n: "n1" },
    now: NOW,
  });
  return signGood({ ...req, ...overrides });
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
    const r = parseSignParam(encodeParam(goodRequest()), OPTS);
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
    const r = parseSignParam(raw as string | null, OPTS);
    expect(r.ok).toBe(false);
  });

  it("refuses a structurally valid request from a foreign origin", () => {
    const r = parseSignParam(encodeParam(goodRequest({ origin: "https://evil.example" })), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/origin/);
  });

  it("refuses an expired request (bridge-kit's own expiry gate)", () => {
    const r = parseSignParam(encodeParam(goodRequest()), { ...OPTS, now: NOW + 3600 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expired/);
  });

  it("refuses a request whose namespace or version is wrong", () => {
    expect(parseSignParam(encodeParam({ ...goodRequest(), ns: "glyphgalaxy:sign:v1" }), OPTS).ok).toBe(false);
    expect(parseSignParam(encodeParam({ ...goodRequest(), v: 99 }), OPTS).ok).toBe(false);
  });

  it("REQUIRES Xetch's signature — an unsigned request is refused (v2 provenance)", () => {
    // makeSignRequest without signGood = a request no page could distinguish
    // from a forgery. It must not reach the confirm screen.
    const unsigned = makeSignRequest({
      origin: "https://xetch.net", sessionId: "s", address: "1Bv", now: NOW,
      core: { p: "xetch", v: 1, t: "like", ts: NOW, parent: "a".repeat(64), n: "n" } as never,
    });
    const r = parseSignParam(encodeParam(unsigned), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/xsig|signed by Xetch/i);
  });

  it("refuses a request signed by the WRONG key (a forger's own signature)", () => {
    const base = makeSignRequest({
      origin: "https://xetch.net", sessionId: "s", address: "1Bv", now: NOW,
      core: { p: "xetch", v: 1, t: "like", ts: NOW, parent: "a".repeat(64), n: "n" } as never,
    });
    const forged = signRequest(base, ATTACKER_WIF); // valid signature, wrong signer
    const r = parseSignParam(encodeParam(forged), OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/xsig/i);
  });

  it("the pinned testnet address matches the dev key (guards a bad pin)", () => {
    expect(XETCH_SIGN_ADDRESS.testnet).toBe(devSigner.address);
  });

  it("fails closed on an unknown network (no pinned signer)", () => {
    const r = parseSignParam(encodeParam(goodRequest()), { net: "regtest" as never, now: NOW, dev: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no pinned Xetch signing key/);
  });

  it("a PROD build (dev:false) refuses testnet — its pin is a PUBLIC key", () => {
    // The whole point of the hardening: a production bundle must never verify
    // against the public dev key, even in testnet mode. Same request that passes
    // under dev:true is refused under dev:false.
    const signed = encodeParam(goodRequest());
    expect(parseSignParam(signed, { net: "testnet", now: NOW, dev: true }).ok).toBe(true);
    const prod = parseSignParam(signed, { net: "testnet", now: NOW, dev: false });
    expect(prod.ok).toBe(false);
    if (!prod.ok) expect(prod.reason).toMatch(/no pinned Xetch signing key/);
  });

  it("mainnet verification does NOT depend on the dev flag", () => {
    // Mainnet uses a secret-key pin, live in every build. (Signed by the dev key
    // here, so it won't verify against the mainnet pin — but the point is the
    // pin is PRESENT and attempted regardless of dev, i.e. not "no pin".)
    const r = parseSignParam(encodeParam(goodRequest()), { net: "mainnet", now: NOW, dev: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/xsig/i); // reached verification, not "no pin"
  });

  it("refuses amounts smuggled into the request only if the contract does — and it does not carry them at all", () => {
    // The contract has no amount fields; extra keys must not create any.
    const r = parseSignParam(
      encodeParam({ ...goodRequest(), payments: [{ address: "evil", value: "999999999" }], fee: "1" }),
      OPTS,
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

describe("signedPayloadDetails — nothing signed goes unshown", () => {
  const base = { p: "xetch" as const, v: 1 as const, ts: NOW, n: "x" };

  it("surfaces media the one-liner omits (the hidden-attachment attack)", () => {
    const rows = signedPayloadDetails({ ...base, t: "post", text: "gm", media: [{ h: "deadbeef", mime: "image/png" }] } as never);
    const media = rows.find((r) => r.label.startsWith("Media"));
    expect(media).toBeDefined();
    expect(media!.value).toContain("deadbeef");
  });

  it("surfaces a stealth parent on a post (silently a reply/branch)", () => {
    const rows = signedPayloadDetails({ ...base, t: "post", text: "gm", parent: "c".repeat(64) } as never);
    expect(rows.some((r) => r.label === "Attached to post" && r.value === "c".repeat(64))).toBe(true);
  });

  it("surfaces the actual fields a profile update writes", () => {
    const rows = signedPayloadDetails({ ...base, t: "profile", meta: { name: "Mallory", bio: "hi", avatar: "abc" } } as never);
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("Field: name");
    expect(labels).toContain("Field: bio");
    expect(labels).toContain("Field: avatar");
    expect(rows.find((r) => r.label === "Field: name")!.value).toBe("Mallory");
  });

  it("does not duplicate what the description already says", () => {
    // A poll vote's `vote` meta is in the description; a reply's parent is framed
    // by the description — neither should reappear as a detail row.
    expect(signedPayloadDetails({ ...base, t: "like", parent: "p", meta: { vote: 2 } } as never)).toEqual([]);
    expect(signedPayloadDetails({ ...base, t: "reply", parent: "p".repeat(64), text: "hi" } as never)).toEqual([]);
  });

  it("is empty for a plain post with nothing hidden", () => {
    expect(signedPayloadDetails({ ...base, t: "post", text: "just text" } as never)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tx-proposal decoding (generic send path)
// ---------------------------------------------------------------------------
describe("decodeSendProposal — what the wallet independently verifies", () => {
  // A trivial script→address decoder for the test: map known scripts to labels.
  const addrOf: Record<string, string> = {
    "76a914aa88ac": "1Alice",
    "76a914bb88ac": "1Bob",
  };
  const decode = (hex: string): string | null => addrOf[hex] ?? null;

  const sendTx = (over: Partial<import("../txProtocol").TxProposal> = {}): import("../txProtocol").TxProposal => ({
    intent: "send",
    inputs: [{ txid: "a".repeat(64), vout: 0, value: "100000", script: "76a914ff88ac" }],
    outputs: [{ script: "76a914aa88ac", value: "50000" }],
    addChange: true,
    network: "testnet",
    ...over,
  });

  it("decodes a single recipient to its address + amount", () => {
    const r = decodeSendProposal(sendTx(), decode);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.recipients).toEqual([{ address: "1Alice", value: 50000n }]);
      expect(r.plan.sending).toBe(50000n);
    }
  });

  it("sums multiple recipients", () => {
    const r = decodeSendProposal(
      sendTx({ outputs: [{ script: "76a914aa88ac", value: "50000" }, { script: "76a914bb88ac", value: "25000" }] }),
      decode,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.sending).toBe(75000n);
  });

  it("REFUSES an output that doesn't decode to a standard address", () => {
    const r = decodeSendProposal(sendTx({ outputs: [{ script: "6a0bdeadbeef", value: "50000" }] }), decode);
    expect(r).toMatchObject({ ok: false, reason: /standard address/ });
  });

  it("refuses a non-send intent", () => {
    const r = decodeSendProposal(sendTx({ intent: "drain" as never }), decode);
    expect(r).toMatchObject({ ok: false, reason: /unsupported transaction type/ });
  });

  it("refuses a zero or unreadable recipient amount", () => {
    expect(decodeSendProposal(sendTx({ outputs: [{ script: "76a914aa88ac", value: "0" }] }), decode))
      .toMatchObject({ ok: false, reason: /non-positive/ });
    expect(decodeSendProposal(sendTx({ outputs: [{ script: "76a914aa88ac", value: "notanumber" }] }), decode))
      .toMatchObject({ ok: false, reason: /unreadable/ });
  });

  it("refuses when there are no recipients", () => {
    const r = decodeSendProposal(sendTx({ outputs: [] }), decode);
    expect(r).toMatchObject({ ok: false, reason: /no recipients/ });
  });

  it("describeSend reads naturally for one and many recipients", () => {
    const toRXD = (p: bigint) => (Number(p) / 1e8).toString();
    const one = decodeSendProposal(sendTx(), decode);
    if (one.ok) expect(describeSend(one.plan, "RXD", toRXD)).toBe("Send 0.0005 RXD to 1Alice");
    const many = decodeSendProposal(
      sendTx({ outputs: [{ script: "76a914aa88ac", value: "50000" }, { script: "76a914bb88ac", value: "25000" }] }),
      decode,
    );
    if (many.ok) expect(describeSend(many.plan, "RXD", toRXD)).toBe("Send 0.00075 RXD to 2 recipients");
  });
});
