/**
 * External TRANSACTION signing — protocol layer (Xetch bridge, `#/sign?req=`).
 *
 * This is a different animal from `protocol.ts` (Phase-A connect). That one
 * signs magic-prefixed MESSAGES, where the worst case is a signature over a
 * nonce, so it tolerates any origin and merely displays it. This one produces a
 * SPEND. The tolerance model does not carry over, and this module is where the
 * difference is enforced:
 *
 *   - The request origin is checked against a HARDCODED first-party allowlist.
 *     Not advisory, not display-only: an origin off the list is rejected before
 *     any UI renders. The `origin` field in the request is attacker-writable,
 *     but it is also where the response gets delivered — so a forged origin
 *     either fails this check or delivers the result to the real first-party
 *     site, which will refuse it (response MAC + nonce echo). What a forger can
 *     never do is have US build a spend for a site we don't know.
 *   - The wire contract itself (shape, nonce, expiry, reply MAC) comes from
 *     `@xetch/bridge-kit`, the SAME package Xetch imports. No local re-
 *     implementation, no drift: if the contract changes, both sides change in
 *     one place. (Its `parseSignRequest` is aliased here to avoid colliding
 *     with `protocol.ts`'s message-signing parser of the same name.)
 *
 * Like `protocol.ts`, this module is PURE: no React, no signals, no keys, no
 * database. Everything here is unit-testable with plain objects, and the page
 * (`pages/SignAction.tsx`) owns all effects.
 */

import {
  parseSignRequest as parseBridgeRequest,
  signResponse as buildBridgeResponse,
  type SignRequest,
  type SignResponse,
  type SignStatus,
} from "@xetch/bridge-kit";

// Re-export for the page + tests so they import ONE module for the protocol.
export type { SignRequest, SignResponse, SignStatus };

/**
 * Origins allowed to request a transaction signature. First-party pin, v1:
 * exactly the Xetch production origins. This is a product decision as much as
 * a security one — general dApps get message signing (`/connect`), which
 * cannot spend. Growing this list is a code change and a review, on purpose.
 * A persisted per-origin grant store can replace it later; do not "just add"
 * an origin here without the SignAction UI copy still being true for it.
 */
export const ALLOWED_SIGN_ORIGINS: readonly string[] = [
  "https://xetch.net",
  "https://www.xetch.net",
];

/**
 * Xetch's request-signing ADDRESS, per network (bridge v2). The provenance
 * anchor: the wallet REQUIRES every sign request to carry a signature that
 * verifies against this, so a page that merely claims `origin:"xetch.net"`
 * cannot get the wallet to act — it has no key to produce the signature.
 *
 * The origin allowlist above is the fast pre-check; THIS is the cryptographic
 * proof. Rotating the key means changing these values (a wallet release) and
 * swapping `XETCH_SIGN_WIF` on the server.
 *
 * mainnet = the production key (its WIF lives only in Xetch's prod .env).
 * testnet = a well-known dev key (the canonical BIP-39 vector), so a dev/test
 *           Xetch can sign locally without a secret.
 */
export const XETCH_SIGN_ADDRESS: Record<"mainnet" | "testnet", string> = {
  mainnet: "1DXLKpLakD9SxFXuYSA7W8d99UWdTv5krk",
  testnet: "moMfswEJUgX3VK6LWBgFvZsXzHHxZHxJ1f",
};

/** Dev-loopback origins (any port). Only honoured when the caller passes
 *  `dev: true`, which the page wires to `import.meta.env.DEV` — dead code in a
 *  production bundle rather than a latent bypass. */
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Is this origin allowed to ask for a SPEND? Exact-match only — no subdomain
 *  suffix tricks, no scheme downgrades, no ports on the prod entries. */
export function isAllowedSignOrigin(origin: string, opts?: { dev?: boolean }): boolean {
  if (ALLOWED_SIGN_ORIGINS.includes(origin)) return true;
  if (opts?.dev && DEV_ORIGIN.test(origin)) return true;
  return false;
}

// --- b64url (Xetch bridge-link encoding: btoa of UTF-8 bytes, -_ alphabet) ---

