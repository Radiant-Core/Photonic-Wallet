# Connect: listing, buying, and cancelling NFTs
# (`swap-offer-request` / `swap-accept-request` / `swap-cancel-request`)

Status: **Shipped — v1 scope.** NFT-for-RXD only, private mode only (no
on-chain advertisement). Built for a marketplace dApp that runs its own
listing index (e.g. realm.rxd) and only needs the wallet to produce/consume
signed offers.

Extends `photonic-connect` with three request types wrapping the wallet's
existing private-swap primitive (`packages/app/src/pages/Swap.tsx` /
`SwapLoad.tsx`): one for the maker (list an item), one for the taker
(complete a purchase), one for the maker again (cancel a listing).

## 1. This is not `@lib/psbt`'s PSBT

The `psrt` field in the offer/accept request types is **raw
partially-signed transaction hex** — the pre-existing "Partially Signed
Radiant Transaction" convention the Swap page already uses (a maker signs a
single input with `SIGHASH_SINGLE|ANYONECANPAY|FORKID` via `@lib/transfer`'s
`partiallySigned`, committing to a single output). It has nothing to do with
the BIP-174 container `docs/psbt.md` describes — different wire format,
different module, don't cross the streams.

This codebase has a third look-alike too: `DeployMethod: "psbt"` /
`revealPsbt()` (`packages/lib/src/mint.ts`, `packages/lib/src/types.ts`), a
bundle/presale NFT-reveal helper that uses the *exact same* raw-tx-hex,
`SIGHASH_SINGLE|ANYONECANPAY` technique as PSRT — just for a mint reveal
instead of a swap. Three names (PSRT, `"psbt"` DeployMethod, and the real
BIP-174 module), no shared code between them — see the naming note at the
top of `docs/psbt.md` for the full rundown before assuming any two of them
mean the same thing.

## 2. Maker: `swap-offer-request`

```ts
type SwapOfferRequest = {
  protocol: "photonic-connect"; v: 1; t: "swap-offer-request";
  ref: string;         // the NFT's canonical ref (BE txid ‖ BE vout hex), owned by this wallet
  priceRxd: number;    // asking price in RXD
  mode: "private";     // the only supported value — "broadcast" is rejected
  id?: string; origin?: string; app?: string; callback?: string;
};

type SwapOfferResult = {
  protocol: "photonic-connect"; v: 1; t: "swap-offer-result";
  id?: string;
  psrt: string;            // raw tx hex — hand this to your own indexer
  reserveTxid: string;     // the swap-subaccount outpoint the PSRT's input spends
  reserveVout: number;
  swapAddress: string;     // the swap subaccount address the NFT was reserved into
  ref: string;             // echoes the request's ref
  payoutAddress: string;   // the maker's own main address — sale proceeds and reclaims land here
  priceRxd: number;        // echoes the request's priceRxd — the reservation's actual signed price
};
```

**Approving this broadcasts a real transaction.** `mode: "private"` only
means no on-chain *advertisement* gets published (unlike the Swap page's
broadcast mode, which additionally publishes an RSWP advertisement to a
public swap index) — it does not mean nothing moves. The wallet still:

1. Looks up `ref` in its own `db.glyph` — the token must exist, be an NFT
   (v1 scope excludes fungible tokens), and not already have a pending swap.
