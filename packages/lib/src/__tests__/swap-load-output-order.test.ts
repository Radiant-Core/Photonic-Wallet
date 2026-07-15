/**
 * Regression guard for the swap-completion output ordering.
 *
 * The swap MAKER partially-signs their offer with
 * SIGHASH_SINGLE|ANYONECANPAY|FORKID (see packages/lib/src/transfer.tsx
 * `partiallySigned`): a single input (their reserved NFT) committing to a
 * single output = the payment they want to receive. SIGHASH_SINGLE binds the
 * signing input to the output at the SAME INDEX. When the taker completes the
 * swap, the maker's pre-signed scriptSig is reused VERBATIM at input index 0
 * (`if (index === 0) return <maker scriptSig>`).
 *
 * Therefore the maker's payment MUST stay at output index 0. A previous version
 * of SwapLoad unconditionally swapped outputs[0]/[1] ("Reorder to (NFT to
 * buyer) then (seller payment)"), which moved the payment to index 1 and left
 * the maker's SIGHASH_SINGLE signature committing to the NFT-to-buyer output
 * instead -> invalid signature -> all NFT-for-RXD swaps broken.
 *
 * THIS TEST ASSERTS THE REAL FUNCTION. An earlier version of this file
 * reconstructed the ordering in a local `buildNftForRxdOutputs` helper and
 * asserted against that copy, because the real logic was trapped inside
 * SwapLoad.tsx's `ViewSwap.signTransaction`. That test passed whether or not
 * the production path was correct — it could not catch the regression it was
 * written to catch. The ordering now lives in `../swapOutputs.ts`, which both
 * takers (pages/SwapLoad.tsx and pages/OpenOrders.tsx) call, and which is what
 * is imported below.
 *
 * The canonical layout is
 *   [ maker payment, asset to taker, ...royalty outputs, ...funding ]
 * matching the working regtest construction in wave-swap-regtest.test.ts
 * (`swapOutputs = [payOut, nftToB, ...]`). Change is appended by the caller
 * after fundTx, so it always trails.
 */
import { it, expect, describe } from "vitest";
import { nftScript, p2pkhScript } from "../script";
import { buildSwapCompletionOutputs } from "../swapOutputs";
import { UnfinalizedOutput } from "../types";

// Known-valid mainnet P2PKH addresses, same format the other lib tests use
// (see script.test.ts / royalty.test.ts). Hardcoded rather than derived via
// radiantjs so this stays a fast, pure unit test with no key generation
// (and avoids radiantjs's incomplete .d.ts types for fromRandom/toAddress).
// royaltyB intentionally reuses the maker address — this guard is about output
// ORDERING (maker payment must stay at index 0), not recipient distinctness.
const ADDR = {
  maker: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  buyer: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
  royaltyA: "12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX",
  royaltyB: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
};

describe("swap completion output ordering", () => {
  // Distinct bytes, NOT a repeated byte: a ref like "ab".repeat(36) is a
  // palindrome under byte-reversal, so LE == BE and byte-order assertions pass
  // regardless of what the code does.
  const refLE =
    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2000000001";
  const makerPaymentScript = p2pkhScript(ADDR.maker); // RXD to the maker
  const assetScript = nftScript(ADDR.buyer, refLE); // NFT delivered to taker
  const PRICE = 7_000_000; // photons (0.07 RXD)

  const makerPayment: UnfinalizedOutput = {
    script: makerPaymentScript,
    value: PRICE,
  };
  const assetToTaker: UnfinalizedOutput = { script: assetScript, value: 1 };

  it("places the maker payment at output[0] and the asset at output[1]", () => {
    const outputs = buildSwapCompletionOutputs({ makerPayment, assetToTaker });

    // The maker's SIGHASH_SINGLE signature (reused scriptSig at input 0) binds
    // to output[0]; it MUST be the maker payment, not the asset.
    expect(outputs[0].script).toBe(makerPaymentScript);
    expect(outputs[0].value).toBe(PRICE);

    // Asset to taker follows at index 1.
    expect(outputs[1].script).toBe(assetScript);

    // Guard against the regressed layout where payment was at index 1.
    expect(outputs[1].script).not.toBe(makerPaymentScript);
    expect(outputs).toHaveLength(2);
  });

  it("keeps maker payment at index 0 with enforced royalties at index 2+", () => {
    const royaltyOutputs: UnfinalizedOutput[] = [
      { script: p2pkhScript(ADDR.royaltyA), value: 200_000 },
      { script: p2pkhScript(ADDR.royaltyB), value: 100_000 },
    ];

    const outputs = buildSwapCompletionOutputs({
      makerPayment,
      assetToTaker,
      royaltyOutputs,
    });

    // Canonical order: [payment, asset, royaltyA, royaltyB].
    expect(outputs.map((o) => o.script)).toEqual([
      makerPaymentScript,
      assetScript,
      royaltyOutputs[0].script,
      royaltyOutputs[1].script,
    ]);

    // Invariant: maker payment is still at index 0 even with royalties present.
    expect(outputs[0].script).toBe(makerPaymentScript);
    expect(outputs[0].value).toBe(PRICE);
  });

  it("appends token-swap funding outputs after the asset", () => {
    const fundingOutputs: UnfinalizedOutput[] = [
      { script: p2pkhScript(ADDR.buyer), value: 500_000 },
    ];

    const outputs = buildSwapCompletionOutputs({
      makerPayment,
      assetToTaker,
      fundingOutputs,
    });

    expect(outputs.map((o) => o.script)).toEqual([
      makerPaymentScript,
      assetScript,
      fundingOutputs[0].script,
    ]);
    expect(outputs[0].script).toBe(makerPaymentScript);
  });

  it("orders royalties before funding, with payment still at index 0", () => {
    const royaltyOutputs: UnfinalizedOutput[] = [
      { script: p2pkhScript(ADDR.royaltyA), value: 200_000 },
    ];
    const fundingOutputs: UnfinalizedOutput[] = [
      { script: p2pkhScript(ADDR.buyer), value: 500_000 },
    ];

    const outputs = buildSwapCompletionOutputs({
      makerPayment,
      assetToTaker,
      royaltyOutputs,
      fundingOutputs,
    });

    expect(outputs.map((o) => o.script)).toEqual([
      makerPaymentScript,
      assetScript,
      royaltyOutputs[0].script,
      fundingOutputs[0].script,
    ]);
    expect(outputs[0].script).toBe(makerPaymentScript);
  });

  it("treats empty royalty/funding lists as absent", () => {
    const outputs = buildSwapCompletionOutputs({
      makerPayment,
      assetToTaker,
      royaltyOutputs: [],
      fundingOutputs: [],
    });

    expect(outputs).toHaveLength(2);
    expect(outputs[0].script).toBe(makerPaymentScript);
    expect(outputs[1].script).toBe(assetScript);
  });
});
