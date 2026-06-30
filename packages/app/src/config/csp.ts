/**
 * Canonical Content-Security-Policy for Photonic Wallet.
 *
 * **This is the single source of truth.** Three deploy paths consume the
 * policy and MUST agree:
 *   - `packages/app/vite.config.ts`           — dev / preview servers (imports this file)
 *   - `packages/app/src-tauri/tauri.conf.json` — desktop bundle
 *   - `packages/app/public/_headers`          — static-host deploys (Netlify/Cloudflare)
 *
 * Tauri and `_headers` can't import this TS module (JSON / static file
 * formats), so they hard-code the same string. `scripts/check-csp-parity.mjs`
 * verifies they all match at build / CI time — if you change the policy
 * here, also update those two files and rerun the script.
 *
 * Audit context: this addresses finding R12. Prior to harmonisation the
 * Vite + Tauri configs allowed `connect-src https: wss:` (any host) while
 * `_headers` pinned to a specific allow-list — meaning an XSS attacker in
 * a non-Netlify-deployed build had the wide policy.
 */

const CONNECT_HOSTS = [
  // Self
  "'self'",
  // Block explorers (UI links + occasional fetch)
  "https://explorer.radiantblockchain.org",
  "https://testnet.radiantexplorer.com",
  // First-party swap relay
  "https://swap.radiantcore.org",
  // IPFS pinning gateway
  "https://*.ipfs.nftstorage.link",
  // ElectrumX websocket endpoints (community-run, allow-listed).
  // The `:*` port wildcard is required: CSP host-source matching defaults
  // to the scheme's default port (443 for `wss://`), but Electrum servers
  // listen on non-standard ports (50022 mainnet TLS, 53002 testnet TLS,
  // and others). Without `:*` Chrome/Safari block every Electrum
  // connection at the CSP layer before the socket even opens.
  "wss://*.radiant4people.com:*",
  "wss://*.radiantcore.org:*",
  "wss://*.bladenet.online:*",
].join(" ");

const IMG_HOSTS = [
  "'self'",
  "data:",
  "blob:",
  "https://*.ipfs.nftstorage.link",
  "https://nft.storage",
].join(" ");

/**
 * The canonical CSP, as a single header-value string.
 *
 * Directives in order: default → script → style → connect → img → font →
 * object → frame → frame-ancestors → worker → base → form-action → upgrade.
 *
 * Pinning notes:
 *   - `script-src 'self'` only — no inline scripts, no eval.
 *   - `style-src 'self' 'unsafe-inline'` — Chakra/Emotion injects runtime
 *     styles via `<style>` tags; we cannot drop `'unsafe-inline'` without
 *     replacing the styling library.
 *   - `object-src 'none'` and `frame-src 'none'` together kill SVG-script
 *     execution and iframe embedding (defense in depth for R13).
 *   - `frame-ancestors 'none'` denies third-party iframes embedding us.
 */
export const CONTENT_SECURITY_POLICY = [
  `default-src 'self'`,
  `script-src 'self'`,
  `style-src 'self' 'unsafe-inline'`,
  `connect-src ${CONNECT_HOSTS}`,
  `img-src ${IMG_HOSTS}`,
  `font-src 'self' data:`,
  `object-src 'none'`,
  `frame-src 'none'`,
  `frame-ancestors 'none'`,
  `worker-src 'self'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `upgrade-insecure-requests`,
].join("; ");

/**
 * WebView-tuned CSP for the Capacitor native builds (iOS / Android).
 *
 * Injected as a `<meta http-equiv>` tag at build time when `CAP_BUILD=1`
 * (see `vite.config.ts`) — native bundles have no HTTP server to set a real
 * CSP header, so the meta tag is the only place to enforce one.
 *
 * Differences from the canonical web policy:
 *   - Adds the Capacitor WebView origins (`capacitor://localhost` on iOS,
 *     `http(s)://localhost` on Android) to `default-/connect-/img-src`.
 *   - Adds `media-src ... mediastream:` so the live getUserMedia QR scanner's
 *     `<video>` element is allowed.
 *   - Widens `worker-src` to `'self' blob:` (some bundlers back workers with
 *     blob: URLs inside the WebView).
 *   - **Drops `upgrade-insecure-requests`**: Android serves the app from
 *     `http://localhost`; upgrading those requests to `https` would fail to
 *     resolve and white-screen the app. (iOS uses the secure `capacitor://`
 *     scheme, so nothing is lost there either.)
 *
 * This constant is intentionally separate from the canonical policy and is NOT
 * part of the `check-csp-parity.mjs` web-parity check.
 */
const CAPACITOR_ORIGINS = "capacitor://localhost https://localhost http://localhost";

export const CAPACITOR_CSP = [
  `default-src 'self' ${CAPACITOR_ORIGINS}`,
  `script-src 'self'`,
  `style-src 'self' 'unsafe-inline'`,
  `connect-src ${CONNECT_HOSTS} ${CAPACITOR_ORIGINS}`,
  `img-src ${IMG_HOSTS} ${CAPACITOR_ORIGINS}`,
  `media-src 'self' blob: mediastream:`,
  `font-src 'self' data:`,
  `object-src 'none'`,
  `frame-src 'none'`,
  `frame-ancestors 'none'`,
  `worker-src 'self' blob:`,
  `base-uri 'self'`,
  `form-action 'self'`,
].join("; ");

/** The full security-headers set applied by Vite dev/preview servers. */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
};
