/**
 * Off-chain REFERENCE odds for a prediction market.
 *
 * A market creator may attach a link to an equivalent market on an external venue (carried in the
 * RMKT beacon as `oddsRef` — see radiantswap/market/beacon.ts). When the on-chain order book is
 * empty (no liquidity yet), the UI shows that venue's implied YES% as a *reference only* — it is
 * NOT the tradeable on-chain price, and the pointer is creator-supplied and untrusted, so we:
 *   - only ever fetch from a fixed host allowlist (defence against being pointed at arbitrary URLs),
 *   - send only the market slug/id (never wallet data),
 *   - clearly label the result as an external reference in the UI.
 *
 * Only Polymarket is supported today: its public Gamma API is CORS-enabled (`access-control-allow-
 * origin: *`) so the wallet can read it directly from the browser. Kalshi's API requires
 * authentication and is not reachable client-side, so it's intentionally omitted for now.
 */

export type OddsProvider = "polymarket";

export interface ReferenceOdds {
  provider: OddsProvider;
  /** Implied probability of YES, 0..1. */
  yesProb: number;
  /** The external market's own question/title, for the tooltip. */
  title: string;
  /** Canonical link back to the external market. */
  url: string;
  /** The external market has closed/resolved — the reference is stale. */
  closed: boolean;
}

/** Hosts the wallet is allowed to fetch reference odds from. Anything else is refused. */
const POLYMARKET_API_HOST = "gamma-api.polymarket.com";
const POLYMARKET_SITE_HOST = "polymarket.com";

export interface ParsedReference {
  provider: OddsProvider;
  slug: string;
}

/** Parse a creator-supplied reference string into a provider + market slug. Accepts:
 *   - a Polymarket URL: https://polymarket.com/event/<slug>, /market/<slug>, or /.../<slug>
 *   - "poly:<slug>" / "polymarket:<slug>"
 *   - a bare slug (kebab-case)
 *  Returns null for anything unrecognised or off-allowlist (e.g. a non-Polymarket URL). */
export function parseReference(input: string): ParsedReference | null {
  const raw = (input || "").trim();
  if (!raw) return null;

  // Explicit provider prefix.
  const prefix = raw.match(/^(?:poly|polymarket):(.+)$/i);
  if (prefix) {
    const slug = sanitizeSlug(prefix[1]);
    return slug ? { provider: "polymarket", slug } : null;
  }

  // A URL — only trust the Polymarket site host, then take the last non-empty path segment.
  if (/^https?:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (u.hostname !== POLYMARKET_SITE_HOST && u.hostname !== `www.${POLYMARKET_SITE_HOST}`) {
      return null;
    }
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    const slug = sanitizeSlug(seg);
    return slug ? { provider: "polymarket", slug } : null;
  }

  // A bare slug.
  const slug = sanitizeSlug(raw);
  return slug ? { provider: "polymarket", slug } : null;
}

/** Keep slugs to the safe kebab-case charset Polymarket uses, so the value is safe to interpolate
 *  into a query string and can't smuggle another host/path. */
function sanitizeSlug(s: string): string | null {
  const slug = s.trim().toLowerCase();
  return /^[a-z0-9-]{2,120}$/.test(slug) ? slug : null;
}

/** Coerce a value that may be a JSON-encoded array string OR an array into a string[]. Polymarket's
 *  Gamma API returns `outcomes`/`outcomePrices` as JSON strings in some responses, arrays in others. */
function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Fetch the reference YES probability for a creator-supplied reference string. Best-effort: returns
 *  null on any parse/allowlist/network/shape failure so the caller simply shows nothing. */
export async function fetchReferenceOdds(
  input: string,
  signal?: AbortSignal
): Promise<ReferenceOdds | null> {
  const ref = parseReference(input);
  if (!ref) return null;
  try {
    const url = `https://${POLYMARKET_API_HOST}/markets?slug=${encodeURIComponent(ref.slug)}`;
    const resp = await fetch(url, { signal });
    if (!resp.ok) return null;
    const body = (await resp.json()) as unknown;
    const m = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
    if (!m) return null;

    const outcomes = asArray(m.outcomes);
    const prices = asArray(m.outcomePrices);
    if (!prices.length) return null;
    // Map the YES outcome; default to index 0 when unlabeled.
    const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(o));
    const idx = yesIdx >= 0 ? yesIdx : 0;
    const yesProb = clamp01(parseFloat(prices[idx]));
    if (!Number.isFinite(yesProb)) return null;

    return {
      provider: "polymarket",
      yesProb,
      title: typeof m.question === "string" ? m.question : ref.slug,
      url: `https://${POLYMARKET_SITE_HOST}/market/${ref.slug}`,
      closed: m.closed === true,
    };
  } catch {
    return null;
  }
}
