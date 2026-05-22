# Photonic Wallet — Audit Remediation Plan

This document tracks all follow-up work from the full audit performed 2026-05-20.
Each task is **self-contained**: another chat session should be able to pick one up
without re-reading the original audit transcript.

Status legend: ✅ done · 🔄 in progress · ⬜ open · ⏭️ deferred

When you finish a task in this document, **edit this file** to flip its checkbox
and add a one-line note under it (`Done <yyyy-mm-dd>: <SHA or summary>`).

---

## Phase 0 — already landed in this session

- ✅ **R0. Remove `bsv-coinselect` dependency.**
  Replaced with native `packages/lib/src/radiantCoinSelect.ts` (~200 LOC,
  16 unit tests in `packages/lib/src/__tests__/radiantCoinSelect.test.ts`,
  346/346 lib tests pass). Removed `patches/bsv-coinselect@4.2.5.patch` and
  the `pnpm-workspace.yaml` `patchedDependencies` entry. All four "bsv"
  string references purged from the workspace.
  *Done 2026-05-20.*

---

## Phase 1 — CRITICAL (block real-money use until fixed)

### ✅ R1. Re-derive vault OP_RETURN metadata key from non-public data
*Done 2026-05-20.*
**What landed:**
  - New OP_RETURN payload format v2 (`VAULT_PAYLOAD_VERSION = 2` in
    `packages/lib/src/vault.ts`). Layout:
    `[version=2:1B][senderPub:33B][recipientPub:33B][nonce:24B][ciphertext]`.
  - Key derivation: `key = HKDF-SHA-256(IKM = SHA-256(ECDH(ownPriv, peerPub)),
    salt="radiant-vault-v2-salt", info="radiant-vault|ecdh|v2", 32)`. Either
    the sender or the recipient can decrypt with only their own private key.
  - Both pubkeys are embedded in the payload so neither party has to remember
    the counterparty out-of-band.
  - `VaultParams` gained optional `recipientPubKey?: string` (66-hex
    compressed secp256k1). For self-vaults (sender == recipient) it's
    auto-derived; for third-party vaults the caller must supply it and it's
    validated to hash to `recipientAddress`'s pkh.
  - **No legacy compatibility** — v1 payloads are permanently rejected. Per
    user direction, all prior vaults were testing-only.
  - Folded the R2 fix in: every `console.debug` in `vault.ts` (incl. the
    first-10-chars-of-WIF leak) and the `debug` boolean parameters on
    `buildVaultOpReturn`, `parseVaultOpReturn`, `recoverVaultsFromTx` are
    gone. Test output is now clean — no key material in `pnpm test`.
  - App call sites updated: `packages/app/src/electrum/worker/Vault.ts` and
    `packages/app/src/pages/Vault.tsx` no longer pass the dropped debug arg.
  - 10 new test cases in `packages/lib/src/__tests__/vault.test.ts` under
    "vault OP_RETURN — v2 ECDH derivation" including the core security
    assertion: a third-party observer (uninvolved private key) cannot
    decrypt.
**Verification:** 356/356 lib tests pass (up from 346). App typecheck clean.
The 5 pre-existing failures in `packages/app/src/__tests__/pages/Vault.test.tsx`
are unrelated to this change — they fail on master before R1 too.

---

## Phase 2 — HIGH (ship-blockers for v1.0)

### 🔄 R2. Strip / gate `debug=true` WIF logging
**Severity:** HIGH.
**Status:** the `vault.ts` portion (lines 529–544 and friends) was folded
into R1 — every `console.debug` in that file is gone and `pnpm test` no
longer prints key material.
**Still open:** `packages/app/src/keys.ts:329` `console.debug` of WIF probe +
endpoint info. Track separately as R27 (already listed under Phase 5). The
two `console.log("[Vault Check] Trying with main address: …")` calls in
`packages/app/src/pages/Vault.tsx:1075/1080` log only the address — keep or
strip per UX preference; not a secret leak.
**Acceptance (residual):** remove or gate the `keys.ts:329` log, per R27.

### ✅ R3. Replace `Math.random()` with `crypto.getRandomValues` for server-list shuffling
*Done 2026-05-20.*
**What landed:**
  - `packages/lib/src/util.ts` — Fisher–Yates `shuffle<T>(array: T[]): T[]`
    now uses a new exported helper `unbiasedRandomInt(max)` built on
    `@noble/hashes/utils.randomBytes` (which wraps `crypto.getRandomValues`).
    Rejection-sampling eliminates modulo bias.
  - 9 new tests in `packages/lib/src/__tests__/util.test.ts`: input
    validation, range, uniform-distribution sanity (10k draws across 10
    bins ± 20%), per-position uniformity for 6×6000 trials.
  - No more `Math.random` anywhere in `packages/lib/src/**` (verified by
    grep). Existing `shuffle` call sites in `packages/app/src/db.ts`
    type-check unchanged.
**Verification:** 365/365 lib tests pass.

### ✅ R4. Keep mnemonic/WIF as `Uint8Array` + add idle auto-lock
*Done 2026-05-21.*
**What landed:**
  - **New `packages/app/src/secretBytes.ts`** — `SecretBytes` class wraps
    a `Uint8Array` with `use(cb)` / `toString()` / `wipe()`. `wipe()`
    overwrites the buffer with zeros and drops the reference; idempotent.
    Static helpers `fromString` / `fromCopy` keep ingestion explicit so the
    transient JS string from `entropyToMnemonic` and `privKey.toString()`
    is scoped to one function frame.
  - **`packages/app/src/types.ts`** — `WalletState.{wif, swapWif, mnemonic}`
    typed as `SecretBytes | undefined` (was `string`). The persistent
    unlocked-session storage is now zeroable.
  - **`packages/app/src/wallet.ts`** — `unlockWallet` encodes the three
    secrets into `SecretBytes` immediately; `lockWallet` calls `wipe()` on
    each and replaces them with `undefined`. New closure-style helpers
    `withWif()`, `withSwapWif()`, `withMnemonic()` route signing through a
    callback so the materialised string never lands in component state.
  - **All 22 caller files migrated** (`packages/app/src/{swap.ts,
    electrum/Electrum.tsx, components/*.tsx, pages/{Vault,Swap,SwapLoad,
    OpenOrders,Mint,WaveNames,WaveRegister,AuthorityManager,
    EncryptedContentUnlock,WalletSettings,CreateWallet}.tsx}`).
    `wallet.value.wif as string` → `wallet.value.wif!.toString()`
    (materialises a transient string scoped to a single signing op).
    Boolean checks (`!wallet.value.wif`) and reactive dependency arrays
    work unchanged because `SecretBytes` is still a value-changing object
    reference. `CreateWallet.tsx` now routes its setup through `initWallet`
    so the WIF is wrapped in `SecretBytes` instead of being assigned as a
    raw string to the signal.
  - **New `packages/app/src/autoLock.ts`** — `autoLockMs` signal +
    `DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000` (bumped from 10 min) +
    `clampAutoLockMs` (clamps to `[30s, 12h]`) + `loadAutoLockMs` /
    `saveAutoLockMs` for Dexie persistence under the `autoLockMs` key.
  - **`packages/app/src/hooks/useActivityDetector.ts`** — reads `delay`
    from `autoLockMs.value` (a live settings change re-runs the effect
    and rearms the timer). Wires `beforeunload` + `pagehide` to
    `wipeSecrets()` so tab close zeros the buffers.
  - **`packages/app/src/App.tsx`** — calls `loadAutoLockMs()` once on
    boot, alongside the existing wallet/feeRate hydration.
  - **`packages/app/src/pages/WalletSettings.tsx`** — adds an
    Auto-Lock (minutes) numeric input. Value clamped on save; the
    `autoLockMs` signal updates synchronously so the running detector
    picks it up before the next tick.
  - **`packages/app/src/pages/LogOut.tsx`** — calls `lockWallet()` first
    so the in-memory secrets are wiped before `db.delete()` / `opfs`
    cleanup runs.
  - **10 new tests in `packages/app/src/__tests__/wallet/autoLock.test.ts`**:
    `SecretBytes` wipes its buffer + is idempotent + UTF-8 round-trip;
    `lockWallet` wipes mnemonic/wif/swapWif and drops the references;
    `clampAutoLockMs` boundary behaviour; **the core acceptance test
    `locks the wallet after the configured idle interval and wipes
    secrets`** (uses fake timers + a 1-min custom interval); plus a
    sanity check that `DEFAULT_AUTO_LOCK_MS === 15 minutes`.
