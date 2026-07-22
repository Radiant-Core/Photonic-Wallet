/**
 * Strict locking-script → address decoding for the tx-signing confirm screen.
 *
 * WHY THIS IS ITS OWN MODULE (and tested): `SignTxAction` must show the user the
 * REAL recipient of an output before they approve a spend. The obvious
 * `new rjs.Script(hex).toAddress(net)` is UNSAFE for this: radiantjs's
 * `getAddressInfo()` first tries OUTPUT classification and, on failure, FALLS
 * BACK to INPUT classification. A crafted scriptSig-shaped locking script —
 * `<push sig> <push pubkey>` — fails the output test, then matches
 * `isPublicKeyHashIn`, and `toAddress()` returns `hash160(pubkey)` as an honest-
 * looking P2PKH address. But as a *locking* script that is anyone-can-spend
 * (it leaves a truthy pubkey on the stack): the confirm screen would show a
 * legitimate — even exactly-correct — recipient while the coins land in a script
 * anyone can sweep from the mempool.
 *
 * So we gate on a strict P2PKH-OUTPUT template FIRST (`parseP2pkhScript`, an
 * anchored `^76a914<h160>88ac$` regex that the spoof can't match), and only then
 * ask rjs to encode the address. Anything that isn't a canonical p2pkh output —
 * P2SH, bare pubkey, token/covenant scripts, the scriptSig spoof — returns null
 * and the caller refuses the request.
 */
import rjs from "@radiant-core/radiantjs";
import { parseP2pkhScript } from "@lib/script";

/**
 * The address a locking script pays, but ONLY when the script is a strict P2PKH
 * output template. Returns null for everything else (fail-closed). `net` is the
 * rjs network string ("livenet" | "testnet").
 */
export function scriptToP2pkhAddress(scriptHex: string, net: "livenet" | "testnet"): string | null {
  const hex = (scriptHex || "").toLowerCase();
  // Unspoofable gate: an anchored p2pkh-OUTPUT match. A <sig><pubkey> scriptSig
  // shape (or any non-p2pkh-out script) fails here and never reaches toAddress().
  if (!parseP2pkhScript(hex).address) return null;
  try {
    const addr = new rjs.Script(hex).toAddress(net);
    return addr ? addr.toString() : null;
  } catch {
    return null;
  }
}
