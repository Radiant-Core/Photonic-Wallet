import { Subscription, ElectrumCallback, VaultRecord } from "@app/types";
import db from "@app/db";
import ElectrumManager from "@app/electrum/ElectrumManager";
import { Worker } from "./electrumWorker";
import { vaultScriptHash, recoverVaultsFromTx } from "@lib/vault";
import { p2pkhScriptHash } from "@lib/script";
import { ElectrumUtxo } from "@lib/types";
import { verifyTransactionHash, hexToBytes } from "@lib/crypto";

/**
 * VaultWorker monitors vault P2SH UTXOs via ElectrumX subscriptions.
 *
 * Unlike RXD/NFT/FT workers which subscribe to a single script hash,
 * the vault worker subscribes to multiple script hashes — one per
 * known vault redeem script. Vault records are stored in the `vault`
 * table and their P2SH script hashes are derived from the redeem script.
 *
 * On wallet connect/register:
 * 1. Load all unclaimed vault records from the DB
 * 2. Subscribe to each vault's P2SH script hash
 * 3. Track vault UTXOs in the txo table with ContractType.VAULT
 */
export class VaultWorker implements Subscription {
  protected worker: Worker;
  protected electrum: ElectrumManager;
  protected address = "";
  protected subscriptions = new Map<string, string>(); // scriptHash → redeemScriptHex
  protected discovering = false; // Lock to prevent concurrent discovery runs

  constructor(worker: Worker, electrum: ElectrumManager) {
    this.worker = worker;
    this.electrum = electrum;
  }

  async syncPending() {
    if (this.address) {
      await this.revalidateClaimed();
      await this.subscribeToAllVaults();
    }
  }

  async manualSync() {
    if (this.address) {
      await this.revalidateClaimed();
      await this.subscribeToAllVaults();
    }
  }

  async register(address: string) {
    this.address = address;

    try {
      await this.revalidateClaimed();
      await this.subscribeToAllVaults();
    } catch (error) {
      console.warn("[Vault] Registration failed:", error);
    }
  }

  /**
   * Issue an Electrum JSON-RPC request with a single retry after `backoffMs`.
   *
   * Used for `listunspent` / `get_mempool` calls where the cold-cache latency
   * on the public ElectrumX server can exceed the WS client's slow-method
   * timeout for heavy addresses. The first attempt warms the server-side
   * cache; the retry then typically returns in a few seconds. Returns
   * `undefined` if both attempts fail rather than throwing, so callers can
   * leave existing DB state untouched instead of misclassifying the vault.
   */
  private async requestWithRetry(
    method: string,
    params: (string | number)[],
    contextTag: string,
    backoffMs = 500
  ): Promise<unknown> {
    try {
      return await this.electrum.client?.request(method, ...params);
    } catch (firstErr) {
      await new Promise((r) => setTimeout(r, backoffMs));
      try {
        return await this.electrum.client?.request(method, ...params);
      } catch (secondErr) {
        console.warn(
          `[Vault] ${method} failed twice for ${contextTag}:`,
          secondErr,
          "(first error:",
          firstErr,
          ")"
        );
        return undefined;
      }
    }
  }

  /**
   * Scan ALL claimed vaults and un-claim any whose P2SH UTXO is still
   * present on-chain. Repairs false positives from the old updateTxos bug.
   */
  async revalidateClaimed() {
    const claimed = await db.vault.where("claimed").equals(1).toArray();
    const relevant = claimed.filter(
      (v) =>
        v.recipientAddress === this.address || v.senderAddress === this.address
    );

    for (const vault of relevant) {
      try {
        const scriptHash = vaultScriptHash(vault.redeemScriptHex);

        // Check confirmed UTXOs. `listunspent` on a cold ElectrumX cache for
        // a heavy address can take 10s+ on the first call but typically
        // returns in 2-5s on retry once the server has the result warm. So
        // we give it one retry with a short backoff before giving up — the
        // alternative (silent warn) leaves a confirmed-spent vault stuck in
        // "claimed=1 but maybe still unspent" purgatory across sessions.
        const utxos = (await this.requestWithRetry(
          "blockchain.scripthash.listunspent",
          [scriptHash],
          `${vault.txid}:${vault.vout}`
        )) as ElectrumUtxo[] | undefined;

        if (utxos === undefined) continue; // Both attempts failed — leave as-is

        const isConfirmedUnspent = utxos.some(
          (u) => u.tx_hash === vault.txid && u.tx_pos === vault.vout
        );

        // Also check mempool — vault tx may be unconfirmed
        let isInMempool = false;
        try {
          const mempoolEntries = (await this.requestWithRetry(
            "blockchain.scripthash.get_mempool",
            [scriptHash],
            `${vault.txid}:${vault.vout}`
          )) as { tx_hash: string; fee: number; height: number }[] | undefined;
          isInMempool =
            mempoolEntries?.some((e) => e.tx_hash === vault.txid) ?? false;
        } catch {
          // Mempool query not supported — only rely on confirmed check
        }

        if (isConfirmedUnspent || isInMempool) {
          // Was incorrectly marked claimed — restore it
          await db.vault
            .where("[txid+vout]")
            .equals([vault.txid, vault.vout])
            .modify({ claimed: 0 });
          console.debug(
            `[Vault] Restored incorrectly claimed: ${vault.txid}:${vault.vout}`
          );
        }
      } catch (error) {
        console.warn(
          `[Vault] revalidateClaimed error for ${vault.txid}:${vault.vout}:`,
          error
        );
      }
    }
  }

