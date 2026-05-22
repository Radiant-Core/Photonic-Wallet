import {
  generateMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  entropyToMnemonic,
} from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { wordlist } from "@scure/bip39/wordlists/english";
import {
  decryptWallet,
  encryptWallet,
  buildHybridKeyPairFromPrivateKey,
  deriveKeyHKDF,
  type HybridKeyPair,
} from "@lib/encryption";
import db from "@app/db";
import { NetworkKey } from "@lib/types";
import { SavedWallet } from "@app/types";
import { p2pkhScriptHash } from "@lib/script";
import {
  RADIANT_COIN_TYPE,
  LEGACY_COIN_TYPE,
  DEFAULT_COIN_TYPE,
  deriveAccountFromHdKey,
  deriveEncryptionPrivateKeyBytes,
  type DerivedAccount,
} from "@lib/wallet";
import config from "@app/config.json";
import { ElectrumWS } from "@lib/electrumWsClient";

// Re-export coin-type constants for app-side callers that previously imported
// them from this module. The actual values live in `@lib/wallet` — the single
// source of truth (audit finding R7).
export { RADIANT_COIN_TYPE, LEGACY_COIN_TYPE, DEFAULT_COIN_TYPE };

/**
 * Derive a deterministic encryption keypair for self-as-recipient (backup key).
 * Uses HD path m/44'/<coinType>'/0'/2/0 — dedicated to encryption, never
 * reused for spending. The path is owned by `@lib/wallet::bip44Paths`.
 *
 * The secp256k1 child key is converted to an X25519 key and ML-KEM-768 seed
 * via HKDF so the curve mismatch is resolved without cross-package imports.
 *
 * @param mnemonic BIP-39 mnemonic (available while wallet is unlocked)
 * @param coinType SLIP-0044 coin type (default 512). Legacy wallets pass 0.
 * @returns Hybrid X25519 + ML-KEM-768 keypair
 */
export function deriveEncryptionKeypair(
  mnemonic: string,
  coinType: number = DEFAULT_COIN_TYPE
): HybridKeyPair {
  const rawPrivate = deriveEncryptionPrivateKeyBytes(mnemonic, coinType);

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

/**
 * Derive spending keys at a given SLIP-0044 coin type.
 *
 * Thin wrapper around `@lib/wallet::deriveAccountFromHdKey` retained for
 * app-internal callers (notably `resolveCoinType` and
 * `probeCoinTypeFromHistory`) that already have an HDKey in hand and don't
 * want to re-derive the seed.
 */
function deriveKeysForCoinType(
  hdKey: HDKey,
  net: NetworkKey,
  coinType: number
): DerivedAccount {
  return deriveAccountFromHdKey(hdKey, net, coinType);
}

/**
 * Resolve which BIP-44 coin type to use for this saved wallet.
 *
 * Strategy:
 *   1. If `data.coinType` is explicitly stored, trust it.
 *   2. Otherwise, derive the default (512) address and compare against the
 *      address persisted in the saved wallet blob. If they match, lock in 512.
 *   3. If they do not match, try the legacy (0) path. If that matches, the
 *      wallet was created pre-v3.0.0 and must continue at coin type 0.
 *   4. As a last resort fall back to the default to avoid breaking new flows
 *      (the caller will still detect address mismatch downstream).
 *
 * The resolved coin type is persisted back into kvp so subsequent unlocks
 * skip the detection step entirely.
 */
async function resolveCoinType(
  hdKey: HDKey,
  net: NetworkKey,
  data: SavedWallet
): Promise<number> {
  if (typeof data.coinType === "number") {
    return data.coinType;
  }

  const candidates = [DEFAULT_COIN_TYPE, LEGACY_COIN_TYPE];
  for (const coinType of candidates) {
    const { address, swapAddress } = deriveKeysForCoinType(
      hdKey,
      net,
      coinType
    );
    if (
      (data.address && data.address === address) ||
      (data.swapAddress && data.swapAddress === swapAddress)
    ) {
      return coinType;
    }
  }

  // No stored address matched; keep default. The wallet will still unlock
  // but the user may need to re-import or migrate funds manually.
  console.warn(
    "[keys] Could not match stored wallet address to any known derivation path; defaulting to coin type",
    DEFAULT_COIN_TYPE
  );
  return DEFAULT_COIN_TYPE;
}

export async function decryptKeys(net: NetworkKey, password: string) {
  const data = (await db.kvp.get("wallet")) as SavedWallet & {
    version?: number;
  };
  if (!data) {
    throw new Error("Failed to unlock");
  }
  const decrypted = await decryptWallet(data, password);
  const mnemonic = entropyToMnemonic(decrypted, wordlist);
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);

  // Detect (or read) the coin type this wallet uses. This is crucial for
  // wallets that were created before v3.0.0 on coin type 0: deriving them at
  // coin type 512 produces a different key pair and every signed transaction
  // fails mandatory-script-verify (OP_EQUALVERIFY) at broadcast time.
  const coinType = await resolveCoinType(hdKey, net, data);
  const { privKey, swapPrivKey, address, swapAddress } = deriveKeysForCoinType(
    hdKey,
    net,
    coinType
  );

  // Persist upgrades:
  //   - Legacy v1 (AES-128-CTR) blobs → v2 (AES-256-GCM)
  //   - Missing coinType field → now stored
  //   - Stored address may have been written pre-upgrade with a default-path
  //     value that no longer matches the resolved coin type; keep whatever
  //     we actually derived so downstream consumers agree.
  const needsReencrypt = !data.version;
  const needsCoinType = typeof data.coinType !== "number";
  if (needsReencrypt || needsCoinType) {
    const blob = needsReencrypt
      ? await encryptWallet(decrypted, password)
      : {
          ciphertext: data.ciphertext,
          salt: data.salt,
          iv: data.iv,
          version: data.version,
        };
    await db.kvp.put(
      {
        ...blob,
        address,
        swapAddress,
        net: data.net,
        coinType,
      },
      "wallet"
    );
  }

  return {
    net,
    mnemonic,
    privKey,
    wif: privKey.toString(),
    address,
    swapWif: swapPrivKey.toString(),
    swapAddress,
    locked: false,
    coinType,
  };
}

