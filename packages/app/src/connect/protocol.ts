/**
 * Wire format for the external-wallet "connect" handshake.
 *
 * Transport-agnostic: the same request/result envelopes ride over QR, paste,
 * or a deep-link `?req=` param. This module is PURE (no React, no key access)
 * so it is exhaustively unit-testable and can never touch a secret.
 *
 * Five request types share this envelope:
 *
 *  - `sign-request` (Phase A, see GlyphGalaxy `docs/WALLET_CONNECT_SCOPE.md`):
 *    the dApp emits a namespaced challenge — e.g.
 *    `glyphgalaxy:wallet-connect:v1:<sessionId>:<nonce>` — as a bare string or
 *    wrapped in a {@link SignRequest} envelope. Photonic signs it via
 *    `@lib/sign` (a message, never a transaction) and returns a
 *    {@link SignResult}.
 *  - `psbt-sign-request` (see `docs/psbt.md`): the dApp hands over a Radiant
 *    PSBT (base64/base64url). Photonic signs whatever P2PKH inputs it owns
 *    via `@lib/psbt`'s `signPsbt`, then either returns the (possibly still
 *    partial) signed PSBT or — only when the request opts in with
 *    `broadcast: true` and every input ends up signed — finalizes, extracts,
 *    and broadcasts, returning a txid instead. See {@link PsbtSignRequest}.
 *  - `mint-request` (see {@link MintRequest}): the dApp sends NFT metadata
 *    plus its primary content (embedded base64 or a remote URL) — no
 *    transaction at all. Photonic funds the mint from its OWN wallet UTXOs
 *    (self-funding coin selection, never dApp-specified inputs), builds and
 *    signs the commit+reveal pair via `@lib/mint`'s `mintToken`, broadcasts
 *    both, and returns `{commitTxid, revealTxid, ref}`. Unlike the other two
 *    types this always broadcasts — there is no "return unsigned" option,
 *    matching the wallet's own local Mint page.
 *  - `swap-offer-request` / `swap-accept-request` (see `docs/swap-request.md`):
 *    the maker side (`swap-offer-request`) reserves an owned NFT into the
 *    swap subaccount and returns a raw PSRT — NOT a `@lib/psbt` PSBT, the
 *    older "Partially Signed Radiant Transaction" convention already used by
 *    the wallet's own Swap page — for the dApp to distribute or index
 *    itself (`mode` must be `"private"`; there is no on-chain advertisement
 *    over connect). The taker side (`swap-accept-request`) completes and
 *    broadcasts a pasted-in PSRT, optionally appending a marketplace fee
 *    output (`feeRxd`/`feeAddress`) alongside any enforced creator royalty,
 *    and returns `{txid}`.
 *
 * The result normally returns to the dApp by hand (copy/paste or QR). A request
 * may instead opt in to an automatic return by carrying a `callback` URL; the
 * result then rides back in that URL's fragment (see {@link buildCallbackUrl},
 * {@link buildPsbtCallbackUrl}, {@link buildMintCallbackUrl}). A `callback` is
 * honoured ONLY when its origin matches the envelope's declared `origin`, so
 * one site can never route another site's result elsewhere.
 *
 * SECURITY: parsing NEVER trusts unvalidated fields. The challenge is run
 * through the same guards the signer enforces (`@lib/sign`: length cap +
 * no control characters) so the UI can render it verbatim and the service can
 * never be handed a hidden payload. Display-only fields (origin/app/address)
 * are sanitized and silently dropped if malformed — they are advisory, never
 * load-bearing for the signature. `broadcast` is the one field that changes
 * *behavior*, so it is never silently coerced: only the literal `true` opts
 * in, anything else means "return the PSBT" (the safer default). A mint
 * request's `main` content is restricted to a fixed MIME allow-list
 * ({@link MINT_ALLOWED_MIME_TYPES}) — stricter than the local Mint page's
 * "any non-empty type", because this content is dApp-controlled, not the
 * user's own file picker.
 */
import rjs from "@radiant-core/radiantjs";
import { MAX_MESSAGE_LENGTH, hasControlChars } from "@lib/sign";
import { filterAttrs } from "@lib/token";

const { Address } = rjs;

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

export type PsbtSignRequest = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "psbt-sign-request";
  /** The PSBT to sign, base64 or base64url (see `@lib/psbt`). */
  psbt: string;
  /**
   * Opt in to the wallet finalizing + broadcasting when its signature(s)
   * complete the transaction, returning a txid instead of a PSBT. Only the
   * literal `true` opts in — anything else, including omission, means
   * "always return the (possibly partial) signed PSBT".
   */
  broadcast?: boolean;
  /** Opaque correlation id echoed back in the result (optional). */
  id?: string;
  /** Requesting site origin, for display + trust decisions (optional). */
  origin?: string;
  /** Human-friendly app label, for display (optional). */
  app?: string;
  /**
   * Where to return the signed result, as a URL fragment (optional).
   *
   * Only ever populated when its origin matches {@link PsbtSignRequest.origin}
   * — see `cleanCallback`. Absent means the classic manual copy/paste return.
   */
  callback?: string;
};

