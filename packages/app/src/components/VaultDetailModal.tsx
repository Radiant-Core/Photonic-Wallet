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
  Divider,
  Badge,
  Link,
  Table,
  Tbody,
  Tr,
  Td,
} from "@chakra-ui/react";
import { t } from "@lingui/macro";
import { VaultRecord } from "@app/types";
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
  if (!vault) return null;

  const remaining = vaultTimeRemaining(
    vault.locktime,
    vault.mode,
    currentHeight,
    currentTimestamp
  );
  const isUnlockable = remaining.value === 0;

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
                </Tbody>
              </Table>
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
