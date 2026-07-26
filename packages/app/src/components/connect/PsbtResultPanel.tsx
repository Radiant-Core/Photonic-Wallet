/**
 * Result screen after a `psbt-sign-request` is signed: either a txid (the
 * wallet broadcast a completed transaction) or a signed PSBT to hand back to
 * the app — by QR when it's small enough, always by copy. Mirrors
 * `Connect.tsx`'s `ResultPanel` for the plain sign-request flow.
 */
import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Box,
  Button,
  Code,
  Divider,
  Stack,
  Text,
  VStack,
  useClipboard,
} from "@chakra-ui/react";
import { MdCheck, MdContentCopy } from "react-icons/md";
import { QRCodeSVG } from "qrcode.react";
import Card from "@app/components/Card";
import { encodePsbtResult, type PsbtSignResult } from "@app/connect/protocol";

// Beyond this a QR code becomes dense enough to be unreliable to scan; fall
// back to copy-only rather than render something unscannable.
const MAX_QR_LEN = 2_500;

export default function PsbtResultPanel({
  result,
  onDone,
}: {
  result: PsbtSignResult;
  onDone: () => void;
}) {
  const value = result.txid ?? result.psbt ?? "";
  const { onCopy, hasCopied } = useClipboard(value);
  const envelope = encodePsbtResult(result);
  const showQr = envelope.length <= MAX_QR_LEN;

  return (
    <Stack spacing={4}>
      {result.txid ? (
        <Alert status="success" borderRadius="lg">
          <AlertIcon />
          <Box>
            <AlertTitle>Broadcast</AlertTitle>
            <AlertDescription fontSize="sm">
              The transaction was sent to the network.
            </AlertDescription>
          </Box>
        </Alert>
      ) : (
        <Alert status={result.complete ? "success" : "info"} borderRadius="lg">
          <AlertIcon />
          <Box>
            <AlertTitle>
              {result.complete ? "Signed" : "Partially signed"}
            </AlertTitle>
            <AlertDescription fontSize="sm">
              {result.complete
                ? "Send this signed transaction back to the app."
                : "Other signatures are still needed before this transaction can be broadcast — send it back to the app to continue."}
            </AlertDescription>
          </Box>
        </Alert>
      )}

      <Card p={5}>
        {showQr ? (
          <VStack spacing={4}>
            <Box borderRadius="md" overflow="hidden" bg="white" p={3}>
              <QRCodeSVG size={232} value={envelope} includeMargin />
            </Box>
            <Text textStyle="small">
              Scan to return the full response, or copy it below.
            </Text>
          </VStack>
        ) : (
          <Text textStyle="small">
            This result is too large for a QR code — copy it below.
          </Text>
        )}

        <Divider my={4} />

        <Text textStyle="label" mb={1}>
          {result.txid ? "Transaction id" : "Signed PSBT"}
        </Text>
        <Code
          display="block"
          w="100%"
          p={3}
          borderRadius="md"
          whiteSpace="pre-wrap"
          wordBreak="break-all"
        >
          {value}
        </Code>
        <Button
          mt={3}
          leftIcon={hasCopied ? <MdCheck /> : <MdContentCopy />}
          onClick={onCopy}
          variant="ghost"
        >
          {hasCopied ? "Copied!" : result.txid ? "Copy txid" : "Copy PSBT"}
        </Button>

        {!result.txid && (
          <Badge
            mt={4}
            colorScheme={result.complete ? "green" : "orange"}
            w="fit-content"
          >
            {result.complete ? "Fully signed" : "Awaiting more signatures"}
          </Badge>
        )}
      </Card>

      <Button variant="solid" onClick={onDone}>
        Sign another
      </Button>
    </Stack>
  );
}
