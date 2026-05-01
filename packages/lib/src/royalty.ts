/**
 * Glyph v2 On-Chain Royalty Enforcement
 * Reference: Glyph v2 Token Standard Section 13 and REP-3012
 */

import rjs from "@radiant-core/radiantjs";
import { Buffer } from "buffer";
import { GlyphV2Royalty } from "./v2metadata";
import { nftScript, p2pkhScript } from "./script";
import { pushMinimal } from "./script";

const { Script, Opcode } = rjs;

// Radiant introspection opcodes (hex values)
const OP_OUTPUTVALUE_HEX = "cc";      // 0xcc - pushes output value by index
const OP_OUTPUTBYTECODE_HEX = "cd";   // 0xcd - pushes output script by index

/**
 * Build P2PKH script hex for a given address
 * Returns the full script: 76a914<hash160>88ac
 */
function buildP2pkhScriptHex(address: string): string {
  return p2pkhScript(address);
}

/**
 * Create royalty-enforced NFT script
 * Enforces royalty payments at the script level using Radiant introspection opcodes
 * 
 * Script structure for royalty enforcement:
 * - Output 0: NFT to buyer (new owner)
 * - Output 1: Seller payment (used to calculate sale price)
 * - Output 2: Royalty payment (single recipient) OR Output 2+N for splits
 * 
 * Uses OP_OUTPUTVALUE and OP_OUTPUTBYTECODE for on-chain validation
 */
export function nftRoyaltyScript(
  address: string,
  ref: string,
  royalty: GlyphV2Royalty
): string {
  if (!royalty.enforced) {
    // Non-enforced royalties use standard NFT script
    return nftScript(address, ref);
  }

  // Build base script with singleton ref
  const script = Script.fromASM(
    `OP_PUSHINPUTREFSINGLETON ${ref} OP_DROP`
  );

  // Add state separator for script validation section
  script.add(Opcode.OP_STATESEPARATOR);

  // Get sale price from output 1 (seller payment)
  // This is the basis for royalty calculation
  const bpsPush = pushMinimal(royalty.bps);
  const minimumPush = royalty.minimum ? pushMinimal(royalty.minimum) : null;

  if (royalty.splits && royalty.splits.length > 0) {
    // Multiple royalty recipients - validate each split
    // Each split's share is calculated as: (sale_price * split.bps / 10000)
    royalty.splits.forEach((split, index) => {
      const outputIndex = 2 + index;
      const splitBpsPush = pushMinimal(split.bps);
      const expectedScriptHex = buildP2pkhScriptHex(split.address);

      // Royalty validation for this split:
      // 1. Verify output pays to correct address (script matches)
      // 2. Verify output value >= (sale_price * split.bps / 10000)
      
      // Push output index and get its bytecode: <idx> OP_OUTPUTBYTECODE
      script.add(Script.fromHex(pushMinimal(outputIndex) + OP_OUTPUTBYTECODE_HEX));
      // Push expected script as data for comparison
      script.add(Buffer.from(expectedScriptHex, "hex"));
      // Verify they match
      script.add(Opcode.OP_EQUAL);
      script.add(Opcode.OP_VERIFY);
      
      // Verify output value >= calculated share
      // Stack: calculate share from output 1 value, compare with output N value
      script.add(Script.fromHex(
        pushMinimal(outputIndex) + OP_OUTPUTVALUE_HEX +      // Get royalty output value
        "51" + OP_OUTPUTVALUE_HEX +                           // OP_1 OP_OUTPUTVALUE (get sale price)
        splitBpsPush + "95" + "03" + "1027" + "96" +           // OP_MUL 10000 OP_DIV
        "a2" + "69"                                            // OP_GREATERTHANOREQUAL OP_VERIFY
      ));
    });
  } else {
    // Single royalty recipient
    const expectedScriptHex = buildP2pkhScriptHex(royalty.address);

    // Build validation with optional minimum
    if (minimumPush) {
      // With minimum: max(raw_royalty, minimum)
      // Calculate royalty: sale_price * bps / 10000
      script.add(Script.fromHex(
        "51" + OP_OUTPUTVALUE_HEX +      // OP_1 OP_OUTPUTVALUE (get sale price)
        bpsPush + "95" +                 // OP_MUL
        "03" + "1027" + "96" +          // 10000 OP_DIV
        "76" + minimumPush + "9f" +     // OP_DUP <min> OP_LESSTHAN
        "63" + "75" + minimumPush + "68" // OP_IF OP_DROP <min> OP_ENDIF
      ));
      
      // Verify royalty output value >= calculated amount
      script.add(Script.fromHex(
        "52" + OP_OUTPUTVALUE_HEX +      // OP_2 OP_OUTPUTVALUE
        "a2" + "69"                      // OP_GREATERTHANOREQUAL OP_VERIFY
      ));
      
      // Verify recipient script matches: OP_2 OP_OUTPUTBYTECODE <script> OP_EQUAL OP_VERIFY
      script.add(Script.fromHex("52" + OP_OUTPUTBYTECODE_HEX));
      script.add(Buffer.from(expectedScriptHex, "hex"));
      script.add(Opcode.OP_EQUAL);
      script.add(Opcode.OP_VERIFY);
    } else {
      // Without minimum
      // First verify recipient: OP_2 OP_OUTPUTBYTECODE <script> OP_EQUAL OP_VERIFY
      script.add(Script.fromHex("52" + OP_OUTPUTBYTECODE_HEX));
      script.add(Buffer.from(expectedScriptHex, "hex"));
      script.add(Opcode.OP_EQUAL);
      script.add(Opcode.OP_VERIFY);
      
      // Then verify amount
      script.add(Script.fromHex(
        "52" + OP_OUTPUTVALUE_HEX +      // OP_2 OP_OUTPUTVALUE (get royalty value)
        "51" + OP_OUTPUTVALUE_HEX +      // OP_1 OP_OUTPUTVALUE (get sale price)
        bpsPush + "95" +                 // OP_MUL
        "03" + "1027" + "96" +          // 10000 OP_DIV
        "a2" + "69"                      // OP_GREATERTHANOREQUAL OP_VERIFY
      ));
    }
  }

  // Add P2PKH spending condition for the NFT itself
  script.add(Script.buildPublicKeyHashOut(address));

  return script.toHex();
}

