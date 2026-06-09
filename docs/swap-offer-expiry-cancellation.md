# Swap-offer expiry & cancellation

Status: **Phase 1 shipped. Phase 2 protocol primitives implemented +
regtest-proven (RSWP v3 wire format + timelocked-refund covenant); the wallet
covenant-reservation migration + cross-repo index parsers remain (see §7).**

This document resolves the `TODO(security)` previously at
`packages/app/src/pages/Swap.tsx` (PSRT construction) and records the design for
a real, consensus-level offer expiry.

## 1. Problem

A swap offer is a **Partially Signed Radiant Transaction (PSRT)**: the maker
moves the asset to a dedicated swap address and signs a single
input → single output with

```
SIGHASH_SINGLE | SIGHASH_ANYONECANPAY | SIGHASH_FORKID
```

(`packages/lib/src/transfer.tsx` → `partiallySigned`). The signature commits the
maker's reserved input to exactly one output — their desired payment — and lets
**anyone** add their own inputs/outputs and complete the transaction (that is the
whole point of an atomic swap).

The consequence is a liveness/price-staleness problem:

- The signature has **no expiry** and **no per-offer cancellation nonce**.
- A shared offer — and especially a **public** offer advertised to the swap
  index (`SwapMode.BROADCAST`, the `RSWP` OP_RETURN) — stays executable by anyone
  who holds the signed bytes, **at the originally-signed price, indefinitely**.
- The **only** way for a maker to revoke it is to **self-spend the reserved
  UTXO** (`packages/app/src/swap.ts` → `cancelSwap`). If the maker forgets, a
  counterparty can fill the offer weeks later after the market has moved.

This became more user-facing once general NFTs gained a **"List for sale"**
button (`ViewDigitalObject.tsx` → `/swap`), so any user can publish a long-lived,
price-frozen offer with one click.

### Threat model

| Holder of the signed offer | Bound by soft expiry? | Bound by cancellation? | Bound by Phase-2 on-chain expiry? |
| --- | --- | --- | --- |
| The reference wallet / cooperative taker | **Yes** | Yes | Yes |
| The swap index (`-swapindex=1`, `getopenorders` `maxAge`) | **Yes** | Yes (UTXO spent) | Yes |
| An attacker who saved the raw PSRT and broadcasts it directly to a node | **No** | **Yes** (UTXO spent) | **Yes** |

The takeaway: until Phase 2, **cancellation (self-spend) is the only hard
revocation**. Everything else is cooperative mitigation and taker protection.

## 2. Options evaluated

The original TODO suggested three mitigations.

### Option 1 — `nLockTime` / `OP_CHECKLOCKTIMEVERIFY` expiry

**Subtlety that matters:** `nLockTime` and `OP_CHECKLOCKTIMEVERIFY` (CLTV) are
"**valid-from**" primitives, not "valid-until". A transaction with
`nLockTime = T` (and a non-final input sequence) becomes mineable **once the
chain passes height/time `T`** — it does *not* become invalid afterwards. CLTV
likewise enforces `tx.nLockTime >= scriptValue`, a **lower** bound.

So a naïve "sign the PSRT with `nLockTime = expiry`" does the **opposite** of what
we want: it would *delay* when the offer can be filled, then leave it fillable
forever. A real expiry therefore cannot be built from `nLockTime` alone.

What *does* work (see Phase 2): a **timelocked refund covenant** on the reserved
UTXO. The token rests in a script with two branches —

- **swap branch** (anytime): the pre-signed `SINGLE|ANYONECANPAY` spend, as today;
- **refund branch** (`<expiry> OP_CHECKLOCKTIMEVERIFY OP_DROP <makerPubKey>
  OP_CHECKSIG`): lets the maker reclaim the asset after `expiry`.

After `expiry` both branches are live, so the maker's wallet **auto-reclaims** at
the deadline. The practical effect is a **guaranteed, cheap cancellation at a
chosen block height** rather than relying on the maker to remember. (Radiant's
existing vault code already builds exactly this CLTV pattern — see
`packages/lib/src/vault.ts`, `CLTV_SEQUENCE`, `setInputSequence`,
`encodeLocktimeAsNum` — so the wallet primitives exist.)

A *truly atomic* "swap branch becomes invalid at `expiry`" would require the
covenant to read the spending transaction's `nLockTime` and enforce an **upper**
bound, which needs transaction-introspection opcodes. If Radiant exposes a
tx-locktime introspection opcode this is an option; otherwise the refund-covenant
above is the realizable mechanism and is what we recommend.

### Option 2 — per-offer cancellation nonce committed by a covenant