export type PsbtSignResult = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "psbt-sign-result";
  id?: string;
  /** Present when returning a (possibly still partial) signed PSBT. */
  psbt?: string;
  /** Present when `broadcast` completed and the tx was accepted. */
  txid?: string;
  /** True once every input carries a final scriptSig. */
  complete: boolean;
};

/** An embedded file: raw bytes carried inline, base64-encoded on the wire. */
export type MintEmbeddedFile = {
  /** MIME type; must be one of {@link MINT_ALLOWED_MIME_TYPES}. */
  mime: string;
  /** Base64 (or base64url) content bytes. */
  data: string;
};

/** A remote file: the wallet embeds only a pointer, not the bytes. */
export type MintRemoteFile = {
  mime: string;
  /** Must be an absolute http(s) URL. */
  url: string;
};

export type MintRequest = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "mint-request";
  /** NFT name (Glyph `name` field). */
  name: string;
  description?: string;
  license?: string;
  /** Sanitized via `@lib/token`'s `filterAttrs`: string/number/boolean only. */
  attrs?: Record<string, string | number | boolean>;
  /** The NFT's primary content. */
  main: MintEmbeddedFile | MintRemoteFile;
  /** Override the wallet's current fee rate (photons/byte), if provided. */
  feeRate?: number;
  /**
   * Build and sign but do NOT broadcast — returns raw transaction hex to
   * inspect/decode instead of txids. Defaults to `true` (broadcast); only
   * the literal `false` opts out, matching `psbt-sign-request`'s `broadcast`
   * field convention (the one field that changes behavior is never silently
   * coerced).
   */
  broadcast?: boolean;
  id?: string;
  origin?: string;
  app?: string;
  callback?: string;
};

export type MintResult = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "mint-result";
  id?: string;
  /** True once both transactions were actually broadcast. */
  broadcast: boolean;
  /** Present when `broadcast` is true (the default). */
  commitTxid?: string;
  revealTxid?: string;
  /** Present when `broadcast: false` — nothing was sent; decode these to verify. */
  commitHex?: string;
  revealHex?: string;
  /** The (would-be) minted NFT's canonical ref (BE txid ‖ BE vout hex). */
  ref: string;
};

export type SwapOfferRequest = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "swap-offer-request";
  /** The NFT's canonical ref (BE txid ‖ BE vout hex), from the wallet's own vault. */
  ref: string;
  /** The RXD price the maker wants, in whole/decimal RXD (not photons). */
  priceRxd: number;
  /**
   * Only `"private"` is supported in v1: the offer is reserved and a PSRT is
   * returned for the dApp to distribute/index itself. There is no on-chain
   * advertisement — a request for `"broadcast"` mode is rejected outright
   * (see the local Swap page for that flow).
   */
  mode: "private";
  id?: string;
  origin?: string;
  app?: string;
  callback?: string;
};

export type SwapOfferResult = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "swap-offer-result";
  id?: string;
  /** Raw partially-signed transaction hex (NOT a PSBT — see docs/swap-request.md). */
  psrt: string;
  /**
   * The reserved swap-subaccount outpoint the PSRT's input spends — a
   * direct on-chain handle to the offer that needs no PSRT parsing. Check
   * whether this outpoint is still unspent to know if the offer is still
   * live (spent = completed or cancelled), the same check
   * `swap-accept-request` itself does before completing a purchase.
   */
  reserveTxid: string;
  reserveVout: number;
  /** The swap subaccount address the NFT was reserved into. */
  swapAddress: string;
  /** Echoes the request's `ref`, for convenience. */
  ref: string;
  /**
   * The maker's own main address — where sale proceeds land, and where a
   * reclaim (cancel) returns the NFT. Bind a listing's seller to this
   * on-chain identity rather than to a login-session address; it's also
   * exactly what to compare against when detecting a reclaim via
   * `get_by_ref` (see docs/swap-request.md §4).
   */
  payoutAddress: string;
  /** Echoes the request's `priceRxd` — the reservation's actual signed
   * price, so a caller can assert a listing matches without parsing the
   * PSRT. */
  priceRxd: number;
};

export type SwapAcceptRequest = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "swap-accept-request";
  /** The maker's PSRT, as raw transaction hex. */
  psrt: string;
  /** Marketplace fee amount in RXD; requires `feeAddress` alongside it. */
  feeRxd?: number;
  /** Marketplace fee recipient; requires `feeRxd` alongside it. */
  feeAddress?: string;
  id?: string;
  origin?: string;
  app?: string;
  callback?: string;
};

export type SwapAcceptResult = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "swap-accept-result";
  id?: string;
  txid: string;
};

export type SwapCancelRequest = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "swap-cancel-request";
  /**
   * The NFT's canonical ref — the same one the original `swap-offer-request`
   * carried. The wallet already tracks a pending swap per glyph (`swapPending`
   * on the `db.glyph` row, and the `db.swap` row's `fromGlyph`), so the ref
   * alone identifies which offer to cancel — no outpoint needed.
   */
  ref: string;
  id?: string;
  origin?: string;
  app?: string;
  callback?: string;
};

export type SwapCancelResult = {
  protocol: typeof CONNECT_PROTOCOL;
  v: typeof CONNECT_VERSION;
  t: "swap-cancel-result";
  id?: string;
  /** The reclaim transaction's txid. */
  txid: string;
};

