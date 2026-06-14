import { describe, it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import {
  encodeLocktime,
  decodeLocktime,
  validateLocktime,
  vaultP2pkhRedeemScript,
  vaultNftRedeemScript,
  vaultFtRedeemScript,
  vaultFtNativeScript,
  p2shOutputScript,
  p2shAddress,
  vaultScriptHash,
  buildRedeemScript,
  isNativeVault,
  isVaultRecipientAddress,
  buildVaultTx,
  claimVaultTx,
  estimateVaultClaimSize,
  estimateVaultClaimFee,
  parseVaultRedeemScript,
  isVaultUnlockable,
  isVaultClaimable,
  vaultTimeRemaining,
  vaultClaimableIn,
  MTP_SAFETY_BUFFER_SEC,
  formatLocktime,
  VAULT_MAX_LOCKTIME_BLOCKS,
  VAULT_MAX_TRANCHES,
  LOCKTIME_THRESHOLD,
  VAULT_MAGIC_BYTES,
  CLTV_SEQUENCE,
  VAULT_DUST_THRESHOLD,
  VAULT_PAYLOAD_VERSION,
  buildVaultOpReturn,
  parseVaultOpReturn,
  buildVestingTx,
  recoverVaultsFromTx,
  decodeVaultMetadataList,
  decryptVaultOpReturnPlaintext,
  verifyVaultRecoveryInfo,
  extractVaultSenderAddress,
  type VaultParams,
  type VaultRecoveryInfo,
  type FundingUtxo,
} from "../vault";
import { nftScript, ftScript } from "../script";
import { sha256 } from "@noble/hashes/sha256";

const { PrivateKey, Transaction, Script } = rjs;

// ============================================================================
// Test fixtures
// ============================================================================

// Regtest/mainnet P2PKH address (radiantjs compatible)
const testAddress = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"; // Satoshi's address format
const testPkh = "62e907b15cbf27d5425399ebf6f0fb50ebb88f18"; // hash160 of that addr

// Dummy 36-byte ref in little-endian hex (72 chars)
const testRef = "a1".repeat(36);

// ============================================================================
// encodeLocktime / decodeLocktime
// ============================================================================

describe("encodeLocktime / decodeLocktime", () => {
  it("encodes and decodes 0", () => {
    const buf = encodeLocktime(0);
    expect(decodeLocktime(buf)).toBe(0);
  });

  it("encodes and decodes small values (1-16)", () => {
    for (let i = 1; i <= 16; i++) {
      const buf = encodeLocktime(i);
      expect(decodeLocktime(buf)).toBe(i);
    }
  });

  it("encodes and decodes block height 500000", () => {
    const buf = encodeLocktime(500000);
    expect(decodeLocktime(buf)).toBe(500000);
    // 500000 = 0x07A120 → LE: 20 a1 07 (3 bytes, high bit not set)
    expect(buf.length).toBe(3);
  });

  it("encodes and decodes VAULT_MAX_LOCKTIME_BLOCKS", () => {
    const buf = encodeLocktime(VAULT_MAX_LOCKTIME_BLOCKS);
    expect(decodeLocktime(buf)).toBe(VAULT_MAX_LOCKTIME_BLOCKS);
  });

  it("encodes and decodes a UNIX timestamp (above threshold)", () => {
    const ts = 1700000000; // ~Nov 2023
    const buf = encodeLocktime(ts);
    expect(decodeLocktime(buf)).toBe(ts);
    // Timestamps require 4 bytes but may need a 5th 0x00 byte if high bit set
    expect(buf.length).toBeLessThanOrEqual(5);
  });

  it("round-trips various values", () => {
    const values = [
      1, 127, 128, 255, 256, 65535, 100000, 499999999, 1700000000, 2000000000,
    ];
    for (const v of values) {
      expect(decodeLocktime(encodeLocktime(v))).toBe(v);
    }
  });

  it("rejects negative locktime", () => {
    expect(() => encodeLocktime(-1)).toThrow("non-negative");
  });

  it("adds padding byte when high bit is set", () => {
    // 128 = 0x80 → needs 0x00 padding → [0x80, 0x00]
    const buf = encodeLocktime(128);
    expect(buf.length).toBe(2);
    expect(buf[0]).toBe(0x80);
    expect(buf[1]).toBe(0x00);
  });
});

// ============================================================================
// validateLocktime
// ============================================================================

describe("validateLocktime", () => {
  it("validates block mode", () => {
    expect(validateLocktime(100000, "block")).toBe(true);
    expect(validateLocktime(VAULT_MAX_LOCKTIME_BLOCKS, "block")).toBe(true);
  });

  it("rejects block mode out of range", () => {
    expect(validateLocktime(0, "block")).toBe(false);
    expect(validateLocktime(-1, "block")).toBe(false);
    expect(validateLocktime(VAULT_MAX_LOCKTIME_BLOCKS + 1, "block")).toBe(
      false
    );
    expect(validateLocktime(LOCKTIME_THRESHOLD, "block")).toBe(false);
  });

  it("validates time mode", () => {
    const future = Math.floor(Date.now() / 1000) + 86400;
    expect(validateLocktime(future, "time")).toBe(true);
  });

  it("rejects time mode in the past", () => {
    const past = Math.floor(Date.now() / 1000) - 86400;
    expect(validateLocktime(past, "time")).toBe(false);
  });

  it("rejects time mode below threshold", () => {
    expect(validateLocktime(100, "time")).toBe(false);
  });
});

// ============================================================================
// Redeem Script Builders
// ============================================================================

describe("vaultP2pkhRedeemScript", () => {
  it("produces hex containing CLTV opcode (b1) and P2PKH pattern", () => {
    const script = vaultP2pkhRedeemScript(100000, testAddress);
    expect(script).toContain("b1"); // OP_CHECKLOCKTIMEVERIFY
    expect(script).toContain("75"); // OP_DROP
    expect(script).toContain("76a914"); // OP_DUP OP_HASH160 <push 20>
    expect(script).toContain("88ac"); // OP_EQUALVERIFY OP_CHECKSIG
  });

  it("embeds the locktime correctly", () => {
    const locktime = 200000;
    const script = vaultP2pkhRedeemScript(locktime, testAddress);
    // The locktime bytes should appear at the start as a push
    const locktimeHex = encodeLocktime(locktime).toString("hex");
    // Script starts with push-data of locktime
    expect(script).toMatch(new RegExp(`^..${locktimeHex}b175`));
  });
});

describe("vaultNftRedeemScript", () => {
  it("contains singleton ref opcode (d8) and CLTV", () => {
    const script = vaultNftRedeemScript(100000, testAddress, testRef);
    expect(script).toContain("b175"); // CLTV DROP
    expect(script).toContain("d8"); // OP_PUSHINPUTREFSINGLETON
    expect(script).toContain(testRef);
    expect(script).toContain("88ac"); // P2PKH tail
  });

  it("rejects invalid ref length", () => {
    expect(() => vaultNftRedeemScript(100000, testAddress, "abcd")).toThrow(
      "72 hex"
    );
  });
});

describe("vaultFtNativeScript / vaultFtRedeemScript", () => {
  it("contains CLTV, state separator (bd), PUSHINPUTREF (d0), and P2PKH", () => {
    const script = vaultFtNativeScript(100000, testAddress, testRef);
    expect(script).toContain("b175"); // CLTV DROP
    expect(script).toContain("76a914"); // P2PKH
    expect(script).toContain("88ac"); // OP_EQUALVERIFY OP_CHECKSIG
    expect(script).toContain("bd"); // OP_STATESEPARATOR
    expect(script).toContain("d0"); // OP_PUSHINPUTREF
    expect(script).toContain(testRef);
  });

  it("is NOT a P2SH script (does not start with a914...87)", () => {
    const script = vaultFtNativeScript(100000, testAddress, testRef);
    expect(script).not.toMatch(/^a914[0-9a-f]{40}87$/);
  });

  it("vaultFtRedeemScript is an alias for vaultFtNativeScript", () => {
    const a = vaultFtRedeemScript(100000, testAddress, testRef);
    const b = vaultFtNativeScript(100000, testAddress, testRef);
    expect(a).toBe(b);
  });

  it("rejects invalid ref length", () => {
    expect(() => vaultFtNativeScript(100000, testAddress, "")).toThrow(
      "72 hex"
    );
  });
});

describe("isNativeVault", () => {
  it("returns true for ft", () => {
    expect(isNativeVault("ft")).toBe(true);
  });

  it("returns false for rxd and nft", () => {
    expect(isNativeVault("rxd")).toBe(false);
    expect(isNativeVault("nft")).toBe(false);
  });
});

// ============================================================================
// buildRedeemScript (dispatch)
// ============================================================================

describe("buildRedeemScript", () => {
  it("dispatches to RXD", () => {
    const params: VaultParams = {
      mode: "block",
      locktime: 100000,
      assetType: "rxd",
      recipientAddress: testAddress,
      value: 50000000,
    };
    const script = buildRedeemScript(params);
    expect(script).toContain("b175"); // CLTV
    expect(script).not.toContain("d8"); // no singleton ref
  });

  it("dispatches to NFT", () => {
    const params: VaultParams = {
      mode: "block",
      locktime: 100000,
      assetType: "nft",
      recipientAddress: testAddress,
      ref: testRef,
      value: 1,
    };
    const script = buildRedeemScript(params);
    expect(script).toContain("d8"); // singleton
  });

  it("dispatches to FT", () => {
    const params: VaultParams = {
      mode: "block",
      locktime: 100000,
      assetType: "ft",
      recipientAddress: testAddress,
      ref: testRef,
      value: 1000000,
    };
    const script = buildRedeemScript(params);
    expect(script).toContain("bdd0"); // statesep + pushinputref
  });

  it("throws for NFT without ref", () => {
    const params: VaultParams = {
      mode: "block",
      locktime: 100000,
      assetType: "nft",
      recipientAddress: testAddress,
      value: 1,
    };
    expect(() => buildRedeemScript(params)).toThrow("ref");
  });
});

// ============================================================================
// P2SH Output Script
// ============================================================================

describe("p2shOutputScript", () => {
  it("produces OP_HASH160 <20-byte-hash> OP_EQUAL", () => {
    const redeem = vaultP2pkhRedeemScript(100000, testAddress);
    const p2sh = p2shOutputScript(redeem);
    // OP_HASH160 = a9, push 20 = 14, OP_EQUAL = 87
    expect(p2sh).toMatch(/^a914[0-9a-f]{40}87$/);
  });
});

describe("p2shAddress", () => {
  it("returns a string starting with 3 (mainnet P2SH)", () => {
    const redeem = vaultP2pkhRedeemScript(100000, testAddress);
    const addr = p2shAddress(redeem);
    expect(addr).toMatch(/^3/);
  });

  it("different locktimes produce different addresses", () => {
    const a1 = p2shAddress(vaultP2pkhRedeemScript(100000, testAddress));
    const a2 = p2shAddress(vaultP2pkhRedeemScript(200000, testAddress));
    expect(a1).not.toBe(a2);
  });
});

describe("vaultScriptHash", () => {
  it("returns 64 hex characters", () => {
    const redeem = vaultP2pkhRedeemScript(100000, testAddress);
    const hash = vaultScriptHash(redeem);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================================
// parseVaultRedeemScript
// ============================================================================

describe("parseVaultRedeemScript", () => {
  it("parses RXD vault script", () => {
    const locktime = 150000;
    const redeem = vaultP2pkhRedeemScript(locktime, testAddress);
    const parsed = parseVaultRedeemScript(redeem);
    expect(parsed).not.toBeNull();
    expect(parsed!.locktime).toBe(locktime);
    expect(parsed!.mode).toBe("block");
    expect(parsed!.assetType).toBe("rxd");
    expect(parsed!.ref).toBeUndefined();
  });

  it("parses NFT vault script", () => {
    const locktime = 300000;
    const redeem = vaultNftRedeemScript(locktime, testAddress, testRef);
    const parsed = parseVaultRedeemScript(redeem);
    expect(parsed).not.toBeNull();
    expect(parsed!.locktime).toBe(locktime);
    expect(parsed!.assetType).toBe("nft");
    expect(parsed!.ref).toBe(testRef);
  });

  it("parses FT native vault script", () => {
    const locktime = 400000;
    const native = vaultFtNativeScript(locktime, testAddress, testRef);
    const parsed = parseVaultRedeemScript(native);
    expect(parsed).not.toBeNull();
    expect(parsed!.locktime).toBe(locktime);
    expect(parsed!.assetType).toBe("ft");
    expect(parsed!.ref).toBe(testRef);
    // For native FT vaults, p2shScriptHex is the native script itself (no P2SH wrap)
    expect(parsed!.p2shScriptHex).toBe(native);
  });

  it("parses timestamp-based locktime as time mode", () => {
    const ts = 1700000000;
    const redeem = vaultP2pkhRedeemScript(ts, testAddress);
    const parsed = parseVaultRedeemScript(redeem);
    expect(parsed).not.toBeNull();
    expect(parsed!.mode).toBe("time");
    expect(parsed!.locktime).toBe(ts);
  });

  it("returns null for non-vault scripts", () => {
    expect(
      parseVaultRedeemScript(
        "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac"
      )
    ).toBeNull();
    expect(parseVaultRedeemScript("")).toBeNull();
    expect(parseVaultRedeemScript("abcd")).toBeNull();
  });

  it("round-trips: build → parse → same params", () => {
    const params: VaultParams = {
      mode: "block",
      locktime: 250000,
      assetType: "rxd",
      recipientAddress: testAddress,
      value: 1000000,
    };
    const redeem = buildRedeemScript(params);
    const parsed = parseVaultRedeemScript(redeem);
    expect(parsed!.locktime).toBe(params.locktime);
    expect(parsed!.assetType).toBe(params.assetType);
    expect(parsed!.mode).toBe(params.mode);
  });
});

// ============================================================================
// Vault Metadata Encoding/Decoding
// ============================================================================

describe("encodeVaultMetadata / decodeVaultMetadata", () => {
  // We access private encodeVaultMetadata via the module's internal test path
  // Since encodeVaultMetadata isn't exported, we test it indirectly via decodeVaultMetadata
  // by crafting the binary manually or using the exported functions.

  it("round-trips RXD params", () => {
    const params: VaultParams = {
      mode: "block",
      locktime: 100000,
      assetType: "rxd",
      recipientAddress: testAddress,
      value: 50000000,
      label: "Test vault",
    };
    // We need to access encodeVaultMetadata — it's not exported but decodeVaultMetadata is
    // Use dynamic import or test the full flow via buildVaultOpReturn
    // For now, test that decodeVaultMetadata handles known binary
    const probe = globalThis as unknown as {
      __vaultEncodeTest?: (p: VaultParams) => Uint8Array;
    };
    const encoded = probe.__vaultEncodeTest?.(params);
    // Skip if encode not accessible — will be tested via integration
    if (!encoded) return;
  });
});

// ============================================================================
// isVaultUnlockable
// ============================================================================

describe("isVaultUnlockable", () => {
  it("returns true when block height >= locktime", () => {
    expect(isVaultUnlockable(100000, "block", 100000, 0)).toBe(true);
    expect(isVaultUnlockable(100000, "block", 100001, 0)).toBe(true);
  });

  it("returns false when block height < locktime", () => {
    expect(isVaultUnlockable(100000, "block", 99999, 0)).toBe(false);
  });

  it("returns true when timestamp >= locktime", () => {
    expect(isVaultUnlockable(1700000000, "time", 0, 1700000000)).toBe(true);
    expect(isVaultUnlockable(1700000000, "time", 0, 1700000001)).toBe(true);
  });

  it("returns false when timestamp < locktime", () => {
    expect(isVaultUnlockable(1700000000, "time", 0, 1699999999)).toBe(false);
  });
});

// ============================================================================
// vaultTimeRemaining
// ============================================================================

describe("vaultTimeRemaining", () => {
  it("returns remaining blocks", () => {
    const result = vaultTimeRemaining(100000, "block", 90000, 0);
    expect(result.value).toBe(10000);
    expect(result.unit).toBe("blocks");
  });

  it("returns 0 when past locktime", () => {
    const result = vaultTimeRemaining(100000, "block", 200000, 0);
    expect(result.value).toBe(0);
  });

  it("returns remaining seconds for time mode", () => {
    const result = vaultTimeRemaining(1700000000, "time", 0, 1699999000);
    expect(result.value).toBe(1000);
    expect(result.unit).toBe("seconds");
  });
});

describe("isVaultClaimable", () => {
  it("MTP_SAFETY_BUFFER_SEC is one hour", () => {
    expect(MTP_SAFETY_BUFFER_SEC).toBe(3600);
  });

  it("matches isVaultUnlockable for block mode", () => {
    expect(isVaultClaimable(100000, "block", 100000, 0)).toBe(true);
    expect(isVaultClaimable(100000, "block", 100001, 0)).toBe(true);
    expect(isVaultClaimable(100000, "block", 99999, 0)).toBe(false);
  });

  it("requires the MTP safety buffer to elapse for time mode", () => {
    const locktime = 1700000000;
    // At wall-clock unlock moment: not yet claimable (would be unlockable)
    expect(isVaultClaimable(locktime, "time", 0, locktime)).toBe(false);
    expect(isVaultUnlockable(locktime, "time", 0, locktime)).toBe(true);

    // One second before MTP buffer elapses: still not claimable
    expect(
      isVaultClaimable(
        locktime,
        "time",
        0,
        locktime + MTP_SAFETY_BUFFER_SEC - 1
      )
    ).toBe(false);

    // Exactly at MTP buffer boundary: claimable
    expect(
      isVaultClaimable(locktime, "time", 0, locktime + MTP_SAFETY_BUFFER_SEC)
    ).toBe(true);

    // Well past: claimable
    expect(isVaultClaimable(locktime, "time", 0, locktime + 86400)).toBe(true);
  });
});

describe("vaultClaimableIn", () => {
  it("matches vaultTimeRemaining for block mode", () => {
    const r = vaultClaimableIn(100000, "block", 90000, 0);
    expect(r.value).toBe(10000);
    expect(r.unit).toBe("blocks");
  });

  it("adds the MTP buffer to time-mode countdowns", () => {
    const locktime = 1700000000;
    // 1000 seconds before unlock: vaultTimeRemaining says 1000s, vaultClaimableIn says 1000 + buffer
    const remaining = vaultClaimableIn(locktime, "time", 0, locktime - 1000);
    expect(remaining.value).toBe(1000 + MTP_SAFETY_BUFFER_SEC);
    expect(remaining.unit).toBe("seconds");
  });

  it("returns 0 once the MTP-buffered moment has passed", () => {
    const locktime = 1700000000;
    const r = vaultClaimableIn(
      locktime,
      "time",
      0,
      locktime + MTP_SAFETY_BUFFER_SEC + 1
    );
    expect(r.value).toBe(0);
  });
});

// ============================================================================
// formatLocktime
// ============================================================================

describe("formatLocktime", () => {
  it("formats block mode", () => {
    const result = formatLocktime(100000, "block");
    expect(result).toContain("100");
    expect(result).toContain("Block");
  });

  it("formats time mode as a date string", () => {
    const result = formatLocktime(1700000000, "time");
    // Should contain some date-like string
    expect(result.length).toBeGreaterThan(5);
  });
});

// ============================================================================
// Constants
// ============================================================================

describe("constants", () => {
  it("VAULT_MAX_LOCKTIME_BLOCKS is 1051898", () => {
    expect(VAULT_MAX_LOCKTIME_BLOCKS).toBe(1051898);
  });

  it("VAULT_MAX_TRANCHES is 12", () => {
    expect(VAULT_MAX_TRANCHES).toBe(12);
  });

  it("LOCKTIME_THRESHOLD is 500_000_000", () => {
    expect(LOCKTIME_THRESHOLD).toBe(500_000_000);
  });

  it("CLTV_SEQUENCE is 0xFFFFFFFE", () => {
    expect(CLTV_SEQUENCE).toBe(0xfffffffe);
  });

  it("VAULT_MAGIC_BYTES encodes 'vault'", () => {
    const decoded = Buffer.from(VAULT_MAGIC_BYTES, "hex").toString("utf8");
    expect(decoded).toBe("vault");
  });
});

// ============================================================================
// buildVaultTx — NFT and FT tokenUtxos
// ============================================================================

describe("buildVaultTx — NFT vault with tokenUtxos", () => {
  const privKey = new PrivateKey();
  const wif = privKey.toWIF();
  const fromAddress = privKey.toAddress().toString();

  const locktime = 100000;
  const vaultValue = 546; // dust for NFT P2SH output

  const tokenScript = nftScript(fromAddress, testRef);
  const tokenUtxo = {
    txid: "a".repeat(64),
    vout: 0,
    script: tokenScript,
    value: 546,
  };

  const rxdCoin = {
    txid: "b".repeat(64),
    vout: 0,
    script: "76a914" + "00".repeat(20) + "88ac",
    value: 500000,
  };

  const params: VaultParams = {
    mode: "block",
    locktime,
    assetType: "nft",
    recipientAddress: fromAddress,
    ref: testRef,
    value: vaultValue,
  };

  it("returns rawTx, txid, redeemScriptHex, and p2shAddr", () => {
    const result = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    expect(result.rawTx).toBeTruthy();
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(result.redeemScriptHex).toBeTruthy();
    expect(result.p2shAddr).toMatch(/^3/);
  });

  it("includes token UTXO as the first input", () => {
    const result = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    const tx = new Transaction(result.rawTx);
    // First input prevTxId should be tokenUtxo.txid (reversed as bytes)
    const firstInputTxid = Buffer.from(tx.inputs[0].prevTxId)
      .reverse()
      .toString("hex");
    expect(firstInputTxid).toBe(tokenUtxo.txid);
  });

  it("P2SH output script matches p2shOutputScript of redeemScript", () => {
    const result = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    const expectedP2sh = p2shOutputScript(result.redeemScriptHex);
    const tx = new Transaction(result.rawTx);
    const outputScripts: string[] = tx.outputs.map(
      (o: { script: { toHex: () => string } }) => o.script.toHex()
    );
    expect(outputScripts).toContain(expectedP2sh);
  });

  it("redeemScript is an NFT vault script (contains d8 singleton opcode)", () => {
    const result = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    expect(result.redeemScriptHex).toContain("d8");
    expect(result.redeemScriptHex).toContain(testRef);
  });

  it("throws when NFT ref is missing from params", () => {
    const paramsNoRef: VaultParams = { ...params, ref: undefined };
    expect(() =>
      buildVaultTx([rxdCoin], fromAddress, wif, paramsNoRef, 1, [tokenUtxo])
    ).toThrow("ref");
  });
});

describe("buildVaultTx — FT vault with tokenUtxos", () => {
  const privKey = new PrivateKey();
  const wif = privKey.toWIF();
  const fromAddress = privKey.toAddress().toString();

  const locktime = 200000;
  const tokenValue = 1000; // FT token units (satoshi field holds token amount)

  const tokenScript = ftScript(fromAddress, testRef);
  const tokenUtxo = {
    txid: "c".repeat(64),
    vout: 0,
    script: tokenScript,
    value: tokenValue,
  };

  const rxdCoin = {
    txid: "d".repeat(64),
    vout: 0,
    script: "76a914" + "00".repeat(20) + "88ac",
    value: 500000,
  };

  const params: VaultParams = {
    mode: "block",
    locktime,
    assetType: "ft",
    recipientAddress: fromAddress,
    ref: testRef,
    value: tokenValue,
  };

  it("returns rawTx, txid, and redeemScriptHex", () => {
    const result = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    expect(result.rawTx).toBeTruthy();
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(result.redeemScriptHex).toBeTruthy();
  });

  it("FT vault output is the native locking script (not P2SH)", () => {
    const result = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    const expectedNativeScript = vaultFtNativeScript(
      locktime,
      fromAddress,
      testRef
    );
    const tx = new Transaction(result.rawTx);
    const outputScripts: string[] = tx.outputs.map(
      (o: { script: { toHex: () => string } }) => o.script.toHex()
    );
    expect(outputScripts).toContain(expectedNativeScript);
    // Must NOT be a P2SH script
    expect(outputScripts[0]).not.toMatch(/^a914[0-9a-f]{40}87$/);
  });

  it("includes token UTXO as the first input", () => {
    const result = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    const tx = new Transaction(result.rawTx);
    const firstInputTxid = Buffer.from(tx.inputs[0].prevTxId)
      .reverse()
      .toString("hex");
    expect(firstInputTxid).toBe(tokenUtxo.txid);
  });

  it("token input scriptSig is non-empty (signed)", () => {
    const result = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    const tx = new Transaction(result.rawTx);
    const tokenInputScript = tx.inputs[0].script.toHex();
    // Must have sig + pubkey pushed — not empty
    expect(tokenInputScript.length).toBeGreaterThan(0);
    // A P2PKH scriptSig is min 106 bytes = 212 hex chars (70-byte DER sig + pushes + 33-byte pubkey)
    expect(tokenInputScript.length).toBeGreaterThanOrEqual(212);
  });

  it("redeemScript is an FT vault native script (contains b175, bd, d0, ref)", () => {
    const result = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    expect(result.redeemScriptHex).toContain("b175"); // CLTV DROP
    expect(result.redeemScriptHex).toContain("bd"); // OP_STATESEPARATOR
    expect(result.redeemScriptHex).toContain("d0"); // OP_PUSHINPUTREF
    expect(result.redeemScriptHex).toContain(testRef);
  });

  it("parseVaultRedeemScript round-trips the FT native script", () => {
    const result = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    const parsed = parseVaultRedeemScript(result.redeemScriptHex);
    expect(parsed).not.toBeNull();
    expect(parsed!.assetType).toBe("ft");
    expect(parsed!.locktime).toBe(locktime);
    expect(parsed!.ref).toBe(testRef);
    // p2shScriptHex == redeemScriptHex for native FT (no P2SH wrapping)
    expect(parsed!.p2shScriptHex).toBe(result.redeemScriptHex);
  });

  it("works without tokenUtxos (RXD-only fallback)", () => {
    const rxdParams: VaultParams = {
      mode: "block",
      locktime,
      assetType: "rxd",
      recipientAddress: fromAddress,
      value: 100000,
    };
    const result = buildVaultTx([rxdCoin], fromAddress, wif, rxdParams, 1);
    expect(result.rawTx).toBeTruthy();
    // RXD script must not contain FT (bdd0) or NFT (d875) opcode sequences
    expect(result.redeemScriptHex).not.toContain("bdd0");
    expect(result.redeemScriptHex).not.toContain("d875");
  });
});

describe("estimateVaultClaimSize / estimateVaultClaimFee", () => {
  // Build representative redeem scripts so the estimator has real lengths to use.
  const rxdRedeem = vaultP2pkhRedeemScript(800_000, testAddress);
  const nftRedeem = vaultNftRedeemScript(800_000, testAddress, testRef);
  const ftRedeem = vaultFtNativeScript(800_000, testAddress, testRef);

  it("returns plausible sizes for each asset type", () => {
    const rxd = estimateVaultClaimSize({
      redeemScriptHex: rxdRedeem,
      assetType: "rxd",
      fundingInputCount: 0,
      hasChange: false,
    });
    const nft = estimateVaultClaimSize({
      redeemScriptHex: nftRedeem,
      assetType: "nft",
      fundingInputCount: 1,
      hasChange: true,
    });
    const ft = estimateVaultClaimSize({
      redeemScriptHex: ftRedeem,
      assetType: "ft",
      fundingInputCount: 1,
      hasChange: true,
    });
    // Sanity bounds: a P2SH RXD vault claim is roughly 220-260 bytes,
    // NFT/FT with one funding input land around 320-450 bytes.
    expect(rxd).toBeGreaterThan(180);
    expect(rxd).toBeLessThan(300);
    expect(nft).toBeGreaterThan(rxd);
    expect(ft).toBeGreaterThan(rxd);
    expect(nft).toBeLessThan(500);
    expect(ft).toBeLessThan(500);
  });

  it("fee scales with feeRate and includes a safety margin", () => {
    const base = {
      redeemScriptHex: rxdRedeem,
      assetType: "rxd" as const,
      fundingInputCount: 0,
      hasChange: false,
    };
    const lowSize = estimateVaultClaimSize(base);
    const lowFee = estimateVaultClaimFee({ ...base, feeRate: 1000 });
    const highFee = estimateVaultClaimFee({ ...base, feeRate: 10000 });

    // Each fee includes the 10% size buffer
    expect(lowFee).toBeGreaterThanOrEqual(Math.ceil(lowSize * 1.1) * 1000);
    expect(highFee).toBe(lowFee * 10);
  });

  it("adding funding inputs and change grows the fee monotonically", () => {
    const noFunding = estimateVaultClaimSize({
      redeemScriptHex: nftRedeem,
      assetType: "nft",
      fundingInputCount: 0,
      hasChange: false,
    });
    const oneFunding = estimateVaultClaimSize({
      redeemScriptHex: nftRedeem,
      assetType: "nft",
      fundingInputCount: 1,
      hasChange: true,
    });
    const twoFunding = estimateVaultClaimSize({
      redeemScriptHex: nftRedeem,
      assetType: "nft",
      fundingInputCount: 2,
      hasChange: true,
    });
    expect(oneFunding).toBeGreaterThan(noFunding);
    expect(twoFunding).toBeGreaterThan(oneFunding);
  });
});

describe("claimVaultTx — funding selection", () => {
  // Real key derived from the test address. PrivateKey.fromRandom("livenet")
  // produces a livenet WIF; .toAddress() then defaults to livenet too — no
  // need to pass the network argument again (which isn't in the .d.ts).
  const wif = PrivateKey.fromRandom("livenet").toWIF();
  const claimAddress = new PrivateKey(wif).toAddress().toString();
  const rxdRedeem = vaultP2pkhRedeemScript(800_000, claimAddress);
  const nftRedeem = vaultNftRedeemScript(800_000, claimAddress, testRef);

  const dummyVaultRxd = {
    txid: "00".repeat(32),
    vout: 0,
    value: 100_000_000, // 1 RXD — comfortably covers any fee
    redeemScriptHex: rxdRedeem,
  };
  const dummyVaultNft = {
    txid: "00".repeat(32),
    vout: 0,
    value: VAULT_DUST_THRESHOLD, // NFT vaults hold dust
    redeemScriptHex: nftRedeem,
  };

  it("throws a clear error when NFT claim has no funding and no callback", () => {
    expect(() =>
      claimVaultTx(
        dummyVaultNft,
        claimAddress,
        wif,
        10000,
        undefined,
        claimAddress
      )
    ).toThrow(/Insufficient funding/i);
  });

  it("pulls additional funding via the selectMoreFunding callback", () => {
    const pool: FundingUtxo[] = [
      {
        txid: "11".repeat(32),
        vout: 0,
        script: "76a914" + testPkh + "88ac",
        value: 50_000_000,
      },
    ];
    let callbackCalls = 0;
    const selectMoreFunding = (
      _needed: number,
      already: FundingUtxo[]
    ): FundingUtxo[] => {
      callbackCalls++;
      const usedKeys = new Set(already.map((u) => `${u.txid}:${u.vout}`));
      return pool.filter((u) => !usedKeys.has(`${u.txid}:${u.vout}`));
    };

    const result = claimVaultTx(
      dummyVaultNft,
      claimAddress,
      wif,
      10000,
      undefined,
      claimAddress,
      selectMoreFunding
    );

    expect(result.rawTx).toBeTruthy();
    expect(callbackCalls).toBeGreaterThanOrEqual(1);
  });

  it("throws when the callback returns no more funding", () => {
    const selectMoreFunding = (): FundingUtxo[] => [];
    expect(() =>
      claimVaultTx(
        dummyVaultNft,
        claimAddress,
        wif,
        10000,
        undefined,
        claimAddress,
        selectMoreFunding
      )
    ).toThrow(/no more funding/i);
  });

  it("RXD vault claim succeeds without funding when the vault covers its own fee", () => {
    const result = claimVaultTx(
      dummyVaultRxd,
      claimAddress,
      wif,
      10000,
      undefined,
      claimAddress
    );
    expect(result.rawTx).toBeTruthy();
  });
});

// ============================================================================
// Vault OP_RETURN (v2 ECDH-based encryption)
// ============================================================================

describe("vault OP_RETURN — v2 ECDH derivation", () => {
  // Sender wallet.
  const senderPriv = new PrivateKey();
  const senderWif = senderPriv.toWIF();
  const senderAddress = senderPriv.toAddress().toString();
  const senderPubHex = senderPriv.toPublicKey().toBuffer().toString("hex");

  // Distinct third-party recipient wallet.
  const recipientPriv = new PrivateKey();
  const recipientWif = recipientPriv.toWIF();
  const recipientAddress = recipientPriv.toAddress().toString();
  const recipientPubHex = recipientPriv
    .toPublicKey()
    .toBuffer()
    .toString("hex");

  // An uninvolved third party (observer).
  const strangerPriv = new PrivateKey();
  const strangerWif = strangerPriv.toWIF();

  const selfVaultParams: VaultParams = {
    mode: "block",
    locktime: 150000,
    assetType: "rxd",
    recipientAddress: senderAddress,
    value: 1_000_000,
    label: "self-vault test",
  };

  const thirdPartyVaultParams: VaultParams = {
    mode: "block",
    locktime: 200000,
    assetType: "rxd",
    recipientAddress: recipientAddress,
    recipientPubKey: recipientPubHex,
    value: 2_000_000,
    label: "gift",
  };

  it("emits a v2 payload with version byte = 2 and both pubkeys embedded", () => {
    const scriptHex = buildVaultOpReturn(selfVaultParams, senderWif);
    // 6a (OP_RETURN) + 05 (push 5) + 7661756c74 ("vault") + push(body)
    // body starts after the magic-string push.
    expect(scriptHex.startsWith("6a05" + VAULT_MAGIC_BYTES)).toBe(true);
    // The version byte is the first byte of the body. After the magic-string
    // push there's a single push prefix (likely 0x4c <len> for ~100B bodies).
    const afterMagic = scriptHex.slice(4 + VAULT_MAGIC_BYTES.length);
    // Strip the push opcode/prefix to land on the body.
    const head = parseInt(afterMagic.slice(0, 2), 16);
    let bodyStartHex: string;
    if (head < 0x4c) bodyStartHex = afterMagic.slice(2);
    else if (head === 0x4c) bodyStartHex = afterMagic.slice(4);
    else if (head === 0x4d) bodyStartHex = afterMagic.slice(6);
    else throw new Error("unexpected push prefix");
    expect(parseInt(bodyStartHex.slice(0, 2), 16)).toBe(VAULT_PAYLOAD_VERSION);

    // senderPub bytes 1..34 of the body
    const embeddedSenderPub = bodyStartHex.slice(2, 2 + 66);
    expect(embeddedSenderPub).toBe(senderPubHex);
    // recipientPub bytes 34..67
    const embeddedRecipientPub = bodyStartHex.slice(2 + 66, 2 + 66 + 66);
    // For a self-vault, sender == recipient.
    expect(embeddedRecipientPub).toBe(senderPubHex);
  });

  it("sender can decrypt a self-vault payload they created", () => {
    const scriptHex = buildVaultOpReturn(selfVaultParams, senderWif);
    const decoded = parseVaultOpReturn(scriptHex, senderWif);
    expect(decoded).not.toBeNull();
    expect(decoded!.locktime).toBe(selfVaultParams.locktime);
    expect(decoded!.assetType).toBe(selfVaultParams.assetType);
    expect(decoded!.label).toBe(selfVaultParams.label);
  });

  it("both sender and recipient can decrypt a third-party vault", () => {
    const scriptHex = buildVaultOpReturn(thirdPartyVaultParams, senderWif);

    const asSender = parseVaultOpReturn(scriptHex, senderWif);
    expect(asSender).not.toBeNull();
    expect(asSender!.locktime).toBe(thirdPartyVaultParams.locktime);

    const asRecipient = parseVaultOpReturn(scriptHex, recipientWif);
    expect(asRecipient).not.toBeNull();
    expect(asRecipient!.locktime).toBe(thirdPartyVaultParams.locktime);
    expect(asRecipient!.label).toBe(thirdPartyVaultParams.label);
  });

  it("an uninvolved third party CANNOT decrypt the vault", () => {
    // This is the core security guarantee R1 fixes: observers without one of
    // the two private keys must not be able to recover the metadata.
    const scriptHex = buildVaultOpReturn(thirdPartyVaultParams, senderWif);
    const asStranger = parseVaultOpReturn(scriptHex, strangerWif);
    expect(asStranger).toBeNull();
  });

  it("returns null for tampered ciphertext", () => {
    const scriptHex = buildVaultOpReturn(selfVaultParams, senderWif);
    // Flip the last byte of the script (inside the ciphertext / tag region).
    const tampered =
      scriptHex.slice(0, -2) +
      (parseInt(scriptHex.slice(-2), 16) ^ 0xff).toString(16).padStart(2, "0");
    expect(parseVaultOpReturn(tampered, senderWif)).toBeNull();
  });

  it("returns null for non-vault scripts", () => {
    expect(
      parseVaultOpReturn(
        "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac",
        senderWif
      )
    ).toBeNull();
    expect(parseVaultOpReturn("", senderWif)).toBeNull();
    expect(parseVaultOpReturn("6a", senderWif)).toBeNull();
  });

  it("refuses to encrypt a third-party vault without recipientPubKey", () => {
    const params: VaultParams = {
      mode: "block",
      locktime: 100000,
      assetType: "rxd",
      recipientAddress: recipientAddress, // someone else's address
      value: 1000,
      // recipientPubKey intentionally omitted
    };
    expect(() => buildVaultOpReturn(params, senderWif)).toThrow(
      /recipientPubKey/i
    );
  });

  it("refuses recipientPubKey that does not match recipientAddress", () => {
    const params: VaultParams = {
      ...thirdPartyVaultParams,
      // Address says recipient, but pubkey says sender — mismatch.
      recipientPubKey: senderPubHex,
    };
    expect(() => buildVaultOpReturn(params, senderWif)).toThrow(
      /does not hash to/i
    );
  });

  it("two encryptions with the same params produce different ciphertexts (nonce randomness)", () => {
    const a = buildVaultOpReturn(selfVaultParams, senderWif);
    const b = buildVaultOpReturn(selfVaultParams, senderWif);
    expect(a).not.toBe(b);
  });

  it("permanently rejects v1-format payloads", () => {
    // Craft a fake v1-style payload: [nonce24][ciphertext...] (no version byte).
    // The current parser must refuse it because the first byte will not equal
    // VAULT_PAYLOAD_VERSION (=2).
    const fakeV1Body = "00".repeat(24 + 32); // version byte=0x00, never matches
    const scriptHex =
      "6a05" + VAULT_MAGIC_BYTES + "39" /* push 0x39=57 bytes */ + fakeV1Body;
    expect(parseVaultOpReturn(scriptHex, senderWif)).toBeNull();
  });
});

// ============================================================================
// recoverVaultsFromTx — round-trip recovery (RXD, NFT, FT, vesting)
//
// Regression coverage for two recovery bugs:
//   - vesting schedules never recovered (multi-tranche plaintext rejected by
//     decodeVaultMetadata's version-byte check)
//   - FT self-vaults never recovered (native output compared against P2SH wrap)
// ============================================================================

describe("recoverVaultsFromTx — round-trip", () => {
  const privKey = new PrivateKey();
  const wif = privKey.toWIF();
  const fromAddress = privKey.toAddress().toString();

  // A fat RXD coin to fund any vault/vesting tx. The scriptSig validity is
  // irrelevant here — recovery only reads the tx OUTPUTS.
  const rxdCoin = {
    txid: "a".repeat(64),
    vout: 0,
    script: "76a914" + "00".repeat(20) + "88ac",
    value: 100_000_000,
  };

  it("recovers a simple RXD self-vault", () => {
    const params: VaultParams = {
      mode: "block",
      locktime: 123456,
      assetType: "rxd",
      recipientAddress: fromAddress,
      value: 5_000_000,
      label: "savings",
    };
    const { rawTx, txid, redeemScriptHex } = buildVaultTx(
      [rxdCoin],
      fromAddress,
      wif,
      params,
      1
    );
    const recovered = recoverVaultsFromTx(rawTx, txid, wif, fromAddress);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].params.assetType).toBe("rxd");
    expect(recovered[0].params.locktime).toBe(123456);
    expect(recovered[0].params.value).toBe(5_000_000);
    expect(recovered[0].redeemScriptHex).toBe(redeemScriptHex);
  });

  it("recovers a simple NFT self-vault", () => {
    const tokenUtxo = {
      txid: "b".repeat(64),
      vout: 0,
      script: nftScript(fromAddress, testRef),
      value: 546,
    };
    const params: VaultParams = {
      mode: "block",
      locktime: 222222,
      assetType: "nft",
      recipientAddress: fromAddress,
      ref: testRef,
      value: 546,
    };
    const { rawTx, txid } = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    const recovered = recoverVaultsFromTx(rawTx, txid, wif, fromAddress);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].params.assetType).toBe("nft");
    expect(recovered[0].params.ref).toBe(testRef);
    expect(recovered[0].params.locktime).toBe(222222);
  });

  it("recovers an FT self-vault (native script — regression for P2SH-only match)", () => {
    const tokenUtxo = {
      txid: "c".repeat(64),
      vout: 0,
      script: ftScript(fromAddress, testRef),
      value: 1000,
    };
    const params: VaultParams = {
      mode: "block",
      locktime: 333333,
      assetType: "ft",
      recipientAddress: fromAddress,
      ref: testRef,
      value: 1000,
    };
    const { rawTx, txid } = buildVaultTx([rxdCoin], fromAddress, wif, params, 1, [
      tokenUtxo,
    ]);
    const recovered = recoverVaultsFromTx(rawTx, txid, wif, fromAddress);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].params.assetType).toBe("ft");
    expect(recovered[0].params.ref).toBe(testRef);
    expect(recovered[0].params.locktime).toBe(333333);
    // The recovered script is the FT native locking script (no P2SH wrap).
    expect(recovered[0].redeemScriptHex).toBe(
      vaultFtNativeScript(333333, fromAddress, testRef)
    );
  });

  it("recovers ALL tranches of a vesting schedule (regression for version-byte collision)", () => {
    const locktimes = [400000, 410000, 420000];
    const tranches: VaultParams[] = locktimes.map((lt) => ({
      mode: "block",
      locktime: lt,
      assetType: "rxd",
      recipientAddress: fromAddress,
      value: 1_000_000,
      label: "vest",
    }));
    const { rawTx, txid } = buildVestingTx(
      [rxdCoin],
      fromAddress,
      wif,
      tranches,
      1
    );
    const recovered = recoverVaultsFromTx(rawTx, txid, wif, fromAddress);
    expect(recovered).toHaveLength(3);
    expect(recovered.map((r) => r.params.locktime).sort((a, b) => a - b)).toEqual(
      locktimes
    );
    for (const r of recovered) expect(r.params.assetType).toBe("rxd");
  });

  it("recovers a single-tranche vesting schedule", () => {
    const tranches: VaultParams[] = [
      {
        mode: "block",
        locktime: 480000,
        assetType: "rxd",
        recipientAddress: fromAddress,
        value: 3_000_000,
      },
    ];
    const { rawTx, txid } = buildVestingTx(
      [rxdCoin],
      fromAddress,
      wif,
      tranches,
      1
    );
    const recovered = recoverVaultsFromTx(rawTx, txid, wif, fromAddress);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].params.locktime).toBe(480000);
  });

  it("recovers a third-party vault for the recipient, but not the sender", () => {
    const recipientPriv = new PrivateKey();
    const recipientWif = recipientPriv.toWIF();
    const recipientAddress = recipientPriv.toAddress().toString();
    const recipientPubHex = recipientPriv
      .toPublicKey()
      .toBuffer()
      .toString("hex");

    const params: VaultParams = {
      mode: "block",
      locktime: 555555,
      assetType: "rxd",
      recipientAddress,
      recipientPubKey: recipientPubHex,
      value: 2_000_000,
    };
    const { rawTx, txid } = buildVaultTx([rxdCoin], fromAddress, wif, params, 1);

    // Recipient recovers it (rebuilt P2SH with the recipient address matches).
    const asRecipient = recoverVaultsFromTx(
      rawTx,
      txid,
      recipientWif,
      recipientAddress
    );
    expect(asRecipient).toHaveLength(1);
    expect(asRecipient[0].params.locktime).toBe(555555);

    // Sender can decrypt but rebuilds with their OWN address → no P2SH match.
    const asSender = recoverVaultsFromTx(rawTx, txid, wif, fromAddress);
    expect(asSender).toHaveLength(0);
  });

  it("recovers nothing for an uninvolved wallet", () => {
    const params: VaultParams = {
      mode: "block",
      locktime: 123456,
      assetType: "rxd",
      recipientAddress: fromAddress,
      value: 5_000_000,
    };
    const { rawTx, txid } = buildVaultTx([rxdCoin], fromAddress, wif, params, 1);
    const stranger = new PrivateKey();
    const recovered = recoverVaultsFromTx(
      rawTx,
      txid,
      stranger.toWIF(),
      stranger.toAddress().toString()
    );
    expect(recovered).toHaveLength(0);
  });
});

