import "./polyfill";
import { expose } from "comlink";
import ElectrumManager from "../ElectrumManager";
import { FTWorker, NFTWorker, RXDWorker, VaultWorker } from "./index";
import db from "@app/db";
import { ElectrumStatus, VaultRecord } from "@app/types";
import { ElectrumRefResponse, NetworkKey } from "@lib/types";
import { network } from "@app/signals";
import config from "@app/config.json";
import { findSwaps } from "./findSwaps";
import { isUtxoUnspent } from "./isUtxoUnspent";
import { verifyTransactionHash, hexToBytes } from "@lib/crypto";
import { HeadersSubscription } from "./Headers";
import { verifyTransactionInclusion, type TxVerification } from "@app/verifier";

type Timer = ReturnType<typeof setTimeout> | null;

declare const self: SharedWorkerGlobalScope;

const electrum = new ElectrumManager();
// Block-header chain sync. Downloads + PoW-validates headers from a pinned
// checkpoint so SPV (transaction-inclusion) verification has a trusted
// Merkle-root source. Enabled now that SPV verification is implemented
// (see verifier.ts / @lib/spv, audit R14).
const headers = new HeadersSubscription(electrum);
let address = "";
let servers: string[] = [];
let serverNum = 0;
let reconnectTimer: Timer = null;
let connectTimer: Timer = null;
let connectionAttempts = 0;
let connectedGeneration = 0;
const MAX_ATTEMPTS_BEFORE_PAUSE = 10; // Pause after trying all servers twice
const FAILOVER_TIMEOUT = 8000; // 8 seconds before trying next server
const PAUSE_DURATION = 30000; // 30 second pause after max attempts

function workerLog(msg: string, data?: unknown) {
  console.debug(msg, data);
}

const RXINDEXER_WSS = "wss://electrumx.radiantcore.org";

// Resolve a WAVE name to its full indexer record (incl. `ref`). Tries the
// connected electrum server first, then falls back to a direct RXinDexer WSS
// call — the connected server frequently doesn't expose the wave.* methods, so
// without this fallback resolution (and name recovery) fails with
// "Name not found on the indexer" even though the indexer knows the name.
async function resolveWaveRaw(
  bareName: string
): Promise<{ ref?: string; target?: string } | null> {
  // 1. Connected server.
  try {
    if (electrum.client && electrum.connected()) {
      const r = (await electrum.client.request("wave.resolve", bareName)) as
        | { ref?: string; target?: string }
        | null
        | undefined;
      if (r && r.ref) return r;
    }
  } catch {
    // Connected server doesn't support wave.resolve — fall through.
  }

  // 2. Direct WSS to RXinDexer (server.version handshake, then wave.resolve).
  try {
    const ws = new WebSocket(RXINDEXER_WSS);
    return await new Promise<{ ref?: string; target?: string } | null>(
      (resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve(null);
        }, 10000);
        let versionSent = false;
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "server.version",
              params: ["photonic", "1.4"],
            })
          );
        };
        ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data as string);
            if (!versionSent) {
              versionSent = true;
              ws.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "wave.resolve",
                  params: [bareName],
                })
              );
              return;
            }
            clearTimeout(timeout);
            ws.close();
            resolve(data.result || null);
          } catch {
            clearTimeout(timeout);
            ws.close();
            resolve(null);
          }
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          ws.close();
          resolve(null);
        };
      }
    );
  } catch {
    return null;
  }
}

/** One side-entry of the RXinDexer swap-index orderbook (swap.get_orders with both refs). */
export interface SwapIndexOrder {
  order_id: string; // 72-hex backing outpoint (byte-reversed by hash_to_hex_str)
  tx_hash: string; // the RSWP advertisement txid, display order — fillable via its ad
  price: number;
  amount: number;
  side: "buy" | "sell";
  maker_address: string | null;
  status: string; // "open" | ...
}

