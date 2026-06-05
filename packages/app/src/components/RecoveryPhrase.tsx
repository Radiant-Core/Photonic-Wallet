import { useEffect, useRef, useState } from "react";
import { CopyIcon } from "@chakra-ui/icons";
import {
  Alert,
  AlertIcon,
  AlertDescription,
  Box,
  Center,
  Button,
  useClipboard,
} from "@chakra-ui/react";
import RecoveryPhraseWords from "./RecoveryPhraseWords";
import ActionIcon from "./ActionIcon";

// Auto-wipe the clipboard this long after copying the recovery phrase, so a
// secret 12-word seed doesn't linger in the system clipboard indefinitely.
const CLIPBOARD_CLEAR_MS = 45000;

export default function RecoveryPhrase({ phrase }: { phrase: string }) {
  const { onCopy, hasCopied } = useClipboard(phrase);
  const [cleared, setCleared] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending timer on unmount.
  useEffect(() => {
    return () => {
      if (clearTimer.current) {
        clearTimeout(clearTimer.current);
      }
    };
  }, []);

  const handleCopy = () => {
    onCopy();
    setCleared(false);
    if (clearTimer.current) {
      clearTimeout(clearTimer.current);
    }
    clearTimer.current = setTimeout(() => {
      // Best-effort wipe: only overwrite if the clipboard still holds OUR
      // phrase, so we never clobber something the user copied in the meantime.
      // navigator.clipboard may be unavailable (insecure context / older
      // webview); fall back to a blind overwrite, and swallow any rejection.
      const wipe = () =>
        navigator.clipboard?.writeText("").catch(() => {
          /* clipboard write blocked — nothing more we can do */
        });
      try {
        if (navigator.clipboard?.readText) {
          navigator.clipboard
            .readText()
            .then((current) => {
              if (current === phrase) {
                void wipe();
              }
            })
            .catch(() => {
              // readText denied (e.g. not focused) — overwrite blindly.
              void wipe();
            });
        } else {
          void wipe();
        }
      } catch {
        void wipe();
      }
      setCleared(true);
    }, CLIPBOARD_CLEAR_MS);
  };

  return (
    <>
      <Alert status="warning" mb={8}>
        <AlertIcon />
        <AlertDescription>
          {
            "Your recovery phrase is the only way to restore your wallet after logging out. Keep it in a safe place and never share it."
          }
        </AlertDescription>
      </Alert>
      <RecoveryPhraseWords words={phrase.split(" ")} />
      <Center mb={hasCopied ? 2 : 4}>
        <Button
          onClick={handleCopy}
          leftIcon={<ActionIcon as={CopyIcon} />}
          variant="ghost"
        >
          {hasCopied ? "Copied!" : "Copy to clipboard"}
        </Button>
      </Center>
      {hasCopied && (
        <Box
          mb={4}
          fontSize="sm"
          color="orange.300"
          textAlign="center"
          px={4}
        >
          {cleared
            ? "Clipboard cleared. Paste your phrase somewhere safe before it is wiped next time."
            : `Recovery phrase copied to the clipboard. For your safety it will be cleared automatically in about ${Math.round(
                CLIPBOARD_CLEAR_MS / 1000
              )} seconds — paste it somewhere safe now.`}
        </Box>
      )}
    </>
  );
}
