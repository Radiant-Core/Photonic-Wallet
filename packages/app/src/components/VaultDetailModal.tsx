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
  Icon,
  IconButton,
  Link,
  Tooltip,
  useClipboard,
} from "@chakra-ui/react";
import { CopyIcon } from "@chakra-ui/icons";
import { TbLock, TbLockOpen } from "react-icons/tb";
import { t } from "@lingui/macro";
import { VaultRecord } from "@app/types";
import { wallet } from "@app/signals";
import { serializeRecoveryInfo } from "@app/vaultRecovery";
import createExplorerUrl from "@app/network/createExplorerUrl";
import DataRow from "./DataRow";
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
      <ModalContent shadow="xl">
        <ModalHeader>
          <HStack>
            <Text>{t`Vault Details`}</Text>
            <Badge
              colorScheme={
                vault.claimed ? "gray" : isUnlockable ? "green" : "orange"
              }
              display="inline-flex"
              alignItems="center"
              gap={1}
            >
              {!vault.claimed && (
                <Icon as={isUnlockable ? TbLockOpen : TbLock} boxSize={3} />
              )}
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
              <DataRow label={t`Asset Type`}>
                <Text textTransform="uppercase">{vault.assetType}</Text>
              </DataRow>
              <DataRow label={t`Amount`}>
                <Box sx={{ fontVariantNumeric: "tabular-nums" }}>
                  <Photons value={vault.value} />
                </Box>
              </DataRow>
              <DataRow label={t`Unlock At`}>
                <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {formatLocktime(vault.locktime, vault.mode)}
                </Text>
              </DataRow>
              <DataRow label={t`Remaining`}>
                <Text sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {vault.claimed
                    ? t`Claimed`
                    : remaining.unit === "blocks"
                    ? `${remaining.value.toLocaleString()} blocks`
                    : t`Ready`}
                </Text>
              </DataRow>
              <DataRow label={t`Recipient`}>
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
              </DataRow>
              <DataRow label={t`Sender`}>
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
              </DataRow>
            </Box>
            <Divider />
            {/* Recovery section — what you need to restore this vault */}
            <Box>
              <Text fontWeight="bold" mb={2}>{t`Recovery`}</Text>
              <Text fontSize="xs" color="text.muted" mb={3}>
                {t`Save this transaction ID. Vaults are not part of your recovery phrase — the TXID (or the redeem script below) is what restores access after a wallet rebuild.`}
              </Text>
              <HStack
                bg="surface.sunken"
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
                  bg="surface.sunken"
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
                  color="accent.secondary"
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
