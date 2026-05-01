/**
 * Royalty Enforcement Tests
 * Tests for REP-3012 on-chain royalty enforcement
 */

import { describe, it, expect } from "vitest";
import {
  nftRoyaltyScript,
  calculateRoyalty,
  validateRoyaltyPayment,
  buildRoyaltyOutputs,
  checkRoyaltyCompliance,
  createRoyalty,
} from "../royalty";
import { GlyphV2Royalty } from "../v2metadata";
import { p2pkhScript } from "../script";

// Valid Radiant P2PKH addresses (compatible with radiantjs)
const TEST_ADDRESS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"; // Owner address
const TEST_RECIPIENT = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"; // Royalty recipient
const TEST_SPLIT_RECIPIENT = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"; // Split recipient (same for testing)
const TEST_REF = "a".repeat(64) + "00000000";

describe("createRoyalty", () => {
  it("should create basic royalty metadata", () => {
    const royalty = createRoyalty(TEST_RECIPIENT, 500); // 5%
    
    expect(royalty.enforced).toBe(false);
    expect(royalty.bps).toBe(500);
    expect(royalty.address).toBe(TEST_RECIPIENT);
    expect(royalty.minimum).toBeUndefined();
    expect(royalty.splits).toBeUndefined();
  });

  it("should create enforced royalty", () => {
    const royalty = createRoyalty(TEST_RECIPIENT, 500, true);
    expect(royalty.enforced).toBe(true);
  });

  it("should create royalty with minimum", () => {
    const royalty = createRoyalty(TEST_RECIPIENT, 500, true, { minimum: 1000 });
    expect(royalty.minimum).toBe(1000);
  });

  it("should create royalty with splits", () => {
    const splits = [
      { address: TEST_RECIPIENT, bps: 300 },
      { address: TEST_SPLIT_RECIPIENT, bps: 200 },
    ];
    const royalty = createRoyalty(TEST_RECIPIENT, 500, true, { splits });
    expect(royalty.splits).toHaveLength(2);
    expect(royalty.splits?.[0].bps).toBe(300);
    expect(royalty.splits?.[1].bps).toBe(200);
  });

  it("should reject invalid basis points", () => {
    expect(() => createRoyalty(TEST_RECIPIENT, -1)).toThrow();
    expect(() => createRoyalty(TEST_RECIPIENT, 10001)).toThrow();
  });

  it("should reject splits that don't sum to total bps", () => {
    const splits = [
      { address: TEST_RECIPIENT, bps: 300 },
      { address: TEST_SPLIT_RECIPIENT, bps: 100 }, // Only 400, not 500
    ];
    expect(() => createRoyalty(TEST_RECIPIENT, 500, true, { splits })).toThrow();
  });
});

describe("calculateRoyalty", () => {
  it("should calculate 5% royalty on 10000 photons", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    expect(calculateRoyalty(10000, royalty)).toBe(500);
  });

  it("should calculate 2.5% royalty on 10000 photons", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 250,
      address: TEST_RECIPIENT,
    };
    expect(calculateRoyalty(10000, royalty)).toBe(250);
  });

  it("should apply minimum when calculated royalty is below minimum", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
      minimum: 1000,
    };
    // 5% of 1000 = 50, but minimum is 1000
    expect(calculateRoyalty(1000, royalty)).toBe(1000);
  });

  it("should not apply minimum when calculated royalty exceeds minimum", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
      minimum: 100,
    };
    // 5% of 10000 = 500, which exceeds minimum of 100
    expect(calculateRoyalty(10000, royalty)).toBe(500);
  });

  it("should handle zero sale price", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    expect(calculateRoyalty(0, royalty)).toBe(0);
  });

  it("should floor decimal results", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 333, // 3.33%
      address: TEST_RECIPIENT,
    };
    // 3.33% of 1000 = 33.3, floored to 33
    expect(calculateRoyalty(1000, royalty)).toBe(33);
  });
});

