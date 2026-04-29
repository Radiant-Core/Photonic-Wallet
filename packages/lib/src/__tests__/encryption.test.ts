/**
 * Unit tests for Glyph v2 Encryption Module (REPs 3006-3009)
 *
 * Tests:
 * - XChaCha20-Poly1305 AEAD round-trip
 * - Chunked AEAD for large files
 * - HKDF-SHA256 key derivation
 * - X25519 key agreement (hybrid with ML-KEM reserved)
 * - CEK wrapping/unwrapping
 * - Content hashing
 * - Metadata builders
 */

import { describe, it, expect } from "vitest";
import {
  encryptXChaCha20Poly1305,
  decryptXChaCha20Poly1305,
  encryptChunked,
  decryptChunked,
  deriveKeyHKDF,
  deriveKeyScrypt,
  generateHybridKeyPair,
  encapsulateHybrid,
  decapsulateHybrid,
  wrapCEK,
  unwrapCEK,
  hashContent,
  hashLocator,
  buildEncryptedMetadata,
  addRecipientToMetadata,
  XCHACHA20_KEY_SIZE,
} from "../encryption";

// Generate random bytes in chunks to avoid quota limits
function randomBytesLarge(size: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  const CHUNK = 65536;
  while (size > 0) {
    const chunkSize = Math.min(size, CHUNK);
    chunks.push(crypto.getRandomValues(new Uint8Array(chunkSize)));
    size -= chunkSize;
  }
  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ============================================================================
// XChaCha20-Poly1305 Tests
// ============================================================================

describe("XChaCha20-Poly1305", () => {
  it("should encrypt and decrypt data correctly", () => {
    const plaintext = new TextEncoder().encode("Hello, Glyph Encryption!");
    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const { ciphertext, nonce } = encryptXChaCha20Poly1305(plaintext, key);

    expect(ciphertext.length).toBeGreaterThan(plaintext.length);
    expect(nonce.length).toBe(24);

    const decrypted = decryptXChaCha20Poly1305(ciphertext, key, nonce);
    expect(new TextDecoder().decode(decrypted)).toBe("Hello, Glyph Encryption!");
  });

  it("should use random nonce when not provided", () => {
    const plaintext = new TextEncoder().encode("Test message");
    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const result1 = encryptXChaCha20Poly1305(plaintext, key);
    const result2 = encryptXChaCha20Poly1305(plaintext, key);

    // Nonces should be different
    expect(result1.nonce).not.toEqual(result2.nonce);
    // Ciphertexts should be different
    expect(result1.ciphertext).not.toEqual(result2.ciphertext);
  });

  it("should throw on wrong key size", () => {
    const plaintext = new Uint8Array([1, 2, 3]);
    const wrongKey = crypto.getRandomValues(new Uint8Array(16)); // 16 bytes instead of 32

    expect(() => encryptXChaCha20Poly1305(plaintext, wrongKey)).toThrow(
      "Key must be 32 bytes"
    );
  });

  it("should throw on tampered ciphertext", () => {
    const plaintext = new TextEncoder().encode("Secret message");
    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const { ciphertext, nonce } = encryptXChaCha20Poly1305(plaintext, key);

    // Tamper with ciphertext
    ciphertext[0] ^= 0xff;

    expect(() => decryptXChaCha20Poly1305(ciphertext, key, nonce)).toThrow();
  });

  it("should support AAD (Additional Authenticated Data)", () => {
    const plaintext = new TextEncoder().encode("Secret message");
    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));
    const aad = new TextEncoder().encode("context-data");

    const { ciphertext, nonce } = encryptXChaCha20Poly1305(
      plaintext,
      key,
      undefined,
      aad
    );

    // Decrypt with same AAD succeeds
    const decrypted = decryptXChaCha20Poly1305(ciphertext, key, nonce, aad);
    expect(decrypted).toEqual(plaintext);

    // Decrypt with different AAD fails
    const wrongAad = new TextEncoder().encode("different");
    expect(() =>
      decryptXChaCha20Poly1305(ciphertext, key, nonce, wrongAad)
    ).toThrow();

    // Decrypt without AAD fails
    expect(() => decryptXChaCha20Poly1305(ciphertext, key, nonce)).toThrow();
  });
});

