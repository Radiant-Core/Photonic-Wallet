/**
 * V2-launch PartC ELSE_BRANCH end-to-end regression.
 *
 * Background: the 2026-05-26 V2-launch redesign (commit 03d58e1) shipped a
 * PartC ELSE_BRANCH whose first MINIMAL_PUSH consumed the wrong stack item,
 * making every V2-launch mint reject on mainnet with
 * `mandatory-script-verify-flag-failed (unknown error)`. The cause: at the
 * start of ELSE_BRANCH the stack is [outputIndex, cRef, newHeight] (newHeight
 * on top, cRef at depth-1). The emitted bytecode used `78` OP_OVER to "fetch
 * newHeight", but OP_OVER duplicates depth-1 — so MINIMAL_PUSH actually
 * received the 36-byte cRef. Its first internal op (OP_NUMEQUAL) caps script-
 * num operands at 8 bytes (Radiant-Core script.h:568,639), so the 36-byte
 * buffer trips INVALID_NUMBER_RANGE_64_BIT and the spend fails. Fixed by
 * changing OVER → DUP.
 *
 * What this file asserts (the structural + behavioral checks that would have
 * caught the bug at commit time, had they existed):
 *
 *  1. Locate the ELSE_BRANCH in the emitted code script and assert its first
 *     post-`78de519d` op is `76` (OP_DUP). A regression to `78` (OP_OVER) is
 *     immediately visible.
 *
 *  2. Execute the ELSE_BRANCH in a focused stack simulator (modelled on
 *     Radiant-Core src/script/interpreter.cpp) starting from the known post-
 *     prologue stack [outputIndex, cRef, newHeight] with newTarget on alt
 *     stack. Walk every opcode the branch uses (DUP, OVER, SWAP, CAT, NUM2BIN,
 *     NUMEQUAL, TXLOCKTIME, FROMALTSTACK, the nested-IF MINIMAL_PUSH primitive,
 *     direct-pushes, PUSHDATA1). Compare the buffer the simulator leaves on top
 *     against `dMintScript(height+1, ...)` byte-for-byte — that buffer IS the
 *     `expected_next_state` the on-chain OP_EQUALVERIFY checks.
 *
 *  3. Exercise the full 3×4 matrix of (algo, daa) combos at boundary heights
 *     and targets, so any opcode-encoding asymmetry between branches surfaces
 *     here rather than on mainnet.
 *
 * The simulator deliberately enforces Radiant-Core's 8-byte script-num cap on
 * NUMEQUAL/NUM2BIN inputs (MAXIMUM_ELEMENT_SIZE_64_BIT, script.h:568). That
 * cap is what catches the OVER-vs-DUP bug: with `78` the simulator throws at
 * MINIMAL_PUSH's first OP_NUMEQUAL, exactly as radiantd does on chain.
 */

import { describe, it, expect } from "vitest";
import { dMintScript, pushMinimal } from "../script";

const CONTRACT_REF = "11".repeat(36);
const TOKEN_REF = "22".repeat(36);
const FIXED_LAST_TIME = 1_700_000_000;

/**
 * Locate the PartC ELSE_BRANCH inside the dmint code script.
 *
 * The IF branch is fixed-length (`6c75 5279cd01d853797e016a7e88` = 13 bytes),
 * so we anchor on it and the surrounding `63` IF and `67` ELSE markers.
 * Returns the hex starting immediately after the `67` ELSE marker and ending
 * just before the closing `686d7551` (ENDIF 2DROP DROP 1).
 */
function extractElseBranch(scriptHex: string): string {
  const ifBranch = "6c755279cd01d853797e016a7e88";
  const elseMarker = "67";
  const epilogue = "686d7551";
  const ifIdx = scriptHex.indexOf(ifBranch);
  if (ifIdx < 0) {
    throw new Error("IF branch marker not found in script");
  }
  const elseStart = ifIdx + ifBranch.length + elseMarker.length;
  // `67` is at ifIdx + ifBranch.length
  const slot = scriptHex.slice(ifIdx + ifBranch.length, ifIdx + ifBranch.length + 2);
  if (slot !== elseMarker) {
    throw new Error(`expected 67 after IF body, got ${slot}`);
  }
  const epilogueIdx = scriptHex.lastIndexOf(epilogue);
  if (epilogueIdx < 0 || epilogueIdx <= elseStart) {
    throw new Error("epilogue marker missing/misplaced");
  }
  return scriptHex.slice(elseStart, epilogueIdx);
}

