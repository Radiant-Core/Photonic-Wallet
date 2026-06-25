import { useRegisterSW } from "virtual:pwa-register/react";
import { pwaInfo } from "virtual:pwa-info";
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Button,
  useToast,
} from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";

console.log(pwaInfo);

/**
 * Shows a user-facing "Update available" dialog when a new build is detected.
 * The user chooses when to update — we never reload out from under an
 * in-progress action.
 */
function ReloadPrompt() {
  const toast = useToast();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [showUpdate, setShowUpdate] = useState(false);
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

  useEffect(() => {
    setShowUpdate(needRefresh);
  }, [needRefresh]);

  const handleUpdate = () => {
    setShowUpdate(false);
    toast({ status: "info", title: "Updating to the latest version…" });
    updateServiceWorker(true);
  };

  const handleDismiss = () => {
    setShowUpdate(false);
  };

  return (
    <AlertDialog
      isOpen={showUpdate}
      leastDestructiveRef={cancelRef}
      onClose={handleDismiss}
      isCentered
    >
      <AlertDialogOverlay>
        <AlertDialogContent>
          <AlertDialogHeader fontSize="lg" fontWeight="bold">
            Update available
          </AlertDialogHeader>
          <AlertDialogBody>
            A new version of Photonic Wallet is available. Update now to get the
            latest features and fixes.
          </AlertDialogBody>
          <AlertDialogFooter>
            <Button ref={cancelRef} onClick={handleDismiss}>
              Later
            </Button>
            <Button colorScheme="blue" onClick={handleUpdate} ml={3}>
              Update now
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogOverlay>
    </AlertDialog>
  );
}

export default ReloadPrompt;
