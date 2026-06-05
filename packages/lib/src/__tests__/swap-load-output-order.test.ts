/**
 * Regression guard for the NFT->RXD swap-completion output ordering.
 *
 * The swap MAKER partially-signs their offer with
 * SIGHASH_SINGLE|ANYONECANPAY|FORKID (see packages/lib/src/transfer.tsx
 * `partiallySigned`): a single input (their reserved NFT) committing to a
 * single output = the payment they want to receive. SIGHASH_SINGLE binds the
 * signing input to the output at the SAME INDEX. When the buyer (taker)
 * completes the swap in packages/app/src/pages/SwapLoad.tsx, the maker's
 * pre-signed scriptSig is reused VERBATIM at input index 0
 * (signTransaction: `if (index === 0) return swapParams.tx.inputs[0].script`).
 *
 * Therefore the maker's payment MUST stay at output index 0. A previous version
 * of SwapLoad unconditionally swapped outputs[0]/[1] ("Reorder to (NFT to
 * buyer) then (seller payment)"), which moved the payment to index 1 and left
 * the maker's SIGHASH_SINGLE signature committing to the NFT-to-buyer output
 * instead -> invalid signature -> all NFT-for-RXD swaps broken.
 *
 * This test reconstructs SwapLoad's output-building logic and asserts the
 * canonical invariant: outputs are
 *   [ maker payment, NFT to buyer, ...royalty outputs, ...funding/change ]
 * i.e. maker payment is at index 0, matching the working regtest construction
 * in wave-swap-regtest.test.ts (`swapOutputs = [payOut, nftToB, ...]`).
 */
import { it, expect, describe } from "vitest";
import { nftScript, p2pkhScript } from "../script";

type Output = { script: string; value: number };

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

// Mirrors the output-construction in
// packages/app/src/pages/SwapLoad.tsx ViewSwap.signTransaction for the
// NFT (offered, `from`) -> RXD (wanted, `to`) case, including the optional
// enforced-royalty splice at index 2. Kept in lockstep with that code: if the
// canonical ordering there regresses, this helper (and the assertions below)
// must be updated, which is the signal that the maker signature would break.
function buildNftForRxdOutputs(opts: {
  // The maker's pre-signed payment output (psrt.outputs[0]).
  makerPaymentScript: string;
  makerPaymentValue: number;
  // NFT delivered to the buyer.
  nftToBuyerScript: string;
  nftValue: number;
  // Optional enforced royalty outputs spliced after the NFT (at index 2).
  royaltyOutputs?: Output[];
  // Optional buyer funding/change appended at the end.
  fundingChange?: Output[];
}): Output[] {
  // Canonical base layout: [ maker payment, NFT to buyer ].
  const outputs: Output[] = [
    { script: opts.makerPaymentScript, value: opts.makerPaymentValue },
    { script: opts.nftToBuyerScript, value: opts.nftValue },
  ];

  // Enforced royalties are inserted AFTER the NFT (index 2), never reordering
  // the maker payment at index 0.
  if (opts.royaltyOutputs && opts.royaltyOutputs.length > 0) {
    outputs.splice(2, 0, ...opts.royaltyOutputs);
  }

  // Buyer funding/change is appended last.
  if (opts.fundingChange && opts.fundingChange.length > 0) {
    outputs.push(...opts.fundingChange);
  }

  return outputs;
}

describe("SwapLoad NFT->RXD completion output ordering", () => {
  const refLE = "00".repeat(36); // 36-byte LE ref placeholder
  const maker = ADDR.maker;
  const buyer = ADDR.buyer;
  const royaltyA = ADDR.royaltyA;
  const royaltyB = ADDR.royaltyB;

  const makerPaymentScript = p2pkhScript(maker); // RXD to the maker
  const nftToBuyerScript = nftScript(buyer, refLE); // NFT delivered to buyer
  const PRICE = 7_000_000; // photons (0.07 RXD)

  it("places the maker payment at output[0] and the NFT at output[1]", () => {
    const outputs = buildNftForRxdOutputs({
      makerPaymentScript,
      makerPaymentValue: PRICE,
      nftToBuyerScript,
      nftValue: 1,
    });

    // The maker's SIGHASH_SINGLE signature (reused scriptSig at input 0) binds
    // to output[0]; it MUST be the maker payment, not the NFT.
    expect(outputs[0].script).toBe(makerPaymentScript);
    expect(outputs[0].value).toBe(PRICE);

    // NFT to buyer follows at index 1.
    expect(outputs[1].script).toBe(nftToBuyerScript);

    // Guard against the regressed layout where payment was at index 1.
    expect(outputs[1].script).not.toBe(makerPaymentScript);
  });

  it("keeps maker payment at index 0 with enforced royalties spliced at index 2", () => {
    const royaltyOutputs: Output[] = [
      { script: p2pkhScript(royaltyA), value: 200_000 },
      { script: p2pkhScript(royaltyB), value: 100_000 },
    ];
    const change: Output[] = [{ script: p2pkhScript(buyer), value: 500_000 }];

    const outputs = buildNftForRxdOutputs({
      makerPaymentScript,
      makerPaymentValue: PRICE,
      nftToBuyerScript,
      nftValue: 1,
      royaltyOutputs,
      fundingChange: change,
    });

    // Canonical order: [payment, nft, royaltyA, royaltyB, change].
    expect(outputs.map((o) => o.script)).toEqual([
      makerPaymentScript,
      nftToBuyerScript,
      royaltyOutputs[0].script,
      royaltyOutputs[1].script,
      change[0].script,
    ]);

    // Invariant: maker payment is still at index 0 even with royalties present.
    expect(outputs[0].script).toBe(makerPaymentScript);
    expect(outputs[0].value).toBe(PRICE);
    // NFT is at index 1, royalties begin at index 2.
    expect(outputs[1].script).toBe(nftToBuyerScript);
    expect(outputs[2].script).toBe(royaltyOutputs[0].script);
  });
});
