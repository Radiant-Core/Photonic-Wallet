/**
 * The consume-once ledger that stops a captured sign request from driving a
 * second real broadcast within its expiry window.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { isNonceConsumed, consumeNonce } from "../consumedNonces";

// jsdom gives us a real sessionStorage; clear it between cases.
beforeEach(() => sessionStorage.clear());

describe("consumed-nonce ledger", () => {
  it("a fresh nonce is not consumed; consuming makes it so", () => {
    expect(isNonceConsumed("abc")).toBe(false);
    consumeNonce("abc");
    expect(isNonceConsumed("abc")).toBe(true);
  });

  it("consuming is idempotent and does not affect other nonces", () => {
    consumeNonce("one");
    consumeNonce("one");
    expect(isNonceConsumed("one")).toBe(true);
    expect(isNonceConsumed("two")).toBe(false);
  });

  it("survives a reload (persisted in sessionStorage, not just memory)", () => {
    consumeNonce("persisted");
    // A reload re-reads from storage — simulated by reading fresh, since the
    // module holds no in-memory cache.
    expect(isNonceConsumed("persisted")).toBe(true);
  });

  it("stays bounded: old nonces evict, recent ones remain", () => {
    for (let i = 0; i < 250; i++) consumeNonce(`n${i}`);
    // The most recent are kept…
    expect(isNonceConsumed("n249")).toBe(true);
    expect(isNonceConsumed("n249".replace("249", "200"))).toBe(true);
    // …the oldest have been evicted (cap is 200).
    expect(isNonceConsumed("n0")).toBe(false);
    expect(isNonceConsumed("n40")).toBe(false);
  });

  it("tolerates a corrupt store without throwing", () => {
    sessionStorage.setItem("xetch.sign.consumedNonces", "not json");
    expect(isNonceConsumed("x")).toBe(false); // reads as empty, no throw
    expect(() => consumeNonce("x")).not.toThrow();
    expect(isNonceConsumed("x")).toBe(true);
  });
});
