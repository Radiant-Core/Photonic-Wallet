import Outpoint from "@lib/Outpoint";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import { ContractType, SmartTokenType } from "./types";
import db from "./db";

// SwapOffer as defined in Radiant Core's swapindex.h
export interface SwapOffer {
  version: number;
  flags: number;
  offered_type: number;
  terms_type: number;
  tokenid: string;
  want_tokenid?: string;
  utxo: {
    txid: string;
    vout: number;
  };
  price_terms: string; // hex-encoded serialized output
  signature: string; // hex-encoded partial signature
  block_height: number;
  // RSWP v3 (Phase 2): consensus-level expiry. Absolute block height at/after
  // which the offer is unfillable and the maker's timelocked-refund covenant
  // lets them reclaim the reserved asset. Absent / 0 for v2 offers (no on-chain
  // expiry). See docs/swap-offer-expiry-cancellation.md §4 and
  // @lib/swapRefundCovenant. The index populates this from the RSWP v3
  // advertisement; the wallet treats a missing value as "no expiry".
  expiry_height?: number;
}

/**
 * RSWP advertisement format version bytes. v2 is the legacy format (no
 * on-chain expiry); v3 adds a maker-chosen `expiry_height`. The wallet builds
 * v3 and accepts both when reading offers from the index.
 */
export const RSWP_VERSION_V2 = 0x02;
export const RSWP_VERSION_V3 = 0x03;

/**
 * RSWP v3 flag bit indicating the offer carries an on-chain `expiry_height`
 * (and the reserved UTXO is held in a timelocked-refund covenant). Bit 1 in the
 * advertisement flags byte (bit 0 = "has want token", already used by v2).
 */
export const RSWP_FLAG_HAS_EXPIRY = 0x02;

/**
 * Whether a (possibly v3) offer is past its on-chain expiry given the current
 * chain tip. v2 offers (no `expiry_height`) are never on-chain-expired — the
 * client SOFT expiry (swapExpiry.ts) still applies to them. Mirrors
 * @lib/swapRefundCovenant `isOfferExpiredByHeight` so the wallet and the
 * covenant agree on the boundary (filled-iff height < expiry).
 */
export function isOfferExpiredOnChain(
  offer: Pick<SwapOffer, "expiry_height">,
  currentHeight: number
): boolean {
  const expiry = offer.expiry_height;
  if (!expiry || expiry <= 0) return false;
  if (!Number.isFinite(currentHeight) || currentHeight <= 0) return false;
  return currentHeight >= expiry;
}

export interface SwapOrderCounts {
  open: number;
  history: number;
}

// Parsed swap offer with decoded terms for UI display
export interface ParsedSwapOffer extends SwapOffer {
  wantScript?: string;
  wantValue?: number;
  wantOutputs?: { script: string; value: number }[];
  offeredContractType: ContractType;
  wantContractType: ContractType;
  offeredTokenType?: SmartTokenType;
  wantTokenType?: SmartTokenType;
}

// Configuration for RPC endpoint
export interface SwapRpcConfig {
  url: string;
  username?: string;
  password?: string;
}

// Default RPC endpoint used by Open Orders / swap views.
// This should be a CORS-enabled reverse proxy in front of a Radiant Core node
// started with `-swapindex=1`. See `docs/deployment-guide.md` for the VPS
// Caddy/Docker recipe used by the hosted wallet.
const DEFAULT_RPC_CONFIG: SwapRpcConfig = {
  url: "https://swap.radiantcore.org",
};

// SECURITY FIX (H8): Use IndexedDB instead of localStorage for better security
const DB_KEY = "swapRpcConfig";

/**
 * Validate swap RPC URL - must use https:// scheme for security
 * SECURITY FIX (H8): Prevent http:// and other insecure schemes
 */
