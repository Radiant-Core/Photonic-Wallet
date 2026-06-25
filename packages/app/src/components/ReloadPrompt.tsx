import { useRegisterSW } from "virtual:pwa-register/react";
import { pwaInfo } from "virtual:pwa-info";
import { useToast } from "@chakra-ui/react";
import { useEffect, useRef } from "react";
import { openModal } from "@app/signals";

console.log(pwaInfo);

/**
 * Auto-applies a new app version so users never have to manually clear the
 * service worker / hard-refresh after a deploy. When a new build is detected we
 * activate it (skipWaiting) and reload — but NEVER while a modal is open
 * (send / unlock / receive), so an auto-reload can't drop an in-progress action.
 * If a modal is open we retry shortly. A short initial grace lets a freshly
 * loaded page settle before any reload.
 */
function ReloadPrompt() {
  const toast = useToast();
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.log("SW registration error", error);
    },
  });

  useEffect(() => {
    if (offlineReady) {
      toast({ status: "info", title: "App ready for offline use" });
      setOfflineReady(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineReady]);

  const applied = useRef(false);
  useEffect(() => {
    if (!needRefresh || applied.current) return;
    let timer: ReturnType<typeof setTimeout>;
    const apply = () => {
      if (applied.current) return;
      // Don't reload out from under an open modal — defer until it closes.
      if (openModal.value?.modal) {
        timer = setTimeout(apply, 4000);
        return;
      }
      applied.current = true;
      toast({ status: "info", title: "Updating to the latest version…" });
      updateServiceWorker(true); // skipWaiting + reload to the new build
    };
    timer = setTimeout(apply, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needRefresh]);

  return null;
}

export default ReloadPrompt;
