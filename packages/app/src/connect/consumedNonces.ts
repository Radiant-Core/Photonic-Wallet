/**
 * Consume-once ledger for sign-request nonces.
 *
 * The bridge contract makes a request single-use *in name* — it carries a fresh
 * nonce and a 180s expiry — but nothing on the wallet side stopped the SAME
 * request from being re-fired within that window. Each replay could drive a
 * second real broadcast (the user's own coins, a real fee), leaning entirely on
 * Xetch's server-side core-digest dedup to swallow the duplicate action. That's
 * a thin reed for a spend, so the wallet records every nonce it has actually
 * acted on and refuses it thereafter.
 *
 * Scope: sessionStorage. Per-tab and cleared on tab close, which is the right
 * lifetime — a nonce also expires in 180s, so cross-session memory buys nothing,
 * and a genuine re-initiation from Xetch always arrives with a fresh nonce. A
 * benign reload of an *un-broadcast* request still works, because a nonce is
 * only consumed at the irreversible step (broadcast), not on mere display.
 *
 * Bounded: we keep the most recent N so a long-lived tab can't grow the entry
 * without limit. N far exceeds any plausible in-window request count.
 */

const KEY = "xetch.sign.consumedNonces";
const MAX = 200;

function load(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as string[]).filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Has this nonce already been acted on in this tab? */
export function isNonceConsumed(nonce: string): boolean {
  return load().includes(nonce);
}

/** Record a nonce as acted-on. Idempotent; keeps only the most recent MAX. */
export function consumeNonce(nonce: string): void {
  try {
    const cur = load().filter((n) => n !== nonce);
    cur.push(nonce);
    const trimmed = cur.length > MAX ? cur.slice(cur.length - MAX) : cur;
    sessionStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* private mode / storage full: fall back to no replay protection rather
       than blocking the user. The server-side dedup remains as a backstop. */
  }
}
