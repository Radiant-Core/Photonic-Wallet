/* eslint-disable @typescript-eslint/ban-ts-comment */
/**
 * Radiant Vault — CLTV-based Coin & Token Timelocking
 *
 * Uses OP_CHECKLOCKTIMEVERIFY (consensus-enforced) to create outputs that
 * cannot be spent before a specified block height or UNIX timestamp.
 *
 * Supports:
 *  - Plain RXD coin vaults
 *  - NFT vaults (singleton ref preserved)
 *  - FT vaults (fungible token conservation rules preserved)
 *  - Vesting schedules (up to 12 tranches in one transaction)
 *  - Encrypted OP_RETURN metadata for seed-based recovery
 *
 * Locking script (redeem script) pattern:
 *   <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <inner-script>
 *
 * Where <inner-script> is one of:
 *   - P2PKH (RXD)
 *   - OP_PUSHINPUTREFSINGLETON <ref> OP_DROP P2PKH (NFT)
 *   - P2PKH OP_STATESEPARATOR <FT conservation> (FT)
 *
 * Spending requires:
 *   - nLockTime >= locktime on the spending transaction
 *   - nSequence < 0xFFFFFFFF on the spending input
 *   - Valid signature satisfying the inner script
 *   - Full redeem script revealed in scriptSig (P2SH)
 */

import rjs from "@radiant-core/radiantjs";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  encryptXChaCha20Poly1305,
  decryptXChaCha20Poly1305,
  deriveKeyHKDF,
} from "./encryption";
import { randomBytes } from "@noble/hashes/utils";

const { Script, Opcode, Address, Transaction, PrivateKey, crypto } = rjs;
type Script = rjs.Script;

// ============================================================================
// Constants
// ============================================================================

/** Maximum locktime in blocks (~10 years at ~1 block/min) */
export const VAULT_MAX_LOCKTIME_BLOCKS = 1051898;

/** Maximum number of vesting tranches */
export const VAULT_MAX_TRANCHES = 12;

/** Threshold: values below this are block heights, above are UNIX timestamps */
export const LOCKTIME_THRESHOLD = 500_000_000;

/** Magic bytes identifying a vault OP_RETURN: "vault" in hex */
export const VAULT_MAGIC_BYTES = "7661756c74"; // "vault"

/** nSequence value that enables CLTV (must be < 0xFFFFFFFF) */
export const CLTV_SEQUENCE = 0xfffffffe;

// ============================================================================
// Types
// ============================================================================

export type VaultAssetType = "rxd" | "nft" | "ft";

export type VaultMode = "block" | "time";

export type VaultParams = {
  /** Locking mode: block height or UNIX timestamp */
  mode: VaultMode;
  /** For "block": absolute block height. For "time": UNIX timestamp (seconds). */
  locktime: number;
  /** Asset type being locked */
  assetType: VaultAssetType;
  /** Recipient address (P2PKH) */
  recipientAddress: string;
  /** For NFT/FT: the token ref in little-endian hex (72 chars) */
  ref?: string;
  /** Amount in photons (RXD/FT) or 1 for NFT */
  value: number;
  /** Optional human-readable label */
  label?: string;
};

export type VestingTranche = VaultParams;

export type VaultMetadata = {
  /** Magic identifier */
  magic: string;
  /** Version */
  v: number;
  /** Asset type */
  a: VaultAssetType;
  /** Locktime mode */
  m: VaultMode;
  /** Locktime value */
  l: number;
  /** Recipient pubkey hash (20 bytes hex) */
  r: string;
  /** Token ref (if NFT/FT) */
  ref?: string;
  /** Label */
  label?: string;
};

export type ParsedVaultScript = {
  locktime: number;
  mode: VaultMode;
  assetType: VaultAssetType;
  recipientPkh: string;
  ref?: string;
  redeemScriptHex: string;
  p2shScriptHex: string;
};

// ============================================================================
// Locktime Encoding
// ============================================================================

/**
 * Encode a locktime as a minimally-encoded script number for CLTV.
 * Values are encoded as little-endian with minimal byte length.
 * Positive values only (CLTV rejects negatives).
 */
export function encodeLocktime(locktime: number): Buffer {
  if (locktime < 0) {
    throw new Error("Locktime must be non-negative");
  }
  if (locktime === 0) {
    return Buffer.from([0x00]);
  }

  // Convert to minimal little-endian encoding
  const bytes: number[] = [];
  let n = locktime;
  while (n > 0) {
    bytes.push(n & 0xff);
    n >>= 8;
  }
  // If the high bit of the last byte is set, add a 0x00 byte
  // to prevent it being interpreted as negative
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(0x00);
  }
  return Buffer.from(bytes);
}

/**
 * Decode a minimally-encoded script number back to a locktime.
 */
export function decodeLocktime(buf: Buffer | Uint8Array): number {
  if (buf.length === 0) return 0;
  // Check for negative (high bit of last byte set)
  if (buf[buf.length - 1] & 0x80) {
    throw new Error("Negative locktime not allowed");
  }
  let n = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    n = (n << 8) | buf[i];
  }
  return n;
}

/**
 * Validate locktime value based on mode.
 */
