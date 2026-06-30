import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor configuration for the native iOS / Android builds of Photonic
 * Wallet. The web assets are produced by `vite build` (with `CAP_BUILD=1`, which
 * drops the PWA service worker and injects a WebView-appropriate CSP — see
 * `vite.config.ts`) into `dist`, then copied into the native projects by
 * `cap sync`.
 *
 * Build the native bundle with `pnpm -F @photonic/app build:mobile`.
 */
const config: CapacitorConfig = {
  appId: "org.radiantcore.photonic",
  appName: "Photonic Wallet",
  webDir: "dist",
  // The Vite build uses `base: "./"`, so every asset URL is relative and
  // resolves under the local WebView origin (capacitor://localhost on iOS,
  // http://localhost on Android). No `server.url` is needed for production.
  //
  // For live-reload against a dev server, add a `server` block pointing at your
  // machine, and run the dev server with `HTTP_DEV=1` so Vite drops the
  // canonical web CSP (which lacks the capacitor:// origin and would
  // force-upgrade the http dev URL):
  //   server: { url: "http://<your-lan-ip>:5173", cleartext: true }
  ios: {
    backgroundColor: "#1a1a24",
    contentInset: "automatic",
  },
  android: {
    backgroundColor: "#1a1a24",
  },
  plugins: {
    SplashScreen: {
      // We dismiss the splash from JS (initNative -> SplashScreen.hide) once
      // React has mounted, so the user never sees an empty WebView flash.
      launchShowDuration: 600,
      launchAutoHide: false,
      backgroundColor: "#1a1a24",
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
      splashFullScreen: true,
      splashImmersive: false,
    },
  },
};

export default config;
