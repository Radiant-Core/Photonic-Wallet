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

// `<namespace>:wallet-connect:v<n>:...` — the shape Phase A challenges take.
// Used only to badge a request as "recognized" in the UI; non-matching
// challenges are still signable (with a warning), never auto-rejected.
const CONNECT_CHALLENGE_RE = /^[a-z0-9.-]+:wallet-connect:v\d+:/i;

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
  return {
    ok: true,
    request: {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "sign-request",
      challenge: obj.challenge as string,
      id: cleanString(obj.id, MAX_ID_LEN),
      origin: cleanOrigin(obj.origin),
      app: cleanString(obj.app, MAX_LABEL_LEN),
      address: cleanAddress(obj.address),
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