export type ConnectRequest =
  | SignRequest
  | PsbtSignRequest
  | MintRequest
  | SwapOfferRequest
  | SwapAcceptRequest
  | SwapCancelRequest;

export type ParsedRequest =
  | { ok: true; request: ConnectRequest }
  | { ok: false; error: string };

const MAX_ID_LEN = 128;
const MAX_LABEL_LEN = 128;
const MAX_ORIGIN_LEN = 256;
const MAX_ADDRESS_LEN = 128;
const MAX_CALLBACK_LEN = 512;

const MAX_MINT_NAME_LEN = 128;
const MAX_MINT_DESC_LEN = 2_048;
const MAX_MINT_LICENSE_LEN = 256;
const MAX_MINT_MIME_LEN = 128;
const MAX_MINT_URL_LEN = 2_048;
const MAX_MINT_ATTR_KEYS = 32;
const MAX_MINT_ATTR_KEY_LEN = 64;

/**
 * Cap on the `main.data` envelope field, in base64 characters. This is a
 * coarse, char-length pre-check only (base64 padding makes it imprecise) —
 * matches `mintEmbedMaxBytes` (512 KB, `packages/app/src/config.json`) with
 * headroom for base64 expansion (~4/3). The exact byte-length enforcement
 * happens after decoding, in `@app/connect/mintFlow`.
 */
export const MAX_MINT_DATA_LEN = 700_000;

/** A ref is 36 bytes (32 txid + 4 vout) hex-encoded: exactly 72 hex chars. */
const REF_RE = /^[0-9a-f]{72}$/i;

/** Raw transaction hex — even length, hex charset. Generous cap: 50 KB. */
const MAX_PSRT_HEX_LEN = 100_000;
const PSRT_HEX_RE = /^[0-9a-f]*$/i;

/**
 * MIME types the wallet will embed on-chain. Restricted (vs. the local Mint
 * page's "any non-empty type" policy) because this content is dApp/attacker
 * — not the user's own file-picker — controlled.
 */
export const MINT_ALLOWED_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "text/plain",
  "application/json",
];

/**
 * Cap on the `psbt` envelope field, in base64 characters (~48 KB decoded).
 * Deep-link URLs and QR codes both have practical size ceilings; requests
 * carrying a larger PSBT must use a transport this protocol doesn't police
 * (e.g. the dApp's own backend) and are rejected here rather than silently
 * truncated.
 */
export const MAX_PSBT_LEN = 65_536;

/**
 * Cap on the whole callback URL this module will auto-navigate to. A signed
 * PSBT returned as a fragment can be large; if the composed URL would exceed
 * this, {@link buildPsbtCallbackUrl} returns undefined rather than risk a
 * silently truncated result — the honest fallback is the manual copy/paste
 * return.
 */
export const MAX_CALLBACK_URL_LEN = 8_192;

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
 * Like {@link cleanAddress}, but for an address that will actually be PAID —
 * currently only a `swap-accept-request`'s `feeAddress`, which becomes a real
 * output script.
 *
 * The charset check alone lets a typo'd or corrupted address through to
 * `p2pkhScript`, which throws mid-flow (safely, but as an opaque late failure
 * after the user has already approved). Decoding it here means a bad address
 * is rejected at parse with a clear reason, before anything is shown or
 * signed.
 *
 * Deliberately network-AGNOSTIC: radiantjs infers the network from the
 * version byte, so this accepts both mainnet and testnet encodings and only
 * rejects a failed base58check. Whether the address matches the wallet's own
 * network is checked in `@app/connect/swapFlow`, which — unlike this pure
 * transport layer — knows which network the wallet is on.
 */
