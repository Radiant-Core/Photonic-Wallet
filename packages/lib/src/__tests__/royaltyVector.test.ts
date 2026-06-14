/**
 * Royalty covenant + beacon byte-layout pin.
 *
 * The RXinDexer royalty index parses these scripts off-chain with NO version/length
 * marker on the covenant, so the builder output here MUST stay byte-for-byte in
 * lockstep with the Python parser. These exact hex vectors are mirrored in
 * RXinDexer tests/test_royalty_parse.py — if this test's expectations change
 * (a builder change), regenerate those Python vectors and re-verify the parser.
 *
 * The txid is deliberately non-palindromic so a byte-order regression can't hide.
 */
import { describe, it, expect } from "vitest";
import {
  royaltySaleScript,
  royaltyBeaconScript,
  royaltyTermsFromMetadata,
  isRoyaltySaleScript,
  parseRoyaltySaleRef,
} from "../royaltyCovenant";

const REF =
  "0011223344556677889900aabbccddeeff00112233445566778899aabbccddee" +
  "03000000";
const ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";

const EXPECTED_COVENANT =
  "d80011223344556677889900aabbccddeeff00112233445566778899aabbccddee03000000" +
  "756376a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac6700cd19" +
  "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac8800cc03a08601a26952cd19" +
  "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac8852cc028813a2695168";

const EXPECTED_BEACON =
  "6a045252594c5124" +
  "0011223344556677889900aabbccddeeff00112233445566778899aabbccddee03000000";

describe("royalty covenant/beacon byte layout (RXinDexer parity)", () => {
  const terms = royaltyTermsFromMetadata({
    ref: REF,
    sellerAddress: ADDR,
    price: 100000,
    royalty: { bps: 500, address: ADDR }, // 5% -> 5000
  });

  it("royaltySaleScript matches the pinned covenant hex", () => {
    expect(royaltySaleScript(terms)).toBe(EXPECTED_COVENANT);
  });

  it("royaltyBeaconScript matches the pinned beacon hex", () => {
    expect(royaltyBeaconScript(REF)).toBe(EXPECTED_BEACON);
  });

  it("the covenant is self-recognizable and ref-recoverable", () => {
    expect(isRoyaltySaleScript(EXPECTED_COVENANT)).toBe(true);
    expect(parseRoyaltySaleRef(EXPECTED_COVENANT)).toBe(REF);
  });
});
