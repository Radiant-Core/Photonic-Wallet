import { i18n } from "@lingui/core";

// Lingui's `compile` command emits CommonJS (`module.exports = { messages:
// JSON.parse("…") }`) and the `compileNamespace: "es"` option is silently
// ignored on the version we depend on. Vite's dev server can't execute CJS
// in the browser — a dynamic `import("./locales/en.js")` throws
// `ReferenceError: module is not defined` and the wallet white-screens.
//
// Workaround: fetch the catalog as raw text, pull the JSON payload out of
// the `JSON.parse("…")` literal via regex, and feed it to lingui. Works
// against both CJS (current) and ESM (future) lingui outputs because both
// embed the same `JSON.parse("…")` literal.
async function fetchCatalogJSON(locale: string): Promise<unknown | null> {
  const url = new URL(`./locales/${locale}.js`, import.meta.url).href;
  let src: string;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`[i18n] catalog fetch failed: ${resp.status} ${url}`);
      return null;
    }
    src = await resp.text();
  } catch (err) {
    console.error(`[i18n] catalog fetch error for ${locale}:`, err);
    return null;
  }
  // Strip Vite's dev-server HMR wrapper if present, then extract the JSON
  // payload. The compiled file ends with `JSON.parse("<escaped json>")};`.
  const match = src.match(/JSON\.parse\((["'`])((?:\\.|(?!\1).)*)\1\)/);
  if (!match) {
    console.error(
      `[i18n] could not locate JSON.parse(...) in catalog for ${locale}; ` +
        "lingui output shape may have changed.",
    );
    return null;
  }
  // Unescape the JSON string literal. The lingui output uses standard JS
  // string-literal escaping; JSON.parse on the literal *and* the inner JSON
  // gives us the messages object directly.
  try {
    const innerJsonStr = JSON.parse(`"${match[2]}"`) as string;
    return JSON.parse(innerJsonStr);
  } catch (err) {
    console.error(`[i18n] JSON.parse failed for ${locale}:`, err);
    return null;
  }
}

export async function loadCatalog(locale: string) {
  const messages = await fetchCatalogJSON(locale);
  if (!messages) {
    console.error(`[i18n] Failed to load messages for locale: ${locale}`);
    return;
  }
  i18n.loadAndActivate({
    locale,
    messages: messages as Record<string, string | string[]>,
  });
}
