//import { Address, Opcode, Script } from "@radiant-core/radiantjs";
import rjs from "@radiant-core/radiantjs";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import { glyphMagicBytesBuffer, glyphMagicBytesHex } from "./token";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { TokenContractType } from "./types";
import {
  bigIntToVmNumber,
  encodeDataPush,
  numberToBinUint32LEClamped,
} from "@bitauth/libauth";

const { Address, Opcode, Script } = rjs;

// NOTE: All ref inputs for script functions must be little-endian

// Size of scripts (not including length VarInt)
export const p2pkhScriptSize = 25;
export const nftScriptSize = 63;
export const ftScriptSize = 75;
export const delegateTokenScriptSize = 63;
export const delegateBurnScriptSize = 42;
export const p2pkhScriptSigSize = 107;
export const mutableNftScriptSize = 175;

const zeroRef = "00".repeat(36);

export function varIntSize(n: number) {
  if (n < 253) {
    return 1;
  } else if (n <= 65535) {
    return 3;
  } else if (n <= 4294967295) {
    return 5;
  } else if (n <= 18446744073709551615n) {
    return 9;
  } else {
    throw new Error("Invalid VarInt");
  }
}

export function pushDataSize(len: number) {
  if (len >= 0 && len < Opcode.OP_PUSHDATA1) {
    return 1;
  } else if (len < Math.pow(2, 8)) {
    return 2;
  } else if (len < Math.pow(2, 16)) {
    return 3;
  } else if (len < Math.pow(2, 32)) {
    return 4;
  }
  throw new Error("Invalid push data length");
}

// Transaction size without scripts (not including input/output script size VarInt and script)
export function baseTxSize(numInputs: number, numOutputs: number) {
  return (
    4 + // version
    varIntSize(numInputs) + // Input count
    (32 + // Prev tx hash
      4 + // Prev tx index
      4) * // Sequence num
      numInputs +
    varIntSize(numOutputs) + // Output count
    8 * // Value
      numOutputs +
    4 // nLockTime
  );
}

// Calcualte size of a transaction, given sizes of input and output scripts
export function txSize(
  inputScriptSizes: number[],
  outputScriptSizes: number[]
) {
  return (
    baseTxSize(inputScriptSizes.length, outputScriptSizes.length) +
    inputScriptSizes.reduce((a, s) => a + varIntSize(s) + s, 0) +
    outputScriptSizes.reduce((a, s) => a + varIntSize(s) + s, 0)
  );
}

export function revealScriptSigSize(glyphMagicBytesLen: number) {
  return p2pkhScriptSigSize + glyphMagicBytesLen;
}

export function commitScriptSize(
  contract: TokenContractType,
  hasDelegate: boolean
) {
  const opSize = {
    ft: 9,
    nft: 10,
    dat: 0,
  };
  return 71 + opSize[contract] + (hasDelegate ? 56 : 0);
}

export function scriptHash(hex: string): string {
  // Guard: hashing the empty script silently produces a constant — the
  // sha256("") digest — which has historically masked upstream bugs where
  // p2pkhScript() / payToScript() / nftScript() returned "" from a swallowed
  // exception. Surface the failure here instead of letting it propagate as
  // a meaningless ElectrumX subscription target.
  if (!hex) {
    throw new Error("scriptHash: cannot hash empty script");
  }
  return Buffer.from(sha256(Buffer.from(hex, "hex")))
    .reverse()
    .toString("hex");
}

export function p2pkhScript(address: string): string {
  try {
    return Script.buildPublicKeyHashOut(address).toHex();
  } catch (err) {
    // The previous version returned "" here, which then flowed into
    // scriptHash() and produced a meaningless constant. Surface the real
    // failure so callers (UI flows, subscription paths) see a clear
    // signal instead of a silent dead address.
    throw new Error(
      `p2pkhScript: invalid address ${JSON.stringify(address)}: ${String(err)}`
    );
  }
}

// Handles p2pkh and p2sh
export function payToScript(address: string): string {
  try {
    return Script.fromAddress(address).toHex();
  } catch (err) {
    throw new Error(
      `payToScript: invalid address ${JSON.stringify(address)}: ${String(err)}`
    );
  }
}

/**
 * Boolean predicate: returns false for any input that isn't a valid P2PKH
 * address. The `try/catch → false` here is intentional — callers use this
 * as input validation. Distinct from the throwing wrappers above.
 */
export function isP2pkh(address: string): boolean {
  try {
    const addr = new Address(address);
    return addr.type === "pubkeyhash";
  } catch {
    return false;
  }
}

export function p2pkhScriptHash(address: string): string {
  return scriptHash(p2pkhScript(address));
}

// Delegate ref is used for assigning related refs to the token
// The delegate burn code script hash must be in an output. This output will prove the delegate ref exists in an input.
function addDelegateRefScript(
  script: rjs.Script,
  delegateRef: string
): rjs.Script {
  script.add(
    Script.fromASM(
      `OP_PUSHINPUTREF ${delegateRef} OP_DUP ` +
        `OP_REFOUTPUTCOUNT_OUTPUTS OP_0 OP_NUMEQUALVERIFY ` + // Push ref disallowed
        `d1 OP_SWAP 6a0364656c OP_CAT OP_CAT OP_HASH256 OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS OP_1 OP_NUMEQUALVERIFY` // Ref must be burned using REQUIREINPUTREF RETURN
    )
  );
  return script;
}

