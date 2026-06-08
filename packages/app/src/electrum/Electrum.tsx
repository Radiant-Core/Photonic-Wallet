import { useLiveQuery } from "dexie-react-hooks";
import { t } from "@lingui/macro";
import db from "@app/db";
import { useEffect, useRef } from "react";
import { electrumStatus, wallet } from "@app/signals";
import { useToast } from "@chakra-ui/react";
import { ContractType, ElectrumStatus, SmartToken } from "@app/types";
import { wrap } from "comlink";
import { signal } from "@preact/signals-react";
import { ElectrumRefResponse, ElectrumUtxo } from "@lib/types";
import type { VaultRecord } from "@app/types";
import { discoverCovenants } from "@app/covenant";

// Android Chrome doesn't support shared workers, fall back to dedicated worker
// TEMP: Force dedicated worker for debugging (SharedWorker logs go to separate console)
const sharedSupported = false; // "SharedWorker" in globalThis;

// Detect Safari - it has issues with ES module workers
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
if (isSafari) {
  console.warn("[Electrum] Safari detected - module workers may have issues");
}

// SharedWorker and Worker must be used directly so Vite can compile the worker
let worker: Worker | MessagePort;
try {
  worker = sharedSupported
    ? new SharedWorker(new URL("./worker/electrumWorker.ts", import.meta.url), {
        type: "module",
      }).port
    : new Worker(new URL("./worker/electrumWorker.ts", import.meta.url), {
        type: "module",
      });

  // Add error listener to catch worker initialization failures
  if (worker instanceof Worker) {
    worker.onerror = (e) => {
      console.error("[Electrum] Worker error:", e.message, e);
    };
  }
} catch (e) {
  console.error("[Electrum] Failed to create worker:", e);
  throw e;
}

const wrapped = wrap<{
  setServers: (servers: string[]) => void;
  setNetwork: (net: "mainnet" | "testnet") => void;
  connect: (address: string) => void;
  isReady: () => boolean;
  reconnect: () => boolean;
  disconnect: (reason: string) => void;
  broadcast: (hex: string) => string;
  getRef: (ref: string) => ElectrumRefResponse;
  getTransaction: (txid: string) => string;
  verifyTransaction: (
    txid: string,
    height?: number
  ) =>
    | { status: "verified"; blockHeight: number }
    | { status: "unverified"; reason: string };
  syncPending: (manual?: boolean) => void;
  manualSync: () => void;
  discoverVaults: (wif: string, address: string, swapWif?: string) => number;
  addVault: (record: VaultRecord) => void;
  setActive: (active: boolean) => void;
  isActive: () => boolean;
  fetchGlyph: (refBE: string) => SmartToken | undefined;
  recoverWaveName: (name: string) => {
    recovered: boolean;
    name: string;
    ref?: string;
    reason?: string;
  };
  findSwaps(
    address: string
  ): { contractType: ContractType; utxo: ElectrumUtxo }[];
  isUtxoUnspent: (txid: string, vout: number, scriptHash: string) => boolean;
  getUtxosByScriptHash: (
    scriptHash: string
  ) => { tx_hash: string; tx_pos: number; height: number; value: number }[];
  getBlockHeight: () => number;
  resolveWaveName: (name: string) => { target: string } | null;
  checkWaveAvailable: (name: string) => boolean;
}>(worker);
export const electrumWorker = signal<typeof wrapped>(wrapped);

export default function Electrum() {
  const toast = useToast();

  // Electrum connection is handled by a worker. It will set connection status in the database using Dexie.
  useLiveQuery(async () => {
    const result = (await db.kvp.get("electrumStatus")) as { status: number };
    if (
      (await electrumWorker.value.isReady()) &&
      result &&
      result.status !== electrumStatus.value
    ) {
      electrumStatus.value = result.status;

      if (result.status === ElectrumStatus.CONNECTED) {
        toast({
          title: t`Connected`,
          status: "success",
        });
      } else if (result.status === ElectrumStatus.DISCONNECTED) {
        toast({
          title: t`Disconnected`,
          // FIXME
          status: "error", //reason === "user" ? "success" : "error",
        });
      }
    }
  });

  const servers = useLiveQuery(async () => {
    const servers = (await db.kvp.get("servers")) as {
      mainnet: string[];
      testnet: string[];
    };
    return servers?.[wallet.value.net];
  }, [wallet.value.net]);

  // Stabilize servers reference - only update when content actually changes
  const serversRef = useRef<string[] | undefined>();
  const stableServers = (() => {
    const prev = serversRef.current;
    if (
      prev &&
      servers &&
      prev.length === servers.length &&
      prev.every((s, i) => s === servers[i])
    ) {
      return prev;
    }
    serversRef.current = servers;
    return servers;
  })();

  // Reconnect when server config changes or when wallet is ready
  useEffect(() => {
    if (stableServers && wallet.value.address) {
      console.debug(
        "[Electrum] Connecting with servers:",
        stableServers.length
      );
      // Push the active network into the worker before connecting so header
      // validation uses the correct ASERT anchors (worker has its own signal
      // scope — see worker setNetwork / audit R14).
      electrumWorker.value.setNetwork(wallet.value.net);
      electrumWorker.value.setServers(stableServers);
      electrumWorker.value.connect(wallet.value.address);
    }
  }, [stableServers, wallet.value.address]);

  // Discover vaults when wallet is unlocked and connected
  const discoveryRanRef = useRef(false);
  useEffect(() => {
    const discover = async () => {
      if (
        discoveryRanRef.current ||
        !wallet.value.wif ||
        !wallet.value.address ||
        electrumStatus.value !== ElectrumStatus.CONNECTED
      ) {
        return;
      }
      discoveryRanRef.current = true;
      console.debug("[Electrum] Starting vault discovery");
      try {
        // Materialise WIFs only for the duration of the worker calls; refs
        // fall out of scope when this effect returns.
        const wifStr = wallet.value.wif.toString();
        const swapWifStr = wallet.value.swapWif?.toString();
        // Scan main address - also try swapWif for decryption if main fails
        const mainCount = await electrumWorker.value.discoverVaults(
          wifStr,
          wallet.value.address,
          swapWifStr // Try swap WIF if main fails to decrypt
        );
        if (mainCount > 0) {
          console.log(
            `[Electrum] Discovered ${mainCount} vault(s) on main address`
          );
        }

        // Scan swap address if different from main
        if (swapWifStr && wallet.value.swapAddress) {
          const swapCount = await electrumWorker.value.discoverVaults(
            swapWifStr,
            wallet.value.swapAddress,
            wifStr // Try main WIF if swap fails to decrypt
          );
          if (swapCount > 0) {
            console.log(
              `[Electrum] Discovered ${swapCount} vault(s) on swap address`
            );
          }
        }

        // Discover covenant-held tokens (soulbound / authority-gated) owned by
        // this wallet from the indexer, so they appear after a re-import / on a
        // fresh device even without local covenant tracking. Owner-stable
        // scripthashes only — royalty listings stay on local tracking. Failures
        // are non-fatal (best-effort, retried on next connect).
        try {
          await discoverCovenants(wallet.value.address);
          if (wallet.value.swapAddress) {
            await discoverCovenants(wallet.value.swapAddress);
          }
        } catch (covErr) {
          console.warn("[Electrum] Covenant discovery failed:", covErr);
        }
      } catch (error) {
        console.warn("[Electrum] Vault discovery failed:", error);
      }
    };

    discover();
  }, [wallet.value.wif, wallet.value.address, electrumStatus.value]);

  return null;
}
