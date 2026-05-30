/**
 * IPFS upload helpers.
 *
 * Audit R21: the deprecated `nft.storage@7.2.0` package (which pulled in the
 * end-of-life `js-IPFS` stack) has been removed. It was only ever used here
 * and in `storage.ts`'s `IPFSAdapter` to (a) locally encode a blob to a CAR +
 * derive its CID and (b) pin the CAR. IPFS *upload* was already disabled in
 * the UI (`Mint.tsx`), and *download* never used nft.storage — it fetches
 * from public gateways (see `storage.ts::IPFSAdapter.download`).
 *
 * Re-enabling IPFS upload requires wiring a maintained pinning client — e.g.
 * Storacha (`@storacha/client`, the successor to web3.storage/nft.storage),
 * Pinata's pinning API, or a self-hosted IPFS/Kubo node. That client must:
 *   1. encode the blob to UnixFS + CAR and derive the CIDv1 locally, and
 *   2. upload/pin the CAR, returning the CID.
 * Until then these functions throw rather than silently no-op.
 */

const IPFS_UPLOAD_DISABLED_MESSAGE =
  "IPFS upload is not available: the deprecated nft.storage backend was " +
  "removed (audit R21). Wire a maintained pinning client (Storacha / Pinata / " +
  "self-hosted Kubo) to re-enable. Downloads from IPFS gateways still work.";

/**
 * Locally derive the CIDv1 for a blob without uploading.
 *
 * Disabled pending a maintained CAR encoder — see module docs. Kept as an
 * export so callers and the type surface remain stable for the re-enable.
 */
export async function encodeCid(_data: ArrayBuffer): Promise<string> {
  void _data;
  throw new Error(IPFS_UPLOAD_DISABLED_MESSAGE);
}

/**
 * Upload + pin a blob to IPFS.
 *
 * Disabled pending a maintained pinning client — see module docs.
 */
export async function upload(
  _data: ArrayBuffer,
  _expectedCid: string,
  _dryRun: boolean,
  _apiKey: string
): Promise<string> {
  void _data;
  void _expectedCid;
  void _dryRun;
  void _apiKey;
  throw new Error(IPFS_UPLOAD_DISABLED_MESSAGE);
}