export function ftCommitScript(
  address: string,
  payloadHash: string,
  delegateRef: string | undefined
) {
  const script = new Script();

  if (delegateRef) {
    addDelegateRefScript(script, delegateRef);
  }

  // Check payload hash
  script
    .add(Opcode.OP_HASH256)
    .add(Buffer.from(payloadHash, "hex"))
    .add(Opcode.OP_EQUALVERIFY);
  // gly
  script.add(glyphMagicBytesBuffer).add(Opcode.OP_EQUALVERIFY);
  // Ensure normal ref for this input exists in an output.
  //
  // R17 decision (2026-05-21): supply is NOT enforced at this layer.
  // Rationale: the matching output is permitted to be a PoW mint
  // contract (dmint) which produces tokens without providing a fixed
  // photon supply at the script level. Enforcing supply here would
  // make dmint reveals fail validation. Supply caps for non-dmint
  // mints are enforced upstream by the bundle/schema layer.
  script.add(
    Script.fromASM(
      "OP_INPUTINDEX OP_OUTPOINTTXHASH OP_INPUTINDEX OP_OUTPOINTINDEX OP_4 OP_NUM2BIN OP_CAT OP_REFTYPE_OUTPUT OP_1 OP_NUMEQUALVERIFY"
    )
  );

  // P2PKH
  script.add(Script.buildPublicKeyHashOut(Address.fromString(address)));

  return script.toHex();
}

export function nftCommitScript(
  address: string,
  payloadHash: string,
  delegateRef: string | undefined
) {
  const script = new Script();

  if (delegateRef) {
    addDelegateRefScript(script, delegateRef);
  }

  // Check payload hash
  script
    .add(Opcode.OP_HASH256)
    .add(Buffer.from(payloadHash, "hex"))
    .add(Opcode.OP_EQUALVERIFY);
  // gly
  script.add(glyphMagicBytesBuffer).add(Opcode.OP_EQUALVERIFY);
  // Ensure singleton for this input exists in an output
  script.add(
    Script.fromASM(
      "OP_INPUTINDEX OP_OUTPOINTTXHASH OP_INPUTINDEX OP_OUTPOINTINDEX OP_4 OP_NUM2BIN OP_CAT OP_REFTYPE_OUTPUT OP_2 OP_NUMEQUALVERIFY"
    )
  );

  // P2PKH
  script.add(Script.buildPublicKeyHashOut(Address.fromString(address)));

  return script.toHex();
}

// dat is used for data storage. Similar to nft but no singleton is created.
export function datCommitScript(
  address: string,
  payloadHash: string,
  delegateRef: string | undefined
) {
  const script = new Script();

  if (delegateRef) {
    addDelegateRefScript(script, delegateRef);
  }

  // Check payload hash
  script
    .add(Opcode.OP_HASH256)
    .add(Buffer.from(payloadHash, "hex"))
    .add(Opcode.OP_EQUALVERIFY);
  // gly dat
  script
    .add(Buffer.from("dat"))
    .add(Opcode.OP_EQUALVERIFY)
    .add(glyphMagicBytesBuffer)
    .add(Opcode.OP_EQUALVERIFY);

  // P2PKH
  script.add(Script.buildPublicKeyHashOut(Address.fromString(address)));

  return script.toHex();
}

export function nftScript(address: string, ref: string) {
  try {
    const script = Script.fromASM(
      `OP_PUSHINPUTREFSINGLETON ${ref} OP_DROP`
    ).add(Script.buildPublicKeyHashOut(address));
    return script.toHex();
  } catch (err) {
    throw new Error(
      `nftScript: invalid address/ref (addr=${JSON.stringify(
        address
      )}, ref=${ref}): ${String(err)}`
    );
  }
}

export function ftScript(address: string, ref: string) {
  const script = Script.buildPublicKeyHashOut(address).add(
    Script.fromASM(
      `OP_STATESEPARATOR OP_PUSHINPUTREF ${ref} OP_REFOUTPUTCOUNT_OUTPUTS OP_INPUTINDEX OP_CODESCRIPTBYTECODE_UTXO OP_HASH256 OP_DUP OP_CODESCRIPTHASHVALUESUM_UTXOS OP_OVER OP_CODESCRIPTHASHVALUESUM_OUTPUTS OP_GREATERTHANOREQUAL OP_VERIFY OP_CODESCRIPTHASHOUTPUTCOUNT_OUTPUTS OP_NUMEQUALVERIFY`
    )
  );
  return script.toHex();
}

export function nftAuthScript(
  address: string,
  ref: string,
  auths: { ref: string; scriptSigHash: string }[]
) {
  if (!auths.length) {
    throw new Error("No auths given");
  }

  const authScript = auths
    .map(
      (auth) => `OP_REQUIREINPUTREF ${auth.ref} ${auth.scriptSigHash} OP_2DROP`
    )
    .join(" ");
  const script = Script.fromASM(
    `${authScript} OP_STATESEPARATOR OP_PUSHINPUTREFSINGLETON ${ref} OP_DROP`
  ).add(Script.buildPublicKeyHashOut(address));
  return script.toHex();
}