function cleanPayoutAddress(v: unknown): string | undefined {
  const s = cleanAddress(v);
  if (!s) return undefined;
  try {
    Address.fromString(s);
  } catch {
    return undefined;
  }
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

/** protocol/version guards shared by every request type. */
function envelopeBasicsError(obj: Record<string, unknown>): string | null {
  if (obj.protocol !== undefined && obj.protocol !== CONNECT_PROTOCOL) {
    return `unsupported protocol: ${String(obj.protocol)}`;
  }
  if (obj.v !== undefined && obj.v !== CONNECT_VERSION) {
    return `unsupported protocol version: ${String(obj.v)}`;
  }
  return null;
}

function normalizeSignEnvelope(obj: Record<string, unknown>): ParsedRequest {
  const basicsErr = envelopeBasicsError(obj);
  if (basicsErr) return { ok: false, error: basicsErr };
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

/** A trimmed, whitespace-free, base64/base64url-charset string, length-capped. */
function cleanPsbtField(v: unknown): string | undefined {
  const s = cleanString(v, MAX_PSBT_LEN);
  if (!s || /\s/.test(s)) return undefined;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return undefined;
  return s;
}

function normalizePsbtEnvelope(obj: Record<string, unknown>): ParsedRequest {
  const basicsErr = envelopeBasicsError(obj);
  if (basicsErr) return { ok: false, error: basicsErr };
  const psbt = cleanPsbtField(obj.psbt);
  if (!psbt) {
    return {
      ok: false,
      error:
        typeof obj.psbt === "string" && obj.psbt.length > MAX_PSBT_LEN
          ? "psbt is too long"
          : "request is missing a psbt",
    };
  }
  const origin = cleanOrigin(obj.origin);
  return {
    ok: true,
    request: {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "psbt-sign-request",
      psbt,
      // Only the literal `true` opts in — see the module doc comment.
      broadcast: obj.broadcast === true,
      id: cleanString(obj.id, MAX_ID_LEN),
      origin,
      app: cleanString(obj.app, MAX_LABEL_LEN),
      callback: cleanCallback(obj.callback, origin),
    },
  };
}

/** A trimmed, whitespace-free, base64/base64url-charset string, length-capped. */
function cleanMintDataField(v: unknown): string | undefined {
  const s = cleanString(v, MAX_MINT_DATA_LEN);
  if (!s || /\s/.test(s)) return undefined;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return undefined;
  return s;
}

/** An absolute http(s) URL, length-capped — mirrors `toHttpOrigin`'s guards. */
function cleanMintUrl(v: unknown): string | undefined {
  const s = cleanString(v, MAX_MINT_URL_LEN);
  if (!s || /\s/.test(s)) return undefined;
  try {
    const url = new URL(s);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  } catch {
    return undefined;
  }
  return s;
}

/**
 * Validate the `main` content field: either an embedded file (`mime`+`data`,
 * base64) or a remote pointer (`mime`+`url`). Returns an error string, or the
 * cleaned field on success. The MIME allow-list applies to both forms — a
 * remote file's `mime` still ends up recorded in the on-chain payload.
 */
function cleanMintMain(
  v: unknown
): { ok: true; main: MintEmbeddedFile | MintRemoteFile } | { ok: false; error: string } {
  if (!v || typeof v !== "object") return { ok: false, error: "request is missing main content" };
  const obj = v as Record<string, unknown>;
  const mime = cleanString(obj.mime, MAX_MINT_MIME_LEN);
  if (!mime) return { ok: false, error: "main content is missing a mime type" };
  if (!MINT_ALLOWED_MIME_TYPES.includes(mime)) {
    return { ok: false, error: `unsupported mime type: ${mime}` };
  }
  if (typeof obj.data === "string") {
    const data = cleanMintDataField(obj.data);
    if (!data) {
      return {
        ok: false,
        error:
          obj.data.length > MAX_MINT_DATA_LEN
            ? "main content is too large"
            : "main content data is not valid base64",
      };
    }
    return { ok: true, main: { mime, data } };
  }
  if (typeof obj.url === "string") {
    const url = cleanMintUrl(obj.url);
    if (!url) return { ok: false, error: "main content url is not a valid http(s) URL" };
    return { ok: true, main: { mime, url } };
  }
  return { ok: false, error: "main content must carry either data or a url" };
}

/** Cap attrs to a bounded number of short keys, then sanitize values via
 * `@lib/token`'s `filterAttrs` (string/number/boolean, <100 chars each) — the
 * same rule the local Mint page's own payload is expected to satisfy. */
function cleanMintAttrs(
  v: unknown
): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Record<string, unknown>).filter(
    ([k]) => k.length > 0 && k.length <= MAX_MINT_ATTR_KEY_LEN && !hasControlChars(k)
  );
  if (entries.length === 0) return undefined;
  const capped = Object.fromEntries(entries.slice(0, MAX_MINT_ATTR_KEYS));
  const filtered = filterAttrs(capped) as Record<string, string | number | boolean>;
  return Object.keys(filtered).length ? filtered : undefined;
}

function normalizeMintEnvelope(obj: Record<string, unknown>): ParsedRequest {
  const basicsErr = envelopeBasicsError(obj);
  if (basicsErr) return { ok: false, error: basicsErr };

  const name = cleanString(obj.name, MAX_MINT_NAME_LEN);
  if (!name) return { ok: false, error: "request is missing a name" };

  const mainResult = cleanMintMain(obj.main);
  if (!mainResult.ok) return { ok: false, error: mainResult.error };

  if (obj.feeRate !== undefined) {
    if (typeof obj.feeRate !== "number" || !Number.isFinite(obj.feeRate) || obj.feeRate <= 0) {
      return { ok: false, error: "feeRate must be a positive number" };
    }
  }

  const origin = cleanOrigin(obj.origin);
  return {
    ok: true,
    request: {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "mint-request",
      name,
      description: cleanString(obj.description, MAX_MINT_DESC_LEN),
      license: cleanString(obj.license, MAX_MINT_LICENSE_LEN),
      attrs: cleanMintAttrs(obj.attrs),
      main: mainResult.main,
      feeRate: typeof obj.feeRate === "number" ? obj.feeRate : undefined,
      // Only the literal `false` opts out of the default (broadcast) — see
      // the module doc comment.
      broadcast: obj.broadcast === false ? false : true,
      id: cleanString(obj.id, MAX_ID_LEN),
      origin,
      app: cleanString(obj.app, MAX_LABEL_LEN),
      callback: cleanCallback(obj.callback, origin),
    },
  };
}

/** A trimmed, whitespace-free, hex-charset string, length- and parity-capped. */
function cleanPsrtField(v: unknown): string | undefined {
  const s = cleanString(v, MAX_PSRT_HEX_LEN);
  if (!s || /\s/.test(s)) return undefined;
  if (s.length % 2 !== 0 || !PSRT_HEX_RE.test(s)) return undefined;
  return s;
}

