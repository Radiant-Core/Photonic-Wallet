import "./polyfill";
import { expose } from "comlink";
import ElectrumManager from "../ElectrumManager";
import { FTWorker, NFTWorker, RXDWorker, VaultWorker } from "./index";
import db from "@app/db";
import { ElectrumStatus, VaultRecord } from "@app/types";
import { ElectrumRefResponse } from "@lib/types";
import { findSwaps } from "./findSwaps";
import { isUtxoUnspent } from "./isUtxoUnspent";

type Timer = ReturnType<typeof setTimeout> | null;

declare const self: SharedWorkerGlobalScope;

const electrum = new ElectrumManager();
// Disable until SPV is implemented
//const headers = new HeadersWorker(electrum);
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

const worker = {
  ready: false,
  active: true,
  setServers(newServers: string[]) {
    workerLog("[Worker] setServers called:", newServers);
    serverNum = 0;
    servers = newServers;
  },
  connect(_address: string) {
    workerLog("[Worker] connect called", { address: _address, servers, serverNum });
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
      db.kvp.put({ status: ElectrumStatus.CONNECTING, server: endpoint }, "electrumStatus");
      const result = electrum.changeEndpoint(endpoint);
      workerLog("[Worker] changeEndpoint result:", result);
      if (!result) {
        workerLog("[Worker] changeEndpoint failed, trying next server");
        tryNextServer();
        return;
      }
      connectTimer = setTimeout(tryNextServer, FAILOVER_TIMEOUT);
    } else {
      workerLog("[Worker] Skipping connection - already connected to same endpoint/address");
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

    const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
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
    return (await electrum.client?.request(
      "blockchain.transaction.get",
      txid
    )) as string;
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
    this.active = active;
  },
  isActive() {
    return this.active;
  },
  async fetchGlyph(ref: string) {
    return nft.fetchGlyph(ref);
  },
  async findSwaps(address: string) {
    return findSwaps(electrum, address);
  },
  async isUtxoUnspent(txid: string, vout: number, scriptHash: string) {
    return isUtxoUnspent(electrum, txid, vout, scriptHash);
  },
  async getBlockHeight(): Promise<number> {
    try {
      const result = await electrum.client?.request(
        "blockchain.headers.subscribe"
      ) as { height: number; hex: string } | undefined;
      return result?.height ?? 0;
    } catch {
      return 0;
    }
  },
  async resolveWaveName(name: string): Promise<{ target: string } | null> {
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
        if (target) return { target };
      }

      // Fall back to RPC (RXinDexer supports this natively)
      try {
        const result = await electrum.client?.request("wave.resolve", bareName) as {
          target?: string;
          zone?: { address?: string };
        } | null | undefined;
        if (result) {
          // RXinDexer returns {target, zone: {address}} — accept either
          const target = result.target || result.zone?.address;
          if (target) return { target };
        }
      } catch {
        // RPC not supported — ignore
      }

      return null;
    } catch {
      return null;
    }
  },
  async checkWaveAvailable(name: string): Promise<boolean> {
    // Try RPC first
    try {
      const result = await electrum.client?.request(
        "wave.check_available",
        name
      ) as boolean | undefined;

      if (result !== undefined && result !== null) {
        return result;
      }
    } catch {
      // RPC not supported — fall through to local DB check
    }

    // Fall back to local DB check
    const parts = name.toLowerCase().split(".");
    const bareName = parts[0];
    const domain = parts[1] || "rxd";
    const GLYPH_WAVE = 11;

    const existing = await db.glyph
      .filter((glyph) => {
        if (!glyph.p?.includes(GLYPH_WAVE)) return false;
        if (glyph.spent !== 0) return false;
        const attrs = glyph.attrs as Record<string, string> | undefined;
        if (!attrs) return false;
        return (attrs.name || "").toLowerCase() === bareName &&
               (attrs.domain || "rxd").toLowerCase() === domain;
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
    workerLog(`[Worker] Tried all servers ${Math.floor(connectionAttempts / totalServers)} times, pausing for ${PAUSE_DURATION/1000}s`);
    db.kvp.put({ status: ElectrumStatus.DISCONNECTED, reason: "all_servers_failed" }, "electrumStatus");
    reconnectTimer = setTimeout(() => {
      connectionAttempts = 0; // Reset counter after pause
      worker.connect(address);
    }, PAUSE_DURATION);
    return;
  }
  
  workerLog(`[Worker] Trying next server (attempt ${connectionAttempts}): ${servers[serverNum]}`);
  worker.connect(address);
}

electrum.addEvent("connected", () => {
  workerLog("[Worker] CONNECTED event received");
  clearTimers();
  connectionAttempts = 0; // Reset on successful connection
  connectedGeneration = electrum.generation;
  db.kvp.put({ status: ElectrumStatus.CONNECTED, server: electrum.endpoint }, "electrumStatus");
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
  workerLog("[Worker] CLOSE event received", { reason, gen: electrum.generation, connGen: connectedGeneration });

  // Ignore close events from old clients when we intentionally switched servers
  if (reason === "switching") {
    workerLog("[Worker] Ignoring close from intentional server switch");
    return;
  }

  // Ignore stale close events from old connections
  if (electrum.connected()) {
    workerLog("[Worker] Ignoring stale close - already connected to another server");
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
