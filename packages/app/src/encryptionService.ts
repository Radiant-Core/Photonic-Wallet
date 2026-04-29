/**
 * Encryption Service for UI Integration (Phase 3)
 *
 * High-level service for encrypting content, managing storage,
 * and creating encrypted NFT metadata.
 *
 * @module encryptionService
 */

import {
  encryptChunked,
  decryptChunked,
  wrapCEK,
  unwrapCEK,
  deriveKeyScrypt,
  deriveKeyHKDF,
  buildEncryptedMetadata,
  addRecipientToMetadata,
  encryptXChaCha20Poly1305,
  decryptXChaCha20Poly1305,
  XCHACHA20_KEY_SIZE,
  type EncryptedContentStub,
  type HybridKeyPair,
} from "@lib/encryption";

// Re-export EncryptedContentStub for components
export type { EncryptedContentStub } from "@lib/encryption";
import { randomBytes, concatBytes } from "@noble/hashes/utils";
import { StorageManager } from "@lib/storage";
import { sha256 } from "@noble/hashes/sha256";

// ============================================================================
// Types
// ============================================================================

export type EncryptionMode = "passphrase" | "recipient";

export type EncryptionOptions = {
  /** Encryption mode */
  mode: EncryptionMode;
  /** For passphrase mode */
  passphrase?: string;
  /** For recipient mode - X25519 public keys */
  recipientPublicKeys?: Uint8Array[];
  /** Optional ML-KEM-768 public keys parallel to recipientPublicKeys (Phase 4: hybrid PQ) */
  recipientMlkemPublicKeys?: Uint8Array[];
  /**
   * Wallet's own encryption keypair for self-as-recipient backup (Phase 4).
   * Derived from HD seed via deriveEncryptionKeypair(). When provided, the CEK
   * is always wrapped for self regardless of mode, preventing permanent lock-out.
   */
  selfKeypair?: HybridKeyPair;
  /** Content MIME type */
  contentType: string;
  /** Content name/filename */
  name: string;
  /** Protocol IDs (usually [2, 8] for NFT + Encrypted) */
  protocolIds?: number[];
};

export type EncryptionResult = {
  /** Encrypted content ready for storage */
  encryptedContent: Uint8Array;
  /** Content hash (SHA256 of original) */
  contentHash: Uint8Array;
  /** Encrypted metadata for on-chain commitment */
  metadata: EncryptedContentStub;
  /** Locator key for storage (keep secret) */
  locatorKey: Uint8Array;
  /** CEK for sharing/re-encryption (keep secret) */
  cek: Uint8Array;
  /** Number of chunks */
  numChunks: number;
  /** Original size */
  originalSize: number;
};

export type DecryptionOptions = {
  /** Encrypted metadata from blockchain */
  metadata: EncryptedContentStub;
  /** For passphrase mode */
  passphrase?: string;
  /**
   * For recipient mode — either a raw X25519 private key (Uint8Array) or a full
   * HybridKeyPair.  A full keypair is required when the wrapped CEK slot uses
   * ML-KEM-768 (i.e. when selfKeypair or recipientMlkemPublicKeys were used at
   * encryption time).  Passing only a Uint8Array falls back to X25519-only.
   */
  privateKey?: HybridKeyPair | Uint8Array;
};

export type FileSizeEstimate = {
  /** Original file size */
  originalSize: number;
  /** Estimated encrypted size (with Poly1305 tags) */
  encryptedSize: number;
  /** Number of chunks */
  numChunks: number;
  /** Estimated chunk overhead */
  overheadBytes: number;
};

export type EncryptionProgress = {
  /** Current stage */
  stage: "reading" | "encrypting" | "decrypting" | "uploading" | "downloading" | "building" | "complete";
  /** Bytes processed */
  loaded: number;
  /** Total bytes */
  total: number;
  /** Percentage (0-100) */
  percent: number;
};