function normalizeSwapOfferEnvelope(obj: Record<string, unknown>): ParsedRequest {
  const basicsErr = envelopeBasicsError(obj);
  if (basicsErr) return { ok: false, error: basicsErr };

  const ref = typeof obj.ref === "string" ? obj.ref.trim().toLowerCase() : undefined;
  if (!ref || !REF_RE.test(ref)) {
    return { ok: false, error: "request is missing a valid ref" };
  }

  if (
    typeof obj.priceRxd !== "number" ||
    !Number.isFinite(obj.priceRxd) ||
    obj.priceRxd <= 0
  ) {
    return { ok: false, error: "priceRxd must be a positive number" };
  }

  if (obj.mode !== "private") {
    return {
      ok: false,
      error:
        obj.mode === "broadcast"
          ? "broadcast mode is not yet supported over connect — use the wallet's Swap page"
          : "mode must be \"private\"",
    };
  }

  const origin = cleanOrigin(obj.origin);
  return {
    ok: true,
    request: {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "swap-offer-request",
      ref,
      priceRxd: obj.priceRxd,
      mode: "private",
      id: cleanString(obj.id, MAX_ID_LEN),
      origin,
      app: cleanString(obj.app, MAX_LABEL_LEN),
      callback: cleanCallback(obj.callback, origin),
    },
  };
}

function normalizeSwapAcceptEnvelope(obj: Record<string, unknown>): ParsedRequest {
  const basicsErr = envelopeBasicsError(obj);
  if (basicsErr) return { ok: false, error: basicsErr };

  const psrt = cleanPsrtField(obj.psrt);
  if (!psrt) {
    return {
      ok: false,
      error:
        typeof obj.psrt === "string" && obj.psrt.length > MAX_PSRT_HEX_LEN
          ? "psrt is too long"
          : "request is missing a valid psrt",
    };
  }

  // feeRxd and feeAddress are a pair: both present or both absent. A fee
  // amount with no recipient (or vice versa) is always a caller mistake, so
  // it's rejected rather than silently dropped.
  const hasFeeRxd = obj.feeRxd !== undefined;
  const hasFeeAddress = obj.feeAddress !== undefined;
  if (hasFeeRxd !== hasFeeAddress) {
    return { ok: false, error: "feeRxd and feeAddress must be provided together" };
  }
  let feeRxd: number | undefined;
  let feeAddress: string | undefined;
  if (hasFeeRxd) {
    if (typeof obj.feeRxd !== "number" || !Number.isFinite(obj.feeRxd) || obj.feeRxd <= 0) {
      return { ok: false, error: "feeRxd must be a positive number" };
    }
    feeAddress = cleanPayoutAddress(obj.feeAddress);
    if (!feeAddress) return { ok: false, error: "feeAddress is not a valid address" };
    feeRxd = obj.feeRxd;
  }

  const origin = cleanOrigin(obj.origin);
  return {
    ok: true,
    request: {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "swap-accept-request",
      psrt,
      feeRxd,
      feeAddress,
      id: cleanString(obj.id, MAX_ID_LEN),
      origin,
      app: cleanString(obj.app, MAX_LABEL_LEN),
      callback: cleanCallback(obj.callback, origin),
    },
  };
}

function normalizeSwapCancelEnvelope(obj: Record<string, unknown>): ParsedRequest {
  const basicsErr = envelopeBasicsError(obj);
  if (basicsErr) return { ok: false, error: basicsErr };

  const ref = typeof obj.ref === "string" ? obj.ref.trim().toLowerCase() : undefined;
  if (!ref || !REF_RE.test(ref)) {
    return { ok: false, error: "request is missing a valid ref" };
  }

  const origin = cleanOrigin(obj.origin);
  return {
    ok: true,
    request: {
      protocol: CONNECT_PROTOCOL,
      v: CONNECT_VERSION,
      t: "swap-cancel-request",
      ref,
      id: cleanString(obj.id, MAX_ID_LEN),
      origin,
      app: cleanString(obj.app, MAX_LABEL_LEN),
      callback: cleanCallback(obj.callback, origin),
    },
  };
}

function normalizeEnvelope(obj: Record<string, unknown>): ParsedRequest {
  const t = obj.t;
  if (
    t !== undefined &&
    t !== "sign-request" &&
    t !== "psbt-sign-request" &&
    t !== "mint-request" &&
    t !== "swap-offer-request" &&
    t !== "swap-accept-request" &&
    t !== "swap-cancel-request"
  ) {
    return { ok: false, error: `unsupported request type: ${String(t)}` };
  }
  if (t === "psbt-sign-request") return normalizePsbtEnvelope(obj);
  if (t === "mint-request") return normalizeMintEnvelope(obj);
  if (t === "swap-offer-request") return normalizeSwapOfferEnvelope(obj);
  if (t === "swap-accept-request") return normalizeSwapAcceptEnvelope(obj);
  if (t === "swap-cancel-request") return normalizeSwapCancelEnvelope(obj);
  return normalizeSignEnvelope(obj);
}

