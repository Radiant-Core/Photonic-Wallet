/**
 * Glyph v2 Encryption Module (REPs 3006-3009)
 *
 * Implements:
 * - XChaCha20-Poly1305 AEAD with chunked streaming
 * - HKDF-SHA256 key derivation
 * - Hybrid X25519 + ML-KEM-768 key agreement
 * - Scrypt passphrase-based key derivation
 * - SHA256 content commitments
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { scrypt } from "@noble/hashes/scrypt";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes, concatBytes } from "@noble/hashes/utils";
import { ml_kem768 } from "@noble/post-quantum/ml-kem";

// ============================================================================
// Constants
// ============================================================================

const CHUNK_SIZE = 32768; // 32 KB chunks (avoid Web Crypto API quota limits)
const XCHACHA20_NONCE_SIZE = 24;
export const XCHACHA20_KEY_SIZE = 32;
const POLY1305_TAG_SIZE = 16;
// Note: ML-KEM-768 (post-quantum) temporarily removed pending library support
// Will be added as hybrid X25519+ML-KEM when available

// Scrypt parameters for passphrase-based keys
const SCRYPT_PARAMS = {
  dkLen: 32,
  N: 65536, // 2^16
  r: 8,
  p: 1,
};

// ============================================================================
// Legacy Types (backwards compatibility)
// ============================================================================

export type EncryptedData = {
  ciphertext: ArrayBuffer | Uint8Array;
  salt: Uint8Array;
  iv: Uint8Array;
  mac: Uint8Array;
};

// ============================================================================
// Glyph v2 Types
// ============================================================================

export type ChunkedAeadConfig = {
  chunkSize: number;
  maxChunks: number;
  scheme: "chunked-aead-v1";
};

export type EncryptionMetadata = {
  type: string;
  hash: string; // sha256:...
  enc: "xchacha20poly1305";
  size: number;
  chunks: number;
  scheme: "chunked-aead-v1";
};

export type CryptoRecipient = {
  /** Key identifier — matches REP-3006 crypto.key.wrap.recipients[].kid */
  kid: string;
  /** Wrap algorithm — REP-3006 crypto.key.wrap.alg */
  alg: "x25519-hkdf-xchacha20poly1305" | "x25519mlkem768-hkdf-xchacha20poly1305";
  /** Base64 wrapped CEK (nonce || ciphertext) — REP-3006 wrapped_cek */
  wrapped_cek: string;
  /** Base64 ephemeral X25519 public key — REP-3006 epk */
  epk: string;
  /** Base64 ML-KEM-768 ciphertext — REP-3006 mlkem_ct (hybrid PQ only) */
  mlkem_ct?: string;
};

export type CryptoMetadata = {
  /** Always "encrypted" per REP-3006 §crypto.mode */
  mode: "encrypted";
  /** Key delivery format — REP-3006 crypto.key.format */
  key_format: "wrapped" | "passphrase";
  /** SHA256 of the CEK — on-chain commitment used as AAD for CEK wrapping */
  cek_hash: string; // sha256:...
  locator?: string; // base64 encrypted pointer (optional)
  locator_hash?: string; // sha256:...
  recipients?: CryptoRecipient[];
  /** Timelock commitment fields (Phase 5 / REP-3009) */
  timelock?: {
    mode: "block" | "time";
    unlock_at: number;
    cek_hash: string; // sha256:hex — authenticates the reveal
    hint?: string;
  };
};

export type EncryptedContentStub = {
  p: number[];
  type: string;
  name: string;
  main: EncryptionMetadata;
  crypto: CryptoMetadata;
};

export type EncryptedChunk = {
  ciphertext: Uint8Array;
  nonce: Uint8Array; // 24-byte XChaCha20 nonce
};

export type ChunkedCiphertext = {
  chunks: EncryptedChunk[];
  plaintextHash: Uint8Array;
};