// ─── Minimal Radiant-Core-faithful script simulator ────────────────────────
//
// Models only the opcodes PartC ELSE_BRANCH uses. Stack items are Uint8Array.
// Where the interpreter would convert a buffer to a script-num (NUMEQUAL,
// NUM2BIN, IF condition, ADD), we enforce the 8-byte cap that catches the
// original bug.

type Stack = Uint8Array[];

const MAXIMUM_ELEMENT_SIZE_64_BIT = 8;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
function unhex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}

/** Decode a stack value as a Radiant int64 script-num (LE, sign-magnitude). */
function vchToNum(vch: Uint8Array): bigint {
  if (vch.length === 0) return 0n;
  if (vch.length > MAXIMUM_ELEMENT_SIZE_64_BIT) {
    throw new Error(
      `INVALID_NUMBER_RANGE_64_BIT: ${vch.length} > ${MAXIMUM_ELEMENT_SIZE_64_BIT} bytes`
    );
  }
  let result = 0n;
  for (let i = 0; i < vch.length; i++) {
    result |= BigInt(vch[i]) << (8n * BigInt(i));
  }
  const top = vch[vch.length - 1];
  if (top & 0x80) {
    const mask = ~(0x80n << (8n * BigInt(vch.length - 1)));
    result &= mask;
    result = -result;
  }
  return result;
}

/** Encode a bigint as a minimal LE sign-magnitude script-num buffer. */
function numToVch(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  const neg = n < 0n;
  let abs = neg ? -n : n;
  const bytes: number[] = [];
  while (abs > 0n) {
    bytes.push(Number(abs & 0xffn));
    abs >>= 8n;
  }
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(neg ? 0x80 : 0x00);
  } else if (neg) {
    bytes[bytes.length - 1] |= 0x80;
  }
  return new Uint8Array(bytes);
}

/** OP_NUM2BIN: pad/truncate value to exactly `size` bytes, sign in top byte. */
function num2bin(value: bigint, size: number): Uint8Array {
  if (size < 0 || size > 520) throw new Error("OP_NUM2BIN: invalid size");
  const neg = value < 0n;
  let abs = neg ? -value : value;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = Number(abs & 0xffn);
    abs >>= 8n;
  }
  if (abs > 0n) throw new Error("OP_NUM2BIN: IMPOSSIBLE_ENCODING (overflow)");
  if (neg) out[size - 1] |= 0x80;
  return out;
}

function pop(stack: Stack): Uint8Array {
  const v = stack.pop();
  if (v === undefined) throw new Error("stack underflow");
  return v;
}
function popN(stack: Stack, n: number): Uint8Array[] {
  if (stack.length < n) throw new Error("stack underflow");
  return Array.from({ length: n }, () => pop(stack)).reverse();
}

/**
 * Execute the PartC ELSE_BRANCH starting with the post-prologue stack and the
 * alt-stack newTarget produced by PartB4. Return the buffer left on top of the
 * main stack just before the trailing EQUALVERIFY sequence consumes it — that
 * is the `expected_next_state` reconstruction.
 *
 * The ELSE_BRANCH ends with three `3 PICK <introspection> EQUALVERIFY` triples
 * and a final DROP. Those triples require live tx context (output value/code/
 * state), which the simulator doesn't have. To isolate the reconstruction
 * logic, we stop at the first `5379ec7888` (start of the EQUALVERIFY chain)
 * and return what's on top — that's exactly the buffer the on-chain check
 * compares against output[outputIndex].statescript.
 */