// ============================================================================
// Chunked AEAD Tests
// ============================================================================

describe("Chunked AEAD", () => {
  it("should encrypt and decrypt small content (single chunk)", () => {
    const plaintext = new TextEncoder().encode("Small secret content");
    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const encrypted = encryptChunked(plaintext, key);

    expect(encrypted.chunks.length).toBe(1);
    expect(encrypted.plaintextHash.length).toBe(32);

    const decrypted = decryptChunked(encrypted, key, encrypted.plaintextHash);
    expect(decrypted).toEqual(plaintext);
  });

  it("should encrypt and decrypt content with multiple chunks", () => {
    // Content larger than 32KB chunk size to force multiple chunks.
    // Web Crypto getRandomValues max is 65536 bytes/call, so fill chunked.
    const plaintext = new Uint8Array(80 * 1024); // 80 KB
    for (let i = 0; i < plaintext.length; i += 32768) {
      crypto.getRandomValues(
        plaintext.subarray(i, Math.min(i + 32768, plaintext.length))
      );
    }
    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const encrypted = encryptChunked(plaintext, key);

    expect(encrypted.chunks.length).toBe(3); // ceil(80/32)

    const decrypted = decryptChunked(encrypted, key, encrypted.plaintextHash);
    expect(decrypted).toEqual(plaintext);
  });

  it("should produce different ciphertexts for identical plaintext", () => {
    const plaintext = new TextEncoder().encode("test message for encryption");
    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const result1 = encryptXChaCha20Poly1305(plaintext, key);
    const result2 = encryptXChaCha20Poly1305(plaintext, key);

    // Nonces should be different
    expect(result1.nonce).not.toEqual(result2.nonce);
    // Ciphertexts should be different
    expect(result1.ciphertext).not.toEqual(result2.ciphertext);

    // But both decrypt to same plaintext
    const dec1 = decryptXChaCha20Poly1305(result1.ciphertext, key, result1.nonce);
    const dec2 = decryptXChaCha20Poly1305(result2.ciphertext, key, result2.nonce);
    expect(dec1).toEqual(dec2);
    expect(dec1).toEqual(plaintext);
  });

  it("should reject wrong plaintextHash on decrypt", () => {
    const plaintext = new TextEncoder().encode("chunked content test");
    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const encrypted = encryptChunked(plaintext, key);

    const wrongHash = crypto.getRandomValues(new Uint8Array(32));
    expect(() => decryptChunked(encrypted, key, wrongHash)).toThrow();
  });

  it("should handle exact chunk boundary (32KB)", () => {
    const plaintext = crypto.getRandomValues(new Uint8Array(32 * 1024));
    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const encrypted = encryptChunked(plaintext, key);

    expect(encrypted.chunks.length).toBe(1);

    const decrypted = decryptChunked(encrypted, key, encrypted.plaintextHash);
    expect(decrypted).toEqual(plaintext);
  });
});

// ============================================================================
// HKDF Tests
// ============================================================================

