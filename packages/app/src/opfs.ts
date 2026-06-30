import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

// OPFS (Origin Private File System) backs a local raw-tx cache. It's a
// performance optimisation, not a source of truth, so it must degrade
// gracefully where the API is missing: `navigator.storage.getDirectory` is
// undefined in the iOS WKWebView before 16.4 (and some Android WebViews).
// Without this guard `putTx` would throw an unhandled rejection there and
// stall the sync loop.
function opfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

export async function getTx(txid: string): Promise<string | undefined> {
  if (!opfsAvailable()) return undefined;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("tx", { create: true });
  try {
    const fileHandle = await dir.getFileHandle(txid);
    const buf = await (await fileHandle.getFile()).arrayBuffer();
    console.debug(`OPFS get ${txid}`);
    return bytesToHex(new Uint8Array(buf));
  } catch {
    return undefined;
  }
}

export async function putTx(txid: string, hex: string) {
  if (!opfsAvailable()) return false;
  console.debug(`OPFS put ${txid}`);
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("tx", { create: true });
  const fileHandle = await dir.getFileHandle(txid, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(hexToBytes(hex) as BlobPart);
  await writable.close();
  return true;
}

export async function deleteAll() {
  if (!opfsAvailable()) return;
  const root = await navigator.storage.getDirectory();
  root.removeEntry("tx", { recursive: true });
}

export default { getTx, putTx, deleteAll };
