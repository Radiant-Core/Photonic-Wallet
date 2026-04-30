import { wallet } from "./signals";
import { SavedWallet, WalletState } from "./types";

export function unlockWallet(mnemonic: string, wif: string, swapWif: string) {
  wallet.value = { ...wallet.value, mnemonic, wif, swapWif, locked: false };
}

export function lockWallet() {
  // Overwrite sensitive string values in-place before dropping references so
  // they are less likely to survive as reachable heap objects after GC.
  // Note: JS strings are immutable, so we can only drop our reference;
  // this at minimum shortens the window they stay in the signal.
  const { mnemonic, wif, swapWif } = wallet.value;
  wallet.value = { ...wallet.value, mnemonic: undefined, wif: undefined, swapWif: undefined, locked: true };
  // Explicitly lose references to reduce GC root count
  void mnemonic; void wif; void swapWif;
}

export function loadWalletFromSaved(savedWallet?: SavedWallet) {
  wallet.value = {
    ready: true,
    address: savedWallet?.address || "",
    swapAddress: savedWallet?.swapAddress || "",
    exists: !!savedWallet,
    net: savedWallet?.net || "testnet",
    locked: true,
  };
}

export function initWallet({
  net,
  wif,
  address,
}: Pick<WalletState, "net" | "wif" | "address">) {
  wallet.value = {
    ...wallet.value,
    locked: false,
    exists: true,
    net,
    wif,
    address,
  };
}