function simulateElseReconstruction(
  branchHex: string,
  ctx: {
    outputIndex: bigint;
    cRef: Uint8Array;
    newHeight: bigint;
    newTarget: bigint;
    nLockTime: number;
  }
): Uint8Array {
  const stack: Stack = [
    numToVch(ctx.outputIndex),
    ctx.cRef,
    numToVch(ctx.newHeight),
  ];
  const altStack: Stack = [numToVch(ctx.newTarget)];

  const bytes = unhex(branchHex);
  let pc = 0;
  // Track IF/ELSE branch execution (Radiant-Core vfExec stack).
  const vfExec: boolean[] = [];

  const isExec = () => vfExec.every((v) => v);

  while (pc < bytes.length) {
    const op = bytes[pc++];

    // Anchor: stop at the start of the EQUALVERIFY chain (53 79 ec 78 88).
    if (
      op === 0x53 &&
      bytes[pc] === 0x79 &&
      bytes[pc + 1] === 0xec &&
      bytes[pc + 2] === 0x78 &&
      bytes[pc + 3] === 0x88
    ) {
      const top = stack[stack.length - 1];
      if (!top) throw new Error("simulator stopped with empty stack");
      return top;
    }

    // Direct push (1..75)
    if (op >= 0x01 && op <= 0x4b) {
      const data = bytes.slice(pc, pc + op);
      pc += op;
      if (isExec()) stack.push(new Uint8Array(data));
      continue;
    }
    // PUSHDATA1
    if (op === 0x4c) {
      const len = bytes[pc++];
      const data = bytes.slice(pc, pc + len);
      pc += len;
      if (isExec()) stack.push(new Uint8Array(data));
      continue;
    }

    if (!isExec()) {
      // Inside a skipped branch: only IF/ELSE/ENDIF affect control flow.
      switch (op) {
        case 0x63: // OP_IF
        case 0x64: // OP_NOTIF
          vfExec.push(false);
          continue;
        case 0x67: // OP_ELSE
          if (vfExec.length === 0) throw new Error("ELSE without IF");
          vfExec[vfExec.length - 1] = !vfExec[vfExec.length - 1];
          continue;
        case 0x68: // OP_ENDIF
          if (vfExec.length === 0) throw new Error("ENDIF without IF");
          vfExec.pop();
          continue;
        default:
          continue;
      }
    }

    switch (op) {
      case 0x00: // OP_0 (push empty)
        stack.push(new Uint8Array(0));
        break;
      case 0x4f: // OP_1NEGATE
        stack.push(numToVch(-1n));
        break;
      case 0x50: // OP_RESERVED
        throw new Error("OP_RESERVED");
      case 0x51:
      case 0x52:
      case 0x53:
      case 0x54:
      case 0x55:
      case 0x56:
      case 0x57:
      case 0x58:
      case 0x59:
      case 0x5a:
      case 0x5b:
      case 0x5c:
      case 0x5d:
      case 0x5e:
      case 0x5f:
      case 0x60: // OP_1..OP_16
        stack.push(numToVch(BigInt(op - 0x50)));
        break;
      case 0x63: // OP_IF
      case 0x64: { // OP_NOTIF
        const v = pop(stack);
        let cond = vchToNum(v) !== 0n;
        if (op === 0x64) cond = !cond;
        vfExec.push(cond);
        break;
      }
      case 0x67: // OP_ELSE
        if (vfExec.length === 0) throw new Error("ELSE without IF");
        vfExec[vfExec.length - 1] = !vfExec[vfExec.length - 1];
        break;
      case 0x68: // OP_ENDIF
        if (vfExec.length === 0) throw new Error("ENDIF without IF");
        vfExec.pop();
        break;
      case 0x6b: { // OP_TOALTSTACK
        altStack.push(pop(stack));
        break;
      }
      case 0x6c: { // OP_FROMALTSTACK
        const v = altStack.pop();
        if (v === undefined) throw new Error("alt stack underflow");
        stack.push(v);
        break;
      }
      case 0x6d: { // OP_2DROP
        pop(stack);
        pop(stack);
        break;
      }
      case 0x75: { // OP_DROP
        pop(stack);
        break;
      }
      case 0x76: { // OP_DUP
        const top = stack[stack.length - 1];
        if (!top) throw new Error("DUP: stack underflow");
        stack.push(new Uint8Array(top));
        break;
      }
      case 0x78: { // OP_OVER
        const v = stack[stack.length - 2];
        if (!v) throw new Error("OVER: stack underflow");
        stack.push(new Uint8Array(v));
        break;
      }
      case 0x7c: { // OP_SWAP
        const [a, b] = popN(stack, 2);
        stack.push(b, a);
        break;
      }
      case 0x7e: { // OP_CAT
        const [a, b] = popN(stack, 2);
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        stack.push(out);
        break;
      }
      case 0x80: { // OP_NUM2BIN
        const sizeVch = pop(stack);
        const valueVch = pop(stack);
        const size = Number(vchToNum(sizeVch));
        const value = vchToNum(valueVch);
        stack.push(num2bin(value, size));
        break;
      }
      case 0x82: { // OP_SIZE
        const top = stack[stack.length - 1];
        if (!top) throw new Error("SIZE: stack underflow");
        stack.push(numToVch(BigInt(top.length)));
        break;
      }
      case 0x93: { // OP_ADD
        const [a, b] = popN(stack, 2);
        stack.push(numToVch(vchToNum(a) + vchToNum(b)));
        break;
      }
      case 0x69: { // OP_VERIFY
        const v = pop(stack);
        if (vchToNum(v) === 0n) {
          throw new Error("OP_VERIFY failed");
        }
        break;
      }
      case 0x88: { // OP_EQUALVERIFY
        const [a, b] = popN(stack, 2);
        if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) {
          throw new Error("OP_EQUALVERIFY failed");
        }
        break;
      }
      case 0x9c: { // OP_NUMEQUAL
        const [a, b] = popN(stack, 2);
        // Triggers INVALID_NUMBER_RANGE_64_BIT on >8-byte operands — this is
        // the radiantd check that catches the OVER-vs-DUP bug.
        const aNum = vchToNum(a);
        const bNum = vchToNum(b);
        stack.push(aNum === bNum ? numToVch(1n) : new Uint8Array(0));
        break;
      }
      case 0x9d: { // OP_NUMEQUALVERIFY
        const [a, b] = popN(stack, 2);
        if (vchToNum(a) !== vchToNum(b)) {
          throw new Error("OP_NUMEQUALVERIFY failed");
        }
        break;
      }
      case 0xa1: { // OP_LESSTHANOREQUAL
        const [a, b] = popN(stack, 2);
        stack.push(vchToNum(a) <= vchToNum(b) ? numToVch(1n) : new Uint8Array(0));
        break;
      }
      case 0xc5: { // OP_TXLOCKTIME
        stack.push(numToVch(BigInt(ctx.nLockTime)));
        break;
      }
      case 0xde: { // OP_REFOUTPUTCOUNT_OUTPUTS (mocked: cRef appears in 1 output)
        const ref = pop(stack);
        if (ref.length !== 36) {
          throw new Error("REFOUTPUTCOUNT_OUTPUTS: refAssetId must be 36 bytes");
        }
        // Singleton preservation: assume the spending tx is well-formed and
        // produces exactly one output with cRef.
        stack.push(numToVch(1n));
        break;
      }
      default:
        throw new Error(
          `simulator does not implement opcode 0x${op.toString(16)} at pc=${pc - 1}`
        );
    }
  }

  // Reached end of branch without hitting the EQUALVERIFY chain anchor.
  const top = stack[stack.length - 1];
  if (!top) throw new Error("ELSE branch ended with empty stack");
  return top;
}

