import Big from "big.js";

export function photonsToRXD(photons: number, exact?: boolean) {
  const fixed = Big(photons).div(100000000).toString();
  return Intl.NumberFormat(
    navigator.language,
    exact ? undefined : { maximumSignificantDigits: 12 }
  ).format(fixed as unknown as number);
}

export function formatPhotons(photons: number) {
  return Intl.NumberFormat(navigator.language).format(photons);
}

/** Convert base units (1e8) to a compact human-readable string (e.g. "12.5K").
 *  All Radiant tokens — RXD and custom tokens alike — use 8 decimal places. */
export function formatAmountCompact(baseUnits: number): string {
  const whole = Big(baseUnits).div(100000000).toNumber();
  return Intl.NumberFormat(navigator.language, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(whole);
}

/** Convert on-chain photons to a compact token display amount.
 *  Uses the Glyph v2 `decimals` field (0-8, default 8):
 *    display = photons / 10^(8 - decimals)
 *  decimals=8 → 1 photon = 1 token (no division)
 *  decimals=0 → 100M photons = 1 token (same as RXD) */
export function formatTokenAmount(photons: number, decimals = 8): string {
  const divisor = Math.pow(10, 8 - decimals);
  const whole = Big(photons).div(divisor).toNumber();
  return Intl.NumberFormat(navigator.language, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(whole);
}
