/**
 * "Connect" — external-wallet connect for dApps.
 *
 * Two request types share this page (see `@app/connect/protocol`):
 *
 *  - `sign-request` (Phase A, GlyphGalaxy `docs/WALLET_CONNECT_SCOPE.md`): a
 *    dApp obtains a signed proof of address ownership WITHOUT the user ever
 *    exposing their seed. Signs ONLY a magic-prefixed message via `@lib/sign`
 *    — never a transaction.
 *  - `psbt-sign-request` (`docs/psbt.md`): a dApp hands over a Radiant PSBT.
 *    The approval screen (`PsbtRequestPanel`) shows every input and output
 *    before anything is signed; the wallet signs only its own plain P2PKH
 *    inputs (`@app/connect/psbtFlow`) and either returns the (possibly still
 *    partial) signed PSBT or — only if the request opted in with
 *    `broadcast: true` and every input ends up signed — broadcasts and
 *    returns a txid.
 *
 * Both arrive over the same out-of-band transport (QR / paste / deep-link
 * `#/connect?req=...`). This page is the human approval gate: nothing is
 * signed until explicit approval (unlocking first if needed), and no key
 * ever leaves the wallet's transient `withWif` frame.
 *
 * A deep-linked request may opt in to an automatic return by carrying a
 * `callback` URL, in which case approval navigates this tab back to the
 * requesting site with the result in the fragment (`canAutoReturn` below,
 * `buildCallbackUrl` / `buildPsbtCallbackUrl` in `@app/connect/protocol`).
 * Everything else is unchanged: a request without one — or one whose
 * callback failed origin-binding — returns the result by copy/paste or QR.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Box,
  Button,
  Code,
  Container,
  Divider,
  Flex,
  HStack,
  Heading,
  Spinner,
  Stack,
  Text,
  Textarea,
  VStack,
  useClipboard,
  useToast,
} from "@chakra-ui/react";
import {
  MdCheck,
  MdContentCopy,
  MdQrCodeScanner,
  MdVerifiedUser,
  MdWarning,
} from "react-icons/md";
import { QRCodeSVG } from "qrcode.react";
import { Scanner } from "@yudiel/react-qr-scanner";
import Card from "@app/components/Card";
import PsbtRequestPanel from "@app/components/connect/PsbtRequestPanel";
import PsbtResultPanel from "@app/components/connect/PsbtResultPanel";
import MintRequestPanel from "@app/components/connect/MintRequestPanel";
import MintResultPanel from "@app/components/connect/MintResultPanel";
import SwapOfferRequestPanel from "@app/components/connect/SwapOfferRequestPanel";
import SwapOfferResultPanel from "@app/components/connect/SwapOfferResultPanel";
import SwapAcceptRequestPanel from "@app/components/connect/SwapAcceptRequestPanel";
import SwapAcceptResultPanel from "@app/components/connect/SwapAcceptResultPanel";
import SwapCancelRequestPanel from "@app/components/connect/SwapCancelRequestPanel";
import SwapCancelResultPanel from "@app/components/connect/SwapCancelResultPanel";
import { openModal, wallet } from "@app/signals";
import {
  readText,
  canScanFromPhoto,
  scanQrFromPhoto,
  isNativePlatform,
} from "@app/platform";
import { withSwapWif, withWif } from "@app/wallet";
import { signMessageWithWif } from "@lib/sign";
import { PsbtError, psbtFromBase64, type Psbt } from "@lib/psbt";
import {
  buildCallbackUrl,
  buildErrorCallbackUrl,
  buildMintCallbackUrl,
  buildMintResult,
  buildPsbtCallbackUrl,
  buildPsbtResult,
  buildRejectCallbackUrl,
  buildSignResult,
  buildSwapAcceptCallbackUrl,
  buildSwapAcceptResult,
  buildSwapCancelCallbackUrl,
  buildSwapCancelResult,
  buildSwapOfferCallbackUrl,
  buildSwapOfferResult,
  classifyConnectError,
  encodeSignResult,
  isRecognizedConnectChallenge,
  parseConnectRequest,
  type ConnectErrorCode,
  type MintRequest,
  type MintResult,
  type PsbtSignRequest,
  type PsbtSignResult,
  type SignRequest,
  type SignResult,
  type SwapAcceptRequest,
  type SwapAcceptResult,
  type SwapCancelRequest,
  type SwapCancelResult,
  type SwapOfferRequest,
  type SwapOfferResult,
} from "@app/connect/protocol";
import { enrichPsbt, signAndMaybeBroadcast, type EnrichedPsbt } from "@app/connect/psbtFlow";
import { mintFromRequest } from "@app/connect/mintFlow";
import { acceptSwapOffer, cancelSwapOffer, createSwapOffer } from "@app/connect/swapFlow";

/**
 * Whether this page may hand a signed result straight back to the request's
 * `callback` by navigating there (see `buildCallbackUrl`).
 *
 * The callback flow exists for one shape: a site deep-linked a browser tab
 * here, so that tab is still the site's to reclaim. Hence the gate on the
 * request having actually arrived via `?req=` — and it never fires in the
 * Capacitor shell,
 * where navigating away replaces the wallet app itself with a remote page and
 * leaves no way back. A request that was pasted or scanned in returns the
 * classic way, by copy/paste, which is what the user's other device or tab is
 * waiting for anyway.
 */