2. Moves it into the swap subaccount via `@lib/transfer`'s
   `transferNonFungible` (a real broadcast, `nft_swap_prepare` in the
   wallet's activity log).
3. Builds and signs the PSRT (`partiallySigned`, swap-subaccount key) over
   that reserved output, committing to a single RXD output back to the
   maker's own address for `priceRxd`.
4. Persists a `PENDING` row to `db.swap` with the real negotiated price —
   the same record the local Swap page writes for a hand-made offer. Without
   this the offer would be invisible in the wallet's own "Pending Swaps" list
   until the next on-chain discovery sweep, and even then would show up as a
   degraded stub that lost the price.
5. Returns the PSRT plus the **reservation outpoint** (`reserveTxid`/
   `reserveVout`) — realm.rxd indexes all of it in its own `POST
   /market/listings/prepare`-fed backend; Photonic never publishes anywhere.

**Why the reservation outpoint matters**: the PSRT itself is opaque raw tx
hex — realm.rxd never parses it. `reserveTxid`/`reserveVout` is a direct
on-chain handle to the offer with no parsing needed: check whether that
specific outpoint is still unspent (the same `isUtxoUnspent` check
`swap-accept-request` itself performs before completing a purchase) to know
whether the offer is still live. Unspent = live; spent = completed or
cancelled — see §4's stale-listing reconciliation guidance.

**Why `payoutAddress` and `priceRxd` are echoed back**: realm.rxd binds a
listing's seller to whatever address the player was logged in with at
listing time, which is a session concept, not an on-chain one. `payoutAddress`
is the maker's actual signing address — sale proceeds and reclaims are
provably tied to it (compare it against `get_by_ref`'s post-reclaim resolved
address in §4), independent of which session created the listing.
`priceRxd` is just the request's own field echoed back, so a caller can
assert the reservation matches the price it's about to advertise without
writing a PSRT parser.

**No on-chain expiry field is included** — the RSWP v3 timelocked-refund
covenant that would give a reservation an automatic reclaim time exists in
`@lib/swapRefundCovenant` but reserving into it is gated off wallet-wide
(`SWAP_RESERVE_INTO_REFUND_COVENANT` in `Swap.tsx`, `docs/swap-offer-expiry-cancellation.md`).
Until that ships, realm.rxd's own soft listing TTL is the only expiry there is.

## 3. Cancel: `swap-cancel-request`

```ts
type SwapCancelRequest = {
  protocol: "photonic-connect"; v: 1; t: "swap-cancel-request";
  ref: string;    // the same ref the original swap-offer-request carried
  id?: string; origin?: string; app?: string; callback?: string;
};

type SwapCancelResult = {
  protocol: "photonic-connect"; v: 1; t: "swap-cancel-result";
  id?: string;
  txid: string;   // the reclaim transaction's txid
};
```

Keyed by **`ref`, not an outpoint** — the wallet already tracks one pending
swap per glyph (`swapPending` on the `db.glyph` row, `fromGlyph` on the
`db.swap` row), so the ref alone identifies which offer to cancel. realm.rxd
already has the ref on every listing; no need to track or pass a reservation
outpoint just to cancel.

Approving looks the offer up in `db.swap` (must be `PENDING`), then calls the
exact same `cancelSwap()` the local Swap page's own "Cancel" button uses —
self-spends the reserved UTXO back to the wallet's main address, flips the
token's `swapPending` flag off, and marks the `db.swap` row `CANCEL`. This
**always broadcasts** on approval, same as accept — there is no
"return unsigned" option.

Rejecting a cancel request returns `#id=...&rejected=true` via the generic
reject-callback mechanism every request type shares (`buildRejectCallbackUrl`).

## 4. How realm.rxd detects a cancellation (or sale) made outside itself

Two ways, in order of preference:

1. **Check the reservation outpoint directly** (needs `reserveTxid`/
   `reserveVout` from the offer result, §2): query whether that specific
   `txid:vout` is still unspent — unambiguous, no lag, and by inspecting the
   spending transaction's outputs you can tell a reclaim (pays back to the
   maker's own address) from a completed sale (pays the maker's price to
   output 0 per `buildSwapCompletionOutputs`, asset to the buyer at output 1).