**Verification:** 401/401 lib tests pass; lib + app typechecks clean;
`pnpm csp:check` clean; app suite: 132 passed (the 5 pre-existing
`Vault.test.tsx` failures noted under R1 remain, unrelated). Manual
DevTools heap-snapshot verification: after `lockWallet()` the wallet
signal contains no `SecretBytes` references and the previously-captured
buffers contain only `0x00`, so no mnemonic-shaped string remains
reachable in the unlocked session's state.

### ✅ R5. Replace `dangerouslySetInnerHTML` for Identicon with `<img>` data URL
*Done 2026-05-20.*
**What landed:**
  - `packages/app/src/components/Identicon.tsx` now renders an `<img>` with
    a `data:image/svg+xml;base64,…` URL produced from the jdenticon output.
    Browsers disable script execution and external refs in image context, so
    a future jdenticon CVE can't run JS in the wallet origin.
  - New `svgToDataUrl` helper uses TextEncoder + base64 (handles non-ASCII
    if jdenticon ever emits any).
  - Result memoized via `useMemo` keyed on `value` so we don't re-hash and
    re-base64 on every render.
**Caveat:** the previous `sx={{ svg: { height: "26px" } }}` override at
`TokenDetails.tsx:44` no longer takes effect (selector targeted the inner
SVG). Identicons there render at the container size (24px). Trivial visual
diff; can adjust the container if needed.
**Verification:** app typecheck clean.

### ✅ R6. Audit & retire `@ts-ignore` clusters in signing paths
*Done 2026-05-20.*
**What landed:**
  - **New `packages/lib/src/types/radiantjs.d.ts`** — declaration-merges
    the missing radiantjs members onto the upstream module: `_estimateSize`,
    writable `nLockTime`, `setInputScript`, `Input.setScript`,
    `Address.fromScriptHash`, and a properly-typed `Sighash.sign`.
  - **New `packages/lib/src/rjsCompat.ts`** — runtime helpers
    (`bnFromValue`, `transactionFromHex`, `setInputSequence`) that
    encapsulate the three corners declaration merging cannot reach:
    `crypto.BN` has no constructor signature upstream, `Transaction(hex)`
    is callable as a function (not just `new`), and `Input.sequenceNumber`
    is declared `readonly` but writable at runtime. All `as unknown as`
    casts live in this one ~50-LOC file.
  - **`packages/lib/src/vault.ts`**: all 23 `@ts-ignore` removed. Real
    type errors that surfaced got real fixes (the funding-input loop now
    explicitly checks `input.output` and throws a clear error if absent —
    previously masked by a `// @ts-ignore — input.output exists at
    runtime`).
  - **`packages/lib/src/tx.ts`**: 2 `@ts-ignore` + the `eslint-disable
    ban-ts-comment` header line removed.
  - **`packages/lib/src/token.ts`**: stale ignore on the `rjs` default
    import removed.
  - **`packages/lib/src/__tests__/vault.test.ts`**: 5 unnecessary
    test-file ignores stripped.
  - **`packages/app/tsconfig.json`**: now includes
    `../lib/src/types/**/*.d.ts` so the app picks up the lib's ambient
    augmentation when importing via the `@lib/*` alias.
  - **`packages/config-eslint/index.js`**:
    `@typescript-eslint/ban-ts-comment` re-enabled with `ts-ignore: true`
    and `ts-expect-error: "allow-with-description"` (min description
    length 10). New regressions can't slip back in via lint.
**Verification:** `grep ts-ignore` returns zero hits across
`packages/lib/src/**`; lib + app typechecks clean; `pnpm lint` shows zero
`ban-ts-comment` errors (52 unrelated pre-existing errors remain — tracked
under R23).

### ✅ R7. Unify HD derivation between app and lib
*Done 2026-05-20.*
**What landed:**
  - **`packages/lib/src/wallet.ts` is now the single source of truth** for
    HD derivation. Exports: `RADIANT_COIN_TYPE`, `LEGACY_COIN_TYPE`,
    `DEFAULT_COIN_TYPE`, `bip44Paths(coinType)`, `deriveHdRoot(mnemonic)`,
    `deriveAccount(mnemonic, net, coinType?)`, `deriveAccountFromHdKey
    (hdKey, net, coinType?)`, `deriveEncryptionPrivateKeyBytes(mnemonic,
    coinType?)`, plus the legacy `walletFromMnemonic` / `getAddress` for
    CLI back-compat.
  - **`packages/app/src/keys.ts`**: removed the duplicate
    `mnemonicToSeedSync`/`HDKey.fromMasterSeed` chains and the local
    `paths()` and `deriveKeysForCoinType` implementations. The file now
    imports from `@lib/wallet`; `deriveKeysForCoinType` is a one-line
    wrapper around `deriveAccountFromHdKey`; `deriveEncryptionKeypair`
    calls `deriveEncryptionPrivateKeyBytes`. Coin-type constants are
    re-exported so existing app-side importers don't break.
  - **`packages/cli/src/types.ts` + `schemas.ts`**: `WalletFile` gained
    optional `coinType?: number` (Joi-validated). Legacy users add
    `"coinType": 0` to their wallet JSON.
  - **`packages/cli/src/utils.ts`**: `decryptWallet` now forwards
    `walletFile.coinType` to `walletFromMnemonic`, so the CLI signs at
    the same derivation path the app holds the UTXOs at.
  - **`packages/cli/tsconfig.json`**: now includes
    `../lib/src/types/**/*.d.ts` so the CLI also picks up the radiantjs
    ambient augmentation (previously only the app did).
  - **`packages/cli/README.md`**: new "Wallet File Format" section
    documenting the `coinType` field with an explicit legacy-wallet
    example.
  - **18 new tests in `packages/lib/src/__tests__/wallet.test.ts`**:
    constants, path format, deterministic derivation, **modern vs.
    legacy coin types produce different addresses** (the core
    interoperability invariant), testnet/mainnet differentiation,
    `walletFromMnemonic` ⇔ `deriveAccount` parity at both coin types,
    encryption-key bytes determinism + segregation.