export function validateLocktime(locktime: number, mode: VaultMode): boolean {
  if (mode === "block") {
    return (
      Number.isInteger(locktime) &&
      locktime > 0 &&
      locktime < LOCKTIME_THRESHOLD &&
      locktime <= VAULT_MAX_LOCKTIME_BLOCKS
    );
  }
  // Time mode: must be >= LOCKTIME_THRESHOLD and a reasonable UNIX timestamp
  return (
    Number.isInteger(locktime) &&
    locktime >= LOCKTIME_THRESHOLD &&
    locktime > Math.floor(Date.now() / 1000)
  );
}

// ============================================================================
// Redeem Script Builders
// ============================================================================

/**
 * Build CLTV + P2PKH redeem script for plain RXD.
 *
 * Script:
 *   <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *   OP_DUP OP_HASH160 <pubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
 */
export function vaultP2pkhRedeemScript(
  locktime: number,
  recipientAddress: string
): string {
  const addr = new Address(recipientAddress);
  const pkh = addr.hashBuffer;
  const locktimeBuf = encodeLocktime(locktime);

  const script = new Script();
  script.add(locktimeBuf);
  script.add(Opcode.OP_CHECKLOCKTIMEVERIFY);
  script.add(Opcode.OP_DROP);
  script.add(Opcode.OP_DUP);
  script.add(Opcode.OP_HASH160);
  script.add(pkh);
  script.add(Opcode.OP_EQUALVERIFY);
  script.add(Opcode.OP_CHECKSIG);

  return script.toHex();
}

/**
 * Build CLTV + NFT redeem script.
 *
 * Script:
 *   <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *   OP_PUSHINPUTREFSINGLETON <ref> OP_DROP
 *   OP_DUP OP_HASH160 <pubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
 */
export function vaultNftRedeemScript(
  locktime: number,
  recipientAddress: string,
  refLE: string
): string {
  if (!refLE || refLE.length !== 72) {
    throw new Error("NFT ref must be 72 hex characters (36 bytes LE)");
  }

  const addr = new Address(recipientAddress);
  const pkh = addr.hashBuffer;
  const locktimeBuf = encodeLocktime(locktime);

  const script = new Script();
  script.add(locktimeBuf);
  script.add(Opcode.OP_CHECKLOCKTIMEVERIFY);
  script.add(Opcode.OP_DROP);
  // Singleton ref
  script.add(Script.fromASM(`OP_PUSHINPUTREFSINGLETON ${refLE} OP_DROP`));
  // P2PKH
  script.add(Opcode.OP_DUP);
  script.add(Opcode.OP_HASH160);
  script.add(pkh);
  script.add(Opcode.OP_EQUALVERIFY);
  script.add(Opcode.OP_CHECKSIG);

  return script.toHex();
}

/**
 * Build CLTV + FT redeem script.
 *
 * Script:
 *   <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
 *   OP_DUP OP_HASH160 <pubKeyHash> OP_EQUALVERIFY OP_CHECKSIG
 *   OP_STATESEPARATOR
 *   OP_PUSHINPUTREF <ref> <FT conservation opcodes>
 *
 * The FT conservation opcodes enforce that the total value of outputs with the
 * same code script hash is >= the total value of inputs (no token inflation).
 */
export function vaultFtRedeemScript(
  locktime: number,
  recipientAddress: string,
  refLE: string
): string {
  if (!refLE || refLE.length !== 72) {
    throw new Error("FT ref must be 72 hex characters (36 bytes LE)");
  }

  const locktimeBuf = encodeLocktime(locktime);

  const script = new Script();
  script.add(locktimeBuf);
  script.add(Opcode.OP_CHECKLOCKTIMEVERIFY);
  script.add(Opcode.OP_DROP);
  // P2PKH
  script.add(Script.buildPublicKeyHashOut(Address.fromString(recipientAddress)));
  // FT conservation (same pattern as ftScript in script.ts)
  script.add(
    Script.fromASM(
      `OP_STATESEPARATOR OP_PUSHINPUTREF ${refLE} OP_REFOUTPUTCOUNT_OUTPUTS OP_INPUTINDEX OP_CODESCRIPTBYTECODE_UTXO OP_HASH256 OP_DUP OP_CODESCRIPTHASHVALUESUM_UTXOS OP_OVER OP_CODESCRIPTHASHVALUESUM_OUTPUTS OP_GREATERTHANOREQUAL OP_VERIFY OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS OP_NUMEQUALVERIFY`
    )
  );

  return script.toHex();
}

// ============================================================================
// P2SH Wrapping
// ============================================================================

/**
 * Compute the P2SH output script from a redeem script hex.
 * P2SH: OP_HASH160 <hash160(redeemScript)> OP_EQUAL
 */
export function p2shOutputScript(redeemScriptHex: string): string {
  const redeemBuf = Buffer.from(redeemScriptHex, "hex");
  const hash = crypto.Hash.sha256ripemd160(redeemBuf);
  const script = new Script();
  script.add(Opcode.OP_HASH160);
  script.add(hash);
  script.add(Opcode.OP_EQUAL);
  return script.toHex();
}

/**
 * Compute the P2SH address from a redeem script hex.
 */
