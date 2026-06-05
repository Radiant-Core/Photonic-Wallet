import { SelectableInput } from "@lib/coinSelect";
import db from "./db";
import { UnfinalizedInput } from "@lib/types";
import { ContractType, TxO } from "./types";
import { parseFtScript } from "@lib/script";
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