function validateSwapRpcUrl(url: string): { valid: boolean; error?: string } {
  if (!url || typeof url !== "string") {
    return { valid: false, error: "URL is required" };
  }

  url = url.trim();

  // Must use HTTPS scheme
  if (!url.startsWith("https://")) {
    if (url.startsWith("http://")) {
      return {
        valid: false,
        error:
          "Insecure HTTP URL is not allowed. Use https:// for secure connections.",
      };
    }
    return {
      valid: false,
      error: "Swap RPC URL must use https:// scheme",
    };
  }

  try {
    const urlObj = new URL(url);
    if (urlObj.protocol !== "https:") {
      return { valid: false, error: "URL must use https:// protocol" };
    }
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  return { valid: true };
}

/**
 * Load swap RPC config from IndexedDB (more secure than localStorage)
 * SECURITY FIX (H8): Moved from localStorage to IndexedDB
 */
async function loadStoredConfig(): Promise<SwapRpcConfig> {
  try {
    const stored = (await db.kvp.get(DB_KEY)) as SwapRpcConfig | undefined;
    if (!stored || typeof stored.url !== "string" || !stored.url) {
      return DEFAULT_RPC_CONFIG;
    }

    // SECURITY FIX (H8): Validate URL scheme
    const validation = validateSwapRpcUrl(stored.url);
    if (!validation.valid) {
      console.warn(`Invalid swap RPC URL in storage: ${validation.error}`);
      return DEFAULT_RPC_CONFIG;
    }

    return {
      url: stored.url,
      username:
        typeof stored.username === "string" ? stored.username : undefined,
      password:
        typeof stored.password === "string" ? stored.password : undefined,
    };
  } catch {
    return DEFAULT_RPC_CONFIG;
  }
}

let rpcConfig: SwapRpcConfig = DEFAULT_RPC_CONFIG;

// Initialize config asynchronously
loadStoredConfig()
  .then((config) => {
    rpcConfig = config;
  })
  .catch(() => {
    // Falls back to DEFAULT_RPC_CONFIG already assigned above.
  });

/**
 * Save swap RPC config to IndexedDB with scheme validation
 * SECURITY FIX (H8): Added https:// scheme validation and moved to IndexedDB
 */
export async function setSwapRpcConfig(config: SwapRpcConfig): Promise<void> {
  // SECURITY FIX (H8): Validate URL scheme before saving
  const validation = validateSwapRpcUrl(config.url);
  if (!validation.valid) {
    throw new Error(`Invalid swap RPC URL: ${validation.error}`);
  }

  rpcConfig = config;
  try {
    await db.kvp.put(config, DB_KEY);
  } catch (error) {
    // Ignore storage failures; in-memory config still works.
    console.warn("Failed to save swap RPC config:", error);
  }
}

export function getSwapRpcConfig(): SwapRpcConfig {
  return rpcConfig;
}

export function getDefaultSwapRpcConfig(): SwapRpcConfig {
  return DEFAULT_RPC_CONFIG;
}

/**
 * Make an RPC call to Radiant Core
 */
async function rpcCall<T>(method: string, params: unknown[] = []): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (rpcConfig.username && rpcConfig.password) {
    const auth = btoa(`${rpcConfig.username}:${rpcConfig.password}`);
    headers["Authorization"] = `Basic ${auth}`;
  }

  const response = await fetch(rpcConfig.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `RPC request failed: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(
      `RPC error: ${data.error.message || JSON.stringify(data.error)}`
    );
  }

  return data.result as T;
}

/**
 * Get open orders for a token (orders offering this token)
 */
export async function getOpenOrders(
  tokenRef: string,
  limit = 100,
  offset = 0,
  maxAge?: number
): Promise<SwapOffer[]> {
  const params: (string | number | null)[] = [tokenRef, limit, offset];
  if (maxAge !== undefined) {
    params.push(maxAge);
  }
  return rpcCall<SwapOffer[]>("getopenorders", params);
}

/**
 * Get open orders for a wanted token (orders wanting this token)
 */
export async function getOpenOrdersByWant(
  wantTokenRef: string,
  limit = 100,
  offset = 0,
  maxAge?: number
): Promise<SwapOffer[]> {
  const params: (string | number | null)[] = [wantTokenRef, limit, offset];
  if (maxAge !== undefined) {
    params.push(maxAge);
  }
  return rpcCall<SwapOffer[]>("getopenordersbywant", params);
}

/**
 * Get swap history for a token
 */
export async function getSwapHistory(
  tokenRef: string,
  limit = 100,
  offset = 0
): Promise<SwapOffer[]> {
  return rpcCall<SwapOffer[]>("getswaphistory", [tokenRef, limit, offset]);
}

/**
 * Get swap history by wanted token
 */
export async function getSwapHistoryByWant(
  wantTokenRef: string,
  limit = 100,
  offset = 0
): Promise<SwapOffer[]> {
  return rpcCall<SwapOffer[]>("getswaphistorybywant", [
    wantTokenRef,
    limit,
    offset,
  ]);
}

/**
 * Get order counts for a token
 */
export async function getSwapCount(tokenRef: string): Promise<SwapOrderCounts> {
  return rpcCall<SwapOrderCounts>("getswapcount", [tokenRef]);
}

/**
 * Get order counts by wanted token
 */
export async function getSwapCountByWant(
  wantTokenRef: string
): Promise<SwapOrderCounts> {
  return rpcCall<SwapOrderCounts>("getswapcountbywant", [wantTokenRef]);
}

/**
 * Get swap index info
 */
export async function getSwapIndexInfo(): Promise<{
  enabled: boolean;
  current_height: number;
  total_orders: number;
  open_orders: number;
  history_orders: number;
  history_blocks: number;
}> {
  return rpcCall("getswapindexinfo", []);
}

/**
 * Check if swap index is available
 */
export async function isSwapIndexAvailable(): Promise<boolean> {
  try {
    const info = await getSwapIndexInfo();
    return info.enabled;
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function readCompactSize(bytes: Uint8Array, offset: number) {
  if (offset >= bytes.length) {
    throw new Error("Invalid CompactSize");
  }

  const first = bytes[offset];
  if (first < 253) {
    return { value: first, size: 1 };
  }

  if (first === 253) {
    if (offset + 3 > bytes.length) {
      throw new Error("Invalid CompactSize");
    }
    return {
      value: bytes[offset + 1] | (bytes[offset + 2] << 8),
      size: 3,
    };
  }

  if (first === 254) {
    if (offset + 5 > bytes.length) {
      throw new Error("Invalid CompactSize");
    }
    return {
      value:
        bytes[offset + 1] |
        (bytes[offset + 2] << 8) |
        (bytes[offset + 3] << 16) |
        (bytes[offset + 4] << 24),
      size: 5,
    };
  }

  throw new Error("CompactSize value too large");
}

function encodeCompactSize(value: number): Uint8Array {
  if (value < 253) {
    return Uint8Array.from([value]);
  }

  if (value <= 0xffff) {
    return Uint8Array.from([253, value & 0xff, (value >> 8) & 0xff]);
  }

  if (value <= 0xffffffff) {
    return Uint8Array.from([
      254,
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff,
    ]);
  }

  throw new Error("CompactSize value too large");
}

function encodeOutput(script: string, value: number) {
  const valueBytes = new Uint8Array(8);
  let remaining = value;
  for (let i = 0; i < 8; i++) {
    valueBytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }

  const scriptBytes = hexToBytes(script);
  const scriptLen = encodeCompactSize(scriptBytes.length);
  const result = new Uint8Array(8 + scriptLen.length + scriptBytes.length);
  result.set(valueBytes, 0);
  result.set(scriptLen, 8);
  result.set(scriptBytes, 8 + scriptLen.length);
  return result;
}

export function parsePriceTerms(priceTermsHex: string): {
  script: string;
  value: number;
  outputs: { script: string; value: number }[];
} | null {
  try {
    const bytes = hexToBytes(priceTermsHex);
    if (bytes.length === 0) {
      return null;
    }

    let offset = 0;
    let outputs: { script: string; value: number }[] = [];

    try {
      const count = readCompactSize(bytes, offset);
      offset += count.size;

      for (let i = 0; i < count.value; i++) {
        if (offset + 8 > bytes.length) {
          throw new Error("Invalid output value");
        }

        let value = 0;
        for (let j = 7; j >= 0; j--) {
          value = value * 256 + bytes[offset + j];
        }
        offset += 8;

        const scriptLen = readCompactSize(bytes, offset);
        offset += scriptLen.size;

        if (offset + scriptLen.value > bytes.length) {
          throw new Error("Invalid output script");
        }

        const script = bytesToHex(
          bytes.slice(offset, offset + scriptLen.value)
        );
        offset += scriptLen.value;
        outputs.push({ script, value });
      }

      if (offset !== bytes.length || outputs.length === 0) {
        throw new Error("Invalid MultiTxOutV1 payload");
      }
    } catch {
      if (bytes.length < 9) {
        return null;
      }

      let value = 0;
      for (let i = 7; i >= 0; i--) {
        value = value * 256 + bytes[i];
      }

      const script = bytesToHex(bytes.slice(8));
      outputs = [{ script, value }];
    }

    return {
      script: outputs[0].script,
      value: outputs[0].value,
      outputs,
    };
  } catch {
    return null;
  }
}

export function encodePriceTerms(script: string, value: number): string {
  return encodePriceTermsOutputs([{ script, value }]);
}

export function encodePriceTermsOutputs(
  outputs: { script: string; value: number }[]
): string {
  const count = encodeCompactSize(outputs.length);
  const encodedOutputs = outputs.map((output) =>
    encodeOutput(output.script, output.value)
  );
  const totalSize =
    count.length +
    encodedOutputs.reduce((sum, output) => sum + output.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  result.set(count, offset);
  offset += count.length;
  for (const output of encodedOutputs) {
    result.set(output, offset);
    offset += output.length;
  }
  return bytesToHex(result);
}

export function assetToSwapTokenId(
  contractType: ContractType,
  glyphRef?: string | null
): string {
  if (contractType === ContractType.RXD || !glyphRef) {
    return "00".repeat(32);
  }

  return Buffer.from(
    sha256(Buffer.from(Outpoint.fromString(glyphRef).ref(), "hex"))
  ).toString("hex");
}
