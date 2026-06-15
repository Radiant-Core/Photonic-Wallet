/**
 * Pure honesty/trust model for prediction markets — the data behind the trust badges, the
 * bond-adequacy warning and the "how this resolves & your recourse" panel.
 *
 * Two properties must never be conflated:
 *   - Solvency / anti-theft is *cryptographically* guaranteed by the covenants (collateral is
 *     fully backed 1:1, shares can't be minted without locking RXD, complete sets are always
 *     reclaimable, no double-resolution, no cross-market replay).
 *   - Outcome *correctness* is NOT on-chain — the covenant verifies who signed, not whether the
 *     world agrees. So honesty rests on the resolver: a single operator, a committee threshold,
 *     or (optimistic) a bonded proposer + watchdog committee.
 *
 * This module surfaces that distinction honestly so a trader can price the trust they're taking.
 * It is intentionally dependency-free (type-only import) so it unit-tests without the wallet/
 * electrum runtime.
 */
import type { TrackedMarket } from "./predict";

export type OracleTrustKind = "optimistic" | "committee" | "solo";

export interface OracleTrust {
  kind: OracleTrustKind;
  /** Signatures required by the on-chain descriptor (the threshold byte). */
  threshold: number;
  /** Committee size, when the creator-side member keys are known locally; else null. */
  n: number | null;
  /** Short chip label, e.g. "Bonded optimistic", "2-of-3 committee", "Single operator". */
  label: string;
  /** Chakra colorScheme for the chip — teal (strong) / blue (ok) / yellow (caution). */
  scheme: "teal" | "blue" | "yellow";
  /** Coarse trust strength, higher = less trust required. */
  strength: 0 | 1 | 2;
  /** True → render in a cautionary tone (single-signature resolution or weak optimistic guard). */
  caution: boolean;
  /** Optimistic markets only: the override/dispute authority is a single key (threshold-1 descriptor),
   *  so the watchdog is one operator, not a committee. Drives honest "solo watchdog" wording. */
  soloWatchdog: boolean;
}

/** The descriptor threshold byte (first byte of the 33-byte oracle descriptor), defaulting to 1. */
export function oracleThreshold(t: Pick<TrackedMarket, "oracle">): number {
  const n = parseInt((t.oracle || "").substring(0, 2), 16);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Classify how much trust a market's resolution requires, from on-chain facts the wallet can see.
 *
 * Optimistic markets are NOT unconditionally "strongest". Two things can weaken them:
 *   - The override/dispute authority is the SAME threshold descriptor as a classic market, so a
 *     threshold-1 optimistic market has a single key as its only watchdog (`soloWatchdog`).
 *   - The covenant only requires `bond > 0` (no creation-time floor), so a thin bond barely deters a
 *     near-free false proposal that auto-finalizes if the watchdog is asleep.
 * When `pool` is supplied (detail page) a thin/weak bond also downgrades the rating. Either weakness
 * flips the badge to caution so it stops ranking strictly above a real committee — matching the
 * separate {@link bondAdequacy} warning instead of contradicting it.
 *
 * `optimisticHint` covers indexer-discovered markets whose full bond/liveness terms aren't loaded yet.
 */
export function oracleTrust(
  t: Pick<
    TrackedMarket,
    "oracle" | "committeeKeys" | "optimistic" | "optimisticHint"
  >,
  opts?: { pool?: number }
): OracleTrust {
  const threshold = oracleThreshold(t);
  const n = t.committeeKeys?.length ?? null;
  if (t.optimistic || t.optimisticHint) {
    const soloWatchdog = threshold === 1 && (n == null || n <= 1);
    // Bond known + pool known (detail page): factor in adequacy. Hub/discovery: terms unknown → null.
    const bondLevel =
      t.optimistic && opts?.pool != null
        ? bondAdequacy(t.optimistic.bond, opts.pool).level
        : null;
    const thinBond = bondLevel === "thin" || bondLevel === "weak";
    const weak = soloWatchdog || thinBond;
    return {
      kind: "optimistic",
      threshold,
      n,
      soloWatchdog,
      label: thinBond
        ? "Bonded · thin bond"
        : soloWatchdog
        ? "Bonded · solo guard"
        : "Bonded optimistic",
      scheme: weak ? "yellow" : "teal",
      strength: weak ? 1 : 2,
      caution: weak,
    };
  }
  if (threshold >= 2) {
    return {
      kind: "committee",
      threshold,
      n,
      soloWatchdog: false,
      label: n ? `${threshold}-of-${n} committee` : `${threshold}-sig committee`,
      scheme: "blue",
      strength: 1,
      caution: false,
    };
  }
  // threshold === 1, classic: a single valid signature settles the market.
  return {
    kind: "solo",
    threshold: 1,
    n,
    soloWatchdog: false,
    label: n && n > 1 ? `1-of-${n} oracle` : "Single operator",
    scheme: "yellow",
    strength: 0,
    caution: true,
  };
}

// ───────────────────────────── bond adequacy (optimistic) ─────────────────────────────
// A false optimistic proposal is profitable when the attacker's winning-side payoff exceeds the
// bond they stand to lose if overridden. The bond is fixed at creation while the collateral pool
// (open interest) grows, so a once-ample bond can become thin. We surface the bond-to-pool ratio
// and warn when the bond is small relative to what's at stake. This is a *heuristic* shown to the
// user — it is NOT consensus-enforced. A covenant-level floor is specced in docs/HONESTY_ROADMAP.md.

export type BondLevel = "ok" | "thin" | "weak";

export interface BondAdequacy {
  /** bond / pool, or 0 when the pool is empty/unknown. */
  ratio: number;
  level: BondLevel;
}

/** A bond at/above this fraction of the pool risks a meaningful share of open interest → "ok". */
export const BOND_OK_RATIO = 0.1;
/** Below this fraction the bond barely deters a false proposal → "weak". */
export const BOND_THIN_RATIO = 0.02;

export function bondAdequacy(bond: number, pool: number): BondAdequacy {
  const ratio = pool > 0 ? bond / pool : 0;
  const level: BondLevel =
    ratio >= BOND_OK_RATIO ? "ok" : ratio >= BOND_THIN_RATIO ? "thin" : "weak";
  return { ratio, level };
}

/** Format a bond/pool ratio for display, keeping one decimal for small (<10%) ratios. Truncates
 *  (floors) the decimal rather than rounding so a value just under the 10% OK floor never renders as
 *  "10.0%" inside a "thin bond" warning — the displayed number always agrees with the level. */
export function formatRatioPct(ratio: number): string {
  const pct = ratio * 100;
  if (pct <= 0) return "0%";
  if (pct < 10) return `${(Math.floor(pct * 10) / 10).toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}
