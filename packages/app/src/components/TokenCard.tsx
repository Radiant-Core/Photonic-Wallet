import { Badge, Box, Flex, Icon, Text, Tooltip } from "@chakra-ui/react";
import Outpoint from "@lib/Outpoint";
import { SmartToken } from "@app/types";
import { Link } from "react-router-dom";
import Identifier from "@app/components/Identifier";
import Photons from "@app/components/Photons";
import TokenContent from "@app/components/TokenContent";
import { TbBox, TbUserCircle } from "react-icons/tb";
import { IconType } from "react-icons/lib";
import { LinkIcon } from "@chakra-ui/icons";
import { RiSwap2Line } from "react-icons/ri";
import { MdLock, MdTimer } from "react-icons/md";
import { GLYPH_ENCRYPTED, GLYPH_TIMELOCK } from "@lib/protocols";

export default function TokenCard({
  glyph,
  value,
  to,
  size = "md",
  defaultIcon,
  pending,
}: {
  glyph?: SmartToken;
  value: number;
  to: string;
  size?: "sm" | "md";
  defaultIcon?: IconType;
  // True while the holding UTXO is unconfirmed (still in the mempool).
  pending?: boolean;
}) {
  const ref = Outpoint.fromString(glyph?.ref || "");
  const isLink = !!glyph?.location;
  const isEncrypted = !!glyph?.p?.includes(GLYPH_ENCRYPTED);
  const isTimelocked = !!glyph?.p?.includes(GLYPH_TIMELOCK);

  const short = ref.shortInput();
  // Shared corner-chip style so every status badge reads as one family.
  const chip = {
    position: "absolute" as const,
    bgColor: "blackAlpha.600",
    backdropFilter: "blur(6px)",
    borderRadius: "sm",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    p: 1.5,
  };
  return (
    <Box
      borderRadius="lg"
      overflow="hidden"
      as={Link}
      to={to}
      display="block"
      borderWidth="1px"
      borderColor="border.subtle"
      boxShadow="sm"
      transition="transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease"
      _hover={{
        transform: "translateY(-2px)",
        boxShadow: "md",
        borderColor: "border.strong",
      }}
    >
      <Box
        bg="surface.sunken"
        height={size === "sm" ? "175px" : "250px"}
        display="flex"
        position="relative"
        alignItems="center"
        justifyContent="center"
        p={2}
      >
        {isLink && (
          <Box {...chip} top={2} right={2}>
            <LinkIcon boxSize={4} />
          </Box>
        )}
        {glyph?.swapPending && (
          <Box {...chip} bottom={2} right={2}>
            <Icon as={RiSwap2Line} boxSize={4} />
          </Box>
        )}
        {pending && (
          <Tooltip label="Awaiting block confirmation" placement="top">
            <Badge
              position="absolute"
              bottom={2}
              left={2}
              colorScheme="yellow"
              variant="solid"
            >
              {"Unconfirmed"}
            </Badge>
          </Tooltip>
        )}
        {(isEncrypted || isTimelocked) && (
          <Tooltip
            label={isTimelocked ? "Timelocked" : "Encrypted"}
            placement="top"
          >
            <Box {...chip} top={2} left={2}>
              <Icon
                as={isTimelocked ? MdTimer : MdLock}
                boxSize={4}
                color={isTimelocked ? "orange.300" : "purple.300"}
              />
            </Box>
          </Tooltip>
        )}
        <TokenContent glyph={glyph} defaultIcon={defaultIcon} thumbnail />
      </Box>
      <Flex
        p={2}
        pr={3}
        bg="surface.raised"
        alignItems="center"
        justifyContent="space-between"
        gap={2}
        lineHeight={8}
      >
        <Flex alignItems="center">
          {glyph?.type === "user" && <Icon as={TbUserCircle} fontSize="2xl" />}
          {glyph?.type === "container" && <Icon as={TbBox} fontSize="2xl" />}
          {glyph?.name ? (
            <Text
              fontWeight="500"
              color="lightBlue.A400"
              whiteSpace="nowrap"
              overflow="hidden"
              textOverflow="ellipsis"
              ml={1}
            >
              {glyph?.name}
            </Text>
          ) : (
            <Identifier>{short}</Identifier>
          )}
        </Flex>
        <Text whiteSpace="nowrap" fontFamily="mono">
          <Photons value={value} />
        </Text>
      </Flex>
    </Box>
  );
}
