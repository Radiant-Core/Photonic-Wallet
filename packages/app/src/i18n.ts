import { i18n } from "@lingui/core";

export async function loadCatalog(locale: string) {
  const catalog = await import(`./locales/${locale}.js`);
  i18n.loadAndActivate({ locale, messages: catalog.messages });
}
