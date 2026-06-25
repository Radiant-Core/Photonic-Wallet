/**
 * Unit tests for the multi-asset batch send and wallet sweep helpers
 * (`../transfer` → transferBatch / sweepAll).
 *
 * These build and sign real transactions with a locally generated key (no
 * network), then assert on the resulting input/output structure and fee:
 *   - a batch send consolidates each FT type into one recipient output, gives
 *     each NFT its own singleton output, and returns RXD change to the sender;
 *   - a sweep consumes every RXD coin and routes the leftover (minus fee) to
 *     the recipient, leaving no sender change;
 *   - guards (too many inputs, insufficient funds, empty selection) throw.
 */
import { it, expect, describe } from "vitest";
import rjs from "@radiant-core/radiantjs";
import {
  transferBatch,
  sweepAll,
  TransferError,
  MAX_BATCH_INPUTS,
} from "../transfer";
import { SelectableInput } from "../coinSelect";
import { ftScript, nftScript, p2pkhScript } from "../script";
import { MIN_RELAY_FEE_RATE } from "../feePolicy";

const { PrivateKey } = rjs;

const FEE_RATE = MIN_RELAY_FEE_RATE;

// Distinct 36-byte (72 hex char) little-endian refs.
const REF_A = "a1".repeat(36);
const REF_B = "b2".repeat(36);
const REF_C = "c3".repeat(36);

