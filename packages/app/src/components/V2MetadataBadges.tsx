import React from "react";
import { HStack, Badge, Tooltip, Icon } from "@chakra-ui/react";
import { Trans } from "@lingui/macro";
import {
  MdLock,
  MdVerified,
  MdLocalFireDepartment,
  MdSecurity,
  MdTimer,
  MdFolder,
} from "react-icons/md";
import { GlyphV2Metadata } from "@lib/v2metadata";
import { isSoulbound } from "@lib/soulbound";
import { isContainer } from "@lib/container";
import { isAuthority } from "@lib/authority";
import { isWaveName } from "@lib/wavenaming";
import { GLYPH_ENCRYPTED, GLYPH_TIMELOCK } from "@lib/protocols";

type V2MetadataBadgesProps = {
  metadata: GlyphV2Metadata;
};

export default function V2MetadataBadges({ metadata }: V2MetadataBadgesProps) {
  const showRoyalty = metadata.royalty && metadata.royalty.bps > 0;
  const showSoulbound = isSoulbound(metadata.policy);
  const showEncrypted = metadata.p.includes(GLYPH_ENCRYPTED);
  const showTimelocked = metadata.p.includes(GLYPH_TIMELOCK);
  const showContainer = isContainer(metadata);
  const showAuthority = isAuthority(metadata);
  const showWave = isWaveName(metadata);
  const showCreatorSig = typeof metadata.creator === "object" && metadata.creator.sig;

  return (
    <HStack spacing={2} flexWrap="wrap">
      {showRoyalty && (
        <Tooltip
          label={`${metadata.royalty!.enforced ? "Enforced" : "Advisory"} Royalty: ${metadata.royalty!.bps / 100}%`}
        >
          <Badge
            colorScheme={metadata.royalty!.enforced ? "purple" : "gray"}
            display="flex"
            alignItems="center"
            gap={1}
          >
            <Icon as={MdLocalFireDepartment} />
            {metadata.royalty!.bps / 100}% Royalty
          </Badge>
        </Tooltip>
      )}

      {showSoulbound && (
        <Tooltip label="Non-transferable (Soulbound)">
          <Badge colorScheme="orange" display="flex" alignItems="center" gap={1}>
            <Icon as={MdLock} />
            Soulbound
          </Badge>
        </Tooltip>
      )}

      {showCreatorSig && (
        <Tooltip label="Creator signature verified">
          <Badge colorScheme="green" display="flex" alignItems="center" gap={1}>
            <Icon as={MdVerified} />
            Verified
          </Badge>
        </Tooltip>
      )}

      {showEncrypted && (
        <Tooltip label="Contains encrypted content">
          <Badge colorScheme="blue" display="flex" alignItems="center" gap={1}>
            <Icon as={MdSecurity} />
            Encrypted
          </Badge>
        </Tooltip>
      )}

      {showTimelocked && (
        <Tooltip label="Timelocked reveal">
          <Badge colorScheme="cyan" display="flex" alignItems="center" gap={1}>
            <Icon as={MdTimer} />
            Timelocked
          </Badge>
        </Tooltip>
      )}

      {showContainer && (
        <Tooltip
          label={`Collection (${metadata.container?.minted || 0}/${metadata.container?.max_items || "∞"})`}
        >
          <Badge colorScheme="teal" display="flex" alignItems="center" gap={1}>
            <Icon as={MdFolder} />
            Collection
          </Badge>
        </Tooltip>
      )}

      {showAuthority && (
        <Tooltip label="Authority Token">
          <Badge colorScheme="red" display="flex" alignItems="center" gap={1}>
            <Icon as={MdSecurity} />
            Authority
          </Badge>
        </Tooltip>
      )}

      {showWave && (
        <Tooltip label="WAVE Name">
          <Badge colorScheme="pink" display="flex" alignItems="center" gap={1}>
            WAVE
          </Badge>
        </Tooltip>
      )}
    </HStack>
  );
}