export function mutableNftScript(mutableRef: string, payloadHash: string) {
  /* Script sig:
   * gly
   * mod
   * <cbor payload>
   * <contract output index>
   * <ref+hash index in token output>
   * <ref index in token output data summary>
   * <token output index>
   */

  return Script.fromASM(
    [
      `${payloadHash} OP_DROP`, // State
      // Pay to token script
      `OP_STATESEPARATOR OP_PUSHINPUTREFSINGLETON ${mutableRef}`, // Mutable contract ref
      `OP_DUP 20 OP_SPLIT OP_BIN2NUM OP_1SUB OP_4 OP_NUM2BIN OP_CAT`, // Build token ref (mutable ref -1)
      `OP_2 OP_PICK OP_REFDATASUMMARY_OUTPUT OP_4 OP_ROLL 24 OP_MUL OP_SPLIT OP_NIP 24 OP_SPLIT OP_DROP OP_EQUALVERIFY`, // Check token ref exists in token output at given refdatasummary index
      `OP_SWAP OP_STATESCRIPTBYTECODE_OUTPUT OP_ROT OP_SPLIT OP_NIP 45 OP_SPLIT OP_DROP OP_OVER 20 OP_CAT OP_INPUTINDEX OP_INPUTBYTECODE OP_SHA256 OP_CAT OP_EQUALVERIFY`, // Compare ref + scriptsig hash in token output to this script's ref + scriptsig hash
      `OP_2 OP_PICK 6d6f64 OP_EQUAL OP_IF`, // Modify operation
      `OP_OVER OP_CODESCRIPTBYTECODE_OUTPUT OP_INPUTINDEX OP_CODESCRIPTBYTECODE_UTXO OP_EQUALVERIFY`, // Contract script must exist unchanged in output
      `OP_OVER OP_STATESCRIPTBYTECODE_OUTPUT 20 OP_5 OP_PICK OP_HASH256 OP_CAT 75 OP_CAT OP_EQUALVERIFY OP_ELSE`, // State script must contain payload hash
      `OP_2 OP_PICK 736c OP_EQUALVERIFY OP_OVER OP_OUTPUTBYTECODE d8 OP_2 OP_PICK OP_CAT 6a OP_CAT OP_EQUAL OP_OVER OP_REFTYPE_OUTPUT OP_0 OP_NUMEQUAL OP_BOOLOR OP_VERIFY OP_ENDIF`, // Seal operation
      `OP_4 OP_ROLL ${glyphMagicBytesHex} OP_EQUALVERIFY OP_2DROP OP_2DROP OP_1`, // Glyph header
    ].join(" ")
  ).toHex() as string;
}

export function nftScriptHash(address: string) {
  return scriptHash(nftScript(address, zeroRef));
}

export function ftScriptHash(address: string) {
  return scriptHash(ftScript(address, zeroRef));
}

export function parseMutableScript(script: string) {
  // Use RegExp so glyph hex variable can be used
  const pattern = new RegExp(
    `^20([0-9a-f]{64})75bdd8([0-9a-f]{72})7601207f818c54807e5279e2547a0124957f7701247f75887cec7b7f7701457f757801207ec0caa87e885279036d6f64876378eac0e98878ec01205579aa7e01757e8867527902736c8878cd01d852797e016a7e8778da009c9b6968547a03${glyphMagicBytesHex}886d6d51$`
  );
  const [, hash, ref] = script.match(pattern) || [];
  return { hash, ref };
}

export function parseP2pkhScript(script: string): {
  address?: string;
} {
  const pattern = /^76a914([0-9a-f]{40})88ac$/;
  const [, address] = script.match(pattern) || [];
  return { address };
}

export function parseNftScript(script: string): {
  ref?: string;
  address?: string;
} {
  const pattern = /^d8([0-9a-f]{72})7576a914([0-9a-f]{40})88ac$/;
  const [, ref, address] = script.match(pattern) || [];
  return { ref, address };
}

export function parseFtScript(script: string): {
  ref?: string;
  address?: string;
} {
  const pattern =
    /^76a914([0-9a-f]{40})88acbdd0([0-9a-f]{72})dec0e9aa76e378e4a269e69d$/;
  const [, address, ref] = script.match(pattern) || [];
  return { ref, address };
}

export function delegateBaseScript(address: string, refs: string[]) {
  const script = new Script();
  refs?.forEach((rel) => {
    script.add(Script.fromASM(`OP_REQUIREINPUTREF ${rel} OP_DROP`));
  });
  script.add(Script.buildPublicKeyHashOut(Address.fromString(address)));
  return script.toHex();
}

export function delegateTokenScript(address: string, ref: string) {
  const script = Script.fromASM(`OP_PUSHINPUTREF ${ref} OP_DROP`).add(
    Script.buildPublicKeyHashOut(address)
  );
  return script.toHex();
}

export function delegateBurnScript(ref: string) {
  return Script.fromASM(`OP_REQUIREINPUTREF ${ref} OP_RETURN 64656c`).toHex();
}

