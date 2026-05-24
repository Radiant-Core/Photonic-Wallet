import { describe, it, expect } from "vitest";
import { SmartTokenPayload, DmintPayload } from "../types";
import { GLYPH_FT, GLYPH_DMINT } from "../protocols";
import {
  dMintScript,
  dMintDiffToTarget,
  buildAsertDaaBytecode,
  buildEpochDaaBytecode,
  buildScheduleDaaBytecode,
  EPOCH_MAX_ADJUSTMENT_LOG2_VALUES,
  SCHEDULE_MAX_ENTRIES,
  DaaParamsValidationError,
  type ScheduleEntry,
} from "../script";
import rjs from "@radiant-core/radiantjs";

const { Script } = rjs;

function hasNonMinimalDataPush(scriptHex: string): boolean {
  const asm = Script.fromHex(scriptHex).toASM();
  const tokens = asm.split(" ");

  return tokens.some((token) => {
    if (!/^[0-9a-f]{2}$/i.test(token)) return false;
    const value = Number.parseInt(token, 16);
    return value === 0 || (value >= 1 && value <= 16) || value === 0x81;
  });
}

function getPowHashOp(scriptHex: string): string | undefined {
  return scriptHex.toLowerCase().match(/(aa|ee|ef)bc01147f/)?.[1];
}

function getPreimageIndexWindow(scriptHex: string): string {
  const asm = Script.fromHex(scriptHex).toASM();
  const start = "OP_OUTPOINTTXHASH";
  const end = "OP_ROLL";
  const startIndex = asm.indexOf(start);
  const endIndex = asm.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    return "";
  }
  return asm.slice(startIndex, endIndex + end.length);
}

