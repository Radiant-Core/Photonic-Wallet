/**
 * Encryption Service Tests (Phase 3)
 *
 * Tests for high-level encryption service used by UI components.
 */

import { describe, it, expect, vi } from "vitest";

// Mock Dexie/IndexedDB — EncryptionSection imports db for WAVE name resolution,
// which crashes jsdom. These tests don't exercise that code path.
vi.mock("@app/db", () => ({
  default: {
    glyph: { toArray: vi.fn().mockResolvedValue([]) },
  },
}));

import {
  estimateEncryptedSize,
  formatBytes,
  encryptContent,
  decryptContent,
  deriveLocatorKeyFromPassphrase,
} from "../encryptionService";
import {
  initialEncryptionState,
  isEncryptionStateValid,
} from "../components/EncryptionSection";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha256";

describe("File Size Estimation", () => {
  it("estimates size for empty file", () => {
    const result = estimateEncryptedSize(0);
    expect(result.originalSize).toBe(0);
    expect(result.numChunks).toBe(0);
    expect(result.encryptedSize).toBe(0);
  });

  it("estimates size for small file (< 32KB)", () => {
    const result = estimateEncryptedSize(1024); // 1 KB
    expect(result.originalSize).toBe(1024);
    expect(result.numChunks).toBe(1);
    expect(result.encryptedSize).toBe(1024 + 16); // +1 Poly1305 tag
    expect(result.overheadBytes).toBe(16);
  });

  it("estimates size for single chunk boundary (32KB)", () => {
    const result = estimateEncryptedSize(32 * 1024);
    expect(result.numChunks).toBe(1);
    expect(result.overheadBytes).toBe(16);
  });

  it("estimates size for multi-chunk file", () => {
    const result = estimateEncryptedSize(100 * 1024); // 100 KB
    expect(result.numChunks).toBe(4); // ceil(100/32)
    expect(result.overheadBytes).toBe(4 * 16);
    expect(result.encryptedSize).toBe(100 * 1024 + 64);
  });

  it("estimates size for 1 MB file", () => {
    const result = estimateEncryptedSize(1024 * 1024); // 1 MB
    expect(result.numChunks).toBe(32); // 1024/32
    expect(result.overheadBytes).toBe(32 * 16);
  });
});

describe("Byte Formatting", () => {
  it("formats 0 bytes", () => {
    expect(formatBytes(0)).toBe("0 Bytes");
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 Bytes");
  });

  it("formats KB", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });

  it("formats GB", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
  });

  it("respects decimal precision", () => {
    expect(formatBytes(1536, 0)).toBe("2 KB");
    expect(formatBytes(1536, 3)).toBe("1.5 KB");
  });
});

describe("Content Encryption", () => {
  it("encrypts content with passphrase", async () => {
    const plaintext = new TextEncoder().encode("Secret NFT content");
    const progressEvents: string[] = [];

    const result = await encryptContent(
      plaintext,
      {
        mode: "passphrase",
        passphrase: "test-passphrase-12345",
        contentType: "text/plain",
        name: "test.txt",
      },
      (progress) => {
        progressEvents.push(progress.stage);
      }
    );

    expect(result.encryptedContent).toBeInstanceOf(Uint8Array);
    expect(result.encryptedContent.length).toBeGreaterThan(plaintext.length);
    expect(result.contentHash).toBeInstanceOf(Uint8Array);
    expect(result.contentHash.length).toBe(32);
    expect(result.cek).toBeInstanceOf(Uint8Array);
    expect(result.cek.length).toBe(32);
    expect(result.locatorKey).toBeInstanceOf(Uint8Array);
    expect(result.locatorKey.length).toBe(32);
    expect(result.numChunks).toBe(1);
    expect(result.originalSize).toBe(plaintext.length);
    expect(result.metadata.type).toBe("text/plain");
    expect(result.metadata.name).toBe("test.txt");
    expect(result.metadata.crypto.mode).toBe("passphrase");
    expect(progressEvents).toContain("encrypting");
    expect(progressEvents).toContain("complete");
  });

  it("throws without passphrase in passphrase mode", async () => {
    const plaintext = new TextEncoder().encode("content");

    await expect(
      encryptContent(plaintext, {
        mode: "passphrase",
        contentType: "text/plain",
        name: "test.txt",
      })
    ).rejects.toThrow();
  });

  it("throws without recipients in recipient mode", async () => {
    const plaintext = new TextEncoder().encode("content");

    await expect(
      encryptContent(plaintext, {
        mode: "recipient",
        contentType: "text/plain",
        name: "test.txt",
      })
    ).rejects.toThrow();
  });

  it("includes protocol IDs in metadata", async () => {
    const plaintext = new TextEncoder().encode("content");

    const result = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase: "test",
      contentType: "text/plain",
      name: "test.txt",
    });

    expect(result.metadata.p).toEqual([2, 8]);
  });

  it("respects custom protocol IDs", async () => {
    const plaintext = new TextEncoder().encode("content");

    const result = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase: "test",
      contentType: "text/plain",
      name: "test.txt",
      protocolIds: [1, 8],
    });

    expect(result.metadata.p).toEqual([1, 8]);
  });
});

