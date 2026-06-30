import { useEffect, useRef, useState } from "react";
import { CopyIcon } from "@chakra-ui/icons";
import {
  Alert,
  AlertIcon,
  AlertDescription,
  Box,
  Center,
  Button,
} from "@chakra-ui/react";
import RecoveryPhraseWords from "./RecoveryPhraseWords";
import ActionIcon from "./ActionIcon";
import { readTextOrNull, copyText } from "@app/platform";

// Auto-wipe the clipboard this long after copying the recovery phrase, so a
// secret 12-word seed doesn't linger in the system clipboard indefinitely.
const CLIPBOARD_CLEAR_MS = 45000;
// How long the "Copied!" affordance stays lit (mirrors Chakra useClipboard).
const COPIED_FLASH_MS = 1500;

export default function RecoveryPhrase({ phrase }: { phrase: string }) {
  const [hasCopied, setHasCopied] = useState(false);
  const [cleared, setCleared] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending timers on unmount.
  useEffect(() => {
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const handleCopy = () => {
    // Route the seed copy through the platform clipboard (@capacitor/clipboard
    // on native, navigator.clipboard / execCommand fallback on web) so it works
    // reliably in the iOS WebView, where navigator.clipboard is gesture-gated.
    void copyText(phrase)
      .then(() => {
        setHasCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(
          () => setHasCopied(false),
          COPIED_FLASH_MS,
        );
      })
      .catch(() => {
        /* copy blocked — nothing more we can do */
      });

    setCleared(false);
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => {
      // Best-effort wipe: only overwrite if the clipboard still holds OUR
      // phrase, so we never clobber something the user copied since. If we
      // can't read it back (denied / unsupported), overwrite blindly.
      void (async () => {
        const current = await readTextOrNull();
        if (current === null || current === phrase) {
          await copyText("").catch(() => {
            /* clipboard write blocked — nothing more we can do */
          });
        }
        setCleared(true);
      })();
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
        <Box mb={4} fontSize="sm" color="orange.300" textAlign="center" px={4}>
          {cleared
            ? "Clipboard cleared. Paste your phrase somewhere safe before it is wiped next time."
            : `Recovery phrase copied to the clipboard. For your safety it will be cleared automatically in about ${Math.round(
                CLIPBOARD_CLEAR_MS / 1000,
              )} seconds — paste it somewhere safe now.`}
        </Box>
      )}
    </>
  );
}