/**
 * Calculate expected royalty outputs for a transaction
 * Returns the outputs that should be added to satisfy royalty requirements
 */
export function buildRoyaltyOutputs(
  salePrice: number,
  royalty: GlyphV2Royalty,
  recipientScripts: string[]  // Pre-built P2PKH scripts for each recipient
): Array<{ script: string; satoshis: number }> {
  if (!royalty.enforced) {
    return []; // No required outputs for advisory royalties
  }

  const outputs: Array<{ script: string; satoshis: number }> = [];

  if (royalty.splits && royalty.splits.length > 0) {
    // Multiple recipients
    royalty.splits.forEach((split, index) => {
      const shareAmount = Math.floor((salePrice * split.bps) / 10000);
      outputs.push({
        script: recipientScripts[index],
        satoshis: shareAmount
      });
    });
  } else {
    // Single recipient
    const royaltyAmount = calculateRoyalty(salePrice, royalty);
    outputs.push({
      script: recipientScripts[0],
      satoshis: royaltyAmount
    });
  }

  return outputs;
}

/**
 * Calculate royalty amount
 */
export function calculateRoyalty(
  salePrice: number,
  royalty: GlyphV2Royalty
): number {
  const royaltyAmount = Math.floor((salePrice * royalty.bps) / 10000);
  
  if (royalty.minimum && royaltyAmount < royalty.minimum) {
    return royalty.minimum;
  }

  return royaltyAmount;
}

/**
 * Validate royalty payment in transaction
 */
