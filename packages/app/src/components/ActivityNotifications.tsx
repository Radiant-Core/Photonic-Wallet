/**
 * Activity Notifications - Real-time transaction notifications
 */
import { useEffect, useState } from "react";
import { useToast, Box, VStack, HStack, Text, Badge, Link, CloseButton } from "@chakra-ui/react";
import { t } from "@lingui/macro";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import { BroadcastResult } from "@app/types";
import createExplorerUrl from "@app/network/createExplorerUrl";
import { ExternalLinkIcon } from "@chakra-ui/icons";

interface Notification {
  id: string;
  type: string;
  title: string;
  txid: string;
  timestamp: number;
  description?: string;
}

const notificationTitles: Record<string, string> = {
  vault_create: "Vault Created",
  vault_claim: "Vault Claimed",
  vault_vesting: "Vesting Schedule Created",
  rxd_send: "RXD Sent",
  rxd_receive: "RXD Received",
  ft_send: "Tokens Sent",
  ft_mint: "Tokens Minted",
  ft_melt: "Tokens Melted",
  nft_send: "NFT Sent",
  nft_melt: "NFT Melted",
  nft_edit: "NFT Edited",
  swap: "Swap Created",
  swap_cancel: "Swap Cancelled",
  authority_commit: "Authority Committed",
  authority_reveal: "Authority Revealed",
  wave_name_commit: "Name Committed",
  wave_name_reveal: "Name Revealed",
};

const notificationTypes: Record<string, "success" | "info" | "warning" | "error"> = {
  vault_create: "success",
  vault_claim: "success",
  vault_vesting: "info",
  rxd_send: "info",
  rxd_receive: "success",
  ft_send: "info",
  ft_mint: "success",
  ft_melt: "warning",
  nft_send: "info",
  nft_melt: "warning",
  nft_edit: "info",
  swap: "info",
  swap_cancel: "warning",
  authority_commit: "info",
  authority_reveal: "success",
  wave_name_commit: "info",
  wave_name_reveal: "success",
};

export function useActivityNotifications() {
  const toast = useToast();
  const [lastSeen, setLastSeen] = useState<number>(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  // Get latest broadcasts
  const broadcasts = useLiveQuery(
    () => db.broadcast.orderBy("date").reverse().limit(10).toArray(),
    []
  );

  // Load last seen timestamp from localStorage
  useEffect(() => {
    const stored = localStorage.getItem("activity-last-seen");
    if (stored) {
      setLastSeen(parseInt(stored, 10));
    }
  }, []);

  // Check for new broadcasts and show notifications
  useEffect(() => {
    if (!broadcasts) return;

    const newNotifications: Notification[] = [];
    let maxTimestamp = lastSeen;

    for (const broadcast of broadcasts) {
      if (broadcast.date > lastSeen) {
        const type = broadcast.description || "transaction";
        newNotifications.push({
          id: broadcast.txid,
          type,
          title: notificationTitles[type] || t`Transaction`,
          txid: broadcast.txid,
          timestamp: broadcast.date,
          description: broadcast.description,
        });
        maxTimestamp = Math.max(maxTimestamp, broadcast.date);
      }
    }

    // Show toast notifications for new activities
    for (const notification of newNotifications.reverse()) {
      toast({
        title: notification.title,
        description: (
          <HStack spacing={2}>
            <Text fontSize="xs">{t`View transaction`}</Text>
            <Link href={createExplorerUrl(notification.txid)} isExternal color="blue.400">
              <ExternalLinkIcon />
            </Link>
          </HStack>
        ),
        status: notificationTypes[notification.type] || "info",
        duration: 5000,
        isClosable: true,
        position: "top-right",
      });
    }

    // Update notifications list
    setNotifications(newNotifications);

    // Save last seen timestamp
    if (maxTimestamp > lastSeen) {
      setLastSeen(maxTimestamp);
      localStorage.setItem("activity-last-seen", maxTimestamp.toString());
    }
  }, [broadcasts, lastSeen, toast]);

  const markAllSeen = () => {
    const now = Date.now();
    setLastSeen(now);
    localStorage.setItem("activity-last-seen", now.toString());
    setNotifications([]);
  };

  return {
    notifications,
    markAllSeen,
    hasNew: notifications.length > 0,
  };
}

export default function ActivityNotifications() {
  const { notifications, markAllSeen, hasNew } = useActivityNotifications();

  if (!hasNew) return null;

  return (
    <Box
      position="fixed"
      top="20px"
      right="20px"
      bg="gray.800"
      border="1px solid"
      borderColor="gray.600"
      borderRadius="md"
      p={4}
      maxW="350px"
      zIndex={1000}
    >
      <HStack justify="space-between" mb={3}>
        <Text fontWeight="bold">{t`New Activity`}</Text>
        <CloseButton onClick={markAllSeen} size="sm" />
      </HStack>
      <VStack spacing={2} align="stretch">
        {notifications.slice(0, 5).map((notif) => (
          <Box key={notif.id} p={2} bg="whiteAlpha.50" borderRadius="md">
            <HStack justify="space-between">
              <Text fontSize="sm" fontWeight="medium">
                {notif.title}
              </Text>
              <Badge size="sm" colorScheme={notificationTypes[notif.type] || "gray"}>
                {notif.type.replace(/_/g, " ")}
              </Badge>
            </HStack>
            <HStack mt={1} spacing={2}>
              <Link href={createExplorerUrl(notif.txid)} isExternal fontSize="xs" color="blue.400">
                {notif.txid.slice(0, 12)}...
              </Link>
              <Text fontSize="xs" color="whiteAlpha.600">
                {new Date(notif.timestamp).toLocaleTimeString()}
              </Text>
            </HStack>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}
