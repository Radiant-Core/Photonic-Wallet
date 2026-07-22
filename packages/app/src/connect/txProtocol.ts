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
 * Order matters: the structural parse (bridge-kit's, 14 rejection reasons,
 * including expiry) runs FIRST so the origin check below reads a `string`
 * that actually is one, then the origin gate turns "well-formed" into
 * "allowed to ask".
 */
export function parseSignParam(
  raw: string | null | undefined,
  opts?: { now?: number; dev?: boolean },
): ParsedSignParam {
  if (!raw || typeof raw !== "string") return { ok: false, reason: "missing request" };

  let decoded: unknown;
  try {
    decoded = b64urlDecode(raw);
  } catch {
    return { ok: false, reason: "undecodable request" };
  }

  const parsed = parseBridgeRequest(decoded, opts?.now !== undefined ? { now: opts.now } : undefined);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  if (!isAllowedSignOrigin(parsed.value.origin, { dev: opts?.dev })) {
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
 * The action in plain words for the approval screen. This line is the human
 * side of the trust boundary — it must describe what the CORE says, because
 * the core is the only thing the requesting site truly controls. Everything
 * priced (recipients, amounts, fee) is derived locally and shown separately.
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