// Deterministic, always-valid 32-byte hex txid derived from an arbitrary seed.
const txid = (seed: string) => {
  let h = "";
  for (let i = 0; i < seed.length; i++) {
    h += seed.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return h.padEnd(64, "0").slice(0, 64);
};

function makeKey() {
  const key = new PrivateKey();
  return { wif: key.toWIF(), address: key.toAddress().toString() };
}

function ftUtxo(
  ownerAddress: string,
  ref: string,
  value: number,
  id: string
): SelectableInput {
  return {
    txid: txid(id),
    vout: 0,
    script: ftScript(ownerAddress, ref),
    value,
  };
}

function nftUtxo(
  ownerAddress: string,
  ref: string,
  value: number,
  id: string
): SelectableInput {
  return {
    txid: txid(id),
    vout: 0,
    script: nftScript(ownerAddress, ref),
    value,
  };
}

function rxdUtxo(
  ownerAddress: string,
  value: number,
  id: string,
  vout = 0
): SelectableInput {
  return {
    txid: txid(id),
    vout,
    script: p2pkhScript(ownerAddress),
    value,
  };
}

const outputScripts = (tx: rjs.Transaction) =>
  tx.outputs.map((o) => o.script.toHex());
const outputValues = (tx: rjs.Transaction) => tx.outputs.map((o) => o.satoshis);

describe("transferBatch (batch send to one recipient)", () => {
  it("consolidates multiple FT types and NFTs into one transaction", () => {
    const sender = makeKey();
    const recipient = makeKey();

    const fts = [
      {
        refLE: REF_A,
        utxos: [
          ftUtxo(sender.address, REF_A, 500, "1a"),
          ftUtxo(sender.address, REF_A, 300, "1b"),
        ],
      },
      {
        refLE: REF_B,
        utxos: [ftUtxo(sender.address, REF_B, 1000, "2a")],
      },
    ];
    const nfts = [{ refLE: REF_C, utxo: nftUtxo(sender.address, REF_C, 1, "3a") }];
    const coins = [rxdUtxo(sender.address, 100_000_000, "f0")];

    const { tx, selected } = transferBatch(
      coins,
      fts,
      nfts,
      sender.address,
      recipient.address,
      FEE_RATE,
      sender.wif
    );

    const scripts = outputScripts(tx);
    const values = outputValues(tx);

    // One consolidated FT output per token type, at the recipient.
    const ftAIdx = scripts.indexOf(ftScript(recipient.address, REF_A));
    const ftBIdx = scripts.indexOf(ftScript(recipient.address, REF_B));
    const nftIdx = scripts.indexOf(nftScript(recipient.address, REF_C));
    expect(ftAIdx).toBeGreaterThanOrEqual(0);
    expect(ftBIdx).toBeGreaterThanOrEqual(0);
    expect(nftIdx).toBeGreaterThanOrEqual(0);
    expect(values[ftAIdx]).toBe(800); // 500 + 300
    expect(values[ftBIdx]).toBe(1000);
    expect(values[nftIdx]).toBe(1);

    // RXD change returns to the sender, not the recipient.
    const senderChange = p2pkhScript(sender.address);
    expect(scripts).toContain(senderChange);
    expect(scripts).not.toContain(p2pkhScript(recipient.address));

    // All token inputs are spent (3 FT + 1 NFT) plus at least one RXD coin.
    expect(selected.inputs.length).toBeGreaterThanOrEqual(5);

    // Realized fee is positive and matches the signed transaction.
    expect(selected.fee).toBeGreaterThan(0);
    expect(tx.getFee()).toBe(selected.fee);
  });

  it("sends an NFT-only batch", () => {
    const sender = makeKey();
    const recipient = makeKey();
    const nfts = [
      { refLE: REF_A, utxo: nftUtxo(sender.address, REF_A, 1, "n1") },
      { refLE: REF_B, utxo: nftUtxo(sender.address, REF_B, 1, "n2") },
    ];
    const coins = [rxdUtxo(sender.address, 100_000_000, "f0")];

    const { tx } = transferBatch(
      coins,
      [],
      nfts,
      sender.address,
      recipient.address,
      FEE_RATE,
      sender.wif
    );

    const scripts = outputScripts(tx);
    expect(scripts).toContain(nftScript(recipient.address, REF_A));
    expect(scripts).toContain(nftScript(recipient.address, REF_B));
  });

  it("throws when nothing is selected", () => {
    const sender = makeKey();
    const recipient = makeKey();
    expect(() =>
      transferBatch(
        [rxdUtxo(sender.address, 100_000_000, "f0")],
        [],
        [],
        sender.address,
        recipient.address,
        FEE_RATE,
        sender.wif
      )
    ).toThrow(TransferError);
  });

  it("throws on insufficient RXD to cover the fee", () => {
    const sender = makeKey();
    const recipient = makeKey();
    expect(() =>
      transferBatch(
        [rxdUtxo(sender.address, 10, "f0")], // far below the fee
        [],
        [{ refLE: REF_A, utxo: nftUtxo(sender.address, REF_A, 1, "n1") }],
        sender.address,
        recipient.address,
        FEE_RATE,
        sender.wif
      )
    ).toThrow(/Insufficient funds/);
  });
});

describe("sweepAll (empty the wallet to one recipient)", () => {
  it("consumes every RXD coin and routes the remainder to the recipient", () => {
    const sender = makeKey();
    const recipient = makeKey();

    const fts = [
      { refLE: REF_A, utxos: [ftUtxo(sender.address, REF_A, 800, "1a")] },
    ];
    const nfts = [{ refLE: REF_C, utxo: nftUtxo(sender.address, REF_C, 1, "3a") }];
    const coins = [
      rxdUtxo(sender.address, 60_000_000, "f0"),
      rxdUtxo(sender.address, 40_000_000, "f1"),
    ];

    const { tx, selected } = sweepAll(
      coins,
      fts,
      nfts,
      sender.address,
      recipient.address,
      FEE_RATE,
      sender.wif
    );

    const scripts = outputScripts(tx);

    // No change to the sender — the wallet is emptied.
    expect(scripts).not.toContain(p2pkhScript(sender.address));
    // The RXD remainder lands at the recipient's plain address.
    expect(scripts).toContain(p2pkhScript(recipient.address));
    // Tokens move to the recipient too.
    expect(scripts).toContain(ftScript(recipient.address, REF_A));
    expect(scripts).toContain(nftScript(recipient.address, REF_C));

    // Both RXD coins plus the token inputs are all consumed.
    const inputKeys = new Set(
      selected.inputs.map((i) => `${i.txid}:${i.vout}`)
    );
    expect(inputKeys.has(`${txid("f0")}:0`)).toBe(true);
    expect(inputKeys.has(`${txid("f1")}:0`)).toBe(true);

    // The recipient receives total RXD minus the fee.
    const recipientP2pkh = p2pkhScript(recipient.address);
    const rxdOut = tx.outputs
      .filter((o) => o.script.toHex() === recipientP2pkh)
      .reduce((s, o) => s + o.satoshis, 0);
    // The change output absorbs a 1-photon rounding cushion into the fee, so
    // recipient RXD == total RXD minus the realized fee.
    expect(rxdOut).toBe(100_000_000 - selected.fee);
  });

  it("throws when the input count exceeds the cap", () => {
    const sender = makeKey();
    const recipient = makeKey();
    const coins = Array.from({ length: MAX_BATCH_INPUTS + 1 }, (_, i) =>
      rxdUtxo(sender.address, 1_000_000, `c${i}`, i)
    );
    expect(() =>
      sweepAll(
        coins,
        [],
        [{ refLE: REF_A, utxo: nftUtxo(sender.address, REF_A, 1, "n1") }],
        sender.address,
        recipient.address,
        FEE_RATE,
        sender.wif
      )
    ).toThrow(/Too many coins/);
  });
});
