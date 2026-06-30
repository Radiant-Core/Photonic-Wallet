// In-tree minimal Electrum WebSocket client. Replaces `ws-electrumx-client` so
// the workspace no longer carries a third-party dependency for a small JSON-RPC
// surface. Public API matches the subset of `ws-electrumx-client@1.0.5` used by
// the app and CLI: constructor(endpoint, options?), request, batchRequest,
// subscribe, unsubscribe, isConnected, close, on/once/off, ElectrumWSEvent.
//
// Differences from the (now-removed) upstream patch:
//   - Request timeout defaults to 10s (the upstream patch had bumped it to 120s,
//     which hid dead sockets for two minutes). A small set of known-slow
//     methods (scripthash listunspent/subscribe/get_history/get_mempool) use a
//     30s ceiling instead — measured against the public ElectrumX, cold-cache
//     `listunspent` on a heavy address can take 11-19s while server.ping stays
//     sub-100ms, so the two need separate ceilings.
//   - Resubscribe failures tear the socket down (CLOSE_CODE) so a higher layer
//     can react. The patch turned this into a silent console.warn, which masked
//     auth/desync failures.
//
// Behaviour kept from the patch (the parts that were legitimate fixes):
//   - Snapshot subscriptions before firing CONNECTED so handlers that subscribe
//     during the CONNECTED callback don't get double-fired.
//   - Don't split frames on the space character — only on \r and \n.

import WebSocketImpl from "isomorphic-ws";

type AnyWebSocket = {
  readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: string, listener: (ev: unknown) => void): void;
};

type WebSocketCtor = new (url: string) => AnyWebSocket;

const WS_CONNECTING = 0;
const WS_OPEN = 1;
// CLOSING / CLOSED are part of the standard WebSocket readyState set but
// aren't compared against in this client — kept underscore-prefixed for
// documentation per the eslint `^_` opt-out (R23).
const _WS_CLOSING = 2;
const _WS_CLOSED = 3;

export type RpcResponse = {
  jsonrpc: string;
  result?: unknown;
  error?: string | { code: number; message: string };
  id: number;
};

export type RpcRequest = {
  jsonrpc: string;
  method: string;
  params?: unknown[];
};

export function isRpcResponse(obj: unknown): obj is RpcResponse {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "jsonrpc" in obj &&
    typeof (obj as { jsonrpc: unknown }).jsonrpc === "string" &&
    "id" in obj &&
    typeof (obj as { id: unknown }).id === "number"
  );
}

export function isRpcRequest(obj: unknown): obj is RpcRequest {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "jsonrpc" in obj &&
    typeof (obj as { jsonrpc: unknown }).jsonrpc === "string" &&
    "method" in obj &&
    typeof (obj as { method: unknown }).method === "string"
  );
}

export type ElectrumWSOptions = {
  token?: string;
  reconnect: boolean;
  verbose: boolean;
  /** Request timeout in ms. Defaults to 10s. */
  requestTimeoutMs: number;
  /**
   * Request timeout in ms for methods listed in `slowMethods`. Defaults to 30s.
   * Lets fast control RPCs (ping/version/headers) keep a tight dead-socket
   * detection window while giving scripthash queries enough headroom for a
   * cold ElectrumX cache.
   */
  slowMethodTimeoutMs: number;
  /**
   * Methods that should use `slowMethodTimeoutMs` instead of `requestTimeoutMs`.
   * Defaults to the scripthash query family, which can take 10s+ on cold cache
   * for heavy addresses even against a healthy server.
   */
  slowMethods: ReadonlySet<string>;
  /**
   * Maximum number of requests allowed in flight on the socket at once.
   * Excess requests queue and are sent as slots free up. Defaults to 4.
   *
   * A single ElectrumX connection processes a heavy wallet's `listunspent` /
   * `ref.get` / header fetches effectively serially; firing the whole sync
   * fan-out at once backs up the server-side queue until requests blow their
   * client-side deadline (the Safari "continuous sync error" storm). Capping
   * concurrency keeps the queue short. Crucially, the per-request timeout
   * clock only starts once a slot is acquired and the frame is sent — queued
   * requests don't burn their deadline while waiting.
   */
  maxConcurrentRequests: number;
  /** Override the WebSocket constructor. Defaults to isomorphic-ws. */
  WebSocketCtor?: WebSocketCtor;
};

export enum ElectrumWSEvent {
  OPEN = "open",
  CLOSE = "close",
  CONNECTED = "connected",
  DISCONNECTED = "disconnected",
  RECONNECTING = "reconnecting",
  ERROR = "error",
  MESSAGE = "message",
}