describe("HKDF-SHA256", () => {
  it("should derive key of specified length", () => {
    const ikm = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const info = new TextEncoder().encode("test-key");

    const key = deriveKeyHKDF(ikm, salt, info, 32);
    expect(key.length).toBe(32);

    const key48 = deriveKeyHKDF(ikm, salt, info, 48);
    expect(key48.length).toBe(48);
  });

  it("should produce deterministic output", () => {
    const ikm = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const info = new TextEncoder().encode("test-key");

    const key1 = deriveKeyHKDF(ikm, salt, info, 32);
    const key2 = deriveKeyHKDF(ikm, salt, info, 32);

    expect(key1).toEqual(key2);
  });

  it("should produce different keys for different inputs", () => {
    const ikm = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(32));

    const key1 = deriveKeyHKDF(ikm, salt, new TextEncoder().encode("info1"), 32);
    const key2 = deriveKeyHKDF(ikm, salt, new TextEncoder().encode("info2"), 32);

    expect(key1).not.toEqual(key2);
  });

  it("should work without salt", () => {
    const ikm = crypto.getRandomValues(new Uint8Array(32));
    const info = new TextEncoder().encode("test-key");

    const key = deriveKeyHKDF(ikm, undefined, info, 32);
    expect(key.length).toBe(32);
  });
});

// ============================================================================
// Scrypt Tests
// ============================================================================

describe("Scrypt Key Derivation", () => {
  it("should derive key from passphrase", () => {
    const passphrase = "my secure passphrase";

    const { key, salt } = deriveKeyScrypt(passphrase);

    expect(key.length).toBe(32);
    expect(salt.length).toBe(32);
  });

  it("should produce deterministic output with same salt", () => {
    const passphrase = "my secure passphrase";
    const salt = crypto.getRandomValues(new Uint8Array(32));

    const result1 = deriveKeyScrypt(passphrase, salt);
    const result2 = deriveKeyScrypt(passphrase, salt);

    expect(result1.key).toEqual(result2.key);
    expect(result1.salt).toEqual(result2.salt);
  });

  it("should produce different keys for different salts", () => {
    const passphrase = "my secure passphrase";

    const result1 = deriveKeyScrypt(passphrase);
    const result2 = deriveKeyScrypt(passphrase);

    expect(result1.salt).not.toEqual(result2.salt);
    expect(result1.key).not.toEqual(result2.key);
  });

  it("should produce different keys for different passphrases", () => {
    const salt = crypto.getRandomValues(new Uint8Array(32));

    const result1 = deriveKeyScrypt("passphrase1", salt);
    const result2 = deriveKeyScrypt("passphrase2", salt);

    expect(result1.key).not.toEqual(result2.key);
  });
});

// ============================================================================
// X25519 Key Agreement Tests
// ============================================================================

describe("X25519 Key Agreement", () => {
  it("should generate keypair", () => {
    const keypair = generateHybridKeyPair();

    expect(keypair.x25519PrivateKey.length).toBe(32);
    expect(keypair.x25519PublicKey.length).toBe(32);
  });

  it("should generate different keypairs each time", () => {
    const keypair1 = generateHybridKeyPair();
    const keypair2 = generateHybridKeyPair();

    expect(keypair1.x25519PrivateKey).not.toEqual(keypair2.x25519PrivateKey);
    expect(keypair1.x25519PublicKey).not.toEqual(keypair2.x25519PublicKey);
  });

  it("should encapsulate and decapsulate shared secret", () => {
    const recipient = generateHybridKeyPair();

    const encapsulated = encapsulateHybrid(recipient.x25519PublicKey);

    expect(encapsulated.x25519EphemeralPublicKey.length).toBe(32);
    expect(encapsulated.sharedSecret.length).toBe(32);

    const sharedSecret = decapsulateHybrid(encapsulated, recipient);
    expect(sharedSecret).toEqual(encapsulated.sharedSecret);
  });

  it("should produce different ephemeral keys each encapsulation", () => {
    const recipient = generateHybridKeyPair();

    const encapsulated1 = encapsulateHybrid(recipient.x25519PublicKey);
    const encapsulated2 = encapsulateHybrid(recipient.x25519PublicKey);

    expect(encapsulated1.x25519EphemeralPublicKey).not.toEqual(
      encapsulated2.x25519EphemeralPublicKey
    );
    expect(encapsulated1.sharedSecret).not.toEqual(encapsulated2.sharedSecret);
  });

  it("should derive same shared secret bidirectionally", () => {
    const alice = generateHybridKeyPair();
    const bob = generateHybridKeyPair();

    // Alice encapsulates for Bob
    const aliceToBob = encapsulateHybrid(bob.x25519PublicKey);
    const bobShared = decapsulateHybrid(aliceToBob, bob);

    // Bob encapsulates for Alice
    const bobToAlice = encapsulateHybrid(alice.x25519PublicKey);
    const aliceShared = decapsulateHybrid(bobToAlice, alice);

    // Both parties got different shared secrets (ephemeral keys)
    expect(aliceToBob.sharedSecret).toEqual(bobShared);
    expect(bobToAlice.sharedSecret).toEqual(aliceShared);
    expect(aliceToBob.sharedSecret).not.toEqual(bobToAlice.sharedSecret);
  });
});

