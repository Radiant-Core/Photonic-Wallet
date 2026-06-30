import { Capacitor } from "@capacitor/core";

/**
 * One-time native-shell initialisation. Called from `main.tsx` after React
 * mounts. No-op on web / Tauri so the same call is safe everywhere.
 *
 * - Tags `<html>` with a `capacitor` class so CSS can opt into safe-area
 *   insets without affecting the web build (see `index.css`).
 * - Styles the status bar to match the app's dark canvas.
 * - Hides the launch splash screen (configured with `launchAutoHide: false`
 *   in `capacitor.config.ts`, so JS controls the dismissal once the UI is up).
 */
export async function initNative(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  document.documentElement.classList.add("capacitor");

  try {
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    // The app canvas is dark (#1a1a24), so we want light status-bar content.
    // In this plugin `Style.Dark` == "light text on a dark background".
    await StatusBar.setStyle({ style: Style.Dark });
    if (Capacitor.getPlatform() === "android") {
      await StatusBar.setBackgroundColor({ color: "#1a1a24" });
      // Keep the bar opaque (not overlaying the WebView) so content isn't
      // clipped under it; the safe-area CSS handles the iOS notch instead.
      await StatusBar.setOverlaysWebView({ overlay: false });
    }
  } catch (err) {
    console.warn("[platform] StatusBar init failed", err);
  }

  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch (err) {
    console.warn("[platform] SplashScreen.hide failed", err);
  }
}