// ============================================================================
// File Size Estimation
// ============================================================================

const CHUNK_SIZE = 32 * 1024; // 32KB from encryption.ts
const POLY1305_TAG_SIZE = 16; // 16 bytes per chunk

/**
 * Estimate file size after encryption
 * @param originalSize Original file size in bytes
 * @returns Size estimate with overhead calculations
 */
export function estimateEncryptedSize(originalSize: number): FileSizeEstimate {
  const numChunks = Math.ceil(originalSize / CHUNK_SIZE);
  const overheadBytes = numChunks * POLY1305_TAG_SIZE;
  const encryptedSize = originalSize + overheadBytes;

  return {
    originalSize,
    encryptedSize,
    numChunks,
    overheadBytes,
  };
}

/**
 * Format bytes for human-readable display
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return (
    parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i]
  );
}

// ============================================================================
// Encryption Service
// ============================================================================

/**
 * Encrypt content for NFT minting
 *
 * This is the main entry point for Phase 3 encryption flow:
 * 1. Generate random CEK
 * 2. Encrypt content with chunked XChaCha20-Poly1305
 * 3. Hash plaintext
 * 4. Build metadata
 * 5. Wrap CEK based on mode (passphrase or recipient)
 * 6. Return result for storage and on-chain commitment
 */
