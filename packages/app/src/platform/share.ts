import { Capacitor } from "@capacitor/core";

export interface ShareTextOptions {
  title?: string;
  text: string;
  /** iOS/Android share-sheet title. */
  dialogTitle?: string;
}

/**
 * True when *some* share mechanism exists: the native plugin on iOS/Android,
 * or the Web Share API in a supporting browser. Use this to gate share UI.
 */
export function canShare(): boolean {
  return Capacitor.isNativePlatform() || typeof navigator.share === "function";
}

/**
 * Share plain text via the OS share sheet (`@capacitor/share` on native,
 * `navigator.share` on the web). No-op if neither is available.
 */
/**
 * True if `err` is the "user dismissed the share sheet" signal rather than a
 * real failure. `@capacitor/share` throws an error whose message contains
 * "canceled"; the Web Share API throws a DOMException named "AbortError".
 * Callers treat this as a no-op, not an error.
 */
export function isShareCancel(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException) {
    return err.name === "AbortError";
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /cancel/i.test(msg);
}

export async function shareText(opts: ShareTextOptions): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Share } = await import("@capacitor/share");
      await Share.share({
        title: opts.title,
        text: opts.text,
        dialogTitle: opts.dialogTitle,
      });
      return;
    }
    if (typeof navigator.share === "function") {
      await navigator.share({ title: opts.title, text: opts.text });
    }
  } catch (err) {
    // Dismissing the share sheet is not an error.
    if (!isShareCancel(err)) throw err;
  }
}
