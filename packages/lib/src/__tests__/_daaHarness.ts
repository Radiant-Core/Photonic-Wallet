// Test-only harness: execute a dMint DAA bytecode body in the radiantjs script
// VM with a seeded stack, returning the resulting target as a bigint.
//
// The DAA body's entry stack (top→bottom) is [target, lastTime, targetTime, ...]
// and it begins with OP_TXLOCKTIME (c5) to push currentTime. For isolated unit
// testing we seed [targetTime, lastTime, target] and replace the leading c5 with
// a literal push of currentTime, then read the new target off the stack top.
//
// radiantjs uses unbounded bignum and does NOT enforce Radiant's int64
// overflow-abort, so this harness can only validate bytecode whose intermediates
// stay in int64 by construction (ASERT-v2 is proven to). It validates LOGIC
// (stack plumbing, opcode semantics, truncation directions) — radiantd on
// regtest remains the authoritative consensus gate.
import rjs from "@radiant-core/radiantjs";
import { pushMinimal } from "../script";

const { Script } = rjs as any;
const Interpreter = (rjs as any).Script.Interpreter;
const BN = (rjs as any).crypto.BN;

export const DAA_FLAGS =
  Interpreter.SCRIPT_ENABLE_MAGNETIC_OPCODES |
  Interpreter.SCRIPT_ENABLE_MONOLITH_OPCODES |
  Interpreter.SCRIPT_VERIFY_MINIMALDATA;

function bnBuf(v: bigint): Buffer {
  return new BN(v.toString()).toScriptNumBuffer();
}

function bufToBig(buf: Buffer): bigint {
  if (!buf || buf.length === 0) return 0n;
  return BigInt(BN.fromScriptNumBuffer(buf, false).toString());
}

/**
 * Run a DAA body (full bytecode incl. its leading OP_TXLOCKTIME) against a
 * seeded state and return the resulting target. Throws on script error.
 */
export function runDaaBody(
  fullBodyHex: string,
  oldTarget: bigint,
  lastTime: bigint,
  currentTime: bigint,
  targetTime: bigint
): bigint {
  if (!fullBodyHex.startsWith("c5")) {
    throw new Error("DAA body must start with OP_TXLOCKTIME (c5)");
  }
  // scriptSig seeds the stack bottom→top: targetTime, lastTime, target.
  const scriptSig = Script.fromHex(
    pushMinimal(targetTime) + pushMinimal(lastTime) + pushMinimal(oldTarget)
  );
  // scriptPubkey = the DAA body, with the leading OP_TXLOCKTIME (c5) replaced by
  // a literal push of currentTime so it runs without a tx context.
  const scriptPubkey = Script.fromHex(
    pushMinimal(currentTime) + fullBodyHex.slice(2)
  );

  const interp = new Interpreter();
  const ok = interp.verify(scriptSig, scriptPubkey, undefined, 0, DAA_FLAGS);
  if (!ok) {
    throw new Error(`script eval failed: ${interp.errstr}`);
  }
  // New target is the stack top after both scripts run. interp.stack is a Stack
  // object (not an array), so use its stacktop accessor.
  return bufToBig(interp.stack.stacktop(-1));
}

// silence unused-import lint when bnBuf path is not used
void bnBuf;
