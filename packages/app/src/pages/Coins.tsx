import { useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  ButtonGroup,
  Flex,
  Input,
  InputGroup,
  InputLeftElement,
  Select,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Wrap,
  WrapItem,
} from "@chakra-ui/react";
import { ExternalLinkIcon, Search2Icon } from "@chakra-ui/icons";
import { TbInbox, TbReceipt } from "react-icons/tb";
import PageHeader from "@app/components/PageHeader";
import ContentContainer from "@app/components/ContentContainer";
import NoContent from "@app/components/NoContent";
import { ContractType } from "@app/types";
import Photons from "@app/components/Photons";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import createExplorerUrl from "@app/network/createExplorerUrl";
import ActivityFeed, { ActivityRow } from "@app/components/ActivityFeed";
import {
  ACTIVITY_FILTERS,
  ActivityCategory,
  classifyActivity,
} from "@app/activity";

export default function History() {
  return (
    <ContentContainer>
      <PageHeader>History</PageHeader>
      <Tabs colorScheme="brand" isLazy>
        <TabList px={{ base: 2, md: 4 }} mb={2}>
          <Tab>Activity</Tab>
          <Tab>Received</Tab>
          <Tab>Coins</Tab>
        </TabList>
        <TabPanels>
          <TabPanel px={0}>
            <ActivityTab />
          </TabPanel>
          <TabPanel px={0}>
            <ReceivedTab />
          </TabPanel>
          <TabPanel px={0}>
            <CoinsTab />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </ContentContainer>
  );
}

/* -------------------------------------------------------------------------- */
/* Activity tab — the unified send / swap / mint / vault / name feed.         */
/* -------------------------------------------------------------------------- */