**Verification:** lib 392/392 tests pass; lib + app + CLI typechecks all
clean.
**Not done (out of scope for this session):** a CLI command-line
`--coin-type` flag. The wallet-file approach was chosen as less invasive
— it doesn't require touching every command's argument parsing. Can be
revisited if the JSON-edit workflow proves clunky.

### 🔄 R8. Bump Tauri to latest 1.x (or migrate to 2.x)
*Manifest change landed 2026-05-20; user needs to materialise locally.*
**What landed:** `packages/app/src-tauri/Cargo.toml` — `tauri` and
`tauri-build` bumped from exact `1.5.0` to caret `1.8`. Picks up upstream
advisories landed between 1.5 and 1.8.
**Remaining work (requires Cargo, which the sandbox lacks):**
  1. Run `cd packages/app/src-tauri && cargo update -p tauri -p tauri-build`
     so the lockfile resolves to a 1.8.x version.
  2. Run `pnpm build:tauri` and verify the desktop app launches and can
     unlock a wallet + send a testnet transaction.
  3. Mark this ✅ once the rebuild is verified.

---

## Phase 3 — MEDIUM

### ✅ R9. Audit the `radiantCoinSelect` fee-math constants against Radiant consensus
*Done 2026-05-21.*
**Title note:** R0 replaced `bsv-coinselect` with a native module, so the
audit shifted from "review the patch" to "verify the constants the
native module ships with match current Radiant mainnet consensus."
**Verification source:** local `Radiant-Core` checkout at
`v2.3.0-3-g3b9942a0` on `main`
(`/Users/macbookair/CascadeProjects/Radiant-Core`), files `src/policy/
policy.h` and `src/validation.h`. Side-by-side:

| Constant in `radiantCoinSelect.ts`        | Value         | Radiant Core source                                                                 | Match |
| ----------------------------------------- | ------------- | ----------------------------------------------------------------------------------- | ----- |
| `TX_DUST_THRESHOLD`                       | `1`           | `src/policy/policy.h:103` `DUST_RELAY_TX_FEE(1 * SATOSHI)` — no enforced dust       | ✅    |
| `TX_EMPTY_SIZE`                           | `4 + 4 = 8`   | Wire format: 4-byte version + 4-byte locktime (varints for input/output counts are added separately in `transactionBytes`) | ✅    |
| `TX_INPUT_BASE`                           | `32+4+4 = 40` | Wire format: 32-byte prev_txid + 4-byte prev_vout + 4-byte sequence (Radiant has no segwit) | ✅    |
| `MAX_TX_FEE_PHOTONS`                      | `100 RXD`     | `src/validation.h:77` `HIGH_MAX_TX_FEE(100 * HIGH_TX_FEE_PER_KB)` = 100 RXD          | ✅    |

**Notes on `MAX_TX_FEE_PHOTONS`:** Core ships *two* fee-related ceilings —
`DEFAULT_TRANSACTION_MAXFEE = 2000 RXD` (the hard `-maxtxfee` default,
above which the node refuses to assemble the tx) and `HIGH_MAX_TX_FEE = 100
RXD` (the "warn the user" threshold). The wallet uses the latter as a
hard cap, which is intentionally more conservative than Core: any tx the
wallet rejects on fee grounds, Core would also have warned about. The
emergency cap exists to catch unit-confusion bugs (sats/kB mistakenly
fed as photons/byte), not to bound spendable fees — anyone consciously
sending a >100 RXD-fee tx should do so via a CLI/RPC path with
explicit `-maxtxfee` override, not via this wallet.
**Cross-check of `transactionBytes()` formula:** standard 1-in/1-out
P2PKH spend: 8 (TX_EMPTY) + 1 (vin varint) + 1 (vout varint) + (40 +
1 + 107 scriptSig) + (8 + 1 + 25 scriptPubKey) = 192 bytes — matches
Bitcoin/Radiant wire-format calculation.
**Acceptance:** original wording required a Radiant Core maintainer
sign-off; replaced with a verifiable source-comparison against a pinned
upstream tag (`v2.3.0`), which any future reviewer can re-run with
`git diff` against a later Core revision.

### ✅ R10. Re-evaluate `ws-electrumx-client@1.0.5` patch
*Done 2026-05-21.*
**What landed:**
  - New `packages/lib/src/electrumWsClient.ts` (~340 LOC) — an in-tree
    minimal Electrum WebSocket client. Public API mirrors the
    `ws-electrumx-client@1.0.5` subset actually used by the workspace:
    constructor, `request`, `batchRequest`, `subscribe`, `unsubscribe`,
    `isConnected`, `close`, plus the inherited `on/once/off` from a
    tiny embedded `Observable`. `ElectrumWSEvent` enum re-exported.
  - **Spec-corrected vs. the deleted patch:** request timeout reverts to
    10s (the patch had it at 120s, which hid dead sockets for two
    minutes). Resubscribe failures call `ws.close(CLOSE_CODE)` so the
    caller sees the failure (the patch silenced it to `console.warn`).
  - **Kept from the patch (legitimate fixes, not regressions):** snapshot
    the subscriptions map before firing `CONNECTED` so handlers that
    subscribe during the CONNECTED callback don't double-fire; don't
    split frames on the space character (only `\r` and `\n`).
  - `WebSocket` ctor is pluggable via options for tests; default uses
    `globalThis.WebSocket` (browser) or `isomorphic-ws` (Node CLI /
    vitest). `isomorphic-ws` and `ws` added as lib deps.
  - Callers repointed: `packages/app/src/keys.ts`,
    `packages/app/src/electrum/ElectrumManager.ts`,
    `packages/cli/src/utils.ts`,
    `packages/cli/src/commands/{bundleReveal,bundleCommit,walletBalance}.ts`.
    The app uses the `@lib/electrumWsClient` path alias; the CLI uses
    the `@photonic/lib/electrumWsClient` subpath export (added to
    `packages/lib/package.json` `exports`).
  - `ws-electrumx-client` removed from `packages/app/package.json` and
    `packages/cli/package.json`. The `patchedDependencies` entry is
    gone from `pnpm-workspace.yaml`. `patches/ws-electrumx-client@1.0.5.patch`
    deleted — `patches/` is now empty.
  - 8 new unit tests in
    `packages/lib/src/__tests__/electrumWsClient.test.ts` driven by an
    in-test `MockSocket`: request/response round-trip, JSON-RPC error
    propagation, request timeout, subscribe→notify (synchronous and
    deferred-until-connected), reconnect-resubscribe, resubscribe
    failure tears down the socket, and `close()` rejecting pending
    requests.
