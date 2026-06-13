/**
 * RadiantSwap prediction-market glue — tracked-market registry, chain reads, and wallet-funded
 * lifecycle actions (create / split / merge / redeem / resolve / revert).
 *
 * Market discovery has no indexer endpoint yet (`market.*` is a deferred RadiantSwap plug-point),
 * so markets are tracked locally by their creation txid: the create tx carries a self-describing
 * RMKT beacon (question + refs + params) from which every watch script is rebuilt. Live state is
 * read with two RPCs: `blockchain.ref.get` (the singleton's latest location) and
 * `blockchain.scripthash.listunspent` (anchors + the wallet's YES/NO positions, whose locking
 * scripts are constant).
 */
import rjs from "@radiant-core/radiantjs";
import {
  buildMarketScripts,
  buildStatefulOutput,
  buildCreateMarket,
  buildSplit,
  buildMerge,
  buildRedeem,
  buildResolve,
  buildRevert,
  buildSellOrder,
  fillSellOrder,
  buildBuyOrder,
  fillBuyOrder,
  buildShareTransfer,
  findMarketBeacon,
  verifyMarketBeacon,
  encodeState,
  impliedProbability,
  oracle as swapOracle,
  rswp,
  Status,
  MARKER,
  type MarketRefs,
  type MarketScripts,
  type MarketState,
  type KeyedUtxo,
  type Utxo,
  type Outcome,
  type SellOrder,
  type BuyOrder,
} from "radiantswap";
import { scriptHash } from "@lib/script";
import db from "@app/db";
import { wallet, feeRate } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";

const { Script, Transaction, Address, PrivateKey } = rjs;

const KVP_KEY = "predictMarkets";

/** A locally tracked market — everything needed to rebuild its scripts, from the RMKT beacon. */
export interface TrackedMarket {
  createTxid: string;
  question: string;
  marketRef: string; // 36-byte hex (internal byte order)
  yesRef: string;
  noRef: string;
  expiry: number;
  grace: number;
  oracle: string; // 33-byte descriptor hex
  /** Committee member pubkeys (33-byte hex, slot order) — known only to the creator (the beacon
   *  carries just the hash descriptor). Needed to prefill resolution for committee markets. */
  committeeKeys?: string[];
  threshold?: number;
  addedAt: number;
}

/** An order this wallet posted (the ad is on-chain; the signed order is kept locally too).
 *  `kind` "ask" = selling shares for RXD (order set); "bid" = offering RXD for shares (buy set).
 *  Legacy entries without `kind` are asks. */
export interface PostedOrder {
  adTxid: string;
  marketCreateTxid: string;
  kind?: "ask" | "bid";
  side: "yes" | "no";
  amount: number; // share photons
  priceSats: number; // RXD photons
  order?: SellOrder;
  buy?: BuyOrder;
  createdAt: number;
}

export function postedKind(o: PostedOrder): "ask" | "bid" {
  return o.kind ?? "ask";
}

/** Live, chain-derived view of a tracked market. */
export interface LiveMarket {
  state: MarketState;
  market: Utxo; // current singleton UTXO (value = collateral + base)
  yesAnchor: Utxo | null;
  noAnchor: Utxo | null;
  myYes: Utxo[]; // wallet's YES positions
  myNo: Utxo[];
  height: number; // current chain height (for expiry display)
}

export const statusLabel: Record<Status, string> = {
  [Status.OPEN]: "Open",
  [Status.RESOLVED_YES]: "Resolved YES",
  [Status.RESOLVED_NO]: "Resolved NO",
  [Status.REVERTED]: "Reverted",
  // optimistic-oracle (MarketOpt) statuses — present in the SDK Status enum
  [Status.PROPOSED_YES]: "Proposed YES (challenge window)",
  [Status.PROPOSED_NO]: "Proposed NO (challenge window)",
};

/* ------------------------------- registry (kvp) ------------------------------- */

export async function listTracked(): Promise<TrackedMarket[]> {
  const rows = (await db.kvp.get(KVP_KEY)) as TrackedMarket[] | undefined;
  return rows || [];
}

export async function trackMarket(m: TrackedMarket): Promise<void> {
  const rows = await listTracked();
  if (rows.some((r) => r.createTxid === m.createTxid)) return;
  await db.kvp.put([m, ...rows], KVP_KEY);
}

export async function untrackMarket(createTxid: string): Promise<void> {
  const rows = await listTracked();
  await db.kvp.put(
    rows.filter((r) => r.createTxid !== createTxid),
    KVP_KEY
  );
}

const ORDERS_KEY = "predictMyOrders";

export async function listMyOrders(
  marketCreateTxid?: string
): Promise<PostedOrder[]> {
  const rows = ((await db.kvp.get(ORDERS_KEY)) as PostedOrder[]) || [];
  return marketCreateTxid
    ? rows.filter((r) => r.marketCreateTxid === marketCreateTxid)
    : rows;
}

