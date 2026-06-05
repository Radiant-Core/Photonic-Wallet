export { coinSelect } from "./coinSelect";
export { default as Outpoint } from "./Outpoint";
export { photonsToRXD } from "./format";

// v1 & v2 Token support
export * from "./token";
export * from "./protocols";
export * from "./script";
export * from "./mint";
export * from "./tx";
export * from "./types";
export * from "./wallet";

// Glyph v2 Features
export * from "./v2metadata";
export * from "./burn";
export * from "./royalty";
export * from "./royaltyCovenant";
export * from "./soulbound";
export {
  createContainer,
  addItemToContainer,
  removeItemFromContainer,
  createChildRelationship,
  validateContainer,
  getContainerStats,
  createChildToken,
  isChildToken,
  getContainerRef,
} from "./container";
export * from "./authority";
export * from "./wavenaming";
export {
  createWaveNameMetadata,
  calculateNameCost,
  generateCommitment,
  verifyCommitment,
  createWaveCommitMetadata,
  canReclaimWaveName,
  createWaveReclaimMetadata,
  isWaveDuplicate,
  getWaveDuplicateWarning,
} from "./wave";
export * from "./crypto";
export * from "./encryption";
export * from "./timelock";
export * from "./reveal";

// SPV (transaction-inclusion verification). Named exports — `dsha256` is
// already surfaced via ./crypto, so we exclude it here to avoid a duplicate.
export {
  extractMerkleRoot,
  hashBlockHeader,
  readNBits,
  verifyHeaderTarget,
  verifyMerkleProof,
  computeMerkleRootFromProof,
  verifyTxInclusion,
  BLOCK_HEADER_SIZE,
  type MerkleProof,
  type InclusionResult,
} from "./spv";

// Storage (Phase 2: Off-Chain Storage)
export * from "./storage";

// Radiant Vault (CLTV timelocking)
export * from "./vault";

// Utilities
export * from "./difficulty";
export * from "./util";
export * from "./ipfs";