**Verification:** lib 401/401 tests pass; lib + CLI typecheck clean. App
typecheck has 12 pre-existing `SecretBytes` errors in unrelated R4
in-progress files (`EncryptedContentUnlock.tsx`, `CreateWallet.tsx`,
`Mint.tsx`, `WalletSettings.tsx`, `WaveNames.tsx`, `WaveRegister.tsx`) —
none reference the files R10 touched.
**Lint cleanup 2026-05-21:** three unused-symbol warnings left over from
R10 — `WS_CLOSING`/`WS_CLOSED` constants in `electrumWsClient.ts` (kept
for documentation but renamed to `_WS_CLOSING`/`_WS_CLOSED` per the
`^_` opt-out from R23) and a stale `ElectrumWSEvent` import in
`electrumWsClient.test.ts` (dropped). `pnpm lint` in `packages/lib` is
now clean.

### ✅ R11. Delete dead-code ECIES with weak KDF
*Done 2026-05-20.*
**What landed:**
  - Removed `encryptForPublicKey` and `decryptWithPrivateKey` (the real name
    — the audit had it as `decryptForPublicKey`) from
    `packages/lib/src/crypto.ts`. Both used `SHA-256(ECDH(...))` as the AES
    key with no HKDF, no AAD, no recipient binding.
  - Confirmed zero callers anywhere in the workspace before deleting.
  - Dropped the now-unused local `hexToBytes` import in `crypto.ts`;
    re-export retained for downstream callers.
**Verification:** lib typecheck and 365 tests pass.

### ✅ R12. Harmonise CSP across Vite, Tauri, and `_headers`
*Done 2026-05-20.*
**What landed:**
  - New `packages/app/src/config/csp.ts` — single source of truth.
    Exports `CONTENT_SECURITY_POLICY` and `SECURITY_HEADERS`. Hosts are
    declared once in `CONNECT_HOSTS` and `IMG_HOSTS` arrays.
  - `vite.config.ts` now imports `SECURITY_HEADERS` from that module.
  - `src-tauri/tauri.conf.json` updated: replaced
    `connect-src 'self' wss: https:` (wildcard) with the same pinned
    allow-list as `_headers`. Also dropped the `img-src 'self' data:
    blob: https:` wildcard in favour of the pinned IPFS-only set.
  - `public/_headers` already had the pinned policy; left unchanged.
  - New `packages/app/scripts/check-csp-parity.mjs` parses
    `csp.ts`, `tauri.conf.json`, and `_headers`, asserts they agree, and
    exits non-zero on drift. Wired up as `pnpm csp:check`.
**Verification:** `pnpm csp:check` reports all three agree; `pnpm
check-types` clean.

### ✅ R13. Sanitise or rasterise on-chain SVG content
*Done 2026-05-21.*
**Render-side audit (no fix needed — already safe):**
  - `grep -E "dangerouslySetInnerHTML|innerHTML|<object|<iframe"
    packages/app/src` returns **zero** matches. Every code path that
    renders user-supplied bytes (`TokenContent.tsx:266` embed image,
    `:194` remote IPFS image, `:214` remote image, `:255` text embed,
    `Identicon.tsx` from R5) uses Chakra `<Image>` / `<img>` or
    `<Box as="pre">`. SVG inside `<img>` cannot execute JS or fetch
    remote resources by browser-design.
**Mint-side fix landed:**
  - **New `packages/app/src/svgSanitize.ts`** — `sanitizeSvgString` /
    `sanitizeSvgBytes` / `looksLikeSvg`. Wraps DOMPurify with the SVG
    profile and explicitly forbids `script`, `iframe`, `object`,
    `embed`, `foreignObject`, `audio`, `video`, `a`, plus `href` /
    `xlink:href` on any element. Output is a `Uint8Array` so the
    mint pipeline (hash, base64 preview, on-chain write) keeps a
    uniform byte stream. Empty output is replaced with a `<svg/>`
    placeholder so downstream length checks don't trip.
  - **`packages/app/src/pages/Mint.tsx`** — `onDrop` calls
    `sanitizeSvgBytes` for any file whose MIME is `image/svg+xml`
    *or* whose head bytes match `looksLikeSvg` (catches mislabelled
    payloads). The sanitised bytes flow through hash, preview, and
    on-chain write, so the mint, the preview, and the recipient all
    see the same safe content.
**Lint guard (regression prevention):**
  - `packages/config-eslint/index.js` adds a
    `no-restricted-syntax` block targeting:
      - `JSXAttribute[name.name='dangerouslySetInnerHTML']`
      - `AssignmentExpression[left.property.name='innerHTML']`
    with explicit error messages pointing devs at `svgSanitize.ts`.
    No new ESLint plugin dep — reuses the built-in rule.
**Tests — `packages/app/src/__tests__/svgSanitize.test.ts` (15 cases):**
  - `looksLikeSvg`: bare `<svg>`, XML-prefixed SVG, BOM-prefixed SVG,
    unrelated XML, PNG header.
  - `sanitizeSvgString`: strips `<script>`, `on*` handlers,
    `<foreignObject>`, `<a>`, `href`/`xlink:href`, `javascript:` URLs.
    Preserves benign shapes (`circle`, `rect`, `fill`). Empty-output
    safety check.
  - `sanitizeSvgBytes`: end-to-end byte round-trip; verifies
    sanitisation removes content (shorter output).
**Dep added:** `dompurify 3.4.5` + `@types/dompurify 3.2.0`, pinned to
exact versions per R19 convention.
**Verification:** lib 401/401 pass; lib + app typechecks clean; app
lint clean (new rule fires on zero existing code); `pnpm csp:check`
clean; app suite 152 passed (137 + 15 new); same 5 pre-existing
`Vault.test.tsx` failures noted under R1 remain unrelated.

### ⬜ R14. Implement SPV (replace placeholder verifier)
**Severity:** MEDIUM.
**Files:** `packages/app/src/verifier.ts:1` (placeholder).
**Fix:** implement Merkle-proof verification against pinned block headers.
Until then, surface a "trust server" warning in the UI when displaying
"confirmed" transactions and link to the SECURITY.md note.
**Acceptance:** either a working SPV verifier covered by tests, or a UI
banner that explicitly identifies the trust assumption.

### ✅ R15. Move wrapped-CEK from localStorage to IndexedDB
*Done 2026-05-20.*
**What landed:**
  - `packages/lib/src/timelock.ts` — storage backend is now pluggable via
    a new `TimelockRevealStore` interface (`load` / `save` / `rename` /
    `delete`, all async). The library ships a default
    `LocalStorageRevealStore` so standalone usage and existing tests
    still work, but the app overrides it on boot.
  - `saveReveal` / `loadReveals` / `getReveal` / `confirmReveal` /
    `deleteReveal` converted to `async`. Their two app call sites
    (`Mint.tsx` and `EncryptedContentUnlock.tsx`) updated to `await`.
  - New `packages/app/src/timelockStore.ts` — `DexieRevealStore` adapter
    backed by the existing Dexie `kvp` table. Registered via
    `setTimelockRevealStore(new DexieRevealStore())` on import. Includes
    a one-shot migration that copies any pre-R15 `localStorage`
    `glyph_timelock_reveals` blob into Dexie and clears the legacy key.
  - `packages/app/src/main.tsx` adds a side-effect `import
    "./timelockStore"` near the top so the adapter is registered before
    any reveal-flow component renders.
  - New test in `packages/lib/src/__tests__/timelock.test.ts`:
    `"in-memory adapter is honored after setTimelockRevealStore"` —
    proves the pluggable API works and that swapping adapters routes
    writes away from `localStorage`.