async function saveMyOrder(o: PostedOrder): Promise<void> {
  const rows = await listMyOrders();
  await db.kvp.put([o, ...rows], ORDERS_KEY);
}

export async function removeMyOrder(adTxid: string): Promise<void> {
  const rows = await listMyOrders();
  await db.kvp.put(
    rows.filter((r) => r.adTxid !== adTxid),
    ORDERS_KEY
  );
}

/* ------------------------------- chain reads ------------------------------- */

export function refsOf(t: TrackedMarket): MarketRefs {
  return {
    marketRef: Buffer.from(t.marketRef, "hex"),
    yesRef: Buffer.from(t.yesRef, "hex"),
    noRef: Buffer.from(t.noRef, "hex"),
  };
}

export function scriptsOf(t: TrackedMarket): MarketScripts {
  return buildMarketScripts(refsOf(t));
}


function outputScripts(rawTx: string): { scripts: Buffer[]; values: number[] } {
  const tx = new Transaction(rawTx);
  return {
    scripts: tx.outputs.map((o: { script: { toBuffer(): Buffer } }) =>
      Buffer.from(o.script.toBuffer())
    ),
    values: tx.outputs.map((o: { satoshis: number }) => o.satoshis),
  };
}

/** Import a market from its creation txid by parsing the RMKT beacon. */
export async function openMarketByCreateTxid(
  createTxid: string
): Promise<TrackedMarket> {
  const raw = await electrumWorker.value.getTransaction(createTxid.trim());
  if (!raw) throw new Error("Transaction not found");
  const tx = new Transaction(raw);
  const scripts = tx.outputs.map((o: { script: { toBuffer(): Buffer } }) =>
    Buffer.from(o.script.toBuffer())
  );
  const beacon = findMarketBeacon(scripts);
  if (!beacon) {
    throw new Error(
      "No RMKT beacon in that transaction — not a (self-describing) RadiantSwap market"
    );
  }
  // Do NOT trust the beacon's own fields: re-anchor to the on-chain market. radiantjs
  // input.prevTxId.toString('hex') is already display order (verified), which is what
  // verifyMarketBeacon's encodeRef expects.
  const createTx = {
    inputs: tx.inputs.map((i: { prevTxId: Buffer; outputIndex: number }) => ({
      txid: Buffer.from(i.prevTxId).toString("hex"),
      vout: i.outputIndex,
    })),
    outputs: tx.outputs.map((o: { script: { toBuffer(): Buffer }; satoshis: number }) => ({
      script: Buffer.from(o.script.toBuffer()),
      satoshis: o.satoshis,
    })),
  };
  const v = verifyMarketBeacon(beacon, createTx);
  if (!v) {
    throw new Error(
      "RMKT beacon failed verification: its marketRef is not a singleton this transaction deploys, " +
        "or output[0]/anchors don't match — treating as an untrusted/forged beacon."
    );
  }
  // fetchLiveMarket locates the singleton via the binary status-variant locks; an optimistic
  // (MarketOpt, 74-byte state) singleton can't be tracked yet — refuse the import loudly rather
  // than silently produce an un-viewable market.
  if (v.state.optimistic) {
    throw new Error(
      "This is an optimistic (MarketOpt) market — committee-resolution markets only are supported " +
        "in this wallet for now."
    );
  }
  return {
    createTxid: createTxid.trim(),
    question: v.question,
    marketRef: v.marketRef.toString("hex"),
    yesRef: v.refs.yesRef.toString("hex"),
    noRef: v.refs.noRef.toString("hex"),
    // resolution params come from the on-chain SINGLETON STATE, never the beacon
    expiry: v.state.expiry,
    grace: v.state.grace,
    oracle: v.state.oracle.toString("hex"),
    addedAt: Date.now(),
  };
}

// Mirror of RXinDexer's Script.zero_refs (electrumx/lib/script.py): the indexer keys a UTXO's
// scripthash on the script with every 36-byte ref operand ZEROED — but only for scripts that
// contain a checksig opcode (so one watch key covers a wallet's holdings across all refs).
// ShareToken code checks signatures, so anchors/positions index under their zeroed form; the
// resulting hash collides across markets and across YES/NO, hence the ref filter below.
const INPUT_REF_OPS = new Set([0xd0, 0xd1, 0xd2, 0xd3, 0xd8]);
const CHECKSIG_OPS = new Set([0xac, 0xad, 0xae, 0xaf]);

