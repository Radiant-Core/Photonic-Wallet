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
  findMarketBeacon,
  marketStateFromScript,
  parseStatefulOutput,
  oracle as swapOracle,
  Status,
  MARKER,
  type MarketRefs,
  type MarketScripts,
  type MarketState,
  type KeyedUtxo,
  type Utxo,
  type Outcome,
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
  addedAt: number;
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
  const { scripts } = outputScripts(raw);
  const beacon = findMarketBeacon(scripts);
  if (!beacon) {
    throw new Error(
      "No RMKT beacon in that transaction — not a (self-describing) RadiantSwap market"
    );
  }
  return {
    createTxid: createTxid.trim(),
    question: beacon.question,
    marketRef: beacon.refs.marketRef.toString("hex"),
    yesRef: beacon.refs.yesRef.toString("hex"),
    noRef: beacon.refs.noRef.toString("hex"),
    expiry: beacon.expiry,
    grace: beacon.grace,
    oracle: beacon.oracle.toString("hex"),
    addedAt: Date.now(),
  };
}

async function unspentByScript(lock: Buffer): Promise<Utxo[]> {
  const utxos = await electrumWorker.value.getUtxosByScriptHash(
    scriptHash(lock.toString("hex"))
  );
  return utxos.map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_pos,
    satoshis: u.value,
    script: lock.toString("hex"),
  }));
}

/** Fetch the live on-chain view of a tracked market. */
export async function fetchLiveMarket(t: TrackedMarket): Promise<LiveMarket> {
  const scripts = scriptsOf(t);
  const [refRes, height] = await Promise.all([
    electrumWorker.value.getRef(t.marketRef),
    electrumWorker.value.getBlockHeight(),
  ]);
  const last = refRes?.[1]?.tx_hash;
  if (!last) throw new Error("Market singleton not found on chain");
  const raw = await electrumWorker.value.getTransaction(last);
  if (!raw) throw new Error("Market transaction not found");
  const { scripts: outScripts, values } = outputScripts(raw);
  let market: Utxo | null = null;
  let state: MarketState | null = null;
  for (let vout = 0; vout < outScripts.length; vout++) {
    const parsed = parseStatefulOutput(outScripts[vout]);
    if (!parsed || !parsed.code.equals(scripts.marketCode)) continue;
    const s = marketStateFromScript(outScripts[vout]);
    if (!s) continue;
    market = {
      txid: last,
      vout,
      satoshis: values[vout],
      script: outScripts[vout].toString("hex"),
    };
    state = s;
    break;
  }
  if (!market || !state) {
    throw new Error("Market output not found in its latest transaction");
  }

  const pkh = walletPkh();
  const [yesAnchors, noAnchors, myYes, myNo] = await Promise.all([
    unspentByScript(buildStatefulOutput(MARKER, scripts.yesCode)),
    unspentByScript(buildStatefulOutput(MARKER, scripts.noCode)),
    unspentByScript(buildStatefulOutput(pkh, scripts.yesCode)),
    unspentByScript(buildStatefulOutput(pkh, scripts.noCode)),
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

/** Create a market with the wallet as 1-of-1 oracle (operator model; committee importable later). */
export async function createMarketAction(p: {
  question: string;
  expiry: number;
  grace: number;
}): Promise<TrackedMarket> {
  const { address, wif } = requireWallet();
  const priv = PrivateKey.fromWIF(wif);
  const committee = swapOracle.soloOracle(
    Buffer.from(priv.toPublicKey().toBuffer())
  );

  // The create tx needs three distinct funding outpoints (they induce the refs), so first build
  // a preparation tx fanning one coin into three P2PKH outputs to ourselves.
  const p2pkh = Script.buildPublicKeyHashOut(Address.fromString(address));
  const PREP = [3_000_000, 300_000, 300_000];
  const prepFunding = await selectFunding(
    PREP.reduce((a, b) => a + b, 0) + 2_000_000
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
  const funding = await selectFunding(3 * amount + 10_000_000);
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
  const funding = await selectFunding(10_000_000);
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
  const funding = await selectFunding(10_000_000);
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

/** Resolve with the wallet key (only valid when the wallet is the 1-of-1 operator oracle). */
export async function resolveAction(
  t: TrackedMarket,
  live: LiveMarket,
  outcome: Outcome
): Promise<string> {
  const { address, wif } = requireWallet();
  const priv = PrivateKey.fromWIF(wif);
  const committee = swapOracle.soloOracle(
    Buffer.from(priv.toPublicKey().toBuffer())
  );
  const funding = await selectFunding(10_000_000);
  const built = sized((feeSats) =>
    buildResolve({
      scripts: scriptsOf(t),
      refs: refsOf(t),
      market: live.market,
      state: live.state,
      outcome,
      committee,
      signerWifs: [wif],
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
  const funding = await selectFunding(10_000_000);
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
