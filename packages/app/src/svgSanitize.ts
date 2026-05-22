/**
 * R13 — SVG sanitisation for mint-time content.
 *
 * SVG is XML and the spec allows `<script>`, `on*` event handlers,
 * `<foreignObject>` (full HTML), and external resource references
 * (`href`/`xlink:href`). If any of those reach a renderer that evaluates
 * them in the page's origin (innerHTML, `<object>`, `<iframe srcdoc>`),
 * the SVG runs JavaScript with full access to the wallet's IndexedDB.
 *
 * The render path is already `<img>`-only (audit done as part of R13
 * verification — see REMEDIATION_PLAN.md), which is safe by browser
 * design. This module is the second half of defence-in-depth: sanitise
 * the bytes *before* they are written on-chain so neither this wallet
 * nor any future renderer (third-party marketplaces, block explorers)
 * has to trust user input.
 *
 * Implementation: DOMPurify with the SVG profile, `IN_PLACE: false`,
 * `RETURN_DOM: false`, no allowed external refs. The sanitised output
 * is serialised back to UTF-8 bytes so the rest of the mint pipeline
 * (hashing, base64 preview, on-chain write) sees a uniform byte
 * stream.
 */
import DOMPurify from "dompurify";

/**
 * Loose check — by SVG-XML structure rather than MIME type, so a file
 * mislabelled as `application/octet-stream` still gets sanitised if the
 * caller routes it through here.
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  // First non-whitespace bytes start with `<svg` or `<?xml` followed
  // eventually by `<svg`. We only need a quick heuristic.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, Math.min(bytes.length, 256))
  );
  // Strip any UTF-8 BOM (charCode 0xFEFF) plus leading whitespace.
  // BOM is removed via charCodeAt check rather than a regex literal so
  // the source file stays ASCII-clean for ESLint.
  let start = 0;
  if (head.length > 0 && head.charCodeAt(0) === 0xfeff) start = 1;
  const trimmed = head.slice(start).trimStart();
  if (trimmed.startsWith("<svg")) return true;
  if (trimmed.startsWith("<?xml")) {
    return /<svg[\s>]/i.test(trimmed);
  }
  return false;
}

/**
 * Sanitise SVG bytes for storage. Returns a new `Uint8Array` whose
 * contents are a safe-to-render SVG with `<script>`, event handlers,
 * `<foreignObject>`, and external resource refs removed.
 *
 * - Input is treated as UTF-8 SVG markup.
 * - Sanitised output is re-encoded as UTF-8 bytes.
 * - If DOMPurify removes everything (i.e. the input was *all* script /
 *   attacker-only payload), this returns a single-byte placeholder
 *   document (`<svg/>`-encoded) rather than zero bytes so downstream
 *   length checks don't trip.
 */
export function sanitizeSvgBytes(bytes: Uint8Array): Uint8Array {
  const svgText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const cleanedText = sanitizeSvgString(svgText);
  return new TextEncoder().encode(cleanedText);
}

/**
 * Pure string sanitiser. Exposed for tests and any caller that already
 * has SVG as a string.
 */
export function sanitizeSvgString(svg: string): string {
  const cleaned = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // Reject elements that can fetch or execute: scripts, iframes,
    // foreign HTML/MathML inside SVG, hyperlinks.
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "foreignObject",
      "audio",
      "video",
      "a",
    ],
    // Strip every `on*` event handler and any external-resource attribute.
    // DOMPurify already strips `on*` by default; we add href/xlink:href
    // because the SVG profile would otherwise keep them on `<image>`,
    // `<use>`, etc., which can fetch remote URLs at render time.
    FORBID_ATTR: ["href", "xlink:href"],
    // No `<html>`/`<body>` wrapping.
    WHOLE_DOCUMENT: false,
    // Don't keep dangerous comments; HTML comments can hide payload that
    // some renderers re-interpret.
    KEEP_CONTENT: false,
  });

  // Defensive fallback: never return empty content — downstream code
  // (hashing, fee estimation) assumes the bytes are non-empty SVG.
  return cleaned.trim().length > 0
    ? cleaned
    : '<svg xmlns="http://www.w3.org/2000/svg"/>';
}