export async function encryptContent(
  plaintext: Uint8Array | File,
  options: EncryptionOptions,
  onProgress?: (progress: EncryptionProgress) => void
): Promise<EncryptionResult> {
  // Convert File to Uint8Array if needed
  let content: Uint8Array;
  if (plaintext instanceof File) {
    onProgress?.({
      stage: "reading",
      loaded: 0,
      total: plaintext.size,
      percent: 0,
    });

    const arrayBuffer = await plaintext.arrayBuffer();
    content = new Uint8Array(arrayBuffer);

    onProgress?.({
      stage: "reading",
      loaded: content.length,
      total: plaintext.size,
      percent: 100,
    });
  } else {
    content = plaintext;
  }

  const originalSize = content.length;

  // Generate CEK
  const cek = crypto.getRandomValues(new Uint8Array(32));

  // Encrypt content
  onProgress?.({
    stage: "encrypting",
    loaded: 0,
    total: originalSize,
    percent: 0,
  });

  const encrypted = encryptChunked(content, cek);
  const numChunks = encrypted.chunks.length;

  onProgress?.({
    stage: "encrypting",
    loaded: originalSize,
    total: originalSize,
    percent: 100,
  });

  // Hash CEK
  const cekHash = sha256(cek);

  // Build base metadata
  let metadata = buildEncryptedMetadata({
    protocolIds: options.protocolIds ?? [2, 8], // NFT + Encrypted
    contentType: options.contentType,
    name: options.name,
    plaintextHash: encrypted.plaintextHash,
    cekHash,
    size: originalSize,
    numChunks,
  });

  // Wrap CEK based on mode
  let locatorKey: Uint8Array;

  if (options.mode === "passphrase" && options.passphrase) {
    // Passphrase mode: derive KEK from passphrase via scrypt, then XChaCha20-wrap CEK
    const { key: passphraseKey, salt: passphraseSalt } = deriveKeyScrypt(
      options.passphrase
    );
    const kek = deriveKeyHKDF(
      passphraseKey,
      passphraseSalt,
      new TextEncoder().encode("glyph-kek-passphrase-v1"),
      XCHACHA20_KEY_SIZE
    );
    const nonce = randomBytes(24);
    const { ciphertext: wrappedCEKCt } = encryptXChaCha20Poly1305(cek, kek, nonce);
    // Encode: salt (32) || nonce (24) || ciphertext
    const wrappedCEK = concatBytes(passphraseSalt, nonce, wrappedCEKCt);

    metadata = addRecipientToMetadata(metadata, wrappedCEK, {
      x25519EphemeralPublicKey: new Uint8Array(32), // sentinel: passphrase mode
      sharedSecret: kek, // not persisted
    });

    // Mark key_format as passphrase (mode stays "encrypted" per REP-3006)
    metadata = {
      ...metadata,
      crypto: { ...metadata.crypto, key_format: "passphrase" },
    };

    // Locator key derived from passphrase — re-derivable without storage
    locatorKey = deriveKeyHKDF(
      passphraseKey,
      passphraseSalt,
      new TextEncoder().encode("glyph-locator-passphrase-v1"),
      32
    );
  } else if (options.mode === "recipient" && options.recipientPublicKeys?.length) {
    // Recipient mode: wrap CEK for each recipient with hybrid KEM
    // cek_hash not yet in metadata at this point — build it first for AAD
    const recipientCekHashAad = new TextEncoder().encode(
      `sha256:${Array.from(sha256(cek)).map((b) => b.toString(16).padStart(2, "0")).join("")}`
    );
    for (let idx = 0; idx < options.recipientPublicKeys.length; idx++) {
      const { wrappedCEK, ephemeral } = wrapCEK(
        cek,
        { x25519: options.recipientPublicKeys[idx], mlkem: options.recipientMlkemPublicKeys?.[idx] },
        recipientCekHashAad
      );
      metadata = addRecipientToMetadata(metadata, wrappedCEK, ephemeral);
    }

    locatorKey = randomBytes(32);
  } else {
    throw new Error(
      "Invalid encryption options: must provide passphrase or recipient keys"
    );
  }

  // Self-as-recipient backup (always added when selfKeypair provided)
  // Ensures the minter can always decrypt even if they lose their passphrase or
  // are not listed as an explicit recipient.
  // AAD = cek_hash bytes (binds the wrapped CEK to this specific NFT)
  const cekHashAad = new TextEncoder().encode(metadata.crypto.cek_hash);

  // Re-wrap recipient slots WITH AAD now that cek_hash is known
  // (Recipient slots were added above without AAD; re-derive with AAD)
  // Note: for simplicity we add AAD only to the selfKeypair slot and future
  // wrapCEK calls. Existing recipient wraps in the loop above also get AAD.
  if (options.selfKeypair) {
    const { wrappedCEK: selfWrappedCEK, ephemeral: selfEphemeral } = wrapCEK(
      cek,
      { x25519: options.selfKeypair.x25519PublicKey, mlkem: options.selfKeypair.mlkemPublicKey },
      cekHashAad
    );
    metadata = addRecipientToMetadata(metadata, selfWrappedCEK, selfEphemeral);
  }

  onProgress?.({
    stage: "complete",
    loaded: originalSize,
    total: originalSize,
    percent: 100,
  });

  return {
    encryptedContent: concatenateChunks(encrypted.chunks),
    contentHash: encrypted.plaintextHash,
    metadata,
    locatorKey,
    cek,
    numChunks,
    originalSize,
  };
}

/**
 * Concatenate encrypted chunks into single Uint8Array
 */
function concatenateChunks(chunks: { ciphertext: Uint8Array; nonce: Uint8Array }[]): Uint8Array {
  // Each chunk: [nonce (24 bytes)][ciphertext (variable)][tag (16 bytes)]
  const totalLength = chunks.reduce(
    (sum, chunk) => sum + 24 + chunk.ciphertext.length,
    0
  );

  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk.nonce, offset);
    offset += 24;
    result.set(chunk.ciphertext, offset);
    offset += chunk.ciphertext.length;
  }

  return result;
}

// ============================================================================
// Decryption Service
// ============================================================================

/**
 * Decrypt content using passphrase or private key
 */
