/**
 * Full per-wallet discovery sweep, shared by the connect-time scan
 * (Electrum.tsx) and the manual "Resync Wallet" button so the two can't drift.
 *
 * Re-subscribing scripthashes (electrumWorker.manualSync) refetches the plain
 * RXD / FT / NFT / WAVE-name UTXOs, balances and history. But some things the
 * wallet owns do NOT live at a by-owner scripthash and are invisible to that
 * sweep:
 *   - Vault records (time-locked gifts) — recovered by scanning history with the
 *     WIF.
 *   - Covenant-held tokens (soulbound / authority-gated) — recovered from the
 *     indexer by their owner-stable (zero-ref) scripthash.
 *   - Royalty *listings* — kept in local `db.covenant`; the reconcile here also
 *     self-heals a listing an earlier build wrongly marked resolved.
 * This function covers those. Callers run manualSync() first for the rest.
 */
import { electrumWorker } from "@app/electrum/Electrum";
import { wallet } from "@app/signals";
import { discoverCovenants, syncCovenants } from "@app/covenant";

export interface DiscoverAllResult {
  vaultsDiscovered: number;
  /** A vault scan was skipped (transient timeout) — caller may retry. */
  incomplete: boolean;
  /** Vaults were skipped because the wallet is locked (no WIF). */
  vaultsSkippedLocked: boolean;
}

/**
 * Discover vault records + covenant-held tokens and reconcile covenants.
 *
 * The covenant work (discovery + reconcile, incl. the royalty-listing self-heal)
 * needs only the wallet address, so it runs whether the wallet is locked or not.
 * Vault discovery needs the WIF, so it runs only when unlocked; locked callers
 * get `vaultsSkippedLocked: true` and still get the covenant reconcile. This is
 * deliberately tolerant so the manual "Resync Wallet" button never has to gate
 * on (or block in) an unlock prompt. Vault scan failures set `incomplete` (so
 * the connect-time latch retries); covenant failures are non-fatal and logged.
 */
export async function discoverAll(): Promise<DiscoverAllResult> {
  const w = wallet.value;
  if (!w.address) {
    throw new Error("No wallet address");
  }
  let incomplete = false;
  let vaultsDiscovered = 0;
  let vaultsSkippedLocked = false;

  const wifStr = w.wif?.toString();
  const swapWifStr = w.swapWif?.toString();

  if (wifStr) {
    // Vaults on the main address (try the swap WIF for decryption if main fails).
    const mainResult = await electrumWorker.value.discoverVaults(
      wifStr,
      w.address,
      swapWifStr
    );
    if (mainResult.skipped > 0) incomplete = true;
    vaultsDiscovered += mainResult.discovered;

    // Vaults on the swap address, if distinct.
    if (swapWifStr && w.swapAddress) {
      const swapResult = await electrumWorker.value.discoverVaults(
        swapWifStr,
        w.swapAddress,
        wifStr
      );
      if (swapResult.skipped > 0) incomplete = true;
      vaultsDiscovered += swapResult.discovered;
    }
  } else {
    vaultsSkippedLocked = true;
  }

  // Covenant-held tokens + reconcile (royalty-listing self-heal). Address-only,
  // so this runs even while locked. Best-effort: non-fatal and logged.
  try {
    await discoverCovenants(w.address);
    if (w.swapAddress) await discoverCovenants(w.swapAddress);
    await syncCovenants();
  } catch (covErr) {
    console.warn("[walletSync] covenant discovery failed:", covErr);
  }

  return { vaultsDiscovered, incomplete, vaultsSkippedLocked };
}
