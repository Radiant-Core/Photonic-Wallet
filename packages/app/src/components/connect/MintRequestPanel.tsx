/**
 * Approval screen for an incoming `mint-request`. Shows exactly what NFT is
 * about to be minted — name, description, attributes, and a preview of the
 * content — before `Connect.tsx` calls `mintFromRequest`. Minting always
 * broadcasts (there is no "return unsigned" option, unlike PSBT requests),
 * so this is the only checkpoint before funds actually move.
 *
 * A request may also override the wallet's own fee rate, which the user pays.
 * `buildTx`'s `feeCheck` bounds how far that can go, but a silently applied
 * override is still the user's money, so it is shown — and flagged when it is
 * above what the wallet would have charged.
 */
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Badge,
  Box,
  Button,
  Code,
  HStack,
  Stack,
  Text,
  Wrap,
  WrapItem,
} from "@chakra-ui/react";
import { MdImage, MdInsertDriveFile } from "react-icons/md";
import Card from "@app/components/Card";
import { feeRate as feeRateSignal } from "@app/signals";
import type { MintRequest } from "@app/connect/protocol";

const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

function ContentPreview({ main }: { main: MintRequest["main"] }) {
  if ("url" in main) {
    return (
      <Box>
        <Badge colorScheme="gray" mb={2}>
          Remote content
        </Badge>
        <Code display="block" p={2} borderRadius="md" wordBreak="break-all" fontSize="xs">
          {main.url}
        </Code>
      </Box>
    );
  }
  if (IMAGE_MIME_TYPES.has(main.mime)) {
    return (
      <Box
        borderRadius="md"
        overflow="hidden"
        bg="whiteAlpha.100"
        maxW="220px"
        mx="auto"
      >
        <img
          src={`data:${main.mime};base64,${main.data}`}
          alt="NFT content preview"
          style={{ display: "block", width: "100%", height: "auto" }}
        />
      </Box>
    );
  }
  return (
    <HStack justify="center" color="text.secondary">
      <MdInsertDriveFile />
      <Text fontSize="sm">{main.mime}</Text>
    </HStack>
  );
}

export default function MintRequestPanel({
  request,
  signerAddress,
  locked,
  autoReturn,
  busy,
  onApprove,
  onReject,
}: {
  request: MintRequest;
  signerAddress: string;
  locked: boolean;
  autoReturn: boolean;
  busy?: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const attrEntries = request.attrs ? Object.entries(request.attrs) : [];
  const walletFeeRate = feeRateSignal.value;
  const feeRateRaised =
    request.feeRate !== undefined && request.feeRate > walletFeeRate;

  return (
    <Stack spacing={4}>
      <Card p={5}>
        <HStack mb={4} spacing={2}>
          <MdImage />
          <Text textStyle="label">Mint an NFT</Text>
        </HStack>

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

        <ContentPreview main={request.main} />

        <Text textStyle="label" mt={4} mb={1}>
          Name
        </Text>
        <Text fontSize="md" fontWeight="medium">
          {request.name}
        </Text>

        {request.description && (
          <>
            <Text textStyle="label" mt={3} mb={1}>
              Description
            </Text>
            <Text fontSize="sm" whiteSpace="pre-wrap">
              {request.description}
            </Text>
          </>
        )}

        {request.license && (
          <>
            <Text textStyle="label" mt={3} mb={1}>
              License
            </Text>
            <Text fontSize="sm">{request.license}</Text>
          </>
        )}

        {attrEntries.length > 0 && (
          <>
            <Text textStyle="label" mt={3} mb={1}>
              Attributes
            </Text>
            <Wrap>
              {attrEntries.map(([k, v]) => (
                <WrapItem key={k}>
                  <Badge fontSize="xs">
                    {k}: {String(v)}
                  </Badge>
                </WrapItem>
              ))}
            </Wrap>
          </>
        )}

        {request.feeRate !== undefined && (
          <>
            <Text textStyle="label" mt={3} mb={1}>
              Fee rate
            </Text>
            <Text fontSize="sm">
              {request.feeRate} photons/byte{" "}
              <Text as="span" color="text.secondary">
                (requested by the app, replacing your wallet's{" "}
                {walletFeeRate} photons/byte)
              </Text>
            </Text>
            {feeRateRaised && (
              <Alert status="warning" mt={2} borderRadius="lg">
                <AlertIcon />
                <AlertDescription fontSize="sm">
                  This app is asking to pay a higher network fee than your
                  wallet's own setting. The extra cost comes out of your RXD
                  balance.
                </AlertDescription>
              </Alert>
            )}
          </>
        )}

        {request.broadcast === false ? (
          <Alert status="info" mt={4} borderRadius="lg">
            <AlertIcon />
            <AlertDescription fontSize="sm">
              Dry run: this will build and sign the mint transactions but{" "}
              <b>not broadcast them</b>. Nothing is sent or spent — you'll get
              the raw hex back to inspect.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert status="warning" mt={4} borderRadius="lg">
            <AlertIcon />
            <AlertDescription fontSize="sm">
              Minting broadcasts two transactions immediately and cannot be
              undone. Network fees are paid from your wallet's RXD balance.
            </AlertDescription>
          </Alert>
        )}

        <Text textStyle="small" mt={3}>
          Minting to <b>{signerAddress || "(no wallet address)"}</b>
        </Text>

        {autoReturn && (
          <Text textStyle="small" mt={2}>
            After approving you will be sent back to{" "}
            {request.app || "the app"} at <b>{request.origin}</b>, which
            receives the result automatically.
          </Text>
        )}

        {locked && (
          <Text textStyle="small" mt={2}>
            You will be asked to unlock your wallet to mint.
          </Text>
        )}
      </Card>

      <HStack spacing={3}>
        <Button
          variant="primary"
          onClick={onApprove}
          flex={1}
          isDisabled={busy}
          isLoading={busy}
          loadingText={request.broadcast === false ? "Building…" : "Minting…"}
        >
          {request.broadcast === false ? "Approve & build" : "Approve & mint"}
        </Button>
        <Button variant="ghost" onClick={onReject} isDisabled={busy}>
          Reject
        </Button>
      </HStack>
    </Stack>
  );
}
