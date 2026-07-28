import { useToast } from "@chakra-ui/react";
import { useEffect, useRef } from "react";

/**
 * Service-worker registration + auto-applied updates.
 *
 * Hand-rolled instead of `virtual:pwa-register/react`: vite-plugin-pwa's
 * prompt-mode client installs an UNCONDITIONAL `window.location.reload()`
 * on the workbox "controlling" event as soon as a new SW reaches "waiting"
 * (verified against dist/client/build/register.js in 0.17.5), which defeats
 * any app-level guard and can reload mid-send. `injectRegister: null` in
 * vite.config.ts keeps the plugin from injecting its own registration.
 *
 * The generated SW is built with `skipWaiting: true` + `clientsClaim: true`,
 * so a new build activates on its own moments after install — required to
 * rescue clients stuck on a white screen, where no app code runs to approve
 * an update. This component handles the page side:
 *  - register sw.js; toast "ready for offline use" once the first install
 *    finishes precaching;
 *  - nudge any old-style waiting SW (built before skipWaiting shipped) with
 *    SKIP_WAITING;
 *  - when a new SW takes control (`controllerchange`) reload onto the new
 *    bundle — but NEVER while a modal is open (send / unlock / receive), so
 *    an auto-reload can't drop an in-progress action; retry shortly instead.
 *    A short grace lets a freshly loaded page settle first;
 *  - re-check for updates hourly so long-lived tabs don't linger on builds
 *    whose lazy chunks a later deploy will delete.
 *
 * The initial `controllerchange` fired by clientsClaim claiming a fresh,
 * previously-uncontrolled page is NOT an update — reloading there would
 * bounce every first-time visitor (tracked via `hadController`).
 */

const UPDATE_CHECK_MS = 60 * 60 * 1000;

// "Is the user mid-action?" — Chakra renders every open Modal / AlertDialog /
// Drawer with .chakra-modal__content, and removes it on close. This is the
// reliable signal: `[role=dialog]` alone is too broad (popovers carry it while
// closed), and the `openModal` signal can NOT be used — useModalSignal
// consumes it (resets to {}) the instant the modal component opens its
// disclosure, so it never reflects "a modal is currently open".
const modalIsOpen = () => !!document.querySelector(".chakra-modal__content");

function ReloadPrompt() {
  const toast = useToast();
  const reloading = useRef(false);

  useEffect(() => {
    // Capacitor/Tauri builds ship no sw.js; non-secure contexts can't
    // register one. Bail quietly everywhere the PWA isn't in play.
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:" && location.protocol !== "http:")
      return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let hadController = !!navigator.serviceWorker.controller;

    const reloadWhenSafe = () => {
      if (cancelled || reloading.current) return;
      // Don't reload out from under an open modal — defer until it closes.
      if (modalIsOpen()) {
        timer = setTimeout(reloadWhenSafe, 4000);
        return;
      }
      reloading.current = true;
      toast({ status: "info", title: "Updating to the latest version…" });
      timer = setTimeout(() => window.location.reload(), 500);
    };

    const onControllerChange = () => {
      if (!hadController) {
        hadController = true;
        return;
      }
      timer = setTimeout(reloadWhenSafe, 2000);
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange
    );

    navigator.serviceWorker
      .register("./sw.js")
      .then((registration) => {
        if (cancelled) return;

        // First install: precache finishing means the app now works offline.
        if (!navigator.serviceWorker.controller) {
          const fresh = registration.installing ?? registration.waiting;
          fresh?.addEventListener("statechange", () => {
            if (fresh.state === "activated" && !cancelled)
              toast({ status: "info", title: "App ready for offline use" });
          });
        }

        const nudge = (sw: ServiceWorker | null) =>
          sw?.postMessage({ type: "SKIP_WAITING" });

        // A waiting SW from a build without baked-in skipWaiting.
        nudge(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          installing?.addEventListener("statechange", () => {
            if (installing.state === "installed") nudge(registration.waiting);
          });
        });

        interval = setInterval(() => {
          registration.update().catch(() => {
            /* offline — try again next tick */
          });
        }, UPDATE_CHECK_MS);
      })
      .catch((error) => {
        console.log("SW registration error", error);
      });

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange
      );
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
    };
  }, []);

  return null;
}

export default ReloadPrompt;