function zeroRefs(script: Buffer): Buffer {
  const out = Buffer.from(script);
  let requiresSig = false;
  let n = 0;
  while (n < script.length) {
    const op = script[n];
    n += 1;
    if (CHECKSIG_OPS.has(op)) {
      requiresSig = true;
    } else if (op <= 0x4e) {
      let dlen = op;
      if (op === 0x4c) {
        dlen = script[n];
        n += 1;
      } else if (op === 0x4d) {
        dlen = script.readUInt16LE(n);
        n += 2;
      } else if (op === 0x4e) {
        dlen = script.readUInt32LE(n);
        n += 4;
      }
      n += dlen;
    } else if (INPUT_REF_OPS.has(op)) {
      out.fill(0, n, n + 36);
      n += 36;
    }
  }
  return requiresSig ? out : script;
}

/** List unspent outputs locked by `lock`, keyed the way the indexer keys them (zero_refs), and
 *  filtered to entries actually carrying `expectRef` (the zeroed hash collides across markets). */
async function unspentByScript(lock: Buffer, expectRef?: Buffer): Promise<Utxo[]> {
  const utxos = await electrumWorker.value.getUtxosByScriptHash(
    scriptHash(zeroRefs(lock).toString("hex"))
  );
  let filtered = utxos;
  if (expectRef) {
    const displayTxid = Buffer.from(expectRef.subarray(0, 32))
      .reverse()
      .toString("hex");
    const refVout = expectRef.readUInt32LE(32);
    filtered = utxos.filter((u) =>
      (u.refs || []).some(
        (r) =>
          r.ref.startsWith(displayTxid) &&
          parseInt(r.ref.substring(65), 10) === refVout
      )
    );
  }
  return filtered.map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_pos,
    satoshis: u.value,
    script: lock.toString("hex"),
  }));
}

/** Fetch the live on-chain view of a tracked market.
 *
 *  The singleton is located via `scripthash.listunspent` over the four status-variant locking
 *  scripts: a market's lock bytes are CONSTANT while its status byte is unchanged (expiry, grace
 *  and oracle never change; collateral lives in the UTXO value), and exactly one variant can be
 *  unspent at a time. This avoids `blockchain.ref.get`, whose per-session response cache can
 *  serve a stale location after the singleton moves (RXinDexer cache-invalidation bug). */
export async function fetchLiveMarket(t: TrackedMarket): Promise<LiveMarket> {
  // A disconnected worker resolves scripthash queries to [] (not an error), which would render
  // as "market not found" — fail loudly instead so the UI shows a retryable state.
  if (!(await electrumWorker.value.isReady())) {
    throw new Error("Not connected to an ElectrumX server — retry in a moment");
  }
  const scripts = scriptsOf(t);
  const baseState = {
    expiry: t.expiry,
    grace: t.grace,
    oracle: Buffer.from(t.oracle, "hex"),
  };
  const statuses = [
    Status.OPEN,
    Status.RESOLVED_YES,
    Status.RESOLVED_NO,
    Status.REVERTED,
  ];
  const [height, ...byStatus] = await Promise.all([
    electrumWorker.value.getBlockHeight(),
    ...statuses.map((status) =>
      unspentByScript(
        buildStatefulOutput(
          encodeState({ status, ...baseState }),
          scripts.marketCode
        ),
        refsOf(t).marketRef
      )
    ),
  ]);
  let market: Utxo | null = null;
  let state: MarketState | null = null;
  for (let i = 0; i < statuses.length; i++) {
    if (byStatus[i].length > 0) {
      market = byStatus[i][0];
      state = { status: statuses[i], ...baseState };
      break;
    }
  }
  if (!market || !state) {
    throw new Error("Market singleton not found on chain");
  }

  const pkh = walletPkh();
  const refs = refsOf(t);
  const [yesAnchors, noAnchors, myYes, myNo] = await Promise.all([
    unspentByScript(buildStatefulOutput(MARKER, scripts.yesCode), refs.yesRef),
    unspentByScript(buildStatefulOutput(MARKER, scripts.noCode), refs.noRef),
    unspentByScript(buildStatefulOutput(pkh, scripts.yesCode), refs.yesRef),
    unspentByScript(buildStatefulOutput(pkh, scripts.noCode), refs.noRef),
  ]);

  return {
    state,
    market,
    yesAnchor: yesAnchors[0] || null,
    noAnchor: noAnchors[0] || null,
    myYes,
    myNo,
    height,
  };
}

/* ------------------------------- wallet funding ------------------------------- */

function requireWallet(): { address: string; wif: string } {
  const w = wallet.value;
  if (!w.address || w.locked || !w.wif) {
    throw new Error("Unlock the wallet first");
  }
  return { address: w.address, wif: w.wif.toString() };
}

export function walletPkh(): Buffer {
  return Buffer.from(Address.fromString(wallet.value.address).hashBuffer);
}