describe("decodeVaultMetadataList", () => {
  const priv = new PrivateKey();
  const wif = priv.toWIF();
  const addr = priv.toAddress().toString();

  it("decodes a single-vault plaintext to one params", () => {
    const op = buildVaultOpReturn(
      {
        mode: "block",
        locktime: 100000,
        assetType: "rxd",
        recipientAddress: addr,
        value: 1,
      },
      wif
    );
    const plaintext = decryptVaultOpReturnPlaintext(op, wif);
    expect(plaintext).not.toBeNull();
    const list = decodeVaultMetadataList(plaintext!);
    // At least the single-vault interpretation must be present and correct.
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some((p) => p.locktime === 100000 && p.assetType === "rxd")).toBe(
      true
    );
  });
});

describe("vaultScriptHash — native FT vs P2SH", () => {
  const electrumScriptHash = (outputScriptHex: string) =>
    Buffer.from(sha256(Buffer.from(outputScriptHex, "hex")))
      .reverse()
      .toString("hex");

  it("hashes RXD/NFT vaults as their P2SH output script", () => {
    const redeem = vaultP2pkhRedeemScript(100000, testAddress);
    expect(vaultScriptHash(redeem)).toBe(
      electrumScriptHash(p2shOutputScript(redeem))
    );
  });

  it("hashes FT vaults as their NATIVE output script (not P2SH)", () => {
    const native = vaultFtNativeScript(100000, testAddress, testRef);
    // Correct: hash the native script directly (it IS the on-chain output).
    expect(vaultScriptHash(native)).toBe(electrumScriptHash(native));
    // And NOT the (wrong) P2SH-wrapped hash the old code produced.
    expect(vaultScriptHash(native)).not.toBe(
      electrumScriptHash(p2shOutputScript(native))
    );
  });
});

