/**
 * Wire format for the external-wallet "connect" signing handshake (Phase A).
 *
 * Transport-agnostic: the same request/result envelopes ride over QR, paste,
 * or a deep-link `?req=` param. This module is PURE (no React, no key access)
 * so it is exhaustively unit-testable and can never touch a secret.
 *
 * Flow (see GlyphGalaxy `docs/WALLET_CONNECT_SCOPE.md`):
 *   1. The dApp emits a namespaced challenge — e.g.
 *      `glyphgalaxy:wallet-connect:v1:<sessionId>:<nonce>` — as a bare string
 *      or wrapped in a {@link SignRequest} envelope (so it can carry the
 *      requesting origin for display).
 *   2. Photonic parses + validates it here, shows it to the user for explicit
 *      approval, signs via `@lib/sign`, and returns a {@link SignResult}.
 *   3. The dApp verifies the signature with radiantjs `Message.verify`.
 *
 * The result normally returns to the dApp by hand (copy/paste or QR). A request
 * may instead opt in to an automatic return by carrying a `callback` URL; the
 * result then rides back in that URL's fragment (see {@link buildCallbackUrl}).
 * A `callback` is honoured ONLY when its origin matches the envelope's declared
 * `origin`, so one site can never route another site's signature elsewhere.
 *
 * SECURITY: parsing NEVER trusts unvalidated fields. The challenge is run
 * through the same guards the signer enforces (`@lib/sign`: length cap +
 * no control characters) so the UI can render it verbatim and the service can
 * never be handed a hidden payload. Display-only fields (origin/app/address)
 * are sanitized and silently dropped if malformed — they are advisory, never
 * load-bearing for the signature.
 */
import { MAX_MESSAGE_LENGTH, hasControlChars } from "@lib/sign";

export const CONNECT_PROTOCOL = "photonic-connect";
export const CONNECT_VERSION = 1;

export type SignRequest = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "sign-request";
  /** The exact, namespaced challenge string to sign (signed verbatim). */
  challenge: string;
  /** Opaque correlation id echoed back in the result (optional). */
  id?: string;
  /** Requesting site origin, for display + trust decisions (optional). */
  origin?: string;
  /** Human-friendly app label, for display (optional). */
  app?: string;
  /** Address the requester expects to sign; page warns on mismatch (optional). */
  address?: string;
  /**
   * Where to return the signed result, as a URL fragment (optional).
   *
   * Only ever populated when its origin matches {@link SignRequest.origin} —
   * see `cleanCallback`. Absent means the classic manual copy/paste return.
   */
  callback?: string;
};

export type SignResult = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "sign-result";
  id?: string;
  address: string;
  pubkey: string;
  signature: string;
};

export type ParsedRequest =
  | { ok: true; request: SignRequest }
  | { ok: false; error: string };

const MAX_ID_LEN = 128;
const MAX_LABEL_LEN = 128;
const MAX_ORIGIN_LEN = 256;
const MAX_ADDRESS_LEN = 128;
const MAX_CALLBACK_LEN = 512;

// `<namespace>:wallet-connect:v<n>:...` — the shape Phase A challenges take.
// Used only to badge a request as "recognized" in the UI; non-matching
// challenges are still signable (with a warning), never auto-rejected.
const CONNECT_CHALLENGE_RE = /^[a-z0-9.-]+:wallet-connect:v\d+:/i;

// Captures the segment straight after `…:wallet-connect:v<n>:` — the nonce, in
// the shape the callback contract specifies
// (`radiant:wallet-connect:v1:<nonce>:<label>`). Only used to echo a
// correlation value back to a callback; never load-bearing for the signature.
const CONNECT_NONCE_RE = /^[a-z0-9.-]+:wallet-connect:v\d+:([^:]+)/i;

/** A trimmed, control-char-free, length-bounded display/identifier string. */
function cleanString(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!s || s.length > maxLen || hasControlChars(s)) return undefined;
  return s;
}

/** Origin must be a single whitespace-free token (scheme://host[:port] or host). */
function cleanOrigin(v: unknown): string | undefined {
  const s = cleanString(v, MAX_ORIGIN_LEN);
  if (!s || /\s/.test(s)) return undefined;
  return s;
}