export function p2shAddress(redeemScriptHex: string): string {
  const redeemBuf = Buffer.from(redeemScriptHex, "hex");
  const hash = crypto.Hash.sha256ripemd160(redeemBuf);
  // @ts-ignore — fromScriptHash exists at runtime
  return Address.fromScriptHash(hash).toString();
}

/**
 * Compute script hash (for ElectrumX subscriptions).
 * SHA256 of the output script, reversed.
 */
export function vaultScriptHash(redeemScriptHex: string): string {
  const outputScript = p2shOutputScript(redeemScriptHex);
  return Buffer.from(sha256(Buffer.from(outputScript, "hex")))
    .reverse()
    .toString("hex");
}

// ============================================================================
// Vault Redeem Script Selection
// ============================================================================

/**
 * Build the appropriate redeem script for a given vault params.
 */
export function buildRedeemScript(params: VaultParams): string {
  switch (params.assetType) {
    case "rxd":
      return vaultP2pkhRedeemScript(params.locktime, params.recipientAddress);
    case "nft":
      if (!params.ref) throw new Error("NFT vault requires a ref");
      return vaultNftRedeemScript(
        params.locktime,
        params.recipientAddress,
        params.ref
      );
    case "ft":
      if (!params.ref) throw new Error("FT vault requires a ref");
      return vaultFtRedeemScript(
        params.locktime,
        params.recipientAddress,
        params.ref
      );
    default:
      throw new Error(`Unknown asset type: ${params.assetType}`);
  }
}

// ============================================================================
// Vault Script Parsing
// ============================================================================

/**
 * Parse a redeem script to determine if it's a vault script and extract params.
 *
 * Script hex structure (after Script.add(Buffer)):
 *   <pushLen> <locktime-LE-bytes> b1 75 ... (CLTV DROP + inner script)
 *
 * Push prefix: 01-04 for 1-4 byte data, or 05 for 5-byte (timestamp with padding).
 * The push length byte is followed by exactly that many locktime bytes.
 *
 * Patterns after CLTV DROP (b175):
 *   RXD:  76 a9 14 <20-byte-pkh> 88 ac
 *   NFT:  d8 <36-byte-ref> 75 76 a9 14 <20-byte-pkh> 88 ac
 *   FT:   76 a9 14 <20-byte-pkh> 88 ac bd d0 <36-byte-ref> <FT conservation>
 */
export function parseVaultRedeemScript(
  scriptHex: string
): ParsedVaultScript | null {
  // Extract locktime from the push-data prefix
  // Format: <pushLen:1byte> <data:pushLen bytes> b1 75 ...
  const extractLocktime = (
    hex: string
  ): { locktime: number; rest: string } | null => {
    if (hex.length < 6) return null; // minimum: 01 XX b1
    const pushLen = parseInt(hex.slice(0, 2), 16);
    if (pushLen < 1 || pushLen > 5) return null; // locktime is 1-5 bytes
    const dataEnd = 2 + pushLen * 2;
    if (hex.length < dataEnd + 4) return null; // need at least b175 after
    const dataHex = hex.slice(2, dataEnd);
    const afterData = hex.slice(dataEnd);
    if (!afterData.startsWith("b175")) return null; // CLTV DROP
    const locktime = decodeLocktime(Buffer.from(dataHex, "hex"));
    return { locktime, rest: afterData.slice(4) }; // skip b175
  };

  const result = extractLocktime(scriptHex);
  if (!result) return null;
  const { locktime, rest } = result;
  const mode: VaultMode = locktime < LOCKTIME_THRESHOLD ? "block" : "time";

  // NFT: d8 <72-char ref> 75 76 a9 14 <40-char pkh> 88 ac
  const nftPattern = /^d8([0-9a-f]{72})7576a914([0-9a-f]{40})88ac$/;
  const nftMatch = rest.match(nftPattern);
  if (nftMatch) {
    return {
      locktime,
      mode,
      assetType: "nft",
      recipientPkh: nftMatch[2],
      ref: nftMatch[1],
      redeemScriptHex: scriptHex,
      p2shScriptHex: p2shOutputScript(scriptHex),
    };
  }

  // FT: 76 a9 14 <40-char pkh> 88 ac bd d0 <72-char ref> <conservation tail>
  const ftPattern =
    /^76a914([0-9a-f]{40})88acbdd0([0-9a-f]{72})dec0e9aa76e378e4a269e69d$/;
  const ftMatch = rest.match(ftPattern);
  if (ftMatch) {
    return {
      locktime,
      mode,
      assetType: "ft",
      recipientPkh: ftMatch[1],
      ref: ftMatch[2],
      redeemScriptHex: scriptHex,
      p2shScriptHex: p2shOutputScript(scriptHex),
    };
  }

  // RXD: 76 a9 14 <40-char pkh> 88 ac
  const rxdPattern = /^76a914([0-9a-f]{40})88ac$/;
  const rxdMatch = rest.match(rxdPattern);
  if (rxdMatch) {
    return {
      locktime,
      mode,
      assetType: "rxd",
      recipientPkh: rxdMatch[1],
      redeemScriptHex: scriptHex,
      p2shScriptHex: p2shOutputScript(scriptHex),
    };
  }

  return null;
}

// ============================================================================
// Vault OP_RETURN Metadata (Encrypted)
// ============================================================================