/**
 * Parse a raw connect request from any transport. Accepts, in order:
 *   1. a JSON envelope ({@link SignRequest} or {@link PsbtSignRequest}, by `t`),
 *   2. a base64url-encoded JSON envelope (deep-link `?req=` form),
 *   3. a bare challenge string (the scope's server emits just the challenge;
 *      always a `sign-request` — a bare PSBT blob is never auto-accepted, an
 *      explicit `psbt-sign-request` envelope is required so intent is
 *      unambiguous).
 */
export function parseConnectRequest(raw: string): ParsedRequest {
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

export type ParsedSignRequest =
  | { ok: true; request: SignRequest }
  | { ok: false; error: string };

/**
 * @deprecated use {@link parseConnectRequest} — kept as a narrowly-typed
 * alias for existing sign-request-only call sites. Behaves identically to
 * `parseConnectRequest`, including correctly erroring if handed a
 * `psbt-sign-request` envelope — the narrower return type here just reflects
 * the historical "this is always a SignRequest" contract.
 */
export function parseSignRequest(raw: string): ParsedSignRequest {
  const r = parseConnectRequest(raw);
  if (!r.ok) return r;
  if (r.request.t !== "sign-request") {
    return { ok: false, error: `unsupported request type: ${r.request.t}` };
  }
  return { ok: true, request: r.request };
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

/** One key-value pair, or nothing when the value is absent. */
function optionalParam(
  key: string,
  value: string | undefined
): [string, string][] {
  return value === undefined ? [] : [[key, value]];
}

/**
 * Compose a callback URL carrying `params` in the FRAGMENT — the single place
 * every request type's result (and reject, and error) return is built.
 *
 * The fragment, never the query, is what keeps results out of server access
 * logs, proxy logs and the `Referer` header: it is read client-side by the
 * requesting page and never transmitted. Every value is
 * `encodeURIComponent`-escaped, because base64 payloads contain `+`, `/`
 * and `=`.
 *
 * Callers never pass an unvalidated `callback` here — origin-binding happened
 * once, at parse time, in `cleanCallback`.
 *
 * `enforceSizeCap` defaults to true: a composed URL over
 * {@link MAX_CALLBACK_URL_LEN} yields undefined so the caller falls back to
 * the manual copy/paste return, since a silently truncated result is worse
 * than no auto-return at all. {@link buildCallbackUrl} is the one opt-out —
 * it has always been uncapped, and its payload can in principle approach the
 * cap (a challenge is bounded only by `MAX_MESSAGE_LENGTH`, 4096, and the
 * nonce is a segment of it), so applying the cap now could turn a
 * currently-working sign callback into a manual fallback. That asymmetry is
 * deliberate rather than an oversight.
 */
function composeCallbackUrl(
  callback: string | undefined,
  params: [string, string][],
  { enforceSizeCap = true }: { enforceSizeCap?: boolean } = {}
): string | undefined {
  if (!callback) return undefined;
  const fragment = params
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `${callback}#${fragment}`;
  if (enforceSizeCap && url.length > MAX_CALLBACK_URL_LEN) return undefined;
  return url;
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
  return composeCallbackUrl(
    req.callback,
    [
      ...optionalParam("nonce", extractChallengeNonce(req.challenge)),
      ["address", result.address],
      ["signature", result.signature],
    ],
    // Deliberately uncapped, unlike every other result type — see
    // `composeCallbackUrl`.
    { enforceSizeCap: false }
  );
}

/** Serialize a result for the response QR / copy box. */
export function encodeSignResult(result: SignResult): string {
  return JSON.stringify(result);
}

/** Serialize a {@link PsbtSignResult} for the response QR / copy box. */
export function encodePsbtResult(result: PsbtSignResult): string {
  return JSON.stringify(result);
}

/** base64url-encode a request envelope (for generating a deep link / QR). */
export function encodeReqParam(request: ConnectRequest): string {
  const json = JSON.stringify(request);
  const b64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(json, "utf8").toString("base64")
      : btoa(json);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @deprecated use {@link encodeReqParam} — kept as a named alias for dApp docs. */
export const encodePsbtReqParam = encodeReqParam;

/** Build a {@link PsbtSignResult} from a request + the outcome of signing. */
export function buildPsbtResult(
  req: Pick<PsbtSignRequest, "id">,
  out: { psbt?: string; txid?: string; complete: boolean }
): PsbtSignResult {
  return {
    protocol: CONNECT_PROTOCOL,
    v: CONNECT_VERSION,
    t: "psbt-sign-result",
    ...(req.id ? { id: req.id } : {}),
    ...(out.psbt !== undefined ? { psbt: out.psbt } : {}),
    ...(out.txid !== undefined ? { txid: out.txid } : {}),
    complete: out.complete,
  };
}

/**
 * The URL to hand a {@link PsbtSignResult} back to an opt-in `callback`, or
 * undefined when the request declared none, or when the composed URL would
 * exceed {@link MAX_CALLBACK_URL_LEN} — a signed PSBT can be large, and a
 * silently truncated auto-return is worse than falling back to the manual
 * copy/paste return.
 *
 * As with {@link buildCallbackUrl}, the result rides in the URL FRAGMENT,
 * never the query, so it never reaches a server's access/proxy logs.
 */
export function buildPsbtCallbackUrl(
  req: Pick<PsbtSignRequest, "callback">,
  result: Pick<PsbtSignResult, "id" | "psbt" | "txid" | "complete">
): string | undefined {
  return composeCallbackUrl(req.callback, [
    ...optionalParam("id", result.id),
    ...optionalParam("txid", result.txid),
    ...optionalParam("psbt", result.psbt),
    ["complete", String(result.complete)],
  ]);
}

/** Serialize a {@link SwapOfferResult} for the response QR / copy box. */
export function encodeSwapOfferResult(result: SwapOfferResult): string {
  return JSON.stringify(result);
}

/** Build a {@link SwapOfferResult} from a request + the maker's raw PSRT. */
export function buildSwapOfferResult(
  req: Pick<SwapOfferRequest, "id">,
  out: {
    psrt: string;
    reserveTxid: string;
    reserveVout: number;
    swapAddress: string;
    ref: string;
    payoutAddress: string;
    priceRxd: number;
  }
): SwapOfferResult {
  return {
    protocol: CONNECT_PROTOCOL,
    v: CONNECT_VERSION,
    t: "swap-offer-result",
    ...(req.id ? { id: req.id } : {}),
    psrt: out.psrt,
    reserveTxid: out.reserveTxid,
    reserveVout: out.reserveVout,
    swapAddress: out.swapAddress,
    ref: out.ref,
    payoutAddress: out.payoutAddress,
    priceRxd: out.priceRxd,
  };
}

/**
 * The URL to hand a {@link SwapOfferResult} back to an opt-in `callback`. As
 * with the other result types, undefined when the request declared none or
 * the composed URL would exceed {@link MAX_CALLBACK_URL_LEN} — a raw PSRT can
 * be sizeable, and the honest fallback is the manual copy/paste return.
 */
export function buildSwapOfferCallbackUrl(
  req: Pick<SwapOfferRequest, "callback">,
  result: Pick<
    SwapOfferResult,
    | "id"
    | "psrt"
    | "reserveTxid"
    | "reserveVout"
    | "swapAddress"
    | "ref"
    | "payoutAddress"
    | "priceRxd"
  >
): string | undefined {
  return composeCallbackUrl(req.callback, [
    ...optionalParam("id", result.id),
    ["psrt", result.psrt],
    ["reserveTxid", result.reserveTxid],
    ["reserveVout", String(result.reserveVout)],
    ["swapAddress", result.swapAddress],
    ["ref", result.ref],
    ["payoutAddress", result.payoutAddress],
    ["priceRxd", String(result.priceRxd)],
  ]);
}

/** Serialize a {@link SwapAcceptResult} for the response QR / copy box. */
export function encodeSwapAcceptResult(result: SwapAcceptResult): string {
  return JSON.stringify(result);
}

/** Build a {@link SwapAcceptResult} from a request + the broadcast txid. */
export function buildSwapAcceptResult(
  req: Pick<SwapAcceptRequest, "id">,
  out: { txid: string }
): SwapAcceptResult {
  return {
    protocol: CONNECT_PROTOCOL,
    v: CONNECT_VERSION,
    t: "swap-accept-result",
    ...(req.id ? { id: req.id } : {}),
    txid: out.txid,
  };
}

/** The URL to hand a {@link SwapAcceptResult} back to an opt-in `callback`. */
export function buildSwapAcceptCallbackUrl(
  req: Pick<SwapAcceptRequest, "callback">,
  result: Pick<SwapAcceptResult, "id" | "txid">
): string | undefined {
  return composeCallbackUrl(req.callback, [
    ...optionalParam("id", result.id),
    ["txid", result.txid],
  ]);
}

/** Serialize a {@link MintResult} for the response QR / copy box. */
export function encodeMintResult(result: MintResult): string {
  return JSON.stringify(result);
}

/** Build a {@link MintResult} from a request + the outcome of minting. */
export function buildMintResult(
  req: Pick<MintRequest, "id">,
  out: {
    broadcast: boolean;
    ref: string;
    commitTxid?: string;
    revealTxid?: string;
    commitHex?: string;
    revealHex?: string;
  }
): MintResult {
  return {
    protocol: CONNECT_PROTOCOL,
    v: CONNECT_VERSION,
    t: "mint-result",
    ...(req.id ? { id: req.id } : {}),
    broadcast: out.broadcast,
    ref: out.ref,
    ...(out.commitTxid !== undefined ? { commitTxid: out.commitTxid } : {}),
    ...(out.revealTxid !== undefined ? { revealTxid: out.revealTxid } : {}),
    ...(out.commitHex !== undefined ? { commitHex: out.commitHex } : {}),
    ...(out.revealHex !== undefined ? { revealHex: out.revealHex } : {}),
  };
}

/**
 * The URL to hand a {@link MintResult} back to an opt-in `callback`, or
 * undefined when the request declared none or the composed URL would exceed
 * {@link MAX_CALLBACK_URL_LEN}. As with the other result types, the payload
 * rides in the URL FRAGMENT, never the query.
 *
 * A dry-run (`broadcast: false`) result carries raw hex, which — especially
 * with embedded content — can easily blow past any reasonable URL length;
 * that's exactly what the length cap is for, falling back to manual
 * copy/QR rather than risk a silently truncated hex string.
 */
export function buildMintCallbackUrl(
  req: Pick<MintRequest, "callback">,
  result: Pick<
    MintResult,
    "id" | "broadcast" | "ref" | "commitTxid" | "revealTxid" | "commitHex" | "revealHex"
  >
): string | undefined {
  return composeCallbackUrl(req.callback, [
    ...optionalParam("id", result.id),
    ["broadcast", String(result.broadcast)],
    ["ref", result.ref],
    ...optionalParam("commitTxid", result.commitTxid),
    ...optionalParam("revealTxid", result.revealTxid),
    ...optionalParam("commitHex", result.commitHex),
    ...optionalParam("revealHex", result.revealHex),
  ]);
}

/** Serialize a {@link SwapCancelResult} for the response QR / copy box. */
export function encodeSwapCancelResult(result: SwapCancelResult): string {
  return JSON.stringify(result);
}

/** Build a {@link SwapCancelResult} from a request + the reclaim txid. */
export function buildSwapCancelResult(
  req: Pick<SwapCancelRequest, "id">,
  out: { txid: string }
): SwapCancelResult {
  return {
    protocol: CONNECT_PROTOCOL,
    v: CONNECT_VERSION,
    t: "swap-cancel-result",
    ...(req.id ? { id: req.id } : {}),
    txid: out.txid,
  };
}

/** The URL to hand a {@link SwapCancelResult} back to an opt-in `callback`. */
export function buildSwapCancelCallbackUrl(
  req: Pick<SwapCancelRequest, "callback">,
  result: Pick<SwapCancelResult, "id" | "txid">
): string | undefined {
  return composeCallbackUrl(req.callback, [
    ...optionalParam("id", result.id),
    ["txid", result.txid],
  ]);
}

/**
 * Build a "rejected" callback URL, fired when the user declines to approve
 * any request type. Generic across all six request types — they all share
 * `callback`/`id` — so callers just pass the request through. Same
 * origin-binding (already enforced when `callback` was parsed onto the
 * request) and size-cap rules as the success callbacks.
 */
export function buildRejectCallbackUrl(req: {
  callback?: string;
  id?: string;
}): string | undefined {
  return composeCallbackUrl(req.callback, [
    ...optionalParam("id", req.id),
    ["rejected", "true"],
  ]);
}

/**
 * A coarse, stable classification of a wallet-side failure — deliberately
 * approximate (matched from error message text, since the underlying flows
 * throw a mix of typed errors and plain `Error`s that were never designed as
 * a wire-level taxonomy) but specific enough for a dApp to branch on and
 * fail fast, rather than only ever seeing "unknown".
 */
export type ConnectErrorCode =
  | "locked"
  | "not_found"
  | "insufficient_funds"
  | "already_spent"
  | "invalid_request"
  | "unknown";

/**
 * Classify a caught error for the error callback (see
 * {@link buildErrorCallbackUrl}). Best-effort substring matching against the
 * error message — every throw site across mint/psbt/swap flow modules was
 * audited to make sure its message matches one of these patterns, but this
 * is not a formal contract those modules are held to, so treat `code` as a
 * best-effort hint and always show `message` too.
 */
export function classifyConnectError(err: unknown): {
  code: ConnectErrorCode;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  let code: ConnectErrorCode = "unknown";
  if (/unlock|locked/.test(lower)) {
    code = "locked";
  } else if (/insufficient|fund/.test(lower)) {
    code = "insufficient_funds";
  } else if (/already (been )?(spent|completed|cancelled|pending)/.test(lower)) {
    code = "already_spent";
  } else if (
    /not found|couldn.?t find|could not find|could not locate|could not resolve|could not fetch/.test(
      lower
    )
  ) {
    code = "not_found";
  } else if (
    /only .*(are|is) supported|must (have|be)|missing|invalid|unsupported|exceeds/.test(
      lower
    )
  ) {
    code = "invalid_request";
  }
  return { code, message };
}

/**
 * Build an "error" callback URL, fired when a wallet-side failure prevents
 * completing ANY request type — a genuine failure (locked, not found,
 * insufficient funds, already spent, ...), distinct from the user
 * explicitly declining ({@link buildRejectCallbackUrl}). Without this, a
 * dApp waiting on a deep-linked request has no way to distinguish "still
 * working" from "failed" and is left hanging until its own timeout.
 *
 * PRIVACY CONTRACT — `error.message` is forwarded verbatim to the requesting
 * site. This is the one path that hands raw internal error text to a third
 * party, so a throw site anywhere in the mint/psbt/swap flows must keep its
 * message free of anything the dApp shouldn't learn: no seed or WIF material
 * (obviously), but also no wallet balances, no addresses or outpoints the
 * request didn't already reference, and no full UTXO-set details. Today's
 * messages are safe — they name txids the dApp itself supplied or created,
 * which are public — but "insufficient funds" must never grow into
 * "insufficient funds: have 1234 photons". Widen with care.
 */
export function buildErrorCallbackUrl(
  req: { callback?: string; id?: string },
  error: { code: ConnectErrorCode; message: string }
): string | undefined {
  return composeCallbackUrl(req.callback, [
    ...optionalParam("id", req.id),
    ["error", error.code],
    ["message", error.message],
  ]);
}