export async function decryptContent(
  encryptedContent: Uint8Array,
  options: DecryptionOptions,
  onProgress?: (progress: Omit<EncryptionProgress, "stage"> & { stage: "downloading" | "decrypting" | "complete" }) => void
): Promise<Uint8Array> {
  const { metadata } = options;

  // Get encrypted chunks from content
  const chunks = parseEncryptedContent(encryptedContent, metadata.main.chunks);

  // Unwrap CEK — assigned inside conditional branches, guarded by unwrapped flag
  let cek!: Uint8Array;

  const recipients = metadata.crypto.recipients;
  if (!recipients?.length) {
    throw new Error("No recipients found in metadata");
  }

  // AAD used during CEK wrapping — the cek_hash string as UTF-8 bytes
  // Passphrase slots were wrapped without AAD (they predate this binding)
  const cekHashAad = metadata.crypto.cek_hash
    ? new TextEncoder().encode(metadata.crypto.cek_hash)
    : undefined;

  if (options.passphrase) {
    // Passphrase mode: passphrase recipients use an all-zeros epk sentinel.
    // Iterate to find the matching passphrase recipient (there may be multiple recipients
    // in mixed mode, e.g. passphrase + self-as-recipient backup).
    const PASSPHRASE_SENTINEL = new Uint8Array(32); // all zeros
    let unwrapped = false;

    for (const recipient of recipients) {
      const ephemeralBytes = new Uint8Array(Buffer.from(recipient.epk, "base64"));
      // Only try recipients marked as passphrase-mode (sentinel ephemeral key)
      if (!ephemeralBytes.every((b, i) => b === PASSPHRASE_SENTINEL[i])) continue;

      try {
        // wrapped_cek layout: salt (32) || nonce (24) || ciphertext
        const wrappedCEKBuf = new Uint8Array(Buffer.from(recipient.wrapped_cek, "base64"));
        const passphraseSalt = wrappedCEKBuf.slice(0, 32);
        const nonce = wrappedCEKBuf.slice(32, 56);
        const ciphertext = wrappedCEKBuf.slice(56);

        const { key: passphraseKey } = deriveKeyScrypt(options.passphrase, passphraseSalt);
        const kek = deriveKeyHKDF(
          passphraseKey,
          passphraseSalt,
          new TextEncoder().encode("glyph-kek-passphrase-v1"),
          XCHACHA20_KEY_SIZE
        );

        // Passphrase wraps do NOT use cek_hash AAD (plain XChaCha20, no AAD)
        cek = decryptXChaCha20Poly1305(ciphertext, kek, nonce);
        unwrapped = true;
        break;
      } catch {
        // Wrong passphrase or corrupted — keep trying remaining passphrase recipients
      }
    }

    if (!unwrapped) {
      throw new Error("Invalid passphrase or no matching passphrase recipient found");
    }
  } else if (options.privateKey) {
    // Recipient mode: iterate all recipients until unwrapCEK succeeds for this private key.
    // Needed because a token may have multiple recipients (e.g. sender + receiver + self-backup).
    let unwrapped = false;

    const recipientKeyPair: HybridKeyPair =
      options.privateKey instanceof Uint8Array
        ? { x25519PrivateKey: options.privateKey, x25519PublicKey: new Uint8Array(32) }
        : options.privateKey!;

    for (const recipient of recipients) {
      // Skip passphrase-sentinel recipients (all-zero epk)
      const ephemeralBytes = new Uint8Array(Buffer.from(recipient.epk, "base64"));
      if (ephemeralBytes.every((b) => b === 0)) continue;

      try {
        const ephemeral = {
          x25519EphemeralPublicKey: ephemeralBytes,
          ...(recipient.mlkem_ct
            ? { mlkemCiphertext: new Uint8Array(Buffer.from(recipient.mlkem_ct, "base64")) }
            : {}),
        };

        cek = unwrapCEK(
          new Uint8Array(Buffer.from(recipient.wrapped_cek, "base64")),
          ephemeral,
          recipientKeyPair,
          cekHashAad
        );
        unwrapped = true;
        break;
      } catch {
        // Not this recipient — try next
      }
    }

    if (!unwrapped) {
      throw new Error("Private key is not a recipient for this content");
    }
  } else {
    throw new Error("Must provide passphrase or privateKey");
  }

  onProgress?.({
    stage: "decrypting",
    loaded: 0,
    total: chunks.length,
    percent: 0,
  });

  // Decrypt chunks
  const plaintextHash = new Uint8Array(Buffer.from(metadata.main.hash.replace("sha256:", ""), "hex"));
  const decrypted = decryptChunked(
    { chunks, plaintextHash },
    cek,
    plaintextHash
  );

  onProgress?.({
    stage: "complete",
    loaded: chunks.length,
    total: chunks.length,
    percent: 100,
  });

  return decrypted;
}