// ============================================================================
// Core AEAD: XChaCha20-Poly1305
// ============================================================================

/**
 * Encrypt data using XChaCha20-Poly1305
 * @param plaintext Data to encrypt
 * @param key 32-byte encryption key
 * @param nonce 24-byte nonce (randomly generated if not provided)
 * @param aad Additional authenticated data
 * @returns Ciphertext with Poly1305 tag appended
 */
export function encryptXChaCha20Poly1305(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce?: Uint8Array,
  aad?: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  if (key.length !== XCHACHA20_KEY_SIZE) {
    throw new Error(`Key must be ${XCHACHA20_KEY_SIZE} bytes, got ${key.length}`);
  }

  const usedNonce = nonce ?? randomBytes(XCHACHA20_NONCE_SIZE);
  if (usedNonce.length !== XCHACHA20_NONCE_SIZE) {
    throw new Error(`Nonce must be ${XCHACHA20_NONCE_SIZE} bytes, got ${usedNonce.length}`);
  }

  const cipher = xchacha20poly1305(key, usedNonce, aad);
  const ciphertext = cipher.encrypt(plaintext);

  return { ciphertext, nonce: usedNonce };
}

/**
 * Decrypt data using XChaCha20-Poly1305
 * @param ciphertext Ciphertext with Poly1305 tag
 * @param key 32-byte encryption key
 * @param nonce 24-byte nonce
 * @param aad Additional authenticated data (must match encryption)
 * @returns Decrypted plaintext
 */
export function decryptXChaCha20Poly1305(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  aad?: Uint8Array
): Uint8Array {
  if (key.length !== XCHACHA20_KEY_SIZE) {
    throw new Error(`Key must be ${XCHACHA20_KEY_SIZE} bytes, got ${key.length}`);
  }
  if (nonce.length !== XCHACHA20_NONCE_SIZE) {
    throw new Error(`Nonce must be ${XCHACHA20_NONCE_SIZE} bytes, got ${nonce.length}`);
  }

  const cipher = xchacha20poly1305(key, nonce, aad);
  return cipher.decrypt(ciphertext);
}

// ============================================================================
// Chunked AEAD for Large Files
// ============================================================================

/**
 * Encrypt large content using chunked XChaCha20-Poly1305
 * Each chunk is independently authenticated with AAD containing chunk index
 * @param plaintext Full plaintext content
 * @param key 32-byte content encryption key (CEK)
 * @returns Array of encrypted chunks with nonces and tags
 */
export function encryptChunked(
  plaintext: Uint8Array,
  key: Uint8Array
): ChunkedCiphertext {
  const plaintextHash = sha256(plaintext);
  const numChunks = Math.ceil(plaintext.length / CHUNK_SIZE);
  const chunks: EncryptedChunk[] = [];

  for (let i = 0; i < numChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, plaintext.length);
    const chunkPlaintext = plaintext.slice(start, end);

    // AAD includes file hash + chunk index for integrity
    const chunkIndex = new Uint8Array(4);
    new DataView(chunkIndex.buffer).setUint32(0, i, false); // big-endian
    const aad = concatBytes(plaintextHash, chunkIndex);

    // Random nonce per chunk for maximum security
    const nonce = randomBytes(XCHACHA20_NONCE_SIZE);

    const { ciphertext } = encryptXChaCha20Poly1305(chunkPlaintext, key, nonce, aad);
    chunks.push({ ciphertext, nonce });
  }

  return { chunks, plaintextHash };
}

/**
 * Decrypt chunked content
 * @param chunkedCiphertext Chunked ciphertext with nonces
 * @param key 32-byte content encryption key
 * @param plaintextHash Expected SHA256 hash of full plaintext (for AAD)
 * @returns Decrypted plaintext
 */