// TODO use this when burning a *name claim contract instead of a delegate burn
export function contractBurnScript(ref: string) {
  return Script.fromASM(`OP_REQUIREINPUTREF ${ref} OP_RETURN 636f6e`).toHex();
}

export function parseDelegateBaseScript(script: string): string[] {
  const pattern = /^((d1[0-9a-f]{72}75)+).*/; // Don't need to match p2pkh
  const match = script.match(pattern);

  if (match) {
    // Return required refs
    const refs = match[1].match(/.{76}/g);
    if (refs) {
      return refs.map((ref) => ref.substring(2, 74));
    }
  }

  return [];
}

export function parseDelegateBurnScript(script: string): string | undefined {
  const pattern = /^d1([0-9a-f]{72})6a0364656c$/;
  const [, ref] = script.match(pattern) || [];
  return ref;
}

export function parseContractBurnScript(script: string): string | undefined {
  const pattern = /^d1([0-9a-f]{72})6a03636f6e$/;
  const [, ref] = script.match(pattern) || [];
  return ref;
}

export function codeScriptHash(script: string) {
  return bytesToHex(sha256(sha256(hexToBytes(script))));
}

// Push a positive number as a 4 bytes little endian
export function push4bytes(n: number) {
  return bytesToHex(encodeDataPush(numberToBinUint32LEClamped(n)));
}

// Push a number with minimal encoding
export function pushMinimal(n: bigint | number) {
  const value = BigInt(n);

  if (value === 0n) {
    return "00"; // OP_0
  }

  if (value === -1n) {
    return "4f"; // OP_1NEGATE
  }

  if (value >= 1n && value <= 16n) {
    const opcode = 0x50 + Number(value); // OP_1 .. OP_16
    return opcode.toString(16).padStart(2, "0");
  }

  return bytesToHex(encodeDataPush(bigIntToVmNumber(value)));
}

export function pushMinimalAsm(n: bigint | number) {
  return Script.fromHex(pushMinimal(n)).toASM();
}

const MAX_TARGET = 0x7fffffffffffffffn; // Doesn't include starting 00000000
export function dMintDiffToTarget(difficulty: number) {
  return MAX_TARGET / BigInt(difficulty);
}

function buildDmintPreimageBytecodePartA(stateItemCount: number) {
  // Stack at time of first PICK (after OP_OUTPOINTTXHASH = 0xc8):
  // bottom: nonce, inputHash, outputHash, outputIndex, <stateItems>, outpointTxHash :top
  // 0xc0 (OP_INPUTINDEX) was removed; it was a spurious extra item that broke B.2's OP_1 PICK.
  const contractRefPickIndex = stateItemCount - 1;
  const inputOutputPickIndex = stateItemCount + 3;
  const nonceRollIndex = stateItemCount + 4;

  return [
    "51",
    "75",
    "c8",
    pushMinimal(contractRefPickIndex),
    "79",
    "7e",
    "a8",
    pushMinimal(inputOutputPickIndex),
    "79",
    pushMinimal(inputOutputPickIndex),
    "79",
    "7e",
    "a8",
    "7e",
    pushMinimal(nonceRollIndex),
    "7a",
    "7e",
  ].join("");
}

function parseScriptNumberToken(token: string): number {
  if (/^OP_[0-9]+$/.test(token)) {
    return Number(token.slice(3));
  }
  if (token === "OP_0") {
    return 0;
  }
  if (token === "OP_1NEGATE") {
    return -1;
  }
  if (!/^[0-9a-f]+$/i.test(token) || token.length % 2 !== 0) {
    throw new Error(`Unsupported script number token: ${token}`);
  }

  const bytes = Array.from(Buffer.from(token, "hex"));
  if (bytes.length === 0) {
    return 0;
  }

  const lastIndex = bytes.length - 1;
  const negative = (bytes[lastIndex] & 0x80) !== 0;
  bytes[lastIndex] &= 0x7f;

  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value |= bytes[i] << (8 * i);
  }
  return negative ? -value : value;
}

function pickStackItem(stack: string[], n: number): string {
  const index = stack.length - 1 - n;
  if (index < 0 || index >= stack.length) {
    throw new Error(`Invalid stack index for OP_PICK/OP_ROLL: ${n}`);
  }
  return stack[index];
}

function stackPick(stack: string[], n: number) {
  stack.push(pickStackItem(stack, n));
}

function stackCat(stack: string[]) {
  const right = stack.pop();
  const left = stack.pop();
  stack.push(`cat(${left},${right})`);
}

function stackSha256(stack: string[]) {
  const value = stack.pop();
  stack.push(`sha256(${value})`);
}

function stackRoll(stack: string[], n: number): string {
  const index = stack.length - 1 - n;
  const [value] = stack.splice(index, 1);
  stack.push(value);
  return value;
}

