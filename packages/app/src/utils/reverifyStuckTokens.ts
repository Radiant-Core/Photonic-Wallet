import db from "@app/db";
import { ContractType, TxO } from "@app/types";
import { verifyTxoInclusion } from "@app/electrum/worker/verifyTxo";
import { updateFtBalances } from "@app/utxos";
import { electrumWorker } from "@app/electrum/Electrum";
import { reverseRef } from "@lib/Outpoint";
import { parseFtScript } from "@lib/script";

/**
 * A txo plus the SPV verification flag (same as in updateTxos.ts)
 */
type VerifiableTxO = TxO & { verified?: 0 | 1 };

/**
 * Force re-verification of stuck UTXOs that have height but failed SPV verification.
 * This fixes tokens that remain in "pending" state indefinitely due to failed verification.
 */
export async function reverifyStuckTokens() {
  console.log("[Reverify] Starting re-verification of stuck tokens...");
  
  // Find all FT UTXOs that have a confirmed height but failed verification (verified: 0 or undefined)
  const allTxos = await db.txo
    .where("contractType")
    .equals(ContractType.FT)
    .toArray();
  
  const stuckTxos = allTxos.filter((txo): txo is VerifiableTxO => 
    txo.height !== undefined && 
    txo.height !== Infinity && 
    txo.height > 0 && 
    txo.spent === 0 && 
    ((txo as any).verified === 0 || (txo as any).verified === undefined)
  );

  if (stuckTxos.length === 0) {
    console.log("[Reverify] No stuck tokens found");
    return { success: true, reverified: 0, tokens: [] };
  }

  console.log(`[Reverify] Found ${stuckTxos.length} stuck UTXOs, attempting re-verification...`);

  const electrum = await electrumWorker.value;
  let reverifiedCount = 0;
  const affectedTokens: string[] = [];
  const touchedScripts = new Set<string>();

  // Process each stuck UTXO
  for (const txo of stuckTxos) {
    try {
      // Attempt SPV verification again using the worker's verifyTransaction method
      const verificationResult = await electrum.verifyTransaction(txo.txid, txo.height!);
      const verified = verificationResult.status === "verified";

      if (verified) {
        // Update the UTXO as verified
        await db.txo.update(txo.id as number, { verified: 1 });
        reverifiedCount++;
        touchedScripts.add(txo.script);
        
        // Extract token ref for reporting
        const { ref } = parseFtScript(txo.script);
        if (ref) {
          const tokenRef = reverseRef(ref);
          affectedTokens.push(tokenRef);
        }
        
        console.log(`[Reverify] Successfully re-verified UTXO ${txo.txid}:${txo.vout}`);
      } else {
        console.log(`[Reverify] Verification still failed for UTXO ${txo.txid}:${txo.vout}: ${verificationResult.status}`);
      }
    } catch (error) {
      console.error(`[Reverify] Error re-verifying UTXO ${txo.txid}:${txo.vout}:`, error);
    }
  }

  // Update FT balances for any affected scripts
  if (touchedScripts.size > 0) {
    console.log(`[Reverify] Updating balances for ${touchedScripts.size} affected scripts...`);
    updateFtBalances(touchedScripts);
  }

  const uniqueTokens = [...new Set(affectedTokens)];
  
  console.log(`[Reverify] Re-verification complete. ${reverifiedCount}/${stuckTxos.length} UTXOs verified. Affected tokens: ${uniqueTokens.join(", ")}`);
  
  return {
    success: true,
    reverified: reverifiedCount,
    total: stuckTxos.length,
    tokens: uniqueTokens
  };
}

/**
 * Force re-verification for specific token references (ASERT, BLAKE3, K12)
 */
export async function reverifySpecificTokens(tokenRefs: string[]) {
  console.log(`[Reverify] Starting targeted re-verification for tokens: ${tokenRefs.join(", ")}`);
  
  let totalReverified = 0;
  const results: { [tokenRef: string]: { reverified: number; total: number } } = {};
  
  for (const tokenRef of tokenRefs) {
    // Find UTXOs for this specific token
    const allTokenTxos = await db.txo
      .where("contractType")
      .equals(ContractType.FT)
      .toArray();
    
    const tokenTxos = allTokenTxos.filter((txo): txo is VerifiableTxO => {
      const { ref } = parseFtScript(txo.script);
      return Boolean(ref && reverseRef(ref) === tokenRef && 
             txo.height !== undefined && 
             txo.height !== Infinity && 
             txo.height > 0 && 
             txo.spent === 0 && 
             ((txo as any).verified === 0 || (txo as any).verified === undefined));
    });
    
    if (tokenTxos.length === 0) {
      console.log(`[Reverify] No stuck UTXOs found for token ${tokenRef}`);
      results[tokenRef] = { reverified: 0, total: 0 };
      continue;
    }
    
    console.log(`[Reverify] Found ${tokenTxos.length} stuck UTXOs for token ${tokenRef}`);
    
    const electrum = await electrumWorker.value;
    let reverifiedCount = 0;
    const touchedScripts = new Set<string>();
    
    for (const txo of tokenTxos) {
      try {
        const verificationResult = await electrum.verifyTransaction(txo.txid, txo.height!);
        const verified = verificationResult.status === "verified";
        
        if (verified) {
          await db.txo.update(txo.id as number, { verified: 1 });
          reverifiedCount++;
          touchedScripts.add(txo.script);
          console.log(`[Reverify] Successfully re-verified ${tokenRef} UTXO ${txo.txid}:${txo.vout}`);
        } else {
          console.log(`[Reverify] Verification still failed for ${tokenRef} UTXO ${txo.txid}:${txo.vout}: ${verificationResult.status}`);
        }
      } catch (error) {
        console.error(`[Reverify] Error re-verifying ${tokenRef} UTXO ${txo.txid}:${txo.vout}:`, error);
      }
    }
    
    if (touchedScripts.size > 0) {
      updateFtBalances(touchedScripts);
    }
    
    results[tokenRef] = { reverified: reverifiedCount, total: tokenTxos.length };
    totalReverified += reverifiedCount;
    
    console.log(`[Reverify] Token ${tokenRef}: ${reverifiedCount}/${tokenTxos.length} UTXOs re-verified`);
  }
  
  console.log(`[Reverify] Targeted re-verification complete. Total re-verified: ${totalReverified}`);
  
  return {
    success: true,
    results,
    totalReverified
  };
}
