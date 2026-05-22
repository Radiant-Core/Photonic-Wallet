import { electrumWorker } from "@app/electrum/Electrum";
import { wallet } from "@app/signals";
import { lockWallet, wipeSecrets } from "@app/wallet";
import { autoLockMs } from "@app/autoLock";
import { useToast } from "@chakra-ui/react";
import { t } from "@lingui/macro";
import { useEffect, useRef, useCallback } from "react";

type Timeout = ReturnType<typeof setTimeout>;
const LOCK_VISIBILITY_GRACE = 30000; // 30 seconds grace period when tab hidden

async function reactivate() {
  if (!(await electrumWorker.value.isActive())) {
    console.debug("Reactivating sync");
    electrumWorker.value.setActive(true);
    electrumWorker.value.syncPending();
  }
}

function deactivate() {
  electrumWorker.value.setActive(false);
  console.debug("Deactivating sync");
}

function armLockTimer(
  timerRef: React.MutableRefObject<Timeout | undefined>,
  toast: ReturnType<typeof useToast>,
  delay: number
) {
  clearTimeout(timerRef.current);
  if (wallet.value.exists && !wallet.value.locked) {
    timerRef.current = setTimeout(() => {
      lockWallet();
      toast({
        title: t`Wallet locked`,
        status: "success",
      });
      deactivate();
    }, delay);
  }
}

export default function useActivityDetector() {
  const toast = useToast();
  const timer = useRef<Timeout>();
  const visibilityTimer = useRef<Timeout>();

  // Read once per effect run — the effect re-mounts whenever `autoLockMs`
  // changes, so a settings update propagates immediately.
  const delay = autoLockMs.value;

  // Reset timer on user activity
  const resetTimer = useCallback(() => {
    clearTimeout(timer.current);
    reactivate();
    armLockTimer(timer, toast, delay);
  }, [toast, delay]);

  // Activity event handlers
  const onMouseMove = useCallback(() => resetTimer(), [resetTimer]);
  const onKeyDown = useCallback(() => resetTimer(), [resetTimer]);
  const onTouchStart = useCallback(() => resetTimer(), [resetTimer]);
  const onPointerDown = useCallback(() => resetTimer(), [resetTimer]);

  const onVisibilityChange = useCallback(() => {
    if (document.visibilityState === "visible") {
      // Tab is active, allow syncing and sync any pending subscriptions
      clearTimeout(visibilityTimer.current);
      reactivate();
      armLockTimer(timer, toast, delay);
    } else {
      // Tab is inactive - set shorter grace period before locking
      clearTimeout(timer.current);
      visibilityTimer.current = setTimeout(() => {
        lockWallet();
        toast({
          title: t`Wallet locked (inactive tab)`,
          status: "success",
        });
        deactivate();
      }, LOCK_VISIBILITY_GRACE);
    }
  }, [toast, delay]);

  const onFocus = useCallback(() => {
    reactivate();
    armLockTimer(timer, toast, delay);
  }, [toast, delay]);

  const onBlur = useCallback(() => {
    deactivate();
  }, []);

  // R4: wipe secret bytes when the tab is torn down so a forensic memory
  // dump after page-close has no recoverable mnemonic/WIF. We can't await
  // anything here — `wipeSecrets` is synchronous and idempotent.
  const onBeforeUnload = useCallback(() => {
    wipeSecrets();
  }, []);

  useEffect(() => {
    // Arm timer immediately on mount if wallet is unlocked
    armLockTimer(timer, toast, delay);

    // Listen for logout broadcasts from other tabs
    let bc: BroadcastChannel | undefined;
    try {
      bc = new BroadcastChannel("photonic-wallet");
      bc.onmessage = (event) => {
        if (event.data?.type === "logout" && !wallet.value.locked) {
          lockWallet();
          toast({
            title: t`Wallet locked (other tab)`,
            status: "success",
          });
          deactivate();
          window.location.reload();
        }
      };
    } catch {
      // BroadcastChannel not supported
    }

    // Add activity listeners
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("touchstart", onTouchStart);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onBeforeUnload);

    return () => {
      clearTimeout(timer.current);
      clearTimeout(visibilityTimer.current);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onBeforeUnload);
      bc?.close();
    };
  }, [
    onMouseMove,
    onKeyDown,
    onTouchStart,
    onPointerDown,
    onVisibilityChange,
    onFocus,
    onBlur,
    onBeforeUnload,
    toast,
    delay,
  ]);
}