/**
 * Derive an encryption key for vault OP_RETURN metadata.
 * Uses HKDF with the recipient's pubkey hash as IKM and "radiant-vault-v1" as info.
 * Both sender and recipient can derive this key from the shared ECDH secret,
 * but for simplicity we use the recipient's pubkey directly.
 */
function deriveVaultMetadataKey(senderWif: string, recipientAddress: string): Uint8Array {
  const privKey = PrivateKey.fromWIF(senderWif);
  const recipientAddr = new Address(recipientAddress);
  const ikm = new Uint8Array(
    Buffer.concat([
      privKey.toPublicKey().toBuffer(),
      recipientAddr.hashBuffer,
    ])
  );
  return deriveKeyHKDF(
    ikm,
    undefined,
    new TextEncoder().encode("radiant-vault-v1"),
    32
  );
}

/**
 * Build encrypted OP_RETURN output script for vault recovery metadata.
 *
 * Format: OP_RETURN <"vault"> <encrypted-payload>
 * Payload (before encryption): CBOR-like compact binary:
 *   [version:1] [assetType:1] [mode:1] [locktime:4LE] [pkh:20] [refLen:1] [ref:0|36] [labelLen:2LE] [label:utf8]
 */
export function buildVaultOpReturn(
  params: VaultParams,
  senderWif: string
): string {
  const metadata = encodeVaultMetadata(params);
  const key = deriveVaultMetadataKey(senderWif, params.recipientAddress);
  const nonce = randomBytes(24);
  const { ciphertext } = encryptXChaCha20Poly1305(metadata, key, nonce);
  const payload = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);

  const script = new Script();
  script.add(Opcode.OP_RETURN);
  script.add(Buffer.from(VAULT_MAGIC_BYTES, "hex")); // "vault"
  script.add(payload);
  return script.toHex();
}

/**
 * Encode vault metadata to compact binary.
 */
function encodeVaultMetadata(params: VaultParams): Uint8Array {
  const assetTypeByte =
    params.assetType === "rxd" ? 0 : params.assetType === "nft" ? 1 : 2;
  const modeByte = params.mode === "block" ? 0 : 1;

  const addr = new Address(params.recipientAddress);
  const pkh = new Uint8Array(addr.hashBuffer);

  const ref = params.ref ? hexToBytes(params.ref) : new Uint8Array(0);
  const label = params.label
    ? new TextEncoder().encode(params.label)
    : new Uint8Array(0);

  const buf = new Uint8Array(1 + 1 + 1 + 4 + 20 + 1 + ref.length + 2 + label.length);
  let offset = 0;

  buf[offset++] = 1; // version
  buf[offset++] = assetTypeByte;
  buf[offset++] = modeByte;

  // locktime as 4 bytes LE
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(offset, params.locktime, true);
  offset += 4;

  buf.set(pkh, offset);
  offset += 20;

  buf[offset++] = ref.length;
  if (ref.length > 0) {
    buf.set(ref, offset);
    offset += ref.length;
  }

  view.setUint16(offset, label.length, true);
  offset += 2;
  if (label.length > 0) {
    buf.set(label, offset);
  }

  return buf;
}

/**
 * Decode vault metadata from compact binary.
 */
export function decodeVaultMetadata(data: Uint8Array): VaultParams | null {
  try {
    if (data.length < 29) return null; // minimum: 1+1+1+4+20+1+2 = 30... but 29 for refLen=0,labelLen=0
    let offset = 0;

    const version = data[offset++];
    if (version !== 1) return null;

    const assetTypeByte = data[offset++];
    const assetType: VaultAssetType =
      assetTypeByte === 0 ? "rxd" : assetTypeByte === 1 ? "nft" : "ft";

    const modeByte = data[offset++];
    const mode: VaultMode = modeByte === 0 ? "block" : "time";

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const locktime = view.getUint32(offset, true);
    offset += 4;

    const pkh = bytesToHex(data.slice(offset, offset + 20));
    offset += 20;

    const refLen = data[offset++];
    let ref: string | undefined;
    if (refLen > 0) {
      ref = bytesToHex(data.slice(offset, offset + refLen));
      offset += refLen;
    }

    const labelLen = view.getUint16(offset, true);
    offset += 2;
    let label: string | undefined;
    if (labelLen > 0) {
      label = new TextDecoder().decode(data.slice(offset, offset + labelLen));
    }

    return {
      mode,
      locktime,
      assetType,
      recipientAddress: "", // Cannot reconstruct full address from pkh alone without network prefix
      ref,
      value: 0, // Not stored in metadata; determined from UTXO
      label,
    };
  } catch {
    return null;
  }
}

/**
 * Attempt to decrypt and parse vault OP_RETURN from a transaction output script.
 * Returns null if not a vault OP_RETURN or decryption fails.
 */
