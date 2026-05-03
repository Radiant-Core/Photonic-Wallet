import {
  Subscription,
  ElectrumCallback,
  VaultRecord,
} from "@app/types";
import db from "@app/db";
import ElectrumManager from "@app/electrum/ElectrumManager";
import { Worker } from "./electrumWorker";
import { vaultScriptHash } from "@lib/vault";
import { ElectrumUtxo } from "@lib/types";

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
   * Scan ALL claimed vaults and un-claim any whose P2SH UTXO is still
   * present on-chain. Repairs false positives from the old updateTxos bug.
   */
  async revalidateClaimed() {
    const claimed = await db.vault.where("claimed").equals(1).toArray();
    const relevant = claimed.filter(
      (v) =>
        v.recipientAddress === this.address ||
        v.senderAddress === this.address
    );

    for (const vault of relevant) {
      try {
        const scriptHash = vaultScriptHash(vault.redeemScriptHex);

        // Check confirmed UTXOs
        const utxos = (await this.electrum.client?.request(
          "blockchain.scripthash.listunspent",
          scriptHash
        )) as ElectrumUtxo[];

        const isConfirmedUnspent = utxos?.some(
          (u) => u.tx_hash === vault.txid && u.tx_pos === vault.vout
        );

        // Also check mempool — vault tx may be unconfirmed
        let isInMempool = false;
        try {
          const mempoolEntries = (await this.electrum.client?.request(
            "blockchain.scripthash.get_mempool",
            scriptHash
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
          console.debug(`[Vault] Restored incorrectly claimed: ${vault.txid}:${vault.vout}`);
        }
      } catch (error) {
        console.warn(`[Vault] revalidateClaimed error for ${vault.txid}:${vault.vout}:`, error);
      }
    }
  }

  /**
   * Subscribe to ElectrumX for all unclaimed vaults where this wallet
   * is either the sender or recipient.
   */
  async subscribeToAllVaults() {
    if (!this.address) return;

    const vaults = await db.vault
      .where("claimed").equals(0)
      .toArray();

    // Filter to vaults involving this wallet address
    const relevant = vaults.filter(
      (v) =>
        v.recipientAddress === this.address ||
        v.senderAddress === this.address
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
        console.debug(`[Vault] Mempool query failed for ${vault.txid}:${vault.vout}, skipping claim check`);
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
      console.warn(`[Vault] checkVaultSpent error for ${vault.txid}:${vault.vout}:`, error);
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
}
