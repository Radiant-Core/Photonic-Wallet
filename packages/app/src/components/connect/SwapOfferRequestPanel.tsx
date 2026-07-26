/**
 * Approval screen for an incoming `swap-offer-request` (maker side): the
 * dApp asks the wallet to list one of its own NFTs for a price. Approving
 * broadcasts a REAL transaction reserving the NFT into the swap subaccount
 * — `mode: "private"` only means no on-chain advertisement is published, not
 * that nothing moves — before the wallet builds and returns the PSRT.
 */
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Code,
  HStack,
  Stack,
  Text,
} from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import { MdSell } from "react-icons/md";
import Card from "@app/components/Card";
import TokenContent from "@app/components/TokenContent";
import db from "@app/db";
import type { SwapOfferRequest } from "@app/connect/protocol";

export default function SwapOfferRequestPanel({
  request,
  locked,
  autoReturn,
  busy,
  onApprove,
  onReject,
}: {
  request: SwapOfferRequest;
  locked: boolean;
  autoReturn: boolean;
  busy?: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const glyph = useLiveQuery(
    () => db.glyph.where({ ref: request.ref }).first(),
    [request.ref]
  );
  const notOwned = glyph === undefined ? undefined : glyph === null;

  return (
    <Stack spacing={4}>
      <Card p={5}>
        <HStack mb={4} spacing={2}>
          <MdSell />
          <Text textStyle="label">List an item for sale</Text>
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

        {glyph ? (
          <HStack mb={4} spacing={3}>
            <Box
              w="256px"
              h="256px"
              flexShrink={0}
              borderRadius="md"
              overflow="hidden"
            >
              <TokenContent glyph={glyph} thumbnail />
            </Box>
            <Text fontWeight="medium">{glyph.name}</Text>
          </HStack>
        ) : notOwned ? (
          <Alert status="error" mb={4} borderRadius="lg">
            <AlertIcon />
            <AlertDescription fontSize="sm">
              This item wasn't found in your wallet — it may already be
              listed, transferred, or the ref is wrong.
            </AlertDescription>
          </Alert>
        ) : (
          <Text fontSize="sm" color="text.secondary" mb={4}>
            Looking up item…
          </Text>
        )}

        <Text textStyle="label" mb={1}>
          Asking price
        </Text>
        <Text fontSize="lg" fontWeight="medium">
          {request.priceRxd} RXD
        </Text>

        <Alert status="warning" mt={4} borderRadius="lg">
          <AlertIcon />
          <AlertDescription fontSize="sm">
            Approving reserves this item into a listing address on-chain
            (a real transaction, network fees apply) and returns a signed
            offer to the app — it does not publish a public advertisement.
          </AlertDescription>
        </Alert>

        {autoReturn && (
          <Text textStyle="small" mt={3}>
            After approving you will be sent back to{" "}
            {request.app || "the app"} at <b>{request.origin}</b>, which
            receives the offer automatically.
          </Text>
        )}

        {locked && (
          <Text textStyle="small" mt={2}>
            You will be asked to unlock your wallet to continue.
          </Text>
        )}
      </Card>

      <HStack spacing={3}>
        <Button
          variant="primary"
          onClick={onApprove}
          flex={1}
          isDisabled={notOwned || busy}
          isLoading={busy}
          loadingText="Listing…"
        >
          Approve &amp; list
        </Button>
        <Button variant="ghost" onClick={onReject} isDisabled={busy}>
          Reject
        </Button>
      </HStack>
    </Stack>
  );
}