export function decryptChunked(
  chunkedCiphertext: ChunkedCiphertext,
  key: Uint8Array,
  plaintextHash: Uint8Array
): Uint8Array {
  const decryptedChunks: Uint8Array[] = [];

  for (let i = 0; i < chunkedCiphertext.chunks.length; i++) {
    const chunk = chunkedCiphertext.chunks[i];
    const chunkIndex = new Uint8Array(4);
    new DataView(chunkIndex.buffer).setUint32(0, i, false);
    const aad = concatBytes(plaintextHash, chunkIndex);

    const decrypted = decryptXChaCha20Poly1305(chunk.ciphertext, key, chunk.nonce, aad);
    decryptedChunks.push(decrypted);
  }

  return concatBytes(...decryptedChunks);
}

// ============================================================================
// Key Derivation
// ============================================================================

/**
 * Derive key using HKDF-SHA256 (RFC 5869)
 * @param ikm Input keying material
 * @param salt Salt (optional, recommended)
 * @param info Context/application-specific info
 * @param length Desired output length in bytes
 * @returns Derived key
 */
export function deriveKeyHKDF(
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: Uint8Array,
  length: number
): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

/**
 * Derive key using scrypt (for passphrase-based encryption)
 * @param passphrase Password/passphrase
 * @param salt Salt (randomly generated if not provided)
 * @returns Derived key and salt used
 */
export function deriveKeyScrypt(
  passphrase: string,
  salt?: Uint8Array
): { key: Uint8Array; salt: Uint8Array } {
  const usedSalt = salt ?? randomBytes(32);
  const key = scrypt(
    new TextEncoder().encode(passphrase),
    usedSalt,
    SCRYPT_PARAMS
  );
  return { key, salt: usedSalt };
}

// ============================================================================
// Hybrid Key Agreement: X25519 + ML-KEM-768
// ============================================================================

export type HybridKeyPair = {
  x25519PrivateKey: Uint8Array;
  x25519PublicKey: Uint8Array;
  mlkemPrivateKey?: Uint8Array; // ML-KEM-768 secret key (2400 bytes)
  mlkemPublicKey?: Uint8Array; // ML-KEM-768 public key (1184 bytes)
};

export type EncapsulatedSecret = {
  x25519EphemeralPublicKey: Uint8Array;
  mlkemCiphertext?: Uint8Array; // ML-KEM-768 encapsulation ciphertext (1088 bytes)
  sharedSecret: Uint8Array;
};

/**
 * Build a hybrid keypair from a known 32-byte X25519 private key, with an optional
 * deterministic ML-KEM-768 seed.  Used by keys.ts to derive a stable encryption
 * keypair from the HD wallet without importing @noble/curves in the app package.
 * @param x25519PrivateKey 32-byte X25519 private key (scalar)
 * @param mlkemSeed Optional 64-byte seed for deterministic ML-KEM keygen
 */
export function buildHybridKeyPairFromPrivateKey(
  x25519PrivateKey: Uint8Array,
  mlkemSeed?: Uint8Array
): HybridKeyPair {
  const x25519PublicKey = x25519.getPublicKey(x25519PrivateKey);

  if (!mlkemSeed) {
    return { x25519PrivateKey, x25519PublicKey };
  }

  const mlkemKeys = ml_kem768.keygen(mlkemSeed);
  return {
    x25519PrivateKey,
    x25519PublicKey,
    mlkemPrivateKey: mlkemKeys.secretKey,
    mlkemPublicKey: mlkemKeys.publicKey,
  };
}

/**
 * Generate hybrid X25519 + ML-KEM-768 keypair
 * @param includeMlkem If true, also generate ML-KEM-768 keys (post-quantum)
 * @returns Hybrid keypair
 */
export function generateHybridKeyPair(includeMlkem = true): HybridKeyPair {
  const x25519PrivateKey = x25519.utils.randomPrivateKey();
  const x25519PublicKey = x25519.getPublicKey(x25519PrivateKey);

  if (!includeMlkem) {
    return { x25519PrivateKey, x25519PublicKey };
  }

  const mlkemKeys = ml_kem768.keygen();
  return {
    x25519PrivateKey,
    x25519PublicKey,
    mlkemPrivateKey: mlkemKeys.secretKey,
    mlkemPublicKey: mlkemKeys.publicKey,
  };
}

