import { Button, ButtonProps } from "@chakra-ui/react";
import { saveFile } from "@app/platform";

export default function DownloadLink({
  children,
  data,
  filename,
  mimeType,
  ...rest
}: {
  data: ArrayBuffer | Uint8Array;
  filename: string;
  mimeType: string;
} & ButtonProps) {
  // saveFile handles the platform split: a Blob + `<a download>` on web/Tauri,
  // and a Filesystem write + share sheet inside the Capacitor WebView (where
  // `<a download>` is a no-op).
  const download = () => {
    void saveFile(filename, data, mimeType);
  };

  return (
    <Button onClick={download} {...rest}>
      {children || "Download"}
    </Button>
  );
}
