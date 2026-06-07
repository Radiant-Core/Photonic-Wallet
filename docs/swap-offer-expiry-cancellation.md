# Swap-offer expiry & cancellation

Status: **Phase 1 shipped (this PR). Phase 2 = follow-up protocol change.**

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

## 5. Testing

- **Phase 1 (this PR):** unit tests for the soft-expiry math
  (`packages/app/src/__tests__/swapExpiry.test.ts`) — age, staleness boundary,
  custom window, undateable offers, age labels. The on-chain swap protocol is
  unchanged, so the existing swap **regtest matrix**
  (`packages/lib/src/__tests__/swap-load-flow.regtest.test.ts`,
  `wave-swap-regtest.test.ts`, `swap-load-output-order.test.ts`) continues to
  cover the load/complete path unchanged.
- **Phase 2:** add regtest matrix cases for: (a) refund branch rejected before
  `expiry_height`; (b) refund branch accepted at/after `expiry_height`; (c) swap
  branch still completes before expiry; (d) v3 advertisement round-trips through
  the index and the wallet refuses to complete a past-expiry offer.

## 6. Files touched (Phase 1)

- `packages/app/src/swapExpiry.ts` — soft-expiry helpers + policy constants (new).
- `packages/app/src/__tests__/swapExpiry.test.ts` — unit tests (new).
- `packages/app/src/pages/Swap.tsx` — maker risk warning; success-screen cancel
  guidance; replaced the `TODO(security)` block with a pointer here.
- `packages/app/src/pages/OpenOrders.tsx` — chain-tip fetch, hide/flag/warn on
  stale offers, "Show expired" toggle.
- `packages/app/src/pages/SwapPending.tsx` — risk banner above pending offers.
- `SECURITY.md` — known-limitation entry for swap-offer liveness.
