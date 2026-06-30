/**
 * Inert stand-in for `virtual:pwa-info`, aliased in for Capacitor builds where
 * the PWA plugin (which normally provides this virtual module) is disabled.
 */
export const pwaInfo: { webManifest?: { href?: string } } | null = null;