function extractPreimageIndicesFromPartA(partAHex: string): {
  contractRefPickIndex: number;
  inputHashPickIndex: number;
  outputHashPickIndex: number;
  nonceRollIndex: number;
} {
  const asm = Script.fromHex(partAHex).toASM();
  const match = asm.match(
    /OP_OUTPOINTTXHASH\s+([^\s]+)\s+OP_PICK\s+OP_CAT\s+OP_SHA256\s+([^\s]+)\s+OP_PICK\s+([^\s]+)\s+OP_PICK\s+OP_CAT\s+OP_SHA256\s+OP_CAT\s+([^\s]+)\s+OP_ROLL\s+OP_CAT/
  );

  if (!match) {
    throw new Error(`Unexpected dMint preimage bytecode Part A format: ${asm}`);
  }

  return {
    contractRefPickIndex: parseScriptNumberToken(match[1]),
    inputHashPickIndex: parseScriptNumberToken(match[2]),
    outputHashPickIndex: parseScriptNumberToken(match[3]),
    nonceRollIndex: parseScriptNumberToken(match[4]),
  };
}

function assertDmintPreimageLayout(partAHex: string, stateItemCount: number) {
  if (stateItemCount < 3) {
    throw new Error(`Invalid dMint state item count: ${stateItemCount}`);
  }

  const {
    contractRefPickIndex,
    inputHashPickIndex,
    outputHashPickIndex,
    nonceRollIndex,
  } = extractPreimageIndicesFromPartA(partAHex);

  const stateLabels = [
    "height",
    "contractRef",
    "tokenRef",
    ...Array.from({ length: stateItemCount - 3 }, (_, i) => `state${i}`),
  ];

  const stack = [
    "nonce",
    "inputHash",
    "outputHash",
    "outputIndex",
    ...stateLabels,
    "outpointTxHash",
  ];

  stackPick(stack, contractRefPickIndex);
  const pickContractRef = stack[stack.length - 1];
  stackCat(stack);
  stackSha256(stack);

  stackPick(stack, inputHashPickIndex);
  const pickInputHash = stack[stack.length - 1];
  stackPick(stack, outputHashPickIndex);
  const pickOutputHash = stack[stack.length - 1];
  stackCat(stack);
  stackSha256(stack);
  stackCat(stack);

  const rollNonce = stackRoll(stack, nonceRollIndex);

  if (
    pickContractRef !== "contractRef" ||
    pickInputHash !== "inputHash" ||
    pickOutputHash !== "outputHash" ||
    rollNonce !== "nonce"
  ) {
    throw new Error(
      `Invalid dMint preimage stack mapping: stateItems=${stateItemCount}, picks=[${pickContractRef},${pickInputHash},${pickOutputHash}], roll=${rollNonce}`
    );
  }
}

// V2 BYTECODE constants (Design Spec §4.3)
// Part B.1: PoW hash extraction (reverse, split, zeros check, bin2num, dup, >=0 verify)
const V2_BYTECODE_PART_B1 = "bc01147f77587f040000000088817600a269";
// Part B.2: Target comparison with preservation (OP_1 PICK target, SWAP, >=, VERIFY)
const V2_BYTECODE_PART_B2 = "51797ca269";
// Part B.4: Stack cleanup — drop 5 V2 extras (target, lastTime, targetTime, daaMode, algoId)
const V2_BYTECODE_PART_B4 = "7575757575";
// Part C: Output validation (same as V1 — code script continuity, token reward, height checks)
const V2_BYTECODE_PART_C =
  "a269577ae500a069567ae600a06901d053797e0cdec0e9aa76e378e4a269e69d7eaa76e47b9d547a818b76537a9c537ade789181547ae6939d635279cd01d853797e016a7e886778de519d547854807ec0eb557f777e5379ec78885379eac0e9885379cc519d75686d7551";

// V1 legacy BYTECODE_PART_B kept as a reference for any future
// backward-compatible parser. Prefixed with `_` to opt out of
// `no-unused-vars` while documenting intent.
const _V1_BYTECODE_PART_B =
  "bc01147f77587f040000000088817600a269a269577ae500a069567ae600a06901d053797e0cdec0e9aa76e378e4a269e69d7eaa76e47b9d547a818b76537a9c537ade789181547ae6939d635279cd01d853797e016a7e886778de519d547854807ec0eb557f777e5379ec78885379eac0e9885379cc519d75686d7551";
void _V1_BYTECODE_PART_B;

function buildAsertDaaBytecode(halfLife: number): string {
  // ASERT-lite DAA (Design Spec §4.5)
  // Entry stack: [target, lastTime, targetTime, daaMode, ...]
  //
  // History note: prior to 2026-05-19 the three NEGATE sites in this function
  // emitted hex byte 0x81 (OP_BIN2NUM) instead of 0x8f (OP_NEGATE) — see
  // task #10. The bug rendered the negative-drift clamp identical to a
  // second positive check and made the RSHIFT path receive a negative
  // shift count. New deployments after the fix use the correct opcode.
  const halfLifePush = pushMinimal(halfLife);
  return [
    "c5", // OP_TXLOCKTIME → currentTime
    "5279", // OP_2 PICK lastTime
    "94", // OP_SUB → time_delta
    "5379", // OP_3 PICK targetTime
    "94", // OP_SUB → excess
    halfLifePush, // push halfLife constant
    "96", // OP_DIV → drift
    // Clamp drift to [-4, +4]
    "7654a0", // DUP OP_4 GT
    "63", // IF
    "7554", //   DROP, push 4
    "68", // ENDIF
    "76548f",
    "9f", // DUP OP_4 NEGATE LT
    "63", // IF
    "75548f", //   DROP, push -4
    "68", // ENDIF
    // Apply shift: drift>0 → LSHIFT, drift<0 → RSHIFT(|drift|), drift==0 → unchanged
    "7600a0", // DUP 0 GT
    "63", // IF (positive)
    "98", //   LSHIFT
    "67", // ELSE
    "76009f", //   DUP 0 LT
    "63", //   IF (negative)
    "8f99", //     NEGATE RSHIFT
    "67", //   ELSE (zero)
    "75", //     DROP (drift=0, target unchanged)
    "68", //   ENDIF
    "68", // ENDIF
    // Clamp target to minimum 1
    "76519f", // DUP OP_1 LT
    "63", // IF
    "7551", //   DROP, push 1
    "68", // ENDIF
  ].join("");
}