/** Pick one wallet RXD coin covering `target` (largest-first; v1 keeps funding to one input). */
async function selectFunding(target: number): Promise<KeyedUtxo> {
  const { wif } = requireWallet();
  const coins = await db.txo
    .where({ contractType: 0 /* ContractType.RXD */, spent: 0 })
    .toArray();
  const coin = coins
    .filter((c) => c.value >= target)
    .sort((a, b) => a.value - b.value)[0];
  if (!coin) {
    throw new Error(
      `No single RXD coin covers ${target} photons — consolidate coins first`
    );
  }
  return {
    txid: coin.txid,
    vout: coin.vout,
    satoshis: coin.value,
    script: coin.script,
    wif,
  };
}

/** Upper-bound fee allowance for coin selection. Covenant transactions run multiple KB (the
 *  Market/Share locking scripts are large), so at the default 10,000 photons/byte a single
 *  action can cost >100M photons — selection must reserve for that; sized() then pays the
 *  exact byte fee and the surplus returns as change. */
function feeHeadroom(): number {
  return Math.ceil(16_000 * feeRate.value * 1.05) + 100_000;
}

/** Two-pass fee sizing: build once with a guess, rebuild with fee = bytes × feeRate (+5%). */
function sized<T extends { hex: string }>(build: (feeSats: number) => T): T {
  const draft = build(1_000_000);
  const bytes = draft.hex.length / 2;
  const fee = Math.ceil(bytes * feeRate.value * 1.05);
  return build(fee);
}

async function broadcast(hex: string): Promise<string> {
  return await electrumWorker.value.broadcast(hex);
}

/* ------------------------------- lifecycle actions ------------------------------- */

/** Create a market. Default oracle = this wallet's key as 1-of-1 operator; pass `committee`
 *  (33-byte pubkey hexes in slot order + threshold) for an N-of-M committee market. */
export async function createMarketAction(p: {
  question: string;
  expiry: number;
  grace: number;
  committee?: { keys: string[]; threshold: number };
}): Promise<TrackedMarket> {
  const { address, wif } = requireWallet();
  const priv = PrivateKey.fromWIF(wif);
  const committee = p.committee
    ? {
        keys: p.committee.keys.map((k) => Buffer.from(k, "hex")),
        threshold: p.committee.threshold,
      }
    : swapOracle.soloOracle(Buffer.from(priv.toPublicKey().toBuffer()));

  // The create tx needs three distinct funding outpoints (they induce the refs), so first build
  // a preparation tx fanning one coin into three P2PKH outputs to ourselves. The first output
  // must cover the create tx's own fee (multi-KB covenant outputs — see feeHeadroom).
  const p2pkh = Script.buildPublicKeyHashOut(Address.fromString(address));
  const PREP = [feeHeadroom() + 500_000, 300_000, 300_000];
  const prepFunding = await selectFunding(
    PREP.reduce((a, b) => a + b, 0) + feeHeadroom()
  );
  const prep = sized((feeSats) => {
    const tx = new Transaction();
    tx.from({
      txId: prepFunding.txid,
      outputIndex: prepFunding.vout,
      script: prepFunding.script,
      satoshis: prepFunding.satoshis,
    });
    for (const v of PREP) {
      tx.addOutput(new Transaction.Output({ script: p2pkh, satoshis: v }));
    }
    const change =
      prepFunding.satoshis - PREP.reduce((a, b) => a + b, 0) - feeSats;
    if (change < 0) throw new Error("Funding coin too small");
    if (change > 0) tx.to(address, change);
    tx.sign(PrivateKey.fromWIF(wif));
    tx.seal();
    return { hex: tx.toString() as string, txid: tx.id as string };
  });
  await broadcast(prep.hex);

  const funding = PREP.map((satoshis, vout) => ({
    txid: prep.txid,
    vout,
    satoshis,
    script: p2pkh.toHex() as string,
    wif,
  })) as [KeyedUtxo, KeyedUtxo, KeyedUtxo];

  const created = sized((feeSats) =>
    buildCreateMarket({
      funding,
      committee,
      expiry: p.expiry,
      grace: p.grace,
      changeAddress: address,
      question: p.question,
      feeSats,
    })
  );
  await broadcast(created.hex);

  const tracked: TrackedMarket = {
    createTxid: created.txid,
    question: p.question,
    marketRef: created.refs.marketRef.toString("hex"),
    yesRef: created.refs.yesRef.toString("hex"),
    noRef: created.refs.noRef.toString("hex"),
    expiry: p.expiry,
    grace: p.grace,
    oracle: created.state.oracle.toString("hex"),
    committeeKeys: committee.keys.map((k) => k.toString("hex")),
    threshold: committee.threshold,
    addedAt: Date.now(),
  };
  await trackMarket(tracked);
  return tracked;
}

