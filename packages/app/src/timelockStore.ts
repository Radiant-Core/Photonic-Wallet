/**
 * Dexie-backed adapter for the lib's pluggable timelock-reveal store.
 *
 * Audit context: R15 moves the wrapped CEK from `localStorage` into
 * IndexedDB. The wrapped CEK is still encrypted to the wallet's own
 * HD-derived encryption key (the self-as-recipient pattern), so an
 * attacker who exfiltrates only the storage tier cannot unwrap it
 * without also obtaining the mnemonic. The point of moving off
 * `localStorage` is:
 *
 *   1. IndexedDB is not survey-readable from browser extensions on the
 *      same set of platforms that expose `localStorage` data to "view
 *      all storage" extension permissions.
 *   2. Persistence semantics match the rest of the wallet (mnemonic,
 *      UTXO state, vaults all live in Dexie). One clearing tier.
 *
 * Register on app boot by importing this module — it side-effect-binds
 * itself via `setTimelockRevealStore`. See `src/main.tsx`.
 */
import {
  setTimelockRevealStore,
  type TimelockReveal,
  type TimelockRevealStore,
} from "@lib/timelock";
import db from "@app/db";

const KVP_KEY = "timelockReveals";

/**
 * Dexie KVP-backed adapter. Stores all reveal records as a JSON array
 * under a single `kvp` row. Reads are O(n) on the number of pending
 * reveals — fine since the wallet rarely holds more than a handful at
 * once.
 */
class DexieRevealStore implements TimelockRevealStore {
  async load(): Promise<TimelockReveal[]> {
    try {
      const rows = (await db.kvp.get(KVP_KEY)) as TimelockReveal[] | undefined;
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  async save(reveal: TimelockReveal): Promise<void> {
    const existing = await this.load();
    const updated = existing.filter((r) => r.tokenRef !== reveal.tokenRef);
    updated.push(reveal);
    await db.kvp.put(updated, KVP_KEY);
  }

  async rename(tempId: string, confirmedTokenRef: string): Promise<void> {
    const reveals = await this.load();
    const idx = reveals.findIndex((r) => r.tokenRef === tempId);
    if (idx === -1) return;
    reveals[idx] = { ...reveals[idx], tokenRef: confirmedTokenRef };
    await db.kvp.put(reveals, KVP_KEY);
  }

  async delete(tokenRef: string): Promise<void> {
    const reveals = await this.load();
    const updated = reveals.filter((r) => r.tokenRef !== tokenRef);
    await db.kvp.put(updated, KVP_KEY);
  }
}

/**
 * One-time migration: if any reveals are sitting in localStorage from a
 * pre-R15 wallet, copy them into the Dexie store and clear the old key.
 * Runs once per process; subsequent calls are no-ops.
 */
let migrated = false;
async function migrateLegacyLocalStorage(): Promise<void> {
  if (migrated) return;
  migrated = true;
  if (typeof localStorage === "undefined") return;
  const LEGACY_KEY = "glyph_timelock_reveals";
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const legacy = JSON.parse(raw) as TimelockReveal[];
    if (!Array.isArray(legacy) || legacy.length === 0) {
      localStorage.removeItem(LEGACY_KEY);
      return;
    }
    const store = new DexieRevealStore();
    const existing = await store.load();
    // Merge by tokenRef — Dexie wins on conflicts (newer data wins; legacy
    // is by definition older if both somehow exist).
    const byRef = new Map<string, TimelockReveal>();
    for (const r of legacy) byRef.set(r.tokenRef, r);
    for (const r of existing) byRef.set(r.tokenRef, r);
    const merged = Array.from(byRef.values());
    await db.kvp.put(merged, KVP_KEY);
    localStorage.removeItem(LEGACY_KEY);
    console.info(
      `[timelockStore] Migrated ${legacy.length} legacy reveal(s) from localStorage → IndexedDB`
    );
  } catch (err) {
    console.warn("[timelockStore] Legacy localStorage migration failed:", err);
  }
}

// Register on import. The migration runs in the background; the active
// store is set synchronously so any reveal-flow callsite that fires
// before the migration completes still writes through to Dexie.
setTimelockRevealStore(new DexieRevealStore());
void migrateLegacyLocalStorage();
