/**
 * Approval screen for an incoming `swap-cancel-request`: the dApp asks the
 * wallet to cancel one of its own pending listings, identified by `ref`.
 * Approving broadcasts a REAL reclaim transaction moving the NFT back to
 * the wallet's main address and voids the PSRT the buyer would otherwise
 * complete against.
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
import { MdCancel } from "react-icons/md";
import Card from "@app/components/Card";
import TokenContent from "@app/components/TokenContent";
import db from "@app/db";
import { SwapStatus } from "@app/types";
import { photonsToRXD } from "@lib/format";
import type { SwapCancelRequest } from "@app/connect/protocol";

export default function SwapCancelRequestPanel({
  request,
  locked,
  autoReturn,
  busy,
  onApprove,
  onReject,
}: {
  request: SwapCancelRequest;
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
  const pendingSwap = useLiveQuery(
    () => db.swap.where({ status: SwapStatus.PENDING }).toArray(),
    []
  )?.find((s) => s.fromGlyph === request.ref);
  const noOffer = pendingSwap === undefined;

  return (
    <Stack spacing={4}>
      <Card p={5}>
        <HStack mb={4} spacing={2}>
          <MdCancel />
          <Text textStyle="label">Cancel a listing</Text>
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

        {glyph && (
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
        )}

        {noOffer && (
          <Alert status="error" mb={4} borderRadius="lg">
            <AlertIcon />
            <AlertDescription fontSize="sm">
              No pending listing was found for this item — it may already be
              cancelled, sold, or never listed by this wallet.
            </AlertDescription>
          </Alert>
        )}

        {pendingSwap && (
          <>
            <Text textStyle="label" mb={1}>
              Asking price
            </Text>
            <Text fontSize="lg" fontWeight="medium">
              {photonsToRXD(pendingSwap.toValue)} RXD
            </Text>
          </>
        )}

        <Alert status="warning" mt={4} borderRadius="lg">
          <AlertIcon />
          <AlertDescription fontSize="sm">
            Approving reclaims this item back to your wallet immediately (a
            real transaction, network fees apply) and voids the signed offer
            — a buyer can no longer complete it.
          </AlertDescription>
        </Alert>

        {autoReturn && (
          <Text textStyle="small" mt={3}>
            After approving you will be sent back to{" "}
            {request.app || "the app"} at <b>{request.origin}</b>, which
            receives the result automatically.
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
          isDisabled={noOffer || busy}
          isLoading={busy}
          loadingText="Cancelling…"
        >
          Approve &amp; cancel
        </Button>
        <Button variant="ghost" onClick={onReject} isDisabled={busy}>
          Reject
        </Button>
      </HStack>
    </Stack>
  );
}
