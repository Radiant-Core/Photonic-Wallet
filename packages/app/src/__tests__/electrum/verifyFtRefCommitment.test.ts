/**
 * Regression: verifyFtRefCommitment must ACCEPT a legitimate FT UTXO.
 *
 * A byte-order bug (`ftScript(address, reverseRef(onChainRefLE))`) in the
 * belt-and-braces recheck rebuilt the expected script with a big-endian ref,
 * so it never matched the on-chain (little-endian) script and EVERY real FT
 * token was rejected → skipped in updateTxos → FT balances vanished wallet-wide
 * (NFT/RXD/WAVE were unaffected — they run no such validator), and the failure
 * survived a restore-from-seed because it is pure logic, not cache.
 *
 * Fixture is the real on-chain "Touch Grass" (GRASS) dMint mint tx 032f850c…,
 * vout 1 (a 100-photon FT UTXO paid to 1489r9f…), captured from production.
 */
import { describe, it, expect } from "vitest";
import { verifyFtRefCommitment } from "@app/electrum/worker/verifyTxo";
import { ftScript } from "@lib/script";
import Outpoint from "@lib/Outpoint";

// Full raw mint tx 032f850c… (indexer /transaction .hex), confirmed.
const RAWTX =
  "0100000002e5693f454c2b8414262176675017468c1412fd087fe028f398b2adebb3fb417a0000000048045fb57a8e2035a4a38a6d6b044d34b9b1b55228ea07cd7915f63b654ec7b3692fb288b9db4e20772a4f0aea07b0c62adcfd2120a4b65224a6d2f965e5f058d708e8f60c5c46ba00ffffffff0ba1d5e4e6e5fdbd33fcb53ec16edcc287f37a426179b016fa9911edefcd00a3000000006b483045022100bda610e181a3ce69407476c3b7f784125a3d576dfb99b31864b2f88d3f51fa8c022016a16e57e9fb2e8ea61b9bd6fcc130ca21576d8502910c2a093c6f02fbf20e484121034cb0a0bed8f9c55b651ef0808a92697d412076229fdad4ee9d0f9dc19bfdfb31ffffffff040100000000000000ee04bb050000d8f33529f0aef57eef35db653fab619743949fda06a7ef40ca262125389fcd09840a000000d0f33529f0aef57eef35db653fab619743949fda06a7ef40ca262125389fcd098400000000021027016408ffffffffffffff3fbd5175c0c855797ea8597959797ea87e5a7a7eaabc01147f77587f040000000088817600a269a269577ae500a069567ae600a06901d053797e0cdec0e9aa76e378e4a269e69d7eaa76e47b9d547a818b76537a9c537ade789181547ae6939d635279cd01d853797e016a7e886778de519d547854807ec0eb557f777e5379ec78885379eac0e9885379cc519d75686d755164000000000000004b76a9142242acad9e3089b7e7b54387c79ce9c77010077788acbdd0f33529f0aef57eef35db653fab619743949fda06a7ef40ca262125389fcd098400000000dec0e9aa76e378e4a269e69d0000000000000000086a036d73670200336822830b000000001976a914edbcf5a11fca041fb80d2030dd30c1d1fd4a987e88ac00000000";

const ADDRESS = "1489r9fYzC9VgueuT16CPWiRRx4HKacYbB";
const utxo = {
  tx_hash:
    "032f850c365a86f4a01610213d021df00aeec5a174b51a198741db6620ba0d2d",
  tx_pos: 1,
  height: 436048,
  value: 100,
  refs: [
    {
      ref: "8409cd9f38252126ca40efa706da9f94439761ab3f65db35ef7ef5aef02935f3i0",
      type: "normal",
    },
  ],
};

const electrum = {
  request: async (method: string) => {
    if (method === "blockchain.transaction.get") return RAWTX;
    throw new Error("unexpected request " + method);
  },
};

// The FT worker's scriptBuilder derives the claimed script from the server ref.
const buildClaimedScript = (serverRef: string) =>
  ftScript(ADDRESS, Outpoint.fromShortInput(serverRef).reverse().toString());

describe("verifyFtRefCommitment", () => {
  it("accepts a legitimate FT UTXO (the GRASS regression)", async () => {
    const claimedScript = buildClaimedScript(utxo.refs[0].ref);
    const ok = await verifyFtRefCommitment(
      electrum as never,
      utxo as never,
      ADDRESS,
      claimedScript
    );
    expect(ok).toBe(true);
  });

  it("rejects a UTXO whose claimed ref does not match the on-chain script", async () => {
    // Server lies about which token this UTXO is — a different ref than what
    // the real (hash-verified) output commits to. Must be rejected.
    const claimedScript = buildClaimedScript(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffi0"
    );
    const ok = await verifyFtRefCommitment(
      electrum as never,
      utxo as never,
      ADDRESS,
      claimedScript
    );
    expect(ok).toBe(false);
  });
});