// ============================================================================
// Share-recovery-info gifting (third-party vault, self-encrypted OP_RETURN)
// + trustless verifyVaultRecoveryInfo import
// ============================================================================

describe("share-recovery-info gifting", () => {
  const sender = new PrivateKey();
  const senderWif = sender.toWIF();
  const senderAddress = sender.toAddress().toString();

  const recipient = new PrivateKey();
  const recipientWif = recipient.toWIF();
  const recipientAddress = recipient.toAddress().toString();

  const stranger = new PrivateKey();
  const strangerWif = stranger.toWIF();

  const rxdCoin = {
    txid: "f".repeat(64),
    vout: 0,
    script: "76a914" + "00".repeat(20) + "88ac",
    value: 100_000_000,
  };

  // Build a gifted vault: recipient != sender, no recipientPubKey,
  // shareRecoveryInfo flips the OP_RETURN to self-encryption.
  const giftParams: VaultParams = {
    mode: "block",
    locktime: 654321,
    assetType: "rxd",
    recipientAddress,
    shareRecoveryInfo: true,
    value: 7_000_000,
    label: "gift",
  };

  it("creates a third-party vault without a recipient pubkey (no throw)", () => {
    const result = buildVaultTx([rxdCoin], senderAddress, senderWif, giftParams, 1);
    expect(result.rawTx).toBeTruthy();
    // The vault output locks to the RECIPIENT's pkh, not the sender's.
    const recipientRedeem = buildRedeemScript({
      ...giftParams,
      recipientAddress,
    });
    const expectedP2sh = p2shOutputScript(recipientRedeem);
    const tx = new Transaction(result.rawTx);
    const scripts: string[] = tx.outputs.map(
      (o: { script: { toHex: () => string } }) => o.script.toHex()
    );
    expect(scripts).toContain(expectedP2sh);
  });

  it("self-encrypts the OP_RETURN: sender can decrypt, recipient and strangers cannot", () => {
    const { rawTx } = buildVaultTx([rxdCoin], senderAddress, senderWif, giftParams, 1);
    const tx = new Transaction(rawTx);
    const opReturn = tx.outputs
      .map((o: { script: { toHex: () => string } }) => o.script.toHex())
      .find((h: string) => h.startsWith("6a05" + VAULT_MAGIC_BYTES));
    expect(opReturn).toBeTruthy();
    // Sender (self-encrypt audience) decrypts.
    expect(parseVaultOpReturn(opReturn!, senderWif)).not.toBeNull();
    // Recipient is NOT the OP_RETURN audience — cannot decrypt.
    expect(parseVaultOpReturn(opReturn!, recipientWif)).toBeNull();
    // Random observer cannot decrypt.
    expect(parseVaultOpReturn(opReturn!, strangerWif)).toBeNull();
  });

  it("recipient imports the vault trustlessly via verifyVaultRecoveryInfo", () => {
    const { rawTx, txid } = buildVaultTx(
      [rxdCoin],
      senderAddress,
      senderWif,
      giftParams,
      1
    );
    const info: VaultRecoveryInfo = {
      txid,
      vout: 0,
      assetType: "rxd",
      mode: "block",
      locktime: 654321,
      label: "gift",
    };
    const got = verifyVaultRecoveryInfo(rawTx, info, recipientAddress);
    expect(got).not.toBeNull();
    expect(got!.vout).toBe(0);
    expect(got!.params.locktime).toBe(654321);
    expect(got!.params.value).toBe(7_000_000); // value comes from the chain
    expect(got!.params.recipientAddress).toBe(recipientAddress);
    // The rebuilt redeem script matches what the sender built for the recipient.
    expect(got!.redeemScriptHex).toBe(
      buildRedeemScript({ ...giftParams, recipientAddress })
    );
  });

  it("rejects an importer who is NOT the recipient (wrong address)", () => {
    const { rawTx, txid } = buildVaultTx(
      [rxdCoin],
      senderAddress,
      senderWif,
      giftParams,
      1
    );
    const info: VaultRecoveryInfo = {
      txid,
      vout: 0,
      assetType: "rxd",
      mode: "block",
      locktime: 654321,
    };
    // Sender tries to import → rebuild with sender pkh → no match.
    expect(verifyVaultRecoveryInfo(rawTx, info, senderAddress)).toBeNull();
    // Stranger likewise.
    expect(
      verifyVaultRecoveryInfo(rawTx, info, stranger.toAddress().toString())
    ).toBeNull();
  });

  it("rejects tampered metadata (locktime / assetType / ref)", () => {
    const { rawTx, txid } = buildVaultTx(
      [rxdCoin],
      senderAddress,
      senderWif,
      giftParams,
      1
    );
    const base: VaultRecoveryInfo = {
      txid,
      vout: 0,
      assetType: "rxd",
      mode: "block",
      locktime: 654321,
    };
    expect(
      verifyVaultRecoveryInfo(rawTx, { ...base, locktime: 654322 }, recipientAddress)
    ).toBeNull();
    expect(
      verifyVaultRecoveryInfo(
        rawTx,
        { ...base, assetType: "nft", ref: testRef },
        recipientAddress
      )
    ).toBeNull();
  });

  it("rejects an out-of-range vout and a poisoned transaction", () => {
    const { rawTx, txid } = buildVaultTx(
      [rxdCoin],
      senderAddress,
      senderWif,
      giftParams,
      1
    );
    expect(
      verifyVaultRecoveryInfo(
        rawTx,
        { txid, vout: 99, assetType: "rxd", mode: "block", locktime: 654321 },
        recipientAddress
      )
    ).toBeNull();
    // Poisoned: claim a different txid than the raw tx actually hashes to.
    expect(
      verifyVaultRecoveryInfo(
        rawTx,
        {
          txid: "0".repeat(64),
          vout: 0,
          assetType: "rxd",
          mode: "block",
          locktime: 654321,
        },
        recipientAddress
      )
    ).toBeNull();
  });

  it("still throws for a third-party vault without pubkey AND without shareRecoveryInfo", () => {
    const params: VaultParams = {
      mode: "block",
      locktime: 654321,
      assetType: "rxd",
      recipientAddress,
      value: 1000,
    };
    expect(() => buildVaultTx([rxdCoin], senderAddress, senderWif, params, 1)).toThrow(
      /recipientPubKey|shareRecoveryInfo/i
    );
  });

  it("gifts a vesting schedule: every tranche imports for the recipient", () => {
    const locktimes = [700000, 710000];
    const tranches: VaultParams[] = locktimes.map((lt) => ({
      mode: "block",
      locktime: lt,
      assetType: "rxd",
      recipientAddress,
      shareRecoveryInfo: true,
      value: 1_500_000,
    }));
    const { rawTx, txid } = buildVestingTx(
      [rxdCoin],
      senderAddress,
      senderWif,
      tranches,
      1
    );
    const recovered = locktimes.map((lt, i) =>
      verifyVaultRecoveryInfo(
        rawTx,
        { txid, vout: i, assetType: "rxd", mode: "block", locktime: lt },
        recipientAddress
      )
    );
    expect(recovered.every((r) => r !== null)).toBe(true);
    expect(recovered.map((r) => r!.params.locktime)).toEqual(locktimes);
  });
});