function ActivityTab() {
  const [filter, setFilter] = useState<ActivityCategory | "all">("all");
  const [query, setQuery] = useState("");

  const broadcasts = useLiveQuery(
    () => db.broadcast.orderBy("date").reverse().toArray(),
    [],
    undefined
  );

  const items: ActivityRow[] = useMemo(() => {
    if (!broadcasts) return [];
    const normalized = query.trim().toLowerCase();
    return broadcasts
      .map((b) => ({
        id: `${b.txid}-${b.date}`,
        txid: b.txid,
        description: b.description,
        timestamp: b.date,
        amount: b.amount,
      }))
      .filter((item) => {
        const meta = classifyActivity(item.description);
        if (filter !== "all" && meta.category !== filter) return false;
        if (!normalized) return true;
        return (
          item.txid.toLowerCase().includes(normalized) ||
          meta.label.toLowerCase().includes(normalized) ||
          (item.description || "").toLowerCase().includes(normalized)
        );
      });
  }, [broadcasts, filter, query]);

  return (
    <Box>
      <Flex
        direction={{ base: "column", md: "row" }}
        gap={2}
        mb={4}
        mx={{ base: 2, md: 4 }}
        align={{ base: "stretch", md: "center" }}
      >
        <Wrap spacing={2} flexGrow={1}>
          {ACTIVITY_FILTERS.map((f) => (
            <WrapItem key={f.key}>
              <Button
                size="sm"
                borderRadius="full"
                variant={filter === f.key ? "solid" : "outline"}
                colorScheme={filter === f.key ? "brand" : "gray"}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </Button>
            </WrapItem>
          ))}
        </Wrap>
        <InputGroup size="sm" maxW={{ base: "full", md: "240px" }}>
          <InputLeftElement pointerEvents="none">
            <Search2Icon color="text.muted" />
          </InputLeftElement>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search activity"
            borderRadius="md"
          />
        </InputGroup>
      </Flex>

      {!broadcasts ? null : items.length === 0 ? (
        <NoContent icon={TbReceipt} subtitle="Your transactions will appear here.">
          {query || filter !== "all"
            ? "No matching activity"
            : "No activity yet"}
        </NoContent>
      ) : (
        <ActivityFeed items={items} />
      )}
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/* Received tab — incoming RXD coins (derived from the txo set).              */
/* -------------------------------------------------------------------------- */

function ReceivedTab() {
  const received = useLiveQuery(
    async () => {
      const rows = await db.txo
        .where("contractType")
        .equals(ContractType.RXD)
        .toArray();
      // change === 0 means the coin arrived from a tx we did not broadcast.
      return rows
        .filter((r) => r.change !== 1)
        .sort((a, b) => (b.height ?? Infinity) - (a.height ?? Infinity));
    },
    [],
    undefined
  );

  if (!received) return null;

  if (received.length === 0) {
    return (
      <NoContent
        icon={TbInbox}
        subtitle="Coins sent to your wallet will appear here."
      >
        No received coins yet
      </NoContent>
    );
  }

  return (
    <Box
      mx={{ base: 2, md: 4 }}
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="xl"
      overflow="hidden"
    >
      <Table size={{ base: "sm", xl: "md" }}>
        <Thead bg="surface.sunken">
          <Tr>
            <Th textStyle="label">Transaction</Th>
            <Th textStyle="label">Block</Th>
            <Th textStyle="label">Status</Th>
            <Th textStyle="label" textAlign="right">
              Amount
            </Th>
            <Th width="50px" />
          </Tr>
        </Thead>
        <Tbody>
          {received.map(({ txid, vout, value, height, spent }) => {
            const pending = height === Infinity || height === undefined;
            return (
              <Tr
                key={`${txid}${vout}`}
                borderTopWidth="1px"
                borderColor="border.subtle"
                _hover={{ bg: "bg.50" }}
              >
                <Td fontFamily="mono" fontSize="xs">
                  {txid.substring(0, 8)}…{txid.substring(56, 64)}
                </Td>
                <Td sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {pending ? "—" : height}
                </Td>
                <Td>
                  <Badge
                    colorScheme={pending ? "yellow" : spent ? "gray" : "green"}
                    fontSize="xs"
                  >
                    {pending ? "Pending" : spent ? "Spent" : "Received"}
                  </Badge>
                </Td>
                <Td
                  textAlign="right"
                  color="green.300"
                  fontWeight="600"
                  sx={{ fontVariantNumeric: "tabular-nums" }}
                >
                  +<Photons value={value} />
                </Td>
                <Td>
                  <a
                    href={createExplorerUrl(txid)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="View on explorer"
                  >
                    <ExternalLinkIcon />
                  </a>
                </Td>
              </Tr>
            );
          })}
        </Tbody>
      </Table>
    </Box>
  );
}

/* -------------------------------------------------------------------------- */
/* Coins tab — raw RXD UTXO set (for power users).                            */
/* -------------------------------------------------------------------------- */

type FilterMode = "unspent" | "spent" | "all";
type SortMode = "newest" | "oldest" | "value_desc" | "value_asc";

function CoinsTab() {
  const [filter, setFilter] = useState<FilterMode>("unspent");
  const [sort, setSort] = useState<SortMode>("newest");

  const txos = useLiveQuery(
    async () => {
      let collection;
      if (filter === "all") {
        collection = db.txo.where("contractType").equals(ContractType.RXD);
      } else {
        collection = db.txo
          .where("[contractType+spent]")
          .equals([ContractType.RXD, filter === "unspent" ? 0 : 1]);
      }

      const rows = await collection.toArray();

      rows.sort((a, b) => {
        switch (sort) {
          case "oldest":
            return (a.height ?? 0) - (b.height ?? 0);
          case "value_desc":
            return b.value - a.value;
          case "value_asc":
            return a.value - b.value;
          case "newest":
          default:
            return (b.height ?? 0) - (a.height ?? 0);
        }
      });

      return rows;
    },
    [filter, sort],
    []
  );

  return (
    <Box>
      <Flex
        columnGap={2}
        rowGap={2}
        mb={2}
        mx={{ base: 2, md: 4 }}
        wrap="wrap"
        alignItems="center"
      >
        <ButtonGroup size="sm" isAttached variant="outline">
          <Button
            variant={filter === "unspent" ? "subtle" : "ghost"}
            onClick={() => setFilter("unspent")}
          >
            Unspent
          </Button>
          <Button
            variant={filter === "spent" ? "subtle" : "ghost"}
            onClick={() => setFilter("spent")}
          >
            Spent
          </Button>
          <Button
            variant={filter === "all" ? "subtle" : "ghost"}
            onClick={() => setFilter("all")}
          >
            All
          </Button>
        </ButtonGroup>

        <Select
          size="sm"
          maxW="180px"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          aria-label="Sort coins"
          title="Sort coins"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="value_desc">Value high-low</option>
          <option value="value_asc">Value low-high</option>
        </Select>

        <Badge colorScheme="gray" fontSize="xs">
          {txos.length}{" "}
          {filter === "all"
            ? "total"
            : filter === "unspent"
            ? "unspent"
            : "spent"}
        </Badge>
      </Flex>

      {txos.length === 0 ? (
        <NoContent icon={TbReceipt} subtitle="RXD coins will appear here.">
          No coins
        </NoContent>
      ) : (
        <Box
          mx={{ base: 2, md: 4 }}
          borderWidth="1px"
          borderColor="border.subtle"
          borderRadius="xl"
          overflow="hidden"
        >
          <Table size={{ base: "sm", xl: "md" }}>
            <Thead bg="surface.sunken">
              <Tr>
                <Th textStyle="label">TX ID</Th>
                <Th textStyle="label">Block</Th>
                <Th textStyle="label">Status</Th>
                <Th textStyle="label" textAlign="right">
                  Value
                </Th>
                <Th width="50px" />
              </Tr>
            </Thead>
            <Tbody fontFamily="mono">
              {txos.map(({ txid, vout, value, height, spent }) => (
                <Tr
                  key={`${txid}${vout}`}
                  opacity={spent ? 0.5 : 1}
                  borderTopWidth="1px"
                  borderColor="border.subtle"
                  _hover={{ bg: "bg.50" }}
                >
                  <Td>
                    {txid.substring(0, 4)}…{txid.substring(60, 64)}
                  </Td>
                  <Td sx={{ fontVariantNumeric: "tabular-nums" }}>
                    {height === Infinity ? "…" : height}
                  </Td>
                  <Td>
                    <Badge
                      colorScheme={spent ? "red" : "green"}
                      fontSize="xs"
                    >
                      {spent ? "Spent" : "Unspent"}
                    </Badge>
                  </Td>
                  <Td
                    textAlign="right"
                    sx={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    <Photons value={value} />
                  </Td>
                  <Td>
                    <a
                      href={createExplorerUrl(txid)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="View on explorer"
                    >
                      <ExternalLinkIcon />
                    </a>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      )}
    </Box>
  );
}