Lets the maker invalidate an offer without moving the reserved UTXO, by
publishing a revocation that a covenant checks. This needs the same class of
covenant work as Option 1 and is **subsumed** by the refund covenant (which
already gives cheap revocation). Documented for completeness; not recommended
over the refund covenant.

### Option 3 — UI cancellation affordance + explicit warning (no protocol change)

Shippable immediately. One-click cancellation already exists
(`SwapPending.tsx`, and `OpenOrders.tsx` → *My Public Offers*). The gap was that
the risk was **not surfaced** and there was **no expiry of any kind**.

## 3. What ships in Phase 1 (this PR)

All wallet-only, no consensus or index-format change.

1. **Maker risk warning** at offer creation (`Swap.tsx`), with stronger copy for
   public/broadcast offers: the offer is signed at a fixed price with no expiry
   and stays fillable until cancelled; cancelling is the only revocation.
2. **Cancellation surfaced** as the explicit remedy on the success screen and on
   the *Pending Swaps* page; one-click cancel is retained in both *Pending Swaps*
   and *Open Orders → My Public Offers*.
3. **Client-side soft expiry** (`packages/app/src/swapExpiry.ts`):
   - default window ~30 days (`SWAP_OFFER_DEFAULT_MAX_AGE_BLOCKS = 4320` at
     `SWAP_BLOCK_SECONDS = 600`), centralized so a future maker-chosen on-chain
     expiry can override it per offer;
   - the **Open Orders** book dates each offer against the index chain tip
     (`getswapindexinfo.current_height`), **hides** offers past the window by
     default, exposes a **"Show expired (N)"** toggle, renders an **Expired**
     badge and human-readable age, and **warns** before a taker fills a stale
     offer.

   This binds cooperative clients and the swap index (which already accepts an
   optional `maxAge` argument on `getopenorders` / `getopenordersbywant`). It is
   honestly **not** a consensus guarantee — an attacker broadcasting a saved PSRT
   directly is unaffected.

### Why the soft expiry is client-side, not in the advertisement

The `RSWP` v2 OP_RETURN ends with `... || priceTerms || signature`, where
`signature` is read to the end of the payload. There is **no room to append a
maker-chosen `expiry` field without a version bump**, and a version bump must be
understood by every consumer of the advertisement (see §4). So Phase 1 uses a
**global client policy** (`maxAge`) rather than a per-offer, maker-chosen value.
The index already supports the `maxAge` filter, so once we confirm production
index support the wallet can additionally pass it on the `getopenorders` calls;
today the wallet enforces the window client-side to avoid depending on a
particular index build (a failed 4th-arg call would otherwise be swallowed by the
existing `.catch(() => [])` and hide *all* orders).

## 4. Phase 2 — consensus-level expiry (follow-up)

Recommended design:

1. **`RSWP` v3 advertisement** carrying a maker-chosen `expiry_height` (and a
   flag bit). Bump the version byte from `0x02` → `0x03`.
2. **Timelocked-refund covenant** on the reserved UTXO (Option 1 above): swap
   branch anytime; `<expiry_height> CLTV DROP <makerPubKey> CHECKSIG` refund
   branch. Maker wallet auto-reclaims at `expiry_height`.
3. **Cooperative/index enforcement**: index hides offers past `expiry_height`;
   the wallet refuses to *complete* an offer past its on-chain expiry.

### Cross-repo coordination (do not ship the format change blind)

`RSWP` is parsed in **more than one place**:

- **Radiant Core** `swapindex` (C++, `swapindex.h`) — the `-swapindex=1` index
  that serves `getopenorders*` for the hosted `swap.radiantcore.org` endpoint
  (see `docs/deployment-guide.md`). It must parse v3 and expose / filter on
  `expiry_height`.
- **RXinDexer** — also parses `RSWP`/`MultiTxOutV1` price terms (see the
  RXinDexer RSWP format notes). Its parser must accept v3.
- **This wallet** — `buildSwapAdvertisementScript` (builder, `Swap.tsx`) and
  `parsePriceTerms` (`swapBroadcast.ts`).

Bumping the version without updating a consumer will make that consumer drop or
misparse v3 offers. Land the parsers first (v2 + v3 accepted), then the wallet
builder, then enable maker-chosen expiry in the UI.

### Implemented RSWP v3 wire layout (this change)

`buildSwapAdvertisementScript` (`packages/app/src/pages/Swap.tsx`) now emits v3
when an `expiry_height` is supplied, keeping the v2 path byte-for-byte:

