/**
 * Encryption Service Tests (Phase 3)
 *
 * Tests for high-level encryption service used by UI components.
 */

import { describe, it, expect } from "vitest";
import {
  estimateEncryptedSize,
  formatBytes,
  encryptContent,
} from "../encryptionService";
import {
  initialEncryptionState,
  isEncryptionStateValid,
} from "../components/EncryptionSection";

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
