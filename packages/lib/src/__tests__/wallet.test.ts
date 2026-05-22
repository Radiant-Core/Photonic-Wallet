import { describe, it, expect } from "vitest";
import {
  RADIANT_COIN_TYPE,
  LEGACY_COIN_TYPE,
  DEFAULT_COIN_TYPE,
  bip44Paths,
  deriveHdRoot,
  deriveAccount,
  deriveAccountFromHdKey,
  deriveEncryptionPrivateKeyBytes,
  walletFromMnemonic,
  getAddress,
} from "../wallet";

// BIP-39 test vector mnemonic — public, never used for real funds.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// A second deterministic mnemonic for cross-mnemonic differentiation tests.
const TEST_MNEMONIC_2 =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("constants", () => {
  it("DEFAULT_COIN_TYPE is the SLIP-0044 Radiant ID (512)", () => {
    expect(DEFAULT_COIN_TYPE).toBe(512);
    expect(RADIANT_COIN_TYPE).toBe(512);
  });

  it("LEGACY_COIN_TYPE is 0 (pre-v3.0.0 wallets)", () => {
    expect(LEGACY_COIN_TYPE).toBe(0);
  });
});

describe("bip44Paths", () => {
  it("emits the three documented paths for the default coin type", () => {
    const p = bip44Paths();
    expect(p.derivationPath).toBe("m/44'/512'/0'/0/0");
    expect(p.swapDerivationPath).toBe("m/44'/512'/0'/0/1");
    expect(p.encryptionDerivationPath).toBe("m/44'/512'/0'/2/0");
  });

  it("substitutes the coinType argument", () => {
    const p = bip44Paths(0);
    expect(p.derivationPath).toBe("m/44'/0'/0'/0/0");
    expect(p.swapDerivationPath).toBe("m/44'/0'/0'/0/1");
    expect(p.encryptionDerivationPath).toBe("m/44'/0'/0'/2/0");
  });

  it("rejects non-integer or negative coinType", () => {
    expect(() => bip44Paths(-1)).toThrow();
    expect(() => bip44Paths(1.5)).toThrow();
    expect(() => bip44Paths(Number.NaN)).toThrow();
  });
});

describe("deriveHdRoot", () => {
  it("produces deterministic seed + HD root from a mnemonic", () => {
    const a = deriveHdRoot(TEST_MNEMONIC);
    const b = deriveHdRoot(TEST_MNEMONIC);
    expect(Buffer.from(a.seed).toString("hex")).toBe(
      Buffer.from(b.seed).toString("hex")
    );
    expect(a.hdKey.privateExtendedKey).toBe(b.hdKey.privateExtendedKey);
  });

  it("different mnemonics produce different roots", () => {
    const a = deriveHdRoot(TEST_MNEMONIC);
    const b = deriveHdRoot(TEST_MNEMONIC_2);
    expect(a.hdKey.privateExtendedKey).not.toBe(b.hdKey.privateExtendedKey);
  });
});

