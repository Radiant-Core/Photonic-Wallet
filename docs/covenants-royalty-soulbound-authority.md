# Glyph covenants: royalty, soulbound, authority — design & enforcement status

_Status date: 2026-06-05. Implements the remediation for the red-team finding
that the wallet's "enforced royalty", "soulbound", and "authority-gated" features
were **dead code** — surfaced in the UI as on-chain guarantees but never wired
and, where present, unsound._

All three covenants below are **executed against the real Radiant v3.0.0 script
interpreter** on regtest (not byte-asserts). The proofs live in
`packages/lib/src/__tests__/*.regtest.test.ts` and run with:

```
REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
  src/__tests__/<name>.regtest.test.ts --testTimeout=600000
```

against a local node: `Radiant-Core/build/src/radiantd -regtest` (RPC
`127.0.0.1:17443`, user `radiantrpc`).

> Running several regtest files at once: add `--no-file-parallelism`. The harness
> uses `scantxoutset`, which is single-threaded on the node, so parallel files
> collide ("scan already in progress"). Sequentially they all pass.

---

## 0. What was wrong (audit, all confirmed against source)

| Feature | Symptom |
| --- | --- |
| Royalty | `nftRoyaltyScript` had **zero callers**; every NFT minted plain P2PKH `nftScript` → reseller paid 0 royalty. The unused script also derived "sale price" from a **buyer-controlled** output (`OP_OUTPUTVALUE` of output[1]) → buyer sets it to 1 photon, pays 0. |
| Soulbound | `soulboundNftScript` was `OP_PUSHINPUTREFSINGLETON <ref> OP_DROP` + plain P2PKH — owner could send to **anyone**. Zero callers. Off-chain check was a hex-substring test, never invoked. |
| Authority | `verifyAuthorityChain` did `authorityTokens.find(() => true)` (explicit TODO) → **any** token presenting **any** authority-looking token passed. `authorityGatedNftScript` had zero callers. |

UI claimed "enforced by smart contract" / "Soulbound — cannot be transferred" /
"Enforced Royalty" for all of the above.

---

## 1. Royalty — unstrippable **listing/sale covenant** (seller-committed fixed amounts)

**Module:** `packages/lib/src/royaltyCovenant.ts`
**Proof:** `royaltyCovenant.regtest.test.ts` ✅

### Design

Chosen model (vs an always-on inductive covenant): the NFT **rests in the
ordinary `nftScript`** (wallet discovery unchanged). To **sell**, the owner moves
it into `royaltySaleScript(...)`, which carries the same singleton ref forward
and bakes in the sale terms as **constants**:

```
d8 <ref> 75            OP_PUSHINPUTREFSINGLETON ref ; OP_DROP   (holds the NFT singleton)
63                     OP_IF        ── cancel path (seller reclaims)
   76 a914 <pkh> 88 ac   standard P2PKH(seller)
67                     OP_ELSE      ── buy path (anyone, if they pay)
   00 cd <sellerScript> 88   output[0].scriptPubKey == seller payout script
   00 cc <P>  a2 69          output[0].value >= P            (seller-committed price)
   52 cd <royScript> 88      output[2].scriptPubKey == royalty recipient
   52 cc <R>  a2 69          output[2].value >= R            (seller-committed royalty)
   51                        OP_1   (multiple royalty recipients extend to output[3], [4], …)
68                     OP_ENDIF
```

- **(a) carries the NFT singleton ref forward** — `OP_PUSHINPUTREFSINGLETON
  <ref>`; consensus ref-conservation forces the ref into an output on every spend
  (the same mechanism `nftScript` relies on).
- **(b) binds the price to a *seller* commitment** — `P`, `R`, the seller payout
  script and the royalty recipient script are **literals compiled into the
  scriptPubKey by the seller at list time**. The buyer spends *that exact UTXO*;
  they cannot change them. (Contrast the audited bug, which read the price from a
  buyer-chosen output.)
- **(c) forces the royalty output(s)** — `OP_OUTPUTBYTECODE`/`OP_OUTPUTVALUE`
  equality + `>=` checks at fixed indices.

`R = floor(P*bps/10000)` (clamped by min/max) is computed **off-chain** by the
wallet at list time. **There is no arithmetic in the script**, so the known rxdc
`OP_2MUL`/`OP_2DIV` (×2/÷2) MUL/DIV miscompile cannot apply here. (Verified: the
emitted bytes are equality/`>=` only — `87/88/a2/cc/cd`, no `95/96/8d/8e`.)

Output layout matches the in-flight SwapLoad maker-payment-at-output[0] fix:
`[ sellerPayout(0), nftToBuyer(1), royalties(2..), buyer change ]`.

### What the regtest proves (executed, not asserted)

