import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElectrumWS } from "../electrumWsClient";

// Mock WebSocket that mirrors enough of the browser API for the client.
// One MockSocket per `new` call; the most recent instance is exposed on
// `MockSocket.last` so tests can drive open/message/close.
class MockSocket {
  static instances: MockSocket[] = [];
  static last(): MockSocket {
    return MockSocket.instances[MockSocket.instances.length - 1];
  }

  readyState = 0; // CONNECTING
  binaryType = "";
  sent: string[] = [];

  private listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(public url: string) {
    MockSocket.instances.push(this);
  }

  addEventListener(event: string, cb: (ev: unknown) => void): void {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    arr.push(cb);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === "string") {
      this.sent.push(data);
    } else {
      const view =
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      this.sent.push(new TextDecoder().decode(view));
    }
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3; // CLOSED
    this.emit("close", { wasClean: code === 1000, code, reason });
  }

  // Test helpers
  emitOpen(): void {
    this.readyState = 1; // OPEN
    this.emit("open", {});
  }

  emitMessageJson(obj: unknown): void {
    this.emit("message", { data: JSON.stringify(obj) + "\n" });
  }

  emitMessageRaw(data: string | ArrayBuffer | Uint8Array): void {
    this.emit("message", { data });
  }

  private emit(event: string, ev: unknown): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const cb of arr) cb(ev);
  }

  /** Most recent sent payload, parsed as JSON. */
  lastSent(): { id: number; method: string; params?: unknown[] } {
    const raw = this.sent[this.sent.length - 1];
    return JSON.parse(raw);
  }
}

type ClientOpts = ConstructorParameters<typeof ElectrumWS>[1];

function makeClient(opts: Partial<ClientOpts> = {}) {
  return new ElectrumWS("wss://example/", {
    WebSocketCtor:
      MockSocket as unknown as NonNullable<ClientOpts>["WebSocketCtor"],
    reconnect: false,
    requestTimeoutMs: 100,
    ...opts,
  });
}

beforeEach(() => {
  MockSocket.instances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ElectrumWS — request / response", () => {
  it("round-trips a JSON-RPC request and resolves with the result", async () => {
    const client = makeClient();
    const sock = MockSocket.last();
    sock.emitOpen();
    // The 500ms CONNECTED timer needs to fire before request() proceeds past
    // the connected-await.
    await vi.advanceTimersByTimeAsync(500);
    expect(client.isConnected()).toBe(true);

    const pending = client.request<string>("server.version", "Test", "1.4");
    const sent = sock.lastSent();
    expect(sent.method).toBe("server.version");
    expect(sent.params).toEqual(["Test", "1.4"]);

    sock.emitMessageJson({ jsonrpc: "2.0", id: sent.id, result: "ok" });
    await expect(pending).resolves.toBe("ok");

    await client.close("done");
  });

  it("rejects when the server returns a JSON-RPC error", async () => {
    const client = makeClient();
    const sock = MockSocket.last();
    sock.emitOpen();
    await vi.advanceTimersByTimeAsync(500);

    const pending = client.request("blockchain.scripthash.listunspent", "abc");
    const sent = sock.lastSent();
    sock.emitMessageJson({
      jsonrpc: "2.0",
      id: sent.id,
      error: { code: -32600, message: "Invalid request" },
    });

    await expect(pending).rejects.toThrow("Invalid request");
    await client.close("done");
  });
});

describe("ElectrumWS — timeout", () => {
  it("rejects pending requests after the configured request timeout", async () => {
    const client = makeClient({ requestTimeoutMs: 50 });
    const sock = MockSocket.last();
    sock.emitOpen();
    await vi.advanceTimersByTimeAsync(500);

    const pending = client.request("server.version");
    // Never reply. Advance past timeout.
    const expectation = expect(pending).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(60);
    await expectation;

    await client.close("done");
  });
});

