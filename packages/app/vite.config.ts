import { defineConfig } from "vite";
import { NodeGlobalsPolyfillPlugin } from "@esbuild-plugins/node-globals-polyfill";
import react from "@vitejs/plugin-react";
import { lingui } from "@lingui/vite-plugin";
import { VitePWA } from "vite-plugin-pwa";
import topLevelAwait from "vite-plugin-top-level-await";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "path";

/**
 * Security headers applied to dev/preview servers.
 *
 * The canonical policy lives in `src/config/csp.ts` and is shared with
 * the Tauri bundle (`src-tauri/tauri.conf.json`) and static-host
 * deployments (`public/_headers`) via the parity check at
 * `scripts/check-csp-parity.mjs`. See R12 in REMEDIATION_PLAN.md.
 *
 * IMPORTANT — PRODUCTION DEPLOYMENT:
 * These headers are only active during `vite dev` and `vite preview`.
 * They MUST also be set in the production web server config (Nginx/Caddy/etc.).
 */
import { SECURITY_HEADERS, CAPACITOR_CSP } from "./src/config/csp";

// Capacitor native build (set by the `build:mobile` script). When true we:
//   1. Drop the PWA service worker — it caches stale assets and misbehaves
//      under the capacitor:// (iOS) and http://localhost (Android) schemes.
//   2. Inject a WebView-appropriate CSP <meta> tag (native bundles have no
//      HTTP server to set a real Content-Security-Policy header).
const isCapacitorBuild = process.env.CAP_BUILD === "1";

// Injects the Capacitor CSP as a <meta http-equiv> into index.html at build.
function capacitorCspPlugin() {
  return {
    name: "photonic-capacitor-csp",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: CAPACITOR_CSP,
          },
          injectTo: "head-prepend" as const,
        },
      ];
    },
  };
}

// When driving the dev server over HTTP (HTTP_DEV=1), drop the Content-
// Security-Policy header entirely. The production CSP (canonical in
// src/config/csp.ts) is unchanged — this only affects the local dev/preview
// servers. Two reasons we drop it rather than soften it:
//   1. `upgrade-insecure-requests` forces every asset to https://127.0.0.1,
//      which fails (no cert) and silently white-screens the app.
//   2. `script-src 'self'` blocks Vite's React Fast Refresh inline preamble,
//      which the React plugin requires — without it you get
//      "@vitejs/plugin-react can't detect preamble" and the app aborts.
// The other security headers (X-Frame-Options etc.) stay on for parity with
// production.
const DEV_SERVER_HEADERS: Record<string, string> =
  process.env.HTTP_DEV === "1"
    ? Object.fromEntries(
        Object.entries(SECURITY_HEADERS).filter(
          ([k]) => k !== "Content-Security-Policy",
        ),
      )
    : SECURITY_HEADERS;

