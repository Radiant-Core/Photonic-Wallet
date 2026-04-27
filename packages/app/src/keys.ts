import { Buffer } from "buffer";
import { Networks, PrivateKey } from "@radiant-core/radiantjs";
import {
  generateMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  entropyToMnemonic,
} from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { wordlist } from "@scure/bip39/wordlists/english";
import {
  EncryptedData,
  decrypt,
  encrypt,
  buildHybridKeyPairFromPrivateKey,
  deriveKeyHKDF,
  type HybridKeyPair,
} from "@lib/encryption";
import db from "@app/db";
import { NetworkKey } from "@lib/types";

const derivationPath = "m/44'/0'/0'/0/0";
const swapDerivationPath = "m/44'/0'/0'/0/1";
const encryptionDerivationPath = "m/44'/0'/0'/2/0";

/**
 * Derive a deterministic encryption keypair for self-as-recipient (backup key).
 * Uses HD path m/44'/0'/0'/2/0 — dedicated to encryption, never reused for spending.
 *
 * The secp256k1 child key is converted to an X25519 key and ML-KEM-768 seed
 * via HKDF so the curve mismatch is resolved without cross-package imports.
 *
 * @param mnemonic BIP-39 mnemonic (available while wallet is unlocked)
 * @returns Hybrid X25519 + ML-KEM-768 keypair
 */
export function deriveEncryptionKeypair(mnemonic: string): HybridKeyPair {
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);
  const childKey = hdKey.derive(encryptionDerivationPath);
  const rawPrivate = childKey.privateKey as Uint8Array;

  // Map secp256k1 private bytes → X25519 scalar via HKDF (avoids curve confusion)
  const x25519PrivateKey = deriveKeyHKDF(
    rawPrivate,
    new TextEncoder().encode("glyph-x25519-v1"),
    new TextEncoder().encode("encryption-keypair"),
    32
  );

  // ML-KEM-768 requires a 64-byte seed for deterministic keygen
  const mlkemSeed = deriveKeyHKDF(
    rawPrivate,
    new TextEncoder().encode("glyph-mlkem768-v1"),
    new TextEncoder().encode("encryption-keypair"),
    64
  );

  return buildHybridKeyPairFromPrivateKey(x25519PrivateKey, mlkemSeed);
}

export async function decryptKeys(net: NetworkKey, password: string) {
  const data = (await db.kvp.get("wallet")) as EncryptedData;
  if (!data) {
    throw new Error("Failed to unlock");
  }
  const decrypted = await decrypt(data, password);
  const mnemonic = entropyToMnemonic(decrypted, wordlist);
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);
  const key = Buffer.from(
    hdKey.derive(derivationPath).privateKey as Uint8Array
  ).toString("hex");
  const swapKey = Buffer.from(
    hdKey.derive(swapDerivationPath).privateKey as Uint8Array
  ).toString("hex");
  if (!key || !swapKey) {
    throw new Error("Invalid mnemonic phrase");
  }
  const privKey = new PrivateKey(key, Networks[net]);
  const swapPrivKey = new PrivateKey(swapKey, Networks[net]);
  const address = privKey?.toAddress().toString() as string;
  const swapAddress = swapPrivKey?.toAddress().toString() as string;

  return {
    net,
    mnemonic,
    privKey,
    wif: privKey.toString(),
    address,
    swapWif: swapPrivKey.toString(),
    swapAddress,
    locked: false,
  };
}

export async function createKeys(net: NetworkKey, password: string) {
  const mnemonic = generateMnemonic(wordlist);
  return recoverKeys(net, mnemonic, password);
}

export async function recoverKeys(
  net: NetworkKey,
  mnemonic: string,
  password: string
) {
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);
  const key = Buffer.from(
    hdKey.derive(derivationPath).privateKey as Uint8Array
  ).toString("hex");
  const swapKey = Buffer.from(
    hdKey.derive(swapDerivationPath).privateKey as Uint8Array
  ).toString("hex");
  if (!key || !swapKey) return;
  const privKey = new PrivateKey(key, Networks[net]);
  const address = privKey?.toAddress().toString() as string;
  const swapPrivKey = new PrivateKey(swapKey, Networks[net]);
  const swapAddress = swapPrivKey?.toAddress().toString() as string;
  const entropy = mnemonicToEntropy(mnemonic, wordlist);
  await db.kvp.put(
    { ...(await encrypt(entropy, password)), address, swapAddress, net: net },
    "wallet"
  );

  return decryptKeys(net, password);
}

export async function keysExist(): Promise<boolean> {
  return !!(await db.kvp.get("wallet"));
}