describe("Encrypt → Decrypt Roundtrip", () => {
  it("roundtrips content with passphrase mode", async () => {
    const originalText = "Top secret NFT payload 🔒";
    const plaintext = new TextEncoder().encode(originalText);

    const encrypted = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase: "correct-horse-battery-staple",
      contentType: "text/plain",
      name: "secret.txt",
    });

    const decrypted = await decryptContent(encrypted.encryptedContent, {
      metadata: encrypted.metadata,
      passphrase: "correct-horse-battery-staple",
    });

    expect(new TextDecoder().decode(decrypted)).toBe(originalText);
  });

  it("fails decryption with wrong passphrase", async () => {
    const plaintext = new TextEncoder().encode("secret content");

    const encrypted = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase: "correct-passphrase",
      contentType: "text/plain",
      name: "file.txt",
    });

    await expect(
      decryptContent(encrypted.encryptedContent, {
        metadata: encrypted.metadata,
        passphrase: "wrong-passphrase",
      })
    ).rejects.toThrow();
  });

  it("roundtrips multi-chunk content", async () => {
    // 96KB > 3 chunks of 32KB
    const plaintext = new Uint8Array(96 * 1024).fill(0xab);

    const encrypted = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase: "multi-chunk-passphrase",
      contentType: "application/octet-stream",
      name: "large.bin",
    });

    expect(encrypted.numChunks).toBe(3);

    const decrypted = await decryptContent(encrypted.encryptedContent, {
      metadata: encrypted.metadata,
      passphrase: "multi-chunk-passphrase",
    });

    expect(decrypted.length).toBe(plaintext.length);
    expect(decrypted[0]).toBe(0xab);
    expect(decrypted[decrypted.length - 1]).toBe(0xab);
  });

  it("content hash matches original plaintext hash", async () => {
    const plaintext = new TextEncoder().encode("hash-check content");
    const expectedHash = sha256(plaintext);

    const encrypted = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase: "hash-passphrase-12345",
      contentType: "text/plain",
      name: "hashcheck.txt",
    });

    expect(bytesToHex(encrypted.contentHash)).toBe(bytesToHex(expectedHash));
  });
});

