// This is imported by worker.ts so it's executed early enough
import { Buffer } from "buffer";
// Cast to a shared globals union so the polyfill assignment type-checks
// without per-line @ts-expect-error markers. After the @types/node bump
// (R19), Buffer is already declared on globalThis and the suppressions
// would be flagged as unused.
type WithBuffer = { Buffer: typeof Buffer };
(globalThis as unknown as WithBuffer).Buffer = Buffer;
if (typeof window !== "undefined")
  (window as unknown as WithBuffer).Buffer = Buffer;
if (typeof self !== "undefined")
  (self as unknown as WithBuffer).Buffer = Buffer;
