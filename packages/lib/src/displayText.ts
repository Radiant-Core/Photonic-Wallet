/**
 * Making untrusted text safe to *show*.
 *
 * A connect request carries strings the wallet did not author - `app`,
 * `origin`, and the challenge itself - and the approval screen renders them so
 * the user can decide what they are agreeing to. That decision is only as good
 * as the rendering.
 *
 * `cleanString` in the connect protocol already rejects C0 control characters
 * and DEL, which stops a request breaking the layout. It does not stop a
 * request **reordering** it. Unicode bidirectional overrides (U+202A-202E,
 * U+2066-2069) change the visual order of the characters that follow, so a
 * crafted `app` or challenge can display as one thing and be signed as
 * another. That is the "Trojan Source" trick, and it needs no invalid UTF-8
 * and no control character to work.
 *
 * So: validate for *acceptance* in the protocol layer, sanitize for *display*
 * here. The two are different jobs and must not be conflated. In particular
 * this module is never applied to a message before signing: the bytes signed
 * are always exactly the bytes the request supplied, and only what is painted
 * on screen is altered - visibly.
 */

/**
 * Characters that can hide or reorder what is rendered.
 *
 *   \u0000-\u001F         C0 controls
 *   \u007F-\u009F         DEL and C1 controls
 *   \u061C                Arabic letter mark
 *   \u200B                zero-width space
 *   \u200E-\u200F         LRM / RLM
 *   \u2028-\u2029         line / paragraph separator
 *   \u202A-\u202E         bidi embeddings and overrides
 *   \u2066-\u2069         bidi isolates
 *   \uFEFF                zero-width no-break space
 *
 * Deliberately NOT included: U+200C ZWNJ and U+200D ZWJ. Both are joiners
 * rather than directional controls - they cannot reorder text - and both are
 * load-bearing in legitimate content, from Devanagari to emoji families (a
 * family emoji is several people joined by ZWJ). Replacing them would corrupt
 * honest app names to defend against an attack they cannot mount.
 */
const UNSAFE_DISPLAY_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B\u200E-\u200F\u2028-\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** True if `text` contains anything that could hide or reorder its rendering. */
export function hasUnsafeDisplayChars(text: string): boolean {
  UNSAFE_DISPLAY_RE.lastIndex = 0;
  return UNSAFE_DISPLAY_RE.test(text);
}

/**
 * Replace every hiding or reordering character with U+FFFD.
 *
 * Replaced rather than stripped, on purpose. Stripping would silently turn a
 * hostile string into a clean-looking one, which fails the user the same way
 * rendering it unchanged does: either way they cannot tell that anything was
 * there. A visible replacement character says "something was removed here"
 * without pretending to explain what.
 */
export function sanitizeForDisplay(text: string): string {
  return text.replace(UNSAFE_DISPLAY_RE, "\uFFFD");
}