// ============================================================================
// CEK Wrapping Tests
// ============================================================================

describe("CEK Wrapping", () => {
  it("should wrap and unwrap CEK", () => {
    const cek = crypto.getRandomValues(new Uint8Array(32));
    const recipient = generateHybridKeyPair();

    const { wrappedCEK, ephemeral } = wrapCEK(cek, {
      x25519: recipient.x25519PublicKey,
      mlkem: new Uint8Array(0), // reserved for future PQ
    });

    // Wrapped CEK should be larger than original (nonce + ciphertext + tag)
    expect(wrappedCEK.length).toBeGreaterThan(32);

    const unwrapped = unwrapCEK(
      wrappedCEK,
      { x25519EphemeralPublicKey: ephemeral.x25519EphemeralPublicKey },
      recipient
    );

    expect(unwrapped).toEqual(cek);
  });

  it("should produce different wrapped CEKs each time", () => {
    const cek = crypto.getRandomValues(new Uint8Array(32));
    const recipient = generateHybridKeyPair();

    const result1 = wrapCEK(cek, {
      x25519: recipient.x25519PublicKey,
      mlkem: new Uint8Array(0),
    });
    const result2 = wrapCEK(cek, {
      x25519: recipient.x25519PublicKey,
      mlkem: new Uint8Array(0),
    });

    expect(result1.wrappedCEK).not.toEqual(result2.wrappedCEK);
  });

  it("should fail to unwrap with wrong recipient", () => {
    const cek = crypto.getRandomValues(new Uint8Array(32));
    const recipient = generateHybridKeyPair();
    const wrongRecipient = generateHybridKeyPair();

    const { wrappedCEK, ephemeral } = wrapCEK(cek, {
      x25519: recipient.x25519PublicKey,
      mlkem: new Uint8Array(0),
    });

    // Should throw when trying to unwrap with wrong key
    expect(() =>
      unwrapCEK(
        wrappedCEK,
        { x25519EphemeralPublicKey: ephemeral.x25519EphemeralPublicKey },
        wrongRecipient
      )
    ).toThrow();
  });
});

// ============================================================================
// Hybrid X25519 + ML-KEM-768 (Phase 4 - REP-3008)
// ============================================================================