export async function createKeys(net: NetworkKey, password: string) {
  const mnemonic = generateMnemonic(wordlist);
  // Brand-new wallets always use the current default (coin type 512); skip
  // the on-chain history probe since a freshly generated mnemonic cannot
  // have any prior activity at either path.
  return recoverKeys(net, mnemonic, password, DEFAULT_COIN_TYPE);
}

/**
 * Probe a Radiant ElectrumX server for activity at a given scripthash.
 * Returns a truthy count on success, or 0 on any error / empty history.
 */
async function probeScriptHashActivity(
  ws: ElectrumWS,
  scriptHash: string
): Promise<number> {
  try {
    const [history, utxos] = await Promise.all([
      ws
        .request("blockchain.scripthash.get_history", scriptHash)
        .catch(() => []) as Promise<unknown>,
      ws
        .request("blockchain.scripthash.listunspent", scriptHash)
        .catch(() => []) as Promise<unknown>,
    ]);
    const h = Array.isArray(history) ? history.length : 0;
    const u = Array.isArray(utxos) ? utxos.length : 0;
    return h + u;
  } catch {
    return 0;
  }
}

/**
 * Auto-detect which BIP-44 coin type derivation has on-chain history for the
 * given mnemonic.
 *
 * Strategy:
 *   1. Derive addresses at coin type 512 (modern) and 0 (legacy).
 *   2. Connect to the first reachable Radiant ElectrumX server.
 *   3. Query history + utxos for both scripthashes (main and swap).
 *   4. If only one coin type has activity, return it.
 *   5. If both have activity, prefer modern (512).
 *   6. If neither (or probe failed entirely), return DEFAULT_COIN_TYPE.
 *
 * This is best-effort — any network failure silently falls back to the
 * default so wallet recovery never hangs or fails on a flaky connection.
 */