2. **Fall back to `get_by_ref`** if you don't have the outpoint on hand for
   an older listing: for an active listing the NFT sits at the swap
   subaccount; after a reclaim it's back at the seller's own address (which
   realm.rxd already stores as the listing's seller address), and after a
   sale it resolves to the buyer. **Caveat**: right after a listing is
   created there can be brief indexer lag before the reservation transaction
   itself is indexed, during which the NFT can still transiently resolve to
   the seller's main address — don't treat a freshly-created listing as
   voided without a short grace window.

Either way, run this reconciliation lazily on market reads and — most
importantly — **inside `preparePurchase`, before handing a buyer a PSRT**,
so a buyer never attempts to complete an offer the seller already reclaimed.
Detected-void listings should be marked cancelled/expired automatically.

## 5. Taker: `swap-accept-request`

```ts
type SwapAcceptRequest = {
  protocol: "photonic-connect"; v: 1; t: "swap-accept-request";
  psrt: string;          // the maker's PSRT, raw tx hex
  feeRxd?: number;       // marketplace fee amount; requires feeAddress
  feeAddress?: string;   // marketplace fee recipient; requires feeRxd
  id?: string; origin?: string; app?: string; callback?: string;
};

type SwapAcceptResult = {
  protocol: "photonic-connect"; v: 1; t: "swap-accept-result";
  id?: string;
  txid: string;
};
```

`feeRxd`/`feeAddress` are realm.rxd's own platform commission (the "fee X RXD
(2.5%)" shown next to each listing) — distinct from any creator royalty the
token itself carries. Both fields must be present together or both absent;
one without the other is rejected as a caller mistake, not silently dropped.
`feeAddress` must be an actual Radiant address — a config placeholder that
never got resolved to a real value (e.g. a literal `"MY_ENV_VAR_NAME"`
string) fails validation with "feeAddress is not a valid address" before
anything is built.

Completing a purchase (`mintFromRequest`'s sibling, `acceptSwapOffer` in
`packages/app/src/connect/swapFlow.ts`) mirrors `SwapLoad.tsx`'s
`ViewSwap.signTransaction` exactly:

1. Parses the PSRT, re-fetches its reserved prevout from Electrum, and
   confirms it's still unspent (`isUtxoUnspent`) — a stale/already-filled
   offer is rejected before anything is built.
2. Resolves the offered token's metadata and checks for enforced creator
   royalty (`getTokenRoyalty` / `@lib/royaltyTerms`) — best-effort, same
   caveat as the local Swap page: a PSRT-based swap can't make royalty
   *unstrippable* (that needs the separate royalty covenant listing flow);
   this only adds the payout when the maker's own token metadata says it's
   enforced.
3. Assembles outputs via `@lib/swapOutputs`'s `buildSwapCompletionOutputs`:
   `[makerPayment(0), assetToTaker(1), ...royalty, ...platformFee, ...funding]`.
   The **platform fee** (`feeRxd`/`feeAddress`) got its own slot in that
   function (`platformFeeOutputs`) alongside — but distinct from — creator
   royalty, since they're different concepts that happen to share a
   position (index 2+, after the asset, never displacing the maker's
   `SIGHASH_SINGLE`-committed output[0]).
4. Funds, signs (reusing the maker's scriptSig verbatim at input 0), and
   broadcasts via `broadcastSwapCompletion`.

This **always broadcasts** on approval — there is no "return unsigned"
option, matching `mint-request`'s behavior. The approval screen shows the
price and fee terms parsed directly from the PSRT (no network round-trip
needed for that part); full validation happens at approve-time and any
failure (stale offer, insufficient funds, disallowed token type) surfaces as
a toast rather than blocking the initial preview.

## 6. Wallet-side failures: the error callback

Every request type in this document — offer, accept, cancel — shares one
more generic callback beyond success (`buildXCallbackUrl`) and explicit
reject (`buildRejectCallbackUrl`): an **error callback**
(`buildErrorCallbackUrl` in `packages/app/src/connect/protocol.ts`), fired
from the same `try/catch` in `Connect.tsx` that today only shows an in-app
toast ("Unable to list", "Unable to complete purchase", "Unable to cancel").

Without it, a genuine wallet-side failure — the NFT isn't in the wallet,
insufficient funds, the wallet is locked, or (on accept) the offer was
already completed or cancelled — left a deep-linked caller with no signal at
all: not a success, not a decline, just silence until its own timeout. A
human watching the screen sees the toast; a dApp waiting on the callback
does not.

```ts
type ConnectErrorCode =
  | "locked" | "not_found" | "insufficient_funds"
  | "already_spent" | "invalid_request" | "unknown";
```

Fired as `#id=...&error=<code>&message=<text>` (fragment only, same as every
other result). `code` is a best-effort classification
(`classifyConnectError`) matched against the underlying error's message —
treat it as a coarse hint for fast branching, and always show `message` too
since the classifier can fall back to `"unknown"` for a message it doesn't
recognize. This fires for the wallet-locked case on every handler (`sign`,
`psbt-sign`, `mint`, `swap-offer`, `swap-accept`, `swap-cancel`) and from
each handler's catch block — it is not specific to the swap flows, just
documented here because the swap flows are where "offer already spent" and
"not found" concretely show up.

## 7. Out of scope for v1

- `mode: "broadcast"` (on-chain advertisement) — rejected outright with a
  message pointing at the local Swap page.
- Fungible-token or RXD-for-token offers — only NFT-for-RXD.
- Token-for-token swaps, container/link tokens.
- The RSWP v3 timelocked-refund covenant reservation path
  (`SWAP_RESERVE_INTO_REFUND_COVENANT`, still gated off in the local Swap
  page too) — no on-chain expiry field exists in `swap-offer-result` yet.

## 8. Minimal dApp example

```ts
// Maker: list an owned NFT privately.
const offerReq = {
  protocol: "photonic-connect", v: 1, t: "swap-offer-request",
  ref: itemRef, priceRxd: 10, mode: "private",
  origin: "https://realm.rxd", callback: "https://realm.rxd/list-callback",
};
location.href = `https://wallet.example/#/connect?req=${encodeReqParam(offerReq)}`;
// On success: https://realm.rxd/list-callback#psrt=...&reserveTxid=...&reserveVout=0
//             &swapAddress=...&ref=...&payoutAddress=...&priceRxd=10
// realm.rxd stores all of this in its own listings index.
// On a wallet-side failure instead: https://realm.rxd/list-callback#error=insufficient_funds&message=...

// Taker: buy a listed NFT, adding a 2.5% platform fee.
const acceptReq = {
  protocol: "photonic-connect", v: 1, t: "swap-accept-request",
  psrt: listingPsrt, feeRxd: 0.25, feeAddress: "1PlatformFeeAddress...",
  origin: "https://realm.rxd", callback: "https://realm.rxd/buy-callback",
};
location.href = `https://wallet.example/#/connect?req=${encodeReqParam(acceptReq)}`;
// On success: https://realm.rxd/buy-callback#txid=...
// If the offer was already bought or reclaimed:
//   https://realm.rxd/buy-callback#error=already_spent&message=...

// Maker: cancel a listing, keyed by ref.
const cancelReq = {
  protocol: "photonic-connect", v: 1, t: "swap-cancel-request",
  ref: itemRef,
  origin: "https://realm.rxd", callback: "https://realm.rxd/cancel-callback",
};
location.href = `https://wallet.example/#/connect?req=${encodeReqParam(cancelReq)}`;
// On success: https://realm.rxd/cancel-callback#txid=...
// Reject instead: https://realm.rxd/cancel-callback#rejected=true
// If there's no such pending offer: https://realm.rxd/cancel-callback#error=not_found&message=...
```
