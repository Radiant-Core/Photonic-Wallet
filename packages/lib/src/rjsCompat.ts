/**
 * Small typed wrappers around `@radiant-core/radiantjs` corners whose
 * runtime shape can't be expressed cleanly via declaration merging.
 *
 * Two cases:
 *   1. `crypto.BN` is declared as `class BN { }` upstream with no
 *      constructor signature, but at runtime accepts `string | number`
 *      (stringified integers are how we get past JS's 2^53 safe-integer
 *      limit when handling satoshi values).
 *   2. `Transaction` is callable both with and without `new` upstream;
 *      the upstream `.d.ts` only types the `new`-construction path, so
 *      we can't call `Transaction(hex)` as a function from typed code.
 *
 * Each helper is a one-line cast plus a clear docstring. Casts are
 * confined to this module — see R6 in REMEDIATION_PLAN.md.
 */
import rjs from "@radiant-core/radiantjs";

const { Transaction, crypto } = rjs;

/**
 * Construct a radiantjs BN. Accepts a number or its stringified form;
 * pass strings for satoshi values that exceed JS's safe-integer range.
 */
export function bnFromValue(value: number | string): rjs.crypto.BN {
  const BN = crypto.BN as unknown as new (v: string | number) => rjs.crypto.BN;
  return new BN(value);
}

/**
 * Construct a radiantjs Transaction from a raw-hex string. Upstream
 * accepts this at runtime via either `Transaction(hex)` or
 * `new Transaction(hex)`, but the typed `Transaction` class doesn't
 * declare the function-call form.
 */
export function transactionFromHex(rawHex: string): rjs.Transaction {
  return new Transaction(rawHex);
}

/**
 * Set `Input.sequenceNumber` (upstream declares it readonly).
 * Required when crafting CLTV-spending transactions where the nSequence
 * must be < 0xFFFFFFFF for the locktime check to apply.
 */
export function setInputSequence(
  input: rjs.Transaction.Input,
  value: number
): void {
  (input as unknown as { sequenceNumber: number }).sequenceNumber = value;
}