```
OP_RETURN "RSWP" <version:1> <flags:1> <offeredType:1> 0x01 <tokenid:32LE>
  [wantTokenid:32LE   if flags & 0x01]
  [expiry_height:4LE  if flags & 0x02]      <-- NEW in v3
  <txid:32LE> <vout> <priceTerms> <signature>
```

- `version` = `0x03` when an expiry is present, else `0x02`.
- `flags` bit `0x01` = has want token (v2, unchanged); bit `0x02` = has
  `expiry_height` (new). The two bits do not collide.
- `expiry_height` is an unsigned 4-byte little-endian absolute block height,
  inserted immediately AFTER the want-token id and BEFORE the outpoint, so a v3
  parser reads it positionally; `signature` is still read to end-of-payload.
- Constants: `RSWP_VERSION_V2/V3`, `RSWP_FLAG_HAS_EXPIRY` in
  `packages/app/src/swapBroadcast.ts`.

### Implemented refund covenant (this change)

`packages/lib/src/swapRefundCovenant.ts` — hex-opcode builder, round-tripped
through the radiantjs parser (same style as `royaltyCovenant.ts` /
`soulbound.ts`). The reserved UTXO scriptPubKey is the covenant itself (native,
not P2SH — like ftScript/nftScript):

```
OP_IF
  <inner-swap-script>                                  ; SWAP branch (anytime)
OP_ELSE
  <expiry_height> OP_CHECKLOCKTIMEVERIFY OP_DROP
  <inner-swap-script>                                  ; REFUND branch (>= expiry)
OP_ENDIF
```

where `<inner-swap-script>` is byte-identical to the ordinary swap-address
script (`p2pkhScript` for RXD, `ftScript`/`nftScript` for tokens) — so the
maker's existing SIGHASH_SINGLE|ANYONECANPAY pre-signature is produced exactly
as today. Branch selectors (appended to the inner `<sig> <pubkey>` scriptSig):
`OP_1` (0x51) → SWAP, `OP_0` (0x00) → REFUND. The refund-claim builder
(`buildSwapRefundClaimTx`) sets `nLockTime = expiry_height` and the input
`nSequence = 0xfffffffe`.

CLTV is "valid-from", so this gives the maker a guaranteed auto-reclaim at the
deadline; it does NOT make the SWAP branch invalid after expiry (that would need
a tx-locktime-introspection opcode for an UPPER bound — see §2 Option 1). The
unfillability of a past-expiry offer is therefore enforced cooperatively: the
wallet hard-refuses to complete an expired offer (`OpenOrders.handleAcceptOrder`
+ `isOfferExpiredOnChain`) and the index hides it.

## 5. Testing

- **Phase 1 (this PR):** unit tests for the soft-expiry math
  (`packages/app/src/__tests__/swapExpiry.test.ts`) — age, staleness boundary,
  custom window, undateable offers, age labels. The on-chain swap protocol is
  unchanged, so the existing swap **regtest matrix**
  (`packages/lib/src/__tests__/swap-load-flow.regtest.test.ts`,
  `wave-swap-regtest.test.ts`, `swap-load-output-order.test.ts`) continues to
  cover the load/complete path unchanged.
- **Phase 2 (implemented):**
  - `packages/lib/src/__tests__/swapRefundCovenant.test.ts` (18 unit tests) —
    expiry-height encoding, inner-script equivalence to ftScript/nftScript/p2pkh,
    covenant layout + round-trip parse (incl. rejecting a tampered covenant whose
    two inner branches differ), scriptSig/selector builders, and the
    `isOfferExpiredByHeight` boundary.
  - `packages/lib/src/__tests__/swapRefundCovenant.regtest.test.ts` (RXD) — runs
    the v3.0.0 interpreter and proves on-chain: **(a)** SWAP branch fills BEFORE
    expiry (taker pays maker via the OP_1 branch); **(b)** REFUND branch BEFORE
    expiry is REJECTED (`bad-txns-nonfinal`); **(c)** REFUND branch AT/AFTER
    expiry is ACCEPTED and the maker reclaims the RXD. Run with
    `REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run
    src/__tests__/swapRefundCovenant.regtest.test.ts --testTimeout=600000`
    against the local regtest stack (radiantd RPC 127.0.0.1:17443). Verified
    PASSING 2026-06-09.
  - `packages/app/src/__tests__/swapBroadcastExpiry.test.ts` (5 tests) — RSWP
    version/flag constants and `isOfferExpiredOnChain` (taker-side boundary,
    fail-open on unknown tip).
- **Phase 2 (not yet covered — see §7):** v3 advertisement round-trip through
  the live Radiant Core `swapindex` / RXinDexer (those parsers are not in this
  repo); FT/NFT covenant regtest cases (only RXD is proven on-chain so far,
  though the covenant builder is asset-type-generic and unit-tested for FT/NFT).

