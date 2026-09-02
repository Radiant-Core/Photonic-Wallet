/**
 * Approval screen for an incoming `anchor-request`: publishing a signed Canon
 * declaration on-chain as a permanent `cnd1` commit+reveal pair, paid from
 * this wallet. Shows the parsed declaration (what the signing key recognizes
 * or revokes), the signer, and a permanence warning before `Connect.tsx`
 * calls `anchorFromRequest`. The exact document is available to inspect —
 * its bytes are what gets committed.
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
  HStack,
  Stack,
  Text,
} from "@chakra-ui/react";
import { MdAnchor, MdWarning } from "react-icons/md";
import Card from "@app/components/Card";
import { canonDeclarationFromDocument } from "@app/connect/protocol";
import type { AnchorRequest } from "@app/connect/protocol";
import { sanitizeForDisplay } from "@lib/displayText";

export default function AnchorRequestPanel({
  request,
  busy,
  onApprove,
  onReject,
}: {
  request: AnchorRequest;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  // Guaranteed parseable — normalizeAnchorEnvelope refused anything else.
  const parsed = canonDeclarationFromDocument(request.document);
  if (!parsed) return null;
  const { declaration } = parsed;

  return (
    <Stack spacing={4}>
      <Card p={5}>
        <HStack justify="space-between" mb={4}>
          <Text textStyle="label">Anchor a Canon declaration</Text>
          <Badge colorScheme="green" display="flex" alignItems="center" gap={1}>
            <MdAnchor /> Canon declaration
          </Badge>
        </HStack>

        {request.origin || request.app ? (
          <Box mb={4}>
            <Text textStyle="label" mb={1}>
              Requested by
            </Text>
            <Code w="100%" p={2} borderRadius="md" wordBreak="break-all">
              {request.app ? `${sanitizeForDisplay(request.app)} — ` : ""}
              {request.origin ? sanitizeForDisplay(request.origin) : "(no origin provided)"}
            </Code>
          </Box>
        ) : null}

        <Box mb={4}>
          <Text textStyle="label" mb={1}>
            The declaration being published
          </Text>
          <Stack spacing={2} p={3} borderRadius="md" borderWidth="1px" fontSize="sm">
            {declaration.declares.map((entry) => (
              <Box key={entry.kind + entry.ref}>
                <Text>
                  Key recognizes the{" "}
                  <b>{entry.kind === "container" ? "collection" : "creator token"}</b>
                  {entry.label ? ` “${sanitizeForDisplay(entry.label)}”` : ""}
                </Text>
                <Code fontSize="xs" wordBreak="break-all">
                  {entry.ref}
                </Code>
              </Box>
            ))}
            {declaration.revokes.map((ref) => (
              <Box key={ref}>
                <Text>
                  Key <b>withdraws recognition</b> of
                </Text>
                <Code fontSize="xs" wordBreak="break-all">
                  {ref}
                </Code>
              </Box>
            ))}
            <Text color="gray.400" fontSize="xs">
              Signer {sanitizeForDisplay(declaration.signer)} · dated{" "}
              {sanitizeForDisplay(declaration.issued)} ·{" "}
              {declaration.expires
                ? `expires ${sanitizeForDisplay(declaration.expires)}`
                : "no expiry"}
            </Text>
            {declaration.comment ? (
              <Text color="gray.400" fontSize="xs">
                “{sanitizeForDisplay(declaration.comment)}”
              </Text>
            ) : null}
          </Stack>
        </Box>

        <Alert status="warning" borderRadius="lg" mb={4}>
          <AlertIcon as={MdWarning} />
          <Box>
            <AlertTitle fontSize="sm">Anchoring is permanent</AlertTitle>
            <AlertDescription fontSize="sm">
              This publishes the declaration to the blockchain forever — it cannot be deleted,
              only superseded by a later one. This wallet pays the transaction fees.
            </AlertDescription>
          </Box>
        </Alert>

        <Box mb={4}>
          <Text textStyle="label" mb={1}>
            Exact document to be committed ({request.document.length} bytes)
          </Text>
          <Code
            display="block"
            w="100%"
            p={2}
            borderRadius="md"
            whiteSpace="pre-wrap"
            wordBreak="break-all"
            fontSize="xs"
            maxH="200px"
            overflowY="auto"
          >
            {sanitizeForDisplay(request.document)}
          </Code>
        </Box>

        <HStack>
          <Button colorScheme="green" onClick={onApprove} isLoading={busy}>
            {request.broadcast === false ? "Build (no broadcast)" : "Anchor on-chain"}
          </Button>
          <Button variant="ghost" onClick={onReject} isDisabled={busy}>
            Reject
          </Button>
        </HStack>
      </Card>
    </Stack>
  );
}
