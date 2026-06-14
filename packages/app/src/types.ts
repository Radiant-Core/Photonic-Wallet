/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore
import type { EncryptedData } from "@lib/encryption";
import type { GlyphV2Royalty, GlyphV2Policy } from "@lib/v2metadata";
import { ElectrumUtxo, NetworkKey } from "@lib/types";
import { CreateToastFnReturn } from "@chakra-ui/react";
import type { SecretBytes } from "./secretBytes";

export type ScriptGroup = "rxd" | "ref" | "nft" | "ft";

// Type of script subscribed to
export enum ContractType {
  RXD,
  NFT,
  FT,
  VAULT,
}

// Type of radiant smart token (mint operation)
export enum SmartTokenType {
  NFT,
  FT,
  DAT,
}

export interface TxO {
  id?: number;
  txid: string; // Can these be shared with Utxo type?
  vout: number;
  script: string;
  value: number;
  date?: number;
  height?: number;
  spent: 0 | 1;
  change?: 0 | 1;
  contractType: ContractType;
  // Ref-tracked UTXO (mutable-NFT / WAVE singletons resting under an auth
  // covenant script after a state/target update). These never appear in the
  // address' ordinary NFT `listunspent`, so the scripthash sweep in updateTxos
  // must NOT decide their spent state — `reconcileRefTrackedNfts` (NFT worker)
  // tracks them by ref via `blockchain.ref.get`.
  byRef?: 0 | 1;
}

export enum SwapStatus {
  PENDING,
  CANCEL,
  COMPLETE,
}

// Swap mode: private (share hex manually) or broadcast (publish to network)
export enum SwapMode {
  PRIVATE,
  BROADCAST,
}

export interface TokenSwap {
  id?: number;
  txid: string;
  tx: string;
  from: ContractType;
  fromGlyph: string | null;
  fromValue: number;
  to: ContractType;
  toGlyph: string | null;
  toValue: number;
  status: SwapStatus;
  date: number;
  // New fields for broadcast swaps
  mode?: SwapMode;
  broadcastTxid?: string; // txid of the broadcast advertisement tx
}

// On-chain covenant a token can rest in. These scriptPubKeys are NOT the plain
// zero-ref nftScript template the indexer indexes by owner, so a token resting
// in one is invisible to the ordinary NFT subscription. We track them locally,
// the same way PSRT swaps are tracked in db.swap, so covenant-listed/minted
// tokens don't vanish from the wallet. See
// docs/covenants-royalty-soulbound-authority.md §5.1.
export enum CovenantType {
  ROYALTY_LISTING,
  SOULBOUND,
  AUTHORITY_GATED,
}

export enum CovenantStatus {
  // The covenant UTXO is live on-chain (listing open / token held in covenant).
  ACTIVE,
  // The covenant UTXO has been spent: a royalty listing was bought or
  // cancelled, or a soulbound token was burned/moved. Resolved, kept for
  // history.
  RESOLVED,
}

// Serializable royalty sale terms (mirrors @lib/royaltyCovenant RoyaltySaleTerms;
// duplicated as a plain shape so types.ts stays free of a lib value import).
export interface CovenantRoyaltyTerms {
  ref: string;
  sellerAddress: string;
  sellerScript: string;
  price: number;
  royalties: Array<{ script: string; value: number }>;
}

// A covenant UTXO the wallet created (a royalty listing, a soulbound mint, or an
// authority-gated mint). Lets covenant-resting tokens stay discoverable/managed
// locally without relying on indexer recognition of the covenant patterns.
export interface CovenantRecord {
  id?: number;
  type: CovenantType;
  /** Token singleton ref in BE display form (matches SmartToken.ref). */
  ref: string;
  /** Covenant UTXO outpoint. */
  txid: string;
  vout: number;
  /** Covenant scriptPubKey hex (the listing/soulbound/gated script). */
  script: string;
  value: number;
  /** Wallet address that created (and, for listings, can cancel) the covenant. */
  ownerAddress: string;
  status: CovenantStatus;
  date: number;
  /** Royalty sale terms — present for ROYALTY_LISTING covenants only. */
  terms?: CovenantRoyaltyTerms;
}