/** Compose the next-mint state script the wallet would emit for height+1. */
function nextStateExpect(opts: {
  prevHeight: number;
  contractRef: string;
  tokenRef: string;
  maxHeight: number;
  reward: number;
  newTarget: bigint;
  algorithm: "sha256d" | "blake3" | "k12";
  daaMode: "fixed" | "asert" | "lwma";
  daaParams: Parameters<typeof dMintScript>[8];
  nLockTime: number;
}): string {
  // dMintScript output layout: [stateScript] || "bd" || codeScript.
  // For verification we want only the state script.
  const full = dMintScript(
    opts.prevHeight + 1,
    opts.contractRef,
    opts.tokenRef,
    opts.maxHeight,
    opts.reward,
    opts.newTarget,
    opts.algorithm,
    opts.daaMode,
    opts.daaParams,
    opts.nLockTime,
  );
  const sep = full.indexOf("bd");
  return full.slice(0, sep);
}

describe("V2-launch PartC ELSE_BRANCH end-to-end (mainnet rejection regression)", () => {
  // ─── 1. Structural assertion: OVER → DUP ─────────────────────────────────
  it("first opcode after the singleton-preservation check is OP_DUP (0x76), not OP_OVER (0x78)", () => {
    const script = dMintScript(
      0,
      CONTRACT_REF,
      TOKEN_REF,
      100,
      1,
      0x7fffffffffffffffn,
      "sha256d",
      "fixed",
      null,
      FIXED_LAST_TIME,
    );
    const branch = extractElseBranch(script);
    // ELSE_BRANCH layout: `78de519d` || <next op> || MINIMAL_PUSH_BYTECODE …
    expect(branch.slice(0, 8)).toBe("78de519d");
    const nextOp = branch.slice(8, 10);
    expect(
      nextOp,
      "PartC ELSE_BRANCH must use OP_DUP (0x76) for newHeight, not OP_OVER " +
        "(0x78). OP_OVER would dup cRef (36 bytes) and trip " +
        "INVALID_NUMBER_RANGE_64_BIT inside MINIMAL_PUSH's OP_NUMEQUAL."
    ).toBe("76");
  });

  // ─── 2. The bug surface itself ───────────────────────────────────────────
  it("simulator throws INVALID_NUMBER_RANGE_64_BIT if ELSE_BRANCH dups cRef instead of newHeight", () => {
    // Synthesise the broken ELSE_BRANCH (the pre-fix wallet emit) by swapping
    // the 0x76 back to 0x78 in the freshly-emitted bytecode. The simulator
    // should reject it exactly the way radiantd does.
    const script = dMintScript(
      0,
      CONTRACT_REF,
      TOKEN_REF,
      100,
      1,
      0x7fffffffffffffffn,
      "sha256d",
      "fixed",
      null,
      FIXED_LAST_TIME,
    );
    const goodBranch = extractElseBranch(script);
    expect(goodBranch.slice(0, 10)).toBe("78de519d76");
    const brokenBranch = "78de519d78" + goodBranch.slice(10);

    expect(() =>
      simulateElseReconstruction(brokenBranch, {
        outputIndex: 0n,
        cRef: unhex(CONTRACT_REF),
        newHeight: 1n,
        newTarget: 0x7fffffffffffffffn,
        nLockTime: FIXED_LAST_TIME + 60,
      })
    ).toThrow(/INVALID_NUMBER_RANGE_64_BIT/);
  });

  // ─── 3. Behavioural matrix: simulator reconstruction == wallet next-state ─
  type Combo = {
    algorithm: "sha256d" | "blake3" | "k12";
    daaMode: "fixed" | "asert" | "lwma";
    daaParams: Parameters<typeof dMintScript>[8];
  };
  const combos: Combo[] = [
    { algorithm: "sha256d", daaMode: "fixed", daaParams: null },
    { algorithm: "sha256d", daaMode: "asert", daaParams: { targetBlockTime: 60, halfLife: 3600 } },
    { algorithm: "sha256d", daaMode: "lwma",  daaParams: { targetBlockTime: 60 } },
    { algorithm: "blake3",  daaMode: "fixed", daaParams: null },
    { algorithm: "blake3",  daaMode: "asert", daaParams: { targetBlockTime: 60, halfLife: 3600 } },
    { algorithm: "blake3",  daaMode: "lwma",  daaParams: { targetBlockTime: 60 } },
    { algorithm: "k12",     daaMode: "fixed", daaParams: null },
    { algorithm: "k12",     daaMode: "asert", daaParams: { targetBlockTime: 60, halfLife: 3600 } },
    { algorithm: "k12",     daaMode: "lwma",  daaParams: { targetBlockTime: 60 } },
  ];

  // Boundary heights chosen so pushMinimal hits each width class:
  //   0 → OP_0; 1..16 → OP_N; 17 → 1-byte literal; 128 → 2-byte (sign byte);
  //   65535 → 3-byte; ... and a near-maxHeight final-but-one (h+1 < mh).
  const heightCases = [
    { prevHeight: 0, maxHeight: 10 },
    { prevHeight: 15, maxHeight: 100 },     // h+1=16 → OP_16 (1 byte)
    { prevHeight: 16, maxHeight: 100 },     // h+1=17 → "01 11" (2 bytes)
    { prevHeight: 127, maxHeight: 1000 },   // h+1=128 → "02 8000" (3 bytes, sign)
    { prevHeight: 65534, maxHeight: 100000 }, // h+1=65535 → "03 ffff00" (4 bytes)
  ];
  const targetCases: bigint[] = [
    1n,                          // OP_1
    16n,                         // OP_16
    17n,                         // 1-byte literal
    0xffn,                       // 2-byte (sign byte needed)
    0x100n,                      // 2-byte
    0x7fffffffffffffffn,         // 8-byte MAX_TARGET
  ];

  for (const c of combos) {
    for (const h of heightCases) {
      for (const t of targetCases) {
        const label = `${c.algorithm}/${c.daaMode} h=${h.prevHeight}→${h.prevHeight + 1} (mh=${h.maxHeight}) target=0x${t.toString(16)}`;
        it(`simulated PartC reconstruction byte-matches wallet next-state: ${label}`, () => {
          const deployScript = dMintScript(
            h.prevHeight,
            CONTRACT_REF,
            TOKEN_REF,
            h.maxHeight,
            1,
            t,
            c.algorithm,
            c.daaMode,
            c.daaParams,
            FIXED_LAST_TIME,
          );
          const branch = extractElseBranch(deployScript);
          const newLockTime = FIXED_LAST_TIME + 60;

          // For this test we don't run a DAA computation — we just assert that
          // for a given (newTarget, newLockTime) the simulator reproduces the
          // wallet's emit. The DAA correctness is covered by other tests.
          const reconstructed = simulateElseReconstruction(branch, {
            outputIndex: 0n,
            cRef: unhex(CONTRACT_REF),
            newHeight: BigInt(h.prevHeight + 1),
            newTarget: t,
            nLockTime: newLockTime,
          });

          const expected = nextStateExpect({
            prevHeight: h.prevHeight,
            contractRef: CONTRACT_REF,
            tokenRef: TOKEN_REF,
            maxHeight: h.maxHeight,
            reward: 1,
            newTarget: t,
            algorithm: c.algorithm,
            daaMode: c.daaMode,
            daaParams: c.daaParams,
            nLockTime: newLockTime,
          });

          expect(hex(reconstructed)).toBe(expected);
        });
      }
    }
  }

  // ─── 4. nLockTime-zero failure mode (miner-side fixed-DAA bug) ───────────
  it("fixed-DAA reconstruction with nLockTime=0 produces a state that differs from wallet's next-state lastTime push", () => {
    // Establishes the second half of the diagnosis: even if the wallet PartC
    // is correct, a miner that fails to set nLockTime for fixed-DAA contracts
    // will build a next-state with `04 <Date.now() LE>` while the on-chain
    // reconstruction produces `04 00000000`. The two must differ at the
    // lastTime push only.
    const deployScript = dMintScript(
      0, CONTRACT_REF, TOKEN_REF, 100, 1, 0x7fffffffffffffffn,
      "sha256d", "fixed", null, FIXED_LAST_TIME,
    );
    const branch = extractElseBranch(deployScript);
    const withZero = simulateElseReconstruction(branch, {
      outputIndex: 0n,
      cRef: unhex(CONTRACT_REF),
      newHeight: 1n,
      newTarget: 0x7fffffffffffffffn,
      nLockTime: 0,
    });
    const withRealClock = nextStateExpect({
      prevHeight: 0,
      contractRef: CONTRACT_REF,
      tokenRef: TOKEN_REF,
      maxHeight: 100,
      reward: 1,
      newTarget: 0x7fffffffffffffffn,
      algorithm: "sha256d",
      daaMode: "fixed",
      daaParams: null,
      nLockTime: FIXED_LAST_TIME + 60,
    });
    expect(hex(withZero)).not.toBe(withRealClock);
    // Sanity: a matching call with nLockTime=0 on both sides DOES align.
    const withZeroBoth = nextStateExpect({
      prevHeight: 0,
      contractRef: CONTRACT_REF,
      tokenRef: TOKEN_REF,
      maxHeight: 100,
      reward: 1,
      newTarget: 0x7fffffffffffffffn,
      algorithm: "sha256d",
      daaMode: "fixed",
      daaParams: null,
      nLockTime: 0,
    });
    expect(hex(withZero)).toBe(withZeroBoth);
  });
});

