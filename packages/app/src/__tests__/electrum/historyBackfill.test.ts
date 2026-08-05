/* eslint-disable @typescript-eslint/ban-ts-comment */
/**
 * History-backfill tests (restored-wallet activity reconstruction).
 *
 * The classifier is exercised with real serialized radiantjs transactions —
 * inputs carry `<sig> <pubkey>` scriptSigs (fake DER sigs, real pubkeys), so
 * input-ownership detection runs against genuine script parsing, not mocks.
 * The orchestrator runs over the real Dexie (`@app/db` on fake-indexeddb)
 * with a stub Electrum serving the built txs, covering: fresh backfill,
 * phantom-receive correction, own-record authority, per-address latching, and
 * header-derived dating.
 */
import "../helpers/fakeIdb"; // must be first: real fake-indexeddb + Dexie shims
import { describe, it, expect, beforeEach, vi } from "vitest";
vi.unmock("@app/db");

import db from "@app/db";
import {
  classifyHistoryTx,
  ownPkhsForAddresses,
  backfillHistory,
} from "@app/electrum/worker/historyBackfill";
import { p2pkhScript, nftScript, ftScript } from "@lib/script";
import { dsha256, bytesToHex } from "@lib/crypto";
import type ElectrumManager from "@app/electrum/ElectrumManager";
import {
  PrivateKey,
  Transaction,
  Script,
  // @ts-ignore
} from "@radiant-core/radiantjs";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const ourKey = new PrivateKey();
const otherKey = new PrivateKey();
const ourAddress = ourKey.toAddress().toString();
const otherAddress = otherKey.toAddress().toString();
const ourPub: Buffer = ourKey.publicKey.toBuffer();
const otherPub: Buffer = otherKey.publicKey.toBuffer();
const ownPkhs = ownPkhsForAddresses([ourAddress]);

const REF = "aa".repeat(36); // 72-hex singleton ref

const SIGHASH_ALL_FORKID = 0x41;
const SIGHASH_SWAP = 0xc1; // ALL | FORKID | ANYONECANPAY

/** Fake DER signature: starts 0x30 (never mistaken for a pubkey), carries a
 *  real sighash byte at the end. 71 bytes so the pubkey-length check skips it. */
function fakeSig(sighash: number): Buffer {
  const sig = Buffer.alloc(71, 0x01);
  sig[0] = 0x30;
  sig[70] = sighash;
  return sig;
}

/** Standard-shape scriptSig: [extra…] <sig> <pubkey>. */
function sigScript(
  pub: Buffer,
  sighash = SIGHASH_ALL_FORKID,
  extra?: Buffer
): InstanceType<typeof Script> {
  const s = new Script();
  if (extra) s.add(extra);
  s.add(fakeSig(sighash));
  s.add(pub);
  return s;
}

function buildTx(
  inputScripts: InstanceType<typeof Script>[],
  outputs: { script: string; sats: number }[]
): string {
  const tx = new Transaction();
  inputScripts.forEach((script, i) => {
    tx.addInput(
      new Transaction.Input({
        prevTxId: bytesToHex(new Uint8Array(32).fill(i + 1)),
        outputIndex: 0,
        script,
        output: new Transaction.Output({ script: new Script(), satoshis: 0 }),
      })
    );
  });
  for (const { script, sats } of outputs) {
    tx.addOutput(
      new Transaction.Output({ script: Script.fromHex(script), satoshis: sats })
    );
  }
  // Present at runtime but missing from radiant.d.ts; plain serialize() would
  // reject the fake signatures.
  return (
    tx as unknown as { uncheckedSerialize: () => string }
  ).uncheckedSerialize();
}

/** Display txid (big-endian hex) of a raw tx — what get_history returns.
 *  (Fresh Uint8Array: noble rejects cross-realm Buffer instances in jsdom.) */
function txidOf(rawHex: string): string {
  return bytesToHex(dsha256(new Uint8Array(Buffer.from(rawHex, "hex"))).reverse());
}

/* ------------------------------------------------------------------ */
/* Classifier                                                          */
/* ------------------------------------------------------------------ */

describe("ownPkhsForAddresses", () => {
  it("derives the hash160 for each address and skips invalid ones", () => {
    const pkhs = ownPkhsForAddresses([ourAddress, "not-an-address"]);
    expect(pkhs.size).toBe(1);
    const [pkh] = [...pkhs];
    expect(pkh).toMatch(/^[0-9a-f]{40}$/);
    expect(p2pkhScript(ourAddress)).toContain(pkh);
  });
});