/**
 * Encapsulate a shared secret for a recipient using hybrid X25519 + ML-KEM-768
 * The final shared secret is HKDF(x25519_ss || mlkem_ss) providing both
 * classical and post-quantum security.
 * @param recipientX25519Pub Recipient's X25519 public key (32 bytes)
 * @param recipientMlkemPub Recipient's ML-KEM-768 public key (1184 bytes, optional)
 * @returns Encapsulated secret that can be decapsulated by recipient
 */
export function encapsulateHybrid(
  recipientX25519Pub: Uint8Array,
  recipientMlkemPub?: Uint8Array
): EncapsulatedSecret {
  // X25519 ECDH with ephemeral key
  const ephemeralX25519Priv = x25519.utils.randomPrivateKey();
  const ephemeralX25519Pub = x25519.getPublicKey(ephemeralX25519Priv);
  const x25519Shared = x25519.getSharedSecret(
    ephemeralX25519Priv,
    recipientX25519Pub
  );

  if (!recipientMlkemPub) {
    // X25519-only (backwards compatible, non-PQ)
    return {
      x25519EphemeralPublicKey: ephemeralX25519Pub,
      sharedSecret: x25519Shared,
    };
  }

  // ML-KEM-768 encapsulation
  const { cipherText: mlkemCiphertext, sharedSecret: mlkemShared } =
    ml_kem768.encapsulate(recipientMlkemPub);

  // Combine both shared secrets via HKDF
  const combined = concatBytes(x25519Shared, mlkemShared);
  const sharedSecret = hkdf(
    sha256,
    combined,
    undefined,
    new TextEncoder().encode("glyph-hybrid-kem-v1"),
    32
  );

  return {
    x25519EphemeralPublicKey: ephemeralX25519Pub,
    mlkemCiphertext,
    sharedSecret,
  };
}

/**
 * Decapsulate a shared secret using hybrid X25519 + ML-KEM-768
 * @param encaps Encapsulated secret from sender
 * @param recipientKeyPair Recipient's private keys
 * @returns Shared secret
 */
export function decapsulateHybrid(
  encaps: EncapsulatedSecret,
  recipientKeyPair: HybridKeyPair
): Uint8Array {
  // X25519 ECDH
  const x25519Shared = x25519.getSharedSecret(
    recipientKeyPair.x25519PrivateKey,
    encaps.x25519EphemeralPublicKey
  );

  if (!encaps.mlkemCiphertext || !recipientKeyPair.mlkemPrivateKey) {
    // X25519-only (backwards compatible, non-PQ)
    return x25519Shared;
  }

  // ML-KEM-768 decapsulation
  const mlkemShared = ml_kem768.decapsulate(
    encaps.mlkemCiphertext,
    recipientKeyPair.mlkemPrivateKey
  );

  // Combine both shared secrets via HKDF (must match encapsulation)
  const combined = concatBytes(x25519Shared, mlkemShared);
  return hkdf(
    sha256,
    combined,
    undefined,
    new TextEncoder().encode("glyph-hybrid-kem-v1"),
    32
  );
}

// ============================================================================
// Content Encryption Key (CEK) Wrapping
// ============================================================================

/**
 * Wrap a CEK for a recipient using hybrid X25519+ML-KEM-768 KEM + XChaCha20-Poly1305.
 * @param cek Content encryption key (32 bytes)
 * @param recipientPublicKey Recipient's X25519 (and optional ML-KEM-768) public keys
 * @param aad Additional authenticated data bound to the wrap (REP-3006: use cek_hash bytes)
 * @returns Wrapped key package including ephemeral keys for recipient
 */
