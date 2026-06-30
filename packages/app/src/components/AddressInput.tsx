import { PropsWithChildren, useState } from "react";
import { Scanner } from "@yudiel/react-qr-scanner";
import { Box, Button, HStack, ModalBody, ModalFooter } from "@chakra-ui/react";
import { canScanFromPhoto, scanQrFromPhoto } from "@app/platform";

export default function AddressInput({
  onScan,
  onClose,
  open,
  children,
}: PropsWithChildren<{
  open: boolean;
  onScan: (value: string) => void;
  onClose: () => void;
}>) {
  const [photoBusy, setPhotoBusy] = useState(false);

  // Native fallback: when the live camera scanner is denied/unavailable, let
  // the user pick or snap a still photo of the QR and decode it (jsQR).
  const scanFromPhoto = async () => {
    setPhotoBusy(true);
    try {
      const value = await scanQrFromPhoto();
      if (value) onScan(value);
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <>
      {open && (
        <>
          <ModalBody>
            <Box w="100%" aspectRatio={1}>
              <Scanner onScan={(codes) => onScan(codes[0].rawValue)} />
            </Box>
          </ModalBody>
          <ModalFooter>
            <HStack spacing={3}>
              {canScanFromPhoto() && (
                <Button onClick={scanFromPhoto} isLoading={photoBusy}>
                  {"Scan from photo"}
                </Button>
              )}
              <Button onClick={() => onClose()}>{"Close"}</Button>
            </HStack>
          </ModalFooter>
        </>
      )}
      {children}
    </>
  );
}
