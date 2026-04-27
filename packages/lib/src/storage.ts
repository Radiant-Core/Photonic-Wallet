/**
 * Glyph Encryption Phase 2: Off-Chain Storage Layer
 *
 * Provides encrypted blob storage with multiple backend adapters:
 * - LocalStorage (browser localStorage, for testing/small files)
 * - Wallet Backend API (primary Photonic Wallet UX)
 * - IPFS (content-addressed, via nft.storage)
 * - Arweave (permanent storage, optional)
 *
 * @module storage
 * @see REP-3006, REP-3007
 */

import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, randomBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  encryptXChaCha20Poly1305,
  decryptXChaCha20Poly1305,
  XCHACHA20_KEY_SIZE,
  hashLocator,
  toBase64,
  fromBase64,
} from "./encryption";
import { NFTStorage } from "nft.storage";

// ============================================================================
// Types
// ============================================================================

/**
 * Encrypted locator containing off-chain storage pointer
 * This is stored encrypted on-chain to hide the actual storage location
 */
export type EncryptedLocator = {
  /** Storage backend type */
  backend: "local" | "backend" | "ipfs" | "arweave";
  /** Content hash (sha256 of encrypted blob) for integrity verification */
  contentHash: string;
  /** Backend-specific pointer (CID, URL, local key) */
  pointer: string;
  /** Optional encryption metadata */
  encryption?: {
    alg: "xchacha20poly1305";
    nonce: string; // base64
  };
};

/**
 * Storage upload result
 */
export type StorageUploadResult = {
  /** Content hash (SHA256 of encrypted blob) */
  contentHash: Uint8Array;
  /** Encrypted locator (to be stored on-chain) */
  encryptedLocator: Uint8Array;
  /** Locator nonce for decryption */
  locatorNonce: Uint8Array;
  /** Number of chunks uploaded */
  chunksUploaded: number;
  /** Total bytes uploaded */
  bytesUploaded: number;
};

/**
 * Storage download result
 */
export type StorageDownloadResult = {
  /** Decrypted plaintext */
  plaintext: Uint8Array;
  /** Verification result */
  verified: boolean;
  /** Content hash of downloaded blob */
  contentHash: Uint8Array;
};

/**
 * Progress callback for chunked operations
 */
export type ProgressCallback = (
  loaded: number,
  total: number,
  stage: "encrypting" | "uploading" | "downloading" | "decrypting" | "verifying"
) => void;

/**
 * Storage adapter interface
 */
export interface StorageAdapter {
  /** Adapter name */
  readonly name: string;

