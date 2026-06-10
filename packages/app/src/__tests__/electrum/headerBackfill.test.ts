/**
 * Backward header backfill tests (pre-checkpoint SPV — "old FTs stuck
 * pending").
 *
 * The forward header sync never fetches below its pinned checkpoint
 * (height 412,000), so a coin confirmed before that height could never be
 * SPV-proven: verifyTxoInclusion found no header, returned false, and the
 * coin stayed `verified: 0` — surfaced as "Pending" — on every sync, forever.
 * backfillHeaders extends the chain downward, validating fetched chunks by
 * prev-hash linkage up to the trusted anchor.
 *
 * Fixtures are REAL mainnet data (headers 411,988–412,000 and a Merkle proof
 * for the first tx of block 411,995), so the linkage, PoW, and Merkle checks
 * run against genuine chain bytes, and the anchor assertion cross-checks the
 * hardcoded checkpoint hash in Headers.ts against the live chain.
 *
 * Uses the real `@app/db` (Dexie over fake-indexeddb); Electrum is a stub
 * serving fixture slices. No network: runs in the normal suite.
 */
import "../helpers/fakeIdb"; // must be first: real fake-indexeddb + Dexie shims
import { describe, it, expect, beforeEach, vi } from "vitest";
vi.unmock("@app/db");

import db from "@app/db";
import { backfillHeaders } from "@app/electrum/worker/Headers";
import { verifyTxoInclusion } from "@app/electrum/worker/verifyTxo";
import type ElectrumManager from "@app/electrum/ElectrumManager";
import type { ElectrumRequester } from "@app/verifier";

const FIXTURE_START = 411988;
// prettier-ignore
const FIXTURE_HEADERS = [
  "00000020fcbebde123b0b6c4d844f48adc4bca67af704bb95cc7e9f31b000000000000008ee8c1d823165d7b287d284956ddfec032a124993bde8e04203060427d75467c8a39b869f282001a252e9789", // 411988
  "0000002041ac1c25e6194572ef47c85ca5d9f92de3ba85f51282fcaf2600000000000000bef27654cfeb721073bd4bd17452895865544b33214e3f744e397f863a39c1ce7a3ab869c982001a1a2a7254", // 411989
  "00000020cc6ae989fffb41370982a6224633e99afd86cdfd3d54bade3800000000000000ae904dada29636c2c5cc1dfb59ac146153806a12f544421062fd15c6b4866b10333db869a982001a480a7181", // 411990
  "0000002089238e7f9e44e6145e4180aeec6257e0d1cc258dbbda6d024c0000000000000039b45227750dec4765a761435fde52cb66cf3a2b3be7b0ce59164dc75da2c9849a3eb8697e83001a32747b63", // 411991
  "000000209049bb38e0a72f25421ef5b463b1dc85eb6813dce087cd6f0000000000000000411c9f30ea5350accfe6c70f8ebe32b680445d12397e96ce963a36b37ebfb492d13eb8699e83001a87e13431", // 411992
  "00000020a8772f29397e427663e48946d6129968d1b8d65ba6f89d448300000000000000196bc0c31e56371fb2110401bcf85dbf2c2f1cca050bbc7b833036b8bc97d1a22b3fb8691a83001a9560ff9c", // 411993
  "00000020b149c1e0a6433a80b32f962f4555ba6b29b7a865e3e2a4517e00000000000000051d35c0ad52c30dcab562c567add5e50d7abab4a76850724b3bccde49428b37a83fb869a982001a6defee54", // 411994
  "00000020a702594f4980fa28596636905da715a76f9e1035fcfb6580180000000000000018ad8474bf8abc958570b5e32bca3475768d5c81c2e2f64ca7c363d9376df8e80140b8694b82001a0292e798", // 411995
  "00000020aef344f266534151ea0eba5eaef709ca157a6d4599a77146210000000000000004d360e7d6609f72a88aef5a8b6b7d071817e6d3a54f1ea7d1aa6970720675cf3b41b869db81001a44aaf94f", // 411996
  "00000020fb31d6b7472726ec0823a4bc6c419572dc255a02609c73e30d000000000000009ea749f3613cc6ae54f83e404a7d39932401f80b3e5e44b94c47a14d81d9be2aac43b869e281001a2f2b6e84", // 411997
  "0000002051bd744e982587c715a214899e77965fef15a96ce5ea2ec65e0000000000000025c2beeaf04eb35094c1fae237704e18bd0b7d2065c8617d979e5d3024965d082545b8699082001a70843449", // 411998
  "0000002024869bacff93ad791cf03b954caadda8483f7397390a77b35d00000000000000dfe5d692c48a7515c332a3e833146a03abf44b96d107abe0feeb511ff24e1763ab46b869b982001a71369c6c", // 411999
  "0000002012ef10a3fc33f24f7ae220fe6054bc706d198439976971792c00000000000000cded8ee4c8ae733cb7473ca701996d9940e3db2187cbc6c5969c8931679436f2c049b869e982001a8a583c74", // 412000
];