function buildLinearDaaBytecode(): string {
  // Linear DAA (Design Spec §4.6)
  // new_target = old_target * time_delta / targetTime
  return [
    "c5", // OP_TXLOCKTIME → currentTime
    "5279", // OP_2 PICK lastTime
    "94", // OP_SUB → time_delta
    "7c", // SWAP → [target, time_delta, ...]
    "95", // MUL → [target*time_delta, ...]
    "5379", // OP_3 PICK targetTime
    "96", // DIV → [new_target, ...]
    // Clamp target to minimum 1
    "76519f",
    "63",
    "7551",
    "68",
  ].join("");
}

/**
 * Allowed maxAdjustment values for EPOCH DAA. Restricted to powers of 2 so the
 * clamp uses OP_LSHIFT/OP_RSHIFT instead of OP_DIV (see EPOCH/SCHEDULE design
 * doc §3.3, decision 2026-05-19). The stored value in `daaParams` is the
 * log2 shift count (1 → 2x, 2 → 4x, 3 → 8x, 4 → 16x).
 */
export const EPOCH_MAX_ADJUSTMENT_LOG2_VALUES = [1, 2, 3, 4] as const;
export type EpochMaxAdjustmentLog2 =
  (typeof EPOCH_MAX_ADJUSTMENT_LOG2_VALUES)[number];

/** Per the EPOCH/SCHEDULE design doc §3.7, target > 2^48 risks overflow in
 * `target * clampedDelta` (delta ≤ targetTime * 16). Rejected at wallet build
 * time when daaMode === 'epoch'. */
export const EPOCH_MAX_SAFE_TARGET = 1n << 48n;

/** Maximum number of entries in a SCHEDULE (design doc §4.2, decided 2026-05-19). */
export const SCHEDULE_MAX_ENTRIES = 10;

export type ScheduleEntry = { height: number; target: bigint };

export class DaaParamsValidationError extends Error {}

/**
 * EPOCH DAA bytecode (design doc §3 + simplifications using OP_MOD/OP_MIN/OP_MAX).
 *
 * Entry stack at Part B.3:
 *   [target, lastTime, targetTime, daaMode, algoId, reward, maxHeight,
 *    tokenRef, contractRef, height, ...]
 *
 * Algorithm (interpretation B from the design doc):
 *   if (height > 0) and (height % epochLength == 0):
 *     delta        = currentTime - lastTime
 *     clampedDelta = max(targetTime >> N, min(targetTime << N, delta))
 *     newTarget    = max(1, target * clampedDelta / targetTime)
 *   else:
 *     target unchanged
 *
 * N = maxAdjustmentLog2 ∈ {1,2,3,4}. Default 2 (= 4x).
 */
function buildEpochDaaBytecode(
  epochLength: number,
  maxAdjustmentLog2: number
): string {
  if (!Number.isInteger(epochLength) || epochLength <= 0) {
    throw new DaaParamsValidationError(
      `EPOCH: epochLength must be a positive integer (got ${epochLength})`
    );
  }
  if (
    !EPOCH_MAX_ADJUSTMENT_LOG2_VALUES.includes(
      maxAdjustmentLog2 as EpochMaxAdjustmentLog2
    )
  ) {
    throw new DaaParamsValidationError(
      `EPOCH: maxAdjustmentLog2 must be one of ${EPOCH_MAX_ADJUSTMENT_LOG2_VALUES.join(
        ", "
      )} (got ${maxAdjustmentLog2})`
    );
  }
  const epochLengthPush = pushMinimal(epochLength);
  const nPush = pushMinimal(maxAdjustmentLog2);
  return [
    // ── Boundary check: (height > 0) AND (height % epochLength == 0) ──
    "5979", // OP_9 OP_PICK       — copy height (state pos 9)
    "76", // OP_DUP             — dup for two checks
    "00a0", // OP_0 OP_GREATERTHAN — height > 0?
    "7c", // OP_SWAP            — move height_copy back to top
    epochLengthPush, // push epochLength
    "97", // OP_MOD             — height % epochLength
    "009c", // OP_0 OP_NUMEQUAL   — mod == 0?
    "9a", // OP_BOOLAND         — combine
    "63", // OP_IF
    // ── delta = currentTime - lastTime ──
    "c5", //   OP_TXLOCKTIME    — currentTime
    "5279", //   OP_2 OP_PICK     — copy lastTime
    "94", //   OP_SUB           — delta
    // ── clamp delta to [targetTime>>N, targetTime<<N] ──
    "5379", //   OP_3 OP_PICK     — copy targetTime
    nPush, //   push N
    "98", //   OP_LSHIFT        — upperBound = targetTime << N
    "a3", //   OP_MIN           — delta = min(delta, upperBound)
    "5379", //   OP_3 OP_PICK     — copy targetTime
    nPush, //   push N
    "99", //   OP_RSHIFT        — lowerBound = targetTime >> N
    "a4", //   OP_MAX           — delta = max(delta, lowerBound)
    // ── newTarget = target * clampedDelta / targetTime ──
    "7c", //   OP_SWAP          — [target, clampedDelta, ...]
    "95", //   OP_MUL           — target * clampedDelta
    "5279", //   OP_2 OP_PICK     — copy targetTime
    "96", //   OP_DIV           — newTarget
    // ── clamp newTarget to ≥1 ──
    "76519f", //   OP_DUP OP_1 OP_LESSTHAN
    "63", //   OP_IF
    "7551", //     OP_DROP OP_1
    "68", //   OP_ENDIF
    "68", // OP_ENDIF (outer)
  ].join("");
}