export function wrapCEK(
  cek: Uint8Array,
  recipientPublicKey: { x25519: Uint8Array; mlkem?: Uint8Array },
  aad?: Uint8Array
): { wrappedCEK: Uint8Array; ephemeral: EncapsulatedSecret } {
  // Encapsulate shared secret (hybrid if mlkem key provided)
  const ephemeral = encapsulateHybrid(
    recipientPublicKey.x25519,
    recipientPublicKey.mlkem && recipientPublicKey.mlkem.length > 0
      ? recipientPublicKey.mlkem
      : undefined
  );

  // Derive KEK from shared secret
  const kek = deriveKeyHKDF(
    ephemeral.sharedSecret,
    undefined,
    new TextEncoder().encode("glyph-kek-v1"),
    32
  );

  // Wrap CEK using XChaCha20-Poly1305, binding AAD (e.g. cek_hash) to the wrap
  const nonce = randomBytes(XCHACHA20_NONCE_SIZE);
  const { ciphertext } = encryptXChaCha20Poly1305(cek, kek, nonce, aad);

  // Prepend nonce to wrapped CEK
  const wrappedCEK = concatBytes(nonce, ciphertext);

  return { wrappedCEK, ephemeral };
}

/**
 * Unwrap a CEK using recipient's private keys.
 * @param wrappedCEK Wrapped CEK (nonce || ciphertext)
 * @param ephemeral Ephemeral public key data from sender
 * @param recipientKeyPair Recipient's private keys
 * @param aad Additional authenticated data used during wrapping (must match wrapCEK)
 * @returns Unwrapped CEK
 */
export function unwrapCEK(
  wrappedCEK: Uint8Array,
  ephemeral: Omit<EncapsulatedSecret, "sharedSecret">,
  recipientKeyPair: HybridKeyPair,
  aad?: Uint8Array
): Uint8Array {
  // Decapsulate shared secret
  const encaps: EncapsulatedSecret = {
    ...ephemeral,
    sharedSecret: new Uint8Array(0), // Will be computed by decapsulateHybrid
  };
  const sharedSecret = decapsulateHybrid(encaps, recipientKeyPair);

  // Derive KEK
  const kek = deriveKeyHKDF(
    sharedSecret,
    undefined,
    new TextEncoder().encode("glyph-kek-v1"),
    32
  );

  // Unwrap CEK (AAD must match what was used in wrapCEK)
  const nonce = wrappedCEK.slice(0, XCHACHA20_NONCE_SIZE);
  const ciphertext = wrappedCEK.slice(XCHACHA20_NONCE_SIZE);

  return decryptXChaCha20Poly1305(ciphertext, kek, nonce, aad);
}

// ============================================================================
// Content Commitments and Hashing
// ============================================================================

/**
 * Compute SHA256 hash of content
 * @param data Content to hash
 * @returns 32-byte SHA256 digest
 */
