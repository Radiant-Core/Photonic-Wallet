import { Button, Flex, FlexProps, Grid, Badge, Text, Tooltip } from "@chakra-ui/react";
import { t } from "@lingui/macro";
import { openModal } from "@app/signals";
import ValueTag from "./ValueTag";
import ActionIcon from "./ActionIcon";
import { TbArrowDownLeft, TbArrowUpRight } from "react-icons/tb";
import Balance from "./Balance";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { SmartTokenType } from "@app/types";
import { GLYPH_WAVE } from "@lib/protocols";
import { HiOutlineAtSymbol } from "react-icons/hi";

export default function AccountBar(props: FlexProps) {
  // Fetch primary WAVE name (user preference or alphabetically first active)
  const primaryWaveName = useLiveQuery(async () => {
    // First check user preference
    const preference = await db.kvp.get("primaryWaveName") as string | undefined;

    const tokens = await db.glyph
      .where("tokenType")
      .equals(SmartTokenType.NFT)
      .filter((glyph) => {
        return glyph.spent === 0 && !!glyph.p?.includes(GLYPH_WAVE);
      })
      .toArray();

    const now = Math.floor(Date.now() / 1000);
    const activeNames = tokens
      .map((t) => {
        const attrs = t.attrs as Record<string, string> | undefined;
        if (!attrs?.name) return null;
        const expires = attrs.expires ? parseInt(attrs.expires) : undefined;
        if (expires && expires <= now) return null; // Skip expired
        return `${attrs.name}${attrs.domain ? `.${attrs.domain}` : ".rxd"}`;
      })
      .filter(Boolean) as string[];

    // If user has a preference and it's still owned/active, use it
    if (preference && activeNames.includes(preference)) {
      return preference;
    }

    // Otherwise return alphabetically first active name
    return activeNames.sort()[0];
  }, []);

  return (
    <Flex flexDir="column" alignItems="center" mx={4} {...props}>
      {/* Primary WAVE Name Badge */}
      {primaryWaveName && (
        <Tooltip label={"Your primary WAVE name"} placement="top">
          <Badge
            colorScheme="brand"
            mb={3}
            px={3}
            py={1}
            borderRadius="full"
            fontSize="sm"
            display="flex"
            alignItems="center"
            gap={1}
            cursor="pointer"
            onClick={() => window.location.href = "#/wave-names"}
            _hover={{ bg: "brand.600" }}
          >
            <HiOutlineAtSymbol />
            {primaryWaveName}
          </Badge>
        </Tooltip>
      )}
      <ValueTag mb={{ base: 2, lg: 6 }}>
        <Balance />
      </ValueTag>
      <Grid
        gridTemplateColumns="repeat(2, minmax(0, 1fr))"
        gap={{ base: 2, "2xl": 4 }}
        w={{ base: "100%", lg: "initial" }}
      >
        <Button
          size={{ base: "sm", "2xl": "md" }}
          leftIcon={<ActionIcon as={TbArrowDownLeft} />}
          onClick={() => (openModal.value = { modal: "receive" })}
        >
          {"Receive"}
        </Button>
        <Button
          size={{ base: "sm", "2xl": "md" }}
          leftIcon={<ActionIcon as={TbArrowUpRight} />}
          onClick={() => (openModal.value = { modal: "send" })}
        >
          {"Send"}
        </Button>
      </Grid>
    </Flex>
  );
}
