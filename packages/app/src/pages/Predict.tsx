import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  IconButton,
  Input,
  LinkBox,
  LinkOverlay,
  SimpleGrid,
  Spinner,
  Text,
  useToast,
} from "@chakra-ui/react";
import { DeleteIcon, RepeatIcon } from "@chakra-ui/icons";
import { useLiveQuery } from "dexie-react-hooks";
import {
  discoverMarkets,
  indexedOrderbook,
  listTracked,
  marketKind,
  openMarketByCreateTxid,
  trackMarket,
  untrackMarket,
  type TrackedMarket,
} from "@app/predict/predict";
import { deriveMarketOdds } from "@app/predict/odds";
import { HeroCard, NeonSplitBar, NEON } from "@app/predict/ui";

/** A market shown on the list: the market plus whether it's in the local watchlist (controls the
 *  untrack button) and whether the indexer discovered it. */
interface ListEntry {
  m: TrackedMarket;
  tracked: boolean;
  discovered: boolean;
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

  const loadDiscovered = useCallback(async () => {
    setDiscovering(true);
    try {
      setDiscovered(await discoverMarkets(100));
    } finally {
      setDiscovering(false);
    }
  }, []);
  useEffect(() => {
    loadDiscovered();
  }, [loadDiscovered]);

  const entries: ListEntry[] = useMemo(() => {
    const localByTxid = new Map(local.map((m) => [m.createTxid, m]));
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

  // Per-market YES probability for the mini odds bar (binary markets only). Fetched best-effort
  // from the indexer's swap book; null = fetched but no live price, undefined = not fetched yet.
  const [oddsMap, setOddsMap] = useState<Record<string, number | null>>({});
  const txKey = entries.map((e) => e.m.createTxid).join(",");
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

  const importMarket = async () => {
    if (!/^[0-9a-fA-F]{64}$/.test(txid.trim())) {
      toast({ title: "Enter a 64-character creation txid", status: "warning" });
      return;
    }
    setImporting(true);
    try {
      const t = await openMarketByCreateTxid(txid);
      await trackMarket(t);
      setTxid("");
      toast({ title: "Market imported", status: "success" });
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

  return (
    <Box mx={{ base: 2, md: 4 }}>
      <Alert status="info" mb={4} borderRadius="md">
        <AlertIcon />
        Fully-collateralized prediction markets on-chain. Binary (YES/NO)
        markets are discovered automatically from the indexer; categorical and
        scalar markets are tracked locally. Import any market by its creation
        txid, or create your own.
      </Alert>

      <Flex gap={2} mb={6} maxW="2xl">
        <Input
          placeholder="Market creation txid"
          fontFamily="mono"
          value={txid}
          onChange={(e) => setTxid(e.target.value)}
        />
        <Button onClick={importMarket} isLoading={importing} minW="24">
          Import
        </Button>
      </Flex>

      <Flex align="center" gap={3} mb={3} px={1}>
        <Text fontSize="sm" color="gray.400">
          {entries.length} market{entries.length === 1 ? "" : "s"}
        </Text>
        <Button
          size="xs"
          variant="ghost"
          leftIcon={<RepeatIcon />}
          isLoading={discovering}
          loadingText="Discovering"
          onClick={loadDiscovered}
        >
          Refresh
        </Button>
      </Flex>

      {entries.length === 0 ? (
        discovering ? (
          <Flex align="center" gap={3} px={2} color="gray.400">
            <Spinner size="sm" /> Discovering markets…
          </Flex>
        ) : (
          <Text color="gray.400" px={2}>
            No markets found yet — create one, or import by creation txid.
          </Text>
        )
      ) : (
        <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4} maxW="4xl">
          {entries.map(({ m, tracked }) => {
            const kind = marketKind(m);
            const to =
              kind === "binary"
                ? `/predict/m/${m.createTxid}`
                : `/predict/cat/${m.createTxid}`;
            const yesProb =
              kind === "binary" ? oddsMap[m.createTxid] : undefined;
            const threshold = parseInt(m.oracle.substring(0, 2), 16);
            const yesPctRounded =
              yesProb != null ? Math.round(yesProb * 100) : null;
            return (
              <LinkBox key={m.createTxid}>
                <HeroCard
                  px={5}
                  py={4}
                  borderRadius="xl"
                  cursor="pointer"
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

                  <Flex align="center" gap={2} mb={3}>
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
                    {tracked && (
                      <Badge variant="outline" colorScheme="teal">
                        Watchlist
                      </Badge>
                    )}
                    <Text
                      fontFamily="mono"
                      fontSize="xs"
                      color="whiteAlpha.400"
                    >
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
                        No live odds yet
                      </Text>
                    )
                  ) : (
                    <Text
                      fontSize="xs"
                      fontFamily="mono"
                      color="whiteAlpha.400"
                      mb={3}
                    >
                      {m.outcomeRefs?.length ?? 0}-outcome market
                    </Text>
                  )}

                  <Flex
                    justify="space-between"
                    fontSize="xs"
                    fontFamily="mono"
                    color="whiteAlpha.500"
                  >
                    <Text>expiry block {m.expiry.toLocaleString()}</Text>
                    <Text>{threshold}-of-N oracle</Text>
                  </Flex>
                </HeroCard>
              </LinkBox>
            );
          })}
        </SimpleGrid>
      )}
    </Box>
  );
}
