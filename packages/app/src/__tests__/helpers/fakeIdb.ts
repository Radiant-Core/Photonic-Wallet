/**
 * Test-environment shims so the *real* Dexie (`@app/db`) can load and open
 * under vitest's jsdom env. Import this FIRST — before `dexie`/`@app/db` — in
 * any test that uses the real database. Two problems from `setup.ts` are
 * undone here:
 *
 *  1. `setup.ts` pre-sets `global.indexedDB = { open: fn }`, which makes
 *     `fake-indexeddb/auto` no-op (it only installs when absent). Force the
 *     real fake-indexeddb factory + key range into place.
 *
 *  2. `setup.ts` mocks `crypto.subtle.digest` to a `vi.fn()` returning
 *     `undefined`. Dexie's module init calls `getPrototypeOf(crypto.subtle
 *     .digest(...))` to detect the native Promise, which throws on `undefined`.
 *     Drop `subtle` so Dexie falls back to its `Promise.resolve()` path.
 */
import { IDBFactory, IDBKeyRange as FDBKeyRange } from "fake-indexeddb";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
  new IDBFactory();
(globalThis as unknown as { IDBKeyRange: typeof FDBKeyRange }).IDBKeyRange =
  FDBKeyRange;

const cryptoObj = (globalThis as unknown as { crypto?: { subtle?: unknown } })
  .crypto;
if (cryptoObj && cryptoObj.subtle) {
  cryptoObj.subtle = undefined;
}