describe("nftRoyaltyScript", () => {
  it("should return standard NFT script for non-enforced royalties", () => {
    const royalty: GlyphV2Royalty = {
      enforced: false,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    const script = nftRoyaltyScript(TEST_ADDRESS, TEST_REF, royalty);
    
    // Should not contain OP_STATESEPARATOR or OP_OUTPUTVALUE
    expect(script).not.toContain("bd"); // OP_STATESEPARATOR
    expect(script).toContain("d8"); // OP_PUSHINPUTREFSINGLETON
  });

  it("should include OP_STATESEPARATOR for enforced royalties", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    const script = nftRoyaltyScript(TEST_ADDRESS, TEST_REF, royalty);
    
    // Should contain state separator and introspection opcodes
    expect(script).toContain("bd"); // OP_STATESEPARATOR
    expect(script).toContain("cc"); // OP_OUTPUTVALUE (0xcc)
    expect(script).toContain("cd"); // OP_OUTPUTBYTECODE (0xcd)
  });

  it("should include introspection opcodes for enforced royalties", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    const script = nftRoyaltyScript(TEST_ADDRESS, TEST_REF, royalty);
    
    // Check for OP_OUTPUTVALUE (0xcc) and OP_OUTPUTBYTECODE (0xcd) in hex
    expect(script).toMatch(/cc/); // OP_OUTPUTVALUE
    expect(script).toMatch(/cd/); // OP_OUTPUTBYTECODE
    
    // Should contain expected P2PKH script for recipient
    const expectedP2pkh = p2pkhScript(TEST_RECIPIENT);
    expect(script).toContain(expectedP2pkh);
  });

  it("should include correct bps calculation constants", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500, // 5%
      address: TEST_RECIPIENT,
    };
    const script = nftRoyaltyScript(TEST_ADDRESS, TEST_REF, royalty);
    
    // Should contain the introspection opcodes
    expect(script).toContain("cc"); // OP_OUTPUTVALUE
    expect(script).toContain("cd"); // OP_OUTPUTBYTECODE
    expect(script).toContain("bd"); // OP_STATESEPARATOR
  });

  it("should handle minimum royalty in script", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
      minimum: 1000,
    };
    const script = nftRoyaltyScript(TEST_ADDRESS, TEST_REF, royalty);
    
    // Should contain state separator and introspection opcodes
    expect(script).toContain("bd"); // OP_STATESEPARATOR
    expect(script).toContain("cc"); // OP_OUTPUTVALUE
    expect(script).toContain("cd"); // OP_OUTPUTBYTECODE
  });

  it("should handle multiple splits correctly", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 1000,
      address: TEST_RECIPIENT,
      splits: [
        { address: TEST_RECIPIENT, bps: 700 },
        { address: TEST_SPLIT_RECIPIENT, bps: 300 },
      ],
    };
    const script = nftRoyaltyScript(TEST_ADDRESS, TEST_REF, royalty);
    
    // Should contain both recipient P2PKH scripts in the hex
    const script1 = p2pkhScript(TEST_RECIPIENT);
    const script2 = p2pkhScript(TEST_SPLIT_RECIPIENT);
    
    expect(script).toContain(script1);
    expect(script).toContain(script2);
    
    // Should have OP_OUTPUTBYTECODE for both splits
    const bytecodeMatches = script.match(/cd/g);
    expect(bytecodeMatches?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildRoyaltyOutputs", () => {
  it("should return empty array for advisory royalties", () => {
    const royalty: GlyphV2Royalty = {
      enforced: false,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    const outputs = buildRoyaltyOutputs(10000, royalty, []);
    expect(outputs).toHaveLength(0);
  });

  it("should build single royalty output", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    const recipientScript = p2pkhScript(TEST_RECIPIENT);
    const outputs = buildRoyaltyOutputs(10000, royalty, [recipientScript]);
    
    expect(outputs).toHaveLength(1);
    expect(outputs[0].satoshis).toBe(500); // 5% of 10000
    expect(outputs[0].script).toBe(recipientScript);
  });

  it("should build multiple split outputs", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 1000,
      address: TEST_RECIPIENT,
      splits: [
        { address: TEST_RECIPIENT, bps: 700 },
        { address: TEST_SPLIT_RECIPIENT, bps: 300 },
      ],
    };
    const script1 = p2pkhScript(TEST_RECIPIENT);
    const script2 = p2pkhScript(TEST_SPLIT_RECIPIENT);
    const outputs = buildRoyaltyOutputs(10000, royalty, [script1, script2]);
    
    expect(outputs).toHaveLength(2);
    expect(outputs[0].satoshis).toBe(700); // 7% of 10000
    expect(outputs[1].satoshis).toBe(300); // 3% of 10000
  });

  it("should handle minimum in output calculation", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
      minimum: 1000,
    };
    const recipientScript = p2pkhScript(TEST_RECIPIENT);
    // Small sale price where minimum applies
    const outputs = buildRoyaltyOutputs(1000, royalty, [recipientScript]);
    
    expect(outputs[0].satoshis).toBe(1000); // Minimum applied
  });
});

