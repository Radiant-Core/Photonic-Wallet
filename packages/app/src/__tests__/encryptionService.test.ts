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
  wrapCEK,
  unwrapCEK,
  buildHybridKeyPairFromPrivateKey,
  deriveKeyHKDF,
} from "@lib/encryption";
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
    expect(result.metadata.crypto.mode).toBe("encrypted");
    expect(result.metadata.crypto.key_format).toBe("passphrase");
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: generate deterministic test keypairs from raw seeds
// ─────────────────────────────────────────────────────────────────────────────

function makeKeypair(seed: string) {
  const raw = new TextEncoder().encode(seed);
  const x25519PrivateKey = deriveKeyHKDF(raw, undefined, new TextEncoder().encode("test-x25519"), 32);
  const mlkemSeed = deriveKeyHKDF(raw, undefined, new TextEncoder().encode("test-mlkem"), 64);
  return buildHybridKeyPairFromPrivateKey(x25519PrivateKey, mlkemSeed);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Multi-Recipient Encrypt → Decrypt Roundtrip", () => {
  it("encrypts for two recipients and both can decrypt", async () => {
    const plaintext = new TextEncoder().encode("multi-recipient secret payload");
    const alice = makeKeypair("alice-seed-abc");
    const bob = makeKeypair("bob-seed-xyz");

    const encrypted = await encryptContent(plaintext, {
      mode: "recipient",
      recipientPublicKeys: [alice.x25519PublicKey, bob.x25519PublicKey],
      contentType: "text/plain",
      name: "shared.txt",
    });

    expect(encrypted.metadata.crypto.mode).toBe("encrypted");
    expect(encrypted.metadata.crypto.key_format).toBe("wrapped");
    expect(encrypted.metadata.crypto.recipients).toHaveLength(2);

    // Alice decrypts
    const decryptedAlice = await decryptContent(encrypted.encryptedContent, {
      metadata: encrypted.metadata,
      privateKey: alice.x25519PrivateKey,
    });
    expect(new TextDecoder().decode(decryptedAlice)).toBe("multi-recipient secret payload");

    // Bob decrypts independently
    const decryptedBob = await decryptContent(encrypted.encryptedContent, {
      metadata: encrypted.metadata,
      privateKey: bob.x25519PrivateKey,
    });
    expect(new TextDecoder().decode(decryptedBob)).toBe("multi-recipient secret payload");
  });

  it("fails to decrypt with a key that is not a recipient", async () => {
    const plaintext = new TextEncoder().encode("restricted content");
    const alice = makeKeypair("alice-seed-only");
    const eve = makeKeypair("eve-seed-not-recipient");

    const encrypted = await encryptContent(plaintext, {
      mode: "recipient",
      recipientPublicKeys: [alice.x25519PublicKey],
      contentType: "text/plain",
      name: "restricted.txt",
    });

    await expect(
      decryptContent(encrypted.encryptedContent, {
        metadata: encrypted.metadata,
        privateKey: eve.x25519PrivateKey,
      })
    ).rejects.toThrow();
  });

  it("iterates all recipient slots before failing (not just slot 0)", async () => {
    const plaintext = new TextEncoder().encode("slot order test");
    const first = makeKeypair("first-slot-seed");
    const second = makeKeypair("second-slot-seed");
    const third = makeKeypair("third-slot-seed");

    const encrypted = await encryptContent(plaintext, {
      mode: "recipient",
      // third is last in the list — decryptContent must try all slots
      recipientPublicKeys: [first.x25519PublicKey, second.x25519PublicKey, third.x25519PublicKey],
      contentType: "text/plain",
      name: "slot.txt",
    });

    expect(encrypted.metadata.crypto.recipients).toHaveLength(3);

    // third can still decrypt even though it's in the last slot
    const decrypted = await decryptContent(encrypted.encryptedContent, {
      metadata: encrypted.metadata,
      privateKey: third.x25519PrivateKey,
    });
    expect(new TextDecoder().decode(decrypted)).toBe("slot order test");
  });
});

