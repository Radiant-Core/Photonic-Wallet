# Radiant PSBT support

Status: **Shipped — v1 scope.** Signing is limited to plain P2PKH inputs the
wallet's main address owns; token-bearing (FT/NFT/vault) inputs are always
refused. See §6 for what's explicitly out of scope.

This document specifies the wire format Photonic Wallet's PSBT module
(`packages/lib/src/psbt/`) implements, and the `psbt-sign-request` extension
to the `photonic-connect` deep-link protocol
(`packages/app/src/connect/protocol.ts`) that lets a dApp hand the wallet a
PSBT to sign the same way it already requests a message signature.

> **Don't confuse this with PSRT or the `"psbt"` `DeployMethod`.** This
> codebase has three differently-shaped things with confusingly similar
> names:
>
> 1. **This module** — an actual BIP-174-style structured container (magic
>    bytes, key-value maps, explicit per-input prevout data), general-purpose,
>    interoperable with Radiant Core's own PSBT RPCs.
> 2. **PSRT** ("Partially Signed Radiant Transaction", `docs/swap-request.md`)
>    — the pre-existing swap-offer mechanism. Despite the acronym, it is
>    **not** a container format: it's raw network-serialized transaction hex
>    with one input signed `SIGHASH_SINGLE|ANYONECANPAY|FORKID`
>    (`@lib/transfer`'s `partiallySigned`). "PSRT" borrowed PSBT's name, not
>    its format.
> 3. **`DeployMethod: "psbt"` / `revealPsbt()`** (`packages/lib/src/mint.ts`,
>    `packages/lib/src/types.ts`) — a pre-existing bundle/presale NFT-reveal
>    helper. Same raw-tx-hex, `SIGHASH_SINGLE|ANYONECANPAY` technique as
>    PSRT, just applied to a mint reveal instead of a swap. Also not a
>    container format, also unrelated to this module.
>
> None of the three overlap in code (no shared functions or types), but the
> vocabulary collision is real — when you see "PSBT" or "psrt" anywhere in
> this codebase, check which of the three it actually means before assuming
> BIP-174 semantics apply.

## 1. Why not plain BIP-174

Radiant's reference node, Radiant Core, implements PSBT — but not stock
BIP-174. It's the **Bitcoin ABC-lineage, segwit-stripped variant** (forked
from Bitcoin Core ~0.17), and it diverges from mainline Bitcoin PSBT in ways
that matter for wire compatibility. Photonic's module targets that variant
specifically, verified against Radiant Core's `src/psbt.h` / `src/psbt.cpp`
and `src/wallet/psbtwallet.cpp`, so a PSBT built by either wallet is usable
by the other via `walletcreatefundedpsbt` / `walletprocesspsbt` /
`finalizepsbt`.

## 2. Wire format

Container framing follows BIP-174: magic bytes, then a sequence of
key-value maps (global, one per input, one per output), each map terminated
by a zero-length key. Keys are `varint keylen ‖ keytype(varint) ‖ keydata`;
values are `varint vallen ‖ value`. A repeated full key within one map is a
hard parse error. Varints are Bitcoin CompactSize and must be minimally
encoded — a non-canonical encoding (e.g. `0xfd 0x05 0x00` for the value 5)
is rejected, matching Radiant Core's `ReadCompactSize`.

```
magic: 70 73 62 74 ff        ("psbt\xff")
```

| Scope | Key | Name | Value |
| --- | --- | --- | --- |
| Global | `0x00` | `PSBT_GLOBAL_UNSIGNED_TX` | Legacy-serialized unsigned tx, every scriptSig empty |
| Input | `0x00` | `PSBT_IN_UTXO` | **Bare `CTxOut`**: int64-LE value ‖ varint-len scriptPubKey |
| Input | `0x02` | `PSBT_IN_PARTIAL_SIG` | keydata = 33/65-byte pubkey; value = DER sig ‖ sighash byte |
| Input | `0x03` | `PSBT_IN_SIGHASH` | 4-byte LE `uint32` |
| Input | `0x04` | `PSBT_IN_REDEEMSCRIPT` | hex script (parsed & preserved, not consumed by the P2PKH signer) |
| Input | `0x06` | `PSBT_IN_BIP32_DERIVATION` | preserved verbatim |
| Input | `0x07` | `PSBT_IN_FINAL_SCRIPTSIG` | hex scriptSig |
| Output | `0x00` / `0x02` | redeem script / bip32 derivation | preserved verbatim, not interpreted |

