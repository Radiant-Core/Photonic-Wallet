/**
 * Result screen after an `anchor-request` completes: the commit + reveal
 * txids (or, for a dry run — `broadcast: false` — the raw unsent hex) and
 * the document's docHash identity. Mirrors `MintResultPanel`'s shape.
 */
import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Box,
  Button,
  Code,
  Divider,
  Stack,
  Text,
  useClipboard,
} from "@chakra-ui/react";
import { MdCheck, MdContentCopy } from "react-icons/md";
import Card from "@app/components/Card";
import type { AnchorResult } from "@app/connect/protocol";

function CopyField({ label, value }: { label: string; value: string }) {
  const { onCopy, hasCopied } = useClipboard(value);
  return (
    <Box mt={3}>
      <Text textStyle="label" mb={1}>
        {label}
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
        {value}
      </Code>
      <Button
        mt={1}
        size="sm"
        leftIcon={hasCopied ? <MdCheck /> : <MdContentCopy />}
        onClick={onCopy}
        variant="ghost"
      >
        {hasCopied ? "Copied!" : "Copy"}
      </Button>
    </Box>
  );
}

export default function AnchorResultPanel({
  result,
  onDone,
}: {
  result: AnchorResult;
  onDone: () => void;
}) {
  return (
    <Stack spacing={4}>
      {result.broadcast ? (
        <Alert status="success" borderRadius="lg">
          <AlertIcon />
          <Box>
            <AlertTitle>Anchored</AlertTitle>
            <AlertDescription fontSize="sm">
              The declaration is now a permanent on-chain record.
            </AlertDescription>
          </Box>
        </Alert>
      ) : (
        <Alert status="info" borderRadius="lg">
          <AlertIcon />
          <Box>
            <AlertTitle>Built &amp; signed — not broadcast</AlertTitle>
            <AlertDescription fontSize="sm">
              Nothing was sent. Decode the hex below to verify before using
              this in production.
            </AlertDescription>
          </Box>
        </Alert>
      )}

      <Card p={5}>
        {result.broadcast ? (
          <>
            <CopyField label="Reveal transaction (the anchor)" value={result.revealTxid!} />
            <CopyField label="Commit transaction" value={result.commitTxid!} />
          </>
        ) : (
          <>
            <CopyField label="Reveal transaction hex" value={result.revealHex!} />
            <CopyField label="Commit transaction hex" value={result.commitHex!} />
          </>
        )}
        <Divider my={3} />
        <CopyField label="Document hash (docHash)" value={result.docHash} />
      </Card>

      <Button variant="solid" onClick={onDone}>
        Done
      </Button>
    </Stack>
  );
}