/** Lock 3N (N collateral + 2N carriers), mint N YES + N NO to the wallet. */
export async function splitAction(
  t: TrackedMarket,
  live: LiveMarket,
  amount: number
): Promise<string> {
  const { address } = requireWallet();
  if (!live.yesAnchor || !live.noAnchor) {
    throw new Error("Share anchors not found on chain");
  }
  const funding = await selectFunding(3 * amount + feeHeadroom());
  const built = sized((feeSats) =>
    buildSplit({
      scripts: scriptsOf(t),
      market: live.market,
      yesAnchor: live.yesAnchor!,
      noAnchor: live.noAnchor!,
      funding,
      amount,
      recipientPkh: walletPkh(),
      changeAddress: address,
      feeSats,
    })
  );
  return await broadcast(built.hex);
}

/** Burn a complete set (equal-value YES + NO UTXOs) and reclaim the collateral. */
export async function mergeAction(
  t: TrackedMarket,
  live: LiveMarket,
  yes: Utxo,
  no: Utxo
): Promise<string> {
  const { address, wif } = requireWallet();
  const funding = await selectFunding(feeHeadroom());
  const built = sized((feeSats) =>
    buildMerge({
      market: live.market,
      yes,
      no,
      shareWif: wif,
      funding,
      payoutAddress: address,
      feeSats,
    })
  );
  return await broadcast(built.hex);
}

/** Burn a winning-side position post-resolution, redeeming 1:1. */
export async function redeemAction(
  t: TrackedMarket,
  live: LiveMarket,
  winningShare: Utxo
): Promise<string> {
  const { address, wif } = requireWallet();
  const funding = await selectFunding(feeHeadroom());
  const built = sized((feeSats) =>
    buildRedeem({
      market: live.market,
      state: live.state,
      winningShare,
      shareWif: wif,
      funding,
      payoutAddress: address,
      feeSats,
    })
  );
  return await broadcast(built.hex);
}

/** True when this wallet's key alone matches the market's oracle descriptor (operator market). */
export function walletIsSoloOracle(t: TrackedMarket): boolean {
  const w = wallet.value;
  if (!w.wif || w.locked) return false;
  const pk = Buffer.from(
    PrivateKey.fromWIF(w.wif.toString()).toPublicKey().toBuffer()
  );
  return (
    swapOracle.committeeDescriptor(swapOracle.soloOracle(pk)).toString("hex") ===
    t.oracle
  );
}

/** Resolve the market. Defaults to the wallet key as 1-of-1 operator; committee markets pass the
 *  member pubkeys (slot order) + ≥threshold member WIFs. The committee is validated against the
 *  on-chain descriptor before building, so a wrong keyset fails fast with a clear error. */
export async function resolveAction(
  t: TrackedMarket,
  live: LiveMarket,
  outcome: Outcome,
  committeeInput?: { keys: string[]; threshold: number; signerWifs: string[] }
): Promise<string> {
  const { address, wif } = requireWallet();
  const priv = PrivateKey.fromWIF(wif);
  const committee = committeeInput
    ? {
        keys: committeeInput.keys.map((k) => Buffer.from(k, "hex")),
        threshold: committeeInput.threshold,
      }
    : swapOracle.soloOracle(Buffer.from(priv.toPublicKey().toBuffer()));
  const descriptor = swapOracle.committeeDescriptor(committee).toString("hex");
  if (descriptor !== t.oracle) {
    throw new Error(
      committeeInput
        ? "Committee keys/threshold do not match this market's oracle descriptor (check slot order)"
        : "This wallet is not the market's operator oracle — supply the committee keys and member WIFs"
    );
  }
  const signerWifs = committeeInput?.signerWifs?.length
    ? committeeInput.signerWifs
    : [wif];
  const funding = await selectFunding(feeHeadroom());
  const built = sized((feeSats) =>
    buildResolve({
      scripts: scriptsOf(t),
      refs: refsOf(t),
      market: live.market,
      state: live.state,
      outcome,
      committee,
      signerWifs,
      funding,
      changeAddress: address,
      feeSats,
    })
  );
  return await broadcast(built.hex);
}

/** Flip an expired, unresolved market to REVERTED (permissionless safety hatch). */
export async function revertAction(
  t: TrackedMarket,
  live: LiveMarket
): Promise<string> {
  const { address } = requireWallet();
  const funding = await selectFunding(feeHeadroom());
  const built = sized((feeSats) =>
    buildRevert({
      scripts: scriptsOf(t),
      market: live.market,
      state: live.state,
      funding,
      changeAddress: address,
      feeSats,
    })
  );
  return await broadcast(built.hex);
}

/* ------------------------------- order layer ------------------------------- */

/** Probability implied by an ask: (price − carrier) / claim, both = the share amount. */
export function askProbability(priceSats: number, amount: number): number {
  return impliedProbability(priceSats, amount, amount);
}

