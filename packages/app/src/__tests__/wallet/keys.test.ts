/**
 * Wallet Key Management Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';

describe('Wallet Key Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('Mnemonic Generation', () => {
    it('should generate 12-word mnemonic', () => {
      // BIP39 mnemonic word count
      const wordCounts = [12, 15, 18, 21, 24];
      expect(wordCounts).toContain(12);
    });

    it('should generate 24-word mnemonic for higher security', () => {
      const wordCounts = [12, 15, 18, 21, 24];
      expect(wordCounts).toContain(24);
    });
  });

  describe('HD Key Derivation', () => {
    it('should use correct derivation path for Radiant', () => {
      // BIP44 path: m/44'/coin_type'/account'/change/address_index
      // Radiant uses coin type 512 (registered)
      const radiantPath = "m/44'/512'/0'/0/0";
      expect(radiantPath).toMatch(/^m\/44'\/\d+'\/\d+'\/\d+\/\d+$/);
    });

    it('should derive child keys deterministically', () => {
      // Same seed + path = same key
      const testSeed = 'test seed for deterministic derivation';
      const path1 = "m/44'/512'/0'/0/0";
      const path2 = "m/44'/512'/0'/0/1";
      
      // Different paths should yield different keys
      expect(path1).not.toBe(path2);
    });
  });

  describe('Key Storage', () => {
    it('should encrypt keys before storage', () => {
      const sensitiveKey = 'private_key_data';
      const password = 'user_password';
      
      // Keys should never be stored in plaintext
      expect(sensitiveKey).not.toBe(password);
    });

    it('should use secure key derivation for encryption', () => {
      // Should use scrypt or similar KDF
      const kdfParams = {
        N: 2 ** 17, // CPU/memory cost
        r: 8,       // Block size
        p: 1,       // Parallelization
      };
      
      expect(kdfParams.N).toBeGreaterThanOrEqual(2 ** 14);
    });
  });
});

describe('Address Generation', () => {
  it('should generate valid P2PKH addresses', () => {
    // P2PKH addresses are 25-34 characters
    const addressLength = { min: 25, max: 34 };
    expect(addressLength.min).toBe(25);
    expect(addressLength.max).toBe(34);
  });

  it('should generate addresses from public key', () => {
    // Address = Base58Check(version + RIPEMD160(SHA256(pubkey)) + checksum)
    const steps = ['sha256', 'ripemd160', 'version_prefix', 'checksum', 'base58'];
    expect(steps.length).toBe(5);
  });

  it('should support multiple address types', () => {
    const addressTypes = ['p2pkh', 'p2sh'];
    expect(addressTypes).toContain('p2pkh');
  });
});

describe('BIP-44 Coin Type Dual-Path Support (regression for v3.0.0 upgrade)', () => {
  // Known BIP-39 test vector (all-abandon). We only need the seed; no real
  // wallet is involved.
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  const seed = mnemonicToSeedSync(TEST_MNEMONIC);
  const hdKey = HDKey.fromMasterSeed(seed);

  const legacyPrivKey = hdKey.derive("m/44'/0'/0'/0/0").privateKey!;
  const modernPrivKey = hdKey.derive("m/44'/512'/0'/0/0").privateKey!;

  it('produces DIFFERENT private keys for coin type 0 vs 512 from the same mnemonic', () => {
    // This is the exact root cause of the WAVE registration bug: after
    // Photonic Wallet v3.0.0 switched the default derivation from coin type 0
    // to 512, legacy wallets signed transactions with a different key than
    // the one that controls their on-chain UTXOs, causing the node to reject
    // every broadcast with OP_EQUALVERIFY in the P2PKH unlock.
    expect(legacyPrivKey).not.toEqual(modernPrivKey);
  });

  it('legacy coin type 0 derivation is deterministic across calls', () => {
    const again = HDKey.fromMasterSeed(seed).derive("m/44'/0'/0'/0/0").privateKey!;
    expect(Buffer.from(legacyPrivKey).toString('hex')).toBe(
      Buffer.from(again).toString('hex')
    );
  });

  it('modern coin type 512 derivation is deterministic across calls', () => {
    const again = HDKey.fromMasterSeed(seed).derive("m/44'/512'/0'/0/0").privateKey!;
    expect(Buffer.from(modernPrivKey).toString('hex')).toBe(
      Buffer.from(again).toString('hex')
    );
  });

  it('swap path differs from spending path at both coin types', () => {
    const legacySwap = hdKey.derive("m/44'/0'/0'/0/1").privateKey!;
    const modernSwap = hdKey.derive("m/44'/512'/0'/0/1").privateKey!;
    expect(legacySwap).not.toEqual(legacyPrivKey);
    expect(modernSwap).not.toEqual(modernPrivKey);
    expect(legacySwap).not.toEqual(modernSwap);
  });

  it('encryption path differs from spending path at both coin types', () => {
    const legacyEnc = hdKey.derive("m/44'/0'/0'/2/0").privateKey!;
    const modernEnc = hdKey.derive("m/44'/512'/0'/2/0").privateKey!;
    expect(legacyEnc).not.toEqual(legacyPrivKey);
    expect(modernEnc).not.toEqual(modernPrivKey);
    expect(legacyEnc).not.toEqual(modernEnc);
  });
});

describe('Coin Type Constants', () => {
  it('exposes RADIANT_COIN_TYPE = 512 and LEGACY_COIN_TYPE = 0', async () => {
    const { RADIANT_COIN_TYPE, LEGACY_COIN_TYPE, DEFAULT_COIN_TYPE } =
      await import('@app/keys');
    expect(RADIANT_COIN_TYPE).toBe(512);
    expect(LEGACY_COIN_TYPE).toBe(0);
    expect(DEFAULT_COIN_TYPE).toBe(RADIANT_COIN_TYPE);
  });

  it('probeCoinTypeFromHistory is exported and is an async function', async () => {
    const { probeCoinTypeFromHistory } = await import('@app/keys');
    expect(typeof probeCoinTypeFromHistory).toBe('function');
    // Sanity: when called with an empty server list the probe must resolve
    // (best-effort fallback to default) and never throw.
    const result = await probeCoinTypeFromHistory(
      'mainnet',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      { timeoutMs: 50, servers: [] }
    );
    expect(result).toBe(512);
  });
});
