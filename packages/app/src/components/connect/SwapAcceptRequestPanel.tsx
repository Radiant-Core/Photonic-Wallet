/**
 * Approval screen for an incoming `swap-accept-request` (taker side): the
 * dApp asks the wallet to complete and broadcast a purchase against a
 * maker's PSRT, optionally adding a marketplace fee output. This always
 * broadcasts on approval — there is no "return unsigned" option.
 *
 * The taker pays the price PLUS any enforced creator royalty PLUS the
 * requested marketplace fee, so all three are itemized with a total: showing
 * price alone would understate what approving costs.
 */
import { useEffect, useState } from "react";
import Big from "big.js";
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  HStack,
  Stack,
  Text,
} from "@chakra-ui/react";
import { MdShoppingCart } from "react-icons/md";
import Card from "@app/components/Card";
import TokenContent from "@app/components/TokenContent";
import { previewSwapAccept, type SwapAcceptPreview } from "@app/connect/swapFlow";
import { electrumStatus } from "@app/signals";
import { ElectrumStatus } from "@app/types";
import type { SwapAcceptRequest } from "@app/connect/protocol";
import { sanitizeForDisplay } from "@lib/displayText";

export default function SwapAcceptRequestPanel({
  request,
  locked,
  autoReturn,
  busy,
  onApprove,
  onReject,
}: {
  request: SwapAcceptRequest;
  locked: boolean;
  autoReturn: boolean;
  busy?: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  // undefined while resolving; null when the PSRT itself is malformed
  // (distinct from a resolved preview that just couldn't find the token).
  const [parsed, setParsed] = useState<SwapAcceptPreview | null | undefined>(
    undefined
  );

  // Wait for the Electrum connection before attempting the lookup — on a
  // fresh page load this effect can otherwise fire before the wallet has
  // finished connecting, so the on-chain prevout lookup `previewSwapAccept`
  // needs has no server to ask yet and degrades straight to price-only. That
  // previously required reloading the page (by which point the connection
  // from the prior load was already up) to see the item resolve; watching
  // `electrumStatus` here means it resolves on its own once connected.
  useEffect(() => {
    if (electrumStatus.value !== ElectrumStatus.CONNECTED) {
      setParsed(undefined);
      return;
    }
    let cancelled = false;
    previewSwapAccept(request).then((result) => {
      if (!cancelled) setParsed(result);
    });
    return () => {
      cancelled = true;
    };
  }, [request, electrumStatus.value]);

  const hasMarketplaceFee =
    request.feeRxd !== undefined && !!request.feeAddress;

  // Only worth a "Total" line when something is added on top of the price;
  // otherwise it would just restate it. Summed with Big so the RXD decimals
  // don't produce float artifacts like 0.30000000000000004.
  const extrasTotal =
    parsed && (parsed.royaltyRxd !== undefined || hasMarketplaceFee)
      ? Big(parsed.priceRxd)
          .plus(parsed.royaltyRxd ?? 0)
          .plus(hasMarketplaceFee ? (request.feeRxd as number) : 0)
          .toString()
      : undefined;

  return (
    <Stack spacing={4}>
      <Card p={5}>
        <HStack mb={4} spacing={2}>
          <MdShoppingCart />
          <Text textStyle="label">Complete a purchase</Text>
        </HStack>

        {request.origin || request.app ? (
          <Box mb={4}>
            <Text textStyle="label" mb={1}>
              Requested by
            </Text>
            <Text fontSize="sm" wordBreak="break-all">
              {request.app ? `${sanitizeForDisplay(request.app)} — ` : ""}
              {request.origin ? sanitizeForDisplay(request.origin) : "(no origin provided)"}
            </Text>
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

        {parsed === undefined ? (
          <Text fontSize="sm" color="text.secondary" mb={4}>
            Looking up item…
          </Text>
        ) : parsed === null ? (
          <Alert status="error" mb={4} borderRadius="lg">
            <AlertIcon />
            <AlertDescription fontSize="sm">
              This doesn't look like a valid offer.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {parsed.glyph ? (
              <HStack mb={4} spacing={3}>
                <Box
                  w="256px"
                  h="256px"
                  flexShrink={0}
                  borderRadius="md"
                  overflow="hidden"
                >
                  <TokenContent glyph={parsed.glyph} thumbnail />
                </Box>
                <Text fontWeight="medium">{parsed.glyph.name}</Text>
              </HStack>
            ) : (
              <Alert status="warning" mb={4} borderRadius="lg">
                <AlertIcon />
                <AlertDescription fontSize="sm">
                  Couldn't identify which item this offer is for — only the
                  price could be confirmed. Only continue if you trust the
                  requesting app.
                </AlertDescription>
              </Alert>
            )}

            <Text textStyle="label" mb={1}>
              Price
            </Text>
            <Text fontSize="lg" fontWeight="medium">
              {parsed.priceRxd} RXD
            </Text>

            {parsed.royaltyRxd !== undefined && (
              <>
                <Text textStyle="label" mt={3} mb={1}>
                  Creator royalty
                </Text>
                <Text fontSize="sm">{parsed.royaltyRxd} RXD</Text>
              </>
            )}

            {hasMarketplaceFee && (
              <>
                <Text textStyle="label" mt={3} mb={1}>
                  Marketplace fee
                </Text>
                <Text fontSize="sm">
                  {request.feeRxd} RXD to <b>{request.feeAddress}</b>
                </Text>
              </>
            )}

            {extrasTotal && (
              <>
                <Text textStyle="label" mt={3} mb={1}>
                  Total
                </Text>
                <Text fontSize="lg" fontWeight="medium">
                  {extrasTotal} RXD
                </Text>
                <Text textStyle="small" color="text.secondary">
                  Plus the network fee, which depends on the final transaction
                  size.
                </Text>
              </>
            )}

            {parsed.royaltyUnknown && (
              <Alert status="warning" mt={3} borderRadius="lg">
                <AlertIcon />
                <AlertDescription fontSize="sm">
                  This item's creator royalty couldn't be checked, so the total
                  above may be incomplete. If the token enforces a royalty, it
                  is charged on top of the price.
                </AlertDescription>
              </Alert>
            )}
          </>
        )}

        <Alert status="warning" mt={4} borderRadius="lg">
          <AlertIcon />
          <AlertDescription fontSize="sm">
            Approving completes and broadcasts this purchase immediately —
            it cannot be undone. Network fees are paid from your wallet's
            RXD balance.
          </AlertDescription>
        </Alert>

        {autoReturn && (
          <Text textStyle="small" mt={3}>
            After approving you will be sent back to{" "}
            {request.app ? sanitizeForDisplay(request.app) : "the app"} at <b>{sanitizeForDisplay(request.origin ?? "")}</b>, which
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
          isDisabled={!parsed || busy}
          isLoading={busy}
          loadingText="Completing…"
        >
          Approve &amp; buy
        </Button>
        <Button variant="ghost" onClick={onReject} isDisabled={busy}>
          Reject
        </Button>
      </HStack>
    </Stack>
  );
}
