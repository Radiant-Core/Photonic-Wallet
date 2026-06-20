/**
 * "Connect & sign" — Phase A of external-wallet connect
 * (GlyphGalaxy `docs/WALLET_CONNECT_SCOPE.md`).
 *
 * Lets a dApp obtain a signed proof of address ownership over an out-of-band
 * transport (QR / paste / deep-link `#/connect?req=...`) WITHOUT the user ever
 * exposing their seed. This page is the human approval gate: it renders the
 * requesting origin + the verbatim challenge, signs only on explicit approval
 * (unlocking first if needed), and signs ONLY a magic-prefixed message via
 * `@lib/sign` — never a transaction. Nothing is persisted; no key leaves the
 * wallet's transient `withWif` frame.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { openModal, wallet } from "@app/signals";
import { withWif } from "@app/wallet";
import { signMessageWithWif } from "@lib/sign";
import {
  buildSignResult,
  encodeSignResult,
  isRecognizedConnectChallenge,
  parseSignRequest,
  type SignRequest,
  type SignResult,
} from "@app/connect/protocol";

export default function Connect() {
  const [searchParams] = useSearchParams();
  const [rawInput, setRawInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<SignResult | null>(null);
  const toast = useToast();

  // Deep-link entry: `#/connect?req=<bare|json|base64url>` (or ?challenge=).
  useEffect(() => {
    const req = searchParams.get("req") || searchParams.get("challenge");
    if (req) setRawInput(req);
  }, []);

  const parsed = useMemo(
    () => (rawInput.trim() ? parseSignRequest(rawInput) : null),
    [rawInput]
  );
  const request = parsed?.ok ? parsed.request : null;

  const signerAddress = wallet.value.address;
  const locked = wallet.value.locked;

  const sign = useCallback(
    (req: SignRequest) => {
      const signed = withWif((wif) => signMessageWithWif(req.challenge, wif));
      if (!signed) {
        toast({ status: "error", title: "Wallet is locked — unable to sign" });
        return;
      }
      setResult(buildSignResult(req, signed));
    },
    [toast]
  );

  const onApprove = useCallback(() => {
    if (!request) return;
    if (wallet.value.locked) {
      // Reuse the global unlock modal; sign in its success callback.
      openModal.value = {
        modal: "unlock",
        onClose: (ok: boolean) => {
          if (ok) sign(request);
        },
      };
    } else {
      sign(request);
    }
  }, [request, sign]);

  const reset = () => {
    setResult(null);
    setRawInput("");
    setScanning(false);
  };

  return (
    <Container maxW="container.md" py={8}>
      <Heading textStyle="h1" mb={1}>
        Connect &amp; sign
      </Heading>
      <Text textStyle="body" color="text.secondary" mb={6}>
        Prove you control this wallet to an app by signing its challenge. This
        never spends funds and never reveals your seed.
      </Text>

      {result ? (
        <ResultPanel result={result} onDone={reset} />
      ) : request ? (
        <RequestPanel
          request={request}
          signerAddress={signerAddress}
          locked={locked}
          onApprove={onApprove}
          onReject={reset}
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
    try {
      const text = await navigator.clipboard.readText();
      if (text) onChange(text);
    } catch {
      /* clipboard unavailable — user can paste manually */
    }
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
  onApprove,
  onReject,
}: {
  request: SignRequest;
  signerAddress: string;
  locked: boolean;
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