/** Address must be base58/bech-style charset only (advisory display). */
function cleanAddress(v: unknown): string | undefined {
  const s = cleanString(v, MAX_ADDRESS_LEN);
  if (!s || !/^[0-9a-zA-Z:]+$/.test(s)) return undefined;
  return s;
}

/**
 * Parse an origin-ish string to its canonical `scheme://host[:port]` form.
 * Accepts a full origin (`https://surf.rxd.zone`) or a bare host
 * (`surf.rxd.zone`, assumed https). Returns undefined for anything that is not
 * an http(s) origin — including `javascript:`/`data:` URLs, whose `.origin` is
 * "null" and which must never round-trip a signature.
 */
function toHttpOrigin(v: string): string | undefined {
  let url: URL | undefined;
  for (const candidate of [v, `https://${v}`]) {
    try {
      url = new URL(candidate);
      break;
    } catch {
      /* try the next form */
    }
  }
  if (!url) return undefined;
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!url.hostname) return undefined;
  return url.origin;
}

/**
 * Validate an opt-in result callback, BOUND TO THE ENVELOPE'S ORIGIN.
 *
 * This binding is the check that matters: without it, site A could hand
 * Photonic site B's challenge with an attacker-controlled `callback` and have
 * the user's signature delivered to the attacker. A callback is therefore kept
 * only when the envelope declares an origin AND the callback resolves to that
 * exact origin (scheme, host, and port all). No origin ⇒ nothing to bind to ⇒
 * no callback, and the user falls back to the manual copy/paste return.
 *
 * Any fragment on the callback is dropped — we own the fragment, it is where
 * the result rides back.
 */