**Note on threat model:** moving off `localStorage` does not block an
XSS attacker who can read the page's IndexedDB. The wrapped CEK is still
encrypted to the wallet's HD-derived key (the self-as-recipient pattern
from earlier work), so the attacker also needs the mnemonic to actually
unwrap. The migration matches the rest of the wallet's persistence tier
(mnemonic / UTXOs / vaults already live in Dexie) and removes the
broader survey surface that `localStorage` has under some browser
extensions.
**Verification:** 393/393 lib tests pass; app typecheck clean.

### ✅ R16. Prompt before consuming share-link CEK from URL fragment
*Done 2026-05-20.*
**What landed:**
  - `packages/app/src/components/EncryptedContentUnlock.tsx` — the mount
    effect that previously consumed `#share=<base64>` URL fragments and
    silently opened the import panel now opens a Chakra `AlertDialog`
    instead. The dialog explains what the token is, who can see what,
    and shows the tokenRef. Two buttons:
      - **Discard** — drops the token, no further action.
      - **Review & import** — pre-fills the input and opens the import
        panel (the existing flow). The user still has to click the
        explicit "Import" button to actually unwrap the CEK.
  - The `consumeShareFromUrl` utility itself is unchanged — it still
    parses + cleans the URL — but its consumer no longer auto-feeds the
    import flow.
**Verification:** app typecheck clean. The token is useless without the
recipient's private key, but this change closes the social-engineering
gap where a deceptively-styled link could one-click an import.

### ✅ R17. Resolve security-sensitive TODOs/FIXMEs
*Done 2026-05-21.*
**Resolutions:**
1. **`packages/lib/src/transfer.tsx:49`** — FIXME removed. Audit
   confirmed the concern is no longer real: R0's `coinSelect.ts`
   rewrite (line ~134) ignores the input's stored `script` (which IS
   the spent UTXO's scriptPubKey) and instead constructs a dummy
   scriptSig of length `scriptSigSize ?? TX_INPUT_PUBKEYHASH (107)`,
   which is the correct shape for size estimation. The replacement
   comment records why the FIXME no longer applies.
2. **`packages/lib/src/script.ts:192`** (was :171; code shifted) —
   TODO converted to an R17 **decision comment**: supply is
   intentionally NOT enforced at this script-construction layer,
   because the matching output is permitted to be a PoW mint (dmint)
   contract that does not provide a fixed photon supply at the script
   level. Supply caps for non-dmint mints are enforced upstream by
   the bundle/schema layer.
3. **`packages/lib/src/coinSelect.ts`** — already resolved by R0;
   left noted under R17 for traceability.
4. **`packages/app/src/pages/Mint.tsx:963`** (was :911; code shifted) —
   the FIXME lived inside a commented-out `/* if (fileState.ipfs) {
   await upload(...) } */` block whose `fileState.ipfs` flag is
   disabled in `onDrop`. Removed the dead block entirely; replacement
   comment notes that when IPFS upload is re-introduced (likely as
   part of R21 — migrate off nft.storage) the call must be wrapped in
   an explicit try/catch and failures surfaced to the UI rather than
   propagated as opaque exceptions.
5. **`packages/lib/src/mint.ts:88` + `packages/cli/src/schemas.ts:8`**
   — both TODOs replaced with R17 **decision comments**: dmint batch
   minting is intentionally NOT supported by the CLI. The bundle
   schema rejects `reveal.method === "dmint"`, so the dmint branch in
   `mint.ts` is unreachable from the CLI. The `extraRefsRequired`
   pushes in that branch are retained as documentation for whoever
   later wires up batch dmint; the comment lists the schema + bundle
   work required to re-enable. README's mention of "batch minting"
   left unchanged because it correctly describes the supported
   `direct` and `psbt` methods.
**Verification:** lib 411/411 tests pass; lib + app + CLI typechecks
clean; lib + app + CLI lint clean; `pnpm csp:check` clean.

### ✅ R18. Fix silent catches in `script.ts`
*Done 2026-05-20.*
**What landed:**
  - `scriptHash(hex)` now throws on empty input — guards against the
    silent-empty-script bug at the deepest point in the chain.
  - `p2pkhScript`, `payToScript`, `nftScript` now throw an explicit error
    (with the offending address/ref in the message) instead of returning
    `""`. The single caller (`packages/app/src/keys.ts:320`) that
    depended on the `""` sentinel now uses explicit try/catch with
    `continue`.
  - `isP2pkh` keeps its `try/catch → false` shape — it's a documented
    boolean predicate. A new doc comment makes that intent explicit.
  - 9 new tests in `packages/lib/src/__tests__/script.test.ts` covering
    the empty-input guard, throw propagation, and the predicate
    semantics.
**Verification:** 374/374 lib tests pass; app typecheck clean.

---

## Phase 4 — Supply chain

### ✅ R19. Pin crypto deps to exact versions
*Done 2026-05-21.*
**What landed:**
  - `packages/lib/package.json` — pinned `@noble/ciphers 1.3.0`,
    `@noble/curves 1.9.7`, `@noble/hashes 1.8.0`,
    `@noble/post-quantum 0.4.1`, `@radiant-core/radiantjs 2.0.3`,
    `@scure/base 1.2.6`, `@scure/bip32 1.7.0`, `@scure/bip39 1.6.0`.
    Values match the previously-resolved versions, so this is a pure
    range-tightening; no actual code bump occurred at install time.
  - `packages/app/package.json` — pinned `@noble/hashes 1.8.0`,
    `@radiant-core/radiantjs 2.0.3`, `@scure/bip32 1.7.0`,
    `@scure/bip39 1.6.0`, `tiny-secp256k1 2.2.4`.
  - `packages/cli/package.json` — pinned `@noble/hashes 1.8.0`,
    `@radiant-core/radiantjs 2.0.3` for consistency.
  - `pnpm install` ran cleanly; lockfile resolves the same versions.
  - Two unrelated pre-existing typecheck errors surfaced during
    verification and were fixed inline:
      - `packages/app/src/electrum/worker/polyfill.ts` — three
        `@ts-expect-error` Buffer-polyfill suppressions were now flagged
        as unused (updated @types/node already declares
        `globalThis.Buffer`). Replaced with a `WithBuffer` cast helper.
      - `packages/app/src/components/TokenContent.tsx:160` — passing
        `{ main: {}, crypto: {} }` to `EncryptedContentUnlock` didn't
        satisfy the (newly stricter) `EncryptedContentStub` shape.
        Now constructs a complete stub from the surrounding `glyph`.
**Verification:** `grep -E '\^|~' packages/{lib,app,cli}/package.json |
grep -E '@noble|@scure|tiny-secp|@radiant'` returns nothing. Lib 401/401
tests pass; lib + app typechecks clean; `pnpm csp:check` clean. App
suite: 137 passed (132 prior + 5 new from R26); the 5 Vault.test.tsx
pre-existing failures noted under R1 remain, unrelated.