export function validateRoyaltyPayment(
  tx: rjs.Transaction,
  royalty: GlyphV2Royalty,
  salePrice: number
): { valid: boolean; error?: string } {
  if (!royalty.enforced) {
    return { valid: true }; // Non-enforced royalties are advisory
  }

  const requiredRoyalty = calculateRoyalty(salePrice, royalty);

  if (royalty.splits && royalty.splits.length > 0) {
    // Validate split payments
    for (let i = 0; i < royalty.splits.length; i++) {
      const split = royalty.splits[i];
      const outputIndex = 2 + i;

      if (outputIndex >= tx.outputs.length) {
        return { valid: false, error: `Missing royalty output ${outputIndex}` };
      }

      const output = tx.outputs[outputIndex];
      const expectedAmount = Math.floor((salePrice * split.bps) / 10000);

      if (output.satoshis < expectedAmount) {
        return {
          valid: false,
          error: `Royalty payment ${i} insufficient: ${output.satoshis} < ${expectedAmount}`,
        };
      }

      // Validate recipient address
      const outputAddress = output.script.toAddress()?.toString();
      if (outputAddress !== split.address) {
        return {
          valid: false,
          error: `Royalty recipient ${i} mismatch: ${outputAddress} != ${split.address}`,
        };
      }
    }
  } else {
    // Validate single royalty payment
    if (tx.outputs.length < 3) {
      return { valid: false, error: "Missing royalty output" };
    }

    const royaltyOutput = tx.outputs[2];

    if (royaltyOutput.satoshis < requiredRoyalty) {
      return {
        valid: false,
        error: `Royalty payment insufficient: ${royaltyOutput.satoshis} < ${requiredRoyalty}`,
      };
    }

    // Validate recipient address
    const outputAddress = royaltyOutput.script.toAddress()?.toString();
    if (outputAddress !== royalty.address) {
      return {
        valid: false,
        error: `Royalty recipient mismatch: ${outputAddress} != ${royalty.address}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Check if a transaction output satisfies royalty requirements
 * Used for both on-chain validation and off-chain pre-flight checks
 */
export function checkRoyaltyCompliance(
  outputs: Array<{ script: string; satoshis: number }>,
  royalty: GlyphV2Royalty,
  salePrice: number
): { compliant: boolean; missingOutputs?: string[]; insufficientPayments?: string[] } {
  if (!royalty.enforced) {
    return { compliant: true };
  }

  const missing: string[] = [];
  const insufficient: string[] = [];

  if (royalty.splits && royalty.splits.length > 0) {
    royalty.splits.forEach((split, index) => {
      const outputIndex = 2 + index;
      const expectedAmount = Math.floor((salePrice * split.bps) / 10000);

      if (outputIndex >= outputs.length) {
        missing.push(`Output ${outputIndex} for ${split.address}`);
      } else if (outputs[outputIndex].satoshis < expectedAmount) {
        insufficient.push(
          `Output ${outputIndex}: ${outputs[outputIndex].satoshis} < ${expectedAmount}`
        );
      }
    });
  } else {
    const requiredAmount = calculateRoyalty(salePrice, royalty);
    
    if (outputs.length < 3) {
      missing.push(`Royalty output at index 2 for ${royalty.address}`);
    } else if (outputs[2].satoshis < requiredAmount) {
      insufficient.push(
        `Royalty output: ${outputs[2].satoshis} < ${requiredAmount}`
      );
    }
  }

  return {
    compliant: missing.length === 0 && insufficient.length === 0,
    missingOutputs: missing.length > 0 ? missing : undefined,
    insufficientPayments: insufficient.length > 0 ? insufficient : undefined,
  };
}

/**
 * Create royalty metadata
 */
export function createRoyalty(
  address: string,
  basisPoints: number,
  enforced: boolean = false,
  options?: {
    minimum?: number;
    splits?: Array<{ address: string; bps: number }>;
  }
): GlyphV2Royalty {
  if (basisPoints < 0 || basisPoints > 10000) {
    throw new Error("Basis points must be between 0 and 10000");
  }

  const royalty: GlyphV2Royalty = {
    enforced,
    bps: basisPoints,
    address,
  };

  if (options?.minimum) {
    royalty.minimum = options.minimum;
  }

  if (options?.splits) {
    // Validate splits sum to total bps
    const totalSplitBps = options.splits.reduce((sum, s) => sum + s.bps, 0);
    if (totalSplitBps !== basisPoints) {
      throw new Error(`Split basis points (${totalSplitBps}) must equal total (${basisPoints})`);
    }
    royalty.splits = options.splits;
  }

  return royalty;
}
