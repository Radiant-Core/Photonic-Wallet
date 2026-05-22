/**
 * R26 — `deriveEncryptionKeypair` must honour the wallet's coin type so
 * legacy (coinType 0) wallets can decrypt content encrypted to their
 * HD-derived recipient key.
 *
 * Before R26, every call site passed only the mnemonic; the helper
 * defaulted to coinType 512 even for wallets that actually spend at
 * coinType 0. That mismatch meant a legacy wallet's "self-as-recipient"
 * slot was derived at one path on mint and a different path on
 * decrypt — recovery failed silently.
 *
 * These tests pin the contract:
 *   - `deriveEncryptionKeypair(m, 0)` ≠ `deriveEncryptionKeypair(m, 512)`
 *   - A CEK wrapped to the coinType-0 keypair only unwraps with the
 *     coinType-0 keypair; the coinType-512 keypair must fail.
 *   - Both derivations are deterministic per (mnemonic, coinType).
 */
import { describe, it, expect } from "vitest";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";

import {
  deriveEncryptionKeypair,
  LEGACY_COIN_TYPE,
  DEFAULT_COIN_TYPE,
} from "@app/keys";
import { wrapCEK, unwrapCEK } from "@lib/encryption";

const SAMPLE_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("R26 — deriveEncryptionKeypair coin type plumbing", () => {
  it("returns different keypairs for legacy (0) vs modern (512) coin types", () => {
    const kpLegacy = deriveEncryptionKeypair(SAMPLE_MNEMONIC, LEGACY_COIN_TYPE);
    const kpModern = deriveEncryptionKeypair(
      SAMPLE_MNEMONIC,
      DEFAULT_COIN_TYPE
    );

    expect(bytesToHex(kpLegacy.x25519PublicKey)).not.toBe(
      bytesToHex(kpModern.x25519PublicKey)
    );
    expect(bytesToHex(kpLegacy.x25519PrivateKey)).not.toBe(
      bytesToHex(kpModern.x25519PrivateKey)
    );
  });

  it("is deterministic per (mnemonic, coinType)", () => {
    const a = deriveEncryptionKeypair(SAMPLE_MNEMONIC, LEGACY_COIN_TYPE);
    const b = deriveEncryptionKeypair(SAMPLE_MNEMONIC, LEGACY_COIN_TYPE);
    expect(bytesToHex(a.x25519PublicKey)).toBe(bytesToHex(b.x25519PublicKey));
    expect(bytesToHex(a.x25519PrivateKey)).toBe(bytesToHex(b.x25519PrivateKey));
  });

  it("falls back to DEFAULT_COIN_TYPE when coinType is omitted", () => {
    const explicit = deriveEncryptionKeypair(
      SAMPLE_MNEMONIC,
      DEFAULT_COIN_TYPE
    );
    const implicit = deriveEncryptionKeypair(SAMPLE_MNEMONIC);
    expect(bytesToHex(implicit.x25519PublicKey)).toBe(
      bytesToHex(explicit.x25519PublicKey)
    );
  });

  it("a CEK wrapped to the legacy keypair can only be unwrapped by it", () => {
    const kpLegacy = deriveEncryptionKeypair(SAMPLE_MNEMONIC, LEGACY_COIN_TYPE);
    const kpModern = deriveEncryptionKeypair(
      SAMPLE_MNEMONIC,
      DEFAULT_COIN_TYPE
    );

    // Simulate a mint at coinType=0: wrap a fresh CEK to the legacy
    // wallet's X25519 public key.
    const cek = randomBytes(32);
    const aad = new TextEncoder().encode("test-cek-hash");
    const { wrappedCEK, ephemeral } = wrapCEK(
      cek,
      { x25519: kpLegacy.x25519PublicKey },
      aad
    );

    // Legacy path (correct) unwraps and recovers the CEK.
    const recovered = unwrapCEK(wrappedCEK, ephemeral, kpLegacy, aad);
    expect(bytesToHex(recovered)).toBe(bytesToHex(cek));

    // Modern path (wrong coinType, pre-R26 behaviour) cannot unwrap.
    expect(() => unwrapCEK(wrappedCEK, ephemeral, kpModern, aad)).toThrow();
  });

  it("a coinType-0 wallet round-trips when both sides use coinType 0", () => {
    // End-to-end smoke for the legacy wallet flow: mint side and
    // decrypt side both call `deriveEncryptionKeypair(mnemonic, 0)`,
    // which is what the app does after R26 reads `wallet.value.coinType`.
    const kpMint = deriveEncryptionKeypair(SAMPLE_MNEMONIC, LEGACY_COIN_TYPE);
    const kpDecrypt = deriveEncryptionKeypair(
      SAMPLE_MNEMONIC,
      LEGACY_COIN_TYPE
    );

    const cek = randomBytes(32);
    const { wrappedCEK, ephemeral } = wrapCEK(cek, {
      x25519: kpMint.x25519PublicKey,
    });
    const recovered = unwrapCEK(wrappedCEK, ephemeral, kpDecrypt);
    expect(bytesToHex(recovered)).toBe(bytesToHex(cek));
  });
});
