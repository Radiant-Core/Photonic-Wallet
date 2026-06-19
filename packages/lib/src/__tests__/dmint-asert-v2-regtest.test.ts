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
import { buildAsertDaaBytecode, pushMinimal } from "../script";
import { computeAsertV2Target, ASERT_V2_MAX_TARGET_DIV4 } from "../dmintDaaV2";

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

function buildCheckScript(c: Case): string {
  const expected = computeAsertV2Target(
    c.oldTarget,
    c.lastTime,
    c.currentTime,
    c.targetTime,
    c.halfLife
  );
  return (
    pushMinimal(c.targetTime) +
    pushMinimal(c.lastTime) +
    pushMinimal(c.oldTarget) +
    buildAsertDaaBytecode(Number(c.halfLife)) +
    pushMinimal(expected) +
    "88" + // OP_EQUALVERIFY  (newTarget)
    pushMinimal(c.lastTime) +
    "88" + // OP_EQUALVERIFY  (lastTime preserved)
    pushMinimal(c.targetTime) +
    "88" + // OP_EQUALVERIFY  (targetTime preserved)
    "51" // OP_TRUE
  );
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

  it("radiantd accepts every v2 retarget spend (bytecode == reference, no overflow)", () => {
    // 1) one funding tx with a check-script output per case.
    const utxos = JSON.parse(rcli("listunspent", "1", "9999999"));
    const u = utxos.find(
      (x: any) => x.amount > 1 && x.spendable && x.scriptPubKey.startsWith("76a914")
    );
    expect(u, "need a spendable P2PKH utxo").toBeTruthy();
    const wif = rcli("dumpprivkey", u.address);
    const changeAddr = rcli("getnewaddress");
    const destAddr = rcli("getnewaddress");

    const checkScripts = cases.map(buildCheckScript);

    const fund = new Transaction();
    fund.from({
      txId: u.txid,
      outputIndex: u.vout,
      script: u.scriptPubKey,
      satoshis: Number(BigInt(Math.round(u.amount * 1e8))),
    });
    for (const hex of checkScripts) {
      fund.addOutput(
        new Transaction.Output({
          script: Script.fromHex(hex),
          satoshis: Number(SATS),
        })
      );
    }
    fund.change(changeAddr);
    fund.sign(PrivateKey.fromWIF(wif));
    const fundHex = fund.uncheckedSerialize();
    const fundTxid = rcli("sendrawtransaction", fundHex);
    expect(fundTxid.length).toBe(64);
    rcli("generatetoaddress", "1", changeAddr);

    // 2) spend each check output; nLockTime carries currentTime to OP_TXLOCKTIME.
    const results: { name: string; ok: boolean; err?: string }[] = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const spend = new Transaction();
      spend.from({
        txId: fundTxid,
        outputIndex: i,
        script: checkScripts[i],
        satoshis: Number(SATS),
      });
      // Radiant min relay floor is 10,000 photons/byte; leave a generous fee so
      // the tx clears policy and proceeds to script verification (what we test).
      spend.to(destAddr, Number(SATS - 5_000_000n)); // 0.05 RXD fee
      spend.inputs[0].setScript(Script.empty()); // self-contained script, no sig
      spend.inputs[0].sequenceNumber = 0xffffffff; // final ⇒ nLockTime free
      spend.nLockTime = Number(c.currentTime);
      const spendHex = spend.uncheckedSerialize();
      try {
        // 2nd arg = allowhighfees (Radiant's older signature) so our generous
        // fee doesn't trip the high-fee guard.
        const res = JSON.parse(
          rcli("testmempoolaccept", JSON.stringify([spendHex]), "true")
        );
        const r0 = res[0] || {};
        results.push({
          name: c.name,
          ok: !!r0.allowed,
          err: r0.allowed ? undefined : `${r0["reject-reason"] || JSON.stringify(r0)}`,
        });
      } catch (e: any) {
        results.push({
          name: c.name,
          ok: false,
          err: (e.stderr || e.message || "").toString().replace(/\s+/g, " ").slice(0, 300),
        });
      }
    }
    rcli("generatetoaddress", "1", changeAddr);

    const failed = results.filter((r) => !r.ok);
    // eslint-disable-next-line no-console
    console.log("regtest v2 results:\n" + results.map((r) => `  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.err ? " :: " + r.err : ""}`).join("\n"));
    expect(failed, failed.map((f) => `${f.name}: ${f.err}`).join("\n")).toEqual([]);
  });
});