export function parseVaultOpReturn(
  scriptHex: string,
  senderWif: string,
  recipientAddress: string
): VaultParams | null {
  try {
    // OP_RETURN (6a) + push "vault" (05 7661756c74) + push <encrypted>
    if (!scriptHex.startsWith("6a05" + VAULT_MAGIC_BYTES)) {
      return null;
    }

    // Extract encrypted payload after magic bytes
    const afterMagic = scriptHex.slice(4 + 2 + VAULT_MAGIC_BYTES.length);
    // Parse the push data length
    const pushByte = parseInt(afterMagic.slice(0, 2), 16);
    let payloadHex: string;
    if (pushByte < 0x4c) {
      payloadHex = afterMagic.slice(2, 2 + pushByte * 2);
    } else if (pushByte === 0x4c) {
      const len = parseInt(afterMagic.slice(2, 4), 16);
      payloadHex = afterMagic.slice(4, 4 + len * 2);
    } else if (pushByte === 0x4d) {
      const len =
        parseInt(afterMagic.slice(2, 4), 16) |
        (parseInt(afterMagic.slice(4, 6), 16) << 8);
      payloadHex = afterMagic.slice(6, 6 + len * 2);
    } else {
      return null;
    }

    const payload = Buffer.from(payloadHex, "hex");
    if (payload.length < 25) return null; // nonce(24) + at least 1 byte

    const nonce = new Uint8Array(payload.slice(0, 24));
    const ciphertext = new Uint8Array(payload.slice(24));
    const key = deriveVaultMetadataKey(senderWif, recipientAddress);
    const plaintext = decryptXChaCha20Poly1305(ciphertext, key, nonce);

    return decodeVaultMetadata(plaintext);
  } catch {
    return null;
  }
}

// ============================================================================
// Transaction Builders
// ============================================================================

/**
 * Build a vault creation transaction (simple — single locktime).
 *
 * Creates a P2SH output locked until the specified locktime, plus a mandatory
 * encrypted OP_RETURN for recovery.
 *
 * @param coins Available RXD UTXOs for funding
 * @param fromAddress Sender's P2PKH address
 * @param wif Sender's private key (WIF)
 * @param params Vault parameters
 * @param feeRate Fee rate in photons/byte
 * @param tokenUtxos For NFT/FT: the token UTXOs to lock (required inputs)
 * @returns Built transaction and selection info
 */
export function buildVaultTx(
  coins: { txid: string; vout: number; script: string; value: number; scriptSig?: string }[],
  fromAddress: string,
  wif: string,
  params: VaultParams,
  feeRate: number,
  tokenUtxos?: { txid: string; vout: number; script: string; value: number }[]
): { rawTx: string; txid: string; redeemScriptHex: string; p2shAddr: string } {
  const redeemScriptHex = buildRedeemScript(params);
  const p2shScript = p2shOutputScript(redeemScriptHex);
  const opReturnScript = buildVaultOpReturn(params, wif);
  const p2shAddr = p2shAddress(redeemScriptHex);

  const tx = new Transaction();
  const privKey = PrivateKey.fromWIF(wif);
  const changeScript = Script.fromAddress(fromAddress).toHex();

  // Add token inputs first (NFT/FT)
  if (tokenUtxos && tokenUtxos.length > 0) {
    for (const utxo of tokenUtxos) {
      tx.addInput(
        new Transaction.Input({
          prevTxId: utxo.txid,
          outputIndex: utxo.vout,
          script: new Script(),
          output: new Transaction.Output({
            script: utxo.script,
            satoshis: utxo.value,
          }),
        })
      );
    }
  }

  // Add RXD funding inputs
  let totalIn = tokenUtxos
    ? tokenUtxos.reduce((sum, u) => sum + u.value, 0)
    : 0;
  const requiredAmount = params.value + 1000; // vault output + estimated fee buffer
  for (const coin of coins) {
    if (totalIn >= requiredAmount + 5000) break; // enough with fee margin
    tx.from({
      address: fromAddress,
      txId: coin.txid,
      outputIndex: coin.vout,
      script: coin.script || changeScript,
      satoshis: coin.value,
    });
    totalIn += coin.value;
  }

  // Vault output (P2SH)
  tx.addOutput(
    new Transaction.Output({
      script: p2shScript,
      satoshis: params.value,
    })
  );

  // OP_RETURN recovery metadata
  tx.addOutput(
    new Transaction.Output({
      script: opReturnScript,
      satoshis: 0,
    })
  );

  // Change
  tx.change(fromAddress);
  // @ts-ignore — _estimateSize exists at runtime
  tx.fee(Math.max(20000, Math.ceil(tx._estimateSize() * feeRate)));
  tx.sign(privKey);
  tx.seal();

  const rawTx = tx.toString();
  const txidHex = bytesToHex(
    Buffer.from(sha256(sha256(Buffer.from(rawTx, "hex")))).reverse()
  );

  return { rawTx, txid: txidHex, redeemScriptHex, p2shAddr };
}

/**
 * Build a vesting schedule transaction with multiple tranches.
 * Each tranche gets its own P2SH output with a different locktime.
 * A single OP_RETURN contains encrypted metadata for all tranches.
 */