/**
 * SCHEDULE DAA bytecode (design doc §4).
 *
 * Generates a descending nested IF/ELSE chain. For each boundary h_i with
 * target t_i, in descending order of h:
 *
 *   if (height >= h_i):
 *     target = t_i
 *   else:
 *     <next-lower-boundary check>
 *
 * If no boundary matches (height < smallest h_i), the original target is
 * preserved.
 *
 * Caller must pass a schedule sorted strictly ascending by height with
 * 1 ≤ length ≤ SCHEDULE_MAX_ENTRIES. Validation is enforced here.
 */
function buildScheduleDaaBytecode(schedule: ScheduleEntry[]): string {
  if (schedule.length === 0) {
    // Empty schedule = FIXED behavior. Caller should map this to mode 'fixed'.
    return "";
  }
  if (schedule.length > SCHEDULE_MAX_ENTRIES) {
    throw new DaaParamsValidationError(
      `SCHEDULE: at most ${SCHEDULE_MAX_ENTRIES} entries allowed (got ${schedule.length})`
    );
  }
  for (let i = 0; i < schedule.length; i++) {
    const entry = schedule[i];
    if (!Number.isInteger(entry.height) || entry.height < 0) {
      throw new DaaParamsValidationError(
        `SCHEDULE: entry ${i} height must be a non-negative integer (got ${entry.height})`
      );
    }
    if (entry.target <= 0n) {
      throw new DaaParamsValidationError(
        `SCHEDULE: entry ${i} target must be positive (got ${entry.target})`
      );
    }
    if (i > 0 && entry.height <= schedule[i - 1].height) {
      throw new DaaParamsValidationError(
        `SCHEDULE: entries must be strictly ascending by height (entry ${i} height ${
          entry.height
        } <= ${schedule[i - 1].height})`
      );
    }
  }

  // Build the nested IF/ELSE chain from the inside out: start with the
  // lowest-boundary check, wrap with each next-higher boundary. After all
  // iterations, the outermost layer is the highest boundary.
  let body = "";
  for (let i = 0; i < schedule.length; i++) {
    const { height, target } = schedule[i];
    body = [
      "5979", // OP_9 OP_PICK         — copy height
      pushMinimal(height), // push boundary
      "a2", // OP_GREATERTHANOREQUAL
      "63", // OP_IF
      "75", //   OP_DROP            — drop old target
      pushMinimal(target), //   push new target
      body ? "67" : "", // OP_ELSE (only if there's a deeper layer to fall back to)
      body,
      "68", // OP_ENDIF
    ].join("");
  }
  return body;
}

/**
 * Translate a user-facing maxAdjustment factor (2, 4, 8, 16) to the log2 shift
 * count the bytecode embeds. Accepts the log2 value directly for callers that
 * already speak that form. Throws DaaParamsValidationError for anything else.
 */
function maxAdjustmentToLog2(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 2; // default 4x (log2=2)
  }
  // Direct log2 form (callers that already pass shift count)
  if (
    EPOCH_MAX_ADJUSTMENT_LOG2_VALUES.includes(value as EpochMaxAdjustmentLog2)
  ) {
    return value;
  }
  // Factor form (2, 4, 8, 16) — convert to log2
  const factorToLog2: Record<number, number> = { 2: 1, 4: 2, 8: 3, 16: 4 };
  if (value in factorToLog2) return factorToLog2[value];
  throw new DaaParamsValidationError(
    `EPOCH: maxAdjustment must be 2, 4, 8, or 16 (got ${value})`
  );
}

/**
 * Translate a wallet-side schedule entry (which may carry `difficulty`,
 * `target`, or both) into the canonical { height, target } form the bytecode
 * generator expects.
 */
type RawScheduleEntry = {
  height?: unknown;
  target?: unknown;
  difficulty?: unknown;
};

