/**
 * Approval screen for an incoming `psbt-sign-request`. Shows exactly what the
 * user is about to sign — which inputs are theirs vs. external, where the
 * money goes, the fee (or an honest "unknown" when it can't be computed),
 * and whether the wallet will hand back a PSBT or broadcast a finished
 * transaction — before `Connect.tsx` calls `signAndMaybeBroadcast`.
 *
 * Every field here is either the wallet's own signal state or the output of
 * `psbtFlow.enrichPsbt`; nothing is trusted from the request except by way
 * of that enrichment (which cross-checks against `db.txo`).
 */
import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Box,
  Code,
  Divider,
  Flex,
  HStack,
  Stack,
  Text,
  Button,
} from "@chakra-ui/react";
import { MdCloudUpload, MdUndo, MdWarning } from "react-icons/md";
import Card from "@app/components/Card";
import { photonsToRXD } from "@lib/format";
import type { PsbtSignRequest } from "@app/connect/protocol";
import type { EnrichedPsbt } from "@app/connect/psbtFlow";
import type { PsbtInputSummary, PsbtOutputSummary } from "@lib/psbt";

const SIGHASH_LABELS: Record<string, string> = {
  SIGHASH_SINGLE: "commits to only one output",
  SIGHASH_ANYONECANPAY: "other inputs may still be added",
};

function amount(value?: bigint) {
  return value !== undefined ? `${photonsToRXD(Number(value))} RXD` : "—";
}

function InputRow({
  input,
  mismatch,
  alreadySpent,
}: {
  input: PsbtInputSummary;
  mismatch: boolean;
  alreadySpent: boolean;
}) {
  return (
    <Flex
      align="center"
      justify="space-between"
      py={2}
      borderBottomWidth="1px"
      borderColor="border.subtle"
      gap={3}
    >
      <Box minW={0} flex={1}>
        <Text fontSize="sm" noOfLines={1} title={`${input.txid}:${input.vout}`}>
          {input.address ?? `${input.txid.slice(0, 12)}…:${input.vout}`}
        </Text>
        <HStack spacing={1} mt={1} flexWrap="wrap">
          <Badge colorScheme={input.mine ? "green" : "gray"} fontSize="xs">
            {input.mine ? "Your wallet" : "External"}
          </Badge>
          {input.tokenBearing && (
            <Badge colorScheme="red" fontSize="xs">
              Token
            </Badge>
          )}
          {alreadySpent && (
            <Badge colorScheme="orange" fontSize="xs">
              Already spent
            </Badge>
          )}
          {mismatch && (
            <Badge colorScheme="red" fontSize="xs">
              Mismatch
            </Badge>
          )}
          {input.finalized && (
            <Badge colorScheme="blue" fontSize="xs">
              Finalized
            </Badge>
          )}
        </HStack>
      </Box>
      <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap">
        {amount(input.value)}
      </Text>
    </Flex>
  );
}

function OutputRow({ output }: { output: PsbtOutputSummary }) {
  return (
    <Flex
      align="center"
      justify="space-between"
      py={2}
      borderBottomWidth="1px"
      borderColor="border.subtle"
      gap={3}
    >
      <Box minW={0} flex={1}>
        <Text fontSize="sm" noOfLines={1} title={output.script}>
          {output.address ?? "(non-standard output)"}
        </Text>
        {output.mine && (
          <Badge colorScheme="green" fontSize="xs" mt={1}>
            To your wallet
          </Badge>
        )}
        {output.tokenBearing && (
          <Badge colorScheme="purple" fontSize="xs" mt={1} ml={output.mine ? 1 : 0}>
            Token
          </Badge>
        )}
      </Box>
      <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap">
        {amount(output.value)}
      </Text>
    </Flex>
  );
}