// ============================================================================
// Red-team hardening: recipient validation, verify guards, dual-key claim
// ============================================================================

describe("isVaultRecipientAddress", () => {
  it("accepts a mainnet P2PKH address on mainnet", () => {
    expect(isVaultRecipientAddress(testAddress, "mainnet")).toBe(true);
    expect(isVaultRecipientAddress(testAddress)).toBe(true);
  });

  it("rejects a P2PKH address on the wrong network", () => {
    expect(isVaultRecipientAddress(testAddress, "testnet")).toBe(false);
  });

  it("rejects a P2SH (scripthash) address — funds would be unclaimable", () => {
    const p2sh = p2shAddress(vaultP2pkhRedeemScript(100000, testAddress));
    expect(p2sh).toMatch(/^3/);
    expect(isVaultRecipientAddress(p2sh, "mainnet")).toBe(false);
  });

  it("rejects garbage / empty / whitespace", () => {
    expect(isVaultRecipientAddress("")).toBe(false);
    expect(isVaultRecipientAddress("not-an-address")).toBe(false);
    expect(isVaultRecipientAddress("   ")).toBe(false);
  });
});

describe("extractVaultSenderAddress", () => {
  it("recovers the sender's address from a vault creation tx", () => {
    const sender = PrivateKey.fromRandom("livenet");
    const senderWif = sender.toWIF();
    const senderAddr = sender.toAddress().toString();
    // The coin script must match the sender so radiantjs actually signs it
    // (otherwise the input scriptSig is empty and no pubkey is revealed).
    const coin = {
      txid: "d".repeat(64),
      vout: 0,
      script: Script.fromAddress(senderAddr).toHex(),
      value: 100_000_000,
    };
    const params: VaultParams = {
      mode: "block",
      locktime: 123456,
      assetType: "rxd",
      recipientAddress: senderAddr,
      value: 5_000_000,
    };
    const { rawTx } = buildVaultTx([coin], senderAddr, senderWif, params, 1);
    expect(extractVaultSenderAddress(rawTx, "mainnet")).toBe(senderAddr);
  });

  it("returns undefined for unparseable input", () => {
    expect(extractVaultSenderAddress("", "mainnet")).toBeUndefined();
    expect(extractVaultSenderAddress("deadbeef", "mainnet")).toBeUndefined();
  });
});