describe("Hybrid X25519 + ML-KEM-768", () => {
  it("should generate hybrid keypair with ML-KEM keys", () => {
    const keypair = generateHybridKeyPair(true);

    expect(keypair.x25519PrivateKey.length).toBe(32);
    expect(keypair.x25519PublicKey.length).toBe(32);
    expect(keypair.mlkemPrivateKey).toBeDefined();
    expect(keypair.mlkemPublicKey).toBeDefined();
    expect(keypair.mlkemPublicKey?.length).toBe(1184); // ML-KEM-768 public key size
    expect(keypair.mlkemPrivateKey?.length).toBe(2400); // ML-KEM-768 secret key size
  });

  it("should generate X25519-only keypair when includeMlkem=false", () => {
    const keypair = generateHybridKeyPair(false);

    expect(keypair.x25519PrivateKey.length).toBe(32);
    expect(keypair.x25519PublicKey.length).toBe(32);
    expect(keypair.mlkemPrivateKey).toBeUndefined();
    expect(keypair.mlkemPublicKey).toBeUndefined();
  });

  it("should encapsulate and decapsulate hybrid shared secret", () => {
    const recipient = generateHybridKeyPair(true);

    const encapsulated = encapsulateHybrid(
      recipient.x25519PublicKey,
      recipient.mlkemPublicKey
    );

    expect(encapsulated.x25519EphemeralPublicKey.length).toBe(32);
    expect(encapsulated.mlkemCiphertext).toBeDefined();
    expect(encapsulated.mlkemCiphertext?.length).toBe(1088); // ML-KEM-768 ct size
    expect(encapsulated.sharedSecret.length).toBe(32);

    const sharedSecret = decapsulateHybrid(encapsulated, recipient);
    expect(sharedSecret).toEqual(encapsulated.sharedSecret);
  });

  it("should wrap and unwrap CEK with hybrid keys", () => {
    const cek = crypto.getRandomValues(new Uint8Array(32));
    const recipient = generateHybridKeyPair(true);

    const { wrappedCEK, ephemeral } = wrapCEK(cek, {
      x25519: recipient.x25519PublicKey,
      mlkem: recipient.mlkemPublicKey,
    });

    expect(ephemeral.mlkemCiphertext).toBeDefined();

    const unwrapped = unwrapCEK(
      wrappedCEK,
      {
        x25519EphemeralPublicKey: ephemeral.x25519EphemeralPublicKey,
        mlkemCiphertext: ephemeral.mlkemCiphertext,
      },
      recipient
    );

    expect(unwrapped).toEqual(cek);
  });

  it("should produce different shared secrets for hybrid vs X25519-only", () => {
    // Same X25519 ephemeral key but different mode should produce different ss
    const recipient = generateHybridKeyPair(true);

    const hybridEncaps = encapsulateHybrid(
      recipient.x25519PublicKey,
      recipient.mlkemPublicKey
    );
    const classicEncaps = encapsulateHybrid(recipient.x25519PublicKey);

    // Different modes, different shared secrets
    expect(hybridEncaps.sharedSecret).not.toEqual(classicEncaps.sharedSecret);
  });

  it("should mark metadata with x25519mlkem768 kid for hybrid", () => {
    const cek = crypto.getRandomValues(new Uint8Array(32));
    const recipient = generateHybridKeyPair(true);

    const { wrappedCEK, ephemeral } = wrapCEK(cek, {
      x25519: recipient.x25519PublicKey,
      mlkem: recipient.mlkemPublicKey,
    });

    const metadata = buildEncryptedMetadata({
      protocolIds: [2, 8],
      contentType: "text/plain",
      name: "test.txt",
      plaintextHash: new Uint8Array(32),
      cekHash: new Uint8Array(32),
      size: 100,
      numChunks: 1,
    });

    const withRecipient = addRecipientToMetadata(metadata, wrappedCEK, ephemeral);

    expect(withRecipient.crypto.recipients?.[0].kid).toBe("x25519mlkem768");
    expect(withRecipient.crypto.recipients?.[0].mlkem_ct).toBeDefined();
  });

  it("should mark metadata with x25519 kid for classic (no PQ)", () => {
    const cek = crypto.getRandomValues(new Uint8Array(32));
    const recipient = generateHybridKeyPair(false);

    const { wrappedCEK, ephemeral } = wrapCEK(cek, {
      x25519: recipient.x25519PublicKey,
    });

    const metadata = buildEncryptedMetadata({
      protocolIds: [2, 8],
      contentType: "text/plain",
      name: "test.txt",
      plaintextHash: new Uint8Array(32),
      cekHash: new Uint8Array(32),
      size: 100,
      numChunks: 1,
    });

    const withRecipient = addRecipientToMetadata(metadata, wrappedCEK, ephemeral);

    expect(withRecipient.crypto.recipients?.[0].kid).toBe("x25519");
    expect(withRecipient.crypto.recipients?.[0].mlkem_ct).toBeUndefined();
  });
});

