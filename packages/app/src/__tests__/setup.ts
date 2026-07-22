/**
 * Vitest Test Setup
 *
 * Global setup for Photonic-Wallet tests.
 */

import { vi } from "vitest";

// Mock @lingui/macro
vi.mock("@lingui/macro", () => ({
  t: (str: string) => str,
}));

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
};
global.localStorage = localStorageMock as unknown as Storage;

// Mock IndexedDB (basic)
global.indexedDB = {
  open: vi.fn(),
  deleteDatabase: vi.fn(),
} as unknown as IDBFactory;

// Mock database for tests
vi.mock("@app/db", () => ({
  default: {
    kvp: {
      get: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    },
    broadcast: {
      orderBy: vi.fn(() => ({
        reverse: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([]),
          limit: vi.fn(() => ({
            toArray: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
      add: vi.fn(),
      put: vi.fn(),
    },
    vault: {
      orderBy: vi.fn(() => ({
        reverse: vi.fn(() => ({
          toArray: vi.fn().mockResolvedValue([]),
        })),
      })),
      where: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(undefined),
        toArray: vi.fn().mockResolvedValue([]),
      })),
      add: vi.fn(),
      put: vi.fn(),
    },
    txo: {
      where: vi.fn(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      })),
    },
  },
}));

// Real WebCrypto, not a mock. jsdom ships no `crypto.subtle`, and the old
// stub here (`digest: vi.fn()` etc.) made anything that actually computes a
// hash or HMAC — like the Xetch bridge's response MAC — fail with
// "importKey is not a function" instead of testing real cryptography.
// Node 20+ implements the same WebCrypto spec browsers do, so tests exercise
// the identical code path production runs. Nothing asserted on the old mock.
import { webcrypto } from "node:crypto";
Object.defineProperty(global, "crypto", { value: webcrypto });

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

console.log("🧪 Photonic-Wallet test environment initialized");