Transport is **standard base64** (matching Radiant Core's `EncodeBase64`);
the connect protocol also accepts base64url on parse, for convenience inside
a URL. Unknown key-value pairs anywhere in the container are preserved and
re-emitted byte-identically — required for combiner semantics and forward
compatibility.

### 2.1 The `PSBT_IN_UTXO` divergence

Mainline BIP-174 has two prevout fields: `non_witness_utxo` (0x00, a full
previous transaction) for legacy inputs, and `witness_utxo` (0x01, a bare
`CTxOut`) for segwit inputs. **Radiant has no segwit** — there is no witness
marker, no witness stack, nothing under key `0x01`. Instead, key `0x00`
itself carries a bare `CTxOut`: 8-byte LE value followed by the varint-length
scriptPubKey. This is safe because Radiant's sighash (§2.2) commits to
exactly that output's script and value — attaching a wrong one just produces
a signature that fails to verify, it can't be used to trick the signer into
overpaying or misdirecting funds.

Key types `0x01` (witness_utxo), `0x05` (witness_script), and `0x08`
(final_scriptwitness) don't exist in this profile; a parser must not emit
them, and treats them as unknown data if present (never interpreted).

### 2.2 Sighash

Default and required: `SIGHASH_ALL | SIGHASH_FORKID` (`0x41`). Every
signature Photonic produces sets `SIGHASH_FORKID`; a sighash without it is
refused outright (Radiant Core's `walletprocesspsbt` does the same —
`"Signature must use SIGHASH_FORKID"`). `SIGHASH_NONE` is refused by policy
(it would let outputs be swapped after signing). `SIGHASH_SINGLE` and
`SIGHASH_ANYONECANPAY`, alone or combined with `ALL`/`SINGLE`, are accepted
— the swap-offer PSRT convention (`packages/lib/src/transfer.tsx` →
`partiallySigned`) already relies on `SINGLE|ANYONECANPAY|FORKID`.

Radiant's FORKID sighash preimage is **not** stock BIP-143: it inserts an
extra `hashOutputHashes` field (a push-ref-aware output commitment) between
`nSequence` and `hashOutputs`. `@radiant-core/radiantjs` implements this
already (`Transaction.Sighash.sign` / `GetHashOutputHashes`), which is why
`signPsbt` always signs through that call rather than a hand-rolled
preimage — reimplementing BIP-143 directly here would silently produce
invalid signatures.

## 3. API — `packages/lib/src/psbt`

Pure module, no app/React dependency. Values are `bigint` internally
(photon amounts can exceed 2^53); convert at the radiantjs boundary via
`bnFromValue(v.toString())`.

```ts
parsePsbt(bytes): Psbt;              serializePsbt(psbt): Uint8Array;
psbtFromBase64(b64): Psbt;           psbtToBase64(psbt): string;

signPsbt(psbt, wif, opts?): { psbt; signedIndexes; skipped };
// Signs inputs whose declared utxo script matches p2pkhScript(address-of-wif).
// Throws PsbtError for policy violations: TOKEN_BEARING_INPUT (any input
// spending a token-bearing output — overridable via allowTokenBearingInputs,
// off by default), MISSING_FORKID, DISALLOWED_SIGHASH.

finalizePsbt(psbt): { psbt; complete };   // complete once every input has a final scriptSig
extractTx(psbt): string;                  // raw hex; throws NOT_FINALIZED otherwise

analyzePsbt(psbt, { ownScripts?, net? }): PsbtAnalysis;
// Pure UI-facing summary: per-input/-output rows, totals, fee (undefined if
// any prevout is unknown), and typed warnings (TOKEN_BEARING_INPUT,
// FEE_UNKNOWN, HIGH_FEE, SIGHASH_*, ALREADY_SIGNED, …).
```

`packages/app/src/connect/psbtFlow.ts` layers the wallet's own state on top:
`enrichPsbt` cross-checks each input against `db.txo` (ownership, spent
status, script/value agreement) and, for external inputs the PSBT didn't
attach a utxo for, best-effort resolves one from the wallet's Electrum
connection purely for fee display — never for signing.

## 4. Connect protocol integration

Extends `photonic-connect` (`packages/app/src/connect/protocol.ts`) with a
second request type alongside the existing `sign-request`:

```ts
type PsbtSignRequest = {
  protocol: "photonic-connect"; v: 1; t: "psbt-sign-request";
  psbt: string;              // base64 or base64url
  broadcast?: boolean;       // only the literal `true` opts in — see below
  id?: string; origin?: string; app?: string; callback?: string;
};

type PsbtSignResult = {
  protocol: "photonic-connect"; v: 1; t: "psbt-sign-result";
  id?: string;
  psbt?: string;   // present unless a broadcast succeeded
  txid?: string;   // present once a broadcast is accepted
  complete: boolean;
};
```

Deep link: `#/connect?req=<base64url envelope>` (same route as `sign-request`
— `packages/app/src/pages/Connect.tsx` dispatches on `t`). A raw PSBT blob is
**never** auto-accepted as a bare string the way a challenge is; an explicit
envelope with `t: "psbt-sign-request"` is required, so intent is always
unambiguous.

**Return vs. broadcast** is the requester's choice, not the wallet's:
- `broadcast` omitted or anything other than the literal `true` → the wallet
  always returns the (possibly still partial) signed PSBT.
- `broadcast: true` **and** every input ends up signed → the wallet
  finalizes, extracts, and broadcasts, returning a `txid` instead.
- `broadcast: true` but the PSBT is still incomplete after the wallet's own
  signature(s) → no error; the partial PSBT is returned as usual, so
  multi-party flows keep working.
- Broadcast attempted but rejected by the network → the signed PSBT is
  still returned, plus an error surfaced in the UI, so nothing is lost.

The approval screen (`PsbtRequestPanel`) always shows a broadcast-vs-return
badge before the user approves anything.

**Callback return** reuses the existing origin-binding rules
(`cleanCallback`): a `callback` is only ever honored when its origin exactly
matches the envelope's declared `origin`. The result rides back in the URL
**fragment**, never the query, so it never reaches a server's access or
proxy logs:

```
<callback>#id=<id>&txid=<txid>&complete=true
<callback>#id=<id>&psbt=<base64>&complete=<true|false>
```

If the composed callback URL would exceed 8 KB (`MAX_CALLBACK_URL_LEN`), the
wallet returns `undefined` rather than risk a silently truncated result —
the user gets the manual copy/paste return instead. The `psbt` envelope
field itself is capped at 64 KB (`MAX_PSBT_LEN`); larger PSBTs need a
transport this protocol doesn't police.

## 5. Safety checks (v1)

| Check | Where | Outcome |
| --- | --- | --- |
| Any input (owned or not) spends a token-bearing output | `signPsbt` + UI | Hard refuse — see rationale in §2.1's sibling: co-signing risks destroying someone's token |
| Wallet's own record disagrees with the PSBT's declared utxo for an owned input | `enrichPsbt` | Hard refuse |
| Owned input already marked spent locally | `enrichPsbt` | Warning only (may be racing the mempool) |
| Sighash missing `SIGHASH_FORKID`, or `SIGHASH_NONE` | `signPsbt` | Hard refuse |
| `SIGHASH_SINGLE` / `ANYONECANPAY` | `analyzePsbt` | Warning shown in the approval UI |
| Fee rate above `MAX_REASONABLE_FEE_RATE` (`packages/lib/src/feePolicy.ts`) | `analyzePsbt` + UI | Warning; broadcast path additionally treats it as a hard stop |
| Fee can't be computed (an input's value is unresolved) | `analyzePsbt` | Shown as "fee unknown", never guessed |