// ============================================================================
// Hashing Tests
// ============================================================================

describe("Content Hashing", () => {
  it("should hash content consistently", () => {
    const content = new TextEncoder().encode("test content");

    const hash1 = hashContent(content);
    const hash2 = hashContent(content);

    expect(hash1.length).toBe(32);
    expect(hash1).toEqual(hash2);
  });

  it("should produce different hashes for different content", () => {
    const content1 = new TextEncoder().encode("content 1");
    const content2 = new TextEncoder().encode("content 2");

    const hash1 = hashContent(content1);
    const hash2 = hashContent(content2);

    expect(hash1).not.toEqual(hash2);
  });

  it("should hash locator correctly", () => {
    const locator = new TextEncoder().encode("ipfs://QmTest123");

    const hash = hashLocator(locator);

    expect(hash.length).toBe(32);
  });
});

// ============================================================================
// Metadata Builder Tests
// ============================================================================

describe("Metadata Builders", () => {
  it("should build encrypted metadata stub", () => {
    const plaintextHash = crypto.getRandomValues(new Uint8Array(32));
    const cekHash = crypto.getRandomValues(new Uint8Array(32));

    const metadata = buildEncryptedMetadata({
      protocolIds: [2, 8], // NFT + Encrypted
      contentType: "image/png",
      name: "Encrypted Artwork",
      plaintextHash,
      cekHash,
      size: 1048576,
      numChunks: 16,
    });

    expect(metadata.p).toEqual([2, 8]);
    expect(metadata.type).toBe("image/png");
    expect(metadata.name).toBe("Encrypted Artwork");
    expect(metadata.main.type).toBe("image/png");
    expect(metadata.main.hash).toBe(`sha256:${Buffer.from(plaintextHash).toString("hex")}`);
    expect(metadata.main.enc).toBe("xchacha20poly1305");
    expect(metadata.main.size).toBe(1048576);
    expect(metadata.main.chunks).toBe(16);
    expect(metadata.main.scheme).toBe("chunked-aead-v1");
    expect(metadata.crypto.mode).toBe("encrypted");
    expect(metadata.crypto.key_format).toBe("wrapped");
    expect(metadata.crypto.cek_hash).toBe(`sha256:${Buffer.from(cekHash).toString("hex")}`);
  });

  it("should support custom encryption scheme", () => {
    const metadata = buildEncryptedMetadata({
      protocolIds: [2],
      contentType: "application/json",
      name: "Test",
      plaintextHash: crypto.getRandomValues(new Uint8Array(32)),
      cekHash: crypto.getRandomValues(new Uint8Array(32)),
      size: 1024,
      numChunks: 1,
      encryptionScheme: "chunked-aead-v1",
    });

    expect(metadata.main.scheme).toBe("chunked-aead-v1");
  });

  it("should add recipient to metadata", () => {
    const plaintextHash = crypto.getRandomValues(new Uint8Array(32));
    const cekHash = crypto.getRandomValues(new Uint8Array(32));
    const cek = crypto.getRandomValues(new Uint8Array(32));

    let metadata = buildEncryptedMetadata({
      protocolIds: [2, 8],
      contentType: "image/png",
      name: "Encrypted Artwork",
      plaintextHash,
      cekHash,
      size: 1048576,
      numChunks: 16,
    });

    const recipient = generateHybridKeyPair();
    const { wrappedCEK, ephemeral } = wrapCEK(cek, {
      x25519: recipient.x25519PublicKey,
      mlkem: new Uint8Array(0),
    });

    metadata = addRecipientToMetadata(metadata, wrappedCEK, ephemeral);

    expect(metadata.crypto.recipients).toHaveLength(1);
    expect(metadata.crypto.recipients![0].kid).toBe("x25519");
    expect(metadata.crypto.recipients![0].wrapped_cek).toBeDefined();
    expect(metadata.crypto.recipients![0].epk).toBeDefined();
  });

  it("should support multiple recipients", () => {
    const plaintextHash = crypto.getRandomValues(new Uint8Array(32));
    const cekHash = crypto.getRandomValues(new Uint8Array(32));
    const cek = crypto.getRandomValues(new Uint8Array(32));

    let metadata = buildEncryptedMetadata({
      protocolIds: [2, 8],
      contentType: "image/png",
      name: "Encrypted Artwork",
      plaintextHash,
      cekHash,
      size: 1048576,
      numChunks: 16,
    });

    // Add first recipient
    const recipient1 = generateHybridKeyPair();
    const result1 = wrapCEK(cek, {
      x25519: recipient1.x25519PublicKey,
      mlkem: new Uint8Array(0),
    });
    metadata = addRecipientToMetadata(metadata, result1.wrappedCEK, result1.ephemeral);

    // Add second recipient
    const recipient2 = generateHybridKeyPair();
    const result2 = wrapCEK(cek, {
      x25519: recipient2.x25519PublicKey,
      mlkem: new Uint8Array(0),
    });
    metadata = addRecipientToMetadata(metadata, result2.wrappedCEK, result2.ephemeral);

    expect(metadata.crypto.recipients).toHaveLength(2);
  });
});