describe("ElectrumWS — subscribe / notify", () => {
  it("subscribes after CONNECTED and dispatches incoming notifications to the callback", async () => {
    const client = makeClient();
    const sock = MockSocket.last();

    sock.emitOpen();
    await vi.advanceTimersByTimeAsync(500);
    expect(client.isConnected()).toBe(true);

    const seen: unknown[][] = [];
    const cb = (...args: unknown[]) => {
      seen.push(args);
    };

    // Subscribe after connect — the .subscribe RPC fires immediately.
    const subPromise = client.subscribe(
      "blockchain.scripthash",
      cb,
      "deadbeef"
    );

    const subSent = sock.lastSent();
    expect(subSent.method).toBe("blockchain.scripthash.subscribe");
    expect(subSent.params).toEqual(["deadbeef"]);

    sock.emitMessageJson({
      jsonrpc: "2.0",
      id: subSent.id,
      result: "status-1",
    });
    await subPromise;

    // The callback is invoked once with (param, initialStatus).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(["deadbeef", "status-1"]);

    // Async notification frame from the server (RPC-shaped: method + params).
    sock.emitMessageJson({
      jsonrpc: "2.0",
      method: "blockchain.scripthash.subscribe",
      params: ["deadbeef", "status-2"],
    });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(["deadbeef", "status-2"]);

    await client.close("done");
  });

  it("defers a subscribe issued before the socket connects, then sends the RPC on CONNECTED", async () => {
    const client = makeClient();
    const sock = MockSocket.last();

    const cb = vi.fn();
    // Fired before the socket is open — should not send anything yet.
    void client.subscribe("blockchain.headers", cb);
    expect(sock.sent).toHaveLength(0);

    sock.emitOpen();
    await vi.advanceTimersByTimeAsync(500);

    // CONNECTED fires the resubscribe loop, which issues the .subscribe RPC.
    const subSent = sock.lastSent();
    expect(subSent.method).toBe("blockchain.headers.subscribe");

    await client.close("done");
  });
});

