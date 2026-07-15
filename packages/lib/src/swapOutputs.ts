/**
 * Canonical output ordering for swap-completion (taker) transactions.
 *
 * WHY THIS IS A CONSENSUS CONSTRAINT, NOT A STYLE CHOICE
 * ------------------------------------------------------
 * A swap offer is a PSRT: the maker partially-signs it with
 * SIGHASH_SINGLE|ANYONECANPAY|FORKID (see `transfer.tsx partiallySigned`) over
 * a single input — their reserved asset — committing to a single output: the
 * payment they want to receive. SIGHASH_SINGLE binds the signing input to the
 * output at the SAME INDEX. The taker reuses the maker's pre-signed scriptSig
 * VERBATIM at input index 0, so the maker's payment MUST be output[0]. Move it
 * and the maker's signature commits to the wrong output: the node rejects the
 * transaction with `mandatory-script-verify-flag-failed` and every NFT-for-RXD
 * swap breaks.
 *
 * This has regressed before: an earlier SwapLoad unconditionally swapped
 * outputs[0]/[1] ("Reorder to (NFT to buyer) then (seller payment)"), which
 * moved the payment to index 1 and broke all such swaps.
 *
 * The ordering lives here — pure, exported, dependency-free — rather than
 * inline in a React component, so the regression guard
 * (`__tests__/swap-load-output-order.test.ts`) can assert THE REAL FUNCTION the
 * taker paths call. It previously reconstructed this logic in a local helper
 * and asserted against that copy, which passes happily while the real path
 * regresses — i.e. it could not catch the very bug it was written for.
 *
 * Callers: `app/src/pages/SwapLoad.tsx` (PSRT paste flow) and
 * `app/src/pages/OpenOrders.tsx` (order-book fill). Proven against a real node
 * in `__tests__/swap-load-flow.regtest.test.ts` and `wave-swap-regtest.test.ts`
 * (`swapOutputs = [payOut, nftToB, ...]`).
 */
import { UnfinalizedOutput } from "./types";

export type SwapCompletionOutputs = {
  /**
   * The maker's payment, taken from their signed price terms. MUST land at
   * index 0 — this is the output their SIGHASH_SINGLE signature commits to.
   */
  makerPayment: UnfinalizedOutput;
  /** The offered asset, delivered to the taker. Lands at index 1. */
  assetToTaker: UnfinalizedOutput;
  /**
   * Enforced-royalty payouts, if any. Land at index 2+, after the asset, never
   * displacing the maker payment. Amounts are computed by the caller; this
   * function only fixes their POSITION.
   */
  royaltyOutputs?: UnfinalizedOutput[];
  /**
   * Outputs funding the asset the maker wants (token-for-token swaps), from
   * `fundFungible` / `fundNonFungible`. Appended last.
   */
  fundingOutputs?: UnfinalizedOutput[];
};

/**
 * Assemble swap-completion outputs in the only order the maker's signature
 * permits:
 *
 *   [ makerPayment, assetToTaker, ...royaltyOutputs, ...fundingOutputs ]
 *
 * Change is appended by the caller AFTER `fundTx` computes it (funding needs
 * this output list first), so it always trails and never affects index 0.
 */
export function buildSwapCompletionOutputs(
  opts: SwapCompletionOutputs
): UnfinalizedOutput[] {
  // Canonical base layout. The maker payment is index 0 by construction.
  const outputs: UnfinalizedOutput[] = [opts.makerPayment, opts.assetToTaker];

  if (opts.royaltyOutputs?.length) {
    outputs.push(...opts.royaltyOutputs);
  }

  if (opts.fundingOutputs?.length) {
    outputs.push(...opts.fundingOutputs);
  }

  return outputs;
}