const worker = {
  ready: false,
  active: true,
  setServers(newServers: string[]) {
    workerLog("[Worker] setServers called:", newServers);
    serverNum = 0;
    servers = newServers;
  },
  /**
   * Set the worker's network. The SharedWorker has its own module-scoped
   * copy of the `network` signal (separate from the main thread), so the
   * main thread must push the active network in. Header validation
   * (ASERT difficulty anchors in Headers.ts) depends on this being correct;
   * without it headers would validate against the testnet default and fail
   * on mainnet. Call before `connect`.
   */
  setNetwork(net: NetworkKey) {
    network.value = config.networks[net];
  },
  connect(_address: string) {
    workerLog("[Worker] connect called", {
      address: _address,
      servers,
      serverNum,
    });
    const endpoint = servers[serverNum];
    workerLog("[Worker] Selected endpoint:", endpoint);

    // If already connected to ANY valid server, don't tear down the connection
    // just because the React effect re-fired with a different serverNum.
    // Only reconnect if the address changed or we have no connection at all.
    if (electrum.connected() && address === _address) {
      workerLog("[Worker] Already connected, skipping reconnect");
      return;
    }

    if (electrum.endpoint !== endpoint || address !== _address) {
      this.ready = true;
      address = _address;
      clearTimers();
      workerLog(`[Worker] Connecting to: ${endpoint}`);
      db.kvp.put(
        { status: ElectrumStatus.CONNECTING, server: endpoint },
        "electrumStatus"
      );
      const result = electrum.changeEndpoint(endpoint);
      workerLog("[Worker] changeEndpoint result:", result);
      if (!result) {
        workerLog("[Worker] changeEndpoint failed, trying next server");
        tryNextServer();
        return;
      }
      connectTimer = setTimeout(tryNextServer, FAILOVER_TIMEOUT);
    } else {
      workerLog(
        "[Worker] Skipping connection - already connected to same endpoint/address"
      );
    }
  },
  reconnect() {
    return electrum.reconnect();
  },
  disconnect(reason: string) {
    electrum.disconnect(reason);
  },
  async broadcast(hex: string): Promise<string> {
    if (!electrum.client || !electrum.connected()) {
      throw new Error("Electrum client not connected");
    }

    const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error("Broadcast timeout")), ms)
        ),
      ]);

    try {
      const result = await withTimeout(
        electrum.client.request("blockchain.transaction.broadcast", hex),
        15000
      );
      workerLog("[Worker] Broadcast result:", result);
      return result as string;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("transactionalreadyinblockchain")) {
        workerLog("[Worker] Broadcast already in blockchain");
        return "";
      }
      throw error;
    }
  },
  async getRef(ref: string) {
    return (await electrum.client?.request(
      "blockchain.ref.get",
      ref
    )) as ElectrumRefResponse;
  },
  async getTransaction(txid: string) {
    const rawTx = (await electrum.client?.request(
      "blockchain.transaction.get",
      txid
    )) as string;

    // SECURITY FIX (C5): Verify transaction hash matches txid
    // This prevents transaction poisoning from malicious servers
    if (rawTx) {
      try {
        const txBytes = hexToBytes(rawTx);
        if (!verifyTransactionHash(txBytes, txid)) {
          console.error(
            `[getTransaction] SECURITY ALERT: Transaction hash mismatch for ${txid}`
          );
          throw new Error(
            "Transaction verification failed: hash does not match txid"
          );
        }
      } catch (verifyError) {
        console.error(
          `[getTransaction] Transaction verification error:`,
          verifyError
        );
        throw new Error(
          `Transaction verification failed: ${
            verifyError instanceof Error
              ? verifyError.message
              : String(verifyError)
          }`
        );
      }
    }

    return rawTx;
  },
  /**
   * SPV-verify that a confirmed transaction is actually included in the chain
   * (audit R14). Fetches a Merkle proof from the server and checks it against
   * our locally PoW-validated header at the proof's height. Returns an
   * `unverified` result (never throws) when headers aren't synced yet or the
   * proof doesn't check out.
   */
  async verifyTransaction(
    txid: string,
    height?: number
  ): Promise<TxVerification> {
    if (!electrum.client || !electrum.connected()) {
      return { status: "unverified", reason: "error" };
    }
    return verifyTransactionInclusion(electrum.client, txid, height);
  },
  isReady() {
    return this.ready;
  },
  async syncPending() {
    await rxd.syncPending();
    await ft.syncPending();
    await nft.syncPending();
    await vault.syncPending();
  },
  async manualSync() {
    await rxd.manualSync();
    await ft.manualSync();
    await nft.manualSync();
    await vault.manualSync();
  },
  async discoverVaults(wif: string, address: string, swapWif?: string) {
    return vault.discoverVaults(wif, address, swapWif);
  },
  async addVault(record: VaultRecord) {
    return vault.addVault(record);
  },
  setActive(active: boolean) {
    const reactivated = active && !this.active;
    this.active = active;
    // When activity resumes (returning from background, or after the
    // consolidate() routine's setActive(false)/setActive(true) bracket), drain
    // any subscription statuses that were queued while inactive instead of
    // waiting for the next push or the throttled reactivation sync.
    if (reactivated) {
      this.syncPending().catch(() => {});
    }
  },
  isActive() {
    return this.active;
  },
  async fetchGlyph(ref: string) {
    return nft.fetchGlyph(ref);
  },
  // Recover a WAVE name into this wallet by name. Handles the case where the
  // local glyph row is gone and the name rests under an auth-covenant singleton
  // (post target-update) that never appears in NFT listunspent. Resolve the ref
  // here (with the WSS fallback) so recovery works even when the connected
  // server lacks wave.*; NFTWorker.recoverWaveName does the chain work.
  async recoverWaveName(name: string) {
    const bareName = (name || "").toLowerCase().split(".")[0].trim();
    if (!bareName) {
      return { recovered: false, name, reason: "Empty name" };
    }
    const res = await resolveWaveRaw(bareName);
    if (!res?.ref) {
      return {
        recovered: false,
        name: bareName,
        reason: "Name not found on the indexer",
      };
    }
    return nft.recoverWaveName(bareName, res.ref);
  },
  async findSwaps(address: string) {
    return findSwaps(electrum, address);
  },
  async isUtxoUnspent(txid: string, vout: number, scriptHash: string) {
    return isUtxoUnspent(electrum, txid, vout, scriptHash);
  },
  // List unspent outputs for an arbitrary scripthash. Used by covenant tracking
  // (covenant.ts) to reconcile listing/soulbound/authority UTXOs, which rest in
  // scripts the per-contract subscriptions don't watch.
  async getUtxosByScriptHash(scriptHash: string) {
    return (
      ((await electrum.client?.request(
        "blockchain.scripthash.listunspent",
        scriptHash
      )) as {
        tx_hash: string;
        tx_pos: number;
        height: number;
        value: number;
      }[]) || []
    );
  },
  async getBlockHeight(): Promise<number> {
    try {
      const result = (await electrum.client?.request(
        "blockchain.headers.subscribe"
      )) as { height: number; hex: string } | undefined;
      return result?.height ?? 0;
    } catch {
      return 0;
    }
  },
  // RXinDexer swap-index orderbook for a (base, quote) pair. Both refs are the
  // `<sha256-of-ref hex>_0` query form. Returns null when the server lacks the
  // swap index (older indexers / not yet deployed) so callers can degrade.
  async getSwapOrderbook(baseRef: string, quoteRef: string) {
    try {
      const result = (await electrum.client?.request(
        "swap.get_orders",
        baseRef,
        quoteRef
      )) as
        | {
            bids: SwapIndexOrder[];
            asks: SwapIndexOrder[];
          }
        | { error: string }
        | undefined;
      if (!result || "error" in result) return null;
      return result;
    } catch {
      return null;
    }
  },
  async resolveWaveName(name: string): Promise<{
    target: string;
    isDuplicate?: boolean;
    warning?: string;
  } | null> {
    // Normalize input: strip .rxd suffix if present to get bare name
    const parts = name.toLowerCase().split(".");
    const bareName = parts[0];
    const domain = parts[1] || "rxd";

    try {
      // Query local DB first — all synced NFTs (including other wallets' names)
      // are stored in db.glyph by the indexer sync
      const GLYPH_WAVE = 11;
      const match = await db.glyph
        .filter((glyph) => {
          if (!glyph.p?.includes(GLYPH_WAVE)) return false;
          if (glyph.spent !== 0) return false;
          const attrs = glyph.attrs as Record<string, string> | undefined;
          if (!attrs) return false;
          const glyphName = (attrs.name || "").toLowerCase();
          const glyphDomain = (attrs.domain || "rxd").toLowerCase();
          return glyphName === bareName && glyphDomain === domain;
        })
        .first();

      if (match) {
        const attrs = match.attrs as Record<string, string>;
        const target = attrs.target || "";
        const isDuplicate = match.is_wave_duplicate === true;
        if (target) {
          return {
            target,
            isDuplicate,
            warning: isDuplicate
              ? "⚠️ DUPLICATE: This is NOT the canonical (first) registration. It is NOT used for name resolution. Consider burning this token."
              : undefined,
          };
        }
      }

      // Fall back to RPC (RXinDexer supports this natively)
      // Try the connected server first, then fall back to RXinDexer directly
      type WaveResolveResult =
        | { target?: string; is_duplicate?: boolean; warning?: string }
        | null
        | undefined;

      // Try connected server first
      try {
        if (electrum.client && electrum.connected()) {
          const result = (await electrum.client.request(
            "wave.resolve",
            bareName
          )) as WaveResolveResult;
          if (result && result.target) {
            return {
              target: result.target,
              isDuplicate: result.is_duplicate,
              warning: result.warning,
            };
          }
        }
      } catch {
        // Connected server doesn't support wave.resolve — fall through to direct call
      }

      // Fall back: direct WebSocket RPC to RXinDexer
      try {
        const ws = new WebSocket(RXINDEXER_WSS);
        const result = await new Promise<WaveResolveResult>(
          (resolve, reject) => {
            const timeout = setTimeout(() => {
              ws.close();
              reject(new Error("timeout"));
            }, 10000);
            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "server.version",
                  params: ["photonic", "1.4"],
                })
              );
            };
            let versionSent = false;
            ws.onmessage = (ev) => {
              try {
                const data = JSON.parse(ev.data as string);
                if (!versionSent) {
                  versionSent = true;
                  ws.send(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      id: 2,
                      method: "wave.resolve",
                      params: [bareName],
                    })
                  );
                  return;
                }
                clearTimeout(timeout);
                ws.close();
                if (data.result) resolve(data.result);
                else resolve(null);
              } catch {
                clearTimeout(timeout);
                ws.close();
                resolve(null);
              }
            };
            ws.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("ws error"));
            };
            ws.onclose = () => {
              clearTimeout(timeout);
            };
          }
        );
        if (result && result.target) {
          return {
            target: result.target,
            isDuplicate: result.is_duplicate,
            warning: result.warning,
          };
        }
      } catch (e) {
        console.warn("[WAVE] Direct RXinDexer resolve failed:", e);
      }

      return null;
    } catch {
      return null;
    }
  },
  async checkWaveAvailable(name: string): Promise<boolean> {
    // Normalize input: strip .rxd suffix if present to get bare name
    const parts = name.toLowerCase().split(".");
    const bareName = parts[0];

    // Try RPC via connected server first
    try {
      if (electrum.client && electrum.connected()) {
        const result = (await electrum.client.request(
          "wave.check_available",
          bareName
        )) as { available: boolean } | null | undefined;

        if (result && typeof result === "object" && "available" in result) {
          return result.available;
        }
      }
    } catch {
      // RPC not supported — fall through to direct WebSocket
    }

    // Fall back: direct WebSocket RPC to RXinDexer (same as waveResolveRPC)
    try {
      const ws = new WebSocket(RXINDEXER_WSS);
      const result = await new Promise<{ available: boolean } | null>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error("timeout"));
          }, 10000);
          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "server.version",
                params: ["photonic", "1.4"],
              })
            );
          };
          let versionSent = false;
          ws.onmessage = (ev) => {
            try {
              const data = JSON.parse(ev.data as string);
              if (!versionSent) {
                versionSent = true;
                ws.send(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "wave.check_available",
                    params: [bareName],
                  })
                );
                return;
              }
              clearTimeout(timeout);
              ws.close();
              if (
                data.result &&
                typeof data.result === "object" &&
                "available" in data.result
              ) {
                resolve(data.result);
              } else {
                resolve(null);
              }
            } catch {
              clearTimeout(timeout);
              ws.close();
              resolve(null);
            }
          };
          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("ws error"));
          };
          ws.onclose = () => {
            clearTimeout(timeout);
          };
        }
      );
      if (result) return result.available;
    } catch (e) {
      console.warn("[WAVE] Direct RXinDexer availability check failed:", e);
    }

    // Fall back to local DB check
    const domain = parts[1] || "rxd";
    const GLYPH_WAVE = 11;

    const existing = await db.glyph
      .filter((glyph) => {
        if (!glyph.p?.includes(GLYPH_WAVE)) return false;
        if (glyph.spent !== 0) return false;
        const attrs = glyph.attrs as Record<string, string> | undefined;
        if (!attrs) return false;
        return (
          (attrs.name || "").toLowerCase() === bareName &&
          (attrs.domain || "rxd").toLowerCase() === domain
        );
      })
      .first();

    // If found in local DB, it's taken; if not found locally, we can't be sure
    // (the name might exist on chain but not synced), so throw to signal uncertainty
    if (existing) return false;
    throw new Error("Server does not support WAVE availability checking");
  },
};