/**
 * Parse encrypted content into chunks
 */
function parseEncryptedContent(
  data: Uint8Array,
  numChunks: number
): { ciphertext: Uint8Array; nonce: Uint8Array }[] {
  const chunks: { ciphertext: Uint8Array; nonce: Uint8Array }[] = [];
  let offset = 0;

  for (let i = 0; i < numChunks; i++) {
    // Read nonce (24 bytes)
    const nonce = data.slice(offset, offset + 24);
    offset += 24;

    // For the last chunk, read remaining data
    // For other chunks, read CHUNK_SIZE + POLY1305_TAG_SIZE
    const isLastChunk = i === numChunks - 1;
    const chunkSize = isLastChunk ? data.length - offset : CHUNK_SIZE + POLY1305_TAG_SIZE;

    const ciphertext = data.slice(offset, offset + chunkSize);
    offset += chunkSize;

    chunks.push({ ciphertext, nonce });
  }

  return chunks;
}

// ============================================================================
// Storage Integration
// ============================================================================

/**
 * Re-derive the locator key from passphrase for passphrase-mode tokens.
 * The passphraseSalt is the first 32 bytes of recipients[0].kek (base64-decoded).
 * Matches the derivation in encryptContent for mode === "passphrase".
 */
export function deriveLocatorKeyFromPassphrase(
  passphrase: string,
  stub: EncryptedContentStub
): Uint8Array {
  const recipient = stub.crypto?.recipients?.[0];
  if (!recipient?.wrapped_cek) {
    throw new Error("No passphrase recipient found in stub");
  }
  const wrappedCEKBuf = new Uint8Array(Buffer.from(recipient.wrapped_cek, "base64"));
  const passphraseSalt = wrappedCEKBuf.slice(0, 32);
  const { key: passphraseKey } = deriveKeyScrypt(passphrase, passphraseSalt);
  return deriveKeyHKDF(
    passphraseKey,
    passphraseSalt,
    new TextEncoder().encode("glyph-locator-passphrase-v1"),
    32
  );
}

/**
 * Upload encrypted content to storage and return encrypted locator
 */
export async function storeEncryptedContent(
  encryptedContent: Uint8Array,
  contentHash: Uint8Array,
  locatorKey: Uint8Array,
  storageManager: StorageManager,
  onProgress?: (loaded: number, total: number, stage: string) => void
): Promise<{ encryptedLocator: Uint8Array; locatorNonce: Uint8Array }> {
  const result = await storageManager.uploadEncrypted(
    encryptedContent,
    locatorKey,
    { onProgress }
  );

  return {
    encryptedLocator: result.encryptedLocator,
    locatorNonce: result.locatorNonce,
  };
}

/**
 * Retrieve encrypted content from storage
 */
export async function retrieveEncryptedContent(
  encryptedLocator: Uint8Array,
  locatorNonce: Uint8Array,
  locatorKey: Uint8Array,
  storageManager: StorageManager,
  onProgress?: (loaded: number, total: number, stage: string) => void
): Promise<Uint8Array> {
  const result = await storageManager.downloadEncrypted(
    encryptedLocator,
    locatorNonce,
    locatorKey,
    { onProgress }
  );

  return result.plaintext;
}
