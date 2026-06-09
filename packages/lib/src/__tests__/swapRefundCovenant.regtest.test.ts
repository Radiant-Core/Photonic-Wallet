/**
 * On-chain regtest proof for the RSWP v3 timelocked-refund swap covenant
 * (Phase 2 of docs/swap-offer-expiry-cancellation.md §4.2).
 *
 * Runs the v3.0.0 interpreter (not byte-asserts). Proves, for an RXD-reserved
 * offer locked into the swap-refund covenant:
 *
 *   (a) SWAP branch BEFORE expiry — a taker completes the maker's pre-signed
 *       SIGHASH_SINGLE|ANYONECANPAY offer (with the OP_1 swap selector) and the
 *       maker is paid. ACCEPTED.
 *   (b) REFUND branch BEFORE expiry — the maker's refund-claim tx (nLockTime =
 *       expiry_height, OP_0 refund selector) is REJECTED by the node because
 *       CLTV's `nLockTime >= expiry` is a non-final tx until the chain reaches
 *       the height (mempool rejects non-final txs).
 *   (c) REFUND branch AT/AFTER expiry — once the chain is mined to expiry_height,
 *       the same refund-claim tx is ACCEPTED and the maker reclaims the RXD.
 *
 * Requires the local regtest stack (radiantd RPC 127.0.0.1:17443). Enable with:
 *   REGTEST_E2E=1 pnpm --filter @photonic/lib exec vitest run \
 *     src/__tests__/swapRefundCovenant.regtest.test.ts --testTimeout=600000
 */
import { it, expect } from "vitest";
import rjs from "@radiant-core/radiantjs";
import { partiallySigned } from "../transfer";
import { buildTx } from "../tx";
import { fundTx, SelectableInput } from "../coinSelect";
import { p2pkhScript } from "../script";
import {
  swapRefundScript,
  appendSwapSelector,
  buildSwapRefundClaimTx,
  parseSwapRefundScript,
  type SwapRefundTerms,
} from "../swapRefundCovenant";
import { Utxo, UnfinalizedInput, UnfinalizedOutput } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { PrivateKey, Networks, Transaction } = rjs as any;

const RPC_URL = "http://127.0.0.1:17443/";
const RPC_USER = "radiantrpc";
const RPC_PASS = "613c41227c677d8bc90f5729f93604a7";
const FEE_RATE = 10_000;
const PHOTONS = 100_000_000;

let rpcId = 0;
async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64"),
    },
    body: JSON.stringify({ jsonrpc: "1.0", id: rpcId++, method, params }),
  });
  const json = (await res.json()) as { result: T; error: unknown };
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}
type Key = { wif: string; address: string };
function newKey(): Key {
  const pk = PrivateKey.fromRandom(Networks.regtest);
  return { wif: pk.toWIF(), address: pk.toAddress(Networks.regtest).toString() };
}
let MINE_ADDR = "";
const mine = (n = 1) => rpc("generatetoaddress", [n, MINE_ADDR]);
async function fund(address: string, rxd: number) {
  await rpc("sendtoaddress", [address, rxd]);
  await mine(1);
}
const broadcast = (hex: string) => rpc<string>("sendrawtransaction", [hex]);
async function tryBroadcast(hex: string): Promise<{ ok: boolean; err?: string }> {
  try {
    await broadcast(hex);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e) };
  }
}
type Unspent = { txid: string; vout: number; scriptPubKey: string; amount: number };
async function scanUnspents(desc: string): Promise<Unspent[]> {
  const r = await rpc<{ unspents: Unspent[] }>("scantxoutset", ["start", [{ desc }]]);
  return r.unspents || [];
}
async function rxdCoins(address: string): Promise<SelectableInput[]> {
  return (await scanUnspents(`addr(${address})`))
    .map((u) => ({ txid: u.txid, vout: u.vout, script: u.scriptPubKey, value: Math.round(u.amount * PHOTONS) }))
    .filter((u) => u.value > 1);
}
async function utxoByScript(scriptHex: string): Promise<Utxo | null> {
  const u = (await scanUnspents(`raw(${scriptHex})`))[0];
  return u ? { txid: u.txid, vout: u.vout, script: scriptHex, value: Math.round(u.amount * PHOTONS) } : null;
}
async function addrBalance(address: string): Promise<number> {
  return (await scanUnspents(`addr(${address})`)).reduce((s, u) => s + Math.round(u.amount * PHOTONS), 0);
}
const height = () => rpc<number>("getblockcount");