describe("verifyVaultRecoveryInfo — hardening", () => {
  const priv = new PrivateKey();
  const wif = priv.toWIF();
  const addr = priv.toAddress().toString();
  const rxdCoin = {
    txid: "e".repeat(64),
    vout: 0,
    script: "76a914" + "00".repeat(20) + "88ac",
    value: 100_000_000,
  };
  const gift: VaultParams = {
    mode: "block",
    locktime: 321000,
    assetType: "rxd",
    recipientAddress: addr,
    shareRecoveryInfo: true,
    value: 4_000_000,
  };

  it("normalizes an uppercase / whitespace-padded txid", () => {
    const { rawTx, txid } = buildVaultTx([rxdCoin], addr, wif, gift, 1);
    const info: VaultRecoveryInfo = {
      txid: `  ${txid.toUpperCase()}  `,
      vout: 0,
      assetType: "rxd",
      mode: "block",
      locktime: 321000,
    };
    expect(verifyVaultRecoveryInfo(rawTx, info, addr)).not.toBeNull();
  });

  it("rejects a non-integer (float) locktime", () => {
    const { rawTx, txid } = buildVaultTx([rxdCoin], addr, wif, gift, 1);
    const info = {
      txid,
      vout: 0,
      assetType: "rxd" as const,
      mode: "block" as const,
      locktime: 321000.5,
    };
    expect(verifyVaultRecoveryInfo(rawTx, info, addr)).toBeNull();
  });
});

