import { describe, it, expect } from "vitest";
import {
  SyncRetry,
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_MAX_MS,
  SYNC_BREAKER_THRESHOLD,
} from "@app/electrum/worker/syncRetry";

describe("SyncRetry", () => {
  it("starts clean (no failures, not tripped)", () => {
    const r = new SyncRetry();
    expect(r.consecutiveFailures).toBe(0);
    expect(r.tripped).toBe(false);
  });

  it("backs off exponentially from the base delay", () => {
    const r = new SyncRetry(3000, 60000, 3);
    expect(r.fail()).toBe(3000); // 1st failure
    expect(r.fail()).toBe(6000); // 2nd
    expect(r.fail()).toBe(12000); // 3rd
    expect(r.fail()).toBe(24000); // 4th
    expect(r.fail()).toBe(48000); // 5th
  });

  it("caps the backoff at maxMs and never overflows", () => {
    const r = new SyncRetry(3000, 60000, 3);
    let last = 0;
    for (let i = 0; i < 100; i++) last = r.fail();
    expect(last).toBe(60000);
    expect(Number.isFinite(last)).toBe(true);
  });

  it("trips the breaker at the threshold and stays tripped", () => {
    const r = new SyncRetry(3000, 60000, 3);
    r.fail(); // 1
    expect(r.tripped).toBe(false);
    r.fail(); // 2
    expect(r.tripped).toBe(false);
    r.fail(); // 3 -> threshold
    expect(r.tripped).toBe(true);
    r.fail(); // 4 -> still tripped
    expect(r.tripped).toBe(true);
  });

  it("reset() clears failures and the tripped state (a success recovers)", () => {
    const r = new SyncRetry(3000, 60000, 3);
    r.fail();
    r.fail();
    r.fail();
    expect(r.tripped).toBe(true);
    r.reset();
    expect(r.consecutiveFailures).toBe(0);
    expect(r.tripped).toBe(false);
    expect(r.fail()).toBe(3000); // back to the base delay after recovery
  });

  it("delayMs() reflects the current streak without mutating it", () => {
    const r = new SyncRetry(3000, 60000, 3);
    r.fail();
    const before = r.consecutiveFailures;
    expect(r.delayMs()).toBe(3000);
    expect(r.delayMs()).toBe(3000);
    expect(r.consecutiveFailures).toBe(before);
  });

  it("exposes sane defaults", () => {
    expect(SYNC_RETRY_BASE_MS).toBe(3000);
    expect(SYNC_RETRY_MAX_MS).toBe(60000);
    expect(SYNC_BREAKER_THRESHOLD).toBe(3);
    const r = new SyncRetry();
    for (let i = 0; i < SYNC_BREAKER_THRESHOLD; i++) r.fail();
    expect(r.tripped).toBe(true);
  });
});