- LIST: NFT moves `nftScript → royaltySaleScript`, confirms.
- **STRIP** (royalty redirected to buyer) → REJECTED (`OP_EQUALVERIFY`).
- **LOW-ROYALTY** (underpay recipient) → REJECTED (`OP_VERIFY`).
- **SELLER-UNDERPAY** (pay seller < P) → REJECTED (`OP_VERIFY`).
- **VALID buy** → ACCEPTED; buyer owns NFT; creator received royalty.
- **CANCEL** (seller key, IF branch) → ACCEPTED; NFT reclaimed.

Tx builders (`buildRoyaltyListingTx` / `buildRoyaltyPurchaseTx` /
`buildRoyaltyCancelTx`) are the single code path shared by the wallet and the
proof.

### Honest limitation

This makes royalty unstrippable **by the buyer** for any listing, and a compliant
wallet always lists honouring the creator's recorded terms. It does **not** stop
a malicious *seller* (using non-wallet software) from crafting a non-compliant
listing (R=0, or royalty paid to self), nor a holder gifting the NFT out-of-band
with no sale. Closing those requires inducting the creator's terms into the NFT
itself (an always-on / hybrid covenant) — deliberately out of scope for the
listing model chosen here.

---

## 2. Soulbound — non-transferable covenant (induction + burn)

**Module:** `packages/lib/src/soulbound.ts` (`soulboundNftScript`)
**Proof:** `soulbound.regtest.test.ts` ✅

```
d8 <ref> 75                       OP_PUSHINPUTREFSINGLETON ref ; OP_DROP
63                                OP_IF      ── MOVE (selector OP_1)
   76 a914 <pkh> 88 ad              owner P2PKH (CHECKSIGVERIFY)
   00 ea c0 e9 87                   output[0] codescript == this input codescript (induction)
67                                OP_ELSE    ── BURN (selector OP_0)
   76 a914 <pkh> 88 ad              owner P2PKH (CHECKSIGVERIFY)
   <ref> de 00 9c                   OP_REFOUTPUTCOUNT_OUTPUTS(ref) == 0  (singleton destroyed)
68                                OP_ENDIF
```

The owner must sign on **both** paths. The MOVE path uses
`OP_CODESCRIPTBYTECODE_OUTPUT(0) == OP_CODESCRIPTBYTECODE_UTXO(inputIndex)`
(the same induction primitive the proven mutable-NFT covenant uses; with no state
separator `OP_CODESCRIPTBYTECODE` returns the whole script). Because the owner
pkh and ref are baked into that code, the NFT can only ever re-lock to the **same
soulbound script for the same owner** — never to a different recipient, never to a
plain transferable `nftScript`.

### What the regtest proves

- Lock NFT into the soulbound covenant.
- **Transfer to a different recipient** → REJECTED (induction `OP_EQUAL` false).
- **Escape to a plain `nftScript(owner)`** → REJECTED.
- **Self-move** (re-lock to same script) → ACCEPTED.
- **Burn** (selector OP_0, ref in 0 outputs) → ACCEPTED (node permits singleton burn).

---

## 3. Authority — issuer-ref equality + creation-time gated mint

**Module:** `packages/lib/src/authority.ts`
**Proofs:** `authority.test.ts` (off-chain, 7 tests) ✅ + `authority.regtest.test.ts` (on-chain) ✅

### 3a. Off-chain `verifyAuthorityChain` (the explicit TODO)

Replaced `authorityTokens.find(() => true)` with a real ref match: the token's
claimed issuer ref(s) (`by`) must equal a candidate authority token's `ref`.
Compared in **both byte orientations** (LE script form / BE display form) because
this codebase passes refs in both conventions. Signature is now
`verifyAuthorityChain(tokenMetadata, AuthorityCandidate[])` where
`AuthorityCandidate = { ref, metadata }`. Forged/unrelated authority → rejected;
no `by` → rejected; matched-but-expired → rejected.

### 3b. On-chain `authorityGatedNftScript` (mint-gating)

```
d1 <authorityRef> 75   OP_REQUIREINPUTREF authorityRef ; OP_DROP
d8 <ref> 75            OP_PUSHINPUTREFSINGLETON ref ; OP_DROP
76 a914 <pkh> 88 ac    P2PKH(owner)
```

`OP_REQUIREINPUTREF` is a **creation-time** rule:
`validateTransactionReferenceOperations` (Radiant-Core `validation.h`) requires
every require-ref found in a tx's **output** scripts to be present among that tx's
**input** refs. So an authority-gated item can only be *minted/created* by a tx
that holds the genuine authority token as an input — a counterfeiter without it
cannot produce one.

### What the regtest proves

- Mint a gated item **without** the authority token → REJECTED
  (`...invalid-transaction-reference-operations`).
- Mint with a **forged** authority (unrelated token, wrong ref) → REJECTED.
- Mint with the **genuine** authority token co-spent → ACCEPTED.

