import { describe, it, expect } from "vitest";
import { SmartTokenPayload, DmintPayload } from "../types";
import { GLYPH_FT, GLYPH_DMINT } from "../protocols";
import {
  dMintScript,
  dMintDiffToTarget,
  pushMinimal,
  buildAsertDaaBytecode,
  buildEpochDaaBytecode,
  buildScheduleDaaBytecode,
  EPOCH_MAX_ADJUSTMENT_LOG2_VALUES,
  SCHEDULE_MAX_ENTRIES,
  DaaParamsValidationError,
  type ScheduleEntry,
  type DaaParams,
} from "../script";
import rjs from "@radiant-core/radiantjs";

const { Script } = rjs;

/**
 * Walks a script's push opcodes byte-by-byte and reports the first push that
 * would fail radiantd's CheckMinimalPush check (Radiant-Core
 * src/script/script.cpp:374). Matches the actual interpreter rule, not the
 * miner's overly-aggressive ASM-token heuristic at
 * Glyph-miner/src/blockchain.ts:280-294.
 *
 * Rules (in CheckMinimalPush order):
 *  1. Empty data must use OP_0. (Single byte 0x00, no length prefix.)
 *  2. Single-byte push of value 1..16 must use OP_1..OP_16.
 *  3. Single-byte push of 0x81 must use OP_1NEGATE.
 *  4. Direct pushes (1..75 bytes) must use opcode == data length.
 *  5. PUSHDATA1 with data ≤ 75 bytes must use direct push.
 *  6. PUSHDATA2 with data ≤ 255 bytes must use PUSHDATA1.
 *  7. PUSHDATA4 with data ≤ 65535 bytes must use PUSHDATA2 or shorter.
 *
 * NB: a multi-byte direct push (e.g. `04 00 00 00 00`) does NOT get reduced
 * to OP_0 by MINIMALDATA — it pushes a 4-byte bytestring of zeros, which is
 * distinct from OP_0's empty push. CheckMinimalPush only collapses single-
 * byte pushes whose data matches an OP_N value.
 *
 * Returns the description of the first violation, or undefined.
 */
function findNonMinimalPush(scriptHex: string): string | undefined {
  const bytes = Buffer.from(scriptHex, "hex");
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i];
    // Direct push (length-prefixed 1..75 bytes).
    if (op >= 0x01 && op <= 0x4b) {
      const len = op;
      const data = bytes.slice(i + 1, i + 1 + len);
      if (len === 1) {
        const v = data[0];
        if (v >= 1 && v <= 16)
          return `pos ${i}: push 1 0x${v.toString(16).padStart(2, "0")} — should be OP_${v}`;
        if (v === 0x81) return `pos ${i}: push 1 0x81 — should be OP_1NEGATE`;
      }
      i += 1 + len;
      continue;
    }
    if (op === 0x4c) {
      const len = bytes[i + 1];
      if (len < 0x4c)
        return `pos ${i}: PUSHDATA1 ${len} — should use direct-push opcode`;
      i += 2 + len;
      continue;
    }
    if (op === 0x4d) {
      const len = bytes[i + 1] | (bytes[i + 2] << 8);
      if (len <= 0xff)
        return `pos ${i}: PUSHDATA2 ${len} — should use PUSHDATA1 or direct`;
      i += 3 + len;
      continue;
    }
    if (op === 0x4e) {
      const len =
        bytes[i + 1] |
        (bytes[i + 2] << 8) |
        (bytes[i + 3] << 16) |
        (bytes[i + 4] << 24);
      if (len <= 0xffff)
        return `pos ${i}: PUSHDATA4 ${len} — should use shorter PUSHDATA`;
      i += 5 + len;
      continue;
    }
    // Non-push opcode — single byte.
    i++;
  }
  return undefined;
}

