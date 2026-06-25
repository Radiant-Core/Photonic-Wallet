/**
 * Activity toasts — real-time, transient notifications for transactions that
 * arrive while the app is open. The persistent notification center (bell +
 * unread count) lives in `components/NotificationBell.tsx`; both share the
 * classification in `@app/activity` so titles / icons / colors match the
 * History page.
 *
 * This component renders nothing — it only fires toasts as a side effect.
 */
import { useEffect, useRef } from "react";
import {
  useToast,
  Box,
  Flex,
  Text,
  Icon,
  Link,
  CloseButton,
} from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import createExplorerUrl from "@app/network/createExplorerUrl";
import { ExternalLinkIcon } from "@chakra-ui/icons";
import { classifyActivity, shortTxid } from "@app/activity";

// Map an activity direction to a Chakra toast status.
const toastStatus = (
  direction: "in" | "out" | "neutral"
): "success" | "info" | "warning" => {
  if (direction === "in") return "success";
  if (direction === "out") return "warning";
  return "info";
};

export default function ActivityNotifications() {
  const toast = useToast();
  // App-open time: only activity broadcast AFTER this fires a toast, so a
  // returning user (or a freshly-synced backlog of receives) isn't hit with a
  // toast storm for everything they missed — the bell surfaces those instead.
  const mountTime = useRef<number>(Date.now());
  // Txids already toasted this session, so a live-query refresh never re-toasts.
  const toasted = useRef<Set<string>>(new Set());

  const broadcasts = useLiveQuery(
    () => db.broadcast.orderBy("date").reverse().limit(10).toArray(),
    []
  );

  useEffect(() => {
    if (!broadcasts) return;

    // Replay oldest-first so a burst toasts in chronological order.
    for (const broadcast of broadcasts.slice().reverse()) {
      if (broadcast.date <= mountTime.current) continue;
      if (toasted.current.has(broadcast.txid)) continue;
      toasted.current.add(broadcast.txid);

      const meta = classifyActivity(broadcast.description);
      toast({
        duration: 6000,
        isClosable: true,
        position: "top-right",
        status: toastStatus(meta.direction),
        render: ({ onClose }) => (
          <Flex
            align="center"
            gap={3}
            bg="surface.raised"
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="lg"
            boxShadow="lg"
            p={3}
            maxW="360px"
          >
            <Flex
              align="center"
              justify="center"
              boxSize="36px"
              flexShrink={0}
              borderRadius="full"
              bg={`${meta.color}.900`}
              color={`${meta.color}.300`}
            >
              <Icon as={meta.icon} boxSize={5} />
            </Flex>
            <Box flexGrow={1} minW={0}>
              <Text fontWeight="600" fontSize="sm">
                {meta.label}
              </Text>
              <Link
                href={createExplorerUrl(broadcast.txid)}
                isExternal
                fontSize="xs"
                color="accent.secondary"
                fontFamily="mono"
              >
                {shortTxid(broadcast.txid)} <ExternalLinkIcon mb="2px" />
              </Link>
            </Box>
            <CloseButton size="sm" onClick={onClose} />
          </Flex>
        ),
      });
    }
  }, [broadcasts, toast]);

  return null;
}