---

## 4. Enforced vs advisory vs wired — current truth

| Capability | On-chain enforced? | Wired in lib? | Wired in React app? |
| --- | --- | --- | --- |
| Royalty listing covenant | ✅ proven on regtest | ✅ `royaltyCovenant.ts` (list/buy/cancel builders, exported) | ✅ "List with enforced royalty" (`RoyaltyListModal`) + Marketplace "Buy a listing" / Cancel (`pages/Market.tsx`) |
| Soulbound covenant | ✅ proven on regtest | ✅ `soulbound.ts` | ✅ mint-path emission (`mint.ts` `RevealCovenant`, threaded from `Mint.tsx` policy.transferable=false) + local covenant tracking |
| Authority-gated mint | ✅ proven on regtest | ✅ `authority.ts` | ✅ mint-path emission + authority-token selector in `Mint.tsx` (co-spends the authority UTXO) + local covenant tracking |
| `verifyAuthorityChain` issuer-ref | ✅ (off-chain logic) | ✅ + 7 unit tests | n/a |
| PSRT swap royalty splice (SwapLoad) | ❌ **advisory** (taker can omit) | n/a | present, now honestly commented |

UI labels were reworded to match this reality (no more "enforced by smart
contract" / "cannot be transferred" absolutes):
`RoyaltyConfig.tsx`, `PolicyConfig.tsx`, `V2MetadataBadges.tsx`.

---

## 5. App-side integration (shipped 2026-06-05)

The three follow-ups below are now wired into `packages/app` and verified against
the running React app (testnet wallet connected to the local regtest RXinDexer)
plus on-chain regtest proofs of every transaction the app builds.

### 5.1 Wallet discovery for covenant scriptPubKeys — local tracking

NFT discovery subscribes to `nftScriptHash(address)` (the plain zero-ref
template; RXinDexer indexes those by owner). A token resting in a covenant rests
in a scriptPubKey with the singleton ref baked in — a unique scripthash the
by-owner subscription never sees. Rather than wait on indexer changes, the wallet
tracks covenant UTXOs **locally**, exactly the way PSRT swaps are tracked in
`db.swap`:

- New `db.covenant` table (schema v16) + `CovenantRecord` (`covenant` / soulbound
  / authority-gated, with the listing terms for royalty listings).
- `packages/app/src/covenant.ts`: `recordCovenant` (called by the list / soulbound
  mint / authority mint flows) and `syncCovenants` (reconciles each ACTIVE
  covenant against `blockchain.scripthash.listunspent` via a new worker method
  `getUtxosByScriptHash`; marks RESOLVED once its UTXO is spent/bought/cancelled).
- Royalty/policy are persisted onto the glyph record (`SmartToken.royalty` /
  `.policy`) from the reveal payload so listing terms and badges are recoverable.

Covenant tokens are managed from the **Marketplace** page (My Listings; a
"Covenant tokens" section lists soulbound/authority-gated holdings).

> **Indexer follow-up (full cross-device coverage):** local tracking covers
> tokens this wallet listed/minted. Discovering covenant tokens received by, or
> restored to, *another* wallet still requires RXinDexer to recognise the
> covenant patterns (`isRoyaltySaleScript` / `isSoulboundScript` /
> `authorityGatedNftScript`) and index them by owner. Tracked separately; the
> wallet behaviour above is complete and self-contained without it.

### 5.2 Royalty marketplace UI

- **List with enforced royalty** (`components/RoyaltyListModal.tsx`, opened from
  the NFT detail page): builds terms with `royaltyTermsFromMetadata` from the
  NFT's recorded royalty and moves the NFT into `royaltySaleScript` via
  `buildRoyaltyListingTx`. Produces a shareable listing **descriptor** (base64
  JSON) — the covenant needs no maker signature, so this is distinct from the
  PSRT swap flow.
- **Buy a listing** + **Cancel** (`pages/Market.tsx`): `buildRoyaltyPurchaseTx`
  from a pasted descriptor; `buildRoyaltyCancelTx` to reclaim. Enforced-royalty
  badges/labels (`V2MetadataBadges`, `RoyaltyConfig`) now read as enforced.

### 5.3 Soulbound / authority mint emission

`mint.ts` `createRevealOutputs` / `mintToken` take an optional `RevealCovenant`:
`policy.transferable === false` → `soulboundNftScript(owner, ref)`; an authority
selection → `authorityGatedNftScript` with the authority token co-spent as an
input and re-created as an output. Threaded from `Mint.tsx` (policy toggle +
authority selector; immutable NFTs only). Minted covenant tokens are recorded via
§5.1 so they stay visible. Proven on-chain in
`mintCovenant.regtest.test.ts` (direct soulbound + authority mint emission).