export function hashContent(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/**
 * Compute hash of encrypted locator (for on-chain commitment)
 * @param locator Encrypted locator bytes
 * @returns 32-byte SHA256 digest
 */
export function hashLocator(locator: Uint8Array): Uint8Array {
  return sha256(locator);
}

// ============================================================================
// Metadata Builders
// ============================================================================

/**
 * Build encrypted content metadata stub for on-chain storage
 * @param params Content parameters
 * @returns Metadata stub ready for CBOR encoding
 */
export function buildEncryptedMetadata(params: {
  protocolIds: number[];
  contentType: string;
  name: string;
  plaintextHash: Uint8Array;
  cekHash: Uint8Array;
  size: number;
  numChunks: number;
  encryptionScheme?: string;
}): EncryptedContentStub {
  return {
    p: params.protocolIds,
    type: params.contentType,
    name: params.name,
    main: {
      type: params.contentType,
      hash: `sha256:${toHex(params.plaintextHash)}`,
      enc: "xchacha20poly1305",
      size: params.size,
      chunks: params.numChunks,
      scheme: (params.encryptionScheme as "chunked-aead-v1") ?? "chunked-aead-v1",
    },
    crypto: {
      mode: "encrypted",
      key_format: "wrapped",
      cek_hash: `sha256:${toHex(params.cekHash)}`,
    },
  };
}

/**
 * Add recipient to encrypted metadata
 * @param metadata Base metadata
 * @param wrappedCEK Wrapped content encryption key
 * @param ephemeral Ephemeral key data
 * @returns Updated metadata with recipient
 */
export function addRecipientToMetadata(
  metadata: EncryptedContentStub,
  wrappedCEK: Uint8Array,
  ephemeral: EncapsulatedSecret
): EncryptedContentStub {
  // Detect hybrid PQ mode by presence of ML-KEM ciphertext
  const isHybrid =
    ephemeral.mlkemCiphertext !== undefined &&
    ephemeral.mlkemCiphertext.length > 0;

  const recipient: CryptoRecipient = {
    kid: isHybrid ? "x25519mlkem768" : "x25519",
    alg: isHybrid
      ? "x25519mlkem768-hkdf-xchacha20poly1305"
      : "x25519-hkdf-xchacha20poly1305",
    wrapped_cek: toBase64(wrappedCEK),
    epk: toBase64(ephemeral.x25519EphemeralPublicKey),
    ...(isHybrid && ephemeral.mlkemCiphertext
      ? { mlkem_ct: toBase64(ephemeral.mlkemCiphertext) }
      : {}),
  };

  return {
    ...metadata,
    crypto: {
      ...metadata.crypto,
      recipients: [...(metadata.crypto.recipients ?? []), recipient],
    },
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function toBase64(bytes: Uint8Array): string {
  // Use standard base64 for metadata (not URL-safe)
  const binString = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binString);
}

export function fromBase64(base64: string): Uint8Array {
  const binString = atob(base64);
  return Uint8Array.from(binString, (c) => c.charCodeAt(0));
}

// ============================================================================
// Legacy Exports (backwards compatibility)
// ============================================================================

/**
 * Legacy encrypt function (AES-CTR with scrypt)
 * @deprecated Use encryptChunked + wrapCEK for new implementations
 */
export async function encrypt(
  data: Uint8Array,
  password: string
): Promise<EncryptedData> {
  const { key, salt } = deriveKeyScrypt(password);
  const iv = randomBytes(16);

  const { crypto } = globalThis;
  const importedKey = await crypto.subtle.importKey(
    "raw",
    key.slice(0, 16),
    { name: "AES-CTR" },
    false,
    ["encrypt"]
  );

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-CTR",
      counter: iv as BufferSource,
      length: 64,
    },
    importedKey,
    data as BufferSource
  );

  const mac = sha256(concatBytes(key.slice(16, 32), new Uint8Array(ciphertext)));

  return {
    ciphertext,
    salt,
    iv,
    mac,
  };
}

/**
 * Legacy decrypt function
 * @deprecated Use decryptChunked + unwrapCEK for new implementations
 */
export async function decrypt(data: EncryptedData, password: string): Promise<Uint8Array> {
  const { key } = deriveKeyScrypt(password, data.salt);

  const mac = sha256(concatBytes(key.slice(16, 32), new Uint8Array(data.ciphertext)));
  if (Buffer.compare(Buffer.from(data.mac), Buffer.from(mac)) !== 0) {
    throw new Error("Password incorrect");
  }

  const { crypto } = globalThis;
  const importedKey = await crypto.subtle.importKey(
    "raw",
    key.slice(0, 16),
    { name: "AES-CTR" },
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-CTR",
      counter: data.iv as BufferSource,
      length: 128,
    },
    importedKey,
    data.ciphertext as BufferSource
  );

  return new Uint8Array(decrypted);
}