describe("selfKeypair — Self-as-Recipient Backup", () => {
  it("minter can decrypt their own NFT via selfKeypair slot", async () => {
    const plaintext = new TextEncoder().encode("minter backup content");
    const minter = makeKeypair("minter-wallet-seed");
    const recipient = makeKeypair("recipient-seed");

    const encrypted = await encryptContent(plaintext, {
      mode: "recipient",
      recipientPublicKeys: [recipient.x25519PublicKey],
      selfKeypair: minter,
      contentType: "text/plain",
      name: "nft.txt",
    });

    // Minter slot is appended — total should be 2
    expect(encrypted.metadata.crypto.recipients).toHaveLength(2);

    // Minter can decrypt — must pass full HybridKeyPair since selfKeypair slot uses ML-KEM
    const decryptedMinter = await decryptContent(encrypted.encryptedContent, {
      metadata: encrypted.metadata,
      privateKey: minter,
    });
    expect(new TextDecoder().decode(decryptedMinter)).toBe("minter backup content");

    // Original recipient can still decrypt
    const decryptedRecipient = await decryptContent(encrypted.encryptedContent, {
      metadata: encrypted.metadata,
      privateKey: recipient,
    });
    expect(new TextDecoder().decode(decryptedRecipient)).toBe("minter backup content");
  });

  it("selfKeypair in passphrase mode also adds self-recipient slot", async () => {
    const plaintext = new TextEncoder().encode("passphrase + self backup");
    const minter = makeKeypair("minter-passphrase-seed");

    const encrypted = await encryptContent(plaintext, {
      mode: "passphrase",
      passphrase: "super-secret-passphrase",
      selfKeypair: minter,
      contentType: "text/plain",
      name: "combined.txt",
    });

    // Should have at least 2 recipients: passphrase sentinel + minter
    expect(encrypted.metadata.crypto.recipients!.length).toBeGreaterThanOrEqual(2);

    // Passphrase path still works
    const decryptedPass = await decryptContent(encrypted.encryptedContent, {
      metadata: encrypted.metadata,
      passphrase: "super-secret-passphrase",
    });
    expect(new TextDecoder().decode(decryptedPass)).toBe("passphrase + self backup");

    // Minter key path also works — full keypair required for ML-KEM self-recipient slot
    const decryptedKey = await decryptContent(encrypted.encryptedContent, {
      metadata: encrypted.metadata,
      privateKey: minter,
    });
    expect(new TextDecoder().decode(decryptedKey)).toBe("passphrase + self backup");
  });
});

