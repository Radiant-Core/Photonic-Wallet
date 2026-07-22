/**
 * "Sign & pay" — external TRANSACTION signing for Xetch (`#/sign?req=…`).
 *
 * This page spends money on behalf of a third-party site, which `/connect`
 * deliberately never does — its promise ("cannot spend your funds") stays true
 * because this is a separate route with a separate protocol module
 * (`connect/txProtocol.ts`, hardcoded first-party allowlist).
 *
 * The trust model, end to end:
 *   - The request carries only the action INTENT (a XetchCore). No amounts, no
 *     inputs, no fee — the contract refuses to even represent them.
 *   - Every value that moves money is derived HERE: price from the canonical
 *     pricing table (`@xetch/bridge-kit`, the same package Xetch itself uses)
 *     at a rate fetched from the Xetch API by US; recipients from the priced
 *     action; funding from our own UTXO set (token-burn backstop intact);
 *     change to our own address; fee bounded by the shared fee guard.
 *   - The human confirmation screen renders what WE computed, never what the
 *     request said, and signing happens only on an explicit tap (the C4
 *     pattern from SendRXD: build → show → confirm → broadcast, with a
 *     double-submit guard and no stale pendingTx reuse).
 *   - The response back to Xetch is `{txid, status}` plus a MAC keyed by the
 *     request's replyKey. Xetch independently confirms the txid on-chain; the
 *     MAC only stops a stray response landing in the wrong tab.
 *
 * Fail-closed rules: unpriceable rate → refuse; unknown action → refuse;
 * network mismatch → refuse; address not ours → refuse; expired → refuse.
 * "Refuse" always offers the user a way to send a `rejected`/`expired`
 * response home, so the requesting tab is never left hanging.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Code,
  Container,
  Divider,
  Flex,
  Heading,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Spinner,
  Text,
  VStack,
  useToast,
} from "@chakra-ui/react";
import rjs from "@radiant-core/radiantjs";
import {
  buildPostTx,
  computePayments,
  verifyPayments,
  pricedActionOf,
  type ComputedPayments,
  type SignRequest,
} from "@xetch/bridge-kit";
import Card from "@app/components/Card";
import DataRow from "@app/components/DataRow";
import db from "@app/db";
import { ContractType, type TxO } from "@app/types";
import { feeRate, network, openModal, wallet } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import { updateRxdBalances, updateWalletUtxos } from "@app/utxos";
import { p2pkhScript } from "@lib/script";
import { photonsToRXD } from "@lib/format";
import { withWif } from "@app/wallet";
import { isNativePlatform } from "@app/platform";
import {
  parseSignParam,
  describeSignAction,
  signedPayloadDetails,
  makeBridgeResponse,
  buildBridgeReturnUrl,
} from "@app/connect/txProtocol";
import { isNonceConsumed, consumeNonce } from "@app/connect/consumedNonces";
import type { SelectableInput } from "@lib/coinSelect";
import type { UnfinalizedInput } from "@lib/types";

const DEV = import.meta.env.DEV === true;
/** Bound both API fetches; a hung request must not hold a spend page open. */
const FETCH_TIMEOUT_MS = 10_000;

/** Fetch JSON from the REQUESTING site's API with a hard timeout. The response
 *  is data from an allowlisted-but-untrusted party: callers validate every
 *  field they read. */
async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(t);
  }
}

interface Priced {
  payments: ComputedPayments;
  photonsPerUsd: bigint;
  platformAddress: string;
  /** Content author being paid, when the action pays one. */
  authorAddress?: string;
  /** Xetch's network — also the network we build the tx for. */
  xetchNetwork: "mainnet" | "testnet" | "regtest";
}

interface PendingTx {
  /** The nonce of the request this tx was built for. Broadcasting checks it
   *  still matches the CURRENT request: a hash-nav to a new /sign?req= (or an
   *  unlock completing after the request changed) must never broadcast a tx
   *  built for request A while the screen now shows request B. */
  nonce: string;
  rawTx: string;
  txid: string;
  /** photons leaving this wallet (payments + data output), excluding change. */
  debit: bigint;
  fee: bigint;
  /** The inputs we spent, resolved back to our own db rows for reconcile. */
  spentInputs: SelectableInput[];
  outputs: UnfinalizedInput[];
}

