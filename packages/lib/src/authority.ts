/**
 * Glyph v2 Authority Token Support
 * Reference: Glyph v2 Token Standard Section 18
 */

import { GlyphV2Metadata } from "./v2metadata";
import { GLYPH_NFT, GLYPH_AUTHORITY } from "./protocols";
import { reverseRef } from "./Outpoint";
import rjs from "@radiant-core/radiantjs";

const { Script } = rjs;

/**
 * An authority token candidate: its on-chain singleton ref (36-byte hex, either
 * byte orientation accepted) plus its decoded metadata.
 */
export type AuthorityCandidate = {
  ref: string;
  metadata: GlyphV2Metadata;
};

/** Both byte orientations of a 36-byte ref, lowercased, for robust matching. */
function refOrientations(refHex: string): string[] {
  const h = (refHex || "").toLowerCase();
  if (!/^[0-9a-f]{72}$/.test(h)) return [h];
  try {
    return [h, reverseRef(h).toLowerCase()];
  } catch {
    return [h];
  }
}

function byEntryToHex(b: Uint8Array | string): string {
  return (typeof b === "string" ? b : Buffer.from(b).toString("hex")).toLowerCase();
}

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
 * Verify authority chain.
 *
 * Checks that a token was *actually* issued by one of the supplied authority
 * tokens by matching the token's claimed issuer ref(s) (its `by` field) against
 * each candidate authority's on-chain ref.
 *
 * Audit fix: the previous implementation did `authorityTokens.find(() => true)`
 * with an explicit TODO — i.e. ANY token presenting ANY authority-looking token
 * passed, so a forged/unrelated authority was accepted. This now requires a real
 * ref equality between the token's `by` reference and the authority's ref, so a
 * token claiming an authority it was not issued by is rejected.
 *
 * Refs are compared in both byte orientations (LE script form and BE display
 * form) so callers don't have to normalise ahead of time — this codebase passes
 * refs in both conventions depending on the source.
 */
export function verifyAuthorityChain(
  tokenMetadata: GlyphV2Metadata,
  authorityTokens: AuthorityCandidate[]
): { valid: boolean; error?: string; authority?: AuthorityCandidate } {
  // Check if token has 'by' field (issued by authority)
  const byField = (tokenMetadata as Record<string, unknown>).by as
    | Array<Uint8Array | string>
    | undefined;
  if (!byField || byField.length === 0) {
    return { valid: false, error: "Token has no issuer reference" };
  }

  // Canonical set of every claimed issuer ref (both byte orientations).
  const claimed = new Set<string>();
  for (const b of byField) {
    for (const form of refOrientations(byEntryToHex(b))) claimed.add(form);
  }

  // The audited fix: require a real ref match, not the first available token.
  const match = authorityTokens.find((a) =>
    refOrientations(a.ref).some((form) => claimed.has(form))
  );
  if (!match) {
    return {
      valid: false,
      error:
        "No authority token matches the token's claimed issuer reference (by)",
    };
  }

  // Validate the matched authority token's metadata.
  const validation = validateAuthority(match.metadata);
  if (!validation.valid) {
    return {
      valid: false,
      error: `Invalid authority: ${validation.errors.join(", ")}`,
    };
  }

  // Check if authority is expired
  if (isAuthorityExpired(match.metadata)) {
    return { valid: false, error: "Authority token has expired" };
  }

  return { valid: true, authority: match };
}

/**
 * Create an authority-gated NFT script.
 *
 * `OP_REQUIREINPUTREF <authorityRef>` is a **creation-time (mint-time)** rule:
 * Radiant-Core's validateTransactionReferenceOperations requires every
 * require-ref found in a tx's OUTPUT scripts to be present among that tx's input
 * refs. Therefore an output using this script can only be *created* by a tx that
 * holds the authority token (ref `requiredAuthorityRef`) as an input — a
 * counterfeiter without the issuer's authority token cannot mint a gated item.
 * Proven on regtest in authority.regtest.test.ts (mint without/with-forged
 * authority is REJECTED; mint with the genuine authority is ACCEPTED).
 *
 * `OP_PUSHINPUTREFSINGLETON <ref>` carries the item's own singleton forward, and
 * the trailing P2PKH authorises the owner's spends.
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