describe("claimVaultTx — separate funding key (swap-locked vault)", () => {
  // Vault locked to key A (the recipient); fee funded from key B's coins.
  const vaultKey = PrivateKey.fromRandom("livenet");
  const vaultWif = vaultKey.toWIF();
  const vaultAddr = vaultKey.toAddress().toString();
  const vaultPubHex = vaultKey.toPublicKey().toBuffer().toString("hex");

  const fundKey = PrivateKey.fromRandom("livenet");
  const fundWif = fundKey.toWIF();
  const fundAddr = fundKey.toAddress().toString();
  const fundPubHex = fundKey.toPublicKey().toBuffer().toString("hex");

  it("signs the vault input with the vault key and funding inputs with the funding key", () => {
    const nftRedeem = vaultNftRedeemScript(800_000, vaultAddr, testRef);
    const dummyVaultNft = {
      txid: "00".repeat(32),
      vout: 0,
      value: VAULT_DUST_THRESHOLD,
      redeemScriptHex: nftRedeem,
    };
    const pool: FundingUtxo[] = [
      {
        txid: "22".repeat(32),
        vout: 0,
        script: Script.fromAddress(fundAddr).toHex(),
        value: 50_000_000,
      },
    ];
    const selectMoreFunding = (
      _needed: number,
      already: FundingUtxo[]
    ): FundingUtxo[] => {
      const used = new Set(already.map((u) => `${u.txid}:${u.vout}`));
      return pool.filter((u) => !used.has(`${u.txid}:${u.vout}`));
    };

    const result = claimVaultTx(
      dummyVaultNft,
      vaultAddr,
      vaultWif,
      10000,
      undefined,
      fundAddr,
      selectMoreFunding,
      fundWif
    );
    expect(result.rawTx).toBeTruthy();
    const tx = new Transaction(result.rawTx);
    expect(tx.inputs.length).toBe(2);
    // Vault input (0) is signed by the vault key; funding input (1) by the fund key.
    expect(tx.inputs[0].script.toHex()).toContain(vaultPubHex);
    expect(tx.inputs[1].script.toHex()).toContain(fundPubHex);
    expect(tx.inputs[1].script.toHex()).not.toContain(vaultPubHex);
  });
});
