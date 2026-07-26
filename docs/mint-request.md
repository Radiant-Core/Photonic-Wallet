# Connect: minting an NFT (`mint-request`)

Status: **Shipped — v1 scope.** NFTs only (no fungible/dMint/container mints,
no author/container references, no royalty/policy/encryption/timelock
options). Immutable Glyph NFTs only.

This extends `photonic-connect` (`packages/app/src/connect/protocol.ts`) with
a third request type, alongside `sign-request` and `psbt-sign-request`
(`docs/psbt.md`), so a dApp — e.g. a game minting item NFTs to a player's
wallet — can ask Photonic to mint on the user's behalf.

## 1. Why this isn't a PSBT request

Radiant NFT minting is a **commit + reveal** pair of transactions where the
reveal input spends a custom covenant script (`OP_HASH256` hash-lock + ref
opcodes), not a plain P2PKH output. Photonic's PSBT signer (`@lib/psbt`) only
recognizes plain P2PKH inputs — by design, matching why Radiant Core itself
doesn't use its own PSBT machinery to mint either (`rpcglyph.cpp` signs
directly with wallet keys; see the design note in this repo's history). So
minting gets its own request type built on `@lib/mint`'s existing
`mintToken`, not on the PSBT signer.

## 2. Funding model: the wallet self-funds

The dApp does **not** specify which UTXOs to spend. Photonic funds the mint
from its own RXD balance using the same coin selection (`fundTx`,
`packages/lib/src/coinSelect.ts`) the local Mint page already uses — the
dApp only supplies *what* to mint, never *which coins*. This sidesteps the
UTXO-discovery problem entirely (the dApp would otherwise need to query a
public ElectrumX server for the user's UTXOs, as it would for a
`psbt-sign-request`).

## 3. Request / result shape

```ts
type MintRequest = {
  protocol: "photonic-connect"; v: 1; t: "mint-request";
  name: string;
  description?: string;
  license?: string;
  attrs?: Record<string, string | number | boolean>;
  main: { mime: string; data: string }   // embedded, base64/base64url
      | { mime: string; url: string };   // remote pointer
  feeRate?: number;                      // photons/byte override
  id?: string; origin?: string; app?: string; callback?: string;
};

type MintResult = {
  protocol: "photonic-connect"; v: 1; t: "mint-result";
  id?: string;
  commitTxid: string;
  revealTxid: string;
  ref: string;   // canonical NFT ref (BE txid ‖ BE vout hex) — use this to look the token up later
};
```

Minting **always broadcasts** — unlike `psbt-sign-request`, there is no
"return unsigned" option, matching the local Mint page's own behavior. The
approval screen is the only checkpoint; once approved, both transactions are
signed and sent immediately.

## 4. Content validation

`main` content is validated more strictly than the local Mint page's own
uploader, because it's dApp/attacker-controlled input, not the user's own
file picker:

- **MIME allow-list** (`MINT_ALLOWED_MIME_TYPES`): `image/png`, `image/jpeg`,
  `image/gif`, `image/webp`, `image/svg+xml`, `text/plain`,
  `application/json`. Anything else is rejected at the protocol layer.
- **Size**: embedded content is capped at the same 512 KB on-chain limit the
  local Mint page enforces (`mintEmbedMaxBytes`,
  `packages/app/src/config.json`) — checked twice: a coarse base64
  char-length pre-check in `protocol.ts` (`MAX_MINT_DATA_LEN`), then the
  exact decoded byte length in `mintFlow.ts`.
- **SVG**: sanitized through the existing DOMPurify pipeline
  (`packages/app/src/svgSanitize.ts`) before being embedded on-chain — same
  treatment the local Mint page gives user-uploaded SVGs.
- **Attrs**: capped to 32 keys, each ≤64 chars, and passed through
  `@lib/token`'s `filterAttrs` (string/number/boolean values only, <100
  chars) — anything else is silently dropped, never rejected outright.
- **Remote (`url`) content**: only the pointer is embedded on-chain, not the
  bytes; still must be an absolute http(s) URL.

## 5. Flow

1. Deep link: `#/connect?req=<base64url envelope>` (same route as the other
   two request types; `Connect.tsx` dispatches on `t`).
2. `MintRequestPanel` shows a content preview (rendered `<img>` for image
   MIME types, a file-type label otherwise), name/description/license/attrs,
   requesting origin, and a warning that approval broadcasts immediately.
3. On approve: `mintFlow.ts`'s `mintFromRequest` —
   - builds the Glyph v2 payload (`buildMintPayload`: decode, size-check,
     sanitize),
   - fetches the wallet's own RXD UTXOs (`db.txo`, `ContractType.RXD`,
     unspent),
   - calls `mintToken("nft", {method:"direct", ...}, wif, coins, payload, [], feeRate)`,
   - broadcasts the commit tx, then the reveal tx (with the same
     "missing inputs → resync → retry once" resilience the local Mint page
     uses for the same race condition),
   - triggers `manualSync()` so the new NFT shows up in the wallet's own UI
     promptly.
4. Result returns to the dApp the same way as the other request types: QR /
   copy by default, or automatically via the origin-bound `callback`
   fragment (`buildMintCallbackUrl`) when the request arrived via deep link:
   ```
   <callback>#id=<id>&commitTxid=<..>&revealTxid=<..>&ref=<..>
   ```

## 6. Out of scope for v1

- Fungible tokens, dMint, containers, authority/soulbound covenants.
- Author/container references (`in`/`by`) — these require the user to already
  own and co-spend a specific existing glyph, which the dApp has no way to
  discover without its own UTXO/indexer query; left for a future iteration.
- Royalty/policy metadata, encryption, timelock.
- Mutable NFTs.

## 7. Minimal dApp example

```ts
const req = {
  protocol: "photonic-connect", v: 1, t: "mint-request",
  name: "Realm Sword",
  description: "A legendary blade forged in the Realm",
  attrs: { rarity: "legendary", power: 42 },
  main: { mime: "image/png", data: base64PngBytes },
  origin: "https://realm.rxd",
  callback: "https://realm.rxd/mint-callback",
};
location.href = `https://wallet.example/#/connect?req=${encodeReqParam(req)}`;
// On return: https://realm.rxd/mint-callback#id=...&commitTxid=...&revealTxid=...&ref=...
```