export default function PsbtRequestPanel({
  request,
  enriched,
  signerAddress,
  locked,
  autoReturn,
  busy,
  onApprove,
  onReject,
}: {
  request: PsbtSignRequest;
  enriched: EnrichedPsbt;
  signerAddress: string;
  locked: boolean;
  autoReturn: boolean;
  busy?: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { analysis, inputs: enrichment, blockers, signableCount } = enriched;
  const canApprove = blockers.length === 0;
  const sighashWarnings = analysis.warnings.filter((w) =>
    w.startsWith("SIGHASH_")
  );

  return (
    <Stack spacing={4}>
      <Card p={5}>
        <Flex align="center" justify="space-between" mb={4}>
          <Text textStyle="label">Transaction to sign</Text>
          {request.broadcast ? (
            <Badge
              colorScheme="orange"
              display="flex"
              alignItems="center"
              gap={1}
            >
              <MdCloudUpload /> Will broadcast
            </Badge>
          ) : (
            <Badge
              colorScheme="blue"
              display="flex"
              alignItems="center"
              gap={1}
            >
              <MdUndo /> Returns to app
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

        {request.broadcast && (
          <Alert status="warning" mb={4} borderRadius="lg">
            <AlertIcon />
            <AlertDescription fontSize="sm">
              If your signature completes this transaction, Photonic will
              broadcast it immediately — this cannot be undone.
            </AlertDescription>
          </Alert>
        )}

        {blockers.map((reason, i) => (
          <Alert status="error" mb={3} borderRadius="lg" key={i}>
            <AlertIcon />
            <AlertDescription fontSize="sm">{reason}</AlertDescription>
          </Alert>
        ))}

        <Text textStyle="label" mb={1}>
          Inputs ({analysis.inputs.length})
        </Text>
        <Box mb={4}>
          {analysis.inputs.map((input, i) => (
            <InputRow
              key={i}
              input={input}
              mismatch={enrichment[i]?.scriptMismatch ?? false}
              alreadySpent={enrichment[i]?.alreadySpent ?? false}
            />
          ))}
        </Box>

        <Text textStyle="label" mb={1}>
          Outputs ({analysis.outputs.length})
        </Text>
        <Box mb={4}>
          {analysis.outputs.map((output, i) => (
            <OutputRow key={i} output={output} />
          ))}
        </Box>

        <Divider mb={4} />

        <Flex justify="space-between" mb={1}>
          <Text textStyle="label">Network fee</Text>
          <Text fontSize="sm" fontWeight="medium">
            {analysis.fee !== undefined ? amount(analysis.fee) : "Unknown"}
          </Text>
        </Flex>
        {analysis.warnings.includes("FEE_UNKNOWN") && (
          <Text textStyle="small" color="text.secondary" mb={2}>
            One or more inputs' amounts couldn't be resolved, so the fee can't
            be verified.
          </Text>
        )}
        {analysis.warnings.includes("HIGH_FEE") && (
          <Alert status="warning" mb={2} borderRadius="lg">
            <AlertIcon />
            <AlertDescription fontSize="sm">
              This fee is unusually high for the transaction size. Double
              check before approving.
            </AlertDescription>
          </Alert>
        )}

        {sighashWarnings.length > 0 && (
          <Alert status="warning" mt={2} mb={2} borderRadius="lg">
            <AlertIcon as={MdWarning} />
            <Box>
              <AlertTitle fontSize="sm">Non-standard signing terms</AlertTitle>
              <AlertDescription fontSize="sm">
                {sighashWarnings
                  .map((w) => SIGHASH_LABELS[w] ?? w)
                  .filter(Boolean)
                  .join("; ")}
                . Other parties may still change parts of this transaction
                after you sign.
              </AlertDescription>
            </Box>
          </Alert>
        )}

        <Text textStyle="small" mt={2}>
          Signing as <b>{signerAddress || "(no wallet address)"}</b> —{" "}
          {signableCount} of your input{signableCount === 1 ? "" : "s"} will
          be signed.
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
            You will be asked to unlock your wallet to sign.
          </Text>
        )}
      </Card>

      <Alert status="info" borderRadius="lg">
        <AlertIcon />
        <AlertDescription fontSize="sm">
          Photonic only signs plain inputs your wallet owns. It never signs
          token-bearing inputs, and it never reveals your seed phrase.
        </AlertDescription>
      </Alert>

      <HStack spacing={3}>
        <Button
          variant="primary"
          onClick={onApprove}
          flex={1}
          isDisabled={!canApprove || busy}
          isLoading={busy}
          loadingText="Signing…"
        >
          Approve &amp; sign
        </Button>
        <Button variant="ghost" onClick={onReject} isDisabled={busy}>
          Reject
        </Button>
      </HStack>
    </Stack>
  );
}