## 6. Out of scope for v1

- Signing token-bearing (FT/NFT/vault covenant) inputs — refused outright.
- A PSBT combiner UI (multi-party signing works by handing the base64
  PSBT to each signer in turn; no merge-of-independently-signed-copies step
  exists yet).
- Signing with the swap subaccount key.
- A `packages/cli` command (the lib module is ready for one; natural
  follow-up).
- OS-level deep-link registration — `#/connect?req=` is a web hash route,
  not a custom URL scheme; auto-return is web-only (`canAutoReturn`).

## 7. Minimal dApp example

```ts
import rjs from "@radiant-core/radiantjs";
const { Transaction, Script } = rjs;

// Build the unsigned tx exactly as you would for a normal send — every
// scriptSig left empty.
const tx = new Transaction();
tx.addInput(new Transaction.Input({ prevTxId, outputIndex, script: new Script() }));
tx.addOutput(new Transaction.Output({ script: destScript, satoshis: value }));

// Wrap it as a PSBT: global unsigned tx + one CTxOut utxo field per input.
const psbt = {
  unsignedTxHex: tx.toString(),
  inputs: [{ utxo: { script: prevScript, value: prevValueBigint }, partialSigs: new Map(), bip32: [], unknown: [] }],
  outputs: [{ entries: [] }],
  unknownGlobals: [],
};

const req = {
  protocol: "photonic-connect", v: 1, t: "psbt-sign-request",
  psbt: psbtToBase64(psbt), broadcast: true,
  origin: "https://your.app", callback: "https://your.app/psbt-callback",
};
location.href = `https://wallet.example/#/connect?req=${encodeReqParam(req)}`;
// On return: https://your.app/psbt-callback#id=...&txid=...&complete=true
```