function canAutoReturn(fromDeepLink: boolean): boolean {
  return fromDeepLink && !isNativePlatform();
}

export default function Connect() {
  const [searchParams] = useSearchParams();
  const [rawInput, setRawInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<SignResult | null>(null);
  const [psbtResult, setPsbtResult] = useState<PsbtSignResult | null>(null);
  const [enriched, setEnriched] = useState<EnrichedPsbt | null>(null);
  const [psbtBusy, setPsbtBusy] = useState(false);
  const [mintResult, setMintResult] = useState<MintResult | null>(null);
  const [mintBusy, setMintBusy] = useState(false);
  const [swapOfferResult, setSwapOfferResult] = useState<SwapOfferResult | null>(null);
  const [swapOfferBusy, setSwapOfferBusy] = useState(false);
  const [swapAcceptResult, setSwapAcceptResult] = useState<SwapAcceptResult | null>(null);
  const [swapAcceptBusy, setSwapAcceptBusy] = useState(false);
  const [swapCancelResult, setSwapCancelResult] = useState<SwapCancelResult | null>(null);
  const [swapCancelBusy, setSwapCancelBusy] = useState(false);
  const [fromDeepLink, setFromDeepLink] = useState(false);
  const toast = useToast();

  // Synchronous re-entrancy guard for the approve action. Only one of
  // sign/psbtSign/mintSign/swapOfferSign/swapAcceptSign may run at a time —
  // this page only ever has one pending request. A `ref` (not the *Busy
  // state, which only takes effect on the next render) is what makes the
  // guard actually synchronous: if the unlock modal's onClose ever fires
  // twice (see Unlock.tsx — its onCloseCallback isn't cleared after use) or
  // a click handler double-fires, the second call is a no-op instead of a
  // second real broadcast.
  const approveInFlightRef = useRef(false);

  // Deep-link entry: `#/connect?req=<bare|json|base64url>` (or ?challenge=).
  useEffect(() => {
    const req = searchParams.get("req") || searchParams.get("challenge");
    if (req) {
      setRawInput(req);
      setFromDeepLink(true);
    }
  }, []);

  const parsed = useMemo(
    () => (rawInput.trim() ? parseConnectRequest(rawInput) : null),
    [rawInput]
  );
  const request = parsed?.ok ? parsed.request : null;

  // The protocol layer only validates that a psbt-sign-request's `psbt`
  // field is base64-shaped; parsing it into a structured PSBT (and
  // rejecting a malformed one) is `@lib/psbt`'s job, done here so a bad PSBT
  // shows a clear error instead of silently falling through.
  const psbtParse = useMemo(() => {
    if (!request || request.t !== "psbt-sign-request") return null;
    try {
      return { ok: true as const, psbt: psbtFromBase64(request.psbt) };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof PsbtError ? err.message : String(err),
      };
    }
  }, [request]);

  // Enrichment (db ownership/spent checks, best-effort external prevout
  // lookup) is async, so it runs once the PSBT parses and is cached until
  // the request changes.
  useEffect(() => {
    setEnriched(null);
    if (!psbtParse?.ok) return;
    let cancelled = false;
    enrichPsbt(psbtParse.psbt).then((e) => {
      if (!cancelled) setEnriched(e);
    });
    return () => {
      cancelled = true;
    };
  }, [psbtParse]);

  const signerAddress = wallet.value.address;
  const locked = wallet.value.locked;

  // Fires the generic error callback (distinct from both success and
  // explicit reject) for a genuine wallet-side failure — locked, not found,
  // insufficient funds, already spent, etc. Without this a deep-linked
  // caller waiting on any of the sign handlers below has no way to tell
  // "still working" from "failed" and is left hanging until its own
  // timeout; the in-app toast alone only helps a human watching the screen.
  const fireConnectError = useCallback(
    (
      req: { callback?: string; id?: string },
      code: ConnectErrorCode,
      message: string
    ) => {
      if (!canAutoReturn(fromDeepLink)) return;
      const url = buildErrorCallbackUrl(req, { code, message });
      if (url) window.location.assign(url);
    },
    [fromDeepLink]
  );

  const sign = useCallback(
    (req: SignRequest) => {
      const signed = withWif((wif) => signMessageWithWif(req.challenge, wif));
      if (!signed) {
        toast({ status: "error", title: "Wallet is locked — unable to sign" });
        fireConnectError(req, "locked", "Wallet is locked — unable to sign");
        return;
      }
      const signResult = buildSignResult(req, signed);
      // Always render the manual-return panel first: it is the fallback if the
      // navigation below is slow, blocked, or skipped.
      setResult(signResult);

      const callbackUrl = canAutoReturn(fromDeepLink)
        ? buildCallbackUrl(req, signResult)
        : undefined;
      if (callbackUrl) window.location.assign(callbackUrl);
    },
    [toast, fromDeepLink, fireConnectError]
  );

  const psbtSign = useCallback(
    async (req: PsbtSignRequest, psbt: Psbt) => {
      setPsbtBusy(true);
      try {
        const outcomePromise = withWif((wif) =>
          signAndMaybeBroadcast(psbt, wif, { broadcast: req.broadcast === true })
        );
        if (!outcomePromise) {
          toast({
            status: "error",
            title: "Wallet is locked — unable to sign",
          });
          fireConnectError(req, "locked", "Wallet is locked — unable to sign");
          return;
        }
        const outcome = await outcomePromise;
        const signResult = buildPsbtResult(req, outcome);
        // As with the sign-request flow, always render the manual-return
        // panel first — it is the fallback if auto-return doesn't fire.
        setPsbtResult(signResult);
        if (outcome.broadcastError) {
          toast({
            status: "warning",
            title: "Broadcast failed",
            description: outcome.broadcastError,
          });
        }

        const callbackUrl = canAutoReturn(fromDeepLink)
          ? buildPsbtCallbackUrl(req, signResult)
          : undefined;
        if (callbackUrl) window.location.assign(callbackUrl);
      } catch (err) {
        toast({
          status: "error",
          title: "Unable to sign",
          description: err instanceof Error ? err.message : String(err),
        });
        const { code, message } = classifyConnectError(err);
        fireConnectError(req, code, message);
      } finally {
        setPsbtBusy(false);
      }
    },
    [toast, fromDeepLink, fireConnectError]
  );

  const mintSign = useCallback(
    async (req: MintRequest) => {
      setMintBusy(true);
      try {
        const outcomePromise = withWif((wif) =>
          mintFromRequest(req, wif, wallet.value.address)
        );
        if (!outcomePromise) {
          toast({
            status: "error",
            title: "Wallet is locked — unable to mint",
          });
          fireConnectError(req, "locked", "Wallet is locked — unable to mint");
          return;
        }
        const outcome = await outcomePromise;
        const mintResultValue = buildMintResult(req, outcome);
        setMintResult(mintResultValue);

        // A dry run (broadcast:false) exists specifically to let the caller
        // inspect the built hex before anything real happens — auto-
        // returning immediately would defeat that. Only navigate away when
        // something actually got sent.
        const callbackUrl =
          outcome.broadcast && canAutoReturn(fromDeepLink)
            ? buildMintCallbackUrl(req, mintResultValue)
            : undefined;
        if (callbackUrl) window.location.assign(callbackUrl);
      } catch (err) {
        toast({
          status: "error",
          title: "Unable to mint",
          description: err instanceof Error ? err.message : String(err),
        });
        const { code, message } = classifyConnectError(err);
        fireConnectError(req, code, message);
      } finally {
        setMintBusy(false);
      }
    },
    [toast, fromDeepLink, fireConnectError]
  );

  const swapOfferSign = useCallback(
    async (req: SwapOfferRequest) => {
      setSwapOfferBusy(true);
      try {
        const address = wallet.value.address;
        const swapAddress = wallet.value.swapAddress;
        const outcomePromise = withWif((wif) =>
          withSwapWif((swapWif) =>
            createSwapOffer(req, wif, swapWif, address, swapAddress)
          )
        );
        if (!outcomePromise) {
          toast({
            status: "error",
            title: "Wallet is locked — unable to list",
          });
          fireConnectError(req, "locked", "Wallet is locked — unable to list");
          return;
        }
        const outcome = await outcomePromise;
        const offerResult = buildSwapOfferResult(req, outcome);
        setSwapOfferResult(offerResult);

        const callbackUrl = canAutoReturn(fromDeepLink)
          ? buildSwapOfferCallbackUrl(req, offerResult)
          : undefined;
        if (callbackUrl) window.location.assign(callbackUrl);
      } catch (err) {
        toast({
          status: "error",
          title: "Unable to list",
          description: err instanceof Error ? err.message : String(err),
        });
        const { code, message } = classifyConnectError(err);
        fireConnectError(req, code, message);
      } finally {
        setSwapOfferBusy(false);
      }
    },
    [toast, fromDeepLink, fireConnectError]
  );

  const swapAcceptSign = useCallback(
    async (req: SwapAcceptRequest) => {
      setSwapAcceptBusy(true);
      try {
        const outcomePromise = withWif((wif) =>
          acceptSwapOffer(req, wif, wallet.value.address)
        );
        if (!outcomePromise) {
          toast({
            status: "error",
            title: "Wallet is locked — unable to complete purchase",
          });
          fireConnectError(
            req,
            "locked",
            "Wallet is locked — unable to complete purchase"
          );
          return;
        }
        const outcome = await outcomePromise;
        const acceptResult = buildSwapAcceptResult(req, outcome);
        setSwapAcceptResult(acceptResult);

        const callbackUrl = canAutoReturn(fromDeepLink)
          ? buildSwapAcceptCallbackUrl(req, acceptResult)
          : undefined;
        if (callbackUrl) window.location.assign(callbackUrl);
      } catch (err) {
        toast({
          status: "error",
          title: "Unable to complete purchase",
          description: err instanceof Error ? err.message : String(err),
        });
        const { code, message } = classifyConnectError(err);
        fireConnectError(req, code, message);
      } finally {
        setSwapAcceptBusy(false);
      }
    },
    [toast, fromDeepLink, fireConnectError]
  );

  const swapCancelSign = useCallback(
    async (req: SwapCancelRequest) => {
      setSwapCancelBusy(true);
      try {
        if (wallet.value.locked) {
          toast({
            status: "error",
            title: "Wallet is locked — unable to cancel",
          });
          fireConnectError(req, "locked", "Wallet is locked — unable to cancel");
          return;
        }
        // cancelSwapOffer (via @app/swap's cancelSwap) reads the signing
        // keys from wallet state directly — no withWif frame needed, same
        // convention the local Swap page's own Cancel button uses.
        const outcome = await cancelSwapOffer(req);
        const cancelResult = buildSwapCancelResult(req, outcome);
        setSwapCancelResult(cancelResult);

        const callbackUrl = canAutoReturn(fromDeepLink)
          ? buildSwapCancelCallbackUrl(req, cancelResult)
          : undefined;
        if (callbackUrl) window.location.assign(callbackUrl);
      } catch (err) {
        toast({
          status: "error",
          title: "Unable to cancel",
          description: err instanceof Error ? err.message : String(err),
        });
        const { code, message } = classifyConnectError(err);
        fireConnectError(req, code, message);
      } finally {
        setSwapCancelBusy(false);
      }
    },
    [toast, fromDeepLink, fireConnectError]
  );

  const onApprove = useCallback(() => {
    if (!request) return;
    const doSign = () => {
      // Synchronous re-entrancy guard: if this fires twice (e.g. the unlock
      // modal's onClose firing again — Unlock.tsx's onCloseCallback isn't
      // cleared after use — or a double click), the second call is a no-op
      // instead of a second real broadcast.
      if (approveInFlightRef.current) return;
      approveInFlightRef.current = true;
      const release = () => {
        approveInFlightRef.current = false;
      };

      if (request.t === "psbt-sign-request") {
        if (psbtParse?.ok) void psbtSign(request, psbtParse.psbt).finally(release);
        else release();
      } else if (request.t === "mint-request") {
        void mintSign(request).finally(release);
      } else if (request.t === "swap-offer-request") {
        void swapOfferSign(request).finally(release);
      } else if (request.t === "swap-accept-request") {
        void swapAcceptSign(request).finally(release);
      } else if (request.t === "swap-cancel-request") {
        void swapCancelSign(request).finally(release);
      } else {
        try {
          sign(request);
        } finally {
          release();
        }
      }
    };
    if (wallet.value.locked) {
      // Reuse the global unlock modal; sign in its success callback.
      openModal.value = {
        modal: "unlock",
        onClose: (ok: boolean) => {
          if (ok) doSign();
        },
      };
    } else {
      doSign();
    }
  }, [
    request,
    sign,
    psbtSign,
    psbtParse,
    mintSign,
    swapOfferSign,
    swapAcceptSign,
    swapCancelSign,
  ]);

  const reset = () => {
    approveInFlightRef.current = false;
    setResult(null);
    setPsbtResult(null);
    setEnriched(null);
    setMintResult(null);
    setSwapOfferResult(null);
    setSwapAcceptResult(null);
    setSwapCancelResult(null);
    setRawInput("");
    setScanning(false);
    // Whatever is entered next was typed/scanned by hand, not deep-linked, so
    // it must not inherit the deep link's licence to auto-return.
    setFromDeepLink(false);
  };

  const onReject = useCallback(() => {
    // Tell the dApp explicitly, the same way an approval would — otherwise a
    // deep-linked caller has no way to distinguish "still waiting" from "the
    // user said no" and is left hanging with no signal at all.
    if (request && canAutoReturn(fromDeepLink)) {
      const url = buildRejectCallbackUrl(request);
      if (url) {
        window.location.assign(url);
        return;
      }
    }
    reset();
  }, [request, fromDeepLink]);

  const isPsbtRequest = request?.t === "psbt-sign-request";
  const isMintRequest = request?.t === "mint-request";
  const isSwapOfferRequest = request?.t === "swap-offer-request";
  const isSwapAcceptRequest = request?.t === "swap-accept-request";
  const isSwapCancelRequest = request?.t === "swap-cancel-request";

  return (
    <Container maxW="container.md" py={8}>
      <Heading textStyle="h1" mb={1}>
        Connect
      </Heading>
      <Text textStyle="body" color="text.secondary" mb={6}>
        {isPsbtRequest
          ? "Review and approve a transaction an app is asking you to sign."
          : isMintRequest
          ? "Review and approve an NFT an app is asking you to mint."
          : isSwapOfferRequest
          ? "Review and approve listing an item for sale."
          : isSwapAcceptRequest
          ? "Review and approve completing a purchase."
          : isSwapCancelRequest
          ? "Review and approve cancelling a listing."
          : "Prove you control this wallet to an app by signing its challenge. This never spends funds and never reveals your seed."}
      </Text>

      {result ? (
        <ResultPanel result={result} onDone={reset} />
      ) : psbtResult ? (
        <PsbtResultPanel result={psbtResult} onDone={reset} />
      ) : request?.t === "psbt-sign-request" ? (
        psbtParse?.ok ? (
          enriched ? (
            <PsbtRequestPanel
              request={request}
              enriched={enriched}
              signerAddress={signerAddress}
              locked={locked}
              autoReturn={!!request.callback && canAutoReturn(fromDeepLink)}
              busy={psbtBusy}
              onApprove={onApprove}
              onReject={onReject}
            />
          ) : (
            <Card p={5}>
              <HStack spacing={3}>
                <Spinner size="sm" />
                <Text>Loading transaction details…</Text>
              </HStack>
            </Card>
          )
        ) : (
          <Stack spacing={4}>
            <Alert status="error" borderRadius="lg">
              <AlertIcon />
              <AlertDescription>
                {psbtParse?.error ?? "This isn't a valid PSBT."}
              </AlertDescription>
            </Alert>
            <Button variant="ghost" onClick={reset} w="fit-content">
              Start over
            </Button>
          </Stack>
        )
      ) : mintResult ? (
        <MintResultPanel result={mintResult} onDone={reset} />
      ) : request?.t === "mint-request" ? (
        <MintRequestPanel
          request={request}
          signerAddress={signerAddress}
          locked={locked}
          autoReturn={!!request.callback && canAutoReturn(fromDeepLink)}
          busy={mintBusy}
          onApprove={onApprove}
          onReject={onReject}
        />
      ) : swapOfferResult ? (
        <SwapOfferResultPanel result={swapOfferResult} onDone={reset} />
      ) : request?.t === "swap-offer-request" ? (
        <SwapOfferRequestPanel
          request={request}
          locked={locked}
          autoReturn={!!request.callback && canAutoReturn(fromDeepLink)}
          busy={swapOfferBusy}
          onApprove={onApprove}
          onReject={onReject}
        />
      ) : swapAcceptResult ? (
        <SwapAcceptResultPanel result={swapAcceptResult} onDone={reset} />
      ) : request?.t === "swap-accept-request" ? (
        <SwapAcceptRequestPanel
          request={request}
          locked={locked}
          autoReturn={!!request.callback && canAutoReturn(fromDeepLink)}
          busy={swapAcceptBusy}
          onApprove={onApprove}
          onReject={onReject}
        />
      ) : swapCancelResult ? (
        <SwapCancelResultPanel result={swapCancelResult} onDone={reset} />
      ) : request?.t === "swap-cancel-request" ? (
        <SwapCancelRequestPanel
          request={request}
          locked={locked}
          autoReturn={!!request.callback && canAutoReturn(fromDeepLink)}
          busy={swapCancelBusy}
          onApprove={onApprove}
          onReject={onReject}
        />
      ) : request ? (
        <RequestPanel
          request={request}
          signerAddress={signerAddress}
          locked={locked}
          autoReturn={!!request.callback && canAutoReturn(fromDeepLink)}
          onApprove={onApprove}
          onReject={onReject}
        />
      ) : (
        <InputPanel
          rawInput={rawInput}
          error={parsed && !parsed.ok ? parsed.error : undefined}
          scanning={scanning}
          setScanning={setScanning}
          onChange={setRawInput}
        />
      )}
    </Container>
  );
}