export function buildVestingTx(
  coins: { txid: string; vout: number; script: string; value: number; scriptSig?: string }[],
  fromAddress: string,
  wif: string,
  tranches: VestingTranche[],
  feeRate: number,
  tokenUtxos?: { txid: string; vout: number; script: string; value: number }[]
): {
  rawTx: string;
  txid: string;
  redeemScripts: string[];
  p2shAddresses: string[];
} {
  if (tranches.length < 1 || tranches.length > VAULT_MAX_TRANCHES) {
    throw new Error(`Vesting must have 1-${VAULT_MAX_TRANCHES} tranches`);
  }

  const redeemScripts: string[] = [];
  const p2shAddresses: string[] = [];
  const tx = new Transaction();
  const privKey = PrivateKey.fromWIF(wif);

  // Add token inputs (NFT/FT)
  if (tokenUtxos && tokenUtxos.length > 0) {
    for (const utxo of tokenUtxos) {
      tx.addInput(
        new Transaction.Input({
          prevTxId: utxo.txid,
          outputIndex: utxo.vout,
          script: new Script(),
          output: new Transaction.Output({
            script: utxo.script,
            satoshis: utxo.value,
          }),
        })
      );
    }
  }

  // Add RXD funding
  let totalIn = tokenUtxos
    ? tokenUtxos.reduce((sum, u) => sum + u.value, 0)
    : 0;
  const totalRequired = tranches.reduce((sum, t) => sum + t.value, 0);
  for (const coin of coins) {
    if (totalIn >= totalRequired + 10000) break;
    tx.from({
      address: fromAddress,
      txId: coin.txid,
      outputIndex: coin.vout,
      script: coin.script || Script.fromAddress(fromAddress).toHex(),
      satoshis: coin.value,
    });
    totalIn += coin.value;
  }

  // Add vault outputs for each tranche
  for (const tranche of tranches) {
    const redeemHex = buildRedeemScript(tranche);
    const p2sh = p2shOutputScript(redeemHex);
    redeemScripts.push(redeemHex);
    p2shAddresses.push(p2shAddress(redeemHex));

    tx.addOutput(
      new Transaction.Output({
        script: p2sh,
        satoshis: tranche.value,
      })
    );
  }

  // Single OP_RETURN with all tranche metadata
  // Encode each tranche's metadata and concatenate with length prefixes
  const metadataParts: Buffer[] = [];
  for (const tranche of tranches) {
    const meta = encodeVaultMetadata(tranche);
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(meta.length);
    metadataParts.push(lenBuf);
    metadataParts.push(Buffer.from(meta));
  }
  const allMetadata = Buffer.concat([
    Buffer.from([tranches.length]),
    ...metadataParts,
  ]);

  // Encrypt the combined metadata
  const key = deriveVaultMetadataKey(wif, tranches[0].recipientAddress);
  const nonce = randomBytes(24);
  const { ciphertext } = encryptXChaCha20Poly1305(
    new Uint8Array(allMetadata),
    key,
    nonce
  );
  const payload = Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);

  const opReturnScript = new Script();
  opReturnScript.add(Opcode.OP_RETURN);
  opReturnScript.add(Buffer.from(VAULT_MAGIC_BYTES, "hex"));
  opReturnScript.add(payload);

  tx.addOutput(
    new Transaction.Output({
      script: opReturnScript.toHex(),
      satoshis: 0,
    })
  );

  // Change
  tx.change(fromAddress);
  // @ts-ignore — _estimateSize exists at runtime
  tx.fee(Math.max(20000, Math.ceil(tx._estimateSize() * feeRate)));
  tx.sign(privKey);
  tx.seal();

  const rawTx = tx.toString();
  const txidHex = bytesToHex(
    Buffer.from(sha256(sha256(Buffer.from(rawTx, "hex")))).reverse()
  );

  return { rawTx, txid: txidHex, redeemScripts, p2shAddresses };
}

// ============================================================================
// Vault Claim (Spend)
// ============================================================================

/**
 * Build a transaction to claim (spend) a mature vault UTXO.
 *
 * The spending transaction must:
 * 1. Set nLockTime >= the vault's locktime
 * 2. Set nSequence < 0xFFFFFFFF on the vault input
 * 3. Provide the full redeem script in the scriptSig
 * 4. Satisfy the inner script (sig + pubkey for P2PKH)
 *
 * For NFT/FT vaults, the output must preserve the token (ref in an output).
 */