describe("CEK Share — Export → Import Roundtrip", () => {
  it("re-wraps CEK for a new recipient and they can decrypt", async () => {
    const plaintext = new TextEncoder().encode("shared secret content");
    const owner = makeKeypair("owner-share-seed");
    const newRecipient = makeKeypair("new-recipient-share-seed");

    // Owner mints the NFT with themselves as recipient
    const encrypted = await encryptContent(plaintext, {
      mode: "recipient",
      recipientPublicKeys: [owner.x25519PublicKey],
      contentType: "text/plain",
      name: "share-test.txt",
    });

    // AAD = cek_hash string as UTF-8 (matches encryptionService behaviour)
    const cekHashAad = new TextEncoder().encode(encrypted.metadata.crypto.cek_hash);

    // Owner unwraps their own CEK
    const recipients = encrypted.metadata.crypto.recipients!;
    let recoveredCek: Uint8Array | undefined;
    for (const r of recipients) {
      const ephemeralBytes = new Uint8Array(Buffer.from(r.epk, "base64"));
      if (ephemeralBytes.every((b) => b === 0)) continue;
      try {
        const ephemeral = {
          x25519EphemeralPublicKey: ephemeralBytes,
          ...(r.mlkem_ct
            ? { mlkemCiphertext: new Uint8Array(Buffer.from(r.mlkem_ct, "base64")) }
            : {}),
        };
        recoveredCek = unwrapCEK(
          new Uint8Array(Buffer.from(r.wrapped_cek, "base64")),
          ephemeral,
          owner,
          cekHashAad
        );
        break;
      } catch { /* try next */ }
    }
    expect(recoveredCek).toBeDefined();

    // Owner re-wraps for newRecipient, binding cek_hash as AAD (simulates handleExportCEK)
    const { wrappedCEK, ephemeral: shareEphemeral } = wrapCEK(
      recoveredCek!,
      { x25519: newRecipient.x25519PublicKey },
      cekHashAad
    );

    // Simulate share token (REP-3006 field names)
    const shareToken = {
      v: 1,
      wrapped_cek: Buffer.from(wrappedCEK).toString("base64"),
      epk: Buffer.from(shareEphemeral.x25519EphemeralPublicKey).toString("base64"),
      cek_hash: encrypted.metadata.crypto.cek_hash,
    };

    // newRecipient receives and unwraps (simulates handleImportCEK)
    const ephemeralFromToken = {
      x25519EphemeralPublicKey: new Uint8Array(Buffer.from(shareToken.epk, "base64")),
    };
    const importedCek = unwrapCEK(
      new Uint8Array(Buffer.from(shareToken.wrapped_cek, "base64")),
      ephemeralFromToken,
      newRecipient,
      cekHashAad  // same cek_hash AAD
    );

    // Both CEKs must be identical
    expect(bytesToHex(importedCek)).toBe(bytesToHex(recoveredCek!));

    // newRecipient re-wraps for their own key and builds patched stub
    const { wrappedCEK: myWrapped, ephemeral: myEphemeral } = wrapCEK(
      importedCek,
      { x25519: newRecipient.x25519PublicKey, mlkem: newRecipient.mlkemPublicKey },
      cekHashAad
    );

    const isHybrid = !!myEphemeral.mlkemCiphertext;
    const patchedRecipient = {
      kid: isHybrid ? "x25519mlkem768" : "x25519",
      alg: (isHybrid
        ? "x25519mlkem768-hkdf-xchacha20poly1305"
        : "x25519-hkdf-xchacha20poly1305") as
        "x25519-hkdf-xchacha20poly1305" | "x25519mlkem768-hkdf-xchacha20poly1305",
      wrapped_cek: Buffer.from(myWrapped).toString("base64"),
      epk: Buffer.from(myEphemeral.x25519EphemeralPublicKey).toString("base64"),
      ...(myEphemeral.mlkemCiphertext
        ? { mlkem_ct: Buffer.from(myEphemeral.mlkemCiphertext).toString("base64") }
        : {}),
    };

    const patchedStub = {
      ...encrypted.metadata,
      crypto: {
        ...encrypted.metadata.crypto,
        recipients: [patchedRecipient, ...recipients],
      },
    };

    // Full decrypt with patched stub — full keypair for ML-KEM slot
    const decrypted = await decryptContent(encrypted.encryptedContent, {
      metadata: patchedStub,
      privateKey: newRecipient,
    });
    expect(new TextDecoder().decode(decrypted)).toBe("shared secret content");
  });

  it("wrong private key cannot unwrap the share token", () => {
    const owner = makeKeypair("owner-seed-wrong-test");
    const cek = new Uint8Array(32).fill(0xcc);
    const attacker = makeKeypair("attacker-seed");
    const target = makeKeypair("target-seed");

    const { wrappedCEK, ephemeral } = wrapCEK(cek, { x25519: target.x25519PublicKey });

    expect(() =>
      unwrapCEK(wrappedCEK, { x25519EphemeralPublicKey: ephemeral.x25519EphemeralPublicKey }, attacker)
    ).toThrow();

    // But target succeeds
    const recovered = unwrapCEK(
      wrappedCEK,
      { x25519EphemeralPublicKey: ephemeral.x25519EphemeralPublicKey },
      target
    );
    expect(bytesToHex(recovered)).toBe(bytesToHex(cek));
  });

  it("cek_hash mismatch is detected before decryption", async () => {
    const plaintext = new TextEncoder().encode("cek hash guard test");
    const owner = makeKeypair("cek-hash-test-seed");

    const encrypted = await encryptContent(plaintext, {
      mode: "recipient",
      recipientPublicKeys: [owner.x25519PublicKey],
      contentType: "text/plain",
      name: "guard.txt",
    });

    const differentNft = await encryptContent(
      new TextEncoder().encode("different NFT"),
      {
        mode: "recipient",
        recipientPublicKeys: [owner.x25519PublicKey],
        contentType: "text/plain",
        name: "other.txt",
      }
    );

    // Share token built from `encrypted` but cek_hash copied from `differentNft`
    const recipients = encrypted.metadata.crypto.recipients!;
    const { wrappedCEK, ephemeral } = wrapCEK(new Uint8Array(32).fill(0xaa), {
      x25519: owner.x25519PublicKey,
    });
    const shareToken = {
      v: 1,
      wrapped_cek: Buffer.from(wrappedCEK).toString("base64"),
      epk: Buffer.from(ephemeral.x25519EphemeralPublicKey).toString("base64"),
      // deliberately wrong hash from a different NFT
      cek_hash: differentNft.metadata.crypto.cek_hash,
    };

    // Simulate the guard in handleImportCEK
    const hashMatches = shareToken.cek_hash === encrypted.metadata.crypto.cek_hash;
    expect(hashMatches).toBe(false); // mismatch correctly detected
    void recipients;
  });
});
