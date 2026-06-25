import { Fragment, useMemo } from "react";
import {
  Box,
  Flex,
  HStack,
  Icon,
  IconButton,
  Text,
  Tooltip,
  VStack,
} from "@chakra-ui/react";
import { ExternalLinkIcon } from "@chakra-ui/icons";
import {
  classifyActivity,
  dateGroup,
  relativeTime,
  shortTxid,
} from "@app/activity";
import createExplorerUrl from "@app/network/createExplorerUrl";

export interface ActivityRow {
  id: string;
  txid: string;
  description?: string;
  timestamp: number;
}

function Row({ item }: { item: ActivityRow }) {
  const meta = classifyActivity(item.description);
  return (
    <Flex
      align="center"
      gap={3}
      px={{ base: 3, md: 4 }}
      py={3}
      borderRadius="lg"
      transition="background 0.15s ease"
      _hover={{ bg: "bg.50" }}
    >
      <Flex
        align="center"
        justify="center"
        boxSize="40px"
        flexShrink={0}
        borderRadius="full"
        bg={`${meta.color}.900`}
        color={`${meta.color}.300`}
      >
        <Icon as={meta.icon} boxSize={5} />
      </Flex>

      <Box flexGrow={1} minW={0}>
        <Text fontWeight="600" noOfLines={1}>
          {meta.label}
        </Text>
        <HStack spacing={2} color="text.muted" fontSize="xs">
          <Text
            as="span"
            fontFamily="mono"
            display={{ base: "none", sm: "inline" }}
          >
            {shortTxid(item.txid)}
          </Text>
          <Text as="span" display={{ base: "none", sm: "inline" }}>
            ·
          </Text>
          <Tooltip
            label={new Date(item.timestamp).toLocaleString()}
            placement="top"
            openDelay={300}
          >
            <Text as="span" whiteSpace="nowrap">
              {relativeTime(item.timestamp)}
            </Text>
          </Tooltip>
        </HStack>
      </Box>

      <Tooltip label="View on explorer" placement="top">
        <IconButton
          as="a"
          href={createExplorerUrl(item.txid)}
          target="_blank"
          rel="noreferrer"
          aria-label="View on explorer"
          icon={<ExternalLinkIcon />}
          size="sm"
          variant="ghost"
          color="text.muted"
        />
      </Tooltip>
    </Flex>
  );
}

export default function ActivityFeed({ items }: { items: ActivityRow[] }) {
  // Group consecutive items (already sorted newest-first) under date headers.
  const groups = useMemo(() => {
    const out: { label: string; rows: ActivityRow[] }[] = [];
    for (const item of items) {
      const label = dateGroup(item.timestamp);
      const last = out[out.length - 1];
      if (last && last.label === label) {
        last.rows.push(item);
      } else {
        out.push({ label, rows: [item] });
      }
    }
    return out;
  }, [items]);

  return (
    <VStack align="stretch" spacing={4}>
      {groups.map((group) => (
        <Box key={group.label}>
          <Text
            textStyle="label"
            color="text.muted"
            px={{ base: 3, md: 4 }}
            mb={1}
          >
            {group.label}
          </Text>
          <Box
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="xl"
            overflow="hidden"
            bg="surface.raised"
          >
            {group.rows.map((item, i) => (
              <Fragment key={item.id}>
                {i > 0 && (
                  <Box
                    borderTopWidth="1px"
                    borderColor="border.subtle"
                    mx={{ base: 3, md: 4 }}
                  />
                )}
                <Row item={item} />
              </Fragment>
            ))}
          </Box>
        </Box>
      ))}
    </VStack>
  );
}
