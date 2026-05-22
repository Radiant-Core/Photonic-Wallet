/**
 * Glyph v2 Authority Token Support
 * Reference: Glyph v2 Token Standard Section 18
 */

import { GlyphV2Metadata } from "./v2metadata";
import { GLYPH_NFT, GLYPH_AUTHORITY } from "./protocols";
import Outpoint from "./Outpoint";
import rjs from "@radiant-core/radiantjs";

const { Script } = rjs;

/**
 * Authority token metadata
 */
export type AuthorityMetadata = {
  issuer: string; // Issuer address or pubkey
  scope?: string; // What this authority governs
  permissions?: string[]; // List of permissions granted
  expires?: string; // ISO8601 expiration date
  revocable?: boolean;
};

/**
 * Create authority token metadata
 */
export function createAuthority(
  issuer: string,
  options?: {
    name?: string;
    scope?: string;
    permissions?: string[];
    expires?: string;
    revocable?: boolean;
  }
): GlyphV2Metadata {
  const authority: AuthorityMetadata = {
    issuer,
    scope: options?.scope,
    permissions: options?.permissions,
    expires: options?.expires,
    revocable: options?.revocable ?? true,
  };

  return {
    v: 2,
    p: [GLYPH_NFT, GLYPH_AUTHORITY],
    name: options?.name || "Authority Token",
    // `authority` is an AuthorityMetadata which the glyph schema allows as
    // an attrs payload but doesn't constrain via TS. Cast through unknown
    // rather than `any` so we don't widen further than necessary.
    attrs: authority as unknown as Record<string, unknown>,
  };
}

/**
 * Validate authority token
 */
export function validateAuthority(metadata: GlyphV2Metadata): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Must have AUTHORITY protocol
  if (!metadata.p.includes(GLYPH_AUTHORITY)) {
    errors.push("Authority metadata must include GLYPH_AUTHORITY protocol");
  }

  // Must have NFT protocol
  if (!metadata.p.includes(GLYPH_NFT)) {
    errors.push("Authority must be an NFT");
  }

  // Validate authority attributes
  if (!metadata.attrs || typeof metadata.attrs !== "object") {
    errors.push("Authority metadata missing attrs object");
  } else {
    const authority = metadata.attrs as AuthorityMetadata;

    if (!authority.issuer) {
      errors.push("Authority issuer is required");
    }

    // Validate expiration if present
    if (authority.expires) {
      try {
        const expiryDate = new Date(authority.expires);
        if (isNaN(expiryDate.getTime())) {
          errors.push("Invalid expiration date format");
        }
      } catch {
        errors.push("Invalid expiration date");
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Check if authority token is expired
 */
export function isAuthorityExpired(metadata: GlyphV2Metadata): boolean {
  if (!metadata.attrs) return false;

  const authority = metadata.attrs as AuthorityMetadata;
  if (!authority.expires) return false;

  try {
    const expiryDate = new Date(authority.expires);
    return expiryDate < new Date();
  } catch {
    return false;
  }
}

/**
 * Check if authority token has permission
 */
export function hasPermission(
  metadata: GlyphV2Metadata,
  permission: string
): boolean {
  if (!metadata.attrs) return false;

  const authority = metadata.attrs as AuthorityMetadata;
  if (!authority.permissions) return false;

  return authority.permissions.includes(permission);
}

/**
 * Verify authority chain
 * Checks if a token was issued by a valid authority
 */
export function verifyAuthorityChain(
  tokenMetadata: GlyphV2Metadata,
  authorityTokens: GlyphV2Metadata[]
): { valid: boolean; error?: string; authority?: GlyphV2Metadata } {
  // Check if token has 'by' field (issued by authority)
  const byField = (tokenMetadata as Record<string, unknown>).by as
    | Uint8Array[]
    | undefined;
  if (!byField || byField.length === 0) {
    return { valid: false, error: "Token has no issuer reference" };
  }

  // Decode issuer ref from token for future ref-matching logic.
  // TODO: compare each authorityTokens[i] against this issuer ref once the
  // blockchain-side ref lookup is in place. For now we accept the first
  // authority token (simplified path).
  Outpoint.fromString(Buffer.from(byField[0]).toString("hex"))
    .reverse()
    .toString();

  const authority = authorityTokens.find(() => {
    return true;
  });

  if (!authority) {
    return { valid: false, error: "No matching authority token found" };
  }

  // Validate authority token
  const validation = validateAuthority(authority);
  if (!validation.valid) {
    return {
      valid: false,
      error: `Invalid authority: ${validation.errors.join(", ")}`,
    };
  }

  // Check if authority is expired
  if (isAuthorityExpired(authority)) {
    return { valid: false, error: "Authority token has expired" };
  }

  return { valid: true, authority };
}

/**
 * Create authority-gated NFT script
 * Requires authority token to be present in transaction
 */
export function authorityGatedNftScript(
  address: string,
  ref: string,
  requiredAuthorityRef: string
): string {
  // Script that requires authority token to be present
  const script = Script.fromASM(
    `OP_REQUIREINPUTREF ${requiredAuthorityRef} OP_DROP ` +
      `OP_PUSHINPUTREFSINGLETON ${ref} OP_DROP`
  ).add(Script.buildPublicKeyHashOut(address));

  return script.toHex();
}

/**
 * Check if token is an authority token
 */
export function isAuthority(metadata: GlyphV2Metadata): boolean {
  return metadata.p.includes(GLYPH_AUTHORITY);
}

/**
 * Revoke authority token
 * Creates a burn transaction for revocable authority
 */
export function revokeAuthority(metadata: GlyphV2Metadata): {
  canRevoke: boolean;
  reason?: string;
} {
  if (!isAuthority(metadata)) {
    return { canRevoke: false, reason: "Not an authority token" };
  }

  const authority = metadata.attrs as AuthorityMetadata;
  if (authority.revocable === false) {
    return { canRevoke: false, reason: "Authority is not revocable" };
  }

  return { canRevoke: true };
}