describe("deriveAccount", () => {
  it("returns coherent main + swap keys/addresses", () => {
    const acct = deriveAccount(TEST_MNEMONIC, "mainnet");
    expect(acct.coinType).toBe(DEFAULT_COIN_TYPE);
    expect(acct.address).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/);
    expect(acct.swapAddress).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/);
    expect(acct.address).not.toBe(acct.swapAddress);
    // WIF-encoded private keys round-trip back to the same addresses.
    expect(acct.privKey.toAddress().toString()).toBe(acct.address);
    expect(acct.swapPrivKey.toAddress().toString()).toBe(acct.swapAddress);
  });

  it("is deterministic for the same mnemonic + coin type", () => {
    const a = deriveAccount(TEST_MNEMONIC, "mainnet", RADIANT_COIN_TYPE);
    const b = deriveAccount(TEST_MNEMONIC, "mainnet", RADIANT_COIN_TYPE);
    expect(a.address).toBe(b.address);
    expect(a.swapAddress).toBe(b.swapAddress);
  });

  it("modern (512) and legacy (0) coin types derive DIFFERENT addresses", () => {
    // The whole point of supporting both coin types: pre-v3.0.0 wallets
    // can still spend their UTXOs. If these matched, the audit's R7 issue
    // (CLI unable to recover legacy wallets) would still exist.
    const modern = deriveAccount(TEST_MNEMONIC, "mainnet", RADIANT_COIN_TYPE);
    const legacy = deriveAccount(TEST_MNEMONIC, "mainnet", LEGACY_COIN_TYPE);
    expect(modern.address).not.toBe(legacy.address);
    expect(modern.swapAddress).not.toBe(legacy.swapAddress);
  });

  it("testnet and mainnet produce different addresses for the same path", () => {
    const main = deriveAccount(TEST_MNEMONIC, "mainnet");
    const test = deriveAccount(TEST_MNEMONIC, "testnet");
    expect(main.address).not.toBe(test.address);
  });

  it("deriveAccountFromHdKey matches deriveAccount when fed the same root", () => {
    const { hdKey } = deriveHdRoot(TEST_MNEMONIC);
    const direct = deriveAccount(TEST_MNEMONIC, "mainnet", RADIANT_COIN_TYPE);
    const fromRoot = deriveAccountFromHdKey(
      hdKey,
      "mainnet",
      RADIANT_COIN_TYPE
    );
    expect(fromRoot.address).toBe(direct.address);
    expect(fromRoot.swapAddress).toBe(direct.swapAddress);
    expect(fromRoot.coinType).toBe(direct.coinType);
  });
});

describe("walletFromMnemonic (legacy / CLI entry point)", () => {
  it("returns the same address deriveAccount produces at default coin type", () => {
    // R7 parity: the CLI uses walletFromMnemonic; the app uses deriveAccount.
    // The two MUST agree at the same coin type, otherwise the CLI cannot
    // sign transactions for wallets created in the app.
    return walletFromMnemonic(TEST_MNEMONIC, "mainnet").then((w) => {
      const acct = deriveAccount(TEST_MNEMONIC, "mainnet", DEFAULT_COIN_TYPE);
      expect(w.address).toBe(acct.address);
    });
  });

  it("honours the coinType argument for legacy wallets", () => {
    return walletFromMnemonic(TEST_MNEMONIC, "mainnet", LEGACY_COIN_TYPE).then(
      (w) => {
        const acct = deriveAccount(TEST_MNEMONIC, "mainnet", LEGACY_COIN_TYPE);
        expect(w.address).toBe(acct.address);
      }
    );
  });

  it("returns a WIF that round-trips through getAddress", () => {
    return walletFromMnemonic(TEST_MNEMONIC, "mainnet").then(async (w) => {
      const addr = await getAddress(w.wif, "mainnet");
      expect(addr).toBe(w.address);
    });
  });
});

describe("deriveEncryptionPrivateKeyBytes", () => {
  it("returns 32 bytes deterministically", () => {
    const a = deriveEncryptionPrivateKeyBytes(TEST_MNEMONIC);
    const b = deriveEncryptionPrivateKeyBytes(TEST_MNEMONIC);
    expect(a.length).toBe(32);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
  });

  it("differs from the spending key at the same coin type", () => {
    const enc = deriveEncryptionPrivateKeyBytes(
      TEST_MNEMONIC,
      RADIANT_COIN_TYPE
    );
    const acct = deriveAccount(TEST_MNEMONIC, "mainnet", RADIANT_COIN_TYPE);
    // Compare encryption-key bytes against the spending key bytes.
    const spendBytes = Buffer.from(acct.privKey.toBuffer()).toString("hex");
    expect(Buffer.from(enc).toString("hex")).not.toBe(spendBytes);
  });

  it("differs between coin types (segregated key spaces)", () => {
    const modern = deriveEncryptionPrivateKeyBytes(
      TEST_MNEMONIC,
      RADIANT_COIN_TYPE
    );
    const legacy = deriveEncryptionPrivateKeyBytes(
      TEST_MNEMONIC,
      LEGACY_COIN_TYPE
    );
    expect(Buffer.from(modern).toString("hex")).not.toBe(
      Buffer.from(legacy).toString("hex")
    );
  });
});
