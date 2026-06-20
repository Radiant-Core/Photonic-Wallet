/**
 * REGTEST e2e consensus gate for the ASERT-v2 bytecode.
 *
 * Runs the actual on-chain DAA body in radiantd's consensus script interpreter
 * (the one thing radiantjs cannot model: the int64 INVALID_NUMBER_RANGE_64_BIT
 * abort). For each case we lock a coin with a BARE script:
 *
 *   <push targetTime> <push lastTime> <push oldTarget>   // seed entry stack
 *   <buildAsertDaaBytecode(halfLife)>                    // c5 reads spend nLockTime
 *   <push expected> OP_EQUALVERIFY                       // newTarget == reference
 *   <push lastTime> OP_EQUALVERIFY                       // lastTime slot preserved
 *   <push targetTime> OP_EQUALVERIFY                     // targetTime slot preserved
 *   OP_TRUE
 *
 * then spend it with the spend tx's nLockTime = currentTime. If radiantd ACCEPTS
 * the spend, the on-chain v2 bytecode computed exactly what the miner's reference
 * (computeAsertV2Target) computed AND left the PartC-required stack shape — with
 * no int64 overflow. If the script over/underflows or disagrees, radiantd rejects
 * with a script-verify error.
 *
 * Guarded by RUN_REGTEST=1 (needs the local /tmp/gg-regtest node up). Run:
 *   RUN_REGTEST=1 npx vitest run src/__tests__/dmint-asert-v2-regtest.test.ts
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import rjs from "@radiant-core/radiantjs";
import { buildAsertDaaBytecode, buildLinearDaaBytecode, pushMinimal } from "../script";
import {
  computeAsertV2Target,
  computeLwmaV2Target,
  ASERT_V2_MAX_TARGET_DIV4,
} from "../dmintDaaV2";

const RUN = process.env.RUN_REGTEST === "1";
const d = RUN ? describe : describe.skip;

const { Transaction, Script, PrivateKey } = rjs as any;

const CLI_BIN = "/Users/macbookair/CascadeProjects/Radiant-Core/build/src/radiant-cli";
const CLI_ARGS = [
  "-datadir=/tmp/gg-regtest",
  "-regtest",
  "-rpcuser=gg",
  "-rpcpassword=ggpass",
  "-rpcwallet=ggminer",
];
function rcli(...args: string[]): string {
  return execFileSync(CLI_BIN, [...CLI_ARGS, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const SATS = 100_000_000n;

type Case = {
  name: string;
  oldTarget: bigint;
  lastTime: bigint;
  currentTime: bigint;
  targetTime: bigint;
  halfLife: bigint;
};

// Wrap a DAA body in a self-contained check script: seed [targetTime,lastTime,
// target], run the body (c5 reads the spend nLockTime), then OP_EQUALVERIFY the
// computed newTarget AND the preserved lastTime/targetTime slots against `expected`.
function buildCheckScript(c: Case, daaBodyHex: string, expected: bigint): string {
  return (
    pushMinimal(c.targetTime) +
    pushMinimal(c.lastTime) +
    pushMinimal(c.oldTarget) +
    daaBodyHex +
    pushMinimal(expected) +
    "88" + // OP_EQUALVERIFY  (newTarget)
    pushMinimal(c.lastTime) +
    "88" + // OP_EQUALVERIFY  (lastTime preserved)
    pushMinimal(c.targetTime) +
    "88" + // OP_EQUALVERIFY  (targetTime preserved)
    "51" // OP_TRUE
  );
}

// Shared fund→spend→testmempoolaccept driver. Returns the per-case results.
function runGate(checkScripts: string[], currentTimes: bigint[]): boolean[] {
  const utxos = JSON.parse(rcli("listunspent", "1", "9999999"));
  const u = utxos.find(
    (x: any) => x.amount > 1 && x.spendable && x.scriptPubKey.startsWith("76a914")
  );
  if (!u) throw new Error("need a spendable P2PKH utxo");
  const wif = rcli("dumpprivkey", u.address);
  const changeAddr = rcli("getnewaddress");
  const destAddr = rcli("getnewaddress");

  const fund = new Transaction();
  fund.from({
    txId: u.txid,
    outputIndex: u.vout,
    script: u.scriptPubKey,
    satoshis: Number(BigInt(Math.round(u.amount * 1e8))),
  });
  for (const hex of checkScripts) {
    fund.addOutput(
      new Transaction.Output({ script: Script.fromHex(hex), satoshis: Number(SATS) })
    );
  }
  fund.change(changeAddr);
  fund.sign(PrivateKey.fromWIF(wif));
  const fundTxid = rcli("sendrawtransaction", fund.uncheckedSerialize());
  if (fundTxid.length !== 64) throw new Error("funding broadcast failed: " + fundTxid);
  rcli("generatetoaddress", "1", changeAddr);

  const ok: boolean[] = [];
  for (let i = 0; i < checkScripts.length; i++) {
    const spend = new Transaction();
    spend.from({ txId: fundTxid, outputIndex: i, script: checkScripts[i], satoshis: Number(SATS) });
    spend.to(destAddr, Number(SATS - 5_000_000n)); // generous fee (min relay 10k photons/byte)
    spend.inputs[0].setScript(Script.empty());
    spend.inputs[0].sequenceNumber = 0xffffffff;
    spend.nLockTime = Number(currentTimes[i]);
    try {
      const res = JSON.parse(
        rcli("testmempoolaccept", JSON.stringify([spend.uncheckedSerialize()]), "true")
      );
      ok.push(!!(res[0] || {}).allowed);
      if (!ok[i]) console.log(`  reject[${i}]:`, (res[0] || {})["reject-reason"]);
    } catch (e: any) {
      ok.push(false);
      console.log(`  error[${i}]:`, (e.stderr || e.message || "").toString().replace(/\s+/g, " ").slice(0, 200));
    }
  }
  rcli("generatetoaddress", "1", changeAddr);
  return ok;
}

d("ASERT-v2 regtest consensus gate", () => {
  // Mix of normal + int64-overflow-stress cases (the radiantjs-blind class).
  const DIV4 = ASERT_V2_MAX_TARGET_DIV4;
  const cases: Case[] = [
    { name: "on-target", oldTarget: DIV4 / 1000n, lastTime: 1_500_000n, currentTime: 1_500_010n, targetTime: 10n, halfLife: 40n },
    { name: "slow block (ease)", oldTarget: DIV4 / 1000n, lastTime: 1_500_000n, currentTime: 1_500_080n, targetTime: 10n, halfLife: 40n },
    { name: "fast block (harden)", oldTarget: DIV4 / 1000n, lastTime: 1_500_000n, currentTime: 1_500_002n, targetTime: 10n, halfLife: 40n },
    { name: "1s deviation (no dead zone)", oldTarget: DIV4 / 1000n, lastTime: 1_500_000n, currentTime: 1_500_011n, targetTime: 10n, halfLife: 40n },
    { name: "extreme slow (clamp +25%)", oldTarget: DIV4 / 4n, lastTime: 1_000_000n, currentTime: 1_400_000n, targetTime: 10n, halfLife: 1n },
    { name: "max target near cap, big gap", oldTarget: DIV4, lastTime: 1_000_000n, currentTime: 1_400_000n, targetTime: 60n, halfLife: 1n },
    { name: "tiny target (high diff), fast", oldTarget: 1n, lastTime: 1_500_000n, currentTime: 1_500_001n, targetTime: 60n, halfLife: 1n },
    { name: "halfLife huge (gentle)", oldTarget: DIV4 / 500n, lastTime: 1_500_000n, currentTime: 1_500_120n, targetTime: 60n, halfLife: 65536n },
    { name: "backward clock (harden, floor)", oldTarget: 1000n, lastTime: 1_500_000n, currentTime: 1_400_000n, targetTime: 10n, halfLife: 1n },
  ];

  it("radiantd accepts every ASERT-v2 retarget spend (bytecode == reference, no overflow)", () => {
    const checkScripts = cases.map((c) =>
      buildCheckScript(
        c,
        buildAsertDaaBytecode(Number(c.halfLife)),
        computeAsertV2Target(c.oldTarget, c.lastTime, c.currentTime, c.targetTime, c.halfLife)
      )
    );
    const ok = runGate(checkScripts, cases.map((c) => c.currentTime));
    const failed = cases.filter((_, i) => !ok[i]).map((c) => c.name);
    console.log("ASERT-v2 regtest:", ok.map((v, i) => `${v ? "PASS" : "FAIL"} ${cases[i].name}`).join(" | "));
    expect(failed, failed.join(", ")).toEqual([]);
  });
});

d("LWMA-v2 regtest consensus gate", () => {
  // LWMA-v2 = damped fractional, gain auto = targetTime. Same int64-overflow-stress
  // mix. halfLife is ignored by LWMA (kept on Case for shape reuse).
  const DIV4 = ASERT_V2_MAX_TARGET_DIV4;
  const cases: Case[] = [
    { name: "on-target", oldTarget: DIV4 / 1000n, lastTime: 1_600_000n, currentTime: 1_600_010n, targetTime: 10n, halfLife: 0n },
    { name: "slow (ease)", oldTarget: DIV4 / 1000n, lastTime: 1_600_000n, currentTime: 1_600_025n, targetTime: 10n, halfLife: 0n },
    { name: "fast (harden)", oldTarget: DIV4 / 1000n, lastTime: 1_600_000n, currentTime: 1_600_005n, targetTime: 10n, halfLife: 0n },
    { name: "1s deviation (no dead zone)", oldTarget: DIV4 / 1000n, lastTime: 1_600_000n, currentTime: 1_600_011n, targetTime: 10n, halfLife: 0n },
    { name: "max target, big gap, tt=1 (overflow stress)", oldTarget: DIV4, lastTime: 1_000_000n, currentTime: 1_400_000n, targetTime: 1n, halfLife: 0n },
    { name: "tiny target, fast", oldTarget: 1n, lastTime: 1_600_000n, currentTime: 1_600_001n, targetTime: 60n, halfLife: 0n },
    { name: "backward clock (harden, floor)", oldTarget: 1000n, lastTime: 1_600_000n, currentTime: 1_500_000n, targetTime: 10n, halfLife: 0n },
    { name: "large targetTime, on-target", oldTarget: DIV4 / 500n, lastTime: 1_600_000n, currentTime: 1_600_600n, targetTime: 600n, halfLife: 0n },
  ];

  it("radiantd accepts every LWMA-v2 retarget spend (bytecode == reference, no overflow)", () => {
    const body = buildLinearDaaBytecode();
    const checkScripts = cases.map((c) =>
      buildCheckScript(c, body, computeLwmaV2Target(c.oldTarget, c.lastTime, c.currentTime, c.targetTime))
    );
    const ok = runGate(checkScripts, cases.map((c) => c.currentTime));
    const failed = cases.filter((_, i) => !ok[i]).map((c) => c.name);
    console.log("LWMA-v2 regtest:", ok.map((v, i) => `${v ? "PASS" : "FAIL"} ${cases[i].name}`).join(" | "));
    expect(failed, failed.join(", ")).toEqual([]);
  });
});
