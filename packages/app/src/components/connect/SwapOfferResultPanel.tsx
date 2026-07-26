/**
 * Result screen after a `swap-offer-request` completes: the raw PSRT for
 * the dApp to index/distribute itself (private mode has no on-chain
 * advertisement to point at).
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
import type { SwapOfferResult } from "@app/connect/protocol";

export default function SwapOfferResultPanel({
  result,
  onDone,
}: {
  result: SwapOfferResult;
  onDone: () => void;
}) {
  const { onCopy, hasCopied } = useClipboard(result.psrt);

  return (
    <Stack spacing={4}>
      <Alert status="success" borderRadius="lg">
        <AlertIcon />
        <Box>
          <AlertTitle>Listed</AlertTitle>
          <AlertDescription fontSize="sm">
            The item was reserved and a signed offer was created.
          </AlertDescription>
        </Box>
      </Alert>

      <Card p={5}>
        <Text textStyle="label" mb={1}>
          Signed offer (PSRT)
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
          {result.psrt}
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
        List another
      </Button>
    </Stack>
  );
}