function normalizeScheduleEntries(raw: unknown): ScheduleEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((rawEntry: unknown, i: number) => {
    if (!rawEntry || typeof rawEntry !== "object") {
      throw new DaaParamsValidationError(
        `SCHEDULE: entry ${i} is not an object`
      );
    }
    const e = rawEntry as RawScheduleEntry;
    if (typeof e.height !== "number") {
      throw new DaaParamsValidationError(
        `SCHEDULE: entry ${i} missing numeric height`
      );
    }
    let target: bigint;
    if (typeof e.target === "bigint") {
      target = e.target;
    } else if (typeof e.target === "number" && Number.isFinite(e.target)) {
      target = BigInt(e.target);
    } else if (
      typeof e.difficulty === "number" &&
      Number.isFinite(e.difficulty) &&
      e.difficulty > 0
    ) {
      target = dMintDiffToTarget(e.difficulty);
    } else {
      throw new DaaParamsValidationError(
        `SCHEDULE: entry ${i} needs either target (bigint/number) or difficulty (positive number)`
      );
    }
    return { height: e.height, target };
  });
}

/** Shape DAA params can take depending on `daaMode`. Each field is optional;
 *  the dispatcher picks what it needs.
 *
 *  Carries an index signature so callers can pass additional fields without
 *  forcing this union to grow on every new DAA mode.
 */
export type DaaParams = {
  halfLife?: number;
  epochLength?: number;
  maxAdjustmentLog2?: number;
  maxAdjustment?: number;
  schedule?: unknown;
  /** Generic seconds-per-block hint used by some modes. */
  targetBlockTime?: number;
  targetTime?: number;
  [key: string]: unknown;
};

function buildV2BytecodePartB(
  daaMode: string,
  daaParams: DaaParams | null
): string {
  let daaBytecode = "";
  switch (daaMode) {
    case "asert":
      daaBytecode = buildAsertDaaBytecode(daaParams?.halfLife || 3600);
      break;
    case "lwma":
      daaBytecode = buildLinearDaaBytecode();
      break;
    case "epoch":
      daaBytecode = buildEpochDaaBytecode(
        daaParams?.epochLength ?? 2016,
        maxAdjustmentToLog2(
          // Prefer the explicit log2 form when present.
          daaParams?.maxAdjustmentLog2 ?? daaParams?.maxAdjustment
        )
      );
      break;
    case "schedule":
      daaBytecode = buildScheduleDaaBytecode(
        normalizeScheduleEntries(daaParams?.schedule)
      );
      break;
    case "fixed":
    default:
      daaBytecode = "";
      break;
  }
  return `${V2_BYTECODE_PART_B1}${V2_BYTECODE_PART_B2}${daaBytecode}${V2_BYTECODE_PART_B4}`;
}

export {
  buildAsertDaaBytecode,
  buildLinearDaaBytecode,
  buildEpochDaaBytecode,
  buildScheduleDaaBytecode,
};

export function dMintScript(
  height: number,
  contractRef: string,
  tokenRef: string,
  maxHeight: number,
  reward: number,
  target: bigint,
  algorithm: string = "sha256d",
  daaMode: string = "fixed",
  daaParams: DaaParams | null = null,
  lastTime: number = 0
) {
  const algorithmIds: Record<string, number> = {
    sha256d: 0,
    blake3: 1,
    k12: 2,
  };

  const daaModeIds: Record<string, number> = {
    fixed: 0,
    epoch: 1,
    asert: 2,
    lwma: 3,
    schedule: 4,
  };

  const algoId = algorithmIds[algorithm] ?? 0;
  const daaId = daaModeIds[daaMode] ?? 0;
  const targetTime = daaParams?.targetBlockTime || daaParams?.targetTime || 60;

  // PoW hash opcode: aa=OP_HASH256(SHA256d), ee=OP_BLAKE3, ef=OP_K12
  const powHashOpcodes: Record<string, string> = {
    sha256d: "aa",
    blake3: "ee",
    k12: "ef",
  };
  const powHashOp = powHashOpcodes[algorithm] || "aa";

  // V2 state layout (10 items, Design Spec §4.2):
  // height | d8:contractRef | d0:tokenRef | maxHeight | reward |
  // algoId | daaMode | targetTime | lastTime | target
  const V2_STATE_ITEM_COUNT = 10;

  const stateScript = [
    push4bytes(height),
    `d8${contractRef}`,
    `d0${tokenRef}`,
    pushMinimal(maxHeight),
    pushMinimal(reward),
    pushMinimal(algoId),
    pushMinimal(daaId),
    pushMinimal(targetTime),
    push4bytes(lastTime),
    pushMinimal(target),
  ].join("");

  const bytecodePartA = buildDmintPreimageBytecodePartA(V2_STATE_ITEM_COUNT);
  assertDmintPreimageLayout(bytecodePartA, V2_STATE_ITEM_COUNT);
  const bytecodePartB = buildV2BytecodePartB(daaMode, daaParams);
  const contractBytecode = `${bytecodePartA}${powHashOp}${bytecodePartB}${V2_BYTECODE_PART_C}`;

  return `${stateScript}bd${contractBytecode}`;
}
