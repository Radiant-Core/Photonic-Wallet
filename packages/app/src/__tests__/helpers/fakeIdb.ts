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
 *  2. (Retired.) `setup.ts` used to mock `crypto.subtle.digest` as a `vi.fn()`
 *     returning `undefined`, which broke Dexie's native-Promise detection
 *     (`getPrototypeOf(crypto.subtle.digest(...))`), so this file dropped
 *     `subtle` to force Dexie's fallback. `setup.ts` now installs Node's REAL
 *     WebCrypto — `digest()` returns a genuine Promise, Dexie detects it
 *     correctly, and the drop became not just unnecessary but impossible
 *     (`subtle` is getter-only on a real Crypto object).
 */
import { IDBFactory, IDBKeyRange as FDBKeyRange } from "fake-indexeddb";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
  new IDBFactory();
(globalThis as unknown as { IDBKeyRange: typeof FDBKeyRange }).IDBKeyRange =
  FDBKeyRange;
