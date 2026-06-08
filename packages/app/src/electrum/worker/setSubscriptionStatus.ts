import db from "@app/db";
import { ContractType } from "@app/types";

let init = false;

async function writeSyncState(
  scriptHash: string,
  contractType: ContractType,
  sync: { done: boolean; error: boolean },
  status?: string
) {
  // Only overwrite the stored server status on success. On error we leave it
  // untouched so the NEXT retry still sees status != newStatus and actually
  // re-syncs (buildUpdateTXOs early-returns when the stored status matches).
  const patch: { contractType: ContractType; sync: typeof sync; status?: string } =
    { contractType, sync };
  if (status !== undefined) patch.status = status;
  await db.subscriptionStatus.update(scriptHash, patch);

  // When restoring a wallet, wait for all subscriptions to be initialised before allowing notifications
  if (!init) {
    const exists = await db.kvp.get("lastNotification");
    if (exists) {
      init = true;
    } else {
      const count = await db.subscriptionStatus
        .filter((status) => status.sync.done)
        .count();
      if (count === 4) {
        const maxId = (await db.txo.orderBy("id").reverse().first())?.id || 0;
        db.kvp.put(maxId, "lastNotification");
        init = true;
      }
    }
  }
}

export default async function setSubscriptionStatus(
  scriptHash: string,
  status: string,
  error: boolean,
  contractType: ContractType
) {
  await writeSyncState(scriptHash, contractType, { done: true, error }, status);
}

/**
 * Mark a subscription as errored after the retry breaker trips, so the UI stops
 * showing an indefinite "syncing" spinner. Crucially does NOT persist a status,
 * so the next (backed-off) retry still re-syncs rather than short-circuiting as
 * "status unchanged". A later success clears this via setSubscriptionStatus.
 */
export async function setSubscriptionError(
  scriptHash: string,
  contractType: ContractType
) {
  await writeSyncState(scriptHash, contractType, { done: true, error: true });
}
