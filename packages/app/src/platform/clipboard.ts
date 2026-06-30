import { Capacitor } from "@capacitor/core";

/**
 * Copy `text` to the clipboard.
 *
 * Inside the Capacitor WebView the Async Clipboard API is unreliable (iOS
 * WKWebView gates `writeText` behind a user gesture and frequently rejects),
 * so we go through `@capacitor/clipboard` on native. On the web we use
 * `navigator.clipboard` and fall back to a legacy `execCommand` path for
 * insecure contexts / old WebViews.
 */
export async function copyText(text: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Clipboard } = await import("@capacitor/clipboard");
    await Clipboard.write({ string: text });
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  legacyCopy(text);
}

/**
 * Read text from the clipboard, or `null` if the clipboard is unavailable /
 * the read was denied. Use this when you need to distinguish "couldn't read"
 * from "read an empty string".
 */
export async function readTextOrNull(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Clipboard } = await import("@capacitor/clipboard");
      const { value, type } = await Clipboard.read();
      // Only surface textual payloads; ignore copied images etc.
      return !type || type.startsWith("text") ? value ?? "" : null;
    } catch {
      return null;
    }
  }
  if (!navigator.clipboard?.readText) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/**
 * Read text from the clipboard. Returns `""` when unavailable or denied
 * (so callers never have to try/catch).
 */
export async function readText(): Promise<string> {
  return (await readTextOrNull()) ?? "";
}

function legacyCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* nothing more we can do */
  } finally {
    document.body.removeChild(ta);
  }
}
