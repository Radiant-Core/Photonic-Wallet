import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  ButtonGroup,
  Flex,
  Heading,
  IconButton,
  Input,
  InputGroup,
  InputLeftElement,
  LinkBox,
  LinkOverlay,
  Select,
  SimpleGrid,
  Spinner,
  Text,
  useToast,
} from "@chakra-ui/react";
import { DeleteIcon, RepeatIcon, SearchIcon } from "@chakra-ui/icons";
import { useLiveQuery } from "dexie-react-hooks";
import {
  currentHeight,
  discoverMarkets,
  fetchMarketStatus,
  indexedOrderbook,
  listTracked,
  marketKind,
  openMarketByCreateTxid,
  openMarketByRef,
  trackMarket,
  untrackMarket,
  type MarketStatusInfo,
  type TrackedMarket,
} from "@app/predict/predict";
import { deriveMarketOdds } from "@app/predict/odds";
import { HeroCard, NeonSplitBar, NEON } from "@app/predict/ui";
import { OracleTrustBadge } from "@app/predict/trust";
import { blockEta } from "@app/predict/time";
import Photons from "@app/components/Photons";

/** A market shown on the list: the market plus whether it's in the local watchlist (controls the
 *  untrack button) and whether the indexer discovered it. */
interface ListEntry {
  m: TrackedMarket;
  tracked: boolean;
  discovered: boolean;
}

type StatusFilter = "all" | "open" | "proposed" | "resolved";
type SortMode = "newest" | "closing";

/** Chakra colorScheme for a live status badge. */
function statusScheme(info: MarketStatusInfo): string {
  if (info.pending) return "purple"; // optimistic challenge window
  if (!info.resolved) return "blue"; // Open
  if (/no\b/i.test(info.label)) return "pink"; // Resolved NO
  if (/revert/i.test(info.label)) return "orange";
  return "green"; // Resolved YES / resolved to an outcome
}

