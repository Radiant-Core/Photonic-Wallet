/**
 * Password-strength policy tests (red-team finding R4 — FIX 2).
 *
 * `validatePasswordStrength` is a pure function, so these are fully isolated
 * (the @app/keys import only pulls in the globally-mocked db/crypto from
 * setup.ts). They lock in the "block trivially-weak passwords" contract that
 * CreateWallet/RecoverWallet rely on.
 */

import { describe, it, expect } from "vitest";
import { validatePasswordStrength, MIN_PASSWORD_LENGTH } from "@app/keys";

describe("validatePasswordStrength", () => {
  it("rejects an empty password", () => {
    expect(validatePasswordStrength("").ok).toBe(false);
  });

  it("rejects a single character", () => {
    expect(validatePasswordStrength("a").ok).toBe(false);
  });

  it("rejects anything shorter than the minimum length", () => {
    const short = "Ab1" + "x".repeat(MIN_PASSWORD_LENGTH - 4); // length = MIN-1
    expect(short.length).toBe(MIN_PASSWORD_LENGTH - 1);
    expect(validatePasswordStrength(short).ok).toBe(false);
  });

  it("rejects a single repeated character even when long enough", () => {
    expect(validatePasswordStrength("a".repeat(MIN_PASSWORD_LENGTH)).ok).toBe(
      false
    );
    expect(validatePasswordStrength("1".repeat(16)).ok).toBe(false);
  });

  it("rejects common passwords case-insensitively", () => {
    for (const weak of ["password", "PassWord", "12345678", "qwerty123"]) {
      expect(validatePasswordStrength(weak).ok).toBe(false);
    }
  });

  it("rejects a long single-character-class password", () => {
    // 12 lowercase letters, not a repeat, not common — still only one class.
    const result = validatePasswordStrength("abcdefghijkl");
    expect(result.ok).toBe(false);
  });

  it("accepts a password meeting the policy (length + >=2 char classes)", () => {
    const ok = validatePasswordStrength("Tr0ubadour-x");
    expect(ok.ok).toBe(true);
  });

  it("returns a user-facing reason string when rejecting", () => {
    const result = validatePasswordStrength("short");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