/** Sign a sell order for one of the wallet's positions and broadcast its RSWP advertisement. */
export async function postOrderAction(
  t: TrackedMarket,
  side: "yes" | "no",
  share: Utxo,
  priceSats: number
): Promise<PostedOrder> {
  const { address, wif } = requireWallet();
  const order = buildSellOrder({
    side,
    share,
    makerWif: wif,
    price: priceSats,
    paymentScriptHex: Script.buildPublicKeyHashOut(
      Address.fromString(address)
    ).toHex() as string,
  });
  const refs = refsOf(t);
  const adScript = rswp.buildAdvertisementScript(
    order,
    side === "yes" ? refs.yesRef : refs.noRef
  );

  const funding = await selectFunding(feeHeadroom());
  const built = sized((feeSats) => {
    const tx = new Transaction();
    tx.from({
      txId: funding.txid,
      outputIndex: funding.vout,
      script: funding.script,
      satoshis: funding.satoshis,
    });
    tx.addOutput(
      new Transaction.Output({
        script: Script.fromHex(adScript.toString("hex")),
        satoshis: 0,
      })
    );
    const change = funding.satoshis - feeSats;
    if (change < 0) throw new Error("Funding coin too small");
    if (change > 0) tx.to(address, change);
    tx.sign(PrivateKey.fromWIF(funding.wif));
    tx.seal();
    return { hex: tx.toString() as string, txid: tx.id as string };
  });
  await broadcast(built.hex);

  const posted: PostedOrder = {
    adTxid: built.txid,
    marketCreateTxid: t.createTxid,
    kind: "ask",
    side,
    amount: share.satoshis,
    priceSats,
    order,
    createdAt: Date.now(),
  };
  await saveMyOrder(posted);
  return posted;
}

/** Offer `priceSats` RXD for `amount` shares: prepare an exact-value coin (its whole value is the
 *  bid — surplus would be claimable by the taker), sign the buy order, broadcast its RSWP ad. */
export async function postBidAction(
  t: TrackedMarket,
  side: "yes" | "no",
  amount: number,
  priceSats: number
): Promise<PostedOrder> {
  const { address, wif } = requireWallet();
  const p2pkh = Script.buildPublicKeyHashOut(Address.fromString(address));

  // prep: one exact-value output the order consumes whole, plus a change output that funds the
  // advertisement tx (explicit chaining — a second db.txo selection here would race the wallet
  // sync and double-spend the coin the prep just consumed: txn-mempool-conflict).
  const prepFunding = await selectFunding(priceSats + 2 * feeHeadroom());
  let prepChange = 0;
  const prep = sized((feeSats) => {
    const tx = new Transaction();
    tx.from({
      txId: prepFunding.txid,
      outputIndex: prepFunding.vout,
      script: prepFunding.script,
      satoshis: prepFunding.satoshis,
    });
    tx.addOutput(new Transaction.Output({ script: p2pkh, satoshis: priceSats }));
    prepChange = prepFunding.satoshis - priceSats - feeSats;
    if (prepChange <= 0) throw new Error("Funding coin too small");
    tx.to(address, prepChange);
    tx.sign(PrivateKey.fromWIF(wif));
    tx.seal();
    return { hex: tx.toString() as string, txid: tx.id as string };
  });
  await broadcast(prep.hex);

  const scripts = scriptsOf(t);
  const refs = refsOf(t);
  const order = buildBuyOrder({
    side,
    rxd: {
      txid: prep.txid,
      vout: 0,
      satoshis: priceSats,
      script: p2pkh.toHex() as string,
      wif,
    },
    amount,
    shareCode: side === "yes" ? scripts.yesCode : scripts.noCode,
    makerRecipientPkh: walletPkh(),
  });
  const adScript = rswp.buildBuyAdvertisementScript(
    order,
    side === "yes" ? refs.yesRef : refs.noRef
  );

  // fund the ad from the prep's own change output (vout 1) — see chaining note above
  const adFunding: KeyedUtxo = {
    txid: prep.txid,
    vout: 1,
    satoshis: prepChange,
    script: p2pkh.toHex() as string,
    wif,
  };
  const built = sized((feeSats) => {
    const tx = new Transaction();
    tx.from({
      txId: adFunding.txid,
      outputIndex: adFunding.vout,
      script: adFunding.script,
      satoshis: adFunding.satoshis,
    });
    tx.addOutput(
      new Transaction.Output({
        script: Script.fromHex(adScript.toString("hex")),
        satoshis: 0,
      })
    );
    const change = adFunding.satoshis - feeSats;
    if (change < 0) throw new Error("Funding coin too small");
    if (change > 0) tx.to(address, change);
    tx.sign(PrivateKey.fromWIF(adFunding.wif));
    tx.seal();
    return { hex: tx.toString() as string, txid: tx.id as string };
  });
  await broadcast(built.hex);

  const posted: PostedOrder = {
    adTxid: built.txid,
    marketCreateTxid: t.createTxid,
    kind: "bid",
    side,
    amount,
    priceSats,
    buy: order,
    createdAt: Date.now(),
  };
  await saveMyOrder(posted);
  return posted;
}