export interface SubscriptionStatus {
  scriptHash: string;
  status: string;
  contractType: ContractType;
  sync: {
    done: boolean;
    numSynced?: number;
    numTotal?: number;
    error?: boolean;
  };
}

export interface ContractBalance {
  id: string;
  confirmed: number;
  unconfirmed: number;
}

export interface BlockHeader {
  hash: string;
  height: number;
  buffer: ArrayBuffer;
  reorg: boolean;
}

export interface BroadcastResult {
  txid: string;
  description: string;
  date: number;
}

// Tokens that follow Radiant Smart Token standard
// TODO rename all instances of SmartToken to Glyph
export interface SmartToken {
  id?: number;
  p?: (number | string)[];
  tokenType: SmartTokenType;
  ref: string;
  ticker?: string;
  lastTxoId?: number;
  revealOutpoint?: string;
  spent: 0 | 1;
  fresh: 0 | 1;
  location?: string;
  name: string;
  type: string; // User defined type
  immutable?: boolean;
  description: string;
  author: string;
  container: string;
  attrs: { [key: string]: string };
  embed?: { t: string; b: ArrayBuffer | Uint8Array }; // Embedded file. TODO save multiple files? Should this go in OPFS or reference the OPFS raw tx?
  remote?: {
    t: string;
    u: string;
    h?: ArrayBuffer | Uint8Array;
    hs?: ArrayBuffer | Uint8Array;
  }; // Remote file
  height?: number;
  swapPending?: boolean;
  // Encrypted NFT fields (GLYPH_ENCRYPTED protocol)
  crypto?: unknown; // payload.crypto — encryption metadata stub
  main?: unknown; // payload.main — on-chain ciphertext or file metadata
  // WAVE protocol fields
  is_wave_duplicate?: boolean; // True if this is a duplicate WAVE name registration
  // Glyph v2 covenant metadata — persisted from the reveal payload so the
  // royalty-listing flow can recover the creator's recorded terms
  // (royaltyTermsFromMetadata) and badges can reflect enforced royalty /
  // soulbound policy without re-decoding the reveal.
  royalty?: GlyphV2Royalty;
  policy?: GlyphV2Policy;
}

export interface Subscription {
  // Provide toast to subscription so user can be notified
  register(address: string, toast: CreateToastFnReturn): void;
  syncPending(): void;
  manualSync(): void;
}

export type ElectrumCallback = (...payload: unknown[]) => unknown;

export type ElectrumStatusUpdate = (
  scriptHash: string,
  newStatus: string,
  manual: boolean
) => Promise<{
  added: TxO[];
  confs: Map<number, ElectrumUtxo>;
  conflict: Map<number, string>;
  spent: { id: number; value: number; script: string }[];
  utxoCount?: number;
}>;

export type SavedWallet = EncryptedData & {
  address: string;
  swapAddress: string;
  net: NetworkKey;
  /**
   * BIP-44 SLIP-0044 coin type used for HD derivation.
   * - 512 (default for wallets created after v3.0.0)
   * - 0   (legacy wallets created before v3.0.0)
   * If undefined, treated as legacy (0) for existing saved wallets and
   * auto-detected/persisted on next unlock.
   */
  coinType?: number;
};