describe("classifyHistoryTx", () => {
  it("classifies an incoming payment as rxd_receive with the received sum", () => {
    const raw = buildTx(
      [sigScript(otherPub)],
      [
        { script: p2pkhScript(ourAddress), sats: 5000 },
        { script: p2pkhScript(otherAddress), sats: 3000 }, // sender change
      ]
    );
    expect(classifyHistoryTx(raw, ownPkhs)).toEqual({
      description: "rxd_receive",
      amount: 5000,
    });
  });

  it("classifies our spend as rxd_send even though change returns to us", () => {
    // This is exactly the phantom-receive case: after a restore the change
    // output would otherwise be logged as "Received RXD".
    const raw = buildTx(
      [sigScript(ourPub)],
      [
        { script: p2pkhScript(otherAddress), sats: 3000 },
        { script: p2pkhScript(ourAddress), sats: 1500 }, // our change
      ]
    );
    expect(classifyHistoryTx(raw, ownPkhs)).toEqual({
      description: "rxd_send",
      amount: 3000,
    });
  });

  it("classifies paying into an unknown script (vault/covenant) as rxd_send", () => {
    const raw = buildTx(
      [sigScript(ourPub)],
      [
        // P2SH-shaped script we don't parse
        { script: "a914" + "11".repeat(20) + "87", sats: 2000 },
        { script: p2pkhScript(ourAddress), sats: 900 },
      ]
    );
    expect(classifyHistoryTx(raw, ownPkhs)).toEqual({
      description: "rxd_send",
      amount: 2000,
    });
  });

  it("classifies an all-to-self RXD tx as consolidate (OP_RETURN ignored)", () => {
    const raw = buildTx(
      [sigScript(ourPub)],
      [
        { script: p2pkhScript(ourAddress), sats: 4000 },
        { script: "6a04deadbeef", sats: 0 }, // zero-value OP_RETURN
      ]
    );
    expect(classifyHistoryTx(raw, ownPkhs)).toEqual({
      description: "consolidate",
    });
  });

  it("classifies NFT movements by the singleton script owner", () => {
    const recv = buildTx(
      [sigScript(otherPub)],
      [{ script: nftScript(ourAddress, REF), sats: 1 }]
    );
    expect(classifyHistoryTx(recv, ownPkhs)?.description).toBe("nft_receive");

    const send = buildTx(
      [sigScript(ourPub)],
      [
        { script: nftScript(otherAddress, REF), sats: 1 },
        { script: p2pkhScript(ourAddress), sats: 500 },
      ]
    );
    expect(classifyHistoryTx(send, ownPkhs)?.description).toBe("nft_send");
  });

  it("classifies FT movements with token-unit amounts", () => {
    const send = buildTx(
      [sigScript(ourPub)],
      [
        { script: ftScript(otherAddress, REF), sats: 100 },
        { script: ftScript(ourAddress, REF), sats: 50 }, // token change
        { script: p2pkhScript(ourAddress), sats: 700 },
      ]
    );
    expect(classifyHistoryTx(send, ownPkhs)).toEqual({
      description: "ft_send",
      amount: 100,
    });

    const recv = buildTx(
      [sigScript(otherPub)],
      [{ script: ftScript(ourAddress, REF), sats: 250 }]
    );
    expect(classifyHistoryTx(recv, ownPkhs)).toEqual({
      description: "ft_receive",
      amount: 250,
    });
  });

  it("recognises a glyph reveal to self as a mint", () => {
    const glyphEnvelope = Buffer.concat([
      Buffer.from("676c79", "hex"), // "gly" magic
      Buffer.from([0x00, 0x01]),
    ]);
    const raw = buildTx(
      [sigScript(ourPub, SIGHASH_ALL_FORKID, glyphEnvelope)],
      [
        { script: nftScript(ourAddress, REF), sats: 1 },
        { script: p2pkhScript(ourAddress), sats: 300 },
      ]
    );
    expect(classifyHistoryTx(raw, ownPkhs)?.description).toBe("nft_mint");
  });

  it("recognises a completed swap by our ANYONECANPAY pre-signed input", () => {
    const raw = buildTx(
      [sigScript(ourPub, SIGHASH_SWAP), sigScript(otherPub)],
      [
        { script: p2pkhScript(otherAddress), sats: 7000 }, // their side
        { script: ftScript(ourAddress, REF), sats: 100 }, // what we got
      ]
    );
    expect(classifyHistoryTx(raw, ownPkhs)?.description).toBe("rxd_swap");
  });

  it("labels a token self-move neutrally instead of guessing", () => {
    const raw = buildTx(
      [sigScript(ourPub)],
      [
        { script: nftScript(ourAddress, REF), sats: 1 },
        { script: p2pkhScript(ourAddress), sats: 400 },
      ]
    );
    expect(classifyHistoryTx(raw, ownPkhs)?.description).toBe("chain_activity");
  });

  it("returns null for a tx with no detectable wallet involvement", () => {
    const raw = buildTx(
      [sigScript(otherPub)],
      [{ script: p2pkhScript(otherAddress), sats: 1000 }]
    );
    expect(classifyHistoryTx(raw, ownPkhs)).toBeNull();
    expect(classifyHistoryTx("nothex", ownPkhs)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

const rawSend = buildTx(
  [sigScript(ourPub)],
  [
    { script: p2pkhScript(otherAddress), sats: 3000 },
    { script: p2pkhScript(ourAddress), sats: 1500 },
  ]
);
const rawRecv = buildTx(
  [sigScript(otherPub)],
  [{ script: p2pkhScript(ourAddress), sats: 5000 }]
);
const sendTxid = txidOf(rawSend);
const recvTxid = txidOf(rawRecv);

function electrumStub(
  history: { tx_hash: string; height: number }[],
  txs: Record<string, string> = { [sendTxid]: rawSend, [recvTxid]: rawRecv }
): ElectrumManager {
  const request = vi.fn(async (method: string, ...params: unknown[]) => {
    if (method === "blockchain.scripthash.get_history") return history;
    if (method === "blockchain.transaction.get") {
      const raw = txs[params[0] as string];
      if (!raw) throw new Error(`no fixture tx ${params[0]}`);
      return raw;
    }
    // backfillHeaders probes this; an undefined response makes it abort
    // gracefully without extending the chain.
    if (method === "blockchain.block.headers") return undefined;
    throw new Error(`unexpected electrum method ${method}`);
  });
  return { client: { request } } as unknown as ElectrumManager;
}

describe("backfillHistory", () => {
  beforeEach(async () => {
    await db.broadcast.clear();
    await db.header.clear();
    await db.kvp.delete("historyBackfill");
  });

  it("records sends and receives from history and latches when complete", async () => {
    const result = await backfillHistory(
      electrumStub([
        { tx_hash: sendTxid, height: 0 },
        { tx_hash: recvTxid, height: 0 },
      ]),
      [ourAddress]
    );

    expect(result.recorded).toBe(2);
    expect(result.complete).toBe(true);

    const send = await db.broadcast.get(sendTxid);
    expect(send?.description).toBe("rxd_send");
    expect(send?.amount).toBe(3000);
    const recv = await db.broadcast.get(recvTxid);
    expect(recv?.description).toBe("rxd_receive");
    expect(recv?.amount).toBe(5000);

    const latch = (await db.kvp.get("historyBackfill")) as Record<
      string,
      { completedAt: number }
    >;
    expect(latch?.[ourAddress]?.completedAt).toBeGreaterThan(0);
  });

  it("corrects a phantom receive (our own change) into the real send", async () => {
    // What recordReceivedActivity logs after a restore, before backfill runs.
    await db.broadcast.put({
      txid: sendTxid,
      description: "rxd_receive",
      date: 123,
      amount: 1500,
    });

    const result = await backfillHistory(
      electrumStub([{ tx_hash: sendTxid, height: 0 }]),
      [ourAddress]
    );

    expect(result.reclassified).toBe(1);
    const entry = await db.broadcast.get(sendTxid);
    expect(entry?.description).toBe("rxd_send");
    expect(entry?.amount).toBe(3000);
  });

  it("never overwrites the wallet's own broadcast-time records", async () => {
    await db.broadcast.put({
      txid: sendTxid,
      description: "rxd_swap",
      date: 5,
      amount: 9,
    });

    const result = await backfillHistory(
      electrumStub([{ tx_hash: sendTxid, height: 0 }]),
      [ourAddress]
    );

    expect(result.recorded).toBe(0);
    expect(result.reclassified).toBe(0);
    const entry = await db.broadcast.get(sendTxid);
    expect(entry?.description).toBe("rxd_swap");
    expect(entry?.date).toBe(5);
    expect(entry?.amount).toBe(9);
  });

  it("is idempotent: a latched re-run examines nothing new", async () => {
    const stub = electrumStub([
      { tx_hash: sendTxid, height: 0 },
      { tx_hash: recvTxid, height: 0 },
    ]);
    await backfillHistory(stub, [ourAddress]);

    const again = await backfillHistory(stub, [ourAddress]);
    expect(again.recorded).toBe(0);
    expect(again.reclassified).toBe(0);
    expect(again.examined).toBe(0);
    expect(again.complete).toBe(true);
  });

  it("dates confirmed txs from the stored block header", async () => {
    const HEIGHT = 412345;
    const TIME = 1_700_000_000; // seconds
    const header = new Uint8Array(80);
    new DataView(header.buffer).setUint32(68, TIME, true);
    await db.header.put({
      hash: "00".repeat(32),
      height: HEIGHT,
      buffer: header.buffer,
      reorg: false,
    });

    const result = await backfillHistory(
      electrumStub([{ tx_hash: recvTxid, height: HEIGHT }]),
      [ourAddress]
    );

    expect(result.recorded).toBe(1);
    expect(result.complete).toBe(true);
    const entry = await db.broadcast.get(recvTxid);
    expect(entry?.date).toBe(TIME * 1000);
  });

  it("skips (and stays incomplete) when a confirmed tx's header is missing", async () => {
    const result = await backfillHistory(
      electrumStub([{ tx_hash: recvTxid, height: 999999 }]),
      [ourAddress]
    );

    expect(result.skipped).toBe(1);
    expect(result.complete).toBe(false);
    expect(await db.broadcast.get(recvTxid)).toBeUndefined();
    expect(await db.kvp.get("historyBackfill")).toBeUndefined();
  });

  it("throws HISTORY_SCAN_FAILED when get_history cannot be loaded", async () => {
    const request = vi.fn(async () => {
      throw new Error("timeout");
    });
    const electrum = { client: { request } } as unknown as ElectrumManager;
    await expect(backfillHistory(electrum, [ourAddress])).rejects.toThrow(
      "HISTORY_SCAN_FAILED"
    );
  });
});