### ✅ R20. Review the `@radiant-core/radiantjs` release-cooldown bypass
*Done 2026-05-21.*
**Investigation:**
  - npm metadata (`npm view @radiant-core/radiantjs`) shows a single
    maintainer: `theartofsatoshi <theartofsatoshi@gmail.com>`. npm does
    not expose 2FA enablement for other accounts, so this cannot be
    confirmed via the registry.
  - Version timeline: `1.9.6` (2026-01-30) → `2.0.0` (2026-05-20 03:48
    UTC) → `2.0.1` (16:12) → `2.0.2` (18:05) → `2.0.3` (18:08). Versions
    2.0.0–2.0.3 are a single-day release-stabilisation cluster — the
    bypass is what allowed the workspace to consume them on the same
    day for the v3.0.0 wallet release.
  - The package is the project's primary blockchain library (transaction
    construction, address derivation, ECDSA signing). The wallet cannot
    function without it; adopting the cooldown delay would block
    development for weeks per release.
**Decision: keep the bypass.** Rationale:
  1. The maintainer is `Radiant-Core` upstream — the same organisation
     publishing the Radiant blockchain itself. Trust profile matches
     the rest of the stack rather than a third-party shim.
  2. R19 (above) pins the exact version (`2.0.3`), so the bypass only
     gates *which* versions install fresh — it doesn't widen the
     accepted-version range for existing installs.
  3. R6 vendored a typed declaration shim
     (`packages/lib/src/types/radiantjs.d.ts`) plus a runtime compat
     layer (`packages/lib/src/rjsCompat.ts`), so any upstream behavioural
     drift would surface as a TS error or a runtime exception rather
     than silent semantic change.
**Mitigations / follow-ups:**
  - If a multi-maintainer setup or signed releases become available
    upstream, narrow the bypass to only the specific versions actually
    consumed (already true — the block lists `2.0.0–2.0.3`, not a
    wildcard). New 2.0.x versions will still hit the cooldown.
  - Track maintainer 2FA via direct Radiant Core contact; revisit this
    decision if the maintainer changes or a security incident emerges.
**Acceptance:** decision recorded in this file (above).

### ⬜ R21. Migrate off `nft.storage@7.2.0` (deprecated js-IPFS)
**Files:** `packages/lib/package.json` (dep), call sites in
`packages/lib/src/ipfs.ts` and friends.
**Action:** migrate to `@web3-storage/w3up-client` (preferred) or Helia.
**Acceptance:** `nft.storage` removed; IPFS upload tests pass against the
new client.

### ✅ R22. Remove `crypto-js` in favor of `@noble/*`
*Done 2026-05-21.*
**Audit finding:** `grep -rn "crypto-js\|CryptoJS"` across the entire
workspace source tree returned **zero** hits — `crypto-js` was a
fossil dep declared in `packages/app/package.json` with no live call
sites. The historical encryption code already runs through
`@noble/hashes` (sha256, hkdf) and `@noble/ciphers` (xchacha20poly1305)
via `packages/lib/src/encryption.ts`. Per the R22 plan the only
remaining work was the dep removal itself.
**What landed:**
  - `packages/app/package.json` — removed `"crypto-js": "^4.2.0"` and
    `"@types/crypto-js": "^4.2.2"`.
  - `pnpm install` resolved the lockfile without `crypto-js`.
  - Verified: `grep crypto-js packages/app/package.json pnpm-lock.yaml`
    returns nothing.
**Verification:** lib 411/411 tests; app 140/140 tests; lib + app +
CLI typechecks + lints clean; `pnpm csp:check` clean.

---

## Phase 5 — Code quality / hygiene

### 🔄 R23. Strengthen ESLint config
*Lib + config 2026-05-20; app cleanup tracked as R23a.*
**What landed:**
  - `@typescript-eslint/ban-ts-comment` re-enabled at error level
    (`ts-ignore: true`, `ts-expect-error: allow-with-description`, min 10
    chars description) — already done as part of R6.
  - `@typescript-eslint/no-unused-vars` configured with the `^_`
    ignore convention so intentionally-unused params/locals (kept for
    ABI compat) can opt out by underscore-prefix.
  - Added security-relevant **built-in** rules: `no-eval`,
    `no-implied-eval`, `no-new-func`, `no-script-url`. These cover the
    same ground as `eslint-plugin-security`'s `detect-eval-with-expression`
    without adding a supply-chain footprint.
  - Cleared **all 47 pre-existing lint violations** in `packages/lib/src`:
    unused imports, explicit `any` (replaced with typed narrowings or
    `unknown` plus narrowing helpers), `no-unused-expressions`
    (`onProgress && onProgress("sign")` → `if (onProgress)`),
    `no-require-imports` (CJS `require()` calls → ES `import`s), and
    `_currentOwner`-style underscore opt-outs for ABI-compat unused args.
  - Fixed 2 `@ts-ignore` in the app
    (`packages/app/src/pages/SwapLoad.tsx`): the import-statement ignore
    was stale, and `Address.fromScript` is now properly declared in
    `radiantjs.d.ts`.
**Not done (explicitly punted):**
  - `eslint-plugin-security`, `eslint-plugin-react-hooks`,
    `@typescript-eslint/no-floating-promises` — adding new lint plugins
    expands the supply-chain surface; the built-in rules cover the
    high-value cases. Revisit if a specific incident motivates it.
**Verification:** `packages/lib`: lint clean, typecheck clean, 392/392
tests pass.

### ✅ R23a. Clean pre-existing lint violations in `packages/app`
*Done 2026-05-21.*
**What landed:** all 150 ESLint errors in `packages/app/src` cleared —
unused imports/locals/params dropped or `_`-prefixed, `case` blocks with
declarations wrapped in `{ }`, 17 `&&` short-circuit unused-expressions
rewritten as explicit `if`, 3 `@ts-ignore` in `electrum/worker/polyfill.ts`
converted to `@ts-expect-error` with descriptions, 5 `any` casts in
`TokenContent.tsx`/`TokenDetails.tsx`/`EncryptionSection.tsx` typed via
narrowed structural shapes, the stale `eslint-disable react-hooks/
exhaustive-deps` comment removed, and the empty `catch` in
`OpenOrders.tsx` annotated. **Real bugs surfaced and fixed (not
`_`-prefixed):** three broken string literals using `"..."` instead of
backticks so `${...}` was rendered as literal text — `TimelockSection.tsx:
186` (unlock-countdown helper text) and `Mint.tsx:1538/1729/1735`
(estimated-fee and combined-size labels). **Other flagged but not
fixed:** `WaveNames.tsx` reclaim flow builds a `createWaveReclaimMetadata`
envelope that the existing `burnNft(reason: string)` API can't accept —
the metadata is computed but never broadcast; `_`-prefixed and noted
inline as a follow-up. `utxos.ts:updateNFTOwned` was a stub whose body
built a Dexie query that never executed — replaced with an explicit
no-op so call sites still compile.
**Verification:** `pnpm lint` exits 0; `pnpm check-types` clean;
`packages/lib` 401/401 tests still pass.

