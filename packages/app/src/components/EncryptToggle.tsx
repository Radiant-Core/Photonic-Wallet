/**
 * Encrypt Toggle Component
 *
 * Toggle switch for enabling content encryption in the minting flow.
 * Shows encryption status and basic information.
 */

import { useState } from "react";
import {
  Box,
  Flex,
  Switch,
  Text,
  Icon,
  IconButton,
  VStack,
  UnorderedList,
  ListItem,
  Alert,
  AlertIcon,
  AlertDescription,
  Collapse,
} from "@chakra-ui/react";
import { MdLock, MdLockOpen, MdInfoOutline } from "react-icons/md";

export type EncryptToggleProps = {
  /** Whether encryption is enabled */
  enabled: boolean;
  /** Callback when toggle changes */
  onChange: (enabled: boolean) => void;
  /** Whether the toggle is disabled */
  disabled?: boolean;
  /** Estimated file size after encryption */
  estimatedSize?: string;
  /** Number of chunks */
  numChunks?: number;
};

/**
 * Toggle switch for enabling content encryption
 */
export function EncryptToggle({
  enabled,
  onChange,
  disabled = false,
  estimatedSize,
  numChunks,
}: EncryptToggleProps) {
  const [showInfo, setShowInfo] = useState(false);

  return (
    <Box>
      <Flex align="center" gap={3}>
        <Switch
          isChecked={enabled}
          onChange={(e) => onChange(e.target.checked)}
          isDisabled={disabled}
          colorScheme="purple"
          size="md"
          aria-label="Enable encryption"
        />
        <Flex align="center" gap={2}>
          <Icon
            as={enabled ? MdLock : MdLockOpen}
            color={enabled ? "purple.300" : "gray.500"}
            boxSize={4}
          />
          <Text
            fontSize="sm"
            fontWeight="medium"
            color={enabled ? "purple.300" : "gray.400"}
          >
            {enabled ? "Encryption Enabled" : "Encryption Disabled"}
          </Text>
        </Flex>
        <IconButton
          aria-label="Encryption information"
          icon={<Icon as={MdInfoOutline} />}
          size="xs"
          variant="ghost"
          colorScheme="gray"
          onClick={() => setShowInfo((v) => !v)}
          ml="auto"
        />
      </Flex>

      {enabled && estimatedSize && (
        <Text fontSize="xs" color="gray.400" mt={2} ml={1}>
          Estimated encrypted size: <Text as="span" color="gray.200" fontWeight="medium">{estimatedSize}</Text>
          {numChunks !== undefined && (
            <Text as="span" color="gray.500"> ({numChunks} chunk{numChunks !== 1 ? "s" : ""})</Text>
          )}
        </Text>
      )}

      <Collapse in={showInfo} animateOpacity>
        <VStack
          align="stretch"
          spacing={3}
          mt={3}
          p={4}
          bg="whiteAlpha.50"
          borderRadius="md"
          borderWidth="1px"
          borderColor="whiteAlpha.100"
        >
          <Text fontSize="sm" color="gray.200" lineHeight="tall">
            <Text as="span" fontWeight="semibold" color="white">Content Encryption</Text>
            {" "}protects your NFT content using XChaCha20-Poly1305 encryption before it leaves your device.
          </Text>

          <UnorderedList spacing={1} pl={1} styleType="none">
            <ListItem>
              <Text fontSize="sm" color="gray.300">🔐 Content encrypted locally before upload</Text>
            </ListItem>
            <ListItem>
              <Text fontSize="sm" color="gray.300">⛓️ Small files (≤512 KB) can be stored on-chain — self-sovereign but higher tx fee</Text>
            </ListItem>
            <ListItem>
              <Text fontSize="sm" color="gray.300">📦 Larger files stored off-chain (IPFS or backend) with a hash commitment on-chain</Text>
            </ListItem>
            <ListItem>
              <Text fontSize="sm" color="gray.300">🗝️ Access controlled by passphrase or recipient public keys</Text>
            </ListItem>
          </UnorderedList>

          <Alert status="warning" variant="left-accent" borderRadius="md" py={2}>
            <AlertIcon />
            <AlertDescription fontSize="xs" color="yellow.200">
              Keep your passphrase or private keys safe — losing them means permanent loss of access to encrypted content.
            </AlertDescription>
          </Alert>
        </VStack>
      </Collapse>
    </Box>
  );
}