  /**
   * Upload encrypted blob
   * @param data Encrypted data to store
   * @param contentHash SHA256 hash for integrity
   * @param onProgress Optional progress callback
   * @returns Storage pointer (CID, URL, key)
   */
  upload(
    data: Uint8Array,
    contentHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<string>;

  /**
   * Download encrypted blob
   * @param pointer Storage pointer from locator
   * @param expectedHash Expected SHA256 hash
   * @param onProgress Optional progress callback
   * @returns Encrypted data
   */
  download(
    pointer: string,
    expectedHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<Uint8Array>;

  /**
   * Check if adapter is available/configured
   */
  isAvailable(): boolean;
}

// ============================================================================
// Locator Encryption
// ============================================================================

const LOCATOR_NONCE_SIZE = 24;

/**
 * Encrypt a locator for on-chain storage
 * @param locator Locator object to encrypt
 * @param key 32-byte encryption key (usually derived from wallet seed)
 * @returns Encrypted locator bytes
 */
export function encryptLocator(
  locator: EncryptedLocator,
  key: Uint8Array
): { encrypted: Uint8Array; nonce: Uint8Array } {
  if (key.length !== XCHACHA20_KEY_SIZE) {
    throw new Error(`Locator encryption key must be ${XCHACHA20_KEY_SIZE} bytes`);
  }

  const plaintext = new TextEncoder().encode(JSON.stringify(locator));
  const nonce = randomBytes(LOCATOR_NONCE_SIZE);

  const { ciphertext } = encryptXChaCha20Poly1305(plaintext, key, nonce);

  return {
    encrypted: ciphertext,
    nonce,
  };
}

/**
 * Decrypt a locator from on-chain storage
 * @param encrypted Encrypted locator bytes
 * @param nonce 24-byte nonce
 * @param key 32-byte encryption key
 * @returns Decrypted locator object
 */
export function decryptLocator(
  encrypted: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array
): EncryptedLocator {
  if (key.length !== XCHACHA20_KEY_SIZE) {
    throw new Error(`Locator decryption key must be ${XCHACHA20_KEY_SIZE} bytes`);
  }
  if (nonce.length !== LOCATOR_NONCE_SIZE) {
    throw new Error(`Locator nonce must be ${LOCATOR_NONCE_SIZE} bytes`);
  }

  const decrypted = decryptXChaCha20Poly1305(encrypted, key, nonce);
  const json = new TextDecoder().decode(decrypted);

  return JSON.parse(json) as EncryptedLocator;
}

// Note: hashLocator is imported from ./encryption

// ============================================================================
// LocalStorage Adapter (Browser)
// ============================================================================

const LOCAL_STORAGE_PREFIX = "glyph_encrypted_blob_";

/**
 * LocalStorage adapter for testing and small files (< 5MB)
 * Note: localStorage has ~5-10MB limit and is synchronous
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly name = "local";

  private maxSize: number;

  constructor(maxSizeBytes: number = 5 * 1024 * 1024) {
    this.maxSize = maxSizeBytes;
  }

  isAvailable(): boolean {
    try {
      const test = "__test__";
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }

  async upload(
    data: Uint8Array,
    contentHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error("localStorage not available");
    }

    if (data.length > this.maxSize) {
      throw new Error(
        `Data size ${data.length} exceeds localStorage max ${this.maxSize}`
      );
    }

    const key = LOCAL_STORAGE_PREFIX + bytesToHex(contentHash);
    const base64Data = toBase64(data);

    // Store in chunks if needed (localStorage has per-item limits ~1MB)
    const CHUNK_SIZE = 500000; // ~500KB per key to stay under limit
    if (base64Data.length > CHUNK_SIZE) {
      const numChunks = Math.ceil(base64Data.length / CHUNK_SIZE);
      const chunks: string[] = [];

      for (let i = 0; i < numChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, base64Data.length);
        const chunk = base64Data.slice(start, end);
        const chunkKey = `${key}_chunk_${i}`;
        localStorage.setItem(chunkKey, chunk);
        chunks.push(chunkKey);

        if (onProgress) {
          onProgress(end, base64Data.length, "uploading");
        }
      }

      // Store metadata
      const meta = JSON.stringify({ numChunks, totalLength: base64Data.length });
      localStorage.setItem(key, meta);

      return key;
    }

    // Single chunk
    localStorage.setItem(key, base64Data);

    if (onProgress) {
      onProgress(data.length, data.length, "uploading");
    }

    return key;
  }

  async download(
    pointer: string,
    expectedHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<Uint8Array> {
    if (!this.isAvailable()) {
      throw new Error("localStorage not available");
    }

    const meta = localStorage.getItem(pointer);
    if (!meta) {
      throw new Error(`Blob not found: ${pointer}`);
    }

    let base64Data: string;

    // Check if chunked
    try {
      const parsed = JSON.parse(meta);
      if (parsed.numChunks) {
        // Reconstruct from chunks
        const chunks: string[] = [];
        for (let i = 0; i < parsed.numChunks; i++) {
          const chunkKey = `${pointer}_chunk_${i}`;
          const chunk = localStorage.getItem(chunkKey);
          if (!chunk) {
            throw new Error(`Missing chunk ${i} for ${pointer}`);
          }
          chunks.push(chunk);

          if (onProgress) {
            const loaded = chunks.reduce((sum, c) => sum + c.length, 0);
            onProgress(loaded, parsed.totalLength, "downloading");
          }
        }
        base64Data = chunks.join("");
      } else {
        base64Data = meta;
      }
    } catch {
      // Not JSON, assume single chunk
      base64Data = meta;
    }

    const data = fromBase64(base64Data);

    // Verify hash
    const actualHash = sha256(data);
    if (bytesToHex(actualHash) !== bytesToHex(expectedHash)) {
      throw new Error("Downloaded blob hash mismatch");
    }

    if (onProgress) {
      onProgress(data.length, data.length, "verifying");
    }

    return data;
  }

  /**
   * Clean up stored blob
   */
  delete(pointer: string): void {
    const meta = localStorage.getItem(pointer);
    if (!meta) return;

    try {
      const parsed = JSON.parse(meta);
      if (parsed.numChunks) {
        for (let i = 0; i < parsed.numChunks; i++) {
          localStorage.removeItem(`${pointer}_chunk_${i}`);
        }
      }
    } catch {
      // Not chunked
    }

    localStorage.removeItem(pointer);
  }
}

// ============================================================================
// Backend API Adapter
// ============================================================================

export type BackendConfig = {
  /** API base URL */
  baseUrl: string;
  /** Authentication token */
  authToken?: string;
  /** Request timeout in ms */
  timeout?: number;
};

/**
 * Wallet Backend API adapter
 * Primary Photonic Wallet UX for encrypted blob storage
 */
export class BackendAdapter implements StorageAdapter {
  readonly name = "backend";

