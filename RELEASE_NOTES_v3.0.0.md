# Photonic Wallet v3.0.0

**The first tagged stable release** — V2-launch dMint mainnet activation, Vaults, WAVE name registration, and full Radiant Core v3.0.0 alignment. This release covers everything since `73df0e4` (the initial v3.0.0 work commit, 40 commits).

> ⚠️ **Mining requires a Radiant Core v3.0.0+ node** in the network to reliably confirm V2-launch dMint mint transactions. Older Radiant Core versions may relay the txs but won't select them for block templates.

---

## Highlights

### V2-launch dMint contract format
A new dMint contract shape (post 2026-05-26 redesign) that propagates adaptive DAA on chain *and* emits MINIMALDATA-compliant pushes throughout. Adaptive-DAA dMint is now mainnet-mineable across the full target range.

- **`fix(dmint)`** PartC `OVER → DUP` (1-byte fix at `script.ts:793`) — the v2-launch ELSE_BRANCH used `0x78` (OP_OVER) to fetch `newHeight` before MINIMAL_PUSH, which actually dup'd the 36-byte cRef at depth-1. Radiant-Core's 8-byte script-num cap (`script.h:568,639`) then tripped `INVALID_NUMBER_RANGE_64_BIT` and every V2-launch mint was rejected with `mandatory-script-verify-flag-failed (unknown error)`. Fixed by changing to `0x76` (OP_DUP).
- **`feat(dmint)`** V2-launch redesign — minimal-push state items + on-chain DAA propagation. PartB4 changed from `7575757575` (5×OP_DROP) to `6b75757575` (TOALTSTACK + 4×OP_DROP) so PartC can reconstruct the next state with the DAA-computed newTarget.
- **`feat(dmint)`** EPOCH and SCHEDULE DAA bytecode implementations.
- **`fix(dmint)`** ASERT-lite DAA bytecode uses `OP_NEGATE` (0x8f) not `OP_BIN2NUM` (0x81) — the pre-fix bug rendered the negative-drift clamp identical to the positive check.
- New 287-test regression suite (`dmint-partc-roundtrip.test.ts`) implementing a Radiant-Core-faithful PartC simulator. Walks every (algo × DAA × height × target) combination and asserts byte-equality with the wallet's emit. Includes the fault-injection test that confirms a regression to `0x78` trips the simulator with the exact `INVALID_NUMBER_RANGE_64_BIT` error.

### Vaults — NFT + FT time-locked custody
- **`feat`** NFT and FT vault creation, claim, and tests.
- **`feat`** Vault discovery from transaction history with manual scan UI + progress logging.
- **`feat`** Vault token picker, FT balance validation, optimistic glyph claim.
- **`feat`** Vault discovery improvements: batch processing, timeout handling, duplicate prevention, concurrency lock.
- **`feat`** Scan both main + swap addresses for vault discovery.
- **`feat`** Vault discovery fallback decryption — tries both main + swap WIFs for encrypted vaults.
- **`fix`** Time-mode vault claims gate on MTP (median time past), not wall-clock.
- **`fix`** FT vaults use native output scripts instead of P2SH.
- **`feat`** Locktime validation for vesting tranches with input highlighting.

### WAVE name registration
- **`feat`** WAVE duplicate detection + improved vault token funding.
- **`fix`** Resilient WAVE resolution with RXinDexer fallback when the connected server lacks `wave.resolve`.
- **`feat`** Pre-fill target address with user's wallet address + "Use My Address" button in WAVE registration.
- **`fix`** WAVE name resolution integrated into fungible token sends.

### Radiant Core v3.0.0 alignment
- **`feat`** BIP44 SLIP-0044 coin type 512 derivation path `m/44'/512'/0'/0/k` for new wallets.
- **`feat`** BIP44 coin type dual-path support for legacy wallet compatibility.
- **`fix`** Fee-rate floor reconciled against Radiant Core `RADIANT_CORE_2` policy.
- **`chore`** `@radiant-core/radiantjs` bumped to ^2.0.3 across the workspace.

### Encrypted glyphs
- **`ux`** Encrypted content card + decrypt panel in the token Details tab.
- **`fix`** `unwrapCEK` derives hybrid/classical mode from the sender's ephemeral data.
- Encrypted glyphs encoding via xchacha20poly1305 with locator-key escrow.
- StorageManager supports on-chain (glyph), IPFS, Arweave, and Wallet-Backend backends for encrypted blob storage.

### Send + confirmation flow
- **`feat`** Transaction confirmation modal for all Send screens (C4 audit finding).
- **`fix`** Optimize NFT/FT vault claim funding and improve fee calculation.
- **`fix`** Vault claim funding scales to actual fee instead of a stale 50k hardcode.
- **`fix`** Skip spent checks for unconfirmed vaults; improve token-vault fee estimation.

### My Public Offers (OpenOrders)
- **`feat`** "My Public Offers" panel on the OpenOrders page with cancel support.

### Security + audit remediation
- **`feat`** Major security and functional update (full audit remediation pass).
- C5: transaction-hash verification in glyph reveal fetch — prevents tx poisoning from malicious servers.
- Multiple input-validation hardening passes through `normalizeRef`, `decodeGlyph`, vault discovery, and the Electrum subscription handler.

### Workspace + build
- **`chore(app)`** `HTTP_DEV=1` opt-out for the `basicSsl` Vite plugin (smoother dev-server workflow without self-signed cert prompts).
- **`fix`** Handle both ESM and CommonJS module formats in i18n catalog loading.
- **`fix`** Migrate `pnpm.patchedDependencies` and overrides to `pnpm-workspace.yaml`.
- **`chore`** Bump `cli` + `tauri` to 3.0.0 (matching `app` + `lib` package versions).

---

## Upgrade notes

- **Mining nodes**: V2-launch dMint mints require a Radiant Core v3.0.0+ node to mine the tx into a block. The wallet broadcasts work fine on any node, but confirmation depends on at least one v3.0.0+ node being on the network.
- **Legacy wallets**: BIP44 path change only affects *new* wallet creation. Existing wallets continue on the legacy derivation path and load transparently.
- **Pre-2026-05-26 V2 deploys** (B3T2, K12T, DEEZ, apple, VRT) no longer parse under the v2-launch shape and are considered disposable test tokens. The new V2 IS the public launch contract.
- **Pre-2026-05-27 V2-launch deploys** have the `OVER → DUP` bug baked into their on-chain PartC bytecode and are permanently un-mineable. Burn and re-deploy.

---

## Test coverage

- **723 tests pass** across 17 test files.
- New `dmint-partc-roundtrip.test.ts` (287 tests) — primary regression for the V2-launch PartC fix.
- `dmint.test.ts` extended to 59 tests covering EPOCH/SCHEDULE DAA bytecode + MINIMAL_PUSH primitive equivalence.
- Vault test coverage (87 tests) covers creation, claim, time-mode gating, and edge cases.
- Wallet, encryption, electrumWsClient, royalty, multihash, and protocols suites all green.

---

## Acknowledgements

V2-launch correctness analysis and PartC simulator co-developed in pair with Claude — full byte-level analysis documented in commit `23efc3c`.