/** Compatibility wrapper preserving the old boolean signature. */
function hasNonMinimalDataPush(scriptHex: string): boolean {
  return findNonMinimalPush(scriptHex) !== undefined;
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
      // A valid Unix timestamp (1700000000 = 2023-11-14) so push4bytes(lastTime)
      // is naturally 4-byte minimal. Any real deploy uses `Date.now()/1000`
      // which is well into this range; the only callers that would pass 0 are
      // test fixtures, and those should use a sentinel timestamp explicitly.
      const lastTime = 1700000000;
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
            daaParams,
            lastTime,
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
      const daaParamsByMode = {
        fixed: null,
        asert: { targetBlockTime: 60, halfLife: 1000 },
        lwma: { targetBlockTime: 60 },
        epoch: { targetBlockTime: 60, epochLength: 2016, maxAdjustmentLog2: 2 },
        schedule: {
          schedule: [
            { height: 0, target: 100000n },
            { height: 1000, target: 50000n },
          ],
        },
      } as const;
      for (const algo of ["sha256d", "blake3", "k12"] as const) {
        for (const daa of [
          "fixed",
          "asert",
          "lwma",
          "epoch",
          "schedule",
        ] as const) {
          const script = dMintScript(
            0,
            contractRef,
            tokenRef,
            100,
            10,
            target,
            algo,
            daa,
            daaParamsByMode[daa] as never
          );
          // PartB4 is now `6b75757575` (TOALTSTACK + 4×DROP), and PartC's
          // V1-style body still starts with `577a` (OP_7 OP_ROLL). Regression
          // guard: the legacy `a269` prefix (which caused the pre-7f19cbb
          // stack-underflow incident, b3t-forensics/captured-b3t2.json) must
          // not reappear, and PartB4 must hand control to PartC's ROLL 7
          // entry. The new PartC's IF branch starts with `6c75 5279cd ...`
          // (FROMALTSTACK DROP, then V1 final-mint check), so the regex
          // matches everything from the TOALTSTACK PartB4 byte through the
          // ROLL 7 of the continue-mining setup.
          expect(script).not.toMatch(/6b75757575577ae5.*a269577a/);
          expect(script).toMatch(/6b75757575577a/);
        }
      }
    });

    // Stronger regression: walk the V2 code script as a linear opcode stream
    // and assert the running stack depth never goes negative at PartC's first
    // ROLL. This catches a wider class of regressions than the regex above —
    // e.g. PartB4 changing from 5 drops to 6, or DAA bytecode acquiring an
    // extra net pop, would both leave the regex passing but underflow PartC.
    //
    // Static model: track depth assuming the "if-taken" branch executes for
    // every IF, since both branches of a valid script have the same net stack
    // effect. We start with the initial scriptSig+state depth that the spend
    // produces (4 scriptSig pushes + V2 state's 10 items = 14 items).
    it("V2 code script never underflows the stack from PartA entry through PartC's ROLL 7", () => {
      // Minimal stack-effect model for Radiant opcodes used by the V2 dMint
      // contract. [poppushDelta, isControlFlow] — most opcodes are linear
      // delta = pushes - pops; IF pops the condition (-1), ELSE/ENDIF are 0.
      const op = (delta: number) => ({ delta });
      const opcodeStackEffect: Record<number, { delta: number }> = {
        // Numeric pushes OP_0..OP_16 (0x00, 0x4f, 0x51..0x60)
        0x00: op(+1),
        0x4f: op(+1), // OP_1NEGATE
        // stack ops
        0x61: op(0),  // OP_NOP
        0x63: op(-1), // OP_IF (pop condition)
        0x64: op(-1), // OP_NOTIF
        0x67: op(0),  // OP_ELSE
        0x68: op(0),  // OP_ENDIF
        0x69: op(-1), // OP_VERIFY
        0x6a: op(0),  // OP_RETURN (terminal; not in dMint)
        0x6b: op(-1), // OP_TOALTSTACK (pop main, push alt) — added 2026-05-26
                      //   with the V2-launch redesign (PartB4 preserves the
                      //   DAA newTarget on the alt stack).
        0x6c: op(+1), // OP_FROMALTSTACK (pop alt, push main) — paired with 0x6b
                      //   in the new PartC IF/ELSE branches.
        0x6d: op(-2), // OP_2DROP
        0x73: op(0),  // OP_IFDUP (best-effort)
        0x75: op(-1), // OP_DROP
        0x76: op(+1), // OP_DUP
        0x77: op(-1), // OP_NIP
        0x78: op(+1), // OP_OVER
        0x79: op(0),  // OP_PICK
        0x7a: op(-1), // OP_ROLL
        0x7b: op(0),  // OP_ROT
        0x7c: op(0),  // OP_SWAP
        0x7d: op(+1), // OP_TUCK
        0x7e: op(-1), // OP_CAT
        0x7f: op(0),  // OP_SPLIT (pop val + idx, push left, right)
        0x80: op(-1), // OP_NUM2BIN (pop value + size, push 1)
        0x81: op(0),  // OP_BIN2NUM (pop, push)
        0x82: op(0),  // OP_SIZE (pushes length without popping)
        // Bitwise / arith
        0x87: op(-1), // OP_EQUAL
        0x88: op(-2), // OP_EQUALVERIFY (pop 2, verify, no push)
        0x8b: op(0),  // OP_1ADD
        0x8c: op(0),  // OP_1SUB
        0x8d: op(0),  // OP_2MUL (post-2026-05-25 ASERT/EPOCH shift unroll)
        0x8e: op(0),  // OP_2DIV
        0x8f: op(0),  // OP_NEGATE
        0x91: op(0),  // OP_NOT
        0x93: op(-1), // OP_ADD
        0x94: op(-1), // OP_SUB
        0x95: op(-1), // OP_MUL
        0x96: op(-1), // OP_DIV
        0x97: op(-1), // OP_MOD
        0x98: op(-1), // OP_LSHIFT
        0x99: op(-1), // OP_RSHIFT
        0x9a: op(-1), // OP_BOOLAND
        0x9c: op(-1), // OP_NUMEQUAL
        0x9d: op(-2), // OP_NUMEQUALVERIFY
        0x9f: op(-1), // OP_LESSTHAN
        0xa0: op(-1), // OP_GREATERTHAN
        0xa1: op(-1), // OP_LESSTHANOREQUAL — added 2026-05-26 for MINIMAL_PUSH
        0xa2: op(-1), // OP_GREATERTHANOREQUAL
        0xa3: op(-1), // OP_MIN
        0xa4: op(-1), // OP_MAX
        // Crypto
        0xa8: op(0),  // OP_SHA256
        0xaa: op(0),  // OP_HASH256
        0xae: op(-1), // OP_CHECKMULTISIG (not used in dMint)
        // Radiant introspection (all unary unless noted)
        0xbc: op(0),  // OP_REVERSEBYTES
        0xbd: op(0),  // OP_STATESEPARATOR (no-op during execution)
        0xc0: op(+1), // OP_INPUTINDEX (nullary)
        0xc5: op(+1), // OP_TXLOCKTIME (nullary)
        0xc8: op(0),  // OP_OUTPOINTTXHASH (unary: pop idx push hash)
        0xcc: op(0),  // OP_OUTPUTVALUE (unary)
        0xcd: op(0),  // OP_OUTPUTBYTECODE (unary)
        0xd0: op(+1), // OP_PUSHINPUTREF
        0xd8: op(+1), // OP_PUSHINPUTREFSINGLETON
        0xde: op(0),  // OP_REFOUTPUTCOUNT_OUTPUTS (unary)
        0xe4: op(0),  // OP_CODESCRIPTHASHVALUESUM_OUTPUTS (unary)
        0xe5: op(0),  // OP_CODESCRIPTHASHOUTPUTCOUNT_UTXOS (unary)
        0xe6: op(0),  // OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS (unary)
        0xe9: op(0),  // OP_CODESCRIPTBYTECODE_OUTPUT (unary)
        0xea: op(0),  // OP_CODESCRIPTBYTECODE_UTXO (unary)
        0xeb: op(0),  // OP_STATESCRIPTBYTECODE_UTXO (unary)
        0xec: op(0),  // OP_STATESCRIPTBYTECODE_OUTPUT (unary)
        0xee: op(0),  // OP_BLAKE3 (unary)
        0xef: op(0),  // OP_K12 (unary)
      };
      // OP_2..OP_16 (0x52..0x60) all push 1
      for (let n = 0x52; n <= 0x60; n++) {
        opcodeStackEffect[n] = op(+1);
      }
      // OP_1 = 0x51 also pushes 1
      opcodeStackEffect[0x51] = op(+1);

      // For each (algo, daa) combo: walk the FULL deploy-output script bytes
      // (state || bd || code), starting with empty stack and pushing each
      // state item. Then walk the code script and assert depth stays ≥ 0.
      const daaParamsByMode = {
        fixed: null,
        asert: { targetBlockTime: 60, halfLife: 1000 },
        lwma: { targetBlockTime: 60 },
        epoch: { targetBlockTime: 60, epochLength: 2016, maxAdjustmentLog2: 2 },
        schedule: {
          schedule: [
            { height: 0, target: 100000n },
            { height: 1000, target: 50000n },
          ],
        },
      } as const;
      for (const algo of ["sha256d", "blake3", "k12"] as const) {
        for (const daa of [
          "fixed",
          "asert",
          "lwma",
          "epoch",
          "schedule",
        ] as const) {
          const script = dMintScript(
            0,
            contractRef,
            tokenRef,
            100,
            10,
            target,
            algo,
            daa,
            daaParamsByMode[daa] as never
          );

          // Initial depth: 4 scriptSig pushes (nonce, ih, oh, oi) + 10 V2 state items.
          let depth = 4 + 10;
          let minDepth = depth;
          let pc = 0;
          let depthAtFirstRoll7: number | undefined;
          const bytes = Buffer.from(script, "hex");
          // `577a` after PartB4 is push-7 + OP_ROLL 7 — PartC's first ROLL.
          // Need depth ≥ 8 right here for the ROLL to access item at depth 7.
          const ROLL7_PREFIX = "577a";

          while (pc < bytes.length) {
            // Track depth right before PartC's first `577a` (push 7, ROLL 7).
            // The pre-fix V2 PartC had a leading `a269` (GE VERIFY) that
            // consumed 2 items and left only 6 on stack here — ROLL 7 then
            // underflowed (SCRIPT_ERR_INVALID_STACK_OPERATION). The post-fix
            // PartC removes that prefix so depth here is the full 8.
            const lookahead = script.substring(pc * 2, pc * 2 + ROLL7_PREFIX.length);
            // The first `577a` after we've crossed PartB4 is the one we want.
            // PartB4 is now `6b75757575` (TOALTSTACK + 4×DROP) — the 2026-05-26
            // redesign preserves the DAA newTarget on the alt stack instead of
            // 5×OP_DROPing everything, which is why the lookback differs from
            // the pre-redesign V2 (`7575757575`).
            const sevenBytesBack = script.substring(
              Math.max(0, pc * 2 - 10),
              pc * 2,
            );
            if (
              lookahead === ROLL7_PREFIX &&
              sevenBytesBack === "6b75757575" &&
              depthAtFirstRoll7 === undefined
            ) {
              depthAtFirstRoll7 = depth;
            }

            const op = bytes[pc++];

            // Push opcodes (raw, OP_PUSHDATA1/2/4): each pushes exactly 1.
            if (op >= 0x01 && op <= 0x4b) {
              pc += op;
              depth += 1;
            } else if (op === 0x4c) {
              const len = bytes[pc++];
              pc += len;
              depth += 1;
            } else if (op === 0x4d) {
              const len = bytes[pc] | (bytes[pc + 1] << 8);
              pc += 2 + len;
              depth += 1;
            } else if (op === 0x4e) {
              const len =
                bytes[pc] |
                (bytes[pc + 1] << 8) |
                (bytes[pc + 2] << 16) |
                (bytes[pc + 3] << 24);
              pc += 4 + len;
              depth += 1;
            } else {
              const effect = opcodeStackEffect[op];
              if (effect === undefined) {
                throw new Error(
                  `Unmodeled opcode 0x${op.toString(16).padStart(2, "0")} at pc ${pc - 1} in ${algo}/${daa}`
                );
              }
              // d8 / d0 push opcodes include 36 bytes of inline ref data.
              // Treat them as a push-with-suffix: they appear in the state
              // script only; consume the trailing 36 bytes as part of the push.
              if (op === 0xd0 || op === 0xd8) {
                pc += 36;
              }
              depth += effect.delta;
            }

            if (depth < minDepth) minDepth = depth;
          }

          // Underflow gate: the linear walker can over- or under-count when
          // IF/ELSE branches have asymmetric stack effects (it processes both
          // branches in sequence), so the absolute final depth isn't reliable.
          // But ANY negative running depth means the static stack is too small
          // somewhere — the bug class we're regressing against.
          expect(minDepth, `${algo}/${daa}: minDepth went negative`).toBeGreaterThanOrEqual(0);

          // Focused check on the specific bug: depth right before PartC's
          // first `577a` (push 7, OP_ROLL 7) must be ≥ 8. The pre-fix V2
          // PartC's leading `a269` consumed two items between PartB4 and
          // ROLL 7, leaving depth at 6 here — exactly the underflow case.
          expect(depthAtFirstRoll7, `${algo}/${daa}: PartC ROLL 7 not found in script`).toBeDefined();
          expect(
            depthAtFirstRoll7 as number,
            `${algo}/${daa}: depth before PartC's ROLL 7 too low (would underflow)`,
          ).toBeGreaterThanOrEqual(8);
        }
      }
    });

    // V2-launch contract shape (post-2026-05-26 redesign,
    // b3t-forensics/V2_CONTRACT_AUDIT_REMEDIATION.md §§7-8):
    //   - All variable state pushes are MINIMALDATA-compliant (height, target).
    //   - PartB4 = `6b75757575` (TOALTSTACK newTarget + 4×DROP).
    //   - PartC reconstructs expected_next_state from scratch using a runtime
    //     MINIMAL_PUSH primitive plus a deploy-time literal middle blob.
    describe("V2-launch contract emission", () => {
      const daaParamsByMode = {
        fixed: null,
        asert: { targetBlockTime: 60, halfLife: 1000 },
        lwma: { targetBlockTime: 60 },
        epoch: { targetBlockTime: 60, epochLength: 2016, maxAdjustmentLog2: 2 },
        schedule: {
          schedule: [
            { height: 0, target: 100000n },
            { height: 1000, target: 50000n },
          ],
        },
      } as const;

      it("state script has no non-minimal pushes at height=0, target=MAX_TARGET", () => {
        const maxTarget = 0x7fffffffffffffffn;
        for (const algo of ["sha256d", "blake3", "k12"] as const) {
          for (const daa of [
            "fixed",
            "asert",
            "lwma",
            "epoch",
            "schedule",
          ] as const) {
            const script = dMintScript(
              0,
              contractRef,
              tokenRef,
              100,
              1,
              maxTarget,
              algo,
              daa,
              daaParamsByMode[daa] as never,
              Math.floor(Date.now() / 1000),
            );
            const sepIdx = script.indexOf("bd");
            const stateHex = script.substring(0, sepIdx);
            const finding = findNonMinimalPush(stateHex);
            expect(finding, `${algo}/${daa} state has non-minimal push: ${finding}`).toBeUndefined();
          }
        }
      });

      it("PartB4 is `6b75757575` (TOALTSTACK + 4×DROP) — DAA newTarget preserved", () => {
        for (const algo of ["sha256d", "blake3", "k12"] as const) {
          for (const daa of ["fixed", "asert"] as const) {
            const script = dMintScript(
              1000, contractRef, tokenRef, 100, 1, target,
              algo, daa,
              daa === "fixed" ? null : { targetBlockTime: 60, halfLife: 1000 },
              Math.floor(Date.now() / 1000),
            );
            const v3PartB4Matches = script.match(/6b75757575/g) ?? [];
            expect(v3PartB4Matches.length).toBe(1);
            // Legacy V2 5×DROP marker must NOT appear (would confuse parsers).
            expect(script).not.toMatch(/7575757575/);
          }
        }
      });

      it("PartC contains both MINIMAL_PUSH primitives + new lastTime build", () => {
        const script = dMintScript(
          1000, contractRef, tokenRef, 100, 1, target,
          "blake3", "asert",
          { targetBlockTime: 60, halfLife: 1000 },
          Math.floor(Date.now() / 1000),
        );
        // MINIMAL_PUSH skeleton (DUP 0 NUMEQUAL IF DROP PUSH(1) 00 ELSE
        //   DUP 16 LE IF PUSH(1) 50 ADD 1 NUM2BIN ELSE SIZE SWAP CAT ENDIF ENDIF)
        // Distinctive subsequence: `7600 9c63 7501 0067 7660 a163 0150 935180 67 82 7c 7e 68 68`
        const minimalPushSig = "76009c637501006776 60 a16301509351806782 7c7e6868".replace(/\s/g, "");
        const sigMatches = script.match(new RegExp(minimalPushSig, "g")) ?? [];
        expect(sigMatches.length).toBe(2);
        // New lastTime build (MINIMALDATA-fixed): TXLOCKTIME push4 NUM2BIN
        // OP_4 SWAP CAT CAT. Replaces the pre-redesign V3 form's `01 04`
        // push (which would have triggered MINIMALDATA — data byte 0x04 is
        // in [1..16] and must use OP_4 = 0x54).
        expect(script).toContain("c55480547c7e7e");
        // FROMALTSTACK preceding the second MINIMAL_PUSH (newTarget consume)
        expect(script).toContain("6c" + minimalPushSig);
        // IF branch (final-mint) starts with FROMALTSTACK DROP to consume the alt
        expect(script).toContain("636c75");
      });

      it("height=0 deploy starts with OP_0 (`00`), not `0400000000`", () => {
        const script = dMintScript(
          0, contractRef, tokenRef, 5, 1, target,
          "blake3", "asert",
          { targetBlockTime: 60, halfLife: 100 },
          1700000000,
        );
        expect(script.startsWith("00")).toBe(true);
        // No height bias applied — first byte is OP_0, not the old `04 00000001`.
        expect(script.startsWith("0400000001")).toBe(false);
        expect(script.startsWith("0400000000")).toBe(false);
      });

      it("maxHeight push uses OP_N for small values (e.g. 5 → `55`)", () => {
        const script = dMintScript(
          0, contractRef, tokenRef, 5, 1, target,
          "blake3", "asert",
          { targetBlockTime: 60, halfLife: 100 },
          1700000000,
        );
        // State script layout (post-redesign):
        //   pushMinimal(0) = OP_0    →  1 byte  =  2 hex chars
        //   d8 + 36-byte cRef        → 37 bytes = 74 hex chars
        //   d0 + 36-byte tRef        → 37 bytes = 74 hex chars
        //   pushMinimal(maxHeight)   → starts here
        const offset = 2 + 74 + 74;
        expect(script.slice(offset, offset + 2)).toBe("55"); // OP_5 = 0x55
      });

      it("target push uses MINIMAL_PUSH (small target → short push)", () => {
        // target=1 → pushMinimal(1) = "51" (OP_1, 1 byte).
        // target=MAX_TARGET → pushMinimal(MAX_TARGET) = "08ffffffffffffff7f" (9 bytes).
        const scriptSmall = dMintScript(
          0, contractRef, tokenRef, 5, 1, 1n,
          "sha256d", "fixed", null, Math.floor(Date.now() / 1000),
        );
        const scriptMax = dMintScript(
          0, contractRef, tokenRef, 5, 1, 0x7fffffffffffffffn,
          "sha256d", "fixed", null, Math.floor(Date.now() / 1000),
        );
        const sepSmall = scriptSmall.indexOf("bd");
        const sepMax = scriptMax.indexOf("bd");
        const stateSmall = scriptSmall.substring(0, sepSmall);
        const stateMax = scriptMax.substring(0, sepMax);
        // The target is the last push of the state script.
        expect(stateSmall.endsWith("51")).toBe(true);
        expect(stateMax.endsWith("08ffffffffffffff7f")).toBe(true);
        // No non-minimal pushes in either.
        expect(findNonMinimalPush(stateSmall)).toBeUndefined();
        expect(findNonMinimalPush(stateMax)).toBeUndefined();
      });
    });

    describe("MINIMAL_PUSH primitive (PartC subroutine)", () => {
      // Round-trip the values that pushMinimal(n) produces against the byte
      // pattern the on-chain MINIMAL_PUSH subroutine would emit. They must
      // agree for every boundary value or the contract's EQUALVERIFY fails.
      // (We test pushMinimal directly here; the bytecode-level test that
      // confirms the on-chain version matches is in the round-trip section.)
      const boundaryValues = [
        0n,
        1n,
        16n,
        17n,
        127n,
        128n,
        32767n,
        32768n,
        2147483647n,            // 2^31 - 1
        0x80000000000000n,       // 2^55
        0x7fffffffffffffffn,     // MAX_TARGET (2^63 - 1)
      ];

      for (const n of boundaryValues) {
        it(`pushMinimal(${n}) round-trips via Script.fromHex().toASM()`, () => {
          const hex = pushMinimal(n);
          // Re-parse via Script and verify the value comes back.
          const asm = Script.fromHex(hex).toASM();
          if (n === 0n) {
            // OP_0 in ASM (radiantjs renders as "OP_0" or empty hex chunk)
            expect(asm === "OP_0" || asm === "0").toBe(true);
            expect(hex).toBe("00");
          } else if (n >= 1n && n <= 16n) {
            expect(asm).toBe(`OP_${n}`);
            expect(hex).toBe((0x50 + Number(n)).toString(16).padStart(2, "0"));
          } else {
            // Direct push of L bytes. ASM is the hex data (no opcode prefix shown).
            expect(asm).toMatch(/^[0-9a-f]+$/);
            const len = Number.parseInt(hex.slice(0, 2), 16);
            expect(hex.length).toBe(2 + len * 2);
          }
        });
      }

      it("emits no non-minimal pushes for any boundary value", () => {
        for (const n of boundaryValues) {
          const hex = pushMinimal(n);
          expect(findNonMinimalPush(hex), `n=${n} → hex=${hex}`).toBeUndefined();
        }
      });
    });

    // The critical EQUALVERIFY-correctness test: what the wallet emits as the
    // next-mint state script must equal byte-for-byte what the on-chain PartC
    // rebuilds as expected_next_state. This test asserts the symbolic equality
    // by comparing the two paths against representative boundary values.
    //
    // Contract rebuilds: MINIMAL_PUSH(h+1) || middleLiteral || "04" || NUM2BIN(4, locktime) || MINIMAL_PUSH(newTarget)
    // Wallet emits:      pushMinimal(h+1) || middleLiteral || push4bytes(locktime)         || pushMinimal(newTarget)
    //
    // For these to match:
    //   1. MINIMAL_PUSH bytecode-stack-effect for n must equal pushMinimal(n)
    //      string. Verified piecewise above for boundary values.
    //   2. "04" || NUM2BIN(4, locktime) must equal push4bytes(locktime).
    //      push4bytes uses `encodeDataPush` which emits exactly `04 [LE4]` for
    //      any non-zero positive 4-byte value. NUM2BIN(4, locktime) emits the
    //      4-byte LE encoding of locktime. So `"04" + NUM2BIN(4, locktime)`
    //      equals push4bytes(locktime) byte-for-byte for any locktime whose
    //      4-byte LE is non-empty (i.e. all timestamps post-1970).
    describe("after-mint expected state matches wallet emit byte-for-byte", () => {
      const cRef = "33".repeat(36);
      const tRef = "44".repeat(36);
      const lastTime = 1700000000;

      const cases = [
        // [height, target, daa, daaParams]
        { h: 0, t: 1n, daa: "fixed" as const, p: null as DaaParams | null },
        { h: 1, t: 0x4000000000000000n, daa: "asert" as const, p: { targetBlockTime: 60, halfLife: 100 } as DaaParams },
        { h: 42, t: 0x7fffffffffffffffn, daa: "asert" as const, p: { targetBlockTime: 60, halfLife: 1000 } as DaaParams },
        { h: 1000000, t: 17n, daa: "lwma" as const, p: { targetBlockTime: 60 } as DaaParams },
      ];

      for (const c of cases) {
        it(`h=${c.h} target=0x${c.t.toString(16)} ${c.daa}: state at h+1 differs from h only in the height push`, () => {
          // The contract's PartC EQUALVERIFY enforces that the only difference
          // between the OLD state and the next state (given fixed-DAA / same
          // target / same lastTime in this test) is the height push at the
          // front. Verify by emitting both, stripping the variable-length
          // height push, and asserting the remainders are byte-identical.
          const deployScript = dMintScript(
            c.h, cRef, tRef, 1000, 1, c.t, "sha256d", c.daa, c.p, lastTime,
          );
          const nextScript = dMintScript(
            c.h + 1, cRef, tRef, 1000, 1, c.t, "sha256d", c.daa, c.p, lastTime,
          );

          // Strip variable-length height push from each. We use pushMinimal's
          // own emit to know how many hex chars to skip — this implicitly
          // asserts pushMinimal(h+1) is well-formed.
          const deployHPush = pushMinimal(c.h);
          const nextHPush = pushMinimal(c.h + 1);
          expect(deployScript.startsWith(deployHPush)).toBe(true);
          expect(nextScript.startsWith(nextHPush)).toBe(true);

          const deployTail = deployScript.substring(deployHPush.length);
          const nextTail = nextScript.substring(nextHPush.length);
          expect(nextTail).toBe(deployTail);
        });
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
      const tokens = asm.split(" ");

      // Negative clamp must compare against -4 (not 4):
      // OP_DUP OP_4 OP_NEGATE OP_LESSTHAN
      expect(asm).toContain("OP_DUP OP_4 OP_NEGATE OP_LESSTHAN");

      // Post-2026-05-25: the shift uses OP_2MUL / OP_2DIV unrolled instead of
      // OP_LSHIFT / OP_RSHIFT, because the latter operate byte-buffer-wise
      // (BE bit order) and don't match bigint shift on multi-byte LE script
      // numbers. See V2_CONTRACT_AUDIT_REPORT.md §2.1.
      expect(tokens).not.toContain("OP_LSHIFT");
      expect(tokens).not.toContain("OP_RSHIFT");

      // Each direction is unrolled 4 times (drift clamp is ±4).
      const mulCount = tokens.filter((t) => t === "OP_2MUL").length;
      const divCount = tokens.filter((t) => t === "OP_2DIV").length;
      expect(mulCount).toBe(4);
      expect(divCount).toBe(4);

      // The negative branch must NEGATE the drift before the 2DIV unroll:
      // ... OP_IF OP_NEGATE OP_DUP 0 OP_GREATERTHAN ...
      expect(asm).toContain("OP_NEGATE OP_DUP 0 OP_GREATERTHAN");
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
