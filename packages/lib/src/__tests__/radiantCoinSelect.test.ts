import { describe, it, expect } from "vitest";
import {
  radiantCoinSelect,
  varIntSize,
  inputBytes,
  outputBytes,
  transactionBytes,
  TX_DUST_THRESHOLD,
  type CoinSelectInput,
  type CoinSelectOutput,
} from "../radiantCoinSelect";
import { MIN_RELAY_FEE_RATE } from "../feePolicy";

// Use the post-V2 mainnet minimum throughout (matches `normalizeFeeRate`).
const RATE = MIN_RELAY_FEE_RATE;

const p2pkhOutput = (value: number): CoinSelectOutput => ({
  // 25-byte P2PKH locking script, hex.
  script: "76a914" + "00".repeat(20) + "88ac",
  value,
});

const utxo = (
  value: number,
  opts: { required?: boolean; script?: string } = {}
): CoinSelectInput => ({
  value,
  required: opts.required,
  // 107-byte P2PKH unlocking script worst case (sig + pubkey).
  script: opts.script ?? "00".repeat(107),
});

describe("varIntSize", () => {
  it("encodes <0xfd in 1 byte", () => {
    expect(varIntSize(0)).toBe(1);
    expect(varIntSize(0xfc)).toBe(1);
  });
  it("encodes 0xfd–0xffff in 3 bytes", () => {
    expect(varIntSize(0xfd)).toBe(3);
    expect(varIntSize(0xffff)).toBe(3);
  });
  it("encodes 0x10000–0xffffffff in 5 bytes", () => {
    expect(varIntSize(0x10000)).toBe(5);
    expect(varIntSize(0xffffffff)).toBe(5);
  });
  it("encodes larger in 9 bytes", () => {
    expect(varIntSize(0x100000000)).toBe(9);
  });
  it("rejects invalid input", () => {
    expect(() => varIntSize(-1)).toThrow();
    expect(() => varIntSize(1.5)).toThrow();
    expect(() => varIntSize(Number.NaN)).toThrow();
  });
});

describe("size helpers", () => {
  it("inputBytes accounts for varint(scriptLen) + scriptLen + 40", () => {
    // 107-byte script → 1 byte varint → 40 + 1 + 107 = 148
    expect(inputBytes(utxo(1000))).toBe(40 + 1 + 107);
  });
  it("outputBytes defaults to P2PKH when script absent", () => {
    expect(outputBytes({ value: 1, script: undefined })).toBe(8 + 1 + 25);
  });
  it("transactionBytes includes tx-level varints", () => {
    const txn = transactionBytes([utxo(1000)], [p2pkhOutput(900)]);
    // TX_EMPTY_SIZE(8) + varInt(1)(1) + varInt(1)(1) + 148 + 34
    expect(txn).toBe(8 + 1 + 1 + 148 + 34);
  });
});

describe("radiantCoinSelect", () => {
  it("returns no inputs when feeRate is invalid", () => {
    const r = radiantCoinSelect([utxo(1000)], [p2pkhOutput(500)], 0, "");
    expect(r.inputs).toBeUndefined();
  });

  it("returns no inputs when funds are insufficient", () => {
    const r = radiantCoinSelect(
      [utxo(100)],
      [p2pkhOutput(1_000_000)],
      RATE,
      ""
    );
    expect(r.inputs).toBeUndefined();
    expect(r.fee).toBeGreaterThan(0);
  });

  it("selects a single sufficient utxo and adds change when worthwhile", () => {
    const inputs = [utxo(10_000_000)];
    const outputs = [p2pkhOutput(5_000_000)];
    const r = radiantCoinSelect(
      inputs,
      outputs,
      RATE,
      "76a914" + "11".repeat(20) + "88ac"
    );
    expect(r.inputs).toHaveLength(1);
    // Original target + change.
    expect(r.outputs).toHaveLength(2);
    // Conservation of value: sum(inputs) === sum(outputs) + fee.
    const inSum = r.inputs!.reduce((a, x) => a + x.value, 0);
    const outSum = (r.outputs ?? []).reduce((a, x) => a + x.value, 0);
    expect(inSum - outSum).toBe(r.fee);
  });

  it("omits change when remainder is below dust threshold", () => {
    // Craft inputs so remainder after fee is ≤ TX_DUST_THRESHOLD.
    const baseBytes = transactionBytes([utxo(1)], [p2pkhOutput(1)]);
    const fee = Math.ceil(RATE * (baseBytes + outputBytes({ value: 0 })));
    const inputs = [utxo(fee + 100 + TX_DUST_THRESHOLD)];
    const outputs = [p2pkhOutput(100)];
    const r = radiantCoinSelect(inputs, outputs, RATE, "");
    expect(r.inputs).toHaveLength(1);
    expect(r.outputs).toHaveLength(1); // no change appended
  });

  it("includes required inputs unconditionally, even if uneconomic", () => {
    // Required input whose fee exceeds its value MUST still be included.
    const req = utxo(50, { required: true }); // detrimental
    const big = utxo(10_000_000);
    const r = radiantCoinSelect([req, big], [p2pkhOutput(1_000_000)], RATE, "");
    expect(r.inputs).toBeDefined();
    expect(r.inputs!.some((i) => i.required)).toBe(true);
  });

  it("skips detrimental discretionary inputs", () => {
    const dust = utxo(50); // fee > value at MIN_RELAY_FEE_RATE
    const big = utxo(10_000_000);
    const r = radiantCoinSelect(
      [dust, big],
      [p2pkhOutput(1_000_000)],
      RATE,
      ""
    );
    expect(r.inputs).toBeDefined();
    expect(r.inputs!.find((i) => i.value === 50)).toBeUndefined();
  });

  it("prefers higher-effective-value utxos (sort order)", () => {
    const small1 = utxo(2_000_000);
    const small2 = utxo(2_000_000);
    const big = utxo(10_000_000);
    const r = radiantCoinSelect(
      [small1, small2, big],
      [p2pkhOutput(5_000_000)],
      RATE,
      ""
    );
    expect(r.inputs).toBeDefined();
    // Should pick the big one first, satisfying with a single input.
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs![0].value).toBe(10_000_000);
  });

  it("throws if realized fee exceeds the emergency cap", () => {
    // Simulate a buggy caller that bypassed normalizeFeeRate and supplied
    // a wildly wrong rate. Use a required input so it's included
    // unconditionally (no detrimental-skip), and a rate tuned so the
    // selector enters finalize() AND no change output is added — leaving
    // the full surplus to flow into the realized fee and trip the cap.
    const insaneRate = 70_000_000; // photons/byte
    const required: CoinSelectInput = {
      value: 15_000_000_000, // 150 RXD, well above MAX_TX_FEE_PHOTONS (100 RXD)
      required: true,
      script: "00".repeat(107),
    };
    expect(() =>
      radiantCoinSelect([required], [p2pkhOutput(1)], insaneRate, "")
    ).toThrow(/emergency cap|unreasonable/);
  });
});
