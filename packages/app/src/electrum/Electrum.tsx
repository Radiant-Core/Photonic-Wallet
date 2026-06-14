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
import type { VaultRecord, VaultScanResult } from "@app/types";
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
  discoverVaults: (
    wif: string,
    address: string,
    swapWif?: string
  ) => VaultScanResult;
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
  getUtxosByScriptHash: (scriptHash: string) => {
    tx_hash: string;
    tx_pos: number;
    height: number;
    value: number;
    refs?: { ref: string; type: string }[];
  }[];
  getBlockHeight: () => number;
  getSwapOrderbook: (
    baseRef: string,
    quoteRef: string
  ) => {
    bids: import("./worker/electrumWorker").SwapIndexOrder[];
    asks: import("./worker/electrumWorker").SwapIndexOrder[];
  } | null;
  listMarkets: (
    limit?: number,
    offset?: number
  ) => import("./worker/electrumWorker").IndexedMarket[];
  getMarket: (
    marketRef: string
  ) => import("./worker/electrumWorker").IndexedMarket | null;
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

  // Discover vaults when wallet is unlocked and connected.
  //
  // `discoveryRanRef` latches ONLY after a confirmed-complete scan (no skipped
  // transactions and no throw). A partial or failed scan leaves it false so a
  // later CONNECTED event retries — otherwise a transient timeout would strand
  // the user at "no vaults" with no automatic recovery. `discoveryInFlightRef`
  // guards against launching overlapping runs while one is still awaiting.
  const discoveryRanRef = useRef(false);
  const discoveryInFlightRef = useRef(false);
  useEffect(() => {
    const discover = async () => {
      if (
        discoveryRanRef.current ||
        discoveryInFlightRef.current ||
        !wallet.value.wif ||
        !wallet.value.address ||
        electrumStatus.value !== ElectrumStatus.CONNECTED
      ) {
        return;
      }
      discoveryInFlightRef.current = true;
      // Assume complete; any skipped tx or thrown error flips this false.
      let complete = true;

      // An unlocked, connected wallet is a strong engagement signal — ask the
      // browser to move this origin into the persistent storage bucket so the
      // IndexedDB-only vault records (and the rest of wallet state) aren't
      // evicted under storage pressure or after ~7 idle days on Safari/iOS.
      try {
        if (navigator.storage?.persist && navigator.storage.persisted) {
          const already = await navigator.storage.persisted();
          if (!already) {
            const granted = await navigator.storage.persist();
            console.debug(`[Storage] Persistent storage granted: ${granted}`);
          }
        }
      } catch (e) {
        console.debug("[Storage] persist() request failed:", e);
      }

      console.debug("[Electrum] Starting vault discovery");
      try {
        // Materialise WIFs only for the duration of the worker calls; refs
        // fall out of scope when this effect returns.
        const wifStr = wallet.value.wif.toString();
        const swapWifStr = wallet.value.swapWif?.toString();
        // Scan main address - also try swapWif for decryption if main fails
        const mainResult = await electrumWorker.value.discoverVaults(
          wifStr,
          wallet.value.address,
          swapWifStr // Try swap WIF if main fails to decrypt
        );
        if (mainResult.skipped > 0) complete = false;
        if (mainResult.discovered > 0) {
          console.log(
            `[Electrum] Discovered ${mainResult.discovered} vault(s) on main address`
          );
        }

        // Scan swap address if different from main
        if (swapWifStr && wallet.value.swapAddress) {
          const swapResult = await electrumWorker.value.discoverVaults(
            swapWifStr,
            wallet.value.swapAddress,
            wifStr // Try main WIF if swap fails to decrypt
          );
          if (swapResult.skipped > 0) complete = false;
          if (swapResult.discovered > 0) {
            console.log(
              `[Electrum] Discovered ${swapResult.discovered} vault(s) on swap address`
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
        // A throw (e.g. history could not be loaded) means the scan did not
        // complete — keep the latch open so the next CONNECTED event retries.
        complete = false;
        console.warn("[Electrum] Vault discovery failed:", error);
      } finally {
        discoveryInFlightRef.current = false;
        // Latch only on a confirmed-complete scan (no skipped tx, no throw).
        if (complete) discoveryRanRef.current = true;
      }
    };

    discover();
  }, [wallet.value.wif, wallet.value.address, electrumStatus.value]);

  return null;
}