export function claimVaultTx(
  vaultUtxo: {
    txid: string;
    vout: number;
    value: number;
    redeemScriptHex: string;
  },
  toAddress: string,
  wif: string,
  feeRate: number,
  additionalFundingUtxos?: { txid: string; vout: number; script: string; value: number }[],
  fundingAddress?: string
): { rawTx: string; txid: string } {
  const parsed = parseVaultRedeemScript(vaultUtxo.redeemScriptHex);
  if (!parsed) {
    throw new Error("Invalid vault redeem script");
  }

  const privKey = PrivateKey.fromWIF(wif);
  const pubKey = privKey.toPublicKey();
  const tx = new Transaction();

  // Set nLockTime to the vault's locktime
  // @ts-ignore — nLockTime exists at runtime
  tx.nLockTime = parsed.locktime;

  // Add vault input with P2SH output script
  const p2shScript = p2shOutputScript(vaultUtxo.redeemScriptHex);
  const input = new Transaction.Input({
    prevTxId: vaultUtxo.txid,
    outputIndex: vaultUtxo.vout,
    script: new Script(),
    output: new Transaction.Output({
      script: p2shScript,
      satoshis: vaultUtxo.value,
    }),
  });
  // Set nSequence to enable CLTV
  // @ts-ignore — sequenceNumber is writable at runtime
  input.sequenceNumber = CLTV_SEQUENCE;
  tx.addInput(input);

  // Add additional funding UTXOs if needed (for fees)
  if (additionalFundingUtxos && additionalFundingUtxos.length > 0 && fundingAddress) {
    for (const utxo of additionalFundingUtxos) {
      tx.from({
        address: fundingAddress,
        txId: utxo.txid,
        outputIndex: utxo.vout,
        script: utxo.script,
        satoshis: utxo.value,
      });
    }
  }

  // Build output based on asset type
  let outputScript: string;
  if (parsed.assetType === "nft" && parsed.ref) {
    // NFT: OP_PUSHINPUTREFSINGLETON <ref> OP_DROP P2PKH
    const nftOut = Script.fromASM(
      `OP_PUSHINPUTREFSINGLETON ${parsed.ref} OP_DROP`
    ).add(Script.buildPublicKeyHashOut(toAddress));
    outputScript = nftOut.toHex();
  } else if (parsed.assetType === "ft" && parsed.ref) {
    // FT: P2PKH + FT conservation
    const ftOut = Script.buildPublicKeyHashOut(toAddress).add(
      Script.fromASM(
        `OP_STATESEPARATOR OP_PUSHINPUTREF ${parsed.ref} OP_REFOUTPUTCOUNT_OUTPUTS OP_INPUTINDEX OP_CODESCRIPTBYTECODE_UTXO OP_HASH256 OP_DUP OP_CODESCRIPTHASHVALUESUM_UTXOS OP_OVER OP_CODESCRIPTHASHVALUESUM_OUTPUTS OP_GREATERTHANOREQUAL OP_VERIFY OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS OP_NUMEQUALVERIFY`
      )
    );
    outputScript = ftOut.toHex();
  } else {
    // RXD: plain P2PKH
    outputScript = Script.buildPublicKeyHashOut(toAddress).toHex();
  }

  // Calculate fee
  // Estimate: base tx + P2SH input (~250 bytes for redeem script + sig) + output
  const estimatedSize = 200 + vaultUtxo.redeemScriptHex.length / 2 + 107 + 34;
  const fee = Math.max(20000, Math.ceil(estimatedSize * feeRate));

  const outputValue = vaultUtxo.value - fee;
  if (outputValue <= 0) {
    throw new Error("Vault UTXO value too small to cover fee");
  }

  tx.addOutput(
    new Transaction.Output({
      script: outputScript,
      satoshis: outputValue,
    })
  );

  // If we have additional funding inputs, add change output
  if (additionalFundingUtxos && additionalFundingUtxos.length > 0 && fundingAddress) {
    const totalFunding = additionalFundingUtxos.reduce(
      (sum, u) => sum + u.value,
      0
    );
    // Recalculate: vault output gets full value, fee comes from funding
    // @ts-ignore — satoshis is writable at runtime
    tx.outputs[0].satoshis = vaultUtxo.value;
    const change = totalFunding - fee;
    if (change > 546) {
      // dust threshold
      tx.addOutput(
        new Transaction.Output({
          script: Script.fromAddress(fundingAddress).toHex(),
          satoshis: change,
        })
      );
    }
  }

  // Sign the vault input with custom scriptSig
  // For P2SH: scriptSig = <sig> <pubkey> <serialized-redeem-script>
  const redeemScriptBuf = Buffer.from(vaultUtxo.redeemScriptHex, "hex");
  const sigType =
    crypto.Signature.SIGHASH_ALL | crypto.Signature.SIGHASH_FORKID;

  // Sign using the redeem script as the subscript
  // @ts-ignore — Sighash.sign accepts these args at runtime
  const sig = Transaction.Sighash.sign(
    tx,
    privKey,
    sigType,
    0, // input index for vault
    // @ts-ignore — fromHex exists at runtime
    Script.fromHex(vaultUtxo.redeemScriptHex),
    // @ts-ignore — BN accepts string at runtime
    new crypto.BN(`${vaultUtxo.value}`)
  );

  const scriptSig = Script.empty()
    .add(Buffer.concat([sig.toBuffer(), Buffer.from([sigType])]))
    .add(pubKey.toBuffer())
    .add(redeemScriptBuf);

  // @ts-ignore — setScript exists at runtime
  tx.inputs[0].setScript(scriptSig);

  // Sign any additional funding inputs (standard P2PKH)
  if (additionalFundingUtxos && additionalFundingUtxos.length > 0) {
    for (let i = 1; i < tx.inputs.length; i++) {
      // @ts-ignore — Sighash.sign and input.output exist at runtime
      const fundingSig = Transaction.Sighash.sign(
        tx,
        privKey,
        sigType,
        i,
        // @ts-ignore — input.output exists at runtime
        tx.inputs[i].output.script,
        // @ts-ignore
        new crypto.BN(`${tx.inputs[i].output.satoshis}`)
      );
      const fundingScriptSig = Script.empty()
        .add(
          Buffer.concat([fundingSig.toBuffer(), Buffer.from([sigType])])
        )
        .add(pubKey.toBuffer());
      // @ts-ignore — setScript exists at runtime
      tx.inputs[i].setScript(fundingScriptSig);
    }
  }

  const rawTx = tx.toString();
  const txidHex = bytesToHex(
    Buffer.from(sha256(sha256(Buffer.from(rawTx, "hex")))).reverse()
  );

  return { rawTx, txid: txidHex };
}

