/**
 * Notification bell — a persistent entry point to recent wallet activity.
 *
 * Shows a live unread badge (activity newer than the last time the center was
 * opened, tracked in `@app/notifications`) and a popover listing the most
 * recent sends / receives / swaps / mints, classified with the shared
 * `@app/activity` model so labels and icons match the History page. Opening the
 * popover marks everything seen.
 */
import {
  Box,
  Button,
  Flex,
  Icon,
  IconButton,
  Link,
  Popover,
  PopoverArrow,
  PopoverBody,
  PopoverContent,
  PopoverFooter,
  PopoverHeader,
  PopoverTrigger,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ExternalLinkIcon } from "@chakra-ui/icons";
import { TbBell, TbBellOff } from "react-icons/tb";
import { Link as RouterLink } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import createExplorerUrl from "@app/network/createExplorerUrl";
import { classifyActivity, relativeTime, shortTxid } from "@app/activity";
import { lastSeen, markAllSeen } from "@app/notifications";

const MAX_ITEMS = 8;

export default function NotificationBell() {
  const broadcasts = useLiveQuery(
    () => db.broadcast.orderBy("date").reverse().limit(MAX_ITEMS).toArray(),
    [],
    []
  );

  // Re-read the signal so the badge updates the moment the center is opened.
  const seen = lastSeen.value;
  const unread = broadcasts.filter((b) => (b.date ?? 0) > seen).length;
  const badge = unread > 9 ? "9+" : `${unread}`;

  return (
    <Popover
      placement="bottom-end"
      isLazy
      onOpen={() => markAllSeen()}
      gutter={8}
    >
      <PopoverTrigger>
        <Box position="relative" display="inline-flex">
          <IconButton
            aria-label="Notifications"
            icon={<Icon as={TbBell} boxSize={5} />}
            variant="ghost"
            size="md"
            borderRadius="full"
          />
          {unread > 0 && (
            <Box
              position="absolute"
              top="2px"
              right="2px"
              minW="18px"
              h="18px"
              px="4px"
              borderRadius="full"
              bg="red.500"
              color="white"
              fontSize="10px"
              fontWeight="700"
              lineHeight="14px"
              textAlign="center"
              pointerEvents="none"
              border="2px solid"
              borderColor="bg.300"
            >
              {badge}
            </Box>
          )}
        </Box>
      </PopoverTrigger>
      <PopoverContent
        bg="surface.raised"
        borderColor="border.subtle"
        boxShadow="xl"
        _focus={{ outline: "none" }}
        w={{ base: "calc(100vw - 32px)", sm: "360px" }}
      >
        <PopoverArrow bg="surface.raised" />
        <PopoverHeader borderColor="border.subtle" fontWeight="700">
          Notifications
        </PopoverHeader>
        <PopoverBody p={0} maxH="380px" overflowY="auto">
          {broadcasts.length === 0 ? (
            <VStack spacing={2} py={8} color="text.muted">
              <Icon as={TbBellOff} boxSize={6} />
              <Text fontSize="sm">No activity yet</Text>
            </VStack>
          ) : (
            broadcasts.map((b) => {
              const meta = classifyActivity(b.description);
              return (
                <Flex
                  key={b.txid}
                  align="center"
                  gap={3}
                  px={3}
                  py={2.5}
                  borderTopWidth="1px"
                  borderColor="border.subtle"
                  _first={{ borderTopWidth: 0 }}
                  _hover={{ bg: "bg.50" }}
                >
                  <Flex
                    align="center"
                    justify="center"
                    boxSize="34px"
                    flexShrink={0}
                    borderRadius="full"
                    bg={`${meta.color}.900`}
                    color={`${meta.color}.300`}
                  >
                    <Icon as={meta.icon} boxSize={4} />
                  </Flex>
                  <Box flexGrow={1} minW={0}>
                    <Text fontSize="sm" fontWeight="600" noOfLines={1}>
                      {meta.label}
                    </Text>
                    <Text fontSize="xs" color="text.muted" fontFamily="mono">
                      {shortTxid(b.txid)} · {relativeTime(b.date)}
                    </Text>
                  </Box>
                  <Link
                    href={createExplorerUrl(b.txid)}
                    isExternal
                    color="text.muted"
                    aria-label="View on explorer"
                  >
                    <ExternalLinkIcon />
                  </Link>
                </Flex>
              );
            })
          )}
        </PopoverBody>
        <PopoverFooter borderColor="border.subtle" p={2}>
          <Button
            as={RouterLink}
            to="/coins"
            variant="ghost"
            size="sm"
            width="100%"
          >
            View all activity
          </Button>
        </PopoverFooter>
      </PopoverContent>
    </Popover>
  );
}
