/**
 * Storage Module Tests
 * Tests for Phase 2: Off-Chain Storage Layer
 */

import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest";
import {
  encryptLocator,
  decryptLocator,
  LocalStorageAdapter,
  BackendAdapter,
  StorageManager,
  IPFSAdapter,
} from "../storage";
import { XCHACHA20_KEY_SIZE } from "../encryption";
import { sha256 } from "@noble/hashes/sha256";

// Mock localStorage for Node.js environment
const mockStorage: Record<string, string> = {};

beforeAll(() => {
  Object.defineProperty(global, "localStorage", {
    value: {
      getItem: (key: string) => mockStorage[key] || null,
      setItem: (key: string, value: string) => {
        mockStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
      },
    },
    writable: true,
  });
});

// ============================================================================
// Locator Encryption Tests
// ============================================================================

describe("Locator Encryption", () => {
  it("should encrypt and decrypt a locator", () => {
    const locator = {
      backend: "local" as const,
      contentHash: "sha256:abc123...",
      pointer: "test-key-123",
    };

    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const { encrypted, nonce } = encryptLocator(locator, key);

    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(encrypted.length).toBeGreaterThan(0);
    expect(nonce.length).toBe(24);

    const decrypted = decryptLocator(encrypted, nonce, key);
    expect(decrypted).toEqual(locator);
  });

  it("should throw on wrong key size for encryption", () => {
    const locator = {
      backend: "local" as const,
      contentHash: "sha256:abc123...",
      pointer: "test-key-123",
    };

    const wrongKey = crypto.getRandomValues(new Uint8Array(16));

    expect(() => encryptLocator(locator, wrongKey)).toThrow(
      "Locator encryption key must be 32 bytes"
    );
  });

  it("should throw on wrong key size for decryption", () => {
    const encrypted = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const wrongKey = crypto.getRandomValues(new Uint8Array(16));

    expect(() => decryptLocator(encrypted, nonce, wrongKey)).toThrow(
      "Locator decryption key must be 32 bytes"
    );
  });

  it("should throw on wrong nonce size", () => {
    const encrypted = crypto.getRandomValues(new Uint8Array(32));
    const wrongNonce = crypto.getRandomValues(new Uint8Array(12));
    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    expect(() => decryptLocator(encrypted, wrongNonce, key)).toThrow(
      "Locator nonce must be 24 bytes"
    );
  });

  it("should produce different ciphertexts for same locator", () => {
    const locator = {
      backend: "local" as const,
      contentHash: "sha256:abc123...",
      pointer: "test-key-123",
    };

    const key = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const result1 = encryptLocator(locator, key);
    const result2 = encryptLocator(locator, key);

    expect(result1.encrypted).not.toEqual(result2.encrypted);
    expect(result1.nonce).not.toEqual(result2.nonce);

    // Both decrypt to same value
    expect(decryptLocator(result1.encrypted, result1.nonce, key)).toEqual(locator);
    expect(decryptLocator(result2.encrypted, result2.nonce, key)).toEqual(locator);
  });
});

// ============================================================================
// LocalStorage Adapter Tests
// ============================================================================

describe("LocalStorage Adapter", () => {
  let adapter: LocalStorageAdapter;

  beforeEach(() => {
    adapter = new LocalStorageAdapter();
    // Clear localStorage before each test
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
  });

  it("should check availability", () => {
    expect(adapter.isAvailable()).toBe(true);
  });

  it("should upload and download small data", async () => {
    const data = new TextEncoder().encode("Hello, encrypted world!");
    const contentHash = crypto.getRandomValues(new Uint8Array(32));
    // Overwrite with real hash of data

    const realHash = sha256(data);

    const pointer = await adapter.upload(data, realHash);
    expect(pointer).toBeDefined();

    const downloaded = await adapter.download(pointer, realHash);
    expect(downloaded).toEqual(data);
  });

  it("should verify hash on download", async () => {
    const data = new TextEncoder().encode("Test data");

    const realHash = sha256(data);

    const pointer = await adapter.upload(data, realHash);

    const wrongHash = crypto.getRandomValues(new Uint8Array(32));
    await expect(adapter.download(pointer, wrongHash)).rejects.toThrow(
      "hash mismatch"
    );
  });

  it("should throw on missing blob", async () => {
    const missingPointer = "nonexistent-key";
    const contentHash = crypto.getRandomValues(new Uint8Array(32));

    await expect(
      adapter.download(missingPointer, contentHash)
    ).rejects.toThrow("Blob not found");
  });

  it("should call progress callback during upload", async () => {
    const data = new TextEncoder().encode("Progress test data");

    const realHash = sha256(data);
    const progressFn = vi.fn();

    await adapter.upload(data, realHash, progressFn);

    expect(progressFn).toHaveBeenCalledWith(
      data.length,
      data.length,
      "uploading"
    );
  });

  it("should call progress callback during download", async () => {
    const data = new TextEncoder().encode("Progress test data");

    const realHash = sha256(data);
    const pointer = await adapter.upload(data, realHash);
    const progressFn = vi.fn();

    await adapter.download(pointer, realHash, progressFn);

    expect(progressFn).toHaveBeenCalledWith(
      data.length,
      data.length,
      "verifying"
    );
  });

  it("should enforce size limit", async () => {
    const smallAdapter = new LocalStorageAdapter(100); // 100 bytes max
    const largeData = new TextEncoder().encode("a".repeat(200));
    const contentHash = crypto.getRandomValues(new Uint8Array(32));

    await expect(smallAdapter.upload(largeData, contentHash)).rejects.toThrow(
      "exceeds localStorage max"
    );
  });
});