describe("ElectrumWS — reconnect / resubscribe", () => {
  it("re-issues subscriptions on the new socket after a reconnect", async () => {
    const client = makeClient({ reconnect: true });
    const sock1 = MockSocket.last();

    const cb = vi.fn();
    void client.subscribe("blockchain.scripthash", cb, "abc");

    sock1.emitOpen();
    await vi.advanceTimersByTimeAsync(500);
    // First sock sent the subscribe RPC.
    expect(sock1.lastSent().method).toBe("blockchain.scripthash.subscribe");
    // Reply so the subscribe promise settles.
    sock1.emitMessageJson({
      jsonrpc: "2.0",
      id: sock1.lastSent().id,
      result: "s1",
    });

    // Close the underlying socket — reconnect timer fires after 1000ms.
    sock1.close(1006, "lost");
    expect(MockSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(MockSocket.instances).toHaveLength(2);

    const sock2 = MockSocket.last();
    sock2.emitOpen();
    await vi.advanceTimersByTimeAsync(500);

    // The new socket should have re-sent the subscribe RPC.
    const resub = sock2.lastSent();
    expect(resub.method).toBe("blockchain.scripthash.subscribe");
    expect(resub.params).toEqual(["abc"]);

    // Don't trigger reconnect again.
    sock2.emitMessageJson({
      jsonrpc: "2.0",
      id: resub.id,
      result: "s2",
    });
    await client.close("done");
  });

  it("tears down the socket when a resubscribe fails", async () => {
    // `blockchain.scripthash.subscribe` lives in the slow-method set so it
    // resolves to `slowMethodTimeoutMs`, not `requestTimeoutMs`. Set both so
    // the resubscribe RPC actually times out within the test's tick budget.
    const client = makeClient({
      reconnect: true,
      requestTimeoutMs: 50,
      slowMethodTimeoutMs: 50,
    });
    const sock1 = MockSocket.last();

    void client.subscribe("blockchain.scripthash", () => {}, "abc");

    sock1.emitOpen();
    await vi.advanceTimersByTimeAsync(500);
    // First subscribe RPC — reply with success so the subscription registers.
    sock1.emitMessageJson({
      jsonrpc: "2.0",
      id: sock1.lastSent().id,
      result: "s1",
    });

    // Drop sock1 to trigger reconnect.
    sock1.close(1006, "lost");
    await vi.advanceTimersByTimeAsync(1000);

    const sock2 = MockSocket.last();
    sock2.emitOpen();
    await vi.advanceTimersByTimeAsync(500);

    // The resubscribe RPC is now in-flight on sock2. Let it time out
    // without replying — the resub-failure handler should close sock2.
    expect(sock2.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    // The catch handler runs synchronously after the rejection — but the
    // rejection itself resolves on a microtask tick. Flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(sock2.readyState).toBe(3); // CLOSED
    expect(client.isConnected()).toBe(false);
  });
});

describe("ElectrumWS — close", () => {
  it("rejects pending requests when close() is called", async () => {
    const client = makeClient();
    const sock = MockSocket.last();
    sock.emitOpen();
    await vi.advanceTimersByTimeAsync(500);

    const pending = client.request("server.version");
    const expectation = expect(pending).rejects.toThrow("manual-close");
    void client.close("manual-close");
    await expectation;
  });
});

describe("ElectrumWS — concurrency gate", () => {
  it("caps in-flight requests and sends parked ones as slots free", async () => {
    const client = makeClient({ maxConcurrentRequests: 2 });
    const sock = MockSocket.last();
    sock.emitOpen();
    await vi.advanceTimersByTimeAsync(500);

    const p1 = client.request("server.version", "a");
    const p2 = client.request("server.version", "b");
    const p3 = client.request("server.version", "c");

    // Fast path is synchronous: the first two frames are already on the wire,
    // the third is parked behind the cap.
    expect(sock.sent).toHaveLength(2);
    const frames = sock.sent.map((s) => JSON.parse(s));
    expect(frames.map((f) => f.params[0])).toEqual(["a", "b"]);

    // Completing p1 frees a slot → the parked p3 is sent.
    sock.emitMessageJson({ jsonrpc: "2.0", id: frames[0].id, result: "ra" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sock.sent).toHaveLength(3);
    const frame3 = JSON.parse(sock.sent[2]);
    expect(frame3.params[0]).toBe("c");

    sock.emitMessageJson({ jsonrpc: "2.0", id: frames[1].id, result: "rb" });
    sock.emitMessageJson({ jsonrpc: "2.0", id: frame3.id, result: "rc" });
    await expect(p1).resolves.toBe("ra");
    await expect(p2).resolves.toBe("rb");
    await expect(p3).resolves.toBe("rc");
    await client.close("done");
  });

  it("does not start a parked request's timeout until it is actually sent", async () => {
    const client = makeClient({
      maxConcurrentRequests: 1,
      requestTimeoutMs: 100,
    });
    const sock = MockSocket.last();
    sock.emitOpen();
    await vi.advanceTimersByTimeAsync(500);

    const p1 = client.request("server.version", "a"); // takes the only slot
    const p2 = client.request("server.version", "b"); // parked
    expect(sock.sent).toHaveLength(1);
    const f1 = JSON.parse(sock.sent[0]);

    // Hold p1 open for 90ms. p2 is parked the whole time — its deadline must
    // not be counting down yet.
    await vi.advanceTimersByTimeAsync(90);
    sock.emitMessageJson({ jsonrpc: "2.0", id: f1.id, result: "ra" });
    await expect(p1).resolves.toBe("ra");
    await vi.advanceTimersByTimeAsync(0);

    // p2 is sent now; its 100ms window begins here, not at enqueue.
    expect(sock.sent).toHaveLength(2);
    const f2 = JSON.parse(sock.sent[1]);

    // 90ms more — 180ms total since p2 was enqueued, which would have timed it
    // out if the clock had started at enqueue. It was only sent ~90ms ago, so
    // it survives.
    await vi.advanceTimersByTimeAsync(90);
    sock.emitMessageJson({ jsonrpc: "2.0", id: f2.id, result: "rb" });
    await expect(p2).resolves.toBe("rb");
    await client.close("done");
  });

  it("rejects parked requests when the socket closes", async () => {
    const client = makeClient({ maxConcurrentRequests: 1 });
    const sock = MockSocket.last();
    sock.emitOpen();
    await vi.advanceTimersByTimeAsync(500);

    const p1 = client.request("server.version", "a"); // in-flight
    const p2 = client.request("server.version", "b"); // parked
    expect(sock.sent).toHaveLength(1);

    const e1 = expect(p1).rejects.toThrow("manual-close");
    const e2 = expect(p2).rejects.toThrow("manual-close");
    void client.close("manual-close");
    await e1;
    await e2;
  });
});
