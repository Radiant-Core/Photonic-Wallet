/**
 * R28 — `process` / `Buffer` globals shim for radiantjs.
 *
 * `@radiant-core/radiantjs@2.x` was authored for Node and reads `process.browser`
 * (and friends) without a guard at three sites:
 *   - `lib/crypto/random.js`     :  `if (process.browser) { … }`
 *   - `lib/crypto/hash.js`       :  `if (process && process.browser) { … }`
 *   - `lib/util/bufferUtil.js`   :  `typeof process !== 'undefined' && process.versions && process.versions.node`
 *
 * The previous fix lived inside an inline `<script type="module">` block in
 * `index.html`. That violated the production CSP (`script-src 'self'`, no
 * inline scripts), and the shim object was exposed at the top of the global
 * scope where any JS introspection could see / mutate it.
 *
 * Replacing it with a typed TS module that's imported first by `main.tsx`
 * means:
 *   - The shim ships in the same bundle as the app — no inline script tag.
 *   - The CSP can stay `script-src 'self'` with no exception.
 *   - The assignment is typed, lint-checked, and impossible to accidentally
 *     bypass when refactoring.
 *
 * We still install `globalThis.process` and `globalThis.Buffer` because
 * radiantjs's references resolve against the actual global object — Vite's
 * `define` substitution can't help here (the `if (process && process.browser)`
 * pattern doesn't textually match `process.browser` alone and breaks if we
 * replace bare `process` literally).
 *
 * If/when radiantjs gains proper browser guards (issue tracked upstream),
 * this module can be deleted in one PR.
 */
import { Buffer } from "buffer";

interface RadiantjsProcessShim {
  browser: boolean;
  env: Record<string, string>;
  version: string;
  // `versions` is the property `bufferUtil.js` checks; leave it unset so the
  // `process.versions && process.versions.node` branch is falsy in the browser.
  versions?: undefined;
}

interface WithShimmedGlobals {
  Buffer?: typeof Buffer;
  process?: RadiantjsProcessShim;
}

const g = globalThis as unknown as WithShimmedGlobals;

if (!g.Buffer) {
  g.Buffer = Buffer;
}

if (!g.process) {
  g.process = {
    browser: true,
    env: {},
    version: "",
  };
}