type Phase =
  | { k: "invalid"; reason: string }
  | { k: "native" }
  | { k: "pricing" }
  | { k: "review"; priced: Priced }
  | { k: "refused"; reason: string; respond: "rejected" | "expired" }
  | { k: "returning" };

export default function SignAction() {
  const [searchParams] = useSearchParams();
  const toast = useToast();

  // Parse ONCE per param value. Everything downstream keys off this. The dev
  // flag admits localhost origins in dev builds only — the branch is compiled
  // out of production, not merely configured off.
  // net selects which pinned Xetch signing address the provenance check
  // verifies against — mainnet in prod, testnet for a dev/test stack.
  const parsed = useMemo(
    () => parseSignParam(searchParams.get("req"), { net: wallet.value.net, dev: DEV }),
    [searchParams, wallet.value.net],
  );

  const initialPhase = useCallback(
    (): Phase =>
      isNativePlatform()
        ? { k: "native" }
        : parsed.ok
          ? { k: "pricing" }
          : { k: "invalid", reason: parsed.reason },
    [parsed],
  );
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const broadcasting = useRef(false);

  // Hash navigation from one sign request to another does NOT remount this
  // route, so state seeded from the first request would narrate the second —
  // including showing a previous verdict for a fresh request (or vice versa).
  // Re-derive everything whenever the parsed request changes, and drop any
  // built-but-unbroadcast tx: it belongs to the OLD request.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return; // the useState initializer already handled this request
    }
    setPhase(initialPhase());
    setPendingTx(null);
    setConfirmOpen(false);
  }, [initialPhase]);

  const req: SignRequest | null = parsed.ok ? parsed.req : null;

  /** Leave for the requesting site with a MAC'd non-ok outcome. Used by every
   *  refusal path so the opener tab is never left waiting out its timeout. */
  const returnWith = useCallback(
    (status: "rejected" | "expired") => {
      if (!req) return; // nothing to respond to — the request never parsed
      setPhase({ k: "returning" });
      void makeBridgeResponse(req, { txid: "", status }).then((res) =>
        window.location.assign(buildBridgeReturnUrl(req, res, { dev: DEV })),
      );
    },
    [req],
  );

  const expired = () =>
    req !== null && Math.floor(Date.now() / 1000) > req.expiry + 30;

  // ---- price the action (no keys involved) --------------------------------
  useEffect(() => {
    if (!req || phase.k !== "pricing") return;
    let live = true;
    (async () => {
      // Replay guard: a request we've already broadcast for is dead. The nonce
      // is consumed at broadcast (not here), so a benign reload of an un-sent
      // request still works — only a genuine re-fire of a settled one is caught.
      if (isNonceConsumed(req.nonce)) {
        setPhase({
          k: "refused",
          reason: "This request was already used. If you meant to do this again, start a fresh action on the site.",
          respond: "rejected",
        });
        return;
      }

      // The connected address must be OURS. A request naming someone else's
      // address is at best a stale session, at worst a confusion attack —
      // either way we refuse rather than warn: this page spends.
      if (req.address !== wallet.value.address) {
        setPhase({
          k: "refused",
          reason:
            "This request is for a different wallet address than the one loaded here. " +
            "Reconnect on the requesting site with this wallet, then try again.",
          respond: "rejected",
        });
        return;
      }

      const action = pricedActionOf(req.core);
      if (!action) {
        setPhase({ k: "refused", reason: `This wallet can't price a “${req.core.t}” action yet.`, respond: "rejected" });
        return;
      }

      let cfg: { platformAddress?: unknown; network?: unknown; photonsPerUsd?: unknown };
      try {
        cfg = (await fetchJson(`${req.origin}/api/config`)) as typeof cfg;
      } catch (e) {
        // Don't stamp a refusal onto a request that's already been superseded
        // by a newer one (hash-nav mid-flight) — this catch runs after an await.
        if (live) setPhase({ k: "refused", reason: `Couldn't reach ${req.origin} for pricing: ${(e as Error).message}`, respond: "rejected" });
        return;
      }
      if (!live) return;

      const xetchNetwork = cfg.network;
      if (xetchNetwork !== "mainnet" && xetchNetwork !== "testnet" && xetchNetwork !== "regtest") {
        setPhase({ k: "refused", reason: "The requesting site reported an unknown network.", respond: "rejected" });
        return;
      }
      // regtest shares testnet's address encoding, which is how a dev stack
      // pairs with a testnet-mode wallet. Mainnet must be mainnet, exactly.
      const walletNet = wallet.value.net;
      const compatible =
        (xetchNetwork === "mainnet" && walletNet === "mainnet") ||
        (xetchNetwork !== "mainnet" && walletNet === "testnet");
      if (!compatible) {
        setPhase({
          k: "refused",
          reason: `Network mismatch: the site is on ${xetchNetwork}, this wallet is on ${walletNet}. Signing would pay addresses on the wrong network.`,
          respond: "rejected",
        });
        return;
      }

      // Fail CLOSED on price: an unpriceable action is not a free action.
      if (typeof cfg.photonsPerUsd !== "string" || cfg.photonsPerUsd === "") {
        setPhase({ k: "refused", reason: "The site has no live RXD/USD rate right now — refusing to sign at an unknown price.", respond: "rejected" });
        return;
      }
      let photonsPerUsd: bigint;
      try {
        photonsPerUsd = BigInt(cfg.photonsPerUsd);
        if (photonsPerUsd <= 0n) throw new Error("non-positive");
      } catch {
        setPhase({ k: "refused", reason: "The site reported an invalid RXD/USD rate.", respond: "rejected" });
        return;
      }
      if (typeof cfg.platformAddress !== "string" || cfg.platformAddress.length === 0) {
        setPhase({ k: "refused", reason: "The site reported no platform address.", respond: "rejected" });
        return;
      }

      // Who gets the author's cut. follow carries the address directly; the
      // parent-post actions need one lookup — from the site's own API, shown
      // to the human below. A lie here redirects the AUTHOR cut to another
      // Xetch account, and the confirmation screen shows the address; it can
      // never touch our funding, change, or fee.
      let authorAddress: string | undefined;
      if (req.core.t === "follow") {
        authorAddress = req.core.target;
      } else if (req.core.parent) {
        try {
          const post = (await fetchJson(`${req.origin}/api/post/${encodeURIComponent(req.core.parent)}`)) as {
            post?: { author?: unknown };
          };
          if (typeof post?.post?.author !== "string" || post.post.author.length === 0) {
            throw new Error("no author on the target post");
          }
          authorAddress = post.post.author;
        } catch (e) {
          if (live) setPhase({ k: "refused", reason: `Couldn't resolve who this action pays: ${(e as Error).message}`, respond: "rejected" });
          return;
        }
      }
      if (!live) return;

      const payments = computePayments({
        action,
        photonsPerUsd,
        platformAddress: cfg.platformAddress,
        authorAddress,
      });

      setPhase({ k: "review", priced: { payments, photonsPerUsd, platformAddress: cfg.platformAddress, authorAddress, xetchNetwork } });
    })().catch((e) => {
      if (live) setPhase({ k: "refused", reason: (e as Error).message, respond: "rejected" });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, phase.k]);

  // ---- build + sign (keys, behind the unlock gate) -------------------------
  const buildAndConfirm = useCallback(async () => {
    if (!req || phase.k !== "review" || building) return;
    if (expired()) {
      setPhase({ k: "refused", reason: "This request expired before it was signed.", respond: "expired" });
      return;
    }
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = {
        modal: "unlock",
        onClose: (unlocked: boolean) => {
          if (unlocked) void buildAndConfirm();
        },
      };
      return;
    }

    setBuilding(true);
    try {
      const { priced } = phase;
      // OUR view of spendable coins — never the request's. Token-bearing UTXOs
      // are not in the RXD table, and bridge-kit's selector re-screens anyway.
      const txos = await db.txo.where({ contractType: ContractType.RXD, spent: 0 }).toArray();
      const utxoById = new Map<string, TxO>();
      for (const t of txos) utxoById.set(`${t.txid}:${t.vout}`, t);

      const built = withWif((wif) =>
        buildPostTx({
          core: req.core,
          wif,
          utxos: txos.map((t) => ({ txid: t.txid, vout: t.vout, value: BigInt(t.value), script: t.script })),
          payments: priced.payments.outputs,
          feeRate: BigInt(Math.max(1, Math.floor(feeRate.value))),
          network: priced.xetchNetwork,
        }),
      );
      if (!built) throw new Error("Wallet is locked");

      // Belt-and-suspenders: judge our own tx by the same rule the server
      // applies at ingest — but against the SIGNED tx's outputs, not the list we
      // asked the builder for. Verifying the computed list only proves
      // computePayments agrees with itself; deriving the payouts from the built
      // scripts proves the tx we're about to broadcast actually pays them, so a
      // builder that dropped or altered an output is caught here, not on chain.
      const action = pricedActionOf(req.core);
      const builtPayouts = priced.payments.outputs.map((o) => {
        const script = p2pkhScript(o.address);
        const value = built.outputs.filter((b) => b.script === script).reduce((s, b) => s + b.value, 0n);
        return { address: o.address, value };
      });
      const verdict = verifyPayments({
        action: action!,
        photonsPerUsd: priced.photonsPerUsd,
        platformAddress: priced.platformAddress,
        authorAddress: priced.authorAddress,
        payouts: builtPayouts,
        selfAction: priced.authorAddress === wallet.value.address,
      });
      if (!verdict.ok) throw new Error(`self-check failed: ${verdict.reason}`);

      // Recover which of OUR coins the builder spent, from the signed tx
      // itself — the ground truth — so the confirm screen's fee is
      // inputs − outputs of the real transaction, not an estimate.
      const parsedTx = new rjs.Transaction(built.hex);
      const spentInputs: SelectableInput[] = [];
      let inputTotal = 0n;
      for (const input of parsedTx.inputs) {
        const key = `${input.prevTxId.toString("hex")}:${input.outputIndex}`;
        const row = utxoById.get(key);
        if (!row) throw new Error(`built tx spends a coin we don't recognise (${key})`);
        spentInputs.push(row as unknown as SelectableInput);
        inputTotal += BigInt(row.value);
      }
      const outputTotal = built.outputs.reduce((s, o) => s + o.value, 0n);
      const fee = inputTotal - outputTotal;
      const ownScript = p2pkhScript(wallet.value.address);
      const changeBack = built.outputs
        .filter((o) => o.script === ownScript)
        .reduce((s, o) => s + o.value, 0n);
      const debit = inputTotal - changeBack;

      setPendingTx({
        nonce: req.nonce, // bind the built tx to THIS request (see confirmBroadcast)
        rawTx: built.hex,
        txid: built.txid,
        debit,
        fee,
        spentInputs,
        outputs: built.outputs.map((o) => ({ script: o.script, value: Number(o.value) })) as UnfinalizedInput[],
      });
      setConfirmOpen(true);
    } catch (e) {
      toast({ title: "Couldn't build the transaction", description: (e as Error).message, status: "error" });
    } finally {
      setBuilding(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, phase, building, toast]);

  // Never carry a built-but-unbroadcast tx across a close (C4).
  const cancelConfirm = () => {
    setConfirmOpen(false);
    setPendingTx(null);
  };

  // ---- broadcast + return ---------------------------------------------------
  const confirmBroadcast = async () => {
    if (!req || !pendingTx || broadcasting.current) return;
    // The built tx must belong to the request now on screen. If they diverged
    // (a hash-nav to a new request, or an unlock that completed after the
    // request changed), refuse rather than broadcast tx A while showing B.
    if (pendingTx.nonce !== req.nonce) {
      cancelConfirm();
      toast({ title: "This request changed — build it again", status: "warning" });
      return;
    }
    if (expired()) {
      cancelConfirm();
      setPhase({ k: "refused", reason: "This request expired before it was broadcast.", respond: "expired" });
      return;
    }
    broadcasting.current = true;
    // Consume the nonce BEFORE the network call: once we commit to broadcasting
    // this request, a replay of it must be refused even if we crash mid-send.
    consumeNonce(req.nonce);
    try {
      const broadcastTxid = await electrumWorker.value.broadcast(pendingTx.rawTx);
      const txid = broadcastTxid || pendingTx.txid;
      db.broadcast.put({ txid, date: Date.now(), description: "xetch_sign", amount: Number(pendingTx.debit) });

      // Mark spent coins + record change immediately, or these coins stay
      // selectable and the next action double-spends them (same fix as
      // SendRXD). The Electrum subscription will reconcile heights later.
      const ownScript = p2pkhScript(wallet.value.address);
      await updateWalletUtxos(ContractType.RXD, ownScript, ownScript, txid, pendingTx.spentInputs, pendingTx.outputs);
      await updateRxdBalances(wallet.value.address);

      setConfirmOpen(false);
      setPhase({ k: "returning" });
      const res = await makeBridgeResponse(req, { txid, status: "ok" });
      window.location.assign(buildBridgeReturnUrl(req, res, { dev: DEV }));
    } catch (e) {
      toast({ title: "Broadcast failed", description: (e as Error).message, status: "error" });
      broadcasting.current = false; // only re-arm on failure — success navigates away
    }
  };

  // ---- render ---------------------------------------------------------------
  if (phase.k === "native") {
    return (
      <Container maxW="container.md" py={8}>
        <Card p={6}>
          <Heading size="md" mb={3}>Signing for apps isn't available here yet</Heading>
          <Text color="text.muted">
            Approving app transactions works in the web and desktop wallet for now — the
            app has no way to hand you back to the site that asked. Open the request on
            your computer instead.
          </Text>
        </Card>
      </Container>
    );
  }

  if (phase.k === "invalid") {
    // No valid request ⇒ nothing trustworthy to respond to; just explain.
    return (
      <Container maxW="container.md" py={8}>
        <Card p={6}>
          <Heading size="md" mb={3}>Can't sign this request</Heading>
          <Alert status="error" borderRadius="md">
            <AlertIcon />
            <AlertDescription>{phase.reason}</AlertDescription>
          </Alert>
        </Card>
      </Container>
    );
  }

  if (phase.k === "returning") {
    return (
      <Container maxW="container.md" py={8}>
        <Flex justify="center" align="center" gap={3} py={12}>
          <Spinner /> <Text>Returning you to {req?.origin}…</Text>
        </Flex>
      </Container>
    );
  }

  if (phase.k === "refused") {
    return (
      <Container maxW="container.md" py={8}>
        <Card p={6}>
          <Heading size="md" mb={3}>Not signing this</Heading>
          <Alert status="warning" borderRadius="md" mb={4}>
            <AlertIcon />
            <AlertDescription>{phase.reason}</AlertDescription>
          </Alert>
          <Button onClick={() => returnWith(phase.respond)}>Return to {req?.origin}</Button>
        </Card>
      </Container>
    );
  }

  if (phase.k === "pricing" || !req) {
    return (
      <Container maxW="container.md" py={8}>
        <Flex justify="center" align="center" gap={3} py={12}>
          <Spinner /> <Text>Checking what this action costs…</Text>
        </Flex>
      </Container>
    );
  }

  const { priced } = phase;
  const roleLabel: Record<string, string> = {
    author: "Content author",
    platform: "Xetch platform fee",
    mention: "Mention",
    pay: "Payment",
  };
  const details = signedPayloadDetails(req.core);

  return (
    <Container maxW="container.md" py={8}>
      <Heading size="md" mb={4}>Sign &amp; pay</Heading>
      <Card p={6} mb={4}>
        <Box mb={4}>
          {/* HONEST attribution: we verified the request TALKS TO this origin
              (allowlisted; every fetch and the reply go there) — we did NOT
              verify a page there initiated it. `origin` is attacker-writable, so
              "requested by" would assert provenance we can't prove. */}
          <Text textStyle="label" mb={1}>Signing for</Text>
          <Code w="100%" p={2} borderRadius="md" wordBreak="break-all">{req.origin}</Code>
          <Text color="text.muted" fontSize="xs" mt={1}>
            Any website can open this screen. Only continue if you just started this
            action on {req.origin}.
          </Text>
        </Box>
        <Box mb={4}>
          <Text textStyle="label" mb={1}>Action</Text>
          <Text fontWeight="bold">{describeSignAction(req.core)}</Text>
          {details.map((d, i) => (
            <DataRow key={i} label={d.label}>
              <Text fontSize="sm" wordBreak="break-all">{d.value}</Text>
            </DataRow>
          ))}
        </Box>
        <Divider my={3} />
        <VStack align="stretch" spacing={1}>
          {priced.payments.outputs.map((o, i) => (
            <DataRow key={i} label={roleLabel[o.role] ?? o.role}>
              <Text sx={{ fontVariantNumeric: "tabular-nums" }} wordBreak="break-all">
                {photonsToRXD(Number(o.value))} {network.value.ticker} → {o.address}
              </Text>
            </DataRow>
          ))}
          {priced.payments.outputs.length === 0 && (
            <Text color="text.muted">No payment outputs — this action only pays the network fee.</Text>
          )}
        </VStack>
        <Divider my={3} />
        <Alert status="info" borderRadius="md">
          <AlertIcon />
          <AlertDescription fontSize="sm">
            These amounts were priced by this wallet from Xetch's public rate — the site
            sent only the action, never the numbers. The exact network fee is shown on the
            next screen, from the built transaction itself.
          </AlertDescription>
        </Alert>
      </Card>
      <Flex gap={3}>
        <Button variant="primary" isLoading={building} onClick={() => void buildAndConfirm()}>
          Continue
        </Button>
        <Button onClick={() => returnWith("rejected")}>Decline</Button>
      </Flex>

      {/* SECURITY (C4): confirm the BUILT transaction; broadcast only on the tap. */}
      <Modal closeOnOverlayClick={false} isOpen={confirmOpen} onClose={cancelConfirm} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>Confirm transaction</ModalHeader>
          <ModalBody>
            <VStack align="stretch" spacing={3}>
              <Box>
                <DataRow label="Action">
                  <Text>{describeSignAction(req.core)}</Text>
                </DataRow>
                {details.map((d, i) => (
                  <DataRow key={`d${i}`} label={d.label}>
                    <Text fontSize="sm" wordBreak="break-all">{d.value}</Text>
                  </DataRow>
                ))}
                {priced.payments.outputs.map((o, i) => (
                  <DataRow key={i} label={roleLabel[o.role] ?? o.role}>
                    <Text sx={{ fontVariantNumeric: "tabular-nums" }} wordBreak="break-all">
                      {photonsToRXD(Number(o.value))} {network.value.ticker} → {o.address}
                    </Text>
                  </DataRow>
                ))}
                <DataRow label="Network fee">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {pendingTx && photonsToRXD(Number(pendingTx.fee))} {network.value.ticker}
                  </Text>
                </DataRow>
                <DataRow label="Total leaving this wallet">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }} fontWeight="bold">
                    {pendingTx && photonsToRXD(Number(pendingTx.debit))} {network.value.ticker}
                  </Text>
                </DataRow>
                <DataRow label="TxID">
                  <Text fontSize="xs" color="text.muted" wordBreak="break-all">{pendingTx?.txid}</Text>
                </DataRow>
              </Box>
              <Divider my={2} />
              <Alert status="warning" borderRadius="md">
                <AlertIcon />
                <AlertDescription>
                  Broadcasting is irreversible. The fee above is computed from the signed
                  transaction (inputs − outputs), so nothing is hidden in it.
                </AlertDescription>
              </Alert>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="primary" isLoading={broadcasting.current} onClick={() => void confirmBroadcast()} mr={4}>
              Confirm &amp; broadcast
            </Button>
            <Button onClick={cancelConfirm}>Cancel</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Container>
  );
}
