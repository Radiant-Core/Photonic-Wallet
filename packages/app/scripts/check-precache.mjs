#!/usr/bin/env node
/**
 * Precache completeness gate — guards against the white-screen bug class.
 *
 * The 2026-07 incident: the entry chunk grew past Workbox's default 2 MiB
 * `maximumFileSizeToCacheInBytes` and was SILENTLY dropped from the precache
 * manifest, while index.html (which references it) stayed precached. Every
 * deploy then stranded returning clients on a cached shell whose JS 404s.
 *
 * This script fails the build if:
 *   1. any asset referenced by dist/index.html is missing from the sw.js
 *      precache manifest (the exact bug), or
 *   2. any dist/assets *.js/*.css file on disk is missing from the manifest
 *      (superset check — lazy chunks matter too), or
 *   3. any bundle file exceeds 3 MiB (half the 7 MiB workbox cap configured
 *      in vite.config.ts — catches bundle regrowth long before it silently
 *      falls out of the precache again).
 *
 * No-ops when dist/sw.js doesn't exist (Capacitor builds disable the PWA).
 *
 * Usage:  node scripts/check-precache.mjs   # from packages/app, after build
 * Wired:  pnpm build  (vite build && node scripts/check-precache.mjs)
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "dist");
const MAX_FILE_BYTES = 3 * 1024 * 1024;

const swPath = join(dist, "sw.js");
if (!existsSync(swPath)) {
  console.log("[precache] no dist/sw.js (Capacitor build?) — skipping");
  process.exit(0);
}

const sw = readFileSync(swPath, "utf-8");
const indexHtml = readFileSync(join(dist, "index.html"), "utf-8");

// Precache manifest entries: {url:"...",revision:...} (minified, keys may or
// may not be quoted, order may vary).
const manifest = new Set();
for (const m of sw.matchAll(/["']?url["']?\s*:\s*"([^"]+)"/g)) {
  manifest.add(m[1].replace(/^\.\//, ""));
}
if (manifest.size === 0) {
  console.error("[precache] FAIL: could not parse a manifest out of dist/sw.js");
  process.exit(1);
}

let failed = false;
const fail = (msg) => {
  failed = true;
  console.error(`[precache] FAIL: ${msg}`);
};

// 1. Everything index.html references must be precached.
const referenced = new Set();
for (const m of indexHtml.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)) {
  referenced.add(m[1]);
}
if (referenced.size === 0) fail("no asset references found in dist/index.html");
for (const url of referenced) {
  if (!manifest.has(url))
    fail(`index.html references ${url} but it is NOT in the sw.js precache manifest`);
}

// 2. Every built js/css asset on disk must be precached, and 3. size-gated.
for (const name of readdirSync(join(dist, "assets"))) {
  const rel = `assets/${name}`;
  const size = statSync(join(dist, "assets", name)).size;
  if (/\.(js|mjs|css)$/.test(name) && !manifest.has(rel))
    fail(`${rel} exists in dist but is NOT in the sw.js precache manifest`);
  if (size > MAX_FILE_BYTES)
    fail(
      `${rel} is ${(size / 1024 / 1024).toFixed(2)} MiB (> ${MAX_FILE_BYTES / 1024 / 1024} MiB guardrail — split it before it outgrows the precache cap)`
    );
}

// Duplicates are a config smell (e.g. includeAssets overlapping globPatterns).
const seen = new Map();
for (const m of sw.matchAll(/["']?url["']?\s*:\s*"([^"]+)"/g)) {
  const u = m[1];
  seen.set(u, (seen.get(u) ?? 0) + 1);
}
for (const [u, n] of seen) {
  if (n > 1) console.warn(`[precache] warn: ${u} appears ${n}x in the manifest`);
}

if (failed) process.exit(1);
console.log(
  `[precache] ✓ ${manifest.size} entries; index.html's ${referenced.size} referenced assets all precached; all files ≤ ${MAX_FILE_BYTES / 1024 / 1024} MiB`
);