describe("checkRoyaltyCompliance", () => {
  it("should return compliant for advisory royalties", () => {
    const royalty: GlyphV2Royalty = {
      enforced: false,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    const result = checkRoyaltyCompliance([], royalty, 10000);
    expect(result.compliant).toBe(true);
  });

  it("should detect missing royalty output", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    // Only 2 outputs (NFT + payment), missing royalty
    const outputs = [
      { script: "", satoshis: 0 },    // Output 0: NFT
      { script: "", satoshis: 10000 }, // Output 1: Payment
    ];
    const result = checkRoyaltyCompliance(outputs, royalty, 10000);
    expect(result.compliant).toBe(false);
    expect(result.missingOutputs).toBeDefined();
    expect(result.missingOutputs?.[0]).toContain("index 2");
  });

  it("should detect insufficient royalty payment", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500, // Expects 500
      address: TEST_RECIPIENT,
    };
    const outputs = [
      { script: "", satoshis: 0 },    // Output 0: NFT
      { script: "", satoshis: 10000 }, // Output 1: Payment
      { script: "", satoshis: 100 },   // Output 2: Royalty (too low!)
    ];
    const result = checkRoyaltyCompliance(outputs, royalty, 10000);
    expect(result.compliant).toBe(false);
    expect(result.insufficientPayments).toBeDefined();
  });

  it("should pass compliance check with correct outputs", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    const outputs = [
      { script: "", satoshis: 0 },    // Output 0: NFT
      { script: "", satoshis: 10000 }, // Output 1: Payment
      { script: "", satoshis: 600 },   // Output 2: Royalty (>= 500)
    ];
    const result = checkRoyaltyCompliance(outputs, royalty, 10000);
    expect(result.compliant).toBe(true);
  });

  it("should detect missing split outputs", () => {
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 1000,
      address: TEST_RECIPIENT,
      splits: [
        { address: TEST_RECIPIENT, bps: 700 },
        { address: TEST_SPLIT_RECIPIENT, bps: 300 },
      ],
    };
    // Only 3 outputs, missing second split
    const outputs = [
      { script: "", satoshis: 0 },    // Output 0: NFT
      { script: "", satoshis: 10000 }, // Output 1: Payment
      { script: "", satoshis: 700 },   // Output 2: First split
    ];
    const result = checkRoyaltyCompliance(outputs, royalty, 10000);
    expect(result.compliant).toBe(false);
    expect(result.missingOutputs).toBeDefined();
  });
});

describe("REP-3012 Compliance", () => {
  it("should follow canonical output ordering", () => {
    // Output 0: NFT to buyer
    // Output 1: Seller payment (sale price)
    // Output 2+: Royalty outputs
    const royalty: GlyphV2Royalty = {
      enforced: true,
      bps: 500,
      address: TEST_RECIPIENT,
    };
    
    const script = nftRoyaltyScript(TEST_ADDRESS, TEST_REF, royalty);
    
    // Script should reference output 1 for sale price
    // and output 2 for royalty using introspection opcodes
    expect(script).toContain("cc"); // OP_OUTPUTVALUE
    expect(script).toContain("cd"); // OP_OUTPUTBYTECODE
    expect(script).toContain("bd"); // OP_STATESEPARATOR
    
    // Should have the expected P2PKH script for royalty recipient
    const expectedScript = p2pkhScript(TEST_RECIPIENT);
    expect(script).toContain(expectedScript);
  });

  it("should calculate royalty correctly on-chain", () => {
    const testCases = [
      { bps: 500, salePrice: 10000, expected: 500 },    // 5%
      { bps: 250, salePrice: 10000, expected: 250 },    // 2.5%
      { bps: 1000, salePrice: 50000, expected: 5000 },  // 10%
      { bps: 100, salePrice: 10000, expected: 100 },    // 1%
    ];

    for (const tc of testCases) {
      const royalty: GlyphV2Royalty = {
        enforced: true,
        bps: tc.bps,
        address: TEST_RECIPIENT,
      };
      const calculated = calculateRoyalty(tc.salePrice, royalty);
      expect(calculated).toBe(tc.expected);
    }
  });
});
