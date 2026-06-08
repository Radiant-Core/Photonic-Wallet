import Dexie, { Table } from "dexie";
import {
  SmartToken,
  TxO,
  BlockHeader,
  SubscriptionStatus,
  ContractBalance,
  BroadcastResult,
  TokenSwap,
  VaultRecord,
  CovenantRecord,
} from "./types";
import config from "@app/config.json";
import { shuffle } from "@lib/util";

export type KeyValuePairs = unknown;

export class Database extends Dexie {
  txo!: Table<TxO>;
  glyph!: Table<SmartToken>;
  subscriptionStatus!: Table<SubscriptionStatus>;
  kvp!: Table<KeyValuePairs>;
  header!: Table<BlockHeader>;
  balance!: Table<ContractBalance>;
  broadcast!: Table<BroadcastResult>;
  swap!: Table<TokenSwap>;
  vault!: Table<VaultRecord>;
  covenant!: Table<CovenantRecord>;

  constructor() {
    super("photonic");
    this.version(1).stores({
      txo: "++id, &[txid+vout], contractType, [contractType+spent], [script+spent], [change+spent]",
      subscriptionStatus: "scriptHash",
      balance: "id",
      glyph:
        "++id, &ref, [type+spent], [type+spent+fresh], lastTxoId, height, tokenType",
      kvp: "",
      header: "hash, height",
      txq: "txid",
    });

    this.version(2).upgrade((transaction) => {
      // Populate servers with updated config, in random order
      const mainnet = shuffle(config.defaultConfig.servers.mainnet);
      const testnet = config.defaultConfig.servers.testnet;
      transaction.table("kvp").put({ mainnet, testnet }, "servers");
    });

    // Add container index
    this.version(3).stores({
      glyph:
        "++id, &ref, [type+spent], [type+spent+fresh], lastTxoId, height, tokenType, container",
    });

    // Add table for keeping track of transactions that have been broadcast
    this.version(4).stores({
      broadcast: "txid",
    });

    this.version(5).upgrade(async (transaction) => {
      const { mainnet } = await transaction.table("kvp").get("servers");

      // Add new servers and shuffle if they aren't in the db already
      const hasNewServers = mainnet.some(
        (server: string) => !server.includes("radiant4people")
      );

      if (!hasNewServers) {
        const newServers = config.defaultConfig.servers.mainnet.slice(2);
        mainnet.push(...newServers);
        shuffle(mainnet);
      }

      const testnet = config.defaultConfig.servers.testnet;
      transaction.table("kvp").put({ mainnet, testnet }, "servers");
    });

    this.version(6).stores({
      swap: "++id, status, txid",
    });

    // Update servers to latest list (V2 hard fork compatible)
    this.version(7).upgrade(async (transaction) => {
      const mainnet = shuffle([...config.defaultConfig.servers.mainnet]);
      const testnet = config.defaultConfig.servers.testnet;
      transaction.table("kvp").put({ mainnet, testnet }, "servers");
    });

    // Remove failing :50004 servers, keep only working :50022 servers
    this.version(8).upgrade(async (transaction) => {
      const mainnet = shuffle([...config.defaultConfig.servers.mainnet]);
      const testnet = config.defaultConfig.servers.testnet;
      transaction.table("kvp").put({ mainnet, testnet }, "servers");
    });

    // Merge in any newly added default servers without dropping user-edited entries
    this.version(9).upgrade(async (transaction) => {
      const current = (await transaction.table("kvp").get("servers")) as
        | { mainnet?: string[]; testnet?: string[] }
        | undefined;

      const mainnet = [...(current?.mainnet || [])];
      const missing = config.defaultConfig.servers.mainnet.filter(
        (server) => !mainnet.includes(server)
      );

      if (missing.length > 0) {
        mainnet.push(...missing);
      }

      const testnet = current?.testnet?.length
        ? current.testnet
        : config.defaultConfig.servers.testnet;

      transaction
        .table("kvp")
        .put({ mainnet: shuffle(mainnet), testnet }, "servers");
    });

    // Add vault table for Radiant Vault (CLTV timelocking)
    this.version(10).stores({
      vault:
        "++id, &[txid+vout], [claimed], [recipientAddress+claimed], [senderAddress+claimed], locktime, assetType",
    });

    // Fix vault indexes: 'claimed' as simple index + add 'date' index
    this.version(11).stores({
      vault:
        "++id, &[txid+vout], claimed, [recipientAddress+claimed], [senderAddress+claimed], locktime, assetType, date",
    });

    // Add vault claim tracking fields and activity log
    this.version(12)
      .stores({
        vault:
          "++id, &[txid+vout], claimed, [recipientAddress+claimed], [senderAddress+claimed], locktime, assetType, date, claimTxid",
      })
      .upgrade(async (transaction) => {
        // Initialize activityLog and claim fields for existing vaults
        await transaction
          .table("vault")
          .toCollection()
          .modify((vault) => {
            if (!vault.activityLog) {
              vault.activityLog = [
                {
                  timestamp: vault.date,
                  action: "created",
                  txid: vault.txid,
                  details: "Vault created",
                  height: vault.height,
                },
              ];
            }
            // claim fields are undefined by default (vault not yet claimed)
          });
      });

    // Add vault scan tracking key-value pair
    this.version(13).upgrade(async (transaction) => {
      // Initialize vault scan timestamp tracking
      await transaction.table("kvp").put({ timestamp: 0 }, "vaultLastScan");
    });

    // Add date index to broadcast table for ActivityNotifications query
    this.version(14).stores({
      broadcast: "txid, date",
    });

    // Add `mode` index to swap table so MyOffersPanel can query
    // db.swap.where({ mode: SwapMode.BROADCAST }) without SchemaError.
    // The `mode` field was added to TokenSwap after version 6 shipped but the
    // index was never created, causing "KeyPath mode on object store swap is
    // not indexed" for all users with an existing DB.
    this.version(15).stores({
      swap: "++id, status, txid, mode",
    });

    // Add covenant table for tracking tokens resting in on-chain covenants
    // (royalty listings, soulbound mints, authority-gated mints). These rest in
    // scriptPubKeys the ordinary NFT subscription doesn't index by owner, so —
    // like PSRT swaps in `swap` — they are tracked locally to stay
    // discoverable/manageable. See covenant.ts.
    this.version(16).stores({
      covenant: "++id, type, ref, status, &[txid+vout], [status+type]",
    });

    // Upgrade any saved direct-port radiantcore endpoints (50010/50011/50012)
    // to the :443 endpoint. Those direct ElectrumX ports are firewalled to the
    // public internet (2026-06-08) and routinely blocked on mobile/corporate
    // networks; only wss://electrumx.radiantcore.org (Caddy :443) is reliably
    // reachable. Older default lists shipped `:50011`, so existing wallets carry
    // a stale, now-dead entry that the connection shuffle keeps retrying →
    // "can't establish a connection" / FT balances never load. Rewrite + dedupe.
    this.version(17).upgrade(async (transaction) => {
      const current = (await transaction.table("kvp").get("servers")) as
        | { mainnet?: string[]; testnet?: string[] }
        | undefined;
      if (!current) return;

      const upgrade = (list: string[] = []) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const s of list) {
          const u =
            /^wss?:\/\/(electrumx\.)?radiantcore\.org:(50010|50011|50012)$/.test(
              s.trim()
            )
              ? "wss://electrumx.radiantcore.org"
              : s;
          if (!seen.has(u)) {
            seen.add(u);
            out.push(u);
          }
        }
        return out;
      };

      transaction
        .table("kvp")
        .put(
          { mainnet: upgrade(current.mainnet), testnet: current.testnet },
          "servers"
        );
    });
  }
}

const db = new Database();

// Populate the database
db.on("ready", async () => {
  const defaults = config.defaultConfig;
  const configKeys = Object.keys(defaults);
  shuffle(config.defaultConfig.servers.mainnet);
  const missing = (await db.kvp.bulkGet(configKeys))
    .map((v, i) =>
      v
        ? false
        : [
            configKeys[i],
            (defaults as { [key: string]: unknown })[configKeys[i]],
          ]
    )
    .filter(Boolean);

  if (missing.length) {
    const obj = Object.fromEntries(missing as []);
    return db.kvp.bulkPut(Object.values(obj), Object.keys(obj));
  }
});

export default db;