/** Is the UTXO behind an order still unspent (order still fillable)? */
export async function orderIsOpen(order: SellOrder): Promise<boolean> {
  return await electrumWorker.value.isUtxoUnspent(
    order.share.txid,
    order.share.vout,
    scriptHash(order.share.script)
  );
}

/** Open/closed status for a posted order of either kind. */
export async function postedOrderIsOpen(posted: PostedOrder): Promise<boolean> {
  const bound =
    postedKind(posted) === "bid" ? posted.buy!.rxd : posted.order!.share;
  return await electrumWorker.value.isUtxoUnspent(
    bound.txid,
    bound.vout,
    scriptHash(bound.script)
  );
}

/** One order in the market's (share ↔ RXD) book, as the indexer reports it. */
export interface IndexedAsk {
  kind: "ask" | "bid";
  side: "yes" | "no";
  /** The RSWP advertisement txid (display order) — resolve to a fillable order
   *  with tradeFromAdTxid. */
  adTxid: string;
  amount: number;
  priceSats: number;
  makerAddress: string | null;
}

/** Query the indexer's swap index for both share books. `available: false` means the connected
 *  indexer has no swap index (not an empty book). */
export async function indexedOrderbook(
  t: TrackedMarket
): Promise<{ available: boolean; asks: IndexedAsk[] }> {
  const refs = refsOf(t);
  const pairs = [
    { side: "yes" as const, ...rswp.orderbookPair(refs.yesRef) },
    { side: "no" as const, ...rswp.orderbookPair(refs.noRef) },
  ];
  const books = await Promise.all(
    pairs.map((p) =>
      electrumWorker.value.getSwapOrderbook(p.base_ref, p.quote_ref)
    )
  );
  if (books.every((b) => b === null)) return { available: false, asks: [] };
  const asks: IndexedAsk[] = [];
  books.forEach((book, i) => {
    for (const o of [...(book?.asks || []), ...(book?.bids || [])]) {
      if (o.status !== "open" || !o.tx_hash) continue;
      asks.push({
        kind: o.side === "buy" ? "bid" : "ask",
        side: pairs[i].side,
        adTxid: o.tx_hash,
        amount: o.amount,
        priceSats: o.price,
        makerAddress: o.maker_address,
      });
    }
  });
  // The indexer's price/amount semantics are still settling (sells report amount == price), so
  // resolve true amounts/prices from each ad's backing outpoint (capped to keep the book render
  // cheap); failures keep the indexer values.
  await Promise.all(
    asks.slice(0, 25).map(async (a) => {
      try {
        const trade = await tradeFromAdTxid(t, a.adTxid);
        if (trade.kind === "ask" && trade.sell) {
          a.amount = trade.sell.share.satoshis;
          a.priceSats = trade.sell.payment.satoshis;
        } else if (trade.kind === "bid" && trade.buy) {
          a.amount = trade.buy.shareOut.satoshis;
          a.priceSats = trade.buy.rxd.satoshis;
        }
      } catch {
        /* keep indexer-reported values */
      }
    })
  );
  asks.sort(
    (a, b) =>
      askProbability(a.priceSats, a.amount) -
      askProbability(b.priceSats, b.amount)
  );
  return { available: true, asks };
}

/** A fillable trade reconstructed from an on-chain RSWP advertisement (either side). */
export interface AdTrade {
  kind: "ask" | "bid";
  side: "yes" | "no";
  open: boolean;
  sell?: SellOrder;
  buy?: BuyOrder;
}

/** Reconstruct a fillable order from an on-chain RSWP advertisement transaction. The kind is
 *  detected from the ad: shares offered = ask; native RXD offered wanting shares = bid. */
export async function tradeFromAdTxid(
  t: TrackedMarket,
  adTxid: string
): Promise<AdTrade> {
  const raw = await electrumWorker.value.getTransaction(adTxid.trim());
  if (!raw) throw new Error("Advertisement transaction not found");
  const { scripts } = outputScripts(raw);
  let ad: ReturnType<typeof rswp.parseAdvertisementScript> = null;
  for (const s of scripts) {
    ad = rswp.parseAdvertisementScript(s);
    if (ad) break;
  }
  if (!ad) throw new Error("No RSWP advertisement in that transaction");
  const refs = refsOf(t);
  const idOf = (r: Buffer) => rswp.swapTokenId(r);

  const backingRaw = await electrumWorker.value.getTransaction(ad.outpoint.txid);
  if (!backingRaw) throw new Error("Offered output's transaction not found");
  const backingTx = outputScripts(backingRaw);
  const backingScript = backingTx.scripts[ad.outpoint.vout];
  if (!backingScript) throw new Error("Offered output not found");
  const backing = {
    script: backingScript.toString("hex"),
    satoshis: backingTx.values[ad.outpoint.vout],
  };
  const open = await electrumWorker.value.isUtxoUnspent(
    ad.outpoint.txid,
    ad.outpoint.vout,
    scriptHash(backing.script)
  );

  if (ad.offeredTokenId === rswp.RXD_TOKEN_ID) {
    // bid: RXD offered, shares wanted
    const side =
      ad.wantTokenId === idOf(refs.yesRef)
        ? "yes"
        : ad.wantTokenId === idOf(refs.noRef)
        ? "no"
        : null;
    if (!side) throw new Error("Advertisement is not for this market's shares");
    return { kind: "bid", side, open, buy: rswp.buyOrderFromAdvertisement(ad, side, backing) };
  }
  const side =
    ad.offeredTokenId === idOf(refs.yesRef)
      ? "yes"
      : ad.offeredTokenId === idOf(refs.noRef)
      ? "no"
      : null;
  if (!side) throw new Error("Advertisement is not for this market's shares");
  return { kind: "ask", side, open, sell: rswp.sellOrderFromAdvertisement(ad, side, backing) };
}

