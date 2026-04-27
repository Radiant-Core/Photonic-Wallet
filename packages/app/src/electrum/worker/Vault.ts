import {
  Subscription,
  ContractType,
  ElectrumCallback,
  ElectrumStatusUpdate,
  VaultRecord,
} from "@app/types";
import { buildUpdateTXOs } from "./updateTxos";
import db from "@app/db";
import ElectrumManager from "@app/electrum/ElectrumManager";
import setSubscriptionStatus from "./setSubscriptionStatus";
import { Worker } from "./electrumWorker";
import { vaultScriptHash, p2shOutputScript } from "@lib/vault";

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
  protected ready = true;

  constructor(worker: Worker, electrum: ElectrumManager) {
    this.worker = worker;
    this.electrum = electrum;
  }

  async syncPending() {
    // Re-check all vault subscriptions
    if (this.ready && this.address) {
      await this.subscribeToAllVaults();
    }
  }

  async manualSync() {
    if (this.ready && this.address) {
      await this.subscribeToAllVaults();
    }
  }

  async register(address: string) {
    this.address = address;

    try {
      await this.subscribeToAllVaults();
    } catch (error) {
      console.warn("[Vault] Registration failed:", error);
    }
  }

  /**
   * Subscribe to ElectrumX for all unclaimed vaults where this wallet
   * is either the sender or recipient.
   */
  async subscribeToAllVaults() {
    if (!this.address) return;

    const vaults = await db.vault
      .where({ claimed: 0 })
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

      const p2sh = p2shOutputScript(vault.redeemScriptHex);
      const updateTXOs = buildUpdateTXOs(
        this.electrum,
        ContractType.VAULT,
        () => p2sh
      );

      try {
        await this.electrum.client?.subscribe(
          "blockchain.scripthash",
          (async (sh: string, status: string) => {
            await this.onSubscriptionReceived(sh, status, updateTXOs);
          }) as ElectrumCallback,
          scriptHash
        );
      } catch (error) {
        console.warn(`[Vault] Subscription failed for ${scriptHash}:`, error);
        // Fall back to manual check
        try {
          await this.onSubscriptionReceived(
            scriptHash,
            "manual-fallback",
            updateTXOs
          );
        } catch (fallbackError) {
          console.warn("[Vault] Manual fallback also failed:", fallbackError);
        }
      }
    }

    // Use the first vault's scriptHash for the subscription status record,
    // or a synthetic one if no vaults exist
    const statusHash = relevant.length > 0
      ? vaultScriptHash(relevant[0].redeemScriptHex)
      : `vault_${this.address}`;

    setSubscriptionStatus(statusHash, "", false, ContractType.VAULT);
  }

  async onSubscriptionReceived(
    scriptHash: string,
    status: string,
    updateTXOs: ElectrumStatusUpdate
  ) {
    if (!this.ready) return;
    this.ready = false;

    try {
      const { added, spent } = await updateTXOs(scriptHash, status, false);

      // Add new vault TXOs to the database
      for (const txo of added) {
        await db.txo.put(txo).catch();
      }

      // Mark spent vault records as claimed
      for (const { id } of spent) {
        const txo = await db.txo.get(id);
        if (txo) {
          await db.vault
            .where({ txid: txo.txid, vout: txo.vout })
            .modify({ claimed: 1 });
        }
      }

      setSubscriptionStatus(scriptHash, status, false, ContractType.VAULT);
    } catch (error) {
      console.warn("[Vault] Subscription update error:", error);
      setSubscriptionStatus(scriptHash, status, true, ContractType.VAULT);
    }

    this.ready = true;
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
