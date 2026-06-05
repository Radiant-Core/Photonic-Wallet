/**
 * Unit tests for the pure server-JSON validation helper used by the txo sync
 * path (audit FIX 3 / M3). Only `validateElectrumUtxo` is exercised here — the
 * other helpers in verifyTxo.ts are I/O-bound (Electrum + header DB) and are
 * covered by the SPV core tests in @lib/spv.
 *
 * NOTE: do not run this in the broader suite from here — it is a standalone,
 * dependency-light test.
 */
import { describe, it, expect } from "vitest";
import {
  validateElectrumUtxo,
  MAX_MONEY_PHOTONS,
} from "@app/electrum/worker/verifyTxo";

const VALID_TXID = "a".repeat(64);

function baseUtxo(overrides: Record<string, unknown> = {}) {
  return {
    tx_hash: VALID_TXID,
    tx_pos: 0,
    height: 412345,
    value: 100000,
    refs: [],
    ...overrides,
  };
}

describe("validateElectrumUtxo (FIX 3 / M3)", () => {
  it("accepts a well-formed confirmed utxo", () => {
    expect(validateElectrumUtxo(baseUtxo())).toBe(true);
  });

  it("accepts height 0 (mempool / unconfirmed convention)", () => {
    expect(validateElectrumUtxo(baseUtxo({ height: 0 }))).toBe(true);
  });

  it("accepts value exactly at the sanity cap", () => {
    expect(validateElectrumUtxo(baseUtxo({ value: MAX_MONEY_PHOTONS }))).toBe(
      true
    );
  });

  it.each([null, undefined, 42, "x", []])(
    "rejects non-object input %p",
    (input) => {
      expect(validateElectrumUtxo(input)).toBe(false);
    }
  );

  it("rejects a malformed tx_hash (wrong length)", () => {
    expect(validateElectrumUtxo(baseUtxo({ tx_hash: "abc" }))).toBe(false);
  });

  it("rejects a non-hex tx_hash", () => {
    expect(validateElectrumUtxo(baseUtxo({ tx_hash: "z".repeat(64) }))).toBe(
      false
    );
  });

  it("rejects a negative value", () => {
    expect(validateElectrumUtxo(baseUtxo({ value: -1 }))).toBe(false);
  });

  it("rejects a non-integer (float) value", () => {
    expect(validateElectrumUtxo(baseUtxo({ value: 1.5 }))).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity])("rejects value %p", (value) => {
    expect(validateElectrumUtxo(baseUtxo({ value }))).toBe(false);
  });

  it("rejects a value above the sanity cap", () => {
    expect(
      validateElectrumUtxo(baseUtxo({ value: MAX_MONEY_PHOTONS + 1 }))
    ).toBe(false);
  });

  it("rejects a negative height", () => {
    expect(validateElectrumUtxo(baseUtxo({ height: -5 }))).toBe(false);
  });

  it("rejects a non-integer height", () => {
    expect(validateElectrumUtxo(baseUtxo({ height: 10.2 }))).toBe(false);
  });

  it("rejects Infinity height", () => {
    expect(validateElectrumUtxo(baseUtxo({ height: Infinity }))).toBe(false);
  });

  it("rejects a negative tx_pos", () => {
    expect(validateElectrumUtxo(baseUtxo({ tx_pos: -1 }))).toBe(false);
  });

  it("rejects a non-integer tx_pos", () => {
    expect(validateElectrumUtxo(baseUtxo({ tx_pos: 0.5 }))).toBe(false);
  });

  it("rejects a missing value field", () => {
    const u = baseUtxo();
    delete (u as Record<string, unknown>).value;
    expect(validateElectrumUtxo(u)).toBe(false);
  });
});