// ─── pushMinimal ↔ on-chain MINIMAL_PUSH primitive equivalence ────────────
//
// The simulator above proves PartC produces the right bytes given correct
// nLockTime + newTarget. This describe block tightens the loop on the
// MINIMAL_PUSH subroutine specifically: for every boundary value, run the
// 21-byte on-chain primitive against the value and confirm it emits the same
// byte sequence as the wallet's `pushMinimal` helper. A drift between the two
// would re-introduce the same class of EQUALVERIFY failure.
describe("MINIMAL_PUSH primitive matches pushMinimal byte-for-byte", () => {
  const MINIMAL_PUSH_BYTECODE =
    "76009c63" +     // DUP 0 NUMEQUAL IF
    "75" + "0100" +   //   DROP, PUSH(1) 0x00
    "67" +            // ELSE
    "76" + "60" + "a163" + //   DUP 16 LE IF
    "0150" + "93" + "51" + "80" + //     PUSH(1) 0x50, ADD, 1, NUM2BIN
    "67" +            //   ELSE
    "82" + "7c" + "7e" + //     SIZE SWAP CAT
    "68" +            //   ENDIF
    "68";             // ENDIF

  const boundary = [
    0n,
    1n,
    16n,
    17n,
    127n,
    128n,
    255n,
    256n,
    32767n,
    32768n,
    0xffffn,
    0x10000n,
    0xffffffffn,
    0x7fffffffffffffffn,
  ];

  for (const n of boundary) {
    it(`n=${n}: simulator emits identical bytes to pushMinimal`, () => {
      const stack: Stack = [numToVch(n)];
      const altStack: Stack = [];
      const branch = MINIMAL_PUSH_BYTECODE;
      // Reuse the same simulator — but it stops only at the EQUALVERIFY anchor,
      // which doesn't appear here. Inline a focused executor instead.
      const bytes = unhex(branch);
      let pc = 0;
      const vfExec: boolean[] = [];
      const isExec = () => vfExec.every((v) => v);
      void altStack;
      while (pc < bytes.length) {
        const op = bytes[pc++];
        // Direct pushes must advance pc past their data even when skipped, or
        // the next loop iteration mis-decodes the data bytes as opcodes.
        if (op >= 0x01 && op <= 0x4b) {
          const data = bytes.slice(pc, pc + op);
          pc += op;
          if (isExec()) stack.push(new Uint8Array(data));
          continue;
        }
        if (!isExec()) {
          // In a skipped branch, only IF/NOTIF/ELSE/ENDIF can change vfExec;
          // they MUST NOT pop the stack — IF in a skipped branch just nests.
          switch (op) {
            case 0x63:
            case 0x64:
              vfExec.push(false);
              continue;
            case 0x67:
              vfExec[vfExec.length - 1] = !vfExec[vfExec.length - 1];
              continue;
            case 0x68:
              vfExec.pop();
              continue;
            default:
              continue;
          }
        }
        switch (op) {
          case 0x00: stack.push(new Uint8Array(0)); break;
          case 0x51: case 0x52: case 0x53: case 0x54: case 0x55:
          case 0x56: case 0x57: case 0x58: case 0x59: case 0x5a:
          case 0x5b: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
          case 0x60: stack.push(numToVch(BigInt(op - 0x50))); break;
          case 0x63: case 0x64: {
            const v = pop(stack);
            let cond = vchToNum(v) !== 0n;
            if (op === 0x64) cond = !cond;
            vfExec.push(cond);
            break;
          }
          case 0x67:
            vfExec[vfExec.length - 1] = !vfExec[vfExec.length - 1];
            break;
          case 0x68: vfExec.pop(); break;
          case 0x75: pop(stack); break;
          case 0x76: {
            const top = stack[stack.length - 1];
            stack.push(new Uint8Array(top));
            break;
          }
          case 0x7c: {
            const [a, b] = popN(stack, 2);
            stack.push(b, a);
            break;
          }
          case 0x7e: {
            const [a, b] = popN(stack, 2);
            const out = new Uint8Array(a.length + b.length);
            out.set(a, 0);
            out.set(b, a.length);
            stack.push(out);
            break;
          }
          case 0x80: {
            const sizeVch = pop(stack);
            const valueVch = pop(stack);
            stack.push(num2bin(vchToNum(valueVch), Number(vchToNum(sizeVch))));
            break;
          }
          case 0x82: {
            const top = stack[stack.length - 1];
            stack.push(numToVch(BigInt(top.length)));
            break;
          }
          case 0x93: {
            const [a, b] = popN(stack, 2);
            stack.push(numToVch(vchToNum(a) + vchToNum(b)));
            break;
          }
          case 0x9c: {
            const [a, b] = popN(stack, 2);
            stack.push(vchToNum(a) === vchToNum(b) ? numToVch(1n) : new Uint8Array(0));
            break;
          }
          case 0xa1: {
            const [a, b] = popN(stack, 2);
            stack.push(vchToNum(a) <= vchToNum(b) ? numToVch(1n) : new Uint8Array(0));
            break;
          }
          default:
            throw new Error(`unsupported opcode 0x${op.toString(16)}`);
        }
      }
      const top = stack[stack.length - 1];
      expect(hex(top)).toBe(pushMinimal(n));
    });
  }
});
