#!/usr/bin/env node
/**
 * R12 — parity check across the three CSP declarations.
 *
 * The canonical policy lives in `src/config/csp.ts`. This script asserts
 * that `src-tauri/tauri.conf.json` and `public/_headers` agree with it,
 * exiting non-zero if any drift. Wire it into CI / pre-commit to catch
 * the drift the audit flagged.
 *
 * Usage:
 *   node scripts/check-csp-parity.mjs        # from packages/app
 *   pnpm --filter @photonic/app csp:check    # via package script
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");

function read(path) {
  return readFileSync(resolve(appRoot, path), "utf-8");
}

/** Pull the CONTENT_SECURITY_POLICY string out of csp.ts at runtime by
 *  evaluating the relevant constants. We don't want to depend on `ts-node`
 *  or build the module — instead we parse the literal arrays and rebuild
 *  the string the same way the TS does. If you change the structure of
 *  csp.ts, update this parser too. */
function readCanonicalCsp() {
  const src = read("src/config/csp.ts");
  // Extract the two host arrays.
  const connectMatch = src.match(/const CONNECT_HOSTS = \[([\s\S]*?)\]\.join/);
  const imgMatch = src.match(/const IMG_HOSTS = \[([\s\S]*?)\]\.join/);
  if (!connectMatch || !imgMatch) {
    throw new Error(
      "csp.ts: could not locate CONNECT_HOSTS / IMG_HOSTS arrays"
    );
  }
  const parseHosts = (arrBody) =>
    arrBody
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"') || line.startsWith("'"))
      .map((line) => line.replace(/^["']|["'],?$/g, ""))
      .filter(Boolean)
      .join(" ");
  const connectSrc = parseHosts(connectMatch[1]);
  const imgSrc = parseHosts(imgMatch[1]);
  return [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `connect-src ${connectSrc}`,
    `img-src ${imgSrc}`,
    `font-src 'self' data:`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `frame-ancestors 'none'`,
    `worker-src 'self'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `upgrade-insecure-requests`,
  ].join("; ");
}

function readTauriCsp() {
  const json = JSON.parse(read("src-tauri/tauri.conf.json"));
  return json.tauri?.security?.csp ?? "";
}

function readHeadersCsp() {
  const text = read("public/_headers");
  const match = text.match(/Content-Security-Policy:\s*(.+?)$/m);
  return match ? match[1].trim() : "";
}

const canonical = readCanonicalCsp();
const tauri = readTauriCsp();
const headers = readHeadersCsp();

let ok = true;
function check(label, actual) {
  if (actual === canonical) {
    console.log(`[csp-parity] ✓ ${label}`);
    return;
  }
  ok = false;
  console.error(`[csp-parity] ✗ ${label} drift`);
  console.error("  canonical:", canonical);
  console.error("  actual:   ", actual);
}

check("src-tauri/tauri.conf.json", tauri);
check("public/_headers", headers);

if (!ok) {
  console.error(
    "\nCSP drift detected. Update src-tauri/tauri.conf.json and " +
      "public/_headers to match src/config/csp.ts."
  );
  process.exit(1);
}
console.log("[csp-parity] all sites agree");