// ============================================================================
// Backend Adapter Tests
// ============================================================================

describe("Backend Adapter", () => {
  it("should check availability with config", () => {
    const adapter = new BackendAdapter({
      baseUrl: "https://api.example.com",
    });

    expect(adapter.isAvailable()).toBe(true);
  });

  it("should check availability without config", () => {
    const adapter = new BackendAdapter({
      baseUrl: "",
    });

    expect(adapter.isAvailable()).toBe(false);
  });
});

// ============================================================================
// IPFS Adapter Tests
// ============================================================================

describe("IPFS Adapter", () => {
  it("should check availability with API key", () => {
    const adapter = new IPFSAdapter({
      apiKey: "test-key",
    });

    expect(adapter.isAvailable()).toBe(true);
  });

  it("should check availability without API key", () => {
    const adapter = new IPFSAdapter({
      apiKey: "",
    });

    expect(adapter.isAvailable()).toBe(false);
  });
});

// ============================================================================
// Storage Manager Tests
// ============================================================================

describe("Storage Manager", () => {
  beforeEach(() => {
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
  });

  it("should initialize with local adapter", () => {
    const manager = new StorageManager({
      defaultAdapter: "local",
      local: {},
    });

    expect(manager.isAvailable("local")).toBe(true);
    expect(manager.getDefaultAdapter().name).toBe("local");
  });

  it("should throw on missing adapter", () => {
    const manager = new StorageManager({
      defaultAdapter: "local",
    });

    expect(() => manager.getAdapter("backend")).toThrow(
      "Storage adapter not found: backend"
    );
  });

  it("should upload encrypted data and return locator", async () => {
    const manager = new StorageManager({
      defaultAdapter: "local",
      local: {},
    });

    const encryptedData = crypto.getRandomValues(new Uint8Array(100));
    const locatorKey = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const result = await manager.uploadEncrypted(encryptedData, locatorKey);

    expect(result.contentHash).toBeInstanceOf(Uint8Array);
    expect(result.encryptedLocator).toBeInstanceOf(Uint8Array);
    expect(result.locatorNonce).toBeInstanceOf(Uint8Array);
    expect(result.bytesUploaded).toBe(encryptedData.length);
    expect(result.chunksUploaded).toBe(1);
  });

  it("should download encrypted data from locator", async () => {
    const manager = new StorageManager({
      defaultAdapter: "local",
      local: {},
    });

    const encryptedData = crypto.getRandomValues(new Uint8Array(100));
    const locatorKey = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const uploadResult = await manager.uploadEncrypted(encryptedData, locatorKey);

    const downloadResult = await manager.downloadEncrypted(
      uploadResult.encryptedLocator,
      uploadResult.locatorNonce,
      locatorKey
    );

    expect(downloadResult.plaintext).toEqual(encryptedData);
    expect(downloadResult.verified).toBe(true);
  });

  it("should throw on wrong locator key during download", async () => {
    const manager = new StorageManager({
      defaultAdapter: "local",
      local: {},
    });

    const encryptedData = crypto.getRandomValues(new Uint8Array(100));
    const locatorKey = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));
    const wrongKey = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const uploadResult = await manager.uploadEncrypted(encryptedData, locatorKey);

    await expect(
      manager.downloadEncrypted(
        uploadResult.encryptedLocator,
        uploadResult.locatorNonce,
        wrongKey
      )
    ).rejects.toThrow();
  });
});

// ============================================================================
// Full Integration Flow
// ============================================================================

describe("Storage Full Integration", () => {
  beforeEach(() => {
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
  });

  it("should complete full upload-download cycle", async () => {
    const manager = new StorageManager({
      defaultAdapter: "local",
      local: {},
    });

    // 1. Simulate encrypted content (from Phase 1 encryption)
    const originalPlaintext = new TextEncoder().encode(
      "Sensitive NFT content for testing storage layer"
    );
    const encryptedContent = crypto.getRandomValues(
      new Uint8Array(originalPlaintext.length + 16) // Simulate ciphertext with tag
    );

    // 2. Upload encrypted content
    const locatorKey = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));
    const uploadResult = await manager.uploadEncrypted(
      encryptedContent,
      locatorKey
    );

    // 3. Verify upload result
    expect(uploadResult.contentHash.length).toBe(32);
    expect(uploadResult.encryptedLocator.length).toBeGreaterThan(0);
    expect(uploadResult.locatorNonce.length).toBe(24);

    // 4. Download encrypted content
    const downloadResult = await manager.downloadEncrypted(
      uploadResult.encryptedLocator,
      uploadResult.locatorNonce,
      locatorKey
    );

    // 5. Verify downloaded content
    expect(downloadResult.plaintext).toEqual(encryptedContent);
    expect(downloadResult.verified).toBe(true);
    expect(downloadResult.contentHash).toEqual(uploadResult.contentHash);
  });

  it("should track upload progress", async () => {
    const manager = new StorageManager({
      defaultAdapter: "local",
      local: {},
    });

    const encryptedData = new Uint8Array(1000);
    const locatorKey = crypto.getRandomValues(new Uint8Array(XCHACHA20_KEY_SIZE));

    const progressEvents: Array<{ loaded: number; total: number; stage: string }> = [];

    await manager.uploadEncrypted(encryptedData, locatorKey, {
      onProgress: (loaded, total, stage) => {
        progressEvents.push({ loaded, total, stage });
      },
    });

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.some((e) => e.stage === "uploading")).toBe(true);
  });
});