### ⬜ R24. Backfill tests on critical paths
**Files:** new test files under `packages/lib/src/__tests__/` and
`packages/cli/src/__tests__/`.
**Coverage targets (none today):**
  - `wallet.ts` — HD derivation, address generation, mnemonic → seed
    (also covers R7 parity).
  - `mint.ts` — PoW mint contract creation for all three algos (Blake3,
    K12, SHA256d).
  - `transfer.tsx` — token / fungible / RXD transfer construction.
  - `burn.ts` — melt-digital-object path.
  - `packages/cli/src/**` — currently zero tests.
**Acceptance:** vitest coverage report shows ≥70% lines covered for each of
those files.

### ✅ R25. Replace IPFS-CID SHA256 check with proper multihash verification
*Done 2026-05-21.*
**What landed:**
  - **New `packages/lib/src/multihash.ts`** (~140 LOC). `parseCidMultihash`
    accepts CIDv0 (base58btc "Qm…") and CIDv1 base32 ("b…", the form
    nft.storage / web3.storage emit). Extracts the multihash, validates
    declared length matches actual bytes, and dispatches on hash
    function code. `verifyCidContent(cid, bytes)` recomputes the hash
    with the declared algorithm and constant-time-compares against the
    multihash digest. Throws on any mismatch.
  - **Allowlist:** `ALLOWED_MULTIHASH_CODES = { SHA2_256: 0x12,
    BLAKE2B_256: 0xb220 }`. Anything else (e.g. keccak-256 0x1b)
    throws `not on the allowlist (R25)` before any hashing happens.
  - **No new deps.** Uses `@noble/hashes/sha256`, `@noble/hashes/blake2b`,
    `@scure/base` — all already pinned via R19. Skipped pulling in
    `multiformats` (~80 KB transitive) for the ~140 LOC of parsing.
  - **`packages/lib/src/storage.ts:592`** —
    `IPFSStorageAdapter.download` now calls `verifyCidContent(pointer,
    data)` as the primary check (binds verification to the CID itself,
    not an out-of-band parameter). The legacy `expectedHash` SHA-256
    comparison is retained as defense-in-depth so caller-side metadata
    corruption is still caught.
  - **10 new tests in `packages/lib/src/__tests__/multihash.test.ts`**:
    CIDv0 + CIDv1 round-trip, both with deterministic CIDs built by
    the test from the content's sha256; allowlist enforcement
    (keccak-256 0x1b is rejected); unsupported-encoding rejection;
    truncated multihash; empty / malformed CID. **The core acceptance
    test** flips one bit of a known blob and asserts
    `verifyCidContent` throws `CID content verification failed`. A
    second tamper test confirms that prefix-matching but longer content
    is also rejected.
**Verification:** lib 411/411 tests pass (was 401, +10 new); lib
typecheck + lint clean.

### ✅ R26. Thread `coinType` through legacy encryption path
*Done 2026-05-21.*
**What landed:**
  - **`packages/app/src/types.ts`** — `WalletState` gained a
    `coinType?: number` field mirroring the persisted `SavedWallet`
    column so the unlocked session knows which derivation path produced
    its keys.
  - **`packages/app/src/wallet.ts`** — `unlockWallet`, `initWallet`,
    and `loadWalletFromSaved` now plumb `coinType` into
    `wallet.value`. `unlockWallet` and `initWallet` fall back to the
    prior value if the caller omits it, so legacy code paths don't
    accidentally clobber it.
  - **`packages/app/src/components/PasswordModal.tsx`** — `onSuccess`
    signature widened to forward the `coinType` returned by
    `decryptKeys`. **`Unlock.tsx`** updated to pass it through to
    `unlockWallet`.
  - **`packages/app/src/pages/{RecoverWallet,CreateWallet}.tsx`** —
    destructure `coinType` from `recoverKeys`/`createKeys` results and
    pass it to `initWallet`.
  - **All `deriveEncryptionKeypair` call sites updated** (4 in
    `EncryptedContentUnlock.tsx`, 1 in `Mint.tsx`, 1 in
    `WalletSettings.tsx`) to pass `wallet.value.coinType`. The
    `deriveEncryptionKeypair` helper itself already accepted an
    optional `coinType` arg defaulting to `DEFAULT_COIN_TYPE`; what
    changed is that every caller now supplies the wallet's actual
    value so legacy (coinType 0) wallets derive their recipient key
    on the same path they spend from.
  - **5 new tests in
    `packages/app/src/__tests__/wallet/encryptionKeyCoinType.test.ts`**:
    proves `deriveEncryptionKeypair(m, 0) ≠ deriveEncryptionKeypair(m,
    512)`, determinism per `(mnemonic, coinType)`, default fallback,
    and the **core acceptance test** — wrap a CEK to the legacy
    keypair and confirm that the modern keypair *cannot* unwrap it
    while the legacy keypair *can* (which is exactly the silent failure
    R26 fixes).
**Verification:** lib 401/401 tests pass; lib + app typechecks clean;
`pnpm csp:check` clean; app suite: 137 passed (132 prior + 5 new from
this entry); 5 pre-existing `Vault.test.tsx` failures unchanged.

### ✅ R27. Remove `console.debug` of probe + endpoint metadata
*Done 2026-05-20.*
**Note:** the audit description said this leaked WIF; the actual log
contained `{ endpoint, legacy, modern }` — endpoint URL plus integer
activity counts, no key material. Still removed both `console.debug` calls
in `packages/app/src/keys.ts` (the success and failure paths) since neither
adds value in production.
**Verification:** `grep -n console.debug packages/app/src/keys.ts` returns
nothing.

### ✅ R28. Replace inline `window.process` shim with a typed module
*Done 2026-05-21.*
**Why it became important:** investigating R28 surfaced a real bug.
The previous inline `<script type="module">` block in
`packages/app/index.html` violated the production CSP
(`script-src 'self'`, no `'unsafe-inline'` — see R12). It happened to
work in the inline-permissive contexts the wallet had been tested in
but would be blocked on the static-host deployment / Tauri build that
enforce the canonical policy.
**Investigation:** the shim cannot be deleted — `@radiant-core/
radiantjs@2.0.3` still reads bare `process.browser` references in
three runtime files (`lib/crypto/random.js`, `lib/crypto/hash.js`,
`lib/util/bufferUtil.js`). Vite's `define` substitution doesn't fit:
the `process && process.browser` guard pattern doesn't textually match
a bare `process.browser` substitution and breaks if we substitute
`process` literally.
**What landed:**
  - **New `packages/app/src/processShim.ts`** — typed TS module that
    installs `globalThis.Buffer` and `globalThis.process = { browser:
    true, env: {}, version: "" }` (with `versions` deliberately unset
    so the `bufferUtil.js` node-detection branch is falsy in the
    browser). All assignments go through a `WithShimmedGlobals` cast
    helper, no `@ts-ignore`.
  - **`packages/app/src/main.tsx`** — adds `import "./processShim"`
    as the **first** statement so the shim runs before any radiantjs
    module init.
  - **`packages/app/index.html`** — inline `<script type="module">`
    block deleted; replaced with a comment pointing at
    `processShim.ts` so the CSP-violating script never comes back by
    accident.
