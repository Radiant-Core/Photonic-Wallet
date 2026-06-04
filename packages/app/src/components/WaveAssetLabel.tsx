import { Badge, Flex, Icon, Text, Tooltip } from "@chakra-ui/react";
import { HiOutlineAtSymbol } from "react-icons/hi";
import { SmartToken } from "@app/types";
import { getWaveDisplay } from "@lib/wave";

/**
 * Expiry summary for a WAVE name, with a Chakra colorScheme. Mirrors the
 * status thresholds used on the WAVE Names page (expired / expiring within 30
 * days / active). Returns null when there is no expiry to show.
 */
export function waveExpiryStatus(
  expires?: number
): { label: string; colorScheme: string } | null {
  if (!expires || expires <= 0) return null;
  const now = Math.floor(Date.now() / 1000);
  const days = Math.floor((expires - now) / 86400);
  const date = new Date(expires * 1000).toLocaleDateString();
  if (now > expires) return { label: `Expired ${date}`, colorScheme: "red" };
  if (days <= 30) return { label: `Expires ${date}`, colorScheme: "orange" };
  return { label: `Valid until ${date}`, colorScheme: "green" };
}

/**
 * Standalone expiry chip for a WAVE name glyph. Renders nothing for non-WAVE
 * glyphs or names without an expiry. Used in compact lists (e.g. marketplace
 * rows) where the name text is already shown separately.
 */
export function WaveExpiryBadge({ glyph }: { glyph?: SmartToken }) {
  const wave = getWaveDisplay(glyph);
  const expiry = waveExpiryStatus(wave?.expires);
  if (!expiry) return null;
  return (
    <Badge colorScheme={expiry.colorScheme} fontSize="0.6em">
      {expiry.label}
    </Badge>
  );
}

/**
 * Renders a WAVE name (name.domain) with an @ icon, an expiry chip, a
 * duplicate warning, and optionally its resolution target. Used wherever a
 * swap UI would otherwise show a generic NFT thumbnail, so buyers/sellers can
 * recognize a name listing at a glance. Returns null for non-WAVE glyphs.
 */
export default function WaveAssetLabel({
  glyph,
  showTarget = false,
  size = "sm",
}: {
  glyph: SmartToken;
  showTarget?: boolean;
  size?: "xs" | "sm" | "md";
}) {
  const wave = getWaveDisplay(glyph);
  if (!wave) return null;
  const expiry = waveExpiryStatus(wave.expires);
  return (
    <Flex direction="column" minW={0}>
      <Flex align="center" gap={1} minW={0}>
        <Icon as={HiOutlineAtSymbol} color="brand.400" boxSize={4} />
        <Text
          fontSize={size}
          fontWeight="semibold"
          isTruncated
          title={wave.full}
        >
          {wave.full}
        </Text>
        {glyph.is_wave_duplicate && (
          <Tooltip label="Not the canonical registration — not used for name resolution">
            <Badge colorScheme="red" fontSize="0.6em">
              DUP
            </Badge>
          </Tooltip>
        )}
      </Flex>
      {expiry && (
        <Badge
          colorScheme={expiry.colorScheme}
          alignSelf="flex-start"
          fontSize="0.6em"
        >
          {expiry.label}
        </Badge>
      )}
      {showTarget && wave.target && (
        <Text fontSize="xs" color="gray.500" isTruncated title={wave.target}>
          → {wave.target}
        </Text>
      )}
    </Flex>
  );
}