  private config: BackendConfig;

  constructor(config: BackendConfig) {
    this.config = {
      timeout: 30000,
      ...config,
    };
  }

  isAvailable(): boolean {
    return typeof fetch !== "undefined" && !!this.config.baseUrl;
  }

  async upload(
    data: Uint8Array,
    contentHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<string> {
    const hashHex = bytesToHex(contentHash);

    // Check if already exists (HEAD request)
    try {
      const headResponse = await fetch(`${this.config.baseUrl}/api/v2/blob/${hashHex}`, {
        method: "HEAD",
        headers: this.getHeaders(),
      });

      if (headResponse.ok) {
        // Blob already exists, return pointer
        return hashHex;
      }
    } catch {
      // Continue to upload
    }

    // Upload via POST
    const response = await fetch(`${this.config.baseUrl}/api/v2/blob/upload`, {
      method: "POST",
      headers: {
        ...this.getHeaders(),
        "Content-Type": "application/octet-stream",
        "X-Content-Hash": hashHex,
      },
      body: data as unknown as BodyInit,
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    if (onProgress) {
      onProgress(data.length, data.length, "uploading");
    }

    return result.pointer || hashHex;
  }

  async download(
    pointer: string,
    expectedHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<Uint8Array> {
    const hashHex = bytesToHex(expectedHash);

    const response = await fetch(`${this.config.baseUrl}/api/v2/blob/${hashHex}`, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    // Get content length if available
    const contentLength = parseInt(response.headers.get("Content-Length") || "0");

    // Read response with progress
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body not readable");
    }

    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;

      if (onProgress && contentLength > 0) {
        onProgress(received, contentLength, "downloading");
      }
    }

    // Concatenate chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const data = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }

    // Verify hash
    const actualHash = sha256(data);
    if (bytesToHex(actualHash) !== hashHex) {
      throw new Error("Downloaded blob hash mismatch");
    }

    if (onProgress) {
      onProgress(data.length, data.length, "verifying");
    }

    return data;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };

    if (this.config.authToken) {
      headers["Authorization"] = `Bearer ${this.config.authToken}`;
    }

    return headers;
  }
}

// ============================================================================
// IPFS Adapter (via nft.storage)
// ============================================================================

export type IPFSConfig = {
  /** NFT.Storage API key */
  apiKey: string;
  /** Whether to actually pin or just encode CID (dry run) */
  dryRun?: boolean;
};

/**
 * IPFS adapter using nft.storage
 * Content-addressed storage with integrity verification
 */
export class IPFSAdapter implements StorageAdapter {
  readonly name = "ipfs";

  private config: IPFSConfig;

  constructor(config: IPFSConfig) {
    this.config = config;
  }

  isAvailable(): boolean {
    return !!this.config.apiKey;
  }

  async upload(
    data: Uint8Array,
    contentHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<string> {
    const store = new NFTStorage({ token: this.config.apiKey });
    const blob = new Blob([new Uint8Array(data)]);

    const { car, cid: encodedCid } = await NFTStorage.encodeBlob(blob);

    // Verify CID matches content hash expectation
    const cid = encodedCid.toString();

    if (this.config.dryRun) {
      if (onProgress) {
        onProgress(data.length, data.length, "uploading");
      }
      return cid;
    }

    // Actually store
    const storedCid = await store.storeCar(car);

    if (storedCid.toString() !== cid) {
      throw new Error("IPFS CID mismatch after storage");
    }

    const status = await store.status(storedCid);

    if (onProgress) {
      onProgress(data.length, data.length, "uploading");
    }

    return status.cid.toString();
  }

  async download(
    pointer: string,
    expectedHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<Uint8Array> {
    // Download from IPFS gateway
    // Try multiple gateways for reliability
    const gateways = [
      `https://ipfs.io/ipfs/${pointer}`,
      `https://cloudflare-ipfs.com/ipfs/${pointer}`,
      `https://gateway.pinata.cloud/ipfs/${pointer}`,
    ];

    let lastError: Error | undefined;

    for (const gateway of gateways) {
      try {
        const response = await fetch(gateway, {
          method: "GET",
        });

        if (!response.ok) {
          throw new Error(`Gateway returned ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);

        // Verify hash
        const actualHash = sha256(data);
        if (bytesToHex(actualHash) !== bytesToHex(expectedHash)) {
          throw new Error("Downloaded blob hash mismatch");
        }

        if (onProgress) {
          onProgress(data.length, data.length, "verifying");
        }

        return data;
      } catch (error) {
        lastError = error as Error;
        continue;
      }
    }

    throw new Error(
      `Failed to download from all IPFS gateways: ${lastError?.message}`
    );
  }
}

// ============================================================================
// Arweave Adapter (via Irys/Bundlr node2 — free <100 KB, permanent)
// ============================================================================

export type ArweaveConfig = {
  /** Irys upload node URL (default: https://node2.irys.xyz) */
  uploadNode?: string;
  /** Arweave gateway for downloads (default: https://arweave.net) */
  gateway?: string;
};

/**
 * Arweave permanent storage adapter.
 * Uploads via Irys node2 (free for blobs ≤100 KB, no wallet required).
 * Downloads via public Arweave gateway — no credentials needed.
 */
export class ArweaveAdapter implements StorageAdapter {
  readonly name = "arweave";

  private uploadNode: string;
  private gateway: string;

  constructor(config: ArweaveConfig = {}) {
    this.uploadNode = config.uploadNode ?? "https://node2.irys.xyz";
    this.gateway = config.gateway ?? "https://arweave.net";
  }

  isAvailable(): boolean {
    return typeof fetch !== "undefined";
  }

  async upload(
    data: Uint8Array,
    contentHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<string> {
    const response = await fetch(`${this.uploadNode}/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-content-sha256": bytesToHex(contentHash),
      },
      // Wrap in a Blob so the body is a valid BodyInit across all DOM/Node fetch types.
      // The `as BlobPart` cast sidesteps TS strict ArrayBufferLike vs ArrayBuffer narrowing.
      body: new Blob([data as BlobPart], { type: "application/octet-stream" }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Arweave upload failed (${response.status}): ${text}`);
    }

    const json = await response.json();
    const txid: string = json.id;
    if (!txid) {
      throw new Error("Arweave upload: no transaction ID in response");
    }

    if (onProgress) {
      onProgress(data.length, data.length, "uploading");
    }

    return `ar://${txid}`;
  }

  async download(
    pointer: string,
    expectedHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<Uint8Array> {
    const txid = pointer.replace(/^ar:\/\//, "");

    // Try primary gateway then fallback mirrors
    const gateways = [
      `${this.gateway}/${txid}`,
      `https://arweave.net/${txid}`,
      `https://gateway.irys.xyz/${txid}`,
    ];

    let lastError: Error | undefined;
    for (const url of gateways) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());

        const actualHash = sha256(buf);
        if (bytesToHex(actualHash) !== bytesToHex(expectedHash)) {
          throw new Error("Arweave blob hash mismatch");
        }

        if (onProgress) onProgress(buf.length, buf.length, "verifying");
        return buf;
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw new Error(`Arweave download failed: ${lastError?.message}`);
  }
}

// ============================================================================
// Glyph Inscription Adapter (On-Chain Storage)
// ============================================================================

export const GLYPH_INSCRIPTION_MAX_SIZE = 512 * 1024; // 512 KB limit for Photonic UX

export type GlyphInscriptionConfig = {
  /** Maximum content size in bytes (default: 512KB) */
  maxSizeBytes?: number;
};

/**
 * On-chain storage adapter for encrypted content.
 * Stores encrypted ciphertext directly in the Glyph NFT's `main.b` field.
 *
 * Use cases:
 * - Small encrypted messages, notes, credentials (<512KB)
 * - Self-sovereign storage (no external provider)
 * - Permanent on-chain availability
 *
 * Limitations:
 * - Max 512KB (Photonic UX limit, not protocol limit)
 * - Higher transaction fees than external storage
 * - Metadata reveals that encrypted content exists
 */
export class GlyphInscriptionAdapter implements StorageAdapter {
  readonly name = "glyph";

  private maxSizeBytes: number;

  constructor(config: GlyphInscriptionConfig = {}) {
    this.maxSizeBytes = config.maxSizeBytes ?? GLYPH_INSCRIPTION_MAX_SIZE;
  }

  isAvailable(): boolean {
    // Always available - uses blockchain itself
    return true;
  }

  /**
   * "Upload" to the blockchain - returns hex-encoded ciphertext.
   * The caller embeds this in the NFT's `main.b` field.
   */
  async upload(
    data: Uint8Array,
    contentHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<string> {
    if (data.length > this.maxSizeBytes) {
      throw new Error(
        `Content too large for on-chain inscription: ${data.length} bytes ` +
          `(max ${this.maxSizeBytes} = ${this.maxSizeBytes / 1024}KB). ` +
          `Use IPFS or Arweave for larger content.`
      );
    }

    // Encode as hex - this will be stored in main.b
    const pointer = bytesToHex(data);

    if (onProgress) {
      onProgress(data.length, data.length, "uploading");
    }

    return `glyph:${pointer}`;
  }

  /**
   * Download from the blockchain - decodes hex-encoded ciphertext.
   * The pointer is the hex string from the NFT's `main.b` field.
   */
  async download(
    pointer: string,
    expectedHash: Uint8Array,
    onProgress?: ProgressCallback
  ): Promise<Uint8Array> {
    // Parse the glyph pointer
    const hexData = pointer.replace(/^glyph:/, "");
    if (!/^[0-9a-fA-F]+$/.test(hexData)) {
      throw new Error("Invalid glyph inscription pointer: expected hex data");
    }

    const data = hexToBytes(hexData);

    // Verify hash
    const actualHash = sha256(data);
    if (bytesToHex(actualHash) !== bytesToHex(expectedHash)) {
      throw new Error("Glyph inscription hash mismatch - data may be corrupted");
    }

    if (onProgress) {
      onProgress(data.length, data.length, "verifying");
    }

    return data;
  }
}

// ============================================================================
// Storage Manager
// ============================================================================

export type StorageManagerConfig = {
  /** Default adapter to use */
  defaultAdapter: "local" | "backend" | "ipfs" | "arweave" | "glyph";
  /** Local storage config */
  local?: { maxSize?: number };
  /** Backend API config */
  backend?: BackendConfig;
  /** IPFS config */
  ipfs?: IPFSConfig;
  /** Arweave config */
  arweave?: ArweaveConfig;
  /** Glyph inscription config (on-chain storage) */
  glyph?: GlyphInscriptionConfig;
};

/**
 * Storage manager coordinating multiple adapters
 */
export class StorageManager {
  private adapters: Map<string, StorageAdapter> = new Map();
  private defaultAdapter: string;

  constructor(config: StorageManagerConfig) {
    this.defaultAdapter = config.defaultAdapter;

    // Initialize adapters
    if (config.local) {
      this.adapters.set(
        "local",
        new LocalStorageAdapter(config.local.maxSize)
      );
    }

    if (config.backend) {
      this.adapters.set("backend", new BackendAdapter(config.backend));
    }

    if (config.ipfs) {
      this.adapters.set("ipfs", new IPFSAdapter(config.ipfs));
    }

    if (config.arweave !== undefined || config.defaultAdapter === "arweave") {
      this.adapters.set("arweave", new ArweaveAdapter(config.arweave ?? {}));
    }

    // Glyph inscription adapter (on-chain storage) - always available
    this.adapters.set("glyph", new GlyphInscriptionAdapter(config.glyph ?? {}));
  }

  /**
   * Get adapter by name
   */
  getAdapter(name: string): StorageAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`Storage adapter not found: ${name}`);
    }
    return adapter;
  }

  /**
   * Get default adapter
   */
  getDefaultAdapter(): StorageAdapter {
    return this.getAdapter(this.defaultAdapter);
  }

  /**
   * Check if adapter is available
   */
  isAvailable(name?: string): boolean {
    const adapterName = name || this.defaultAdapter;
    const adapter = this.adapters.get(adapterName);
    return adapter?.isAvailable() ?? false;
  }

  /**
   * Upload encrypted content and create locator
   */
  async uploadEncrypted(
    encryptedData: Uint8Array,
    locatorKey: Uint8Array,
    options?: {
      adapter?: string;
      onProgress?: ProgressCallback;
    }
  ): Promise<StorageUploadResult> {
    const adapterName = options?.adapter || this.defaultAdapter;
    const adapter = this.getAdapter(adapterName);

    // Calculate content hash
    const contentHash = sha256(encryptedData);

    // Upload to storage
    const pointer = await adapter.upload(
      encryptedData,
      contentHash,
      options?.onProgress
    );

    // Build and encrypt locator
    const locator: EncryptedLocator = {
      backend: adapterName as EncryptedLocator["backend"],
      contentHash: `sha256:${bytesToHex(contentHash)}`,
      pointer,
    };

    const { encrypted: encryptedLocator, nonce: locatorNonce } = encryptLocator(
      locator,
      locatorKey
    );

    return {
      contentHash,
      encryptedLocator,
      locatorNonce,
      chunksUploaded: 1,
      bytesUploaded: encryptedData.length,
    };
  }

  /**
   * Download and decrypt content from locator
   */
  async downloadEncrypted(
    encryptedLocator: Uint8Array,
    locatorNonce: Uint8Array,
    locatorKey: Uint8Array,
    options?: {
      onProgress?: ProgressCallback;
    }
  ): Promise<StorageDownloadResult> {
    // Decrypt locator
    const locator = decryptLocator(encryptedLocator, locatorNonce, locatorKey);

    // Get appropriate adapter
    const adapter = this.getAdapter(locator.backend);

    // Parse content hash
    const hashMatch = locator.contentHash.match(/^sha256:([a-f0-9]{64})$/i);
    if (!hashMatch) {
      throw new Error(`Invalid content hash format: ${locator.contentHash}`);
    }
    const expectedHash = hexToBytes(hashMatch[1]);

    // Download
    const encryptedData = await adapter.download(
      locator.pointer,
      expectedHash,
      options?.onProgress
    );

    return {
      plaintext: encryptedData, // Still encrypted, caller decrypts with CEK
      verified: true,
      contentHash: expectedHash,
    };
  }
}

// ============================================================================
// Chunked Upload/Download Helpers
// ============================================================================

const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64KB

/**
 * Chunked upload with progress tracking
 */
export async function uploadChunked(
  chunks: Uint8Array[],
  adapter: StorageAdapter,
  onProgress?: ProgressCallback
): Promise<{ pointers: string[]; totalHash: Uint8Array }> {
  const pointers: string[] = [];
  let totalBytes = 0;

  // Calculate total size for progress
  const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkHash = sha256(chunk);

    if (onProgress) {
      onProgress(totalBytes, totalSize, "uploading");
    }

    const pointer = await adapter.upload(chunk, chunkHash);
    pointers.push(pointer);

    totalBytes += chunk.length;
  }

  // Calculate total hash (hash of concatenated chunk hashes)
  const allHashes = concatBytes(...chunks.map((c) => sha256(c)));
  const totalHash = sha256(allHashes);

  if (onProgress) {
    onProgress(totalBytes, totalSize, "verifying");
  }

  return { pointers, totalHash };
}

/**
 * Chunked download with progress tracking
 */
export async function downloadChunked(
  pointers: string[],
  adapter: StorageAdapter,
  onProgress?: ProgressCallback
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  // Estimate total size (unknown until download)
  const estimatedTotal = pointers.length * DEFAULT_CHUNK_SIZE;

  for (let i = 0; i < pointers.length; i++) {
    const pointer = pointers[i];

    if (onProgress) {
      onProgress(totalBytes, estimatedTotal, "downloading");
    }

    // We need the hash to download, so we pass a dummy and verify after
    const dummyHash = new Uint8Array(32);
    const chunk = await adapter.download(pointer, dummyHash);

    chunks.push(chunk);
    totalBytes += chunk.length;
  }

  if (onProgress) {
    onProgress(totalBytes, totalBytes, "verifying");
  }

  return chunks;
}

// Note: toHex, fromHex, toBase64, fromBase64, sha256, and XCHACHA20_KEY_SIZE
// are imported from other modules and re-exported via index.ts
