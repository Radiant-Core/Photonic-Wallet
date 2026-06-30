import { Capacitor } from "@capacitor/core";
import jsQR from "jsqr";

/**
 * QR input on native has two paths:
 *
 *  1. The live `@yudiel/react-qr-scanner` (getUserMedia) — primary, works in
 *     the Capacitor WebView once the camera permission strings are present
 *     (iOS `NSCameraUsageDescription`, Android `CAMERA`).
 *  2. This photo fallback — capture or pick a still image via `@capacitor/camera`
 *     and decode it with `jsQR`. Useful when live camera access is denied, the
 *     code is already saved in the photo library, or on older WebViews.
 */

/** True when the still-photo QR fallback is available (native only). */
export function canScanFromPhoto(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Capture/pick a photo and decode a QR code from it.
 * Returns the decoded string, or `null` if the user cancelled or no code was
 * found.
 */
export async function scanQrFromPhoto(): Promise<string | null> {
  const { Camera, CameraResultType, CameraSource } = await import(
    "@capacitor/camera"
  );
  let dataUrl: string | undefined;
  try {
    const photo = await Camera.getPhoto({
      quality: 90,
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt, // user chooses camera or photo library
      correctOrientation: true,
    });
    dataUrl = photo.dataUrl;
  } catch {
    // User cancelled the picker or denied permission.
    return null;
  }
  if (!dataUrl) return null;
  try {
    return await decodeQrFromDataUrl(dataUrl);
  } catch {
    // Image failed to load / decode (corrupt or unsupported) — honor the
    // documented `string | null` contract instead of rejecting.
    return null;
  }
}

async function decodeQrFromDataUrl(dataUrl: string): Promise<string | null> {
  const img = await loadImage(dataUrl);
  // Downscale large camera images before decoding — jsQR is O(pixels) and the
  // code is still legible at ~1024px on the long edge.
  const maxDim = 1024;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const result = jsQR(data, w, h, { inversionAttempts: "attemptBoth" });
  return result?.data ?? null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