## 6. Files touched (Phase 1)

- `packages/app/src/swapExpiry.ts` — soft-expiry helpers + policy constants (new).
- `packages/app/src/__tests__/swapExpiry.test.ts` — unit tests (new).
- `packages/app/src/pages/Swap.tsx` — maker risk warning; success-screen cancel
  guidance; replaced the `TODO(security)` block with a pointer here.
- `packages/app/src/pages/OpenOrders.tsx` — chain-tip fetch, hide/flag/warn on
  stale offers, "Show expired" toggle.
- `packages/app/src/pages/SwapPending.tsx` — risk banner above pending offers.
- `SECURITY.md` — known-limitation entry for swap-offer liveness.

## 6b. Files touched (Phase 2 — this change)

- `packages/lib/src/swapRefundCovenant.ts` — RSWP v3 timelocked-refund covenant:
  `swapRefundScript` (builder), `parseSwapRefundScript`/`isSwapRefundScript`,
  `encodeExpiryHeight`, `innerSwapScript`, `buildRefundScriptSig` /
  `appendSwapSelector`, `buildSwapRefundClaimTx` (maker auto-reclaim tx), and
  `isOfferExpiredByHeight`. (new)
- `packages/lib/src/__tests__/swapRefundCovenant.test.ts` — 18 unit tests. (new)
- `packages/lib/src/__tests__/swapRefundCovenant.regtest.test.ts` — on-chain
  proof of swap-before / refund-rejected-before / refund-accepted-after. (new)
- `packages/app/src/swapBroadcast.ts` — `expiry_height` on `SwapOffer`;
  `RSWP_VERSION_V2/V3`, `RSWP_FLAG_HAS_EXPIRY`; `isOfferExpiredOnChain`.
- `packages/app/src/pages/Swap.tsx` — v3 advertisement builder (adds
  `expiry_height`, keeps v2); derives the expiry height from the chain tip; the
  covenant-reservation path is gated behind `SWAP_RESERVE_INTO_REFUND_COVENANT`
  (see §7).
- `packages/app/src/pages/OpenOrders.tsx` — hard-refuses to fill an offer past
  its on-chain `expiry_height`, and hides expired offers from the book.
- `packages/app/src/__tests__/swapBroadcastExpiry.test.ts` — 5 unit tests. (new)

## 7. Remaining work / known gaps (human review)

These are deliberately out of scope for this change and must be completed before
the consensus expiry is *enabled* end-to-end:

1. **Wallet covenant-reservation migration (gated OFF).** Reserving the offered
   asset into the refund covenant changes the reserved UTXO's on-chain shape.
   Four existing v2-shaped paths assume a plain `ftScript`/`nftScript`/`p2pkh`
   at the swap address and must be made covenant-aware first:
   - swap *discovery* — `electrumWorker.findSwaps(swapAddress)`;
   - maker *cancellation* — `packages/app/src/swap.ts` `cancelSwap`;
   - pending-swap *reconciliation* — `swap.ts` `syncSwaps`;
   - taker *completion* — `SwapLoad.tsx` (reuses the maker scriptSig verbatim and
     would need to append the `OP_1` SWAP selector + recognise the covenant
     UTXO).
   Until then `SWAP_RESERVE_INTO_REFUND_COVENANT = false` in `Swap.tsx`, so the
   wallet publishes a plain **v2** advert (no `expiry_height`) and never claims
   an on-chain expiry it cannot enforce. The covenant + v3 format are fully
   implemented and regtest-proven; flipping the flag is the remaining work.
2. **Cross-repo v3 parsers (CONSENSUS-relevant for the index, not the chain).**
   Radiant Core `swapindex` (C++) and RXinDexer must parse RSWP **v3** (accept
   the new `expiry_height` field, expose/filter on it) before makers broadcast
   v3 adverts — otherwise those consumers drop or misparse v3 offers (§4). The
   wire layout to implement is in §4 "Implemented RSWP v3 wire layout".
3. **FT/NFT refund regtest.** Only the RXD covenant is proven on-chain. The
   builder is asset-type-generic and unit-tested for FT/NFT, but an on-chain
   FT/NFT refund (preserving token conservation through the covenant) should be
   added when the reservation path is wired.
4. **No atomic upper-bound expiry.** CLTV cannot invalidate the SWAP branch
   after expiry; unfillability past `expiry_height` is enforced cooperatively
   (wallet refuses + index hides). A truly atomic expiry needs a Radiant
   tx-locktime-introspection opcode (§2 Option 1). Documented, not a regression.