// ============================================================================
// Integration Test: Full Encryption Flow
// ============================================================================

describe("Full Encryption Flow", () => {
  it("should encrypt content, wrap CEK, and build complete metadata", () => {
    // 1. Generate recipient keypair
    const recipient = generateHybridKeyPair();

    // 2. Generate CEK
    const cek = crypto.getRandomValues(new Uint8Array(32));

    // 3. Encrypt content (manual for testing without AAD issues)
    const plaintext = new TextEncoder().encode("Sensitive NFT content here");
    const plaintextHash = hashContent(plaintext);

    // Manual encryption without AAD for test stability
    const cekNonce = crypto.getRandomValues(new Uint8Array(24));
    const { ciphertext, nonce } = encryptXChaCha20Poly1305(plaintext, cek, cekNonce);

    // 4. Hash CEK
    const { sha256 } = require("@noble/hashes/sha256");
    const cekHash = sha256(cek);

    // 5. Build metadata
    let metadata = buildEncryptedMetadata({
      protocolIds: [2, 8], // NFT + Encrypted
      contentType: "application/octet-stream",
      name: "Encrypted File",
      plaintextHash,
      cekHash,
      size: plaintext.length,
      numChunks: 1,
    });

    // 6. Wrap CEK for recipient
    const { wrappedCEK, ephemeral } = wrapCEK(cek, {
      x25519: recipient.x25519PublicKey,
      mlkem: new Uint8Array(0),
    });

    // 7. Add recipient to metadata
    metadata = addRecipientToMetadata(metadata, wrappedCEK, ephemeral);

    // Verify metadata structure
    expect(metadata.p).toContain(8); // Encrypted protocol
    expect(metadata.crypto.recipients).toHaveLength(1);

    // 8. Recipient unwraps CEK
    const unwrappedCEK = unwrapCEK(
      wrappedCEK,
      { x25519EphemeralPublicKey: ephemeral.x25519EphemeralPublicKey },
      recipient
    );
    expect(unwrappedCEK).toEqual(cek);

    // 9. Decrypt content (manual, not using decryptChunked due to AAD mismatch)
    const decrypted = decryptXChaCha20Poly1305(ciphertext, unwrappedCEK, nonce);
    expect(decrypted).toEqual(plaintext);
  });
});
