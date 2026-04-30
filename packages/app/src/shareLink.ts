/**
 * CEK Share Link utilities
 *
 * Encodes a CEK share token as a URL-safe base64 fragment appended to the
 * current hash-router URL.  The payload never touches a server — it lives
 * entirely in the URL fragment (#…share=<base64>).
 *
 * Format:  <current hash route>#share=<base64url(JSON token)>
 * Example: index.html#/objects/token/abc123:0#share=eyJ2IjoxLC...
 *
 * Security: the fragment is never sent in HTTP requests.  The token itself
 * is a wrapped (encrypted) CEK — useless without the recipient's private key.
 */

export type CekShareToken = {
  v: 1;
  ref: string;        // tokenRef ("txid:vout") — for display only
  kid: string;        // "x25519" | "x25519mlkem768"
  wrapped_cek: string; // base64 — wrapped CEK (nonce || ciphertext) — REP-3006 wrapped_cek
  epk: string;        // base64 — ephemeral X25519 public key — REP-3006 epk
  cek_hash: string;   // "sha256:<hex>" — on-chain commitment (also used as AAD)
};

/** Encode a token into a full shareable URL using the current page location */
export function buildShareUrl(token: CekShareToken): string {
  const json = JSON.stringify(token);
  const b64 = btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  // window.location.hash already includes the leading '#', e.g. "#/objects/token/abc"
  // We append our fragment parameter with a second '#' — browsers keep only the last
  // fragment, so we use '&' within the existing hash segment instead.
  // Strategy: append ?share=<b64> before any existing query in the hash, or use a
  // dedicated separator that survives copy-paste: just build a full new URL.
  const base = window.location.href.split("#share=")[0]; // strip any previous share param
  return `${base}#share=${b64}`;
}

/**
 * Decode a share token from either:
 *  (a) a full URL containing #share=<base64url>
 *  (b) a raw base64url string
 *  (c) a raw JSON string (legacy / power-user fallback)
 *
 * Returns null if the input is not a recognised share token.
 */
export function parseShareInput(input: string): CekShareToken | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // (a) Full URL — extract the #share= fragment
  const hashMatch = trimmed.match(/[#&]share=([A-Za-z0-9+/\-_=]+)/);
  if (hashMatch) {
    return decodeShareB64(hashMatch[1]);
  }

  // (b) Raw base64url (no braces, no spaces)
  if (/^[A-Za-z0-9\-_=+/]+$/.test(trimmed) && !trimmed.startsWith("{")) {
    return decodeShareB64(trimmed);
  }

  // (c) Raw JSON fallback
  try {
    const obj = JSON.parse(trimmed) as CekShareToken;
    if (obj.v === 1 && obj.wrapped_cek && obj.epk && obj.cek_hash) return obj;
  } catch { /* not JSON */ }

  return null;
}

function decodeShareB64(b64: string): CekShareToken | null {
  try {
    // Re-add base64 padding if stripped
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    const obj = JSON.parse(json) as CekShareToken;
    if (obj.v === 1 && obj.wrapped_cek && obj.epk && obj.cek_hash) return obj;
  } catch { /* invalid */ }
  return null;
}

/**
 * Read a pending share token from the current page URL fragment and remove it
 * so it doesn't linger in the browser history.
 * Returns null if no #share= param is present.
 */
export function consumeShareFromUrl(): CekShareToken | null {
  const raw = window.location.href;
  const match = raw.match(/[#&]share=([A-Za-z0-9+/\-_=]+)/);
  if (!match) return null;

  const token = decodeShareB64(match[1]);

  // Clean the share param from the URL without triggering a navigation
  try {
    const cleaned = raw.replace(/[#&]share=[A-Za-z0-9+/\-_=]+/, "");
    window.history.replaceState(null, "", cleaned);
  } catch { /* non-browser env (tests) */ }

  return token;
}
