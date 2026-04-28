import { useState, useEffect, useRef } from "react";
import { Box, Icon, Image, Text, HStack, Badge } from "@chakra-ui/react";
import { QRCodeSVG } from "qrcode.react";
import { SmartToken } from "@app/types";
import { TbLink } from "react-icons/tb";
import { FaCircleXmark } from "react-icons/fa6";
import {
  BsFileEarmarkFill,
  BsFillFileTextFill,
  BsFillFileImageFill,
  BsFillFileXFill,
} from "react-icons/bs";
import Identifier from "./Identifier";
import useIpfsUrl from "@app/hooks/useIpfsUrl";
import UnsafeImage from "./UnsafeImage";
import { IconBaseProps, IconType } from "react-icons/lib";
import { GLYPH_ENCRYPTED, GLYPH_TIMELOCK } from "@lib/protocols";
import { formatTimeRemaining, getUnlockRemaining } from "@lib/timelock";
import { MdTimer, MdLockOpen } from "react-icons/md";
import EncryptedContentUnlock from "./EncryptedContentUnlock";

export default function TokenContent({
  glyph,
  thumbnail = false,
  defaultIcon = BsFillFileXFill,
  decryptedBytes: controlledBytes,
  decryptedMime: controlledMime,
  onDecrypted: controlledOnDecrypted,
}: {
  glyph?: SmartToken;
  thumbnail?: boolean;
  defaultIcon?: ((props: IconBaseProps) => JSX.Element) | IconType;
  /** Controlled: decrypted bytes from parent (ViewDigitalObject) */
  decryptedBytes?: Uint8Array | null;
  /** Controlled: decrypted MIME type from parent */
  decryptedMime?: string;
  /** Controlled: callback to parent when decryption succeeds */
  onDecrypted?: (bytes: Uint8Array, mime: string) => void;
}) {
  const [internalBytes, setInternalBytes] = useState<Uint8Array | null>(null);
  const [internalMime, setInternalMime] = useState<string>("application/octet-stream");
  // Use controlled state when parent provides it, otherwise fall back to internal
  const decryptedBytes = controlledBytes !== undefined ? controlledBytes : internalBytes;
  const decryptedMime = controlledMime !== undefined ? controlledMime : internalMime;
  const [, forceUpdate] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isEncrypted = !!(glyph?.p?.includes(GLYPH_ENCRYPTED));
  const isTimelocked = !!(glyph?.p?.includes(GLYPH_TIMELOCK));

  // Start a 1-second interval while content is timelocked and not yet decrypted
  useEffect(() => {
    if (!isTimelocked || decryptedBytes) return;
    timerRef.current = setInterval(() => forceUpdate((n) => n + 1), 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isTimelocked, decryptedBytes]);

  if (isEncrypted && !decryptedBytes) {
    const rawPayload = glyph as unknown as Record<string, unknown>;
    const stub = rawPayload?.crypto as any;
    const locator = rawPayload?.locator as string | undefined;
    const locatorNonce = rawPayload?.locator_nonce as string | undefined;
    const mainObj = rawPayload?.main as any;
    const mainB = mainObj?.b as string | undefined; // hex ciphertext for on-chain (glyph) storage
    const contentType = mainObj?.type as string | undefined;

    const unlockAt: number | undefined = stub?.timelock?.unlock_at;
    const remaining = isTimelocked && unlockAt
      ? getUnlockRemaining(
          // Minimal shape accepted by getUnlockRemaining
          { p: glyph!.p, main: stub?.main ?? {}, crypto: stub ?? {} } as any
        )
      : 0;
    const stillLocked = remaining > 0;

    if (thumbnail) {
      return (
        <Box position="relative" width="100%" height="100%">
          <Icon as={stillLocked ? MdTimer : MdLockOpen} width="100%" height="100%" color={stillLocked ? "orange.400" : "blue.400"} />
          {stillLocked && (
            <Badge
              position="absolute"
              bottom={0}
              right={0}
              colorScheme="orange"
              fontSize="0.55em"
              px={1}
            >
              {formatTimeRemaining(remaining)}
            </Badge>
          )}
        </Box>
      );
    }

    const handleDecrypted = (plaintext: Uint8Array) => {
      const resolvedMime = contentType || "application/octet-stream";
      if (controlledOnDecrypted) {
        controlledOnDecrypted(plaintext, resolvedMime);
      } else {
        setInternalBytes(plaintext);
        setInternalMime(resolvedMime);
      }
    };

    return (
      <Box>
        {isTimelocked && stillLocked && (
          <HStack
            bg="orange.900"
            borderRadius="md"
            px={3}
            py={2}
            mb={3}
            spacing={2}
          >
            <Icon as={MdTimer} color="orange.300" fontSize="lg" />
            <Box>
              <Text fontSize="sm" fontWeight="bold" color="orange.200">
                Timelocked — unlocks in {formatTimeRemaining(remaining)}
              </Text>
              {unlockAt && (
                <Text fontSize="xs" color="orange.400">
                  {new Date(unlockAt * 1000).toLocaleString()}
                </Text>
              )}
            </Box>
          </HStack>
        )}
        <EncryptedContentUnlock
          stub={stub || { main: {}, crypto: {} }}
          locator={locator}
          locatorNonce={locatorNonce}
          mainB={mainB}
          tokenRef={glyph?.ref}
          onDecrypted={handleDecrypted}
        />
      </Box>
    );
  }

  const embed = decryptedBytes
    ? { t: decryptedMime, b: decryptedBytes }
    : glyph?.embed;
  const { remote } = glyph || {};
  const maxLen = 1000;

  // Image URL
  if (remote && remote.t?.startsWith("image/")) {
    const isIpfs = remote.u?.match(/^ipfs:\/\//);
    const url = isIpfs ? useIpfsUrl(remote.u) : remote.u;
    if (isIpfs) {
      return (
        <Image
          src={url}
          width="100%"
          height="100%"
          objectFit="contain"
          //sx={{ imageRendering: "pixelated" }}
          backgroundColor="black"
        />
      );
    } else {
      if (thumbnail) {
        return (
          <Icon
            as={BsFillFileImageFill}
            width="100%"
            height="100%"
            color="gray.500"
          />
        );
      } else {
        return <UnsafeImage src={url} />;
      }
    }
  }

  // Non-image URL
  if (remote) {
    if (thumbnail) {
      return <Icon as={TbLink} width="100%" height="100%" color="gray.500" />;
    }
    return (
      <>
        {thumbnail || (
          <Box borderRadius="md" overflow="hidden" mb={4}>
            <QRCodeSVG size={256} value={remote.u} includeMargin />
          </Box>
        )}
        <div>
          <Identifier copyValue={remote.u} showCopy>
            {remote.u.substring(0, 200)}
            {remote.u.length > 200 && "..."}
          </Identifier>
        </div>
      </>
    );
  }

  if (embed) {
    // Text file
    if (embed.t?.startsWith("text/plain")) {
      if (thumbnail) {
        return (
          <Icon
            as={BsFillFileTextFill}
            width="100%"
            height="100%"
            color="gray.500"
          />
        );
      }

      const text = new TextDecoder("utf-8").decode(embed.b);
      return (
        <Box as="pre" whiteSpace="pre-wrap">
          {text.substring(0, maxLen)}
          {text.length > maxLen && "..."}
        </Box>
      );
    }

    // Image file
    if (embed.t?.startsWith("image/")) {
      const blob = new Blob([embed.b as BlobPart], { type: embed.t });
      const imgUrl = URL.createObjectURL(blob);
      return (
        <Image
          src={imgUrl}
          width="100%"
          height="100%"
          objectFit="contain"
          //sx={{ imageRendering: "pixelated" }} // TODO find a way to apply this to pixel art
          //backgroundColor="white"
        />
      );
    }

    // Unknown file
    if (thumbnail) {
      return (
        <Icon
          as={BsFileEarmarkFill}
          width="100%"
          height="100%"
          color="gray.500"
        />
      );
    }

    return (
      <Icon
        as={BsFileEarmarkFill}
        width="100%"
        height="100%"
        maxWidth="200px"
        color="gray.500"
        mb={2}
      />
    );
  }

  if (thumbnail) {
    return (
      <Icon as={defaultIcon} width="100%" height="100%" color="gray.500" />
    );
  }

  return (
    <>
      <Icon as={FaCircleXmark} boxSize={8} color="gray.500" />
      <Box fontSize="md" userSelect="none" mt={2}>
        No content
      </Box>
    </>
  );
}