/** Atomically fill a sell order: pay the maker's pre-signed price, take the shares. Reconstruct
 *  the order first via orderFromAdTxid (book entries carry the ad txid as `adTxid`). */
export async function fillOrderAction(
  t: TrackedMarket,
  order: SellOrder
): Promise<string> {
  const { address } = requireWallet();
  const scripts = scriptsOf(t);
  // Fetch the live singleton so fillSellOrder can refuse a stale order on a non-OPEN market
  // (a maker's pre-signed SINGLE|ACP ask stays fillable after resolution — without this the
  // taker could overpay for a now-worthless losing share). fetchLiveMarket throws if the
  // singleton is gone, which also correctly aborts the fill.
  const live = await fetchLiveMarket(t);
  const funding = await selectFunding(order.payment.satoshis + feeHeadroom());
  const built = sized((feeSats) =>
    fillSellOrder({
      order,
      shareCode: order.side === "yes" ? scripts.yesCode : scripts.noCode,
      takerRecipientPkh: walletPkh(),
      funding,
      changeAddress: address,
      marketScriptHex: live.market.script,
      feeSats,
    })
  );
  return await broadcast(built.hex);
}

/** Atomically fill a buy order: send the shares, take the maker's RXD. Picks the smallest
 *  position that covers the amount; any surplus returns as share change. */
export async function fillBidAction(
  t: TrackedMarket,
  live: LiveMarket,
  order: BuyOrder
): Promise<string> {
  const { address, wif } = requireWallet();
  const positions = order.side === "yes" ? live.myYes : live.myNo;
  const takerShare = positions
    .filter((u) => u.satoshis >= order.shareOut.satoshis)
    .sort((a, b) => a.satoshis - b.satoshis)[0];
  if (!takerShare) {
    throw new Error(
      `No single ${order.side.toUpperCase()} position covers ${order.shareOut.satoshis} photons`
    );
  }
  const funding = await selectFunding(feeHeadroom());
  const built = sized((feeSats) =>
    fillBuyOrder({
      order,
      takerShare,
      takerShareWif: wif,
      funding,
      payoutScriptHex: Script.buildPublicKeyHashOut(
        Address.fromString(address)
      ).toHex() as string,
      takerChangePkh: walletPkh(),
      changeAddress: address,
      feeSats,
    })
  );
  return await broadcast(built.hex);
}

/** Cancel a posted order by spending its bound UTXO back to ourselves: asks self-transfer the
 *  share; bids self-send the exact-value RXD coin. */
export async function cancelOrderAction(posted: PostedOrder): Promise<string> {
  const { address, wif } = requireWallet();
  const funding = await selectFunding(feeHeadroom());
  let built: { hex: string };
  if (postedKind(posted) === "bid") {
    const coin = posted.buy!.rxd;
    built = sized((feeSats) => {
      const tx = new Transaction();
      tx.from({ txId: coin.txid, outputIndex: coin.vout, script: coin.script, satoshis: coin.satoshis });
      tx.from({ txId: funding.txid, outputIndex: funding.vout, script: funding.script, satoshis: funding.satoshis });
      const back = coin.satoshis + funding.satoshis - feeSats;
      if (back <= 0) throw new Error("Funding too small for fee");
      tx.to(address, back);
      tx.sign(PrivateKey.fromWIF(wif));
      tx.seal();
      return { hex: tx.toString() as string, txid: tx.id as string };
    });
  } else {
    built = sized((feeSats) =>
      buildShareTransfer({
        share: posted.order!.share,
        shareWif: wif,
        recipientPkh: walletPkh(),
        funding,
        changeAddress: address,
        feeSats,
      })
    );
  }
  const txid = await broadcast(built.hex);
  await removeMyOrder(posted.adTxid);
  return txid;
}