// ============================================================================
// Vault Status Helpers
// ============================================================================

/**
 * Check if a vault is unlockable given the current block height and time.
 */
export function isVaultUnlockable(
  locktime: number,
  mode: VaultMode,
  currentBlockHeight: number,
  currentTimestamp: number
): boolean {
  if (mode === "block") {
    return currentBlockHeight >= locktime;
  }
  return currentTimestamp >= locktime;
}

/**
 * Estimate the remaining time or blocks until a vault unlocks.
 */
export function vaultTimeRemaining(
  locktime: number,
  mode: VaultMode,
  currentBlockHeight: number,
  currentTimestamp: number
): { value: number; unit: "blocks" | "seconds" } {
  if (mode === "block") {
    const remaining = locktime - currentBlockHeight;
    return { value: Math.max(0, remaining), unit: "blocks" };
  }
  const remaining = locktime - currentTimestamp;
  return { value: Math.max(0, remaining), unit: "seconds" };
}

/**
 * Format a locktime for display.
 */
export function formatLocktime(locktime: number, mode: VaultMode): string {
  if (mode === "block") {
    return `Block #${locktime.toLocaleString()}`;
  }
  return new Date(locktime * 1000).toLocaleString();
}

// ============================================================================
// Vault Recovery
// ============================================================================

/**
 * Scan a raw transaction hex for vault OP_RETURN outputs.
 * Returns an array of output indices that contain vault magic bytes.
 */
export function findVaultOpReturnOutputs(rawTxHex: string): number[] {
  // @ts-ignore — Transaction.fromString exists at runtime
  const tx = Transaction(rawTxHex);
  const indices: number[] = [];

  for (let i = 0; i < tx.outputs.length; i++) {
    const scriptHex = tx.outputs[i].script.toHex();
    // Check for OP_RETURN + vault magic
    if (scriptHex.startsWith("6a05" + VAULT_MAGIC_BYTES)) {
      indices.push(i);
    }
  }

  return indices;
}

/**
 * Attempt to recover vault records from a raw transaction by decrypting
 * the OP_RETURN metadata with the wallet's private key.
 *
 * This is used during wallet restore from seed. For each vault creation
 * transaction found in history, this function attempts to decrypt the
 * OP_RETURN and reconstruct the full VaultRecord (including redeem script).
 *
 * @param rawTxHex Raw transaction hex
 * @param txid Transaction ID
 * @param wif Wallet's WIF private key (for decryption)
 * @param walletAddress The wallet's P2PKH address
 * @returns Array of recovered vault records (may be empty)
 */
export function recoverVaultsFromTx(
  rawTxHex: string,
  txid: string,
  wif: string,
  walletAddress: string,
  debug = false
): {
  vout: number;
  redeemScriptHex: string;
  p2shScriptHex: string;
  params: VaultParams;
}[] {
  // @ts-ignore — Transaction constructor accepts hex at runtime
  const tx = Transaction(rawTxHex);
  const results: {
    vout: number;
    redeemScriptHex: string;
    p2shScriptHex: string;
    params: VaultParams;
  }[] = [];

  if (debug) {
    console.debug(`[recoverVaults] ${txid}: ${tx.outputs.length} outputs`);
  }

  // Find OP_RETURN outputs with vault magic
  for (let i = 0; i < tx.outputs.length; i++) {
    const scriptHex = tx.outputs[i].script.toHex();

    if (debug) {
      console.debug(`[recoverVaults] ${txid}: output ${i} script starts with: ${scriptHex.slice(0, 20)}...`);
    }

    if (!scriptHex.startsWith("6a05" + VAULT_MAGIC_BYTES)) continue;

    if (debug) {
      console.debug(`[recoverVaults] ${txid}: output ${i} has vault magic bytes!`);
    }

    // Try decrypting with this wallet as sender, using own address as recipient
    const parsed = parseVaultOpReturn(scriptHex, wif, walletAddress);

    if (debug) {
      if (parsed) {
        console.debug(`[recoverVaults] ${txid}: output ${i} decrypted successfully`, parsed);
      } else {
        console.debug(`[recoverVaults] ${txid}: output ${i} decryption FAILED - wrong key?`);
      }
    }

    if (!parsed) continue;

    // Reconstruct the redeem script from decoded metadata
    try {
      // The recipient address can't be fully recovered from just pkh,
      // but we know our wallet address. For self-vaults, the recipient IS us.
      const params: VaultParams = {
        ...parsed,
        recipientAddress: walletAddress,
      };

      const redeemScriptHex = buildRedeemScript(params);
      const p2sh = p2shOutputScript(redeemScriptHex);

      // Verify: check if any non-OP_RETURN output matches this P2SH script
      for (let j = 0; j < tx.outputs.length; j++) {
        if (j === i) continue; // skip OP_RETURN itself
        const outScript = tx.outputs[j].script.toHex();
        if (outScript === p2sh) {
          results.push({
            vout: j,
            redeemScriptHex,
            p2shScriptHex: p2sh,
            params: {
              ...params,
              value: tx.outputs[j].satoshis,
            },
          });
        }
      }
    } catch {
      // Script reconstruction failed — skip
      continue;
    }
  }

  return results;
}
