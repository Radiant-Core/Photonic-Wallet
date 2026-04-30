import { useState } from "react";
import { useLocation } from "react-router-dom";
import {
  Badge,
  Button,
  ButtonGroup,
  Flex,
  Select,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
} from "@chakra-ui/react";
import { ExternalLinkIcon } from "@chakra-ui/icons";
import PageHeader from "@app/components/PageHeader";
import ContentContainer from "@app/components/ContentContainer";
import { ContractType } from "@app/types";
import Photons from "@app/components/Photons";
import { useLiveQuery } from "dexie-react-hooks";
import db from "@app/db";
import Pagination from "@app/components/Pagination";
import useQueryString from "@app/hooks/useQueryString";
import createExplorerUrl from "@app/network/createExplorerUrl";

const pageSize = 20;

type FilterMode = "unspent" | "spent" | "all";
type SortMode = "newest" | "oldest" | "value_desc" | "value_asc";

export default function Coins() {
  const { pathname } = useLocation();
  const { p: pageParam } = useQueryString();
  const page = parseInt(pageParam || "0", 10);
  const [filter, setFilter] = useState<FilterMode>("unspent");
  const [sort, setSort] = useState<SortMode>("newest");

  const txos = useLiveQuery(
    async () => {
      let collection;
      if (filter === "all") {
        collection = db.txo
          .where("contractType")
          .equals(ContractType.RXD);
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

  const totalCount = txos.length;
  const pageRows = txos.slice(page * pageSize, page * pageSize + pageSize);
  const hasNext = totalCount > (page + 1) * pageSize;

  return (
    <ContentContainer>
      <PageHeader
        toolbar={
          <Pagination
            page={page}
            startUrl={pathname}
            prevUrl={`${pathname}${page > 1 ? `?p=${page - 1}` : ""}`}
            nextUrl={hasNext ? `${pathname}?p=${page + 1}` : undefined}
          />
        }
      >
        Coins
      </PageHeader>

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
            variant={filter === "unspent" ? "solid" : "outline"}
            onClick={() => setFilter("unspent")}
          >
            Unspent
          </Button>
          <Button
            variant={filter === "spent" ? "solid" : "outline"}
            onClick={() => setFilter("spent")}
          >
            Spent
          </Button>
          <Button
            variant={filter === "all" ? "solid" : "outline"}
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
          {totalCount} {filter === "all" ? "total" : filter === "unspent" ? "unspent" : "spent"}
        </Badge>
      </Flex>

      <Table size={{ base: "sm", xl: "md" }}>
        <Thead>
          <Tr>
            <Th display={{ base: "none", lg: "table-cell" }} />
            <Th>TX ID</Th>
            <Th>Block</Th>
            <Th>Status</Th>
            <Th textAlign="right">Value</Th>
            <Th width="50px" />
            <Th display={{ base: "none", lg: "table-cell" }} />
          </Tr>
        </Thead>
        <Tbody fontFamily="mono">
          {pageRows.map(({ txid, vout, value, height, spent }) => (
            <Tr key={`${txid}${vout}`} opacity={spent ? 0.5 : 1}>
              <Td display={{ base: "none", lg: "table-cell" }} />
              <Td>
                {txid.substring(0, 4)}…{txid.substring(60, 64)}
              </Td>
              <Td>{height === Infinity ? "…" : height}</Td>
              <Td>
                <Badge colorScheme={spent ? "red" : "green"} fontSize="xs">
                  {spent ? "Spent" : "Unspent"}
                </Badge>
              </Td>
              <Td textAlign="right">
                <Photons value={value} />
              </Td>
              <Td>
                <a href={createExplorerUrl(txid)} target="_blank" aria-label="View on explorer">
                  <ExternalLinkIcon />
                </a>
              </Td>
              <Td display={{ base: "none", lg: "table-cell" }} />
            </Tr>
          ))}
        </Tbody>
      </Table>
    </ContentContainer>
  );
}