export default defineConfig({
  base: "./",
  server: {
    headers: DEV_SERVER_HEADERS,
  },
  preview: {
    headers: DEV_SERVER_HEADERS,
  },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // processShim + the buffer polyfill must evaluate before the
          // radiantjs chunk. Cross-chunk imports are hoisted and execute
          // BEFORE the importing chunk's own inlined module code — if the
          // shim stayed inlined in the entry while radiantjs is split out,
          // radiantjs would init before globalThis.Buffer/process exist
          // (the old white-screen crash class). Giving the shim its own
          // chunk preserves source order: main.tsx imports ./processShim
          // first, so Rollup emits that chunk import first in the entry.
          if (
            id.includes("/src/processShim") ||
            id.includes("node_modules/buffer/")
          )
            return "polyfills";
          if (!id.includes("node_modules")) return undefined;
          // bn.js / elliptic / hash.js are radiantjs's OWN CommonJS deps and
          // must live in the same chunk: splitting them out creates a chunk
          // cycle (bn.js needs the Buffer interop hoisted into the radiantjs
          // chunk, radiantjs needs bn.js) → TDZ "Cannot access before
          // initialization" at module eval → white screen with no console
          // error. Verified 2026-07-27.
          if (
            id.includes("@radiant-core/radiantjs") ||
            id.includes("/bn.js/") ||
            id.includes("/elliptic/") ||
            id.includes("/hash.js/")
          )
            return "radiantjs";
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id))
            return "react";
          if (id.includes("react-router") || id.includes("@remix-run"))
            return "router";
          if (
            id.includes("@chakra-ui") ||
            id.includes("@emotion") ||
            id.includes("framer-motion")
          )
            return "ui";
          if (id.includes("react-icons")) return "icons";
          if (id.includes("@noble/") || id.includes("@scure/"))
            return "crypto";
          if (id.includes("/dexie") || id.includes("localforage"))
            return "storage";
          if (id.includes("@lingui")) return "i18n";
          return undefined;
        },
      },
    },
  },
  plugins: [
    react({
      babel: {
        // useSignals hook is an alternative to signals-react-transform
        // If this plugin is removed @vitejs/plugin-react-swc can be used instead of Babel and @lingui/swc-plugin instead of macros
        plugins: ["module:@preact/signals-react-transform", "macros"],
      },
    }),
    topLevelAwait({
      promiseExportName: "__tla",
      promiseImportName: (i) => `__tla_${i}`,
    }),
    lingui(),
    // Mobile build: inject the WebView CSP and skip the service worker.
    // Web/Tauri build: keep the PWA service worker.
    ...(isCapacitorBuild
      ? [capacitorCspPlugin()]
      : [
          VitePWA({
            workbox: {
              // Everything index.html references MUST be precached or the SW
              // serves a cached shell whose JS 404s after the next deploy —
              // the recurring white-screen bug. The default 2 MiB cap
              // silently dropped the entry chunk; 7 MiB means even a
              // monolith regression stays precached (scripts/
              // check-precache.mjs fails the build long before that).
              globPatterns: [
                "**/*.{js,mjs,css,html,ico,png,svg,woff2,webmanifest}",
              ],
              maximumFileSizeToCacheInBytes: 7 * 1024 * 1024,
              // Activate a new SW immediately on install. Load-bearing for
              // stranded users: a white-screened page has no app to post
              // SKIP_WAITING, and a plain reload never activates a waiting
              // SW — without this they stay broken forever. Page-reload
              // timing stays app-controlled (modal-aware) in ReloadPrompt.
              skipWaiting: true,
              clientsClaim: true,
              cleanupOutdatedCaches: true,
            },
            registerType: "prompt",
            // Registration + update handling is hand-rolled in
            // ReloadPrompt.tsx (the plugin's prompt-mode client force-reloads
            // on update with no way to defer around an open modal). Don't
            // inject the plugin's own register script alongside it.
            injectRegister: null,
            manifest: {
              theme_color: "#1a1a24",
              background_color: "#1a1a24",
              display: "standalone",
              scope: "/",
              start_url: "/",
              short_name: "Photonic Wallet",
              description: "Mint and transfer tokens on Radiant",
              name: "Photonic Wallet",
              icons: [
                {
                  src: "pwa-64x64.png",
                  sizes: "64x64",
                  type: "image/png",
                },
                {
                  src: "pwa-192x192.png",
                  sizes: "192x192",
                  type: "image/png",
                },
                {
                  src: "pwa-512x512.png",
                  sizes: "512x512",
                  type: "image/png",
                },
                {
                  src: "maskable-icon-512x512.png",
                  sizes: "512x512",
                  type: "image/png",
                  purpose: "maskable",
                },
              ],
            },
          }),
        ]),
    // basicSsl serves a self-signed cert so Safari (which force-upgrades
    // http://localhost) can load the preview server. Cert prompts once
    // per session; click "Show Details → Visit Website" to accept.
    // Set HTTP_DEV=1 to skip basicSsl when driving the dev server via
    // automation that can't bypass the cert page (e.g. Chrome DevTools
    // Protocol attachment is blocked on cert-error frames).
    ...(process.env.HTTP_DEV === "1" ? [] : [basicSsl()]),
  ],
  define: {
    APP_VERSION: JSON.stringify(process.env.npm_package_version),
  },
  resolve: {
    // Force a single radiantjs instance across the whole graph (including the
    // linked `radiantswap` package, which otherwise pulls its OWN copy). Without
    // this the code-split /predict chunk bundles a second ~600KB radiantjs copy;
    // deduping also kept the init-order crash class from recurring (fixed
    // upstream in radiantjs 2.0.6, but one shared instance is correct regardless).
    dedupe: ["@radiant-core/radiantjs"],
    alias: {
      "@app": path.resolve(__dirname, "./src"),
      "@lib": path.resolve(__dirname, "../lib/src"),
      // (ReloadPrompt no longer imports the plugin's virtual modules — SW
      // registration is hand-rolled there — so no Capacitor stubs needed.)
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: "globalThis",
      },
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      plugins: [NodeGlobalsPolyfillPlugin({ buffer: true })],
    },
  },
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        // Ensure proper format for Safari compatibility
        inlineDynamicImports: true,
      },
    },
    plugins: () => [
      topLevelAwait({
        promiseExportName: "__tla",
        promiseImportName: (i) => `__tla_${i}`,
      }),
    ],
  },
});