// The pinned checkpoint in Headers.ts — the fixture's last header must hash
// to exactly this for the anchor check to pass, which doubles as a
// cross-check of the hardcoded constant against the live chain.
const CHECKPOINT_HEIGHT = 412000;
const CHECKPOINT_HASH =
  "000000000000000e7fbf20f83b1b0ac4881b95da9248f746ba9d82e24ca78f05";

// Real Merkle proof for the coinbase of block 411,995 (below the checkpoint),
// as returned by blockchain.transaction.get_merkle.
const PROOF_TXID =
  "63f0abfa2c4ff62f549ea0dae00db63a1992202d3b3d08a624e04ffebb500585";
const PROOF_HEIGHT = 411995;
const PROOF = {
  block_height: PROOF_HEIGHT,
  merkle: [
    "d1d44d3781d38db742646ba24bd67afca9f5da38f6df5ae5420c3dd08834f8c9",
    "62d989bb88ea64778bfb1570c7558092ba78f1d39a3c285a1a53a592888c98ad",
    "0eb75017f65b453039a084992e18f66d44130fe8b57457accdaf1443a6322806",
    "71a33683905e709d5fc36235aae8ec761ad57b9625febd779804d2cf5d1f742e",
  ],
  pos: 0,
};

/** Electrum stub serving slices of the fixture chain. */
function makeElectrum(
  mutate?: (hex: string, start: number, count: number) => string
) {
  const request = vi.fn(async (method: string, ...params: unknown[]) => {
    if (method !== "blockchain.block.headers") {
      throw new Error(`unexpected method ${method}`);
    }
    const [start, count] = params as [number, number];
    const idx = start - FIXTURE_START;
    if (idx < 0 || idx + count > FIXTURE_HEADERS.length) {
      throw new Error(`request outside fixture range: ${start} +${count}`);
    }
    const hex = FIXTURE_HEADERS.slice(idx, idx + count).join("");
    return { hex: mutate ? mutate(hex, start, count) : hex, count, max: 2016 };
  });
  return {
    electrum: { client: { request } } as unknown as ElectrumManager,
    request,
  };
}

const storedHeights = async () =>
  (await db.header.toArray()).map((row) => row.height).sort((a, b) => a - b);

beforeEach(async () => {
  await db.header.clear();
});