function InputPanel({
  rawInput,
  error,
  scanning,
  setScanning,
  onChange,
}: {
  rawInput: string;
  error?: string;
  scanning: boolean;
  setScanning: (v: boolean) => void;
  onChange: (v: string) => void;
}) {
  const pasteFromClipboard = async () => {
    const text = await readText();
    if (text) onChange(text);
  };

  return (
    <Stack spacing={4}>
      <Card p={5}>
        <Text textStyle="label" mb={3}>
          Paste a connect request
        </Text>
        <Textarea
          value={rawInput}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste the challenge or request the app gave you…"
          rows={4}
          fontFamily="mono"
          fontSize="sm"
        />
        {error && (
          <Alert status="error" mt={3} borderRadius="lg">
            <AlertIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <HStack mt={3} spacing={3}>
          <Button
            leftIcon={<MdQrCodeScanner />}
            onClick={() => setScanning(!scanning)}
            variant="solid"
          >
            {scanning ? "Stop camera" : "Scan QR"}
          </Button>
          <Button onClick={pasteFromClipboard} variant="ghost">
            Paste from clipboard
          </Button>
          {canScanFromPhoto() && (
            <Button
              onClick={async () => {
                const value = await scanQrFromPhoto();
                if (value) onChange(value);
              }}
              variant="ghost"
            >
              Scan from photo
            </Button>
          )}
        </HStack>
      </Card>

      {scanning && (
        <Card p={4}>
          <Box w="100%" maxW="320px" mx="auto" aspectRatio={1}>
            <Scanner
              onScan={(codes) => {
                if (codes[0]?.rawValue) {
                  onChange(codes[0].rawValue);
                  setScanning(false);
                }
              }}
            />
          </Box>
        </Card>
      )}
    </Stack>
  );
}

function RequestPanel({
  request,
  signerAddress,
  locked,
  autoReturn,
  onApprove,
  onReject,
}: {
  request: SignRequest;
  signerAddress: string;
  locked: boolean;
  autoReturn: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const recognized = isRecognizedConnectChallenge(request.challenge);
  const addressMismatch =
    !!request.address && request.address !== signerAddress;

  return (
    <Stack spacing={4}>
      <Card p={5}>
        <Flex align="center" justify="space-between" mb={4}>
          <Text textStyle="label">Signature request</Text>
          {recognized ? (
            <Badge
              colorScheme="green"
              display="flex"
              alignItems="center"
              gap={1}
            >
              <MdVerifiedUser /> Recognized connect
            </Badge>
          ) : (
            <Badge
              colorScheme="orange"
              display="flex"
              alignItems="center"
              gap={1}
            >
              <MdWarning /> Unrecognized
            </Badge>
          )}
        </Flex>

        {request.origin || request.app ? (
          <Box mb={4}>
            <Text textStyle="label" mb={1}>
              Requested by
            </Text>
            <Code w="100%" p={2} borderRadius="md" wordBreak="break-all">
              {request.app ? `${request.app} — ` : ""}
              {request.origin ?? "(no origin provided)"}
            </Code>
          </Box>
        ) : (
          <Alert status="info" mb={4} borderRadius="lg">
            <AlertIcon />
            <AlertDescription fontSize="sm">
              No origin was provided. Only continue if you trust where this
              request came from.
            </AlertDescription>
          </Alert>
        )}

        {!recognized && (
          <Alert status="warning" mb={4} borderRadius="lg">
            <AlertIcon />
            <Box>
              <AlertTitle fontSize="sm">
                Not a standard connect request
              </AlertTitle>
              <AlertDescription fontSize="sm">
                Only sign if you understand exactly what you are approving.
              </AlertDescription>
            </Box>
          </Alert>
        )}

        <Text textStyle="label" mb={1}>
          Message to sign
        </Text>
        <Code
          display="block"
          w="100%"
          p={3}
          mb={4}
          borderRadius="md"
          whiteSpace="pre-wrap"
          wordBreak="break-all"
        >
          {request.challenge}
        </Code>

        <Text textStyle="label" mb={1}>
          Signing as
        </Text>
        <Code w="100%" p={2} borderRadius="md" wordBreak="break-all">
          {signerAddress || "(no wallet address)"}
        </Code>

        {addressMismatch && (
          <Alert status="warning" mt={4} borderRadius="lg">
            <AlertIcon />
            <AlertDescription fontSize="sm">
              This request expects address <b>{request.address}</b>, but your
              active wallet is different. The signature will be for your active
              wallet and the app may reject it.
            </AlertDescription>
          </Alert>
        )}

        {autoReturn && (
          <Text textStyle="small" mt={4}>
            After signing you will be sent back to {request.app || "the app"} at{" "}
            <b>{request.origin}</b>, which receives your address and signature
            automatically.
          </Text>
        )}

        {locked && (
          <Text textStyle="small" mt={4}>
            You will be asked to unlock your wallet to sign.
          </Text>
        )}
      </Card>

      <Alert status="info" borderRadius="lg">
        <AlertIcon />
        <AlertDescription fontSize="sm">
          Connecting only proves you control this wallet. The app receives this
          signature and your address — it <b>cannot</b> spend your funds, move
          your tokens, or see your seed phrase.
        </AlertDescription>
      </Alert>

      <HStack spacing={3}>
        <Button variant="primary" onClick={onApprove} flex={1}>
          Approve &amp; sign
        </Button>
        <Button variant="ghost" onClick={onReject}>
          Reject
        </Button>
      </HStack>
    </Stack>
  );
}

function ResultPanel({
  result,
  onDone,
}: {
  result: SignResult;
  onDone: () => void;
}) {
  const { onCopy, hasCopied } = useClipboard(result.signature);
  const envelope = encodeSignResult(result);

  return (
    <Stack spacing={4}>
      <Alert status="success" borderRadius="lg">
        <AlertIcon />
        <Box>
          <AlertTitle>Signed</AlertTitle>
          <AlertDescription fontSize="sm">
            Send this signature back to the app to finish connecting.
          </AlertDescription>
        </Box>
      </Alert>

      <Card p={5}>
        <VStack spacing={4}>
          <Box borderRadius="md" overflow="hidden" bg="white" p={3}>
            <QRCodeSVG size={232} value={envelope} includeMargin />
          </Box>
          <Text textStyle="small">
            Scan to return the full response, or copy the signature below.
          </Text>
        </VStack>

        <Divider my={4} />

        <Text textStyle="label" mb={1}>
          Signature
        </Text>
        <Code
          display="block"
          w="100%"
          p={3}
          borderRadius="md"
          whiteSpace="pre-wrap"
          wordBreak="break-all"
        >
          {result.signature}
        </Code>
        <Button
          mt={3}
          leftIcon={hasCopied ? <MdCheck /> : <MdContentCopy />}
          onClick={onCopy}
          variant="ghost"
        >
          {hasCopied ? "Copied!" : "Copy signature"}
        </Button>

        <Text textStyle="label" mt={4} mb={1}>
          Signed by
        </Text>
        <Code w="100%" p={2} borderRadius="md" wordBreak="break-all">
          {result.address}
        </Code>
      </Card>

      <Button variant="solid" onClick={onDone}>
        Sign another
      </Button>
    </Stack>
  );
}