const rxd = new RXDWorker(worker, electrum);
const nft = new NFTWorker(worker, electrum);
const ft = new FTWorker(worker, electrum);
const vault = new VaultWorker(worker, electrum);

export type Worker = typeof worker;

function clearTimers() {
  if (connectTimer) {
    clearTimeout(connectTimer);
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
}

function tryNextServer() {
  connectionAttempts++;
  const totalServers = Math.max(1, servers.length);
  serverNum = (serverNum + 1) % totalServers;

  // If we've tried all servers multiple times, pause before retrying
  if (connectionAttempts >= MAX_ATTEMPTS_BEFORE_PAUSE) {
    workerLog(
      `[Worker] Tried all servers ${Math.floor(
        connectionAttempts / totalServers
      )} times, pausing for ${PAUSE_DURATION / 1000}s`
    );
    db.kvp.put(
      { status: ElectrumStatus.DISCONNECTED, reason: "all_servers_failed" },
      "electrumStatus"
    );
    reconnectTimer = setTimeout(() => {
      connectionAttempts = 0; // Reset counter after pause
      worker.connect(address);
    }, PAUSE_DURATION);
    return;
  }

  workerLog(
    `[Worker] Trying next server (attempt ${connectionAttempts}): ${servers[serverNum]}`
  );
  worker.connect(address);
}

electrum.addEvent("connected", () => {
  workerLog("[Worker] CONNECTED event received");
  clearTimers();
  connectionAttempts = 0; // Reset on successful connection
  connectedGeneration = electrum.generation;
  db.kvp.put(
    { status: ElectrumStatus.CONNECTED, server: electrum.endpoint },
    "electrumStatus"
  );
  // Start header-chain sync independently of the wallet address — SPV needs
  // headers regardless of which account is loaded.
  headers.register().catch((err) => {
    workerLog("[Worker] Header subscription failed:", err);
  });
  if (address) {
    workerLog("[Worker] Connected, registering address:", address);
    rxd.register(address);
    nft.register(address);
    ft.register(address);
    vault.register(address);
  }
});

electrum.addEvent("error", (error: unknown) => {
  workerLog("[Worker] ERROR event received:", error);
});

electrum.addEvent("close", (event: unknown) => {
  const { reason } = event as { reason: string };
  workerLog("[Worker] CLOSE event received", {
    reason,
    gen: electrum.generation,
    connGen: connectedGeneration,
  });

  // Ignore close events from old clients when we intentionally switched servers
  if (reason === "switching") {
    workerLog("[Worker] Ignoring close from intentional server switch");
    return;
  }

  // Ignore stale close events from old connections
  if (electrum.connected()) {
    workerLog(
      "[Worker] Ignoring stale close - already connected to another server"
    );
    return;
  }

  db.kvp.put({ status: ElectrumStatus.DISCONNECTED, reason }, "electrumStatus");

  // Reason will be "user" for disconnects initiated by the user
  if (!reason) {
    workerLog("[Worker] Server dropped connection, will try next server in 5s");
    reconnectTimer = setTimeout(tryNextServer, 5000);
  }
});

// Android Chrome doesn't support shared workers, fall back to dedicated worker
if (
  typeof SharedWorkerGlobalScope !== "undefined" &&
  globalThis instanceof SharedWorkerGlobalScope
) {
  self.addEventListener("connect", (e) => expose(worker, e.ports[0]));
} else {
  expose(worker);
}