export interface WalletState {
  net: NetworkKey;
  ready: boolean;
  exists: boolean;
  locked: boolean;
  /**
   * Spending WIF as zeroable bytes. Replaces the prior `wif?: string` so
   * the persistent unlocked-session reference can be cleared on lock
   * (R4 — JS strings cannot be wiped). Materialise to a string only
   * inside a signing op via `wif.toString()`.
   */
  wif?: SecretBytes;
  address: string;
  /** Swap-WIF as zeroable bytes. See `wif` above. */
  swapWif?: SecretBytes;
  swapAddress: string;
  /** BIP-39 mnemonic as zeroable bytes; cleared on lock. */
  mnemonic?: SecretBytes;
  /**
   * BIP-44 SLIP-0044 coin type used for HD derivation (mirrors
   * `SavedWallet.coinType`). Hydrated on `loadWalletFromSaved` and refreshed
   * on `unlockWallet` so encryption-key derivation (R26) matches what the
   * wallet uses for spending. Undefined → legacy default `0` for legacy
   * unlocked sessions, `DEFAULT_COIN_TYPE` for new wallets.
   */
  coinType?: number;
}

export enum ElectrumStatus {
  LOADING,
  DISCONNECTED,
  CONNECTING,
  CONNECTED,
}

export type NetworkConfig = {
  name: string;
  ticker: string;
  anchor: {
    height: number;
    bits: number;
    prevTime: number;
  };
  anchorV2?: {
    height: number;
    bits: number;
    prevTime: number;
  };
  explorer: {
    tx: string;
  };
};

export class SwapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapError";
    Object.setPrototypeOf(this, SwapError.prototype);
  }
}

// Vault activity log entry for tracking vault lifecycle events
export interface VaultActivity {
  timestamp: number;
  action: "created" | "discovered" | "claimed" | "unlockable" | "restored";
  txid: string;
  details?: string;
  height?: number;
}

// Radiant Vault record — stored in IndexedDB for recovery and UI display
export interface VaultRecord {
  id?: number;
  /** Vault creation txid */
  txid: string;
  /** Output index of the vault P2SH UTXO */
  vout: number;
  /** Amount locked (photons) */
  value: number;
  /** Asset type: rxd, nft, or ft */
  assetType: "rxd" | "nft" | "ft";
  /** Lock mode */
  mode: "block" | "time";
  /** Locktime value (block height or UNIX timestamp) */
  locktime: number;
  /** Recipient P2PKH address */
  recipientAddress: string;
  /** Sender P2PKH address */
  senderAddress: string;
  /** Token ref (for NFT/FT) in LE hex */
  ref?: string;
  /** Optional label */
  label?: string;
  /** Full redeem script hex (needed to spend) */
  redeemScriptHex: string;
  /** P2SH output script hex */
  p2shScriptHex: string;
  /** Whether this vault has been claimed (spent) */
  claimed: 0 | 1;
  /** Block height when vault tx was confirmed */
  height?: number;
  /** Creation timestamp */
  date: number;
  /** Claim transaction txid (when claimed) */
  claimTxid?: string;
  /** When the vault was claimed */
  claimDate?: number;
  /** Block height when claimed */
  claimHeight?: number;
  /** Activity log for this vault */
  activityLog?: VaultActivity[];
}

/**
 * Result of a vault discovery scan over one address's transaction history.
 * `skipped` counts transactions that could not be fetched/verified (timeouts,
 * hash mismatch, per-tx errors) — a non-zero value means the scan was partial
 * and "no vaults found" cannot be trusted.
 */
export interface VaultScanResult {
  /** New vaults discovered and stored this scan */
  discovered: number;
  /** Transactions successfully fetched and examined */
  scanned: number;
  /** Total transactions in the address history */
  total: number;
  /** Transactions that could not be scanned (timeouts, verification failures) */
  skipped: number;
}

/** Persisted record of the last vault discovery scan for an address. */
export interface VaultLastScan extends VaultScanResult {
  timestamp: number;
  address?: string;
  /** True only when every transaction was scanned (skipped === 0, no throw). */
  complete: boolean;
}

/**
 * Sentinel thrown by discoverVaults when the address transaction history could
 * not be loaded (get_history exhausted its retries). Carried via the Error
 * message so it survives the comlink worker boundary, where `instanceof` checks
 * do not. The UI maps this to a "could not load history" error instead of the
 * misleading "no vaults found".
 */
export const VAULT_SCAN_FAILED = "VAULT_SCAN_FAILED";

export {};