describe("backfillHeaders", () => {
  it("backfills from the pinned checkpoint down to the target", async () => {
    const { electrum, request } = makeElectrum();

    await backfillHeaders(electrum, FIXTURE_START);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "blockchain.block.headers",
      FIXTURE_START,
      13
    );
    expect(await storedHeights()).toEqual(
      FIXTURE_HEADERS.map((_, i) => FIXTURE_START + i)
    );

    // The checkpoint header itself is stored and matches the pinned hash.
    const cp = await db.header
      .where("height")
      .equals(CHECKPOINT_HEIGHT)
      .first();
    expect(cp?.hash).toBe(CHECKPOINT_HASH);

    // Buffers are exactly the 80 header bytes (no Buffer pool bleed-through).
    for (const row of await db.header.toArray()) {
      expect(row.buffer.byteLength).toBe(80);
      expect(row.reorg).toBe(false);
    }
  });

  it("is a no-op when the chain already covers the target", async () => {
    const { electrum, request } = makeElectrum();
    await backfillHeaders(electrum, FIXTURE_START);
    request.mockClear();

    await backfillHeaders(electrum, FIXTURE_START + 2); // above earliest
    await backfillHeaders(electrum, FIXTURE_START); // exactly earliest
    expect(request).not.toHaveBeenCalled();
  });

  it("anchors on the earliest stored header when extending", async () => {
    // Simulate a wallet that only has the checkpoint header stored.
    const cpBytes = Uint8Array.from(
      Buffer.from(FIXTURE_HEADERS[FIXTURE_HEADERS.length - 1], "hex")
    );
    await db.header.put({
      hash: CHECKPOINT_HASH,
      height: CHECKPOINT_HEIGHT,
      reorg: false,
      buffer: cpBytes.buffer,
    });

    const { electrum, request } = makeElectrum();
    await backfillHeaders(electrum, PROOF_HEIGHT);

    expect(request).toHaveBeenCalledWith(
      "blockchain.block.headers",
      PROOF_HEIGHT,
      CHECKPOINT_HEIGHT - PROOF_HEIGHT + 1
    );
    expect(await storedHeights()).toEqual([
      411995, 411996, 411997, 411998, 411999, 412000,
    ]);
  });

  it("walks down in multiple bounded chunks", async () => {
    const { electrum, request } = makeElectrum();

    await backfillHeaders(electrum, FIXTURE_START, 5);

    expect(request.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [411996, 5],
      [411992, 5],
      [411988, 5],
    ]);
    expect((await storedHeights()).length).toBe(13);
  });

  it("refuses a chunk whose top header is not the trusted anchor", async () => {
    // Serve the right count, but the top header is 411,999 again instead of
    // the checkpoint header — a server pushing a different chain.
    const { electrum, request } = makeElectrum((hex) => {
      const headers = hex.match(/.{160}/g) as string[];
      headers[headers.length - 1] = headers[headers.length - 2];
      return headers.join("");
    });

    await backfillHeaders(electrum, FIXTURE_START);

    expect(request).toHaveBeenCalledTimes(1);
    expect(await storedHeights()).toEqual([]);
  });

  it("refuses a chunk with broken internal linkage", async () => {
    // Corrupt one byte inside a middle header's Merkle root: still parseable,
    // but its hash no longer matches the next header's prevHash.
    const { electrum, request } = makeElectrum((hex) => {
      const pos = 5 * 160 + 80; // header index 5, inside the Merkle root
      const flipped = hex[pos] === "0" ? "1" : "0";
      return hex.slice(0, pos) + flipped + hex.slice(pos + 1);
    });

    await backfillHeaders(electrum, FIXTURE_START);

    expect(request).toHaveBeenCalledTimes(1);
    expect(await storedHeights()).toEqual([]);
  });

  it("refuses a truncated response", async () => {
    const { electrum } = makeElectrum((hex) => hex.slice(0, hex.length - 160));

    await backfillHeaders(electrum, FIXTURE_START);

    expect(await storedHeights()).toEqual([]);
  });

  it("degrades gracefully when the server request fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("socket dropped");
    });
    const electrum = { client: { request } } as unknown as ElectrumManager;

    await expect(
      backfillHeaders(electrum, FIXTURE_START)
    ).resolves.toBeUndefined();
    expect(await storedHeights()).toEqual([]);
  });

  it("ignores nonsense targets without fetching", async () => {
    const { electrum, request } = makeElectrum();
    await backfillHeaders(electrum, NaN);
    await backfillHeaders(electrum, -1);
    await backfillHeaders(electrum, Infinity);
    expect(request).not.toHaveBeenCalled();
  });

  it("serializes concurrent calls instead of double-fetching", async () => {
    const { electrum, request } = makeElectrum();

    await Promise.all([
      backfillHeaders(electrum, FIXTURE_START),
      backfillHeaders(electrum, FIXTURE_START + 2),
    ]);

    expect(request).toHaveBeenCalledTimes(1);
    expect((await storedHeights()).length).toBe(13);
  });
});

describe("verifyTxoInclusion after backfill (the pending-FT fix, end to end)", () => {
  it("an old coin unprovable before backfill verifies after it", async () => {
    // A requester that serves the real Merkle proof for the old coin.
    const proofRequester = {
      request: vi.fn(async (method: string) => {
        if (method !== "blockchain.transaction.get_merkle") {
          throw new Error(`unexpected method ${method}`);
        }
        return PROOF;
      }),
    } as unknown as ElectrumRequester;

    // Before backfill: no header at 411,995 — the proof cannot be checked, so
    // the coin stays unverified ("Pending") exactly as users observed.
    expect(
      await verifyTxoInclusion(proofRequester, PROOF_TXID, PROOF_HEIGHT)
    ).toBe(false);

    // Backfill the missing range, then the same proof verifies.
    const { electrum } = makeElectrum();
    await backfillHeaders(electrum, PROOF_HEIGHT);
    expect(
      await verifyTxoInclusion(proofRequester, PROOF_TXID, PROOF_HEIGHT)
    ).toBe(true);
  });
});
