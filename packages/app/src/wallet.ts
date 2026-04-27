import { wallet } from "./signals";
import { SavedWallet, WalletState } from "./types";

export function unlockWallet(mnemonic: string, wif: string, swapWif: string) {
  wallet.value = { ...wallet.value, mnemonic, wif, swapWif, locked: false };
}

export function lockWallet() {
  wallet.value = { ...wallet.value, mnemonic: undefined, wif: undefined, locked: true };
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
