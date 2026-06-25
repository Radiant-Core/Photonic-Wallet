import { SelectableInput } from "@lib/coinSelect";
import db from "./db";
import { UnfinalizedInput } from "@lib/types";
import { ContractType, TxO } from "./types";
import { parseFtScript, p2pkhScript } from "@lib/script";
import { reverseRef } from "@lib/Outpoint";

/**
 * SPV verification flag carried on a stored txo (FIX 1 / R14).
 *
 * `TxO` lives in the out-of-scope `@app/types`, so we read the extra Dexie
 * column via this structural extension. `verified === 1` means the txo's
 * inclusion was proven (Merkle proof checked against a locally PoW-validated
 * header). Anything else (0 / undefined) is unverified.
 */
type VerifiableTxO = TxO & { verified?: 0 | 1 };

/**
 * A txo counts toward the CONFIRMED balance only when it has a real block
 * height AND its inclusion has been SPV-verified (FIX 1 / R14). A height that
 * the server merely *claims* (without a valid Merkle proof) is treated as
 * pending — surfaced under `unconfirmed` — so a malicious server cannot inflate
 * the confirmed/spendable balance with a fabricated confirmation.
 */
function isConfirmedAndVerified(txo: VerifiableTxO): boolean {
  return txo.height !== Infinity && txo.height !== undefined && txo.verified === 1;
}

// Update txo table after a transaction. This will keep the db in sync before an ElectrumX subscription is received.
// ownScript and changeScript will be the same for RXD UTXOs
export async function updateWalletUtxos(
  contractType: ContractType,
  ownScript: string,
  changeScript: string,
  txid: string,
  inputs: SelectableInput[],
  outputs: UnfinalizedInput[]
) {
  const newTxos: TxO[] = [];
  await db.transaction("rw", db.txo, async () => {
    // Spend inputs
    await Promise.all(
      inputs.map(async (input) => {
        const { utxo } = input;
        // FIXME this is a bit messy
        const { id } = (utxo as TxO) || input;
        if (id) {
          await db.txo.update(id, {
            spent: 1,
          });
        }
      })
    );
    // Add outputs
    for (const [vout, output] of outputs.entries()) {
      // Check for FT change, FT sent to self or RXD funding change
      const sentToSelf = output.script === ownScript;
      if (sentToSelf || output.script === changeScript) {
        const outputContractType = sentToSelf ? contractType : ContractType.RXD;
        const txo: TxO = {
          contractType: outputContractType,
          script: output.script,
          spent: 0,
          height: Infinity,
          txid,
          vout,
          value: output.value,
          change: 1,
          date: new Date().getTime(),
        };
        const id = (await db.txo.put(txo)) as number;
        newTxos.push({ ...txo, id });
      }
    }
  });
  return newTxos;
}

// Reconcile the local UTXO set after a multi-asset batch send or wallet sweep.
//
// A batch/sweep transaction can spend RXD + several FT types + several NFTs and
// produce token outputs to a recipient plus (optionally) RXD change. The
// single-contract `updateWalletUtxos` doesn't fit, so this applies the changes
// directly:
//   - every selected input is marked spent;
//   - any output paying our own P2PKH (RXD change — present for a batch send,
//     absent for a sweep, where change goes to the recipient) is recorded;
//   - NFTs that left the wallet have their glyph row marked spent so the grid
//     drops them immediately (mirrors SendDigitalObject);
//   - FT and RXD balances are recomputed.
export async function updateAfterBatchTransfer({
  ownAddress,
  txid,
  inputs,
  outputs,
  ftScripts,
  sentNftTxoIds,
  nftLeftWallet,
}: {
  ownAddress: string;
  txid: string;
  inputs: SelectableInput[];
  outputs: UnfinalizedInput[];
  ftScripts: Set<string>;
  sentNftTxoIds: number[];
  nftLeftWallet: boolean;
}) {
  const changeScript = p2pkhScript(ownAddress);

  await db.transaction("rw", db.txo, db.glyph, async () => {
    // Spend every selected input.
    await Promise.all(
      inputs.map(async (input) => {
        const { utxo } = input;
        const { id } = (utxo as TxO) || (input as unknown as TxO);
        if (id) {
          await db.txo.update(id, { spent: 1 });
        }
      })
    );

    // Record our own RXD change so it isn't lost before the next sync.
    for (const [vout, output] of outputs.entries()) {
      if (output.script === changeScript) {
        const txo: TxO = {
          contractType: ContractType.RXD,
          script: output.script,
          spent: 0,
          height: Infinity,
          txid,
          vout,
          value: output.value,
          change: 1,
          date: Date.now(),
        };
        await db.txo.put(txo);
      }
    }

    // NFTs that left the wallet: drop their glyph rows from the owned grid.
    if (nftLeftWallet) {
      for (const txoId of sentNftTxoIds) {
        await db.glyph.where({ lastTxoId: txoId }).modify({ spent: 1 });
      }
    }
  });

  if (ftScripts.size) {
    await updateFtBalances(ftScripts);
  }
  await updateRxdBalances(ownAddress);
}

// Update RXD balances
export async function updateRxdBalances(id: string) {
  await db.transaction("rw", db.txo, db.balance, async () => {
    let confirmed = 0;
    let unconfirmed = 0;
    await db.txo
      .where({ contractType: ContractType.RXD, spent: 0 })
      .each((txo) => {
        // FIX 1 (R14): only SPV-verified confirmations count as confirmed.
        // Claimed-confirmed-but-unverified coins are surfaced as pending.
        if (isConfirmedAndVerified(txo as VerifiableTxO)) {
          confirmed += txo.value;
        } else {
          unconfirmed += txo.value;
        }
      });

    await db.balance.put({ id, confirmed, unconfirmed });
  });
}

// Update NFT owned status for an address.
// Stub: the body previously built an unused Dexie query that never executed.
// Kept as a no-op so call sites compile; the real implementation needs
// proper script parsing rather than a substring match.
export async function updateNFTOwned(_address: string) {
  void _address;
}

// Update FT balances
export async function updateFtBalances(scripts: Set<string>) {
  await db.transaction("rw", db.txo, db.balance, async () => {
    for (const script of scripts) {
      let confirmed = 0;
      let unconfirmed = 0;
      await db.txo.where({ script, spent: 0 }).each((txo) => {
        // FIX 1 (R14): only SPV-verified confirmations count as confirmed.
        if (isConfirmedAndVerified(txo as VerifiableTxO)) {
          confirmed += txo.value;
        } else {
          unconfirmed += txo.value;
        }
      });
      const { ref } = parseFtScript(script);
      await db.balance.put({
        id: reverseRef(ref as string),
        confirmed,
        unconfirmed,
      });
    }
  });
}
