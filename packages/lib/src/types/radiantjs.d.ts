/**
 * Local declaration-merging for `@radiant-core/radiantjs`.
 *
 * The upstream `.d.ts` is incomplete in several places — methods and
 * properties that exist at runtime but aren't declared (or are declared
 * loosely). Each gap below is something we provably hit in `vault.ts`,
 * `tx.ts`, or `token.ts`; the previous workaround was a `// @ts-ignore`
 * comment, which silently masked any *new* mistake on the same line.
 *
 * When upstream typings catch up, delete the matching block here.
 */

import "@radiant-core/radiantjs";

declare module "@radiant-core/radiantjs" {
  // ──────────────────────────────────────────────────────────────────────
  // Transaction — _estimateSize and writable nLockTime exist at runtime but
  // aren't declared. Both are stable, documented in the BSV / Radiant
  // lineage that radiantjs forks.
  //
  // Note: `crypto.BN` and a few other awkward cases (Input.sequenceNumber
  // write access, function-call Transaction(hex)) live in `../rjsCompat.ts`
  // — they need runtime helpers rather than pure type declarations.
  // ──────────────────────────────────────────────────────────────────────
  interface Transaction {
    /** Estimated serialized size in bytes after signing. */
    _estimateSize(): number;
    /**
     * Transaction-level nLockTime (BIP-65 / OP_CHECKLOCKTIMEVERIFY).
     * Writable — `tx.nLockTime = N` must compile.
     */
    nLockTime: number;
    /**
     * Register a callback to produce a custom scriptSig for input `index`.
     * The callback runs at sign-time and must return the scriptSig as hex.
     */
    setInputScript(
      index: number,
      callback: (tx: Transaction, output: Transaction.Output) => string
    ): this;
  }

  namespace Transaction {
    // Make Input.setScript known to TS and surface the input.output
    // property the upstream typing declares as optional but we always
    // populate before signing.
    interface Input {
      setScript(script: Script | string | Buffer): this;
    }

    // Sighash.sign — upstream uses `(...args: any[])` which loses
    // call-site type checking. Replace with the real signature.
    namespace Sighash {
      function sign(
        tx: Transaction,
        privKey: PrivateKey,
        sighashType: number,
        inputIndex: number,
        subscript: Script,
        satoshisBN: crypto.BN
      ): crypto.Signature;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Address — `fromScriptHash` and `fromScript` are static methods radiantjs
  // ships but didn't declare.
  // ──────────────────────────────────────────────────────────────────────
  namespace Address {
    function fromScriptHash(scriptHash: string | Buffer): Address;
    function fromScript(
      script: Script,
      network?: Networks.Network | string
    ): Address;
  }
}