export default function Predict() {
  const toast = useToast();
  const [txid, setTxid] = useState("");
  const [importing, setImporting] = useState(false);

  // Locally tracked markets (watchlist + the only source for categorical/scalar, which carry no
  // beacon) and indexer-discovered binary markets (newest-first). Merged + deduped for display.
  const local = useLiveQuery(listTracked, [], []);
  const [discovered, setDiscovered] = useState<TrackedMarket[]>([]);
  const [discovering, setDiscovering] = useState(true);

  // Discovery controls: free-text search over the question, a status filter, and a sort order.
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortMode>("newest");
  // Chain tip, fetched once per refresh, to humanise "closes in ≈X" on each card.
  const [height, setHeight] = useState<number | null>(null);

  const loadDiscovered = useCallback(async () => {
    setDiscovering(true);
    try {
      const [markets, h] = await Promise.all([
        discoverMarkets(100),
        currentHeight(),
      ]);
      setDiscovered(markets);
      setHeight(h);
    } finally {
      setDiscovering(false);
    }
  }, []);
  useEffect(() => {
    loadDiscovered();
  }, [loadDiscovered]);

  const entries: ListEntry[] = useMemo(() => {
    const localByTxid = new Map(local.map((m) => [m.createTxid, m] as const));
    const seen = new Set<string>();
    const out: ListEntry[] = [];
    for (const m of discovered) {
      if (seen.has(m.createTxid)) continue;
      seen.add(m.createTxid);
      out.push({ m, tracked: localByTxid.has(m.createTxid), discovered: true });
    }
    for (const m of local) {
      if (seen.has(m.createTxid)) continue;
      seen.add(m.createTxid);
      out.push({ m, tracked: true, discovered: false });
    }
    return out;
  }, [discovered, local]);

  const txKey = entries.map((e) => e.m.createTxid).join(",");

  // Per-market YES probability for the mini odds bar (binary markets only). Fetched best-effort
  // from the indexer's swap book; null = fetched but no live price, undefined = not fetched yet.
  const [oddsMap, setOddsMap] = useState<Record<string, number | null>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const binaries = entries
        .filter((e) => marketKind(e.m) === "binary")
        .map((e) => e.m);
      const results = await Promise.all(
        binaries.map(async (m) => {
          try {
            const book = await indexedOrderbook(m);
            return [
              m.createTxid,
              book.available ? deriveMarketOdds(book.asks).yesProb : null,
            ] as const;
          } catch {
            return [m.createTxid, null] as const;
          }
        })
      );
      if (!cancelled)
        setOddsMap((prev) => ({ ...prev, ...Object.fromEntries(results) }));
    })();
    return () => {
      cancelled = true;
    };
  }, [txKey]);

  // Per-market live status, probed best-effort from chain so the list can split Active vs Resolved
  // (and badge each card). A market with no probe result yet stays Active so it never disappears.
  const [statusMap, setStatusMap] = useState<
    Record<string, MarketStatusInfo | null>
  >({});
  const probeStatuses = useCallback(async () => {
    const list = entries.map((e) => e.m);
    const results = await Promise.all(
      list.map(async (m) => [m.createTxid, await fetchMarketStatus(m)] as const)
    );
    setStatusMap((prev) => ({ ...prev, ...Object.fromEntries(results) }));
  }, [txKey]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = entries.map((e) => e.m);
      const results = await Promise.all(
        list.map(
          async (m) => [m.createTxid, await fetchMarketStatus(m)] as const
        )
      );
      if (!cancelled)
        setStatusMap((prev) => ({ ...prev, ...Object.fromEntries(results) }));
    })();
    return () => {
      cancelled = true;
    };
  }, [txKey]);

  // Apply search + status filter + sort. A market with no status probe yet (null) is treated as
  // "open/unknown" so it shows under All and Open and never silently vanishes.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchStatus = (e: ListEntry): boolean => {
      const s = statusMap[e.m.createTxid];
      switch (statusFilter) {
        case "open":
          return !s || (!s.resolved && !s.pending);
        case "proposed":
          return !!s?.pending;
        case "resolved":
          return !!s?.resolved;
        default:
          return true;
      }
    };
    const list = entries.filter(
      (e) => (!q || e.m.question.toLowerCase().includes(q)) && matchStatus(e)
    );
    if (sort === "closing") return [...list].sort((a, b) => a.m.expiry - b.m.expiry);
    return list; // "newest": preserve discovery order (newest-first)
  }, [entries, statusMap, query, statusFilter, sort]);

  const { active, resolved } = useMemo(() => {
    const a: ListEntry[] = [];
    const r: ListEntry[] = [];
    for (const e of shown) {
      (statusMap[e.m.createTxid]?.resolved ? r : a).push(e);
    }
    return { active: a, resolved: r };
  }, [shown, statusMap]);

  const importMarket = async () => {
    const q = txid.trim();
    const isTxid = /^[0-9a-fA-F]{64}$/.test(q);
    const isRef = q.includes("_") || /^[0-9a-fA-F]{72}$/.test(q);
    if (!isTxid && !isRef) {
      toast({
        title: "Enter a creation txid or a market ref",
        description: "64-char txid, or a ref as txid_vout",
        status: "warning",
      });
      return;
    }
    setImporting(true);
    try {
      const t = isTxid
        ? await openMarketByCreateTxid(q)
        : await openMarketByRef(q);
      await trackMarket(t);
      setTxid("");
      toast({ title: "Market imported", status: "success" });
      probeStatuses();
    } catch (e) {
      toast({
        title: "Import failed",
        description: (e as Error).message,
        status: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  const renderCard = ({ m, tracked }: ListEntry) => {
    const kind = marketKind(m);
    const to =
      kind === "binary"
        ? `/predict/m/${m.createTxid}`
        : `/predict/cat/${m.createTxid}`;
    const yesProb = kind === "binary" ? oddsMap[m.createTxid] : undefined;
    const yesPctRounded = yesProb != null ? Math.round(yesProb * 100) : null;
    const status = statusMap[m.createTxid];
    return (
      <LinkBox key={m.createTxid}>
        <HeroCard
          px={5}
          py={4}
          borderRadius="xl"
          cursor="pointer"
          opacity={status?.resolved ? 0.85 : 1}
          transition="transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease"
          _hover={{
            borderColor: "rgba(74, 222, 168, 0.5)",
            transform: "translateY(-2px)",
            boxShadow:
              "inset 0 0 0 1px rgba(74, 222, 168, 0.08), 0 0 40px rgba(36, 200, 148, 0.12), 0 18px 40px rgba(0, 0, 0, 0.55)",
          }}
        >
          {tracked && (
            <IconButton
              aria-label="Untrack market"
              size="xs"
              variant="ghost"
              icon={<DeleteIcon />}
              position="absolute"
              top={2}
              right={2}
              zIndex={2}
              color="whiteAlpha.500"
              _hover={{ color: "red.300", bg: "whiteAlpha.100" }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                untrackMarket(m.createTxid);
              }}
            />
          )}
          <LinkOverlay as={Link} to={to}>
            <Heading
              size="sm"
              color="whiteAlpha.900"
              lineHeight="1.25"
              noOfLines={2}
              pr={8}
              mb={2}
            >
              {m.question}
            </Heading>
          </LinkOverlay>

          <Flex align="center" gap={2} mb={3} flexWrap="wrap">
            <Badge
              colorScheme={
                kind === "binary"
                  ? "green"
                  : kind === "scalar"
                  ? "purple"
                  : "teal"
              }
              variant="subtle"
            >
              {kind === "binary"
                ? "Binary"
                : kind === "scalar"
                ? `Scalar · ${m.outcomeRefs?.length ?? 0}`
                : `Categorical · ${m.outcomeRefs?.length ?? 0}`}
            </Badge>
            {status && (
              <Badge colorScheme={statusScheme(status)} variant="solid">
                {status.label}
              </Badge>
            )}
            {tracked && (
              <Badge variant="outline" colorScheme="teal">
                Watchlist
              </Badge>
            )}
            {m.optimistic && (
              <Badge
                colorScheme="teal"
                variant="outline"
                display="inline-flex"
                alignItems="center"
                gap={1}
              >
                bond <Photons value={m.optimistic.bond} />
              </Badge>
            )}
            <Text fontFamily="mono" fontSize="xs" color="whiteAlpha.400">
              {m.createTxid.substring(0, 8)}…
            </Text>
          </Flex>

          {kind === "binary" ? (
            yesPctRounded != null ? (
              <>
                <Flex
                  justify="space-between"
                  fontFamily="mono"
                  fontSize="sm"
                  mb={1.5}
                >
                  <Text
                    color={NEON.yes}
                    fontWeight="bold"
                    textShadow="0 0 12px rgba(63, 230, 164, 0.5)"
                  >
                    {yesPctRounded}%{" "}
                    <Text as="span" fontSize="xs">
                      YES
                    </Text>
                  </Text>
                  <Text
                    color={NEON.no}
                    fontWeight="bold"
                    textShadow="0 0 12px rgba(255, 101, 133, 0.45)"
                  >
                    <Text as="span" fontSize="xs">
                      NO
                    </Text>{" "}
                    {100 - yesPctRounded}%
                  </Text>
                </Flex>
                <NeonSplitBar yesPct={yesPctRounded} h="8px" mb={3} />
              </>
            ) : (
              <Text
                fontSize="xs"
                fontFamily="mono"
                color="whiteAlpha.400"
                mb={3}
              >
                {status?.resolved ? "Market resolved" : "No live odds yet"}
              </Text>
            )
          ) : (
            <Text fontSize="xs" fontFamily="mono" color="whiteAlpha.400" mb={3}>
              {m.outcomeRefs?.length ?? 0}-outcome market
            </Text>
          )}

          <Flex
            justify="space-between"
            align="center"
            gap={2}
            fontSize="xs"
            fontFamily="mono"
            color="whiteAlpha.500"
          >
            <Text>
              expiry {m.expiry.toLocaleString()}
              {height != null && !status?.resolved && height < m.expiry && (
                <Text as="span" color="whiteAlpha.400">
                  {" "}
                  · closes {blockEta(height, m.expiry)}
                </Text>
              )}
            </Text>
            <OracleTrustBadge t={m} withTooltip={false} />
          </Flex>
        </HeroCard>
      </LinkBox>
    );
  };

  return (
    <Box mx={{ base: 2, md: 4 }}>
      <Alert status="info" mb={4} borderRadius="md">
        <AlertIcon />
        Fully-collateralized prediction markets on-chain. Binary (YES/NO)
        markets are discovered automatically from the indexer; categorical and
        scalar markets are tracked locally. Import or share any market by its
        creation txid or market ref, or create your own.
      </Alert>

      <Flex gap={2} mb={6} maxW="2xl">
        <Input
          placeholder="Market creation txid or ref (txid_vout)"
          fontFamily="mono"
          value={txid}
          onChange={(e) => setTxid(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && importMarket()}
        />
        <Button onClick={importMarket} isLoading={importing} minW="24">
          Import
        </Button>
      </Flex>

      {entries.length > 0 && (
        <Flex gap={3} mb={4} wrap="wrap" align="center">
          <InputGroup maxW="sm" flex="1 1 220px">
            <InputLeftElement pointerEvents="none">
              <SearchIcon color="whiteAlpha.400" />
            </InputLeftElement>
            <Input
              placeholder="Search markets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </InputGroup>
          <ButtonGroup size="sm" isAttached variant="outline">
            {(["all", "open", "proposed", "resolved"] as StatusFilter[]).map(
              (f) => (
                <Button
                  key={f}
                  onClick={() => setStatusFilter(f)}
                  variant={statusFilter === f ? "solid" : "outline"}
                  colorScheme={statusFilter === f ? "teal" : "gray"}
                  textTransform="capitalize"
                >
                  {f}
                </Button>
              )
            )}
          </ButtonGroup>
          <Select
            size="sm"
            maxW="44"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
          >
            <option value="newest">Newest</option>
            <option value="closing">Closing soon</option>
          </Select>
        </Flex>
      )}

      <Flex align="center" gap={3} mb={3} px={1}>
        <Text fontSize="sm" color="text.muted">
          {shown.length === entries.length
            ? `${entries.length} market${entries.length === 1 ? "" : "s"}`
            : `${shown.length} of ${entries.length} markets`}
        </Text>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={<RepeatIcon />}
          isLoading={discovering}
          loadingText="Discovering"
          onClick={() => {
            loadDiscovered();
            probeStatuses();
          }}
        >
          Refresh
        </Button>
      </Flex>

      {entries.length === 0 ? (
        discovering ? (
          <Flex align="center" gap={3} px={2} color="text.muted">
            <Spinner size="sm" /> Discovering markets…
          </Flex>
        ) : (
          <Text color="text.muted" px={2}>
            No markets found yet — create one, or import by creation txid.
          </Text>
        )
      ) : shown.length === 0 ? (
        <Text color="text.muted" px={2}>
          No markets match your search or filter.
        </Text>
      ) : (
        <>
          {active.length > 0 && (
            <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} maxW="4xl">
              {active.map(renderCard)}
            </SimpleGrid>
          )}

          {resolved.length > 0 && (
            <>
              <Flex align="center" gap={2} mt={8} mb={3} px={1}>
                <Heading size="sm" color="whiteAlpha.700">
                  Resolved
                </Heading>
                <Badge colorScheme="green" variant="subtle">
                  {resolved.length}
                </Badge>
              </Flex>
              <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} maxW="4xl">
                {resolved.map(renderCard)}
              </SimpleGrid>
            </>
          )}
        </>
      )}
    </Box>
  );
}