  /**
   * Subscribe to ElectrumX for all unclaimed vaults where this wallet
   * is either the sender or recipient.
   */
  async subscribeToAllVaults() {
    if (!this.address) return;

    const vaults = await db.vault.where("claimed").equals(0).toArray();

    // Filter to vaults involving this wallet address
    const relevant = vaults.filter(
      (v) =>
        v.recipientAddress === this.address || v.senderAddress === this.address
    );

    for (const vault of relevant) {
      const scriptHash = vaultScriptHash(vault.redeemScriptHex);

      if (this.subscriptions.has(scriptHash)) {
        continue; // Already subscribed
      }

      this.subscriptions.set(scriptHash, vault.redeemScriptHex);

      try {
        await this.electrum.client?.subscribe(
          "blockchain.scripthash",
          (async (_sh: string, _status: string) => {
            await this.checkVaultSpent(vault);
          }) as ElectrumCallback,
          scriptHash
        );

        // Also do an immediate check on subscribe
        await this.checkVaultSpent(vault);
      } catch (error) {
        console.warn(`[Vault] Subscription failed for ${scriptHash}:`, error);
        try {
          await this.checkVaultSpent(vault);
        } catch (fallbackError) {
          console.warn("[Vault] Fallback check failed:", fallbackError);
        }
      }
    }
  }

  /**
   * Check if a specific vault UTXO has been spent by querying listunspent
   * for its exact P2SH script hash. If the result is empty, the vault
   * has been claimed and we mark it as such.
   *
   * This is intentionally scoped to ONE vault — never touches other records.
   */
  async checkVaultSpent(vault: VaultRecord) {
    try {
      // Don't check spent status for unconfirmed vaults (race condition with indexing)
      if (!vault.height || vault.height === 0) {
        console.debug(
          `[Vault] Skipping spent check for unconfirmed vault: ${vault.txid}:${vault.vout}`
        );
        return;
      }

      const scriptHash = vaultScriptHash(vault.redeemScriptHex);
      const utxos = (await this.electrum.client?.request(
        "blockchain.scripthash.listunspent",
        scriptHash
      )) as ElectrumUtxo[];

      if (utxos === undefined) return;

      const isConfirmedUnspent = utxos.some(
        (u) => u.tx_hash === vault.txid && u.tx_pos === vault.vout
      );

      if (isConfirmedUnspent) return; // Still in the UTXO set — not spent

      // Not in confirmed UTXO set — check mempool before concluding it's spent.
      // listunspent only returns confirmed UTXOs; an unconfirmed vault tx
      // would appear in get_mempool instead.
      let isInMempool = false;
      try {
        const mempoolEntries = (await this.electrum.client?.request(
          "blockchain.scripthash.get_mempool",
          scriptHash
        )) as { tx_hash: string; fee: number; height: number }[] | undefined;

        isInMempool =
          mempoolEntries?.some((e) => e.tx_hash === vault.txid) ?? false;
      } catch {
        // If mempool query fails, do NOT mark as claimed — err on the side of safety
        console.debug(
          `[Vault] Mempool query failed for ${vault.txid}:${vault.vout}, skipping claim check`
        );
        return;
      }

      if (isInMempool) return; // Still unconfirmed — not spent

      // UTXO is absent from both confirmed set and mempool — vault has been claimed
      await db.vault
        .where("[txid+vout]")
        .equals([vault.txid, vault.vout])
        .modify({ claimed: 1 });
      console.debug(`[Vault] Marked claimed: ${vault.txid}:${vault.vout}`);
    } catch (error) {
      console.warn(
        `[Vault] checkVaultSpent error for ${vault.txid}:${vault.vout}:`,
        error
      );
    }
  }