export async function probeCoinTypeFromHistory(
  net: NetworkKey,
  mnemonic: string,
  options: { timeoutMs?: number; servers?: string[] } = {}
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);

  const candidates: { coinType: number; addresses: string[] }[] = [];
  for (const coinType of [LEGACY_COIN_TYPE, RADIANT_COIN_TYPE]) {
    try {
      const d = deriveKeysForCoinType(hdKey, net, coinType);
      candidates.push({ coinType, addresses: [d.address, d.swapAddress] });
    } catch {
      // ignore — invalid mnemonic at this path
    }
  }
  if (!candidates.length) return DEFAULT_COIN_TYPE;

  // Try the user's stored servers first, then fall back to the bundled list.
  let serverList = options.servers;
  if (!serverList) {
    try {
      const stored = (await db.kvp.get("servers")) as
        | { mainnet?: string[]; testnet?: string[] }
        | undefined;
      serverList = stored?.[net];
    } catch {
      // ignore
    }
  }
  if (!serverList || serverList.length === 0) {
    serverList = (config.defaultConfig.servers as Record<string, string[]>)[
      net
    ];
  }
  if (!serverList || serverList.length === 0) return DEFAULT_COIN_TYPE;

  const deadline = Date.now() + timeoutMs;
  for (const endpoint of serverList) {
    if (Date.now() >= deadline) break;
    let ws: ElectrumWS | undefined;
    try {
      ws = new ElectrumWS(endpoint);

      // Wait briefly for the socket to be usable. We probe by issuing a
      // cheap server.version request and racing it against the remaining
      // budget for this endpoint.
      const remaining = Math.max(500, deadline - Date.now());
      const versionPromise = ws.request(
        "server.version",
        "PhotonicWallet/recover",
        "1.4"
      );
      const versionTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("server.version timeout")), remaining)
      );
      await Promise.race([versionPromise, versionTimeout]);

      const counts: Record<number, number> = {};
      for (const c of candidates) {
        let sum = 0;
        for (const address of c.addresses) {
          // p2pkhScriptHash now throws on bad addresses instead of returning
          // "" silently. Skip individual failures rather than aborting the
          // whole probe — a single mis-derived candidate shouldn't prevent
          // checking the rest.
          let sh: string;
          try {
            sh = p2pkhScriptHash(address);
          } catch {
            continue;
          }
          sum += await probeScriptHashActivity(ws, sh);
        }
        counts[c.coinType] = sum;
      }

      const legacy = counts[LEGACY_COIN_TYPE] ?? 0;
      const modern = counts[RADIANT_COIN_TYPE] ?? 0;

      if (legacy > 0 && modern === 0) return LEGACY_COIN_TYPE;
      if (modern > 0 && legacy === 0) return RADIANT_COIN_TYPE;
      if (modern > 0 && legacy > 0) {
        // Ambiguous (both paths have activity). Prefer the path with more
        // total activity, breaking ties toward the modern default.
        return modern >= legacy ? RADIANT_COIN_TYPE : LEGACY_COIN_TYPE;
      }
      // Neither path had activity at this server — keep trying others in
      // case this one is misbehaving.
    } catch {
      // Probe failed at this endpoint — silently move on to the next
      // candidate. We never log endpoint or error details in production
      // builds (they'd appear in any user's DevTools).
    } finally {
      try {
        ws?.close("probe-complete");
      } catch {
        // ignore
      }
    }
  }

  return DEFAULT_COIN_TYPE;
}

export async function recoverKeys(
  net: NetworkKey,
  mnemonic: string,
  password: string,
  coinType?: number
) {
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);

  // Resolve coin type:
  //   - Explicit caller-provided value wins (used by createKeys and tests).
  //   - Otherwise probe ElectrumX to detect legacy (coin type 0) wallets
  //     that have on-chain history from before the v3.0.0 derivation-path
  //     change. Probe is best-effort and defaults to the modern path.
  const resolvedCoinType =
    typeof coinType === "number"
      ? coinType
      : await probeCoinTypeFromHistory(net, mnemonic);

  let derived;
  try {
    derived = deriveKeysForCoinType(hdKey, net, resolvedCoinType);
  } catch {
    return;
  }
  const entropy = mnemonicToEntropy(mnemonic, wordlist);
  await db.kvp.put(
    {
      ...(await encryptWallet(entropy, password)),
      address: derived.address,
      swapAddress: derived.swapAddress,
      net: net,
      coinType: resolvedCoinType,
    },
    "wallet"
  );

  return decryptKeys(net, password);
}

export async function keysExist(): Promise<boolean> {
  return !!(await db.kvp.get("wallet"));
}
