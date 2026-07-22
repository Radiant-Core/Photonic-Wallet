/**
 * "Send & sign" — external TRANSACTION signing for Xetch, the GENERIC path
 * (`#/sign?req=…` where the request carries a `tx` proposal instead of a core
 * intent). Its sibling `SignAction` handles the intent path (post/like/follow),
 * where Xetch names no amounts and this wallet prices everything. Here Xetch
 * proposes a SPEND — a send of RXD — and this wallet's job is to decide, on its
 * own, exactly what that spend does before signing it.
 *
 * The safety model (mirrors SendRXD, not the intent path):
 *   - Provenance: the request must be signed by Xetch (verified in
 *     `parseSignParam` against the pinned signing address) AND come from an
 *     allowlisted origin. A page that merely claims to be Xetch can't get here.
 *   - What moves money is the OUTPUTS. This wallet DECODES every output to an
 *     address + amount (`decodeSendProposal`) and shows them — a redirected or
 *     unreadable recipient is refused, not displayed as trustworthy.
 *   - Funding is OURS, never the request's: we fund the send from our own coins
 *     exactly like the wallet's Send screen (`transferRadiant`), so token-
 *     bearing UTXOs can't be spent as fee/change and the request can't point us
 *     at coins we didn't choose. The proposed `inputs` are ignored.
 *   - C4 confirm: build → show the fee from the SIGNED tx → broadcast only on an
 *     explicit tap. The nonce is consumed at broadcast, so a replay is refused.
 *
 * Like the intent page, effects live here; the protocol/decoding is pure in
 * `connect/txProtocol.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Card,
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
import Card2 from "@app/components/Card";
import DataRow from "@app/components/DataRow";
import db from "@app/db";
import { ContractType } from "@app/types";
import { feeRate, network, openModal, wallet } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import { updateRxdBalances, updateWalletUtxos } from "@app/utxos";
import { p2pkhScript } from "@lib/script";
import { photonsToRXD } from "@lib/format";
import { transferRadiant } from "@lib/transfer";
import type { SelectableInput } from "@lib/coinSelect";
import { useLiveQuery } from "dexie-react-hooks";
import { isNativePlatform } from "@app/platform";
import {
  parseSignParam,
  makeBridgeResponse,
  buildBridgeReturnUrl,
  decodeSendProposal,
  describeSend,
  type SignRequest,
  type DecodedSend,
} from "@app/connect/txProtocol";
import { isNonceConsumed, consumeNonce } from "@app/connect/consumedNonces";
import { scriptToP2pkhAddress } from "@app/connect/scriptDecode";

const DEV = import.meta.env.DEV === true;

/** rjs network string for the wallet's current network. Regtest pairs with a
 *  testnet-mode wallet, so anything non-mainnet decodes with testnet prefixes. */
function rjsNetwork(): "livenet" | "testnet" {
  return wallet.value.net === "mainnet" ? "livenet" : "testnet";
}

/** Decode a locking script to its recipient address, or null if it isn't a
 *  strict P2PKH output. Injected into the pure `decodeSendProposal`. The
 *  strictness (see scriptDecode.ts) is what stops a scriptSig-shaped,
 *  anyone-can-spend script from being shown as an honest recipient. */
function scriptToAddress(scriptHex: string): string | null {
  return scriptToP2pkhAddress(scriptHex, rjsNetwork());
}

interface PendingTx {
  /** Binds the built tx to the request on screen (see confirmBroadcast). */
  nonce: string;
  rawTx: string;
  txid: string;
  /** Photons leaving this wallet = amount sent + fee (change returns to us). */
  debit: number;
  fee: number;
  sending: number;
  /** The coins spent + outputs of the built tx, for post-broadcast reconcile.
   *  Exactly what transferRadiant returns, so updateWalletUtxos accepts it. */
  selected: ReturnType<typeof transferRadiant>["selected"];
}

type Phase =
  | { k: "invalid"; reason: string }
  | { k: "native" }
  | { k: "verifying" }
  | { k: "review"; plan: DecodedSend }
  | { k: "refused"; reason: string; respond: "rejected" | "expired" }
  | { k: "returning" };

