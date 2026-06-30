/**
 * Platform abstraction layer.
 *
 * Photonic ships as a web app, a Tauri desktop bundle, and (via Capacitor)
 * native iOS / Android apps from the *same* bundle. A handful of browser APIs
 * behave differently — or not at all — inside the Capacitor WebView
 * (clipboard, `<a download>`, Web Share, the live camera). The helpers here
 * route those operations through native Capacitor plugins when running in the
 * native shell and fall back to the standard web APIs everywhere else.
 *
 * Every helper is safe to import and call on the web: `@capacitor/core` has a
 * web implementation of `Capacitor.isNativePlatform()` (returns `false`), and
 * the native-only plugins are loaded with dynamic `import()` *after* that
 * check, so they never enter the web/Tauri chunk graph.
 */
import { Capacitor } from "@capacitor/core";

/** True when running inside the Capacitor native shell (iOS or Android). */
export const isNativePlatform = (): boolean => Capacitor.isNativePlatform();

/** `"ios" | "android" | "web"`. */
export const getPlatform = (): string => Capacitor.getPlatform();

export * from "./native";
export * from "./clipboard";
export * from "./share";
export * from "./saveFile";
export * from "./qr";
