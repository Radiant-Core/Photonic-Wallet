import { useState } from "react";

/**
 * Inert stand-in for `virtual:pwa-register/react`, aliased in for Capacitor
 * builds where the PWA service worker is disabled (see `vite.config.ts`).
 * Returns the same shape `useRegisterSW` does, but never registers a worker or
 * signals an update — native apps update through the App Store / Play Store, so
 * `<ReloadPrompt />` simply renders nothing actionable.
 */
export function useRegisterSW(_options?: {
  immediate?: boolean;
  onRegisteredSW?: (
    swScriptUrl: string,
    registration?: ServiceWorkerRegistration,
  ) => void;
  onRegisterError?: (error: unknown) => void;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
}) {
  return {
    offlineReady: useState(false),
    needRefresh: useState(false),
    updateServiceWorker: async (_reloadPage?: boolean) => {
      /* no service worker in the native build */
    },
  };
}