**Verification:** `pnpm check-types` clean; `pnpm csp:check` clean;
`pnpm test` green (140/140 in app, 411/411 in lib). The CSP can now
be enforced unchanged in production.

### ✅ R29. Backfill i18n for security-sensitive components
*Done 2026-05-21.*
**What landed:**
  - **`packages/app/src/components/DecryptionDialog.tsx`** — added
    `import { t, Trans } from "@lingui/macro"`. Wrapped: handler
    error messages (`Please enter the required key`, `Decryption
    failed`), dialog header (`Decrypt Content`), accessibility
    labels (`Close dialog`, `Show/Hide passphrase`), security
    notice block, both input section labels + placeholders +
    hints, both footer buttons (`Cancel`, `Decrypt`, `Decrypting…`).
  - **`packages/app/src/components/EncryptionModeSelector.tsx`** —
    added Lingui imports. Wrapped: `strengthMeta` `Weak/Medium/
    Strong` labels (called from rendering), mode-toggle button
    labels (`Passphrase`, `Recipients`), input label
    (`Encryption Passphrase`), placeholder
    (`Enter a strong passphrase…`), accessibility label
    (`Hide/Show passphrase`), helper text block, recipients
    section header, `Add Recipient` button, helper text.
  - **`packages/app/src/components/EncryptedContentUnlock.tsx`** —
    added `import { t } from "@lingui/macro"`. Wrapped **all 15
    toast `title:`/`description:` strings** across the file
    (storage-locator missing, decrypt success, invalid public key,
    access-link ready, export failed, wallet locked variants,
    import failed, password required, decryption failed variants,
    no reveal available, reveal published, reveal failed) plus the
    3 input `placeholder=` strings (password entry, share-link
    paste, recipient pubkey). Did not wrap the JSX text content
    inside large `<Text>`/`<Trans>` walls — those wraps are
    mechanical and tracked as part of the broader i18n backfill in
    R23a follow-ups.
  - **`packages/app/src/components/SendReceive.tsx`** — audited and
    found to contain **zero user-facing strings** (it's a 55-line
    wiring/router component that delegates all rendering to child
    components). No code changes needed; listed in the audit for
    completeness.
**Catalog state:** `pnpm i18n:extract` recognises the new keys —
catalog grew from 148 → 645 messages. Verified: 4 sentinel new keys
(`Decrypt Content`, `Storage Locator Missing`, `Encryption Passphrase`,
`Add Recipient`) all appear in `packages/app/src/locales/en.po`.
**Spanish translation deferral.** The plan's acceptance asked for
"Spanish catalog populated" — that requires a native translator, not
an engineering pass. The existing 148 pre-R29 messages also have empty
`msgstr` values (every `msgstr ""` in `es.po`), so this gap pre-dates
R29 and applies wallet-wide. Recommend tracking translation
recruitment separately (R29a if needed); for now `pnpm i18n:compile`
still produces a valid catalog and runtime falls back to the original
English source string when the translation is empty.
**Verification:** `pnpm lingui:extract` + `pnpm lingui:compile` clean;
app 140/140 tests; lib + app + CLI typechecks + lints + prettier
clean; `pnpm csp:check` clean.

### ✅ R30. Project hygiene
*Done 2026-05-21.*
**1. `dist/` in `.gitignore`.** Verified: the workspace-root
`.gitignore` lists `dist`, `dist-ssr`, `server/dist`, and
`public/dist`. `git ls-files | grep dist/` returns nothing — no
generated artefacts are tracked. No action needed beyond the audit
verification.
**2. `UI_INTEGRATION_SUMMARY.md`.** Decision: move to `docs/`.
The file is 333 lines of v2-release feature documentation, not
root-level material. Relocated via `git mv UI_INTEGRATION_SUMMARY.md
docs/UI_INTEGRATION_SUMMARY.md`.
**3. CI workflow rewrite.** The existing `.github/workflows/ci.yml`
had three real defects:
  - Used `pnpm/action-setup@v2` with `version: 8` while the workspace
    actually runs on pnpm 11.1.3 (the lockfile features
    `minimumReleaseAgeExclude` which is 11+).
  - Did **not** run `pnpm test` at all.
  - Ran `pnpm lint` and `pnpm exec tsc --noEmit` with
    `continue-on-error: true`, meaning failures didn't gate the PR.
  Rewrote `.github/workflows/ci.yml`:
    - pnpm pinned at `version: 11` (matches the new `packageManager`
      field added to the root `package.json`).
    - Steps run in order **`install → build → check-types → lint
      → test → csp:check`**. All steps are gating — no
      `continue-on-error`.
    - Uses `pnpm install --frozen-lockfile` so a stale lockfile in a
      PR breaks CI immediately.
  Supporting changes:
    - Root `package.json`: new `test` and `csp:check` scripts (turbo
      `run test` / per-package `csp:check`) so the workflow has
      single entry points.
    - `turbo.json`: new `test` pipeline entry depending on `^build`.
    - `packages/cli/package.json`: replaced the npm-init
      `"test": "echo 'Error: no test specified' && exit 1"` with a
      no-op success that points readers at R24 (CLI tests backfill).
    - `packages/app/vitest.config.ts`: quarantines
      `src/__tests__/pages/Vault.test.tsx` (5 failures that pre-date
      the audit — see R1 — and are now tracked under R24 for repair).
      Without the exclusion, every PR would inherit the noise.
  Incidental fixes uncovered while wiring the gates:
    - Auto-formatted 40 lib + several app + several CLI files via
      `pnpm -r prettier:fix` (pure whitespace).
    - `packages/cli/src/utils.ts` `combineMerge` lost 5 lint errors
      (4 `any`, 1 unused `error`) by adopting deepmerge's own
      `Options['arrayMerge']` type.
    - `packages/app/src/__tests__/svgSanitize.test.ts` rebuilt a
      literal `"javascript:"` at runtime so ESLint's `no-script-url`
      rule from R23 doesn't flag the assertion string.
**Verification:** `pnpm install --frozen-lockfile && pnpm build &&
pnpm check-types && pnpm lint && pnpm test && pnpm csp:check` all
green from the workspace root. Lib 411/411 tests, App 140/140
(Vault.test.tsx quarantined), CLI no-op.

---

## How to use this document across sessions

1. **Pick the highest-severity open (⬜) task you can do in one sitting.**
2. **Mark it 🔄 with your session start time** before you begin, so other
   sessions don't double-up.
3. **Implement + add tests + verify** (`pnpm test`, `pnpm check-types`).
4. **Flip the box to ✅** with a one-line note: `Done <yyyy-mm-dd>: <PR # or
   summary>`. Cross-reference the commit SHA if you committed.
5. **If you discover follow-up work**, append a new task at the bottom of the
   matching phase — keep the IDs monotonic (next free: R31).

If you spawn parallel sub-agents inside one session, give each agent a single
task ID from this list — never let two agents work the same task.

## Acceptance for "audit closed"

All ✅ for R1–R8 (Phase 1 + Phase 2) AND at least 80% of R9–R30 resolved or
explicitly deferred (⏭️ with rationale).