// Reconnect backoff. A dropped socket used to reconnect on a fixed 1s timer
// with no jitter, so every wallet whose connection dropped at the same moment
// (e.g. the indexer briefly slowed and a `scripthash.subscribe` timed out)
// reconnected in lockstep and re-subscribed every scripthash at once — a
// synchronised thundering herd that kept the indexer saturated, which caused
// more timeouts: a self-sustaining storm. Exponential backoff caps each
// client's retry rate; jitter de-correlates the herd. The backoff only resets
// once a connection has stayed up for RECONNECT_STABLE_MS, so a socket that
// flaps connect→fail→connect keeps escalating instead of resetting to base on
// every brief connect.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_STABLE_MS = 30000;
const CONNECTED_TIMEOUT = 500;
const DEFAULT_REQUEST_TIMEOUT = 1000 * 10;
const DEFAULT_SLOW_METHOD_TIMEOUT = 1000 * 30;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_SLOW_METHODS: ReadonlySet<string> = new Set([
  "blockchain.scripthash.listunspent",
  "blockchain.scripthash.subscribe",
  "blockchain.scripthash.unsubscribe",
  "blockchain.scripthash.get_history",
  "blockchain.scripthash.get_mempool",
  "blockchain.scripthash.get_balance",
  // Whole-tx fetches can also stall on cold cache for large txs.
  "blockchain.transaction.get",
  // The chain-catchup header fetch pulls up to 1000 80-byte headers
  // (~160KB hex) in one response — legitimately >10s on a slow link, so it
  // needs the slow ceiling rather than the tight dead-socket window.
  "blockchain.block.headers",
]);
const CLOSE_CODE = 1000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: string;
  timeout: ReturnType<typeof setTimeout>;
};

type Subscription = (...payload: unknown[]) => unknown;

type Listener = ((...args: unknown[]) => void) | null;

class Observable {
  private listeners = new Map<string, Listener[]>();

  on(event: string, callback: (...args: unknown[]) => void): number {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    return arr.push(callback) - 1;
  }

  once(event: string, callback: (...args: unknown[]) => void): void {
    const id = this.on(event, (...args) => {
      this.off(event, id);
      callback(...args);
    });
  }

  off(event: string, id: number): void {
    const arr = this.listeners.get(event);
    if (!arr || arr.length < id + 1) return;
    arr[id] = null;
  }

  allOff(event: string): void {
    this.listeners.delete(event);
  }

  protected fire(event: string, ...payload: unknown[]): void {
    const arr = this.listeners.get(event);
    if (!arr || !arr.length) return;
    for (const cb of arr) {
      if (!cb) continue;
      cb(...payload);
    }
  }
}

function subscriptionKey(method: string, params: unknown[]): string {
  return `${method}${typeof params[0] === "string" ? `-${params[0]}` : ""}`;
}

function bytesToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder("utf-8").decode(data as unknown as Uint8Array);
  }
  if (Array.isArray(data)) {
    // Node 'ws' delivers Buffer-array for fragmented messages.
    const parts = data as Array<ArrayBufferLike | Uint8Array>;
    const buffers = parts.map((p) =>
      p instanceof Uint8Array ? p : new Uint8Array(p as ArrayBuffer)
    );
    const total = buffers.reduce((n, b) => n + b.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const b of buffers) {
      merged.set(b, offset);
      offset += b.byteLength;
    }
    return new TextDecoder("utf-8").decode(merged);
  }
  return String(data);
}

function stringToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function formatRequest(r: RpcRequest & { id: number }): Uint8Array {
  return stringToBytes(JSON.stringify(r) + "\n");
}

function resolveDefaultWebSocket(): WebSocketCtor {
  const fromGlobal = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (fromGlobal) return fromGlobal;
  return WebSocketImpl as unknown as WebSocketCtor;
}

export class ElectrumWS extends Observable {
  static DEFAULT_OPTIONS: ElectrumWSOptions = {
    reconnect: true,
    verbose: false,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT,
    slowMethodTimeoutMs: DEFAULT_SLOW_METHOD_TIMEOUT,
    maxConcurrentRequests: DEFAULT_MAX_CONCURRENT_REQUESTS,
    slowMethods: DEFAULT_SLOW_METHODS,
  };

