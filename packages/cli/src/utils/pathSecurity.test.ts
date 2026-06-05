/**
 * Isolated unit tests for safeResolvePath (path-traversal guard).
 *
 * Uses Node's built-in test runner + assert so it needs no devDependencies.
 * Run on its own (do NOT run as part of this change set):
 *   pnpm exec tsx --test packages/cli/src/utils/pathSecurity.test.ts
 * or, once compiled:
 *   node --test dist/utils/pathSecurity.test.js
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { safeResolvePath } from "./pathSecurity";

const root = path.resolve("/tmp/bundle-root");

test("rejects parent-directory traversal", () => {
  assert.throws(
    () => safeResolvePath(root, "../../../etc/passwd"),
    /traversal|inside bundle dir/i
  );
});

test("rejects traversal hidden mid-path", () => {
  assert.throws(
    () => safeResolvePath(root, "assets/../../escape"),
    /traversal|inside bundle dir/i
  );
});

test("rejects absolute paths", () => {
  assert.throws(
    () => safeResolvePath(root, "/etc/passwd"),
    /Absolute paths are not allowed/i
  );
});

test("allows a normal nested relative path", () => {
  const resolved = safeResolvePath(root, "cache/hs.abc.webp");
  assert.equal(resolved, path.join(root, "cache", "hs.abc.webp"));
  assert.ok(resolved.startsWith(root + path.sep));
});

test("allows a simple file in the bundle root", () => {
  const resolved = safeResolvePath(root, "image.png");
  assert.equal(resolved, path.join(root, "image.png"));
});