export default function SignTxAction() {
  const [searchParams] = useSearchParams();
  const toast = useToast();

  const parsed = useMemo(
    () => parseSignParam(searchParams.get("req"), { net: wallet.value.net, dev: DEV }),
    [searchParams],
  );

  const initialPhase = useCallback(
    (): Phase =>
      isNativePlatform()
        ? { k: "native" }
        : parsed.ok
          ? { k: "verifying" }
          : { k: "invalid", reason: parsed.reason },
    [parsed],
  );
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [pendingTx, setPendingTx] = useState<PendingTx | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [building, setBuilding] = useState(false);
  const broadcasting = useRef(false);

  // Our spendable RXD coins — the funding set. Never the request's inputs.
  const rxd = useLiveQuery(
    () => db.txo.where({ contractType: ContractType.RXD, spent: 0 }).toArray(),
    [],
  );

  // A hash-nav from one request to another does not remount this route; re-seed
  // everything (and drop any built-but-unbroadcast tx) when the request changes.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setPhase(initialPhase());
    setPendingTx(null);
    setConfirmOpen(false);
  }, [initialPhase]);

  const req: SignRequest | null = parsed.ok ? parsed.req : null;
  const proposal = req?.tx ?? null;

  const returnWith = useCallback(
    (status: "rejected" | "expired") => {
      if (!req) return;
      setPhase({ k: "returning" });
      void makeBridgeResponse(req, { txid: "", status }).then((res) =>
        window.location.assign(buildBridgeReturnUrl(req, res, { dev: DEV })),
      );
    },
    [req],
  );

  const expired = () => req !== null && Math.floor(Date.now() / 1000) > req.expiry + 30;

  // ---- verify the proposal (no keys involved) ------------------------------
  useEffect(() => {
    if (!req || !proposal || phase.k !== "verifying") return;

    if (isNonceConsumed(req.nonce)) {
      setPhase({
        k: "refused",
        reason: "This request was already used. If you meant to do this again, start a fresh send on the site.",
        respond: "rejected",
      });
      return;
    }

    // The connected address must be OURS. This page spends — refuse, don't warn.
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

    // Network must match, exactly for mainnet. Signing on the wrong network would
    // pay addresses that don't exist there.
    const txNet = proposal.network;
    const walletNet = wallet.value.net;
    const compatible =
      (txNet === "mainnet" && walletNet === "mainnet") ||
      (txNet !== "mainnet" && walletNet === "testnet");
    if (!compatible) {
      setPhase({
        k: "refused",
        reason: `Network mismatch: the request is for ${txNet}, this wallet is on ${walletNet}.`,
        respond: "rejected",
      });
      return;
    }

    const decoded = decodeSendProposal(proposal, scriptToAddress);
    if (!decoded.ok) {
      setPhase({ k: "refused", reason: decoded.reason, respond: "rejected" });
      return;
    }
    // Phase 1 funds a single recipient via the Send path. Multi-recipient sends
    // are a later addition — refuse clearly rather than silently drop outputs.
    if (decoded.plan.recipients.length !== 1) {
      setPhase({
        k: "refused",
        reason: "This wallet can't sign a multi-recipient send yet — send them one at a time.",
        respond: "rejected",
      });
      return;
    }

    setPhase({ k: "review", plan: decoded.plan });
  }, [req, proposal, phase.k]);

  // ---- build + sign (keys, behind the unlock gate) -------------------------
  const buildAndConfirm = useCallback(async () => {
    if (!req || !proposal || phase.k !== "review" || building) return;
    if (expired()) {
      setPhase({ k: "refused", reason: "This request expired before it was signed.", respond: "expired" });
      return;
    }
    if (!rxd) {
      toast({ title: "Still loading your coins — try again in a moment", status: "warning" });
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
      const { plan } = phase;
      const recipient = plan.recipients[0];
      // Sign EXACTLY what we showed: rebuild the recipient script from the
      // DECODED address, not the request's raw output bytes. The decode already
      // proved it's a strict p2pkh output, so this is byte-identical for an
      // honest request — and for a hostile one it guarantees the coins go to the
      // address on the confirm screen, never to some other script that merely
      // decoded to a look-alike. Funding is our own coins (transferRadiant).
      const recipientScript = p2pkhScript(recipient.address);
      const value = Number(recipient.value);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error("The amount to send is out of range.");
      }

      const coins: SelectableInput[] = rxd.slice();
      const { tx, selected } = transferRadiant(
        coins,
        wallet.value.address,
        recipientScript,
        value,
        feeRate.value,
        wallet.value.wif.toString(),
      );

      const rawTx = tx.toString();
      const txid = tx.hash;
      const inputTotal = selected.inputs.reduce((s, i) => s + i.value, 0);
      const outputTotal = selected.outputs.reduce((s, o) => s + o.value, 0);
      const fee = inputTotal - outputTotal;
      const ownScript = p2pkhScript(wallet.value.address);
      const changeVal = selected.outputs
        .filter((o) => o.script === ownScript)
        .reduce((s, o) => s + o.value, 0);
      const debit = inputTotal - changeVal;

      setPendingTx({ nonce: req.nonce, rawTx, txid, debit, fee, sending: value, selected });
      setConfirmOpen(true);
    } catch (e) {
      toast({ title: "Couldn't build the transaction", description: (e as Error).message, status: "error" });
    } finally {
      setBuilding(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, proposal, phase, building, rxd, toast]);

  const cancelConfirm = () => {
    setConfirmOpen(false);
    setPendingTx(null);
  };

  // ---- broadcast + return ---------------------------------------------------
  const confirmBroadcast = async () => {
    if (!req || !pendingTx || broadcasting.current) return;
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
    // Consume BEFORE the network call: once we commit to broadcasting, a replay
    // must be refused even if we crash mid-send.
    consumeNonce(req.nonce);
    try {
      const broadcastTxid = await electrumWorker.value.broadcast(pendingTx.rawTx);
      const txid = broadcastTxid || pendingTx.txid;
      db.broadcast.put({ txid, date: Date.now(), description: "xetch_send", amount: pendingTx.debit });

      const ownScript = p2pkhScript(wallet.value.address);
      await updateWalletUtxos(
        ContractType.RXD,
        ownScript,
        ownScript,
        txid,
        pendingTx.selected.inputs,
        pendingTx.selected.outputs,
      );
      await updateRxdBalances(wallet.value.address);

      setConfirmOpen(false);
      setPhase({ k: "returning" });
      const res = await makeBridgeResponse(req, { txid, status: "ok" });
      window.location.assign(buildBridgeReturnUrl(req, res, { dev: DEV }));
    } catch (e) {
      toast({ title: "Broadcast failed", description: (e as Error).message, status: "error" });
      broadcasting.current = false;
    }
  };

  // ---- render ---------------------------------------------------------------
  if (phase.k === "native") {
    return (
      <Container maxW="container.md" py={8}>
        <Card2 p={6}>
          <Heading size="md" mb={3}>Signing for apps isn't available here yet</Heading>
          <Text color="text.muted">
            Approving app transactions works in the web and desktop wallet for now. Open the
            request on your computer instead.
          </Text>
        </Card2>
      </Container>
    );
  }

  if (phase.k === "invalid") {
    return (
      <Container maxW="container.md" py={8}>
        <Card2 p={6}>
          <Heading size="md" mb={3}>Can't sign this request</Heading>
          <Alert status="error" borderRadius="md">
            <AlertIcon />
            <AlertDescription>{phase.reason}</AlertDescription>
          </Alert>
        </Card2>
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
        <Card2 p={6}>
          <Heading size="md" mb={3}>Not signing this</Heading>
          <Alert status="warning" borderRadius="md" mb={4}>
            <AlertIcon />
            <AlertDescription>{phase.reason}</AlertDescription>
          </Alert>
          <Button onClick={() => returnWith(phase.respond)}>Return to {req?.origin}</Button>
        </Card2>
      </Container>
    );
  }

  if (phase.k === "verifying" || !req || !proposal) {
    return (
      <Container maxW="container.md" py={8}>
        <Flex justify="center" align="center" gap={3} py={12}>
          <Spinner /> <Text>Checking this request…</Text>
        </Flex>
      </Container>
    );
  }

  const { plan } = phase;
  const ticker = network.value.ticker;
  const toRXD = (p: bigint) => photonsToRXD(Number(p));

  return (
    <Container maxW="container.md" py={8}>
      <Heading size="md" mb={4}>Send &amp; sign</Heading>
      <Card2 p={6} mb={4}>
        <Box mb={4}>
          <Text textStyle="label" mb={1}>Signing for</Text>
          <Code w="100%" p={2} borderRadius="md" wordBreak="break-all">{req.origin}</Code>
          <Text color="text.muted" fontSize="xs" mt={1}>
            Any website can open this screen. Only continue if you just started this send
            on {req.origin}.
          </Text>
        </Box>
        <Box mb={4}>
          <Text textStyle="label" mb={1}>Action</Text>
          <Text fontWeight="bold">{describeSend(plan, ticker, toRXD)}</Text>
        </Box>
        <Divider my={3} />
        <VStack align="stretch" spacing={1}>
          {plan.recipients.map((r, i) => (
            <DataRow key={i} label="Recipient">
              <Text sx={{ fontVariantNumeric: "tabular-nums" }} wordBreak="break-all">
                {toRXD(r.value)} {ticker} → {r.address}
              </Text>
            </DataRow>
          ))}
        </VStack>
        <Divider my={3} />
        <Alert status="info" borderRadius="md">
          <AlertIcon />
          <AlertDescription fontSize="sm">
            This wallet funds the send from your own coins and shows the exact network fee on
            the next screen, computed from the signed transaction itself.
          </AlertDescription>
        </Alert>
      </Card2>
      <Flex gap={3}>
        <Button variant="primary" isLoading={building} onClick={() => void buildAndConfirm()}>
          Continue
        </Button>
        <Button onClick={() => returnWith("rejected")}>Decline</Button>
      </Flex>

      {/* C4: confirm the BUILT transaction; broadcast only on the tap. */}
      <Modal closeOnOverlayClick={false} isOpen={confirmOpen} onClose={cancelConfirm} isCentered>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>Confirm send</ModalHeader>
          <ModalBody>
            <VStack align="stretch" spacing={3}>
              <Box>
                {plan.recipients.map((r, i) => (
                  <DataRow key={i} label="Recipient">
                    <Text sx={{ fontVariantNumeric: "tabular-nums" }} wordBreak="break-all">
                      {toRXD(r.value)} {ticker} → {r.address}
                    </Text>
                  </DataRow>
                ))}
                <DataRow label="Network fee">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {pendingTx && photonsToRXD(pendingTx.fee)} {ticker}
                  </Text>
                </DataRow>
                <DataRow label="Total leaving this wallet">
                  <Text sx={{ fontVariantNumeric: "tabular-nums" }} fontWeight="bold">
                    {pendingTx && photonsToRXD(pendingTx.debit)} {ticker}
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