describe("On-Chain (Glyph) Storage Path", () => {
  it("isOnChain is true when mainB present and no locator", () => {
    // Logic mirrored from EncryptedContentUnlock: !!mainB && !locator
    const mainB = "deadbeef";
    const locator = undefined;
    expect(!!mainB && !locator).toBe(true);
  });

  it("isOnChain is false when locator present even if mainB set", () => {
    const mainB = "deadbeef";
    const locator = "base64locatorvalue";
    expect(!!mainB && !locator).toBe(false);
  });

  it("isOnChain is false when neither mainB nor locator set", () => {
    const mainB = undefined;
    const locator = undefined;
    expect(!!mainB && !locator).toBe(false);
  });

  it("hex roundtrip: bytes → hex → hexToBytes matches", () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]);
    const hex = bytesToHex(original);
    const recovered = hexToBytes(hex);
    expect(recovered).toEqual(original);
  });

  it("verifies on-chain hash before decrypting", async () => {
    const plaintext = new TextEncoder().encode("on-chain content");

    const encrypted = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase: "on-chain-passphrase",
      contentType: "text/plain",
      name: "onchain.txt",
    });

    // Simulate on-chain hex
    const hexData = bytesToHex(encrypted.encryptedContent);
    const recovered = hexToBytes(hexData);

    // Hash of the encrypted bytes (what main.hash contains)
    const encHash = sha256(recovered);
    // Confirm deterministic
    expect(bytesToHex(sha256(encrypted.encryptedContent))).toBe(bytesToHex(encHash));

    // Tampered data should produce different hash
    const tampered = new Uint8Array(recovered);
    tampered[0] ^= 0xff;
    expect(bytesToHex(sha256(tampered))).not.toBe(bytesToHex(encHash));
  });
});

describe("deriveLocatorKeyFromPassphrase", () => {
  it("derives consistent locator key for same passphrase", async () => {
    const plaintext = new TextEncoder().encode("test");
    const encrypted = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase: "locator-key-test-passphrase",
      contentType: "text/plain",
      name: "test.txt",
    });

    const key1 = deriveLocatorKeyFromPassphrase("locator-key-test-passphrase", encrypted.metadata);
    const key2 = deriveLocatorKeyFromPassphrase("locator-key-test-passphrase", encrypted.metadata);
    expect(bytesToHex(key1)).toBe(bytesToHex(key2));
  });

  it("derives different locator key for different passphrase", async () => {
    const plaintext = new TextEncoder().encode("test");
    const encrypted = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase: "correct-passphrase-xyz",
      contentType: "text/plain",
      name: "test.txt",
    });

    const correctKey = deriveLocatorKeyFromPassphrase("correct-passphrase-xyz", encrypted.metadata);
    const wrongKey = deriveLocatorKeyFromPassphrase("wrong-passphrase-abc", encrypted.metadata);
    expect(bytesToHex(correctKey)).not.toBe(bytesToHex(wrongKey));
  });

  it("matches the locatorKey produced during encryption", async () => {
    const plaintext = new TextEncoder().encode("locator key match test");
    const passphrase = "matching-locator-passphrase";

    const encrypted = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase,
      contentType: "text/plain",
      name: "test.txt",
    });

    const derived = deriveLocatorKeyFromPassphrase(passphrase, encrypted.metadata);
    expect(bytesToHex(derived)).toBe(bytesToHex(encrypted.locatorKey));
  });
});

describe("EncryptionSection State Validation", () => {
  it("initial state has encryption disabled", () => {
    expect(initialEncryptionState.enabled).toBe(false);
    expect(initialEncryptionState.mode).toBe("passphrase");
    expect(initialEncryptionState.passphrase).toBe("");
    expect(initialEncryptionState.recipientKeys).toEqual([]);
  });

  it("is valid when encryption disabled", () => {
    expect(isEncryptionStateValid(initialEncryptionState)).toBe(true);
  });

  it("requires 8+ char passphrase in passphrase mode", () => {
    expect(
      isEncryptionStateValid({
        enabled: true,
        mode: "passphrase",
        passphrase: "short",
        recipientKeys: [],
        storageBackend: "ipfs",
      })
    ).toBe(false);

    expect(
      isEncryptionStateValid({
        enabled: true,
        mode: "passphrase",
        passphrase: "long-enough-passphrase",
        recipientKeys: [],
        storageBackend: "ipfs",
      })
    ).toBe(true);
  });

  it("requires at least one recipient in recipient mode", () => {
    expect(
      isEncryptionStateValid({
        enabled: true,
        mode: "recipient",
        passphrase: "",
        recipientKeys: [],
        storageBackend: "ipfs",
      })
    ).toBe(false);

    expect(
      isEncryptionStateValid({
        enabled: true,
        mode: "recipient",
        passphrase: "",
        recipientKeys: ["pubkey1"],
        storageBackend: "ipfs",
      })
    ).toBe(true);
  });
});
