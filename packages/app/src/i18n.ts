import { i18n } from "@lingui/core";

export async function loadCatalog(locale: string) {
  const catalog = await import(`./locales/${locale}.js`);
  // Handle both ESM and CommonJS module formats
  // When using dynamic import() on CommonJS modules, exports are wrapped in 'default'
  const messages = catalog.messages ?? catalog.default?.messages;
  if (!messages) {
    console.error(`[i18n] Failed to load messages for locale: ${locale}`, catalog);
    return;
  }
  i18n.loadAndActivate({ locale, messages });
}
