import { useState } from "react";
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalFooter,
  ModalBody,
  ModalCloseButton,
  Button,
  VStack,
  HStack,
  Text,
  Box,
  Code,
  Collapse,
  Divider,
  Badge,
  IconButton,
  Link,
  Table,
  Tbody,
  Tooltip,
  Tr,
  Td,
  useClipboard,
} from "@chakra-ui/react";
import { CopyIcon } from "@chakra-ui/icons";
import { t } from "@lingui/macro";
import { VaultRecord } from "@app/types";
import { wallet } from "@app/signals";
import { serializeRecoveryInfo } from "@app/vaultRecovery";
import createExplorerUrl from "@app/network/createExplorerUrl";
import Photons from "./Photons";
import { formatLocktime, vaultTimeRemaining } from "@lib/vault";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  vault: VaultRecord | null;
  currentHeight: number;
  currentTimestamp: number;
}

export default function VaultDetailModal({
  isOpen,
  onClose,
  vault,
  currentHeight,
  currentTimestamp,
}: Props) {
  const [showScript, setShowScript] = useState(false);

  // Hooks must run unconditionally — compute clipboard sources from the
  // (possibly null) vault and bail on render below.
  const { onCopy: copyTxid, hasCopied: copiedTxid } = useClipboard(
    vault?.txid ?? ""
  );
  const { onCopy: copyScript, hasCopied: copiedScript } = useClipboard(
    vault?.redeemScriptHex ?? ""
  );
  const recoveryJson = vault ? serializeRecoveryInfo([vault]) : "";
  const { onCopy: copyRecovery, hasCopied: copiedRecovery } =
    useClipboard(recoveryJson);

  if (!vault) return null;

  const remaining = vaultTimeRemaining(
    vault.locktime,
    vault.mode,
    currentHeight,
    currentTimestamp
  );
  const isUnlockable = remaining.value === 0;

  const ownAddresses = [
    wallet.value.address,
    wallet.value.swapAddress,
  ].filter(Boolean);
  const recipientIsYou = ownAddresses.includes(vault.recipientAddress);
  const senderIsYou =
    !!vault.senderAddress && ownAddresses.includes(vault.senderAddress);
  // Provenance: locked to us but funded by someone else (or unknown) = a gift
  // we received; locked to someone else but funded by us = a gift we sent.
  const isReceived = recipientIsYou && !senderIsYou;
  const isSent = !recipientIsYou && senderIsYou;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>
          <HStack>
            <Text>{t`Vault Details`}</Text>
            <Badge
              colorScheme={
                vault.claimed ? "gray" : isUnlockable ? "green" : "orange"
              }
            >
              {vault.claimed
                ? t`Claimed`
                : isUnlockable
                ? t`Unlockable`
                : t`Locked`}
            </Badge>
            {isReceived && (
              <Badge colorScheme="purple">{t`Received`}</Badge>
            )}
            {isSent && <Badge colorScheme="blue">{t`Sent`}</Badge>}
          </HStack>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody>
          <VStack align="stretch" spacing={4}>
            <Box>
              <Text fontWeight="bold" mb={2}>{t`Vault Information`}</Text>
              <Table size="sm" variant="simple">
                <Tbody>
                  <Tr>
                    <Td fontWeight="medium">{t`Asset Type`}</Td>
                    <Td textTransform="uppercase">{vault.assetType}</Td>
                  </Tr>
                  <Tr>
                    <Td fontWeight="medium">{t`Amount`}</Td>
                    <Td>
                      <Photons value={vault.value} />
                    </Td>
                  </Tr>
                  <Tr>
                    <Td fontWeight="medium">{t`Unlock At`}</Td>
                    <Td>{formatLocktime(vault.locktime, vault.mode)}</Td>
                  </Tr>
                  <Tr>
                    <Td fontWeight="medium">{t`Remaining`}</Td>
                    <Td>
                      {vault.claimed
                        ? t`Claimed`
                        : remaining.unit === "blocks"
                        ? `${remaining.value.toLocaleString()} blocks`
                        : t`Ready`}
                    </Td>
                  </Tr>
                  <Tr>
                    <Td fontWeight="medium">{t`Recipient`}</Td>
                    <Td>
                      <Text
                        as="span"
                        fontFamily="mono"
                        fontSize="xs"
                        wordBreak="break-all"
                      >
                        {vault.recipientAddress || t`(unknown)`}
                      </Text>
                      {recipientIsYou && (
                        <Badge ml={2} colorScheme="green" fontSize="2xs">
                          {t`You`}
                        </Badge>
                      )}
                    </Td>
                  </Tr>
                  <Tr>
                    <Td fontWeight="medium">{t`Sender`}</Td>
                    <Td>
                      <Text
                        as="span"
                        fontFamily="mono"
                        fontSize="xs"
                        wordBreak="break-all"
                      >
                        {vault.senderAddress || t`(unknown)`}
                      </Text>
                      {senderIsYou && (
                        <Badge ml={2} colorScheme="green" fontSize="2xs">
                          {t`You`}
                        </Badge>
                      )}
                    </Td>
                  </Tr>
                </Tbody>
              </Table>
            </Box>
            <Divider />
            {/* Recovery section — what you need to restore this vault */}
            <Box>
              <Text fontWeight="bold" mb={2}>{t`Recovery`}</Text>
              <Text fontSize="xs" color="whiteAlpha.600" mb={3}>
                {t`Save this transaction ID. Vaults are not part of your recovery phrase — the TXID (or the redeem script below) is what restores access after a wallet rebuild.`}
              </Text>
              <HStack
                bg="blackAlpha.300"
                borderRadius="md"
                px={2}
                py={1}
                mb={2}
              >
                <Text fontWeight="medium" fontSize="xs" w="90px">
                  {t`TXID`}
                </Text>
                <Code
                  bg="transparent"
                  fontSize="xs"
                  wordBreak="break-all"
                  flex={1}
                >
                  {vault.txid}
                </Code>
                <Tooltip
                  label={copiedTxid ? t`Copied!` : t`Copy TXID`}
                  placement="top"
                >
                  <IconButton
                    aria-label={t`Copy TXID`}
                    icon={<CopyIcon />}
                    size="xs"
                    variant="ghost"
                    onClick={copyTxid}
                  />
                </Tooltip>
              </HStack>
              <HStack>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setShowScript((s) => !s)}
                >
                  {showScript ? t`Hide redeem script` : t`Show redeem script`}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  leftIcon={<CopyIcon />}
                  onClick={copyRecovery}
                >
                  {copiedRecovery ? t`Copied!` : t`Copy recovery info`}
                </Button>
              </HStack>
              <Collapse in={showScript} animateOpacity>
                <HStack
                  bg="blackAlpha.300"
                  borderRadius="md"
                  px={2}
                  py={1}
                  mt={2}
                  align="start"
                >
                  <Code
                    bg="transparent"
                    fontSize="2xs"
                    wordBreak="break-all"
                    flex={1}
                  >
                    {vault.redeemScriptHex}
                  </Code>
                  <Tooltip
                    label={copiedScript ? t`Copied!` : t`Copy`}
                    placement="top"
                  >
                    <IconButton
                      aria-label={t`Copy redeem script`}
                      icon={<CopyIcon />}
                      size="xs"
                      variant="ghost"
                      onClick={copyScript}
                    />
                  </Tooltip>
                </HStack>
              </Collapse>
            </Box>
            <Divider />
            <Box>
              <Text fontWeight="bold" mb={2}>{t`Transactions`}</Text>
              <HStack>
                <Text fontWeight="medium" w="100px">{t`Created`}</Text>
                <Link
                  href={createExplorerUrl(vault.txid)}
                  isExternal
                  fontFamily="mono"
                  fontSize="xs"
                  color="blue.400"
                >
                  {vault.txid.slice(0, 16)}...
                </Link>
              </HStack>
              {vault.claimed && vault.claimTxid && (
                <HStack mt={2}>
                  <Text fontWeight="medium" w="100px">{t`Claimed`}</Text>
                  <Link
                    href={createExplorerUrl(vault.claimTxid)}
                    isExternal
                    fontFamily="mono"
                    fontSize="xs"
                    color="green.400"
                  >
                    {vault.claimTxid.slice(0, 16)}...
                  </Link>
                </HStack>
              )}
            </Box>
            {vault.activityLog && vault.activityLog.length > 0 && (
              <>
                <Divider />
                <Box>
                  <Text fontWeight="bold" mb={2}>{t`Activity Log`}</Text>
                  <VStack align="stretch" spacing={2}>
                    {vault.activityLog.map((a, i) => (
                      <HStack key={i} spacing={2}>
                        <Badge size="sm">{a.action}</Badge>
                        <Text fontSize="xs">
                          {new Date(a.timestamp).toLocaleString()}
                        </Text>
                        <Link
                          href={createExplorerUrl(a.txid)}
                          isExternal
                          fontSize="xs"
                        >
                          {a.txid.slice(0, 8)}...
                        </Link>
                      </HStack>
                    ))}
                  </VStack>
                </Box>
              </>
            )}
          </VStack>
        </ModalBody>
        <ModalFooter>
          <Button onClick={onClose}>{t`Close`}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