function b64urlDecode(s: string): unknown {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function b64urlEncode(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type ParsedSignParam =
  | { ok: true; req: SignRequest }
  | { ok: false; reason: string };

/**
 * Decode and validate a `?req=` parameter into a trusted-enough-to-DISPLAY
 * request. Hostile input in, verdict out; never throws.
 *
 * Three gates, in order:
 *   1. Structural parse (bridge-kit) — shape, nonce, expiry, and, given the
 *      pinned signer address, that Xetch's `xsig` VERIFIES. This is the
 *      provenance gate: a request not signed by Xetch is rejected here.
 *   2. Origin allowlist — the fast first-party check.
 * `net` selects which pinned Xetch signing address to verify against; it is
 * REQUIRED, and an unknown network fails closed (no pin ⇒ no valid request).
 */
export function parseSignParam(
  raw: string | null | undefined,
  opts: { net: "mainnet" | "testnet"; now?: number; dev?: boolean },
): ParsedSignParam {
  if (!raw || typeof raw !== "string") return { ok: false, reason: "missing request" };

  const signerAddress = XETCH_SIGN_ADDRESS[opts.net];
  if (!signerAddress) return { ok: false, reason: `no pinned Xetch signing key for network ${opts.net}` };

  let decoded: unknown;
  try {
    decoded = b64urlDecode(raw);
  } catch {
    return { ok: false, reason: "undecodable request" };
  }

  // Structural + provenance in one pass: signerAddress makes bridge-kit REQUIRE
  // and verify xsig, so a forged (unsigned or wrong-key) request never returns ok.
  const parsed = parseBridgeRequest(decoded, { signerAddress, ...(opts.now !== undefined ? { now: opts.now } : {}) });
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  if (!isAllowedSignOrigin(parsed.value.origin, { dev: opts.dev })) {
    return { ok: false, reason: `origin not allowed to request transaction signing: ${parsed.value.origin}` };
  }

  return { ok: true, req: parsed.value };
}

/**
 * Build the redirect URL that carries a response back to the requesting site.
 *
 * The return path is derived from the request's ORIGIN plus a fixed route —
 * never from a caller-supplied callback URL, so there is nothing to origin-
 * bind or sanitise (contrast `protocol.ts`'s `cleanCallback`, which exists
 * because Phase-A lets the dApp choose its callback). Payload rides in the
 * fragment: never sent to a server, never logged, never in Referer.
 *
 * Throws (rather than returns) on a non-allowlisted origin: reaching this
 * point with one means `parseSignParam` was bypassed, and a throw in the
 * response path is a fail-closed way to surface that programming error.
 */
export function buildBridgeReturnUrl(
  req: Pick<SignRequest, "origin">,
  res: SignResponse,
  opts?: { dev?: boolean },
): string {
  if (!isAllowedSignOrigin(req.origin, { dev: opts?.dev })) {
    throw new Error(`refusing to build a return URL for non-allowlisted origin: ${req.origin}`);
  }
  return `${req.origin}/wallet-return#${b64urlEncode(res)}`;
}

/** MAC-signed response for this request (async — the MAC is Web Crypto HMAC).
 *  Thin re-export so the page never imports bridge-kit directly — one protocol
 *  surface, one place to audit. */
export function makeBridgeResponse(
  req: SignRequest,
  outcome: { txid: string; status: SignStatus },
): Promise<SignResponse> {
  return buildBridgeResponse(req, outcome);
}

/**
 * Every signed field the one-line description does NOT already convey, as
 * label/value rows for the confirmation screen.
 *
 * This exists because `signEnvelope` signs the WHOLE core under the user's
 * identity key — `text`, `media`, `parent`, `target`, `meta`, all of it — while
 * `describeSignAction` only renders a few. Anything signed but unshown is
 * content the user authored without seeing: a "post" that also carries media or
 * a hidden `parent` (a stealth reply), or a "profile" update whose actual
 * bio/avatar never appear. So we surface the rest here, and the page shows it,
 * so "what was approved" equals "what was signed."
 *
 * `text`, and `target`/`vote` where the description already states them, are
 * omitted to avoid duplication.
 */
export function signedPayloadDetails(core: SignRequest["core"]): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const c = core as SignRequest["core"] & {
    media?: Array<{ h?: unknown; mime?: unknown }>;
    parent?: unknown;
    meta?: Record<string, unknown>;
  };

  if (Array.isArray(c.media) && c.media.length > 0) {
    rows.push({
      label: `Media (${c.media.length})`,
      value: c.media.map((m) => (typeof m?.h === "string" ? m.h : "?")).join(", "),
    });
  }
  // A `parent` on anything other than the reply/branch/like the description
  // already frames is worth surfacing — it changes what the post IS.
  if (typeof c.parent === "string" && c.parent && core.t !== "reply" && core.t !== "branch" && core.t !== "like") {
    rows.push({ label: "Attached to post", value: c.parent });
  }
  // Non-`vote` meta is arbitrary signed content — most importantly the fields a
  // `profile` update actually writes (name/bio/avatar/…). Show each pair.
  if (c.meta && typeof c.meta === "object") {
    for (const [k, v] of Object.entries(c.meta)) {
      if (k === "vote") continue; // already reflected in the description
      rows.push({ label: `Field: ${k}`, value: String(v) });
    }
  }
  return rows;
}

/**
 * The action in plain words for the approval screen. This line is the human
 * side of the trust boundary — it must describe what the CORE says, because
 * the core is the only thing the requesting site truly controls. Everything
 * priced (recipients, amounts, fee) is derived locally and shown separately.
 * It is a SUMMARY — {@link signedPayloadDetails} carries the fields it omits so
 * nothing signed goes unshown.
 */
export function describeSignAction(core: SignRequest["core"]): string {
  const quote = (s: string, max = 80) =>
    `“${s.length > max ? s.slice(0, max - 1) + "…" : s}”`;
  switch (core.t) {
    case "post":
      return `Publish a post: ${quote(core.text ?? "")}`;
    case "reply":
      return `Reply to a post: ${quote(core.text ?? "")}`;
    case "branch":
      return core.text && core.text.trim().length > 0
        ? `Quote a post: ${quote(core.text)}`
        : "Repost a post";
    case "like":
      return core.meta && typeof core.meta.vote === "number"
        ? `Vote in a poll (option ${Number(core.meta.vote) + 1})`
        : "Like a post (pays its author)";
    case "follow":
      return `Follow ${core.target ?? "an account"} (pays them)`;
    case "profile":
      return "Update your Xetch profile";
    default:
      // Unpriceable actions are rejected before display; this is belt-and-
      // suspenders for a future core type arriving ahead of wallet support.
      return `Unrecognised action: ${String(core.t)}`;
  }
}