function cleanCallback(
  v: unknown,
  origin: string | undefined
): string | undefined {
  if (!origin) return undefined;
  const s = cleanString(v, MAX_CALLBACK_LEN);
  if (!s || /\s/.test(s)) return undefined;

  const expected = toHttpOrigin(origin);
  if (!expected) return undefined;

  let url: URL;
  try {
    url = new URL(s); // absolute only — a relative callback has no origin to bind
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  // Embedded credentials would render as part of the URL we navigate to; a
  // legitimate callback never needs them.
  if (url.username || url.password) return undefined;
  if (url.origin !== expected) return undefined;

  url.hash = "";
  return url.toString();
}

/**
 * The nonce inside a recognized connect challenge, if it has one.
 *
 * Per the callback contract the nonce is the segment right after
 * `<ns>:wallet-connect:v<n>:`, letting the requesting site match the response
 * to its pending request. Challenges that don't match the recognized shape
 * yield undefined and the callback simply carries no `nonce`.
 */
export function extractChallengeNonce(challenge: string): string | undefined {
  if (typeof challenge !== "string") return undefined;
  return CONNECT_NONCE_RE.exec(challenge)?.[1];
}

/**
 * Validate a candidate challenge with the SAME rules the signer enforces.
 * Returns an error message, or null if the challenge is safe to sign+display.
 * NOTE: the value is validated verbatim — never trimmed — because the dApp's
 * verifier checks the exact bytes.
 */
function challengeError(challenge: unknown): string | null {
  if (typeof challenge !== "string") return "request is missing a challenge";
  if (challenge.length === 0) return "challenge is empty";
  if (challenge.length > MAX_MESSAGE_LENGTH) return "challenge is too long";
  if (hasControlChars(challenge)) {
    return "challenge contains control characters";
  }
  return null;
}

function tryParseJsonObject(s: string): Record<string, unknown> | null {
  const t = s.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** base64url → UTF-8 string, or undefined if not base64url. */
function tryBase64ToString(s: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return undefined;
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    if (typeof Buffer !== "undefined") {
      return Buffer.from(b64, "base64").toString("utf8");
    }
    return typeof atob === "function" ? atob(b64) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEnvelope(obj: Record<string, unknown>): ParsedRequest {
  if (obj.t !== undefined && obj.t !== "sign-request") {
    return { ok: false, error: `unsupported request type: ${String(obj.t)}` };
  }
  if (obj.protocol !== undefined && obj.protocol !== CONNECT_PROTOCOL) {
    return {
      ok: false,
      error: `unsupported protocol: ${String(obj.protocol)}`,
    };
  }
  if (obj.v !== undefined && obj.v !== CONNECT_VERSION) {
    return {
      ok: false,
      error: `unsupported protocol version: ${String(obj.v)}`,
    };
  }
  const err = challengeError(obj.challenge);
  if (err) return { ok: false, error: err };
  const origin = cleanOrigin(obj.origin);
  return {
    ok: true,
    request: {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "sign-request",
      challenge: obj.challenge as string,
      id: cleanString(obj.id, MAX_ID_LEN),
      origin,
      app: cleanString(obj.app, MAX_LABEL_LEN),
      address: cleanAddress(obj.address),
      callback: cleanCallback(obj.callback, origin),
    },
  };
}

/**
 * Parse a raw connect request from any transport. Accepts, in order:
 *   1. a JSON {@link SignRequest} envelope,
 *   2. a base64url-encoded JSON envelope (deep-link `?req=` form),
 *   3. a bare challenge string (the scope's server emits just the challenge).
 */
export function parseSignRequest(raw: string): ParsedRequest {
  if (typeof raw !== "string") return { ok: false, error: "no request" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "empty request" };

  const envObj =
    tryParseJsonObject(trimmed) ??
    tryParseJsonObject(tryBase64ToString(trimmed) ?? "");
  if (envObj) return normalizeEnvelope(envObj);

  // Bare challenge. Trim is safe here (canonical connect challenges carry no
  // surrounding whitespace) and removes paste/scan artifacts before signing.
  const err = challengeError(trimmed);
  if (err) return { ok: false, error: err };
  return {
    ok: true,
    request: {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "sign-request",
      challenge: trimmed,
    },
  };
}

/** True if the challenge matches the recognized `…:wallet-connect:vN:…` shape. */
export function isRecognizedConnectChallenge(challenge: string): boolean {
  return typeof challenge === "string" && CONNECT_CHALLENGE_RE.test(challenge);
}

/** Build a {@link SignResult} from a request + a produced signature. */
export function buildSignResult(
  req: Pick<SignRequest, "id">,
  signed: { address: string; pubkey: string; signature: string }
): SignResult {
  return {
    protocol: CONNECT_PROTOCOL,
    v: CONNECT_VERSION,
    t: "sign-result",
    ...(req.id ? { id: req.id } : {}),
    address: signed.address,
    pubkey: signed.pubkey,
    signature: signed.signature,
  };
}

/**
 * The URL to hand a signed result back to an opt-in `callback`, or undefined
 * when the request declared none (the manual copy/paste return).
 *
 * The result rides in the FRAGMENT, never the query: a fragment is not sent to
 * any server, so the signature stays out of access logs, proxy logs, and the
 * `Referer` header — it is read client-side by the requesting page. Each value
 * is `encodeURIComponent`-escaped because a base64 signature contains `+`, `/`
 * and `=`.
 *
 * The signature's exposure is bounded regardless: it is over a single-use,
 * server-issued nonce, so a leaked one cannot be replayed against a different
 * challenge.
 */
export function buildCallbackUrl(
  req: Pick<SignRequest, "callback" | "challenge">,
  result: Pick<SignResult, "address" | "signature">
): string | undefined {
  if (!req.callback) return undefined;
  const nonce = extractChallengeNonce(req.challenge);
  const params: [string, string][] = [
    ...(nonce ? ([["nonce", nonce]] as [string, string][]) : []),
    ["address", result.address],
    ["signature", result.signature],
  ];
  const fragment = params
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${req.callback}#${fragment}`;
}

/** Serialize a result for the response QR / copy box. */
export function encodeSignResult(result: SignResult): string {
  return JSON.stringify(result);
}

/** base64url-encode a request envelope (for generating a deep link / QR). */
export function encodeReqParam(request: SignRequest): string {
  const json = JSON.stringify(request);
  const b64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(json, "utf8").toString("base64")
      : btoa(json);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