  private options: ElectrumWSOptions;
  private endpoint: string;
  private requests = new Map<number, PendingRequest>();
  // Concurrency gate: number of requests currently sent-but-not-settled, and
  // the FIFO queue of callers parked until a slot frees up.
  private inFlight = 0;
  private slotWaiters: { grant: () => void; deny: (err: Error) => void }[] = [];
  private subscriptions = new Map<string, Subscription>();
  private connected = false;
  private connectedTimeout?: ReturnType<typeof setTimeout>;
  private reconnectionTimeout?: ReturnType<typeof setTimeout>;
  // Consecutive reconnect attempts since the last stable connection — drives
  // the exponential backoff in nextReconnectDelay().
  private reconnectAttempts = 0;
  // Armed on a successful connect; if it fires (the socket stayed up for
  // RECONNECT_STABLE_MS) the backoff resets. Cleared if the socket drops first.
  private stabilityTimeout?: ReturnType<typeof setTimeout>;
  private incompleteMessage = "";
  private WebSocketCtor: WebSocketCtor;
  // Public so legacy code that pokes `client.ws` (the upstream lib exposed it)
  // keeps working.
  ws!: AnyWebSocket;

  constructor(endpoint: string, options: Partial<ElectrumWSOptions> = {}) {
    super();
    this.endpoint = endpoint;
    this.options = { ...ElectrumWS.DEFAULT_OPTIONS, ...options };
    this.WebSocketCtor = options.WebSocketCtor ?? resolveDefaultWebSocket();
    this.connect();
  }

  get verbose(): boolean {
    return this.options.verbose;
  }

  async batchRequest<R extends Array<unknown>>(
    ...requests: { method: string; params: unknown[] }[]
  ): Promise<R> {
    if (!this.connected) {
      await new Promise<void>((resolve) =>
        this.once(ElectrumWSEvent.CONNECTED, () => resolve())
      );
    }
    let id = this.nextId();
    const payloads = requests.map((r) => ({
      jsonrpc: "2.0",
      method: r.method,
      params: r.params,
      id: id++,
    }));
    const promises = payloads.map((p) =>
      this.createRequestPromise(p.id, p.method)
    );
    for (const p of payloads) {
      this.ws.send(formatRequest(p));
    }
    return Promise.all(promises) as Promise<R>;
  }

