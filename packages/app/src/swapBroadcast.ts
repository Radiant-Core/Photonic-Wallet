/**
 * Broadcast Swap functionality for Photonic Wallet
 * Integrates with Radiant Core's SwapIndex for public order book
 */

import { ContractType, SmartTokenType } from "./types";

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
}

export interface SwapOrderCounts {
  open: number;
  history: number;
}

// Parsed swap offer with decoded terms for UI display
export interface ParsedSwapOffer extends SwapOffer {
  // Decoded from price_terms
  wantScript?: string;
  wantValue?: number;
  // Derived info
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

// Default to local node
const DEFAULT_RPC_CONFIG: SwapRpcConfig = {
  url: "http://127.0.0.1:7332",
};

let rpcConfig: SwapRpcConfig = DEFAULT_RPC_CONFIG;

export function setSwapRpcConfig(config: SwapRpcConfig) {
  rpcConfig = config;
}

export function getSwapRpcConfig(): SwapRpcConfig {
  return rpcConfig;
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
    throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  
  if (data.error) {
    throw new Error(`RPC error: ${data.error.message || JSON.stringify(data.error)}`);
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
  return rpcCall<SwapOffer[]>("getswaphistorybywant", [wantTokenRef, limit, offset]);
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
export async function getSwapCountByWant(wantTokenRef: string): Promise<SwapOrderCounts> {
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

/**
 * Parse price_terms from a swap offer to extract the requested output
 * price_terms contains a serialized output (script + value)
 */
export function parsePriceTerms(priceTermsHex: string): { script: string; value: number } | null {
  try {
    const bytes = hexToBytes(priceTermsHex);
    if (bytes.length < 9) return null; // minimum: 8 bytes value + 1 byte script length

    // First 8 bytes are little-endian value
    let value = 0;
    for (let i = 7; i >= 0; i--) {
      value = value * 256 + bytes[i];
    }

    // Rest is the script (with length prefix if present)
    const scriptBytes = bytes.slice(8);
    const script = bytesToHex(scriptBytes);

    return { script, value };
  } catch {
    return null;
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

/**
 * Encode price terms for broadcasting (value + script)
 */
export function encodePriceTerms(script: string, value: number): string {
  // 8 bytes little-endian value
  const valueBytes = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    valueBytes[i] = v & 0xff;
    v = Math.floor(v / 256);
  }

  const scriptBytes = hexToBytes(script);
  const result = new Uint8Array(8 + scriptBytes.length);
  result.set(valueBytes, 0);
  result.set(scriptBytes, 8);

  return bytesToHex(result);
}
