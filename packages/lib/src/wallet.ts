/**
 * HD derivation — single source of truth for Photonic Wallet.
 *
 * Used by both the desktop/web app (`packages/app/src/keys.ts`) and the
 * batch-minting CLI (`packages/cli/src/utils.ts`). Previously the app and
 * lib had subtly different copies of this logic, which broke the CLI for
 * any wallet created at SLIP-0044 coin type 0 (legacy) or using the swap
 * subaccount. See audit finding R7 in REMEDIATION_PLAN.md.
 *
 * Path layout (BIP-44 with the coin-type field parameterised):
 *   main spending     m/44'/<coinType>'/0'/0/0
 *   swap subaccount   m/44'/<coinType>'/0'/0/1
 *   encryption key    m/44'/<coinType>'/0'/2/0
 *
 * Coin types in use:
 *   - 512 (RADIANT_COIN_TYPE) — the SLIP-0044 registered ID for Radiant.
 *     Default for any wallet created at or after v3.0.0.
 *   - 0   (LEGACY_COIN_TYPE)  — pre-v3.0.0 wallets. Still supported so
 *     existing UTXOs remain spendable.
 */
import rjs from "@radiant-core/radiantjs";
import {
  mnemonicToEntropy,
  mnemonicToSeed,
  mnemonicToSeedSync,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { bytesToHex } from "@noble/hashes/utils";
import { NetworkKey, Wallet } from "./types";

const { Networks, PrivateKey } = rjs;

// ────────────────────────────────────────────────────────────────────────
// Coin-type constants
// ────────────────────────────────────────────────────────────────────────

/** SLIP-0044 registered Radiant coin type. Default for v3.0.0+ wallets. */
export const RADIANT_COIN_TYPE = 512;

/** Pre-v3.0.0 wallets used coin type 0. Still supported for backward compat. */
export const LEGACY_COIN_TYPE = 0;

/** Default coin type for newly-created wallets. */
export const DEFAULT_COIN_TYPE = RADIANT_COIN_TYPE;

// ────────────────────────────────────────────────────────────────────────
// Path helpers
// ────────────────────────────────────────────────────────────────────────

export type BipPaths = {
  /** m/44'/<coinType>'/0'/0/0 — main spending address. */
  derivationPath: string;
  /** m/44'/<coinType>'/0'/0/1 — swap subaccount. */
  swapDerivationPath: string;
  /** m/44'/<coinType>'/0'/2/0 — dedicated encryption keypair, never reused for spending. */
  encryptionDerivationPath: string;
};

/** Compute the three BIP-44 paths used by Photonic Wallet at the given coin type. */
export function bip44Paths(coinType: number = DEFAULT_COIN_TYPE): BipPaths {
  if (!Number.isInteger(coinType) || coinType < 0) {
    throw new Error(`bip44Paths: invalid coinType ${coinType}`);
  }
  return {
    derivationPath: `m/44'/${coinType}'/0'/0/0`,
    swapDerivationPath: `m/44'/${coinType}'/0'/0/1`,
    encryptionDerivationPath: `m/44'/${coinType}'/0'/2/0`,
  };
}

// ────────────────────────────────────────────────────────────────────────
// HD-root derivation
// ────────────────────────────────────────────────────────────────────────

/**
 * Derive the BIP-39 seed and BIP-32 master key from a mnemonic.
 *
 * The HD root is opaque — callers should use it to derive specific paths
 * via `hdKey.derive(...)` rather than passing it around. Returning both
 * the seed and the root keeps tests deterministic and lets advanced
 * callers (e.g. account-discovery probes) work below the public surface.
 */
export function deriveHdRoot(mnemonic: string): {
  seed: Uint8Array;
  hdKey: HDKey;
} {
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);
  return { seed, hdKey };
}

// ────────────────────────────────────────────────────────────────────────
// Account derivation
// ────────────────────────────────────────────────────────────────────────

/**
 * Result of `deriveAccount` — the four artefacts every transaction-signing
 * call site needs: main key + swap key, and the two corresponding addresses.
 */
export type DerivedAccount = {
  privKey: rjs.PrivateKey;
  swapPrivKey: rjs.PrivateKey;
  address: string;
  swapAddress: string;
  coinType: number;
};