  /**
   * Add a new vault and subscribe to it immediately.
   * Called after creating a vault transaction.
   */
  async addVault(record: VaultRecord) {
    await db.vault.put(record);
    await this.subscribeToAllVaults();
  }

  /**
   * Discover vaults from transaction history by scanning for vault creation
   * transactions and recovering vault metadata from OP_RETURN outputs.
   *
   * This is called during wallet restore to find vaults created previously.
   *
   * @param wif The wallet's WIF private key (for decrypting vault OP_RETURN)
   * @param address The address to scan (defaults to registered address if not provided)
   * @param swapWif Optional swap WIF to also try for decryption (vault may be encrypted with swap key)
   * @returns Number of vaults discovered and added to the database
   */
  async discoverVaults(
    wif: string,
    address?: string,
    swapWif?: string
  ): Promise<number> {
    // Prevent concurrent discovery runs
    if (this.discovering) {
      console.warn("[Vault] Discovery already in progress, skipping");
      return 0;
    }

    const scanAddress = address || this.address;
    if (!scanAddress) {
      console.warn("[Vault] Cannot discover vaults: no address provided");
      return 0;
    }

    this.discovering = true;
    console.log(`[Vault] 🔍 Starting vault discovery for ${scanAddress}`);

    try {
      // Get P2PKH script hash for this address to fetch its history
      const scriptHash = p2pkhScriptHash(scanAddress);

      // Fetch transaction history for this address
      const history = (await this.electrum.client?.request(
        "blockchain.scripthash.get_history",
        scriptHash
      )) as { tx_hash: string; height: number }[] | undefined;

      if (!history || history.length === 0) {
        console.debug("[Vault] No transaction history found");
        return 0;
      }

      console.debug(`[Vault] Found ${history.length} transactions to scan`);

      let discoveredCount = 0;
      let timeoutCount = 0;

      // Check each transaction for vault outputs
      let scanned = 0;
      let debugLogCount = 0;
      const MAX_DEBUG_LOGS = 5; // Log details for first 5 transactions
      const BATCH_SIZE = 50; // Process in batches with delays
      const DELAY_MS = 10; // Small delay between requests

      for (const { tx_hash: txid, height } of history) {
        try {
          scanned++;
          const isDebug = debugLogCount < MAX_DEBUG_LOGS;

          // Log progress every 500 transactions
          if (scanned % 500 === 0) {
            console.log(
              `[Vault] Scanned ${scanned}/${history.length} transactions...`
            );
            // Add small delay every 500 to avoid overwhelming server
            await new Promise((r) => setTimeout(r, 100));
          }

          // Add small delay between individual requests
          if (scanned % BATCH_SIZE === 0) {
            await new Promise((r) => setTimeout(r, DELAY_MS));
          }

          // Skip individual outputs already in DB (important for vesting txs
          // with multiple tranches sharing the same txid)
          const existingVaultsForTx = await db.vault
            .where("txid")
            .equals(txid)
            .toArray();
          const knownVouts = new Set(existingVaultsForTx.map((v) => v.vout));

          // Fetch the raw transaction with retry logic for timeouts
          let rawTx: string | undefined;
          let retries = 2;
          while (retries > 0) {
            try {
              rawTx = (await this.electrum.client?.request(
                "blockchain.transaction.get",
                txid
              )) as string | undefined;
              break;
            } catch {
              retries--;
              if (retries === 0) {
                console.warn(`[Vault] Timeout fetching tx ${txid}, skipping`);
                break;
              }
              // Wait before retry
              await new Promise((r) => setTimeout(r, 500));
            }
          }

          if (!rawTx) {
            timeoutCount++;
            continue;
          }

          // SECURITY FIX (C5): Verify transaction hash matches txid
          // This prevents transaction poisoning from malicious servers
          try {
            const txBytes = hexToBytes(rawTx);
            if (!verifyTransactionHash(txBytes, txid)) {
              console.error(
                `[Vault] SECURITY ALERT: Transaction hash mismatch for ${txid}`
              );
              timeoutCount++;
              continue; // Skip this potentially malicious transaction
            }
          } catch (verifyError) {
            console.error(
              `[Vault] Transaction verification failed for ${txid}:`,
              verifyError
            );
            timeoutCount++;
            continue; // Skip on verification failure
          }

          if (isDebug) {
            console.debug(
              `[Vault] Debug: Checking ${txid}, rawTx length: ${rawTx.length}`
            );
          }

          // Try to recover vaults from this transaction.
          // The lib no longer accepts a debug flag — secrets must never flow
          // into console output. Local tracing here is kept but only logs
          // counts and txids, never key material.
          const enableDebug = debugLogCount < 3;
          let recovered = recoverVaultsFromTx(rawTx, txid, wif, scanAddress);

          // If no vaults found with main WIF and swapWif provided, try swap WIF
          if (recovered.length === 0 && swapWif) {
            if (enableDebug) {
              console.debug(`[Vault] Debug: Trying swapWif for ${txid}`);
            }
            recovered = recoverVaultsFromTx(rawTx, txid, swapWif, scanAddress);
          }

          if (isDebug) {
            console.debug(
              `[Vault] Debug: ${txid} - recovered: ${recovered.length}`
            );
            if (recovered.length === 0 && !enableDebug) {
              // Check if tx has OP_RETURN
              const hasOpReturn = rawTx.includes("6a"); // Simple hex check
              console.debug(
                `[Vault] Debug: ${txid} - has OP_RETURN (hex check): ${hasOpReturn}`
              );
            }
            debugLogCount++;
          }

          if (recovered.length > 0) {
            console.log(
              `[Vault] 🎉 Recovered ${recovered.length} vault(s) from ${txid}`
            );

            // Convert recovered vault data to VaultRecords and store
            for (const vaultData of recovered) {
              if (knownVouts.has(vaultData.vout)) {
                if (isDebug) {
                  console.debug(
                    `[Vault] Debug: ${txid}:${vaultData.vout} already in DB, skipping`
                  );
                }
                continue;
              }

              const discoveryDate = Date.now();
              const record: VaultRecord = {
                txid,
                vout: vaultData.vout,
                value: vaultData.params.value,
                assetType: vaultData.params.assetType,
                mode: vaultData.params.mode,
                locktime: vaultData.params.locktime,
                recipientAddress: vaultData.params.recipientAddress,
                senderAddress: scanAddress, // We sent this vault
                ref: vaultData.params.ref,
                label: vaultData.params.label,
                redeemScriptHex: vaultData.redeemScriptHex,
                p2shScriptHex: vaultData.p2shScriptHex,
                claimed: 0,
                height: height > 0 ? height : undefined,
                date: discoveryDate,
                activityLog: [
                  {
                    timestamp: discoveryDate,
                    action: "discovered",
                    txid,
                    details: `Discovered ${vaultData.params.assetType.toUpperCase()} vault from transaction history`,
                    height: height > 0 ? height : undefined,
                  },
                ],
              };

              await db.vault.put(record);
              discoveredCount++;
            }
          }
        } catch (error) {
          console.warn(`[Vault] Error scanning tx ${txid}:`, error);
          // Continue with next transaction
        }
      }

      console.log(
        `[Vault] ✅ Scanned ${scanned}/${history.length} transactions, found ${discoveredCount} vault(s), ${timeoutCount} timeouts`
      );

      if (discoveredCount > 0) {
        console.log(
          `[Vault] Discovered ${discoveredCount} vault(s) from history`
        );
        // Subscribe to newly discovered vaults
        await this.subscribeToAllVaults();
      } else {
        console.log("[Vault] ℹ️ No vaults discovered in transaction history");
        console.debug(
          "[Vault] Debug: Sample txids checked:",
          history.slice(0, 3).map((h) => h.tx_hash)
        );
      }

      // Store scan timestamp for this address
      try {
        const scanKey = `vaultLastScan_${scanAddress}`;
        await db.kvp.put(
          {
            timestamp: Date.now(),
            address: scanAddress,
            discovered: discoveredCount,
          },
          scanKey
        );
      } catch (e) {
        console.warn("[Vault] Failed to store scan timestamp:", e);
      }

      return discoveredCount;
    } catch (error) {
      console.warn("[Vault] Discovery failed:", error);
      return 0;
    } finally {
      this.discovering = false;
    }
  }
}
