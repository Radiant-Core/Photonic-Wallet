import { openModal, wallet } from "./signals";
import { SavedWallet, WalletState } from "./types";
import { SecretBytes, disposeSecret } from "./secretBytes";

/**
 * Unlock the wallet by ingesting the secrets produced by `decryptKeys`.
 *
 * Inputs are JS strings because the upstream crypto chain
 * (`entropyToMnemonic` and `PrivateKey.toString()`) returns strings — those
 * are out of our control. We immediately encode them to `SecretBytes` so
 * the *persistent* references in `wallet.value` are zeroable on lock. The
 * original string arguments fall out of scope after this function returns;
 * callers (currently only `Unlock.tsx`'s `onSuccess`) should drop their
 * references promptly. Any prior secrets in state are wiped first.
 */
export function unlockWallet(
  mnemonic: string,
  wif: string,
  swapWif: string,
  coinType?: number
) {
  wipeSecrets();
  wallet.value = {
    ...wallet.value,
    mnemonic: SecretBytes.fromString(mnemonic),
    wif: SecretBytes.fromString(wif),
    swapWif: SecretBytes.fromString(swapWif),
    // Track which derivation path produced these keys. Required by R26 so
    // that `deriveEncryptionKeypair` can derive a recipient key on the same
    // coin type the wallet actually spends from — otherwise legacy
    // (coinType 0) wallets get a derivation mismatch and can't decrypt
    // their own historical encrypted content.
    coinType: coinType ?? wallet.value.coinType,
    locked: false,
  };
}

/**
 * Zero the `SecretBytes` buffers held in `wallet.value` and drop the
 * references. Idempotent. Used by `lockWallet`, the idle timer, the
 * `beforeunload` handler, and the cross-tab logout listener.
 */
export function wipeSecrets(): void {
  const { mnemonic, wif, swapWif } = wallet.value;
  mnemonic?.wipe();
  wif?.wipe();
  swapWif?.wipe();
}

/**
 * Lock the wallet: wipe the byte buffers, drop the references in signal
 * state, and flip `locked: true`. After this returns, no readable copy of
 * the mnemonic/WIF remains in the wallet signal — the heap snapshot should
 * not contain a recoverable BIP-39 word list.
 */
export function lockWallet() {
  wipeSecrets();
  wallet.value = {
    ...wallet.value,
    mnemonic: disposeSecret(wallet.value.mnemonic),
    wif: disposeSecret(wallet.value.wif),
    swapWif: disposeSecret(wallet.value.swapWif),
    locked: true,
  };
}

/**
 * Gate a spending action behind an unlocked wallet.
 *
 * If the wallet is locked, open the global unlock modal (handled by the
 * `<Unlock />` component mounted in `App`) and, on a successful unlock, invoke
 * `retry` — typically the calling handler itself, so the action resumes where
 * the user left off. This replaces the older pattern of dead-ending with a
 * "Wallet locked" error toast: instead of telling the user to go unlock, we
 * put the password field in front of them and continue automatically.
 *
 * Returns `true` when the wallet was locked (the caller should stop — the
 * action will be retried after unlock) and `false` when already unlocked (the
 * caller should proceed).
 *
 * Usage:
 *   const handleFoo = async () => {
 *     if (requireUnlock(handleFoo)) return;
 *     // ...proceeds only when unlocked
 *   };
 */
export function requireUnlock(retry: () => void): boolean {
  if (!wallet.value.locked) return false;
  openModal.value = {
    modal: "unlock",
    onClose: (success: boolean) => {
      if (success) retry();
    },
  };
  return true;
}

export function loadWalletFromSaved(savedWallet?: SavedWallet) {
  wallet.value = {
    ready: true,
    address: savedWallet?.address || "",
    swapAddress: savedWallet?.swapAddress || "",
    exists: !!savedWallet,
    net: savedWallet?.net || "testnet",
    // SavedWallet may legitimately have an undefined coinType for
    // pre-v3.0.0 blobs; the unlocker resolves and persists the right
    // value, after which this hydration keeps state in sync.
    coinType: savedWallet?.coinType,
    locked: true,
  };
}

export function initWallet({
  net,
  wif,
  address,
  coinType,
}: Pick<WalletState, "net" | "address"> & { wif: string; coinType?: number }) {
  wallet.value = {
    ...wallet.value,
    locked: false,
    exists: true,
    net,
    wif: SecretBytes.fromString(wif),
    address,
    coinType: coinType ?? wallet.value.coinType,
  };
}

/**
 * Run a callback with the current spending WIF as a transient string.
 * Returns `undefined` if the wallet is locked.
 *
 * Prefer this over `wallet.value.wif?.toString()` because the wif string
 * is scoped to the callback frame — easier to audit that no surrounding
 * code retains a reference. Throws are propagated.
 */
export function withWif<T>(cb: (wif: string) => T): T | undefined {
  const sb = wallet.value.wif;
  if (!sb || sb.isWiped) return undefined;
  return cb(sb.toString());
}

/** As `withWif` but for the swap WIF. */
export function withSwapWif<T>(cb: (wif: string) => T): T | undefined {
  const sb = wallet.value.swapWif;
  if (!sb || sb.isWiped) return undefined;
  return cb(sb.toString());
}

/**
 * Run a callback with the BIP-39 mnemonic as a transient string. Used by
 * `deriveEncryptionKeypair` and CEK-unwrap flows that need to re-derive
 * keys from the seed.
 */
export function withMnemonic<T>(cb: (mnemonic: string) => T): T | undefined {
  const sb = wallet.value.mnemonic;
  if (!sb || sb.isWiped) return undefined;
  return cb(sb.toString());
}
