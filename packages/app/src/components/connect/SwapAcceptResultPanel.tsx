/**
 * Result screen after a `swap-accept-request` completes: the broadcast
 * txid.
 */
import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Box,
  Button,
  Code,
  Stack,
  Text,
  useClipboard,
} from "@chakra-ui/react";
import { MdCheck, MdContentCopy } from "react-icons/md";
import Card from "@app/components/Card";
import type { SwapAcceptResult } from "@app/connect/protocol";

export default function SwapAcceptResultPanel({
  result,
  onDone,
}: {
  result: SwapAcceptResult;
  onDone: () => void;
}) {
  const { onCopy, hasCopied } = useClipboard(result.txid);

  return (
    <Stack spacing={4}>
      <Alert status="success" borderRadius="lg">
        <AlertIcon />
        <Box>
          <AlertTitle>Purchase complete</AlertTitle>
          <AlertDescription fontSize="sm">
            The transaction was broadcast to the network.
          </AlertDescription>
        </Box>
      </Alert>

      <Card p={5}>
        <Text textStyle="label" mb={1}>
          Transaction id
        </Text>
        <Code
          display="block"
          w="100%"
          p={2}
          borderRadius="md"
          whiteSpace="pre-wrap"
          wordBreak="break-all"
          fontSize="xs"
        >
          {result.txid}
        </Code>
        <Button
          mt={2}
          size="sm"
          leftIcon={hasCopied ? <MdCheck /> : <MdContentCopy />}
          onClick={onCopy}
          variant="ghost"
        >
          {hasCopied ? "Copied!" : "Copy"}
        </Button>
      </Card>

      <Button variant="solid" onClick={onDone}>
        Done
      </Button>
    </Stack>
  );
}
