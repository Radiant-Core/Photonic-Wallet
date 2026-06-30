import { Capacitor } from "@capacitor/core";
import { isShareCancel } from "./share";

/**
 * Persist a generated file to the device.
 *
 * - **Native (iOS/Android):** `<a download>` is a no-op inside the WebView, so
 *   we write the bytes to the app's Cache directory with `@capacitor/filesystem`
 *   and then open the OS share sheet (`@capacitor/share`) pointed at that file,
 *   letting the user save it into Files / Drive or send it on.
 * - **Web / Tauri:** the classic Blob + `<a download>` click.
 *
 * `data` may be text (`string`) or binary (`ArrayBuffer` / `Uint8Array`).
 */
export async function saveFile(
  filename: string,
  data: ArrayBuffer | Uint8Array | string,
  mimeType: string,
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await saveFileNative(filename, data);
    return;
  }
  saveFileWeb(filename, data, mimeType);
}

async function saveFileNative(
  filename: string,
  data: ArrayBuffer | Uint8Array | string,
): Promise<void> {
  const { Filesystem, Directory, Encoding } = await import(
    "@capacitor/filesystem"
  );
  const isText = typeof data === "string";
  await Filesystem.writeFile({
    path: filename,
    data: isText ? (data as string) : toBase64(data),
    directory: Directory.Cache,
    // Text is written as UTF-8; binary is base64 (omit encoding => base64).
    ...(isText ? { encoding: Encoding.UTF8 } : {}),
    recursive: true,
  });
  const { uri } = await Filesystem.getUri({
    path: filename,
    directory: Directory.Cache,
  });
  const { Share } = await import("@capacitor/share");
  try {
    await Share.share({
      title: filename,
      url: uri,
      dialogTitle: "Save or share file",
    });
  } catch (err) {
    if (!isShareCancel(err)) throw err;
  } finally {
    // Don't leave a (possibly sensitive, e.g. decrypted) export lingering in
    // the app cache. iOS hands the file content off synchronously during the
    // share, so deleting after Share.share returns is safe. On Android the
    // receiving app may read the FileProvider URI lazily after we return, so we
    // leave the file (app-private, OS-evicted) to avoid truncating that read.
    if (Capacitor.getPlatform() === "ios") {
      await Filesystem.deleteFile({
        path: filename,
        directory: Directory.Cache,
      }).catch(() => {
        /* best-effort cleanup */
      });
    }
  }
}

function saveFileWeb(
  filename: string,
  data: ArrayBuffer | Uint8Array | string,
  mimeType: string,
): void {
  const part: BlobPart =
    typeof data === "string" ? data : (data as BlobPart);
  const blob = new Blob([part], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Base64-encode binary data in chunks (avoids call-stack overflow on large
 *  payloads from `String.fromCharCode(...veryLongArray)`). */
function toBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