describe("dMint Token Creation (Glyph v2)", () => {
  describe("Payload Structure", () => {
    it("should include v:2 version field", () => {
      const payload: SmartTokenPayload = {
        v: 2,
        p: [GLYPH_FT, GLYPH_DMINT],
        ticker: "TEST",
      };

      expect(payload.v).toBe(2);
    });

    it("should include FT and DMINT protocols", () => {
      const payload: SmartTokenPayload = {
        v: 2,
        p: [GLYPH_FT, GLYPH_DMINT],
        ticker: "TEST",
      };

      expect(payload.p).toContain(GLYPH_FT);
      expect(payload.p).toContain(GLYPH_DMINT);
    });

    it("should include dmint object with algorithm", () => {
      const dmint: DmintPayload = {
        algo: 0x01, // Blake3
        numContracts: 1,
        maxHeight: 10000,
        reward: 100,
        premine: 0,
        diff: 10,
      };

      const payload: SmartTokenPayload = {
        v: 2,
        p: [GLYPH_FT, GLYPH_DMINT],
        ticker: "TEST",
        dmint,
      };

      expect(payload.dmint).toBeDefined();
      expect(payload.dmint?.algo).toBe(0x01);
    });
  });

  describe("Algorithm IDs", () => {
    // Helper function to map algorithm string to ID
    const mapAlgoToId = (algo: string): number => {
      const algoMap: Record<string, number> = {
        sha256d: 0x00,
        blake3: 0x01,
        k12: 0x02,
        argon2light: 0x03,
      };
      return algoMap[algo] ?? 0x00;
    };

    it("should map sha256d to 0x00", () => {
      expect(mapAlgoToId("sha256d")).toBe(0x00);
    });

    it("should map blake3 to 0x01", () => {
      expect(mapAlgoToId("blake3")).toBe(0x01);
    });

    it("should map k12 to 0x02", () => {
      expect(mapAlgoToId("k12")).toBe(0x02);
    });

    it("should map argon2light to 0x03", () => {
      expect(mapAlgoToId("argon2light")).toBe(0x03);
    });

    it("should default unknown algorithms to sha256d (0x00)", () => {
      expect(mapAlgoToId("unknown")).toBe(0x00);
    });
  });

  describe("DAA Modes", () => {
    it("should support fixed DAA mode (0x00)", () => {
      const dmint: DmintPayload = {
        algo: 0x01,
        numContracts: 1,
        maxHeight: 10000,
        reward: 100,
        premine: 0,
        diff: 10,
        // No daa field = fixed mode
      };

      expect(dmint.daa).toBeUndefined();
    });

    it("should support ASERT DAA mode (0x02)", () => {
      const dmint: DmintPayload = {
        algo: 0x01,
        numContracts: 1,
        maxHeight: 10000,
        reward: 100,
        premine: 0,
        diff: 10,
        daa: {
          mode: 0x02,
          targetBlockTime: 60,
          halfLife: 1000,
        },
      };

      expect(dmint.daa).toBeDefined();
      expect(dmint.daa?.mode).toBe(0x02);
      expect(dmint.daa?.halfLife).toBe(1000);
    });

    it("should support LWMA DAA mode (0x03)", () => {
      const dmint: DmintPayload = {
        algo: 0x01,
        numContracts: 1,
        maxHeight: 10000,
        reward: 100,
        premine: 0,
        diff: 10,
        daa: {
          mode: 0x03,
          targetBlockTime: 60,
          windowSize: 144,
        },
      };

      expect(dmint.daa).toBeDefined();
      expect(dmint.daa?.mode).toBe(0x03);
      expect(dmint.daa?.windowSize).toBe(144);
    });

    it("should support Epoch DAA mode (0x01)", () => {
      const dmint: DmintPayload = {
        algo: 0x00, // sha256d
        numContracts: 1,
        maxHeight: 10000,
        reward: 100,
        premine: 0,
        diff: 10,
        daa: {
          mode: 0x01,
          targetBlockTime: 600,
          epochLength: 2016,
          maxAdjustment: 4,
        },
      };

      expect(dmint.daa).toBeDefined();
      expect(dmint.daa?.mode).toBe(0x01);
      expect(dmint.daa?.epochLength).toBe(2016);
    });

    it("should support Schedule DAA mode (0x04)", () => {
      const dmint: DmintPayload = {
        algo: 0x01,
        numContracts: 1,
        maxHeight: 10000,
        reward: 100,
        premine: 0,
        diff: 10,
        daa: {
          mode: 0x04,
          targetBlockTime: 60,
          schedule: [
            { height: 0, difficulty: 10 },
            { height: 1000, difficulty: 100 },
            { height: 5000, difficulty: 1000 },
          ],
        },
      };

      expect(dmint.daa).toBeDefined();
      expect(dmint.daa?.mode).toBe(0x04);
      expect(dmint.daa?.schedule).toHaveLength(3);
    });
  });

  describe("Complete dMint Token Payloads", () => {
    it("should create valid Blake3 ASERT token", () => {
      const payload: SmartTokenPayload = {
        v: 2,
        p: [GLYPH_FT, GLYPH_DMINT],
        ticker: "BLAKE",
        name: "Blake3 Token",
        dmint: {
          algo: 0x01, // Blake3
          numContracts: 1,
          maxHeight: 10000,
          reward: 100,
          premine: 0,
          diff: 2500000,
          daa: {
            mode: 0x02, // ASERT
            targetBlockTime: 60,
            halfLife: 3600,
          },
        },
      };

      expect(payload.v).toBe(2);
      expect(payload.p).toContain(GLYPH_FT);
      expect(payload.p).toContain(GLYPH_DMINT);
      expect(payload.dmint?.algo).toBe(0x01);
      expect(payload.dmint?.daa?.mode).toBe(0x02);
    });

    it("should create valid SHA256d Fixed token", () => {
      const payload: SmartTokenPayload = {
        v: 2,
        p: [GLYPH_FT, GLYPH_DMINT],
        ticker: "SHA256",
        name: "SHA256d Token",
        dmint: {
          algo: 0x00, // SHA256d
          numContracts: 1,
          maxHeight: 21000000,
          reward: 50,
          premine: 1000000,
          diff: 500000,
        },
      };

      expect(payload.v).toBe(2);
      expect(payload.dmint?.algo).toBe(0x00);
      expect(payload.dmint?.premine).toBe(1000000);
      expect(payload.dmint?.daa).toBeUndefined(); // Fixed mode
    });

    it("should create valid K12 LWMA token", () => {
      const payload: SmartTokenPayload = {
        v: 2,
        p: [GLYPH_FT, GLYPH_DMINT],
        ticker: "K12",
        name: "KangarooTwelve Token",
        dmint: {
          algo: 0x02, // K12
          numContracts: 1,
          maxHeight: 5000,
          reward: 200,
          premine: 0,
          diff: 2000000,
          daa: {
            mode: 0x03, // LWMA
            targetBlockTime: 30,
            windowSize: 72,
          },
        },
      };

      expect(payload.dmint?.algo).toBe(0x02);
      expect(payload.dmint?.daa?.mode).toBe(0x03);
      expect(payload.dmint?.daa?.windowSize).toBe(72);
    });

    it("should create valid Argon2Light Epoch token", () => {
      const payload: SmartTokenPayload = {
        v: 2,
        p: [GLYPH_FT, GLYPH_DMINT],
        ticker: "ARG2",
        name: "Argon2 Light Token",
        dmint: {
          algo: 0x03, // Argon2Light
          numContracts: 1,
          maxHeight: 100000,
          reward: 10,
          premine: 500,
          diff: 50000,
          daa: {
            mode: 0x01, // Epoch
            targetBlockTime: 120,
            epochLength: 500,
            maxAdjustment: 2,
          },
        },
      };

      expect(payload.dmint?.algo).toBe(0x03);
      expect(payload.dmint?.daa?.mode).toBe(0x01);
      expect(payload.dmint?.daa?.epochLength).toBe(500);
    });
  });

  describe("dMint Script Encoding", () => {
    const contractRef = "11".repeat(36);
    const tokenRef = "22".repeat(36);
    const target = dMintDiffToTarget(10);

    const algoCases = [
      { algo: "sha256d", expectedOp: "aa" },
      { algo: "blake3", expectedOp: "ee" },
      { algo: "k12", expectedOp: "ef" },
    ] as const;

    const daaCases = [
      { daaMode: "fixed", daaParams: null },
      {
        daaMode: "asert",
        daaParams: { targetBlockTime: 60, halfLife: 1000, asymptote: 0 },
      },
      { daaMode: "lwma", daaParams: { targetBlockTime: 60, windowSize: 144 } },
      {
        daaMode: "epoch",
        daaParams: { targetBlockTime: 60, epochLength: 2016, maxAdjustment: 4 },
      },
      {
        daaMode: "schedule",
        daaParams: {
          schedule: [
            { height: 0, difficulty: 10 },
            { height: 1000, difficulty: 50 },
          ],
        },
      },
    ] as const;

    it("should emit canonical minimal pushes for all supported algorithms and DAA modes", () => {
      for (const { algo, expectedOp } of algoCases) {
        for (const { daaMode, daaParams } of daaCases) {
          const script = dMintScript(
            0,
            contractRef,
            tokenRef,
            100,
            10,
            target,
            algo,
            daaMode,
            daaParams
          );

          expect(getPowHashOp(script)).toBe(expectedOp);
          expect(hasNonMinimalDataPush(script)).toBe(false);
        }
      }
    });

    it("uses V2 preimage stack indices for sha256d fixed contracts (10 state items)", () => {
      const script = dMintScript(
        0,
        contractRef,
        tokenRef,
        100,
        10,
        target,
        "sha256d",
        "fixed",
        null
      );

      // V2 format: 10 state items → contractRefPick=9, ioPick=13, nonceRoll=14
      // 0xc8 (OP_OUTPOINTTXHASH) pushes txHash; consumed by first OP_CAT with contractRef
      const indexWindow = getPreimageIndexWindow(script);
      expect(indexWindow).toContain("OP_OUTPOINTTXHASH OP_9 OP_PICK");
      expect(indexWindow).toContain("OP_13 OP_PICK OP_13 OP_PICK");
      expect(indexWindow).toContain("OP_14 OP_ROLL");
    });

    it("uses same V2 preimage stack indices for blake3 asert contracts (10 state items)", () => {
      const script = dMintScript(
        0,
        contractRef,
        tokenRef,
        100,
        10,
        target,
        "blake3",
        "asert",
        { targetBlockTime: 60, halfLife: 1000 }
      );

      // V2 format: 10 state items (halfLife is bytecode constant, not state)
      // 0xc8 (OP_OUTPOINTTXHASH) pushes txHash; consumed by first OP_CAT with contractRef
      const indexWindow = getPreimageIndexWindow(script);
      expect(indexWindow).toContain("OP_OUTPOINTTXHASH OP_9 OP_PICK");
      expect(indexWindow).toContain("OP_13 OP_PICK OP_13 OP_PICK");
      expect(indexWindow).toContain("OP_14 OP_ROLL");
    });

    // Regression: Part A must emit OP_INPUTINDEX OP_OUTPOINTTXHASH (c0 c8), not
    // OP_1 OP_DROP OP_OUTPOINTTXHASH (51 75 c8). OP_OUTPOINTTXHASH is UNARY in
    // Radiant-Core — it pops the input index from the stack. The 51 75 variant
    // leaves `target` on top and c8 consumes it as an index, causing
    // SCRIPT_ERR_INVALID_TX_INPUT_INDEX at broadcast time.
    it("Part A prefix before OP_OUTPOINTTXHASH is exactly OP_INPUTINDEX — not OP_1 OP_DROP (c0c8 regression)", () => {
      for (const algo of ["sha256d", "blake3", "k12"] as const) {
        const script = dMintScript(
          0,
          contractRef,
          tokenRef,
          100,
          10,
          target,
          algo,
          "asert",
          { targetBlockTime: 60, halfLife: 1000 }
        );
        const asm = Script.fromHex(script).toASM();
        const sepIdx = asm.indexOf("OP_STATESEPARATOR");
        const txhashIdx = asm.indexOf("OP_OUTPOINTTXHASH", sepIdx);
        expect(sepIdx).toBeGreaterThan(-1);
        expect(txhashIdx).toBeGreaterThan(sepIdx);
        // The token immediately before OP_OUTPOINTTXHASH must be OP_INPUTINDEX
        const tokens = asm.slice(sepIdx + "OP_STATESEPARATOR".length, txhashIdx).trim().split(/\s+/);
        expect(tokens.at(-1)).toBe("OP_INPUTINDEX");
        // And there must be no OP_DROP between state separator and OP_OUTPOINTTXHASH
        expect(tokens).not.toContain("OP_DROP");
      }
    });

    // Regression: V2 PartC must NOT begin with OP_GREATERTHANOREQUAL OP_VERIFY (`a269`).
    // That prefix consumes mh and r — items the V1-style PartC body that follows immediately
    // needs for its first `OP_7 OP_ROLL OP_CODESCRIPTHASHOUTPUTCOUNT_UTXOS` pair.
    // With the prefix in place, V2 contracts stack-underflow at the ROLL (rejected at broadcast
    // with SCRIPT_ERR_INVALID_STACK_OPERATION). The B3T (374b92…) and B3T2 (bc41a1…) contracts
    // deployed before this fix are permanently un-mineable. See
    // b3t-forensics/b3t2-root-cause.md.
    it("V2 PartC starts at the V1-equivalent boundary (no `a269` after the 5 OP_DROPs)", () => {
      for (const algo of ["sha256d", "blake3", "k12"] as const) {
        for (const daa of ["fixed", "asert", "lwma"] as const) {
          const script = dMintScript(
            0,
            contractRef,
            tokenRef,
            100,
            10,
            target,
            algo,
            daa,
            daa === "fixed" ? null : { targetBlockTime: 60, halfLife: 1000 }
          );
          // PartB4 = 5×OP_DROP (`7575757575`). The byte immediately after must
          // begin the V1-style PartC body, which starts with `577a` (OP_7 OP_ROLL).
          expect(script).not.toMatch(/7575757575a269/);
          expect(script).toMatch(/7575757575577a/);
        }
      }
    });
  });

  describe("ASERT DAA bytecode", () => {
    // Regression for the 2026-05-19 opcode bug: prior implementations of
    // buildAsertDaaBytecode emitted hex 0x81 (OP_BIN2NUM) in three places
    // where 0x8f (OP_NEGATE) was intended. The bug rendered the negative-
    // drift clamp identical to a second positive check and made the RSHIFT
    // path receive a negative shift count.
    it("emits OP_NEGATE three times and no OP_BIN2NUM in the DAA section", () => {
      const hex = buildAsertDaaBytecode(1000);
      const asm = Script.fromHex(hex).toASM();
      const tokens = asm.split(" ");

      const bin2numCount = tokens.filter((t) => t === "OP_BIN2NUM").length;
      const negateCount = tokens.filter((t) => t === "OP_NEGATE").length;

      expect(bin2numCount).toBe(0);
      expect(negateCount).toBe(3);
    });

    it("emits the documented clamp-and-shift opcode skeleton", () => {
      const hex = buildAsertDaaBytecode(1000);
      const asm = Script.fromHex(hex).toASM();

      // Negative clamp must compare against -4 (not 4):
      // OP_DUP OP_4 OP_NEGATE OP_LESSTHAN
      expect(asm).toContain("OP_DUP OP_4 OP_NEGATE OP_LESSTHAN");

      // Negative shift must NEGATE the drift before RSHIFT:
      // OP_NEGATE OP_RSHIFT
      expect(asm).toContain("OP_NEGATE OP_RSHIFT");
    });
  });

  describe("EPOCH DAA bytecode", () => {
    it("emits expected opcode sequence for default params", () => {
      const hex = buildEpochDaaBytecode(2016, 2);
      // Sanity: starts with OP_9 OP_PICK (5979) and ends with OP_ENDIF (68)
      expect(hex.startsWith("5979")).toBe(true);
      expect(hex.endsWith("68")).toBe(true);
      // Must contain OP_MOD (97), OP_BOOLAND (9a), OP_TXLOCKTIME (c5),
      // OP_LSHIFT (98), OP_RSHIFT (99), OP_MIN (a3), OP_MAX (a4), OP_MUL (95), OP_DIV (96)
      for (const op of ["97", "9a", "c5", "98", "99", "a3", "a4", "95", "96"]) {
        expect(hex).toContain(op);
      }
    });

    it("emits canonical-minimal pushes (no leading zeros, no oversized data pushes)", () => {
      const hex = buildEpochDaaBytecode(2016, 2);
      // Must parse without errors and round-trip through Script.fromHex.toASM
      const asm = Script.fromHex(hex).toASM();
      expect(asm.length).toBeGreaterThan(0);
      expect(hasNonMinimalDataPush(hex)).toBe(false);
    });

    it("embeds different shift counts for different maxAdjustmentLog2 values", () => {
      const seen = new Set<string>();
      for (const n of EPOCH_MAX_ADJUSTMENT_LOG2_VALUES) {
        const hex = buildEpochDaaBytecode(100, n);
        seen.add(hex);
      }
      // Each log2 value must produce a distinct bytecode (different push constants)
      expect(seen.size).toBe(EPOCH_MAX_ADJUSTMENT_LOG2_VALUES.length);
    });

    it("rejects invalid epochLength", () => {
      expect(() => buildEpochDaaBytecode(0, 2)).toThrow(
        DaaParamsValidationError
      );
      expect(() => buildEpochDaaBytecode(-1, 2)).toThrow(
        DaaParamsValidationError
      );
      expect(() => buildEpochDaaBytecode(1.5, 2)).toThrow(
        DaaParamsValidationError
      );
    });

    it("rejects maxAdjustmentLog2 outside {1,2,3,4}", () => {
      expect(() => buildEpochDaaBytecode(100, 0)).toThrow(
        DaaParamsValidationError
      );
      expect(() => buildEpochDaaBytecode(100, 5)).toThrow(
        DaaParamsValidationError
      );
      expect(() => buildEpochDaaBytecode(100, -1)).toThrow(
        DaaParamsValidationError
      );
    });
  });

  describe("SCHEDULE DAA bytecode", () => {
    const sampleSchedule: ScheduleEntry[] = [
      { height: 1000, target: 500n },
      { height: 2000, target: 250n },
      { height: 5000, target: 100n },
    ];

    it("emits empty bytecode for an empty schedule", () => {
      expect(buildScheduleDaaBytecode([])).toBe("");
    });

    it("emits nested IF/ELSE chain for a 3-entry schedule", () => {
      const hex = buildScheduleDaaBytecode(sampleSchedule);
      // Should contain 3 occurrences of OP_GREATERTHANOREQUAL (a2)
      const geCount = (hex.match(/a2/g) ?? []).length;
      expect(geCount).toBe(3);
      // Should contain at least 3 OP_IF (63), 2 OP_ELSE (67), 3 OP_ENDIF (68)
      expect((hex.match(/63/g) ?? []).length).toBeGreaterThanOrEqual(3);
      expect((hex.match(/67/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect((hex.match(/68/g) ?? []).length).toBeGreaterThanOrEqual(3);
      // Should parse cleanly
      Script.fromHex(hex).toASM();
    });

    it("puts the highest boundary outermost (descending walk in code)", () => {
      const hex = buildScheduleDaaBytecode(sampleSchedule);
      // pushMinimal(5000) → 0x02 8813 (2-byte push, little-endian 0x1388)
      // pushMinimal(2000) → 0x02 d007 (2-byte push, little-endian 0x07d0)
      // pushMinimal(1000) → 0x02 e803 (2-byte push, little-endian 0x03e8)
      const i5000 = hex.indexOf("028813");
      const i2000 = hex.indexOf("02d007");
      const i1000 = hex.indexOf("02e803");
      expect(i5000).toBeGreaterThan(-1);
      expect(i2000).toBeGreaterThan(i5000);
      expect(i1000).toBeGreaterThan(i2000);
    });

    it("rejects more than SCHEDULE_MAX_ENTRIES entries", () => {
      const tooMany = Array.from(
        { length: SCHEDULE_MAX_ENTRIES + 1 },
        (_, i) => ({
          height: (i + 1) * 100,
          target: BigInt(1000 - i),
        })
      );
      expect(() => buildScheduleDaaBytecode(tooMany)).toThrow(
        DaaParamsValidationError
      );
    });

    it("rejects unsorted or duplicate-height entries", () => {
      expect(() =>
        buildScheduleDaaBytecode([
          { height: 2000, target: 250n },
          { height: 1000, target: 500n }, // unsorted
        ])
      ).toThrow(DaaParamsValidationError);
      expect(() =>
        buildScheduleDaaBytecode([
          { height: 1000, target: 500n },
          { height: 1000, target: 250n }, // duplicate
        ])
      ).toThrow(DaaParamsValidationError);
    });

    it("rejects non-positive target", () => {
      expect(() =>
        buildScheduleDaaBytecode([{ height: 100, target: 0n }])
      ).toThrow(DaaParamsValidationError);
      expect(() =>
        buildScheduleDaaBytecode([{ height: 100, target: -1n }])
      ).toThrow(DaaParamsValidationError);
    });

    it("accepts difficulty form via dMintScript daaParams", () => {
      // This exercises the normalizeScheduleEntries path: input has `difficulty`,
      // bytecode embeds the corresponding target.
      const script = dMintScript(
        0,
        "11".repeat(36),
        "22".repeat(36),
        100,
        10,
        dMintDiffToTarget(10),
        "sha256d",
        "schedule",
        {
          schedule: [
            { height: 1000, difficulty: 50 },
            { height: 2000, difficulty: 100 },
          ],
        }
      );
      // Should produce a contract script and round-trip cleanly
      expect(Script.fromHex(script).toASM().length).toBeGreaterThan(0);
    });
  });
});
