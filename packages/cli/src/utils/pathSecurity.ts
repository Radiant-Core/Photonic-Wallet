/**
 * Path security utilities for CLI bundle commands
 *
 * Prevents path traversal attacks by validating that resolved paths
 * stay within the intended bundle directory.
 */

import path from "path";

/**
 * Validates that a resolved path stays within the root directory.
 * @param rootDir The root/bundle directory that must contain the path
 * @param relativePath The user-provided relative path to validate
 * @returns The absolute path if valid
 * @throws Error if the path attempts directory traversal outside root
 */
export function safeResolvePath(rootDir: string, relativePath: string): string {
  // Reject absolute paths
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Absolute paths are not allowed: ${relativePath}`);
  }

  // Reject paths containing .. components
  const normalizedRelative = path.normalize(relativePath);
  if (
    normalizedRelative.startsWith("..") ||
    normalizedRelative.includes("../")
  ) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }

  // Resolve the absolute path
  const absPath = path.resolve(rootDir, relativePath);
  const root = path.resolve(rootDir) + path.sep;

  // Ensure the resolved path is within the root directory
  if (!absPath.startsWith(root)) {
    throw new Error(`Path must stay inside bundle dir: ${relativePath}`);
  }

  return absPath;
}

/**
 * Validates a bundle embed path and returns the safe resolved path.
 * @param bundleDir The bundle directory
 * @param embedPath The embed.path value from bundle.json
 * @returns Safe absolute path
 */
export function resolveEmbedPath(bundleDir: string, embedPath: string): string {
  return safeResolvePath(bundleDir, embedPath);
}