it.skipIf(process.env.REGTEST_E2E !== "1")(
  "RXD swap-refund covenant: swap fills before expiry; refund rejected before, accepted after",
  async () => {
    MINE_ADDR = await rpc<string>("getnewaddress");
    if ((await rpc<number>("getbalance")) < 250) await rpc("generatetoaddress", [110, MINE_ADDR]);

    const maker = newKey();
    const makerSwap = newKey(); // swap subaccount (signs the inner P2PKH)
    const taker = newKey();
    await fund(maker.address, 100);
    await fund(taker.address, 100);

    const RESERVED = 5 * PHOTONS; // RXD the maker reserves to sell
    const PRICE = 4 * PHOTONS; // payment the maker wants (output[0])

    // Expiry a few blocks in the future so we can test before/after.
    const tip = await height();
    const expiryHeight = tip + 6;

    const terms: SwapRefundTerms = {
      assetType: "rxd",
      swapAddress: makerSwap.address,
      expiryHeight,
    };
    const covenantScript = swapRefundScript(terms);
    // Sanity: the covenant round-trips and carries the chosen expiry.
    expect(parseSwapRefundScript(covenantScript)?.expiryHeight).toBe(expiryHeight);

    // --- Maker reserves RXD into the covenant -----------------------------
    {
      const fundSel = fundTx(
        maker.address,
        await rxdCoins(maker.address),
        [],
        [{ script: covenantScript, value: RESERVED }],
        p2pkhScript(maker.address),
        FEE_RATE
      );
      expect(fundSel.funded).toBe(true);
      const lockTx = buildTx(
        maker.address,
        maker.wif,
        fundSel.funding,
        [{ script: covenantScript, value: RESERVED }, ...fundSel.change],
        false
      );
      await broadcast(lockTx.toString());
      await mine(1);
    }
    const covUtxo = await utxoByScript(covenantScript);
    expect(covUtxo).toBeTruthy();
    console.log("LOCK OK — RXD reserved in swap-refund covenant", covUtxo!.txid + ":" + covUtxo!.vout);

    // --- Maker pre-signs the SWAP branch (SINGLE|ANYONECANPAY, output0=PRICE)
    // partiallySigned signs the INNER swap script (p2pkh of makerSwap). We must
    // sign against the FULL covenant script though, because that is the
    // on-chain scriptPubKey. So we sign over the covenant script directly and
    // append the OP_1 swap selector.
    const makerInner: UnfinalizedInput = { ...(covUtxo as Utxo) };
    const psrt = new Transaction(
      partiallySigned(
        makerSwap.address,
        makerInner,
        { script: p2pkhScript(maker.address), value: PRICE },
        makerSwap.wif
      ).toString()
    );
    const innerScriptSig = psrt.inputs[0].script.toHex();
    const swapBranchScriptSig = appendSwapSelector(innerScriptSig);

    // ===================== (a) SWAP fills BEFORE expiry =====================
    {
      const payOut: UnfinalizedOutput = { script: p2pkhScript(maker.address), value: PRICE };
      const takerFund = fundTx(
        taker.address,
        await rxdCoins(taker.address),
        [makerInner],
        [payOut],
        p2pkhScript(taker.address),
        FEE_RATE
      );
      expect(takerFund.funded).toBe(true);
      const swapInputs = [makerInner, ...takerFund.funding];
      // The covenant input already contributes RESERVED to the input pool, so
      // fundTx routes the leftover (RESERVED - PRICE - fee + taker coins) back
      // to the taker as change. Output[0] MUST stay = the maker's PRICE payment
      // (the SIGHASH_SINGLE pre-signature commits to it).
      const swapOutputs = [payOut, ...takerFund.change];
      const makerBefore = await addrBalance(maker.address);
      const swapTx = buildTx(
        taker.address,
        taker.wif,
        swapInputs,
        swapOutputs,
        false,
        (index, script) =>
          index === 0 ? rjs.Script.fromHex(swapBranchScriptSig) : script
      );
      const r = await tryBroadcast(swapTx.toString());
      console.log("(a) SWAP-before-expiry accepted:", r.ok, r.err?.slice(0, 140));
      expect(r.ok).toBe(true);
      await mine(1);
      expect((await addrBalance(maker.address)) - makerBefore).toBe(PRICE);
      console.log(`(a) OK — taker filled the offer; maker +${PRICE / PHOTONS} RXD via SWAP branch`);
    }

    // The swap above consumed the covenant UTXO. Re-lock a fresh one to test
    // the refund branch in isolation (same terms, new value).
    const REFUND_VALUE = 3 * PHOTONS;
    {
      const fundSel = fundTx(
        maker.address,
        await rxdCoins(maker.address),
        [],
        [{ script: covenantScript, value: REFUND_VALUE }],
        p2pkhScript(maker.address),
        FEE_RATE
      );
      expect(fundSel.funded).toBe(true);
      const lockTx = buildTx(
        maker.address,
        maker.wif,
        fundSel.funding,
        [{ script: covenantScript, value: REFUND_VALUE }, ...fundSel.change],
        false
      );
      await broadcast(lockTx.toString());
      await mine(1);
    }
    const covUtxo2 = await utxoByScript(covenantScript);
    expect(covUtxo2).toBeTruthy();

    const buildRefund = () =>
      buildSwapRefundClaimTx(
        { txid: covUtxo2!.txid, vout: covUtxo2!.vout, value: covUtxo2!.value, covenantScript },
        terms,
        p2pkhScript(maker.address),
        makerSwap.wif,
        FEE_RATE
      );

    // ===================== (b) REFUND REJECTED before expiry ================
    {
      const cur = await height();
      expect(cur).toBeLessThan(expiryHeight); // still before the deadline
      const refundTx = buildRefund();
      const r = await tryBroadcast(refundTx.rawTx);
      console.log(`(b) REFUND-before-expiry (height ${cur} < ${expiryHeight}) rejected:`, !r.ok, r.err?.slice(0, 140));
      expect(r.ok).toBe(false); // non-final / CLTV not yet satisfied
    }

    // ===================== (c) REFUND ACCEPTED at/after expiry ==============
    {
      // Mine until the tip is AT the expiry height (nLockTime = expiryHeight
      // becomes final once the next block to be mined is > expiryHeight, i.e.
      // current tip >= expiryHeight).
      let cur = await height();
      if (cur < expiryHeight) await mine(expiryHeight - cur);
      cur = await height();
      expect(cur).toBeGreaterThanOrEqual(expiryHeight);

      const makerBefore = await addrBalance(maker.address);
      const refundTx = buildRefund();
      const r = await tryBroadcast(refundTx.rawTx);
      console.log(`(c) REFUND-after-expiry (height ${cur} >= ${expiryHeight}) accepted:`, r.ok, r.err?.slice(0, 140));
      expect(r.ok).toBe(true);
      await mine(1);
      const gained = (await addrBalance(maker.address)) - makerBefore;
      // Maker reclaims REFUND_VALUE minus the fee taken from it (RXD path).
      expect(gained).toBeGreaterThan(0);
      expect(gained).toBeLessThanOrEqual(REFUND_VALUE);
      console.log(`(c) OK — maker reclaimed ${gained / PHOTONS} RXD via REFUND branch after expiry`);
    }
  },
  600_000
);