  async request<ResponseType = unknown>(
    method: string,
    ...params: (boolean | string | number | (string | number)[])[]
  ): Promise<ResponseType> {
    if (!this.connected) {
      await new Promise<void>((resolve) =>
        this.once(ElectrumWSEvent.CONNECTED, () => resolve())
      );
    }
    // Reserve an in-flight slot. Fast path (a slot is free) stays synchronous
    // so the frame is sent within this call — send ordering is preserved and
    // callers can read the sent frame straight after request(). Only when the
    // socket is saturated do we await, parking in FIFO order. Reserving the id
    // and arming the timeout AFTER the slot — with no await before the send —
    // keeps id-reservation atomic and makes the deadline count only real
    // in-flight time, not time spent queued behind other requests.
    if (this.inFlight < this.options.maxConcurrentRequests) {
      this.inFlight++;
    } else {
      await this.acquireSlot();
    }
    const id = this.nextId();
    const payload: RpcRequest & { id: number } = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };
    const promise = this.createRequestPromise(id, method);
    if (this.verbose) console.debug("ElectrumWS SEND:", method, ...params);
    try {
      this.ws.send(formatRequest(payload));
    } catch (err) {
      // Send failed synchronously (e.g. socket already closed). Tear down the
      // just-armed pending request and free the slot so we don't leak either.
      const pending = this.requests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.requests.delete(id);
      }
      this.releaseSlot();
      throw err;
    }
    return promise.finally(() => this.releaseSlot()) as Promise<ResponseType>;
  }

  private nextId(): number {
    let id: number;
    do {
      id = Math.ceil(Math.random() * 1e5);
    } while (this.requests.has(id));
    return id;
  }

  /**
   * Pick the per-request timeout. `subscribe`/`unsubscribe` come in as the
   * bare method name (`blockchain.scripthash`) so we also match the `.subscribe`
   * / `.unsubscribe` variants the actual JSON-RPC call uses.
   */
  private resolveTimeoutMs(method: string): number {
    if (this.options.slowMethods.has(method)) {
      return this.options.slowMethodTimeoutMs;
    }
    return this.options.requestTimeoutMs;
  }

  /**
   * Reserve an in-flight slot, parking the caller in FIFO order if the socket
   * is already at `maxConcurrentRequests`. Resolves once a slot is held;
   * rejects if the connection is torn down while parked (see
   * `drainSlotWaiters`). Single-threaded JS means the check-and-increment in
   * the fast path is atomic, so the cap is never exceeded.
   */
  private acquireSlot(): Promise<void> {
    if (this.inFlight < this.options.maxConcurrentRequests) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.slotWaiters.push({
        grant: () => {
          this.inFlight++;
          resolve();
        },
        deny: reject,
      });
    });
  }

  private releaseSlot(): void {
    if (this.inFlight > 0) this.inFlight--;
    this.slotWaiters.shift()?.grant();
  }

  /** Reject every parked slot-waiter — used when the socket tears down so
   * callers fail fast instead of hanging on a connection that's gone. */
  private drainSlotWaiters(reason: string): void {
    const waiters = this.slotWaiters;
    this.slotWaiters = [];
    for (const w of waiters) w.deny(new Error(reason));
  }

  private createRequestPromise(id: number, method: string): Promise<unknown> {
    const timeoutMs = this.resolveTimeoutMs(method);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.requests.delete(id);
        reject(
          new Error(`ElectrumWS request timeout. request ID: ${id} (${method})`)
        );
      }, timeoutMs);
      this.requests.set(id, { resolve, reject, method, timeout });
    });
  }

  async subscribe(
    method: string,
    callback: (...payload: unknown[]) => unknown,
    ...params: (string | number)[]
  ): Promise<void> {
    const key = subscriptionKey(method, params);
    this.subscriptions.set(key, callback);
    if (!this.connected) return;
    callback(...params, await this.request(`${method}.subscribe`, ...params));
  }

  async unsubscribe(
    method: string,
    ...params: (string | number)[]
  ): Promise<unknown> {
    const key = subscriptionKey(method, params);
    const deleted = this.subscriptions.delete(key);
    if (deleted) return this.request(`${method}.unsubscribe`, ...params);
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async close(reason: string): Promise<boolean> {
    this.options.reconnect = false;
    for (const [id, request] of this.requests) {
      clearTimeout(request.timeout);
      this.requests.delete(id);
      request.reject(new Error(reason));
    }
    this.drainSlotWaiters(reason);
    if (this.reconnectionTimeout) clearTimeout(this.reconnectionTimeout);
    if (this.connectedTimeout) clearTimeout(this.connectedTimeout);
    if (this.stabilityTimeout) clearTimeout(this.stabilityTimeout);
    if (
      this.ws.readyState === WS_CONNECTING ||
      this.ws.readyState === WS_OPEN
    ) {
      const closingPromise = new Promise<boolean>((resolve) =>
        this.once(ElectrumWSEvent.CLOSE, () => resolve(true))
      );
      this.ws.close(CLOSE_CODE, reason);
      return closingPromise;
    }
    return true;
  }

  /**
   * Delay before the next reconnect, with exponential backoff + jitter.
   * `reconnectAttempts` grows on each drop and only resets after a stable
   * connection (see onOpen), so a flapping socket backs off progressively
   * rather than hammering the server on a fixed timer. Equal jitter spreads the
   * delay across [d/2, d) — a floor so a single client doesn't busy-reconnect,
   * while still decorrelating many clients that dropped at the same instant.
   */
  private nextReconnectDelay(): number {
    const capped = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts
    );
    this.reconnectAttempts++;
    return capped / 2 + Math.random() * (capped / 2);
  }

  private connect(): void {
    let url = this.endpoint;
    if (this.options.token) url = `${url}?token=${this.options.token}`;
    this.ws = new this.WebSocketCtor(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => this.onOpen());
    this.ws.addEventListener("message", (ev) => this.onMessage(ev));
    this.ws.addEventListener("error", (ev) => this.onError(ev));
    this.ws.addEventListener("close", (ev) => this.onClose(ev));
  }

  private onOpen(): void {
    this.fire(ElectrumWSEvent.OPEN);
    this.connectedTimeout = setTimeout(() => {
      this.connected = true;
      // A connection that survives RECONNECT_STABLE_MS is healthy → reset the
      // reconnect backoff. Cleared in onClose/close so a socket that drops
      // before proving stable keeps (and keeps escalating) its backoff.
      if (this.stabilityTimeout) clearTimeout(this.stabilityTimeout);
      this.stabilityTimeout = setTimeout(() => {
        this.reconnectAttempts = 0;
      }, RECONNECT_STABLE_MS);
      // Snapshot subscriptions before firing CONNECTED so handlers that
      // subscribe during the CONNECTED callback aren't fired twice.
      const existing = new Map(this.subscriptions);
      this.fire(ElectrumWSEvent.CONNECTED);
      for (const [key, callback] of existing) {
        const parts = key.split("-");
        const method = parts.shift();
        if (!method) {
          if (this.verbose) {
            console.warn(
              "Cannot resubscribe, no method in subscription key:",
              key
            );
          }
          continue;
        }
        this.subscribe(method, callback, ...parts).catch((error: Error) => {
          const msg = error.message || "";
          // "excessive resource usage" is a server-side throttle, not a state
          // loss. Tearing the socket down kills every other worker's in-flight
          // request and triggers a reconnect storm. The affected worker's
          // manual fallback (listunspent polling) handles the failed subscribe.
          if (msg.includes("excessive resource usage")) {
            if (this.verbose) {
              console.warn(
                "ElectrumWS resubscribe throttled, keeping socket alive:",
                msg
              );
            }
            return;
          }
          // A resubscribe failure means the server lost state (or rejected
          // our auth). Tear the socket down so the reconnect logic — or the
          // caller listening on CLOSE — sees the failure, rather than
          // silently swallowing it.
          if (
            this.ws.readyState === WS_CONNECTING ||
            this.ws.readyState === WS_OPEN
          ) {
            this.ws.close(CLOSE_CODE, msg);
          }
        });
      }
    }, CONNECTED_TIMEOUT);
  }

  private onMessage(msg: unknown): void {
    const ev = msg as { data: unknown };
    const raw = bytesToString(ev.data);
    // Don't split on space — JSON values can legitimately contain spaces.
    // eslint-disable-next-line no-control-regex
    const re = new RegExp("\r|\n", "g");
    const lines = raw.split(re).filter((line) => line.length > 0);
    for (const line of lines) {
      const parsed = this.parseLine(line);
      if (!parsed) continue;
      this.fire(ElectrumWSEvent.MESSAGE, parsed);
      if (typeof parsed !== "object") {
        if (this.verbose) console.debug("Non-JSON response:", parsed);
        continue;
      }
      const obj = parsed as RpcResponse | RpcRequest;
      if (
        "id" in obj &&
        typeof obj.id === "number" &&
        this.requests.has(obj.id)
      ) {
        const request = this.requests.get(obj.id)!;
        clearTimeout(request.timeout);
        this.requests.delete(obj.id);
        const r = obj as RpcResponse;
        if ("result" in r) {
          request.resolve(r.result);
        } else if (r.error) {
          const errorMsg =
            typeof r.error === "string" ? r.error : r.error.message;
          request.reject(new Error(errorMsg));
        } else {
          request.reject(new Error("No result"));
        }
      }
      if (
        "method" in obj &&
        typeof obj.method === "string" &&
        obj.method.endsWith("subscribe")
      ) {
        const method = obj.method.replace(".subscribe", "");
        const params = (obj as RpcRequest).params || [];
        const key = subscriptionKey(method, params);
        const callback = this.subscriptions.get(key);
        if (callback) callback(...params);
      }
    }
  }

  private parseLine(line: string): RpcResponse | RpcRequest | false {
    try {
      const parsed = JSON.parse(line);
      if (isRpcResponse(parsed) || isRpcRequest(parsed)) {
        this.incompleteMessage = "";
        return parsed;
      }
    } catch {
      if (this.verbose) console.debug("Failed to parse:", line);
    }
    if (this.incompleteMessage && !line.includes(this.incompleteMessage)) {
      return this.parseLine(`${this.incompleteMessage}${line}`);
    }
    if (this.verbose) {
      console.debug(
        `Failed to parse JSON, retrying together with next message: "${line}"`
      );
    }
    this.incompleteMessage = line;
    return false;
  }

  private onError(event: unknown): void {
    const err = (event as { error?: unknown }).error;
    if (err) {
      if (this.verbose) console.error("ElectrumWS ERROR:", err);
      this.fire(ElectrumWSEvent.ERROR, err);
    }
  }

  private onClose(event: unknown): void {
    this.fire(ElectrumWSEvent.CLOSE, event);
    // Socket dropped before (or after) proving stable — cancel the pending
    // backoff reset so reconnectAttempts keeps climbing across a flap.
    if (this.stabilityTimeout) {
      clearTimeout(this.stabilityTimeout);
      this.stabilityTimeout = undefined;
    }
    if (!this.connected) {
      if (this.connectedTimeout) clearTimeout(this.connectedTimeout);
    } else {
      this.fire(ElectrumWSEvent.DISCONNECTED);
    }
    // Reject any outstanding requests so callers don't hang.
    for (const [id, request] of this.requests) {
      clearTimeout(request.timeout);
      this.requests.delete(id);
      request.reject(new Error("connection closed"));
    }
    this.drainSlotWaiters("connection closed");
    if (this.options.reconnect && this.connected) {
      this.fire(ElectrumWSEvent.RECONNECTING);
      this.reconnectionTimeout = setTimeout(
        () => this.connect(),
        this.nextReconnectDelay()
      );
    }
    this.connected = false;
  }
}