function privKeyFromHdLeaf(leaf: HDKey, net: NetworkKey): rjs.PrivateKey {
  const raw = leaf.privateKey;
  if (!raw) {
    throw new Error(
      "HD derivation produced no private key (invalid mnemonic?)"
    );
  }
  return new PrivateKey(bytesToHex(raw), Networks[net]);
}

/**
 * Derive the main and swap private keys + addresses for a given mnemonic
 * at a given SLIP-0044 coin type. The single source of truth used by both
 * the app and CLI.
 */
export function deriveAccount(
  mnemonic: string,
  net: NetworkKey,
  coinType: number = DEFAULT_COIN_TYPE
): DerivedAccount {
  const { hdKey } = deriveHdRoot(mnemonic);
  return deriveAccountFromHdKey(hdKey, net, coinType);
}

/**
 * Variant of `deriveAccount` for callers that already have an `HDKey`
 * in hand (e.g. account-discovery probes that try several coin types
 * without re-running the seed → HD-key step each time).
 */
export function deriveAccountFromHdKey(
  hdKey: HDKey,
  net: NetworkKey,
  coinType: number = DEFAULT_COIN_TYPE
): DerivedAccount {
  const p = bip44Paths(coinType);
  const privKey = privKeyFromHdLeaf(hdKey.derive(p.derivationPath), net);
  const swapPrivKey = privKeyFromHdLeaf(
    hdKey.derive(p.swapDerivationPath),
    net
  );
  return {
    privKey,
    swapPrivKey,
    address: privKey.toAddress().toString(),
    swapAddress: swapPrivKey.toAddress().toString(),
    coinType,
  };
}

/**
 * Derive the raw 32-byte private-key bytes for the dedicated encryption
 * child. Callers map these into X25519 / ML-KEM material as needed —
 * see `packages/app/src/keys.ts::deriveEncryptionKeypair`.
 */
export function deriveEncryptionPrivateKeyBytes(
  mnemonic: string,
  coinType: number = DEFAULT_COIN_TYPE
): Uint8Array {
  const { hdKey } = deriveHdRoot(mnemonic);
  const leaf = hdKey.derive(bip44Paths(coinType).encryptionDerivationPath);
  if (!leaf.privateKey) {
    throw new Error("Encryption-key derivation produced no private key");
  }
  return leaf.privateKey;
}

// ────────────────────────────────────────────────────────────────────────
// Convenience / back-compat surface
// ────────────────────────────────────────────────────────────────────────

export async function tryMnemonic(mnemonic: string) {
  return mnemonicToSeed(mnemonic);
}

export async function importMnemonic(mnemonic: string) {
  return mnemonicToEntropy(mnemonic, wordlist);
}

/**
 * Legacy single-key entry point used by the CLI. Wraps `deriveAccount`
 * and returns only the main spending key — the CLI does not yet expose
 * swap functionality.
 *
 * `coinType` defaults to `DEFAULT_COIN_TYPE` for backward compatibility
 * with existing CLI usage. A future CLI command may accept `--coin-type`
 * to operate on legacy (v2.x) wallets; see R7 in REMEDIATION_PLAN.md.
 */
export async function walletFromMnemonic(
  mnemonic: string,
  net: NetworkKey,
  coinType: number = DEFAULT_COIN_TYPE
): Promise<Wallet> {
  const { privKey, address } = deriveAccount(mnemonic, net, coinType);
  return { privKey, wif: privKey.toString(), address };
}

/**
 * Compressed secp256k1 public key (33-byte hex) for a spending WIF — the form
 * a prediction-market oracle committee and any pubkey-based covenant expect.
 * These are exactly the bytes radiantjs `PrivateKey.toPublicKey()` produces, so
 * the value surfaced to the user matches what the covenant is built with.
 */
export function publicKeyHexFromWif(wif: string): string {
  return bytesToHex(
    Uint8Array.from(PrivateKey.fromWIF(wif).toPublicKey().toBuffer())
  );
}

export async function getAddress(key: string, net: NetworkKey) {
  const privKey = new PrivateKey(key, Networks[net]);
  return privKey.toAddress().toString();
}
