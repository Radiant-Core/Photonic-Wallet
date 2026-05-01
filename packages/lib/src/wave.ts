/**
 * Glyph v2 WAVE Name Convenience API
 * Wraps wavenaming.ts with app-friendly helpers
 * Includes commit-reveal pattern and on-chain duplicate prevention
 */

import { GlyphV2Metadata } from "./v2metadata";
import { GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE } from "./protocols";
import { isValidWaveName } from "./wavenaming";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";

// Constants for commit-reveal and expiration
export const COMMIT_REVEAL_DELAY = 1; // Minimum 1 block between commit and reveal
export const DEFAULT_REGISTRATION_DURATION = 2 * 365 * 24 * 60 * 60; // 2 years in seconds
export const GRACE_PERIOD = 30 * 24 * 60 * 60; // 30 days grace period after expiration

/**
 * Validate a full WAVE name string (e.g., "alice.rxd")
 */
export function validateWaveName(
  fullName: string
): { valid: boolean; error?: string } {
  if (!fullName) {
    return { valid: false, error: "Name is required" };
  }

  const parts = fullName.split(".");
  const name = parts[0];

  if (!name || name.length < 3) {
    return { valid: false, error: "Name must be at least 3 characters" };
  }

  if (name.length > 63) {
    return { valid: false, error: "Name must be 63 characters or less" };
  }

  if (!isValidWaveName(name)) {
    return {
      valid: false,
      error: "Name must be lowercase alphanumeric and hyphens, cannot start/end with hyphen",
    };
  }

  return { valid: true };
}

/**
 * Calculate registration cost based on name length
 * Shorter names cost more (in photons/satoshis)
 */
export function calculateNameCost(fullName: string): number {
  const name = fullName.split(".")[0];
  if (!name) return 0;

  const len = name.length;

  // Pricing tiers (in photons) - 1 RXD = 100,000,000 photons
  if (len <= 3) return 10_000_000_000;  // 100 RXD
  if (len === 4) return 5_000_000_000;   // 50 RXD
  if (len === 5) return 1_000_000_000;   // 10 RXD
  return 500_000_000;                    // 5 RXD for 6+ chars
}

/**
 * Create WAVE name token metadata for minting
 */
export function createWaveNameMetadata(
  fullName: string,
  ownerAddress: string,
  options?: {
    target?: string;
    desc?: string;
    expires?: number;
    data?: Record<string, unknown>;
  }
): GlyphV2Metadata {
  const parts = fullName.split(".");
  const name = parts[0];
  const domain = parts[1] || "rxd";

  // Calculate default expiration (2 years from now)
  const now = Math.floor(Date.now() / 1000);
  const expires = options?.expires ?? (now + DEFAULT_REGISTRATION_DURATION);

  return {
    v: 2,
    p: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE],
    name: fullName,
    desc: options?.desc,
    type: "wave_name",
    attrs: {
      name,
      domain,
      target: options?.target || ownerAddress,
      target_type: "address",
      expires, // Always include expiration
      ...(options?.data && { records: options.data }),
    } as any,
  };
}

/**
 * Generate a commitment for the commit-reveal pattern
 * Returns the commitment hash and the salt (keep salt secret until reveal)
 */
export function generateCommitment(fullName: string): {
  commitment: string;
  salt: string;
} {
  const salt = bytesToHex(randomBytes(16)); // 16 bytes = 32 hex chars
  const commitment = bytesToHex(sha256(fullName + salt));
  return { commitment, salt };
}

/**
 * Verify that a revealed name matches the commitment
 */
export function verifyCommitment(
  commitment: string,
  fullName: string,
  salt: string
): boolean {
  const computed = bytesToHex(sha256(fullName + salt));
  return computed === commitment;
}

/**
 * Create commit-phase metadata (for commit-reveal registration)
 * This is a temporary NFT that holds the commitment
 */
export function createWaveCommitMetadata(
  commitment: string,
  ownerAddress: string,
  revealAfterHeight: number
): GlyphV2Metadata {
  return {
    v: 2,
    p: [GLYPH_NFT, GLYPH_MUT, GLYPH_WAVE],
    name: `wave_commit_${commitment.slice(0, 8)}`,
    desc: "WAVE name registration commitment",
    type: "wave_commit",
    attrs: {
      commitment,
      revealAfterHeight,
      owner: ownerAddress,
    } as any,
  };
}

/**
 * Check if a name can be reclaimed (expired + grace period passed)
 */
export function canReclaimWaveName(
  expires: number,
  currentHeight: number,
  registrationHeight: number
): { canReclaim: boolean; reclaimableAfter: number } {
  const reclaimableAfter = expires + GRACE_PERIOD;
  const now = Math.floor(Date.now() / 1000);
  const canReclaim = now >= reclaimableAfter;

  return {
    canReclaim,
    reclaimableAfter,
  };
}

/**
 * Create reclaim metadata for burning an expired WAVE name
 */
export function createWaveReclaimMetadata(
  fullName: string,
  originalRef: string
): GlyphV2Metadata {
  return {
    v: 2,
    p: [GLYPH_WAVE], // Only WAVE protocol, no NFT/MUT since we're burning
    name: fullName,
    desc: `Reclaim expired WAVE name: ${fullName}`,
    type: "wave_reclaim",
    attrs: {
      action: "reclaim",
      originalRef,
      reclaimedAt: Math.floor(Date.now() / 1000),
    } as any,
  };
}
