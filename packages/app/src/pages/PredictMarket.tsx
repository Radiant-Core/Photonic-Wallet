import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  GridItem,
  Heading,
  HStack,
  Input,
  InputGroup,
  InputRightAddon,
  Select,
  Spinner,
  Textarea,
  Stat,
  StatLabel,
  StatNumber,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useToast,
} from "@chakra-ui/react";
import { Status, type Utxo } from "radiantswap";
import Photons from "@app/components/Photons";
import { useLiveQuery } from "dexie-react-hooks";
import { wallet } from "@app/signals";
import {
  askProbability,
  cancelOrderAction,
  challengeBlocksRemaining,
  fetchLiveMarket,
  fillBidAction,
  fillOrderAction,
  finalizeAction,
  indexedOrderbook,
  isOptimistic,
  listMyOrders,
  listTracked,
  mergeAction,
  openMarketByCreateTxid,
  trackMarket,
  postBidAction,
  postedKind,
  postedOrderIsOpen,
  postOrderAction,
  proposalConfirmations,
  proposeAction,
  redeemAction,
  resolveAction,
  revertAction,
  splitAction,
  statusLabel,
  tradeFromAdTxid,
  walletIsSoloOracle,
  type AdTrade,
  type IndexedAsk,
  type LiveMarket,
  type PostedOrder,
  type TrackedMarket,
} from "@app/predict/predict";
import { bestDirectAsk, deriveMarketOdds } from "@app/predict/odds";
import {
  MarketHeroFrame,
  NeonBuyButton,
  NeonSplitBar,
  NEON,
} from "@app/predict/ui";

const RXD = 100_000_000;

/** Pair up equal-value YES/NO UTXOs into mergeable complete sets (greedy). */
function completeSets(yes: Utxo[], no: Utxo[]): { yes: Utxo; no: Utxo }[] {
  const pool = [...no];
  const sets: { yes: Utxo; no: Utxo }[] = [];
  for (const y of yes) {
    const i = pool.findIndex((n) => n.satoshis === y.satoshis);
    if (i >= 0) {
      sets.push({ yes: y, no: pool[i] });
      pool.splice(i, 1);
    }
  }
  return sets;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Peer-to-peer order trading: post asks for own positions, browse the indexed book, fill ads. */
function OrdersPanel({
  tracked,
  live,
  busy,
  run,
  book,
  reloadBook,
}: {
  tracked: TrackedMarket;
  live: LiveMarket;
  busy: string;
  run: (label: string, fn: () => Promise<string>) => Promise<void>;
  book: { available: boolean; asks: IndexedAsk[] } | null;
  reloadBook: () => void;
}) {
  const toast = useToast();
  const positions = [
    ...live.myYes.map((u) => ({ u, side: "yes" as const })),
    ...live.myNo.map((u) => ({ u, side: "no" as const })),
  ];
  const [posIdx, setPosIdx] = useState("0");
  const [priceRxd, setPriceRxd] = useState("");
  const [bidSide, setBidSide] = useState<"yes" | "no">("yes");
  const [bidAmountRxd, setBidAmountRxd] = useState("1");
  const [bidTotalRxd, setBidTotalRxd] = useState("");
  const [adTxid, setAdTxid] = useState("");
  const [preview, setPreview] = useState<AdTrade | null>(null);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const myOrders = useLiveQuery(
    () => listMyOrders(tracked.createTxid),
    [tracked.createTxid],
    [] as PostedOrder[]
  );
  const bookOdds = book?.available ? deriveMarketOdds(book.asks) : null;

  useEffect(() => {
    (async () => {
      const entries = await Promise.all(
        myOrders.map(
          async (o) => [o.adTxid, await postedOrderIsOpen(o)] as const
        )
      );
      setOpenMap(Object.fromEntries(entries));
    })();
    // `live` in deps: re-check open/closed whenever the market view refreshes —
    // a fill or cancel spends the bound UTXO without touching the list.
  }, [myOrders, live]);

  const post = () => {
    const pos = positions[parseInt(posIdx, 10)];
    const price = Math.round(parseFloat(priceRxd) * 100_000_000);
    if (!pos) {
      toast({ title: "Pick a position to sell", status: "warning" });
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      toast({ title: "Enter an asking price in RXD", status: "warning" });
      return;
    }
    run("Post order", async () => {
      const posted = await postOrderAction(tracked, pos.side, pos.u, price);
      return posted.adTxid;
    });
  };

  const lookupAd = async () => {
    setPreview(null);
    try {
      setPreview(await tradeFromAdTxid(tracked, adTxid));
    } catch (e) {
      toast({
        title: "Ad lookup failed",
        description: (e as Error).message,
        status: "error",
      });
    }
  };

  const fillTrade = async (trade: AdTrade): Promise<string> => {
    if (!trade.open) throw new Error("Order already filled or cancelled");
    if (trade.kind === "bid")
      return await fillBidAction(tracked, live, trade.buy!);
    return await fillOrderAction(tracked, trade.sell!);
  };

  const fillFromBook = (ask: IndexedAsk) => {
    run("Fill", async () =>
      fillTrade(await tradeFromAdTxid(tracked, ask.adTxid))
    );
  };

  const postBid = () => {
    const amount = Math.round(parseFloat(bidAmountRxd) * 100_000_000);
    const total = Math.round(parseFloat(bidTotalRxd) * 100_000_000);
    if (!Number.isFinite(amount) || amount < 546) {
      toast({ title: "Enter a share amount ≥ 546 photons", status: "warning" });
      return;
    }
    if (!Number.isFinite(total) || total <= 0) {
      toast({ title: "Enter the RXD you are offering", status: "warning" });
      return;
    }
    run("Post bid", async () => {
      const posted = await postBidAction(tracked, bidSide, amount, total);
      return posted.adTxid;
    });
  };

  return (
    <Box mb={6}>
      <Heading size="sm" mb={2}>
        Orders
      </Heading>

      {positions.length > 0 && live.state.status === Status.OPEN && (
        <Flex gap={2} mb={3} maxW="3xl" wrap="wrap">
          <Select
            maxW="64"
            value={posIdx}
            onChange={(e) => setPosIdx(e.target.value)}
          >
            {positions.map((p, i) => (
              <option key={`${p.u.txid}:${p.u.vout}`} value={i}>
                {p.side.toUpperCase()}{" "}
                {(p.u.satoshis / 100_000_000).toLocaleString()} RXD (
                {p.u.txid.substring(0, 6)}…:{p.u.vout})
              </option>
            ))}
          </Select>
          <InputGroup maxW="56">
            <Input
              type="number"
              placeholder="ask price"
              value={priceRxd}
              onChange={(e) => setPriceRxd(e.target.value)}
            />
            <InputRightAddon>RXD</InputRightAddon>
          </InputGroup>
          <Button minW="28" isLoading={busy === "Post order"} onClick={post}>
            Post sell order
          </Button>
        </Flex>
      )}

      {live.state.status === Status.OPEN && (
        <Flex gap={2} mb={4} maxW="3xl" wrap="wrap">
          <Select
            maxW="28"
            value={bidSide}
            onChange={(e) => setBidSide(e.target.value as "yes" | "no")}
          >
            <option value="yes">YES</option>
            <option value="no">NO</option>
          </Select>
          <InputGroup maxW="48">
            <Input
              type="number"
              placeholder="shares"
              value={bidAmountRxd}
              onChange={(e) => setBidAmountRxd(e.target.value)}
            />
            <InputRightAddon>shares</InputRightAddon>
          </InputGroup>
          <InputGroup maxW="48">
            <Input
              type="number"
              placeholder="offering"
              value={bidTotalRxd}
              onChange={(e) => setBidTotalRxd(e.target.value)}
            />
            <InputRightAddon>RXD</InputRightAddon>
          </InputGroup>
          <Button minW="28" isLoading={busy === "Post bid"} onClick={postBid}>
            Post buy order
          </Button>
        </Flex>
      )}

      {myOrders.length > 0 && (
        <Box mb={4}>
          <Text fontSize="sm" color="gray.400" mb={1}>
            My posted orders
          </Text>
          <Table size="sm" maxW="3xl">
            <Tbody fontFamily="mono">
              {myOrders.map((o) => (
                <Tr key={o.adTxid}>
                  <Td>
                    <Badge variant="outline" mr={1}>
                      {postedKind(o).toUpperCase()}
                    </Badge>
                    <Badge colorScheme={o.side === "yes" ? "green" : "red"}>
                      {o.side.toUpperCase()}
                    </Badge>
                  </Td>
                  <Td textAlign="right">
                    <Photons value={o.amount} />
                  </Td>
                  <Td>
                    for <Photons value={o.priceSats} /> (
                    {pct(askProbability(o.priceSats, o.amount))})
                  </Td>
                  <Td>
                    <Badge
                      colorScheme={openMap[o.adTxid] ? "blue" : "gray"}
                      fontSize="xs"
                    >
                      {openMap[o.adTxid] === undefined
                        ? "…"
                        : openMap[o.adTxid]
                        ? "open"
                        : "closed"}
                    </Badge>
                  </Td>
                  <Td>
                    {openMap[o.adTxid] && (
                      <Button
                        size="xs"
                        isLoading={busy === "Cancel order"}
                        onClick={() =>
                          run("Cancel order", () => cancelOrderAction(o))
                        }
                      >
                        Cancel
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      )}

      <Flex align="center" gap={2} mb={1}>
        <Text fontSize="sm" color="gray.400">
          Order book (indexer)
        </Text>
        <Button size="xs" onClick={reloadBook}>
          Refresh
        </Button>
      </Flex>
      {live.state.status === Status.OPEN &&
        bookOdds &&
        bookOdds.mid !== null && (
          <Flex align="center" gap={2} my={1} color="gray.500" fontSize="xs">
            <Box
              flex="1"
              borderBottom="1px solid"
              borderColor="whiteAlpha.200"
            />
            <Text whiteSpace="nowrap">
              spread {bookOdds.spread!.toFixed(2)} · mid{" "}
              {bookOdds.mid.toFixed(2)}
            </Text>
            <Box
              flex="1"
              borderBottom="1px solid"
              borderColor="whiteAlpha.200"
            />
          </Flex>
        )}
      {book === null ? (
        <Spinner size="sm" />
      ) : !book.available ? (
        <Text fontSize="sm" color="gray.500" mb={4}>
          The connected indexer has no swap index — orders can still be filled
          from an advertisement txid below.
        </Text>
      ) : book.asks.length === 0 ? (
        <Text fontSize="sm" color="gray.500" mb={4}>
          No open orders for this market.
        </Text>
      ) : (
        <Table size="sm" maxW="3xl" mb={4}>
          <Thead>
            <Tr>
              <Th>Order</Th>
              <Th textAlign="right">Amount</Th>
              <Th textAlign="right">Price</Th>
              <Th textAlign="right">Implied</Th>
              <Th>Maker</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody fontFamily="mono">
            {book.asks.map((a) => (
              <Tr key={a.adTxid}>
                <Td>
                  <Badge variant="outline" mr={1}>
                    {a.kind.toUpperCase()}
                  </Badge>
                  <Badge colorScheme={a.side === "yes" ? "green" : "red"}>
                    {a.side.toUpperCase()}
                  </Badge>
                </Td>
                <Td textAlign="right">
                  <Photons value={a.amount} />
                </Td>
                <Td textAlign="right">
                  <Photons value={a.priceSats} />
                </Td>
                <Td textAlign="right">
                  {pct(askProbability(a.priceSats, a.amount))}
                </Td>
                <Td>
                  {a.makerAddress === wallet.value.address ? (
                    <Badge fontSize="xs">you</Badge>
                  ) : (
                    `${a.makerAddress?.substring(0, 8) ?? "?"}…`
                  )}
                </Td>
                <Td>
                  {a.makerAddress !== wallet.value.address && (
                    <Button
                      size="xs"
                      isLoading={busy === "Fill"}
                      onClick={() => fillFromBook(a)}
                    >
                      Fill
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}

      <Flex gap={2} maxW="3xl" wrap="wrap">
        <Input
          maxW="md"
          fontFamily="mono"
          placeholder="Fill from advertisement txid"
          value={adTxid}
          onChange={(e) => setAdTxid(e.target.value)}
        />
        <Button minW="24" onClick={lookupAd}>
          Look up
        </Button>
      </Flex>
      {preview && (
        <Flex align="center" gap={3} mt={2} fontSize="sm">
          <Badge variant="outline">{preview.kind.toUpperCase()}</Badge>
          <Badge colorScheme={preview.side === "yes" ? "green" : "red"}>
            {preview.side.toUpperCase()}
          </Badge>
          <Photons
            value={
              preview.kind === "bid"
                ? preview.buy!.shareOut.satoshis
                : preview.sell!.share.satoshis
            }
          />
          <Text>for</Text>
          <Photons
            value={
              preview.kind === "bid"
                ? preview.buy!.rxd.satoshis
                : preview.sell!.payment.satoshis
            }
          />
          <Text>
            (
            {pct(
              askProbability(
                preview.kind === "bid"
                  ? preview.buy!.rxd.satoshis
                  : preview.sell!.payment.satoshis,
                preview.kind === "bid"
                  ? preview.buy!.shareOut.satoshis
                  : preview.sell!.share.satoshis
              )
            )}
            )
          </Text>
          <Badge colorScheme={preview.open ? "blue" : "gray"}>
            {preview.open ? "open" : "closed"}
          </Badge>
          {preview.open && (
            <Button
              size="xs"
              isLoading={busy === "Fill"}
              onClick={() => run("Fill", () => fillTrade(preview))}
            >
              Fill
            </Button>
          )}
        </Flex>
      )}
    </Box>
  );
}

export default function PredictMarket() {
  const { createTxid } = useParams<{ createTxid: string }>();
  const toast = useToast();
  const [tracked, setTracked] = useState<TrackedMarket | null>(null);
  const [live, setLive] = useState<LiveMarket | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [splitRxd, setSplitRxd] = useState("1");
  const [ckeys, setCkeys] = useState("");
  const [cwifs, setCwifs] = useState("");
  const [book, setBook] = useState<{
    available: boolean;
    asks: IndexedAsk[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await listTracked();
      let t = rows.find((r) => r.createTxid === createTxid) || null;
      // Not in the local watchlist (opened from the discovered-markets feed or a shared link):
      // re-anchor the binary market from its on-chain RMKT beacon and add it to the watchlist.
      if (!t && createTxid) {
        try {
          t = await openMarketByCreateTxid(createTxid);
          await trackMarket(t);
        } catch (e) {
          if (!cancelled) setError((e as Error).message);
          return;
        }
      }
      if (cancelled) return;
      setTracked(t);
      if (t?.committeeKeys?.length) setCkeys(t.committeeKeys.join("\n"));
      if (!t) setError("Market not tracked — import it from the Markets page");
    })();
    return () => {
      cancelled = true;
    };
  }, [createTxid]);

  // Plain const (not useMemo): walletIsSoloOracle reads wallet.value.wif/locked, which change on
  // unlock — a [tracked]-keyed memo would stay stale if the wallet unlocks after this page mounts.
  const soloOracle = tracked ? walletIsSoloOracle(tracked) : false;
  const threshold = tracked ? parseInt(tracked.oracle.substring(0, 2), 16) : 1;
  const committeeInput = () =>
    soloOracle || !tracked
      ? undefined
      : {
          keys: ckeys
            .split("\n")
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean),
          threshold,
          signerWifs: cwifs
            .split("\n")
            .map((w) => w.trim())
            .filter(Boolean),
        };

  const refresh = useCallback(async () => {
    if (!tracked) return;
    setError("");
    try {
      setLive(await fetchLiveMarket(tracked));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tracked]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Self-heal: a market resolved/reverted in another wallet doesn't push an event here, so poll
  // while it's still actionable (Open, or an optimistic challenge window) and refresh whenever the
  // tab regains focus. Stops once terminal — a resolved/reverted singleton never changes again, so
  // a stale "live" view can't linger.
  useEffect(() => {
    if (!tracked) return;
    const s = live?.state.status;
    const terminal =
      s !== undefined &&
      s !== Status.OPEN &&
      s !== Status.PROPOSED_YES &&
      s !== Status.PROPOSED_NO;
    if (terminal) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    const id = setInterval(refresh, 20000);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, [tracked, live?.state.status, refresh]);

  // After an action broadcasts, ElectrumX's listunspent cache can briefly still list the spent
  // singleton, so a single refresh may render the pre-action status. Re-probe a few times with
  // backoff to converge on the new on-chain state.
  const refreshSettled = useCallback(async () => {
    for (const ms of [0, 2500, 5000, 8000]) {
      if (ms) await new Promise((r) => setTimeout(r, ms));
      await refresh();
    }
  }, [refresh]);

  const loadBook = useCallback(async () => {
    if (!tracked) return;
    try {
      setBook(await indexedOrderbook(tracked));
    } catch {
      setBook({ available: false, asks: [] });
    }
  }, [tracked]);
  useEffect(() => {
    loadBook();
  }, [loadBook]);

  const sets = useMemo(
    () => (live ? completeSets(live.myYes, live.myNo) : []),
    [live]
  );

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      const txid = await fn();
      toast({
        title: `${label} broadcast`,
        description: txid,
        status: "success",
      });
      // Singleton chain advances one tx per action; refetch the live view (with settle-retry to
      // beat the listunspent cache lag) + order book.
      await refreshSettled();
      await loadBook();
    } catch (e) {
      toast({
        title: `${label} failed`,
        description: (e as Error).message,
        status: "error",
      });
    } finally {
      setBusy("");
    }
  };

  if (!tracked) {
    return (
      <Box mx={4}>
        {error ? (
          <Alert status="warning">
            <AlertIcon />
            {error}
          </Alert>
        ) : (
          <Spinner />
        )}
      </Box>
    );
  }

  const st = live?.state.status;
  const open = st === Status.OPEN;
  const resolved = st === Status.RESOLVED_YES || st === Status.RESOLVED_NO;
  const winningSide = st === Status.RESOLVED_YES ? "YES" : "NO";
  const revertibleAt = tracked.expiry + tracked.grace;
  const canRevert = open && live !== null && live.height >= revertibleAt;

  // Market-level odds + one-click buy targets (Items 1 & 3), derived from the indexed book. Plain
  // consts (not useMemo): they must NOT sit after the `if (!tracked) return` guard above as hooks,
  // and they're cheap O(book) pure computations that also need to track the wallet address signal.
  const odds = book?.available ? deriveMarketOdds(book.asks) : null;
  const yesAsk = book?.available
    ? bestDirectAsk(book.asks, "yes", wallet.value.address)
    : null;
  const noAsk = book?.available
    ? bestDirectAsk(book.asks, "no", wallet.value.address)
    : null;
  const buyBest = (side: "yes" | "no", ask: IndexedAsk | null) => {
    if (!live) return;
    if (!ask) {
      toast({
        title: `No ${side.toUpperCase()} sell orders to fill yet`,
        status: "warning",
      });
      return;
    }
    run(`Buy ${side.toUpperCase()}`, async () => {
      const trade = await tradeFromAdTxid(tracked, ask.adTxid);
      if (!trade.open)
        throw new Error("That order was just filled — refresh and retry");
      if (trade.kind !== "ask" || !trade.sell)
        throw new Error("Unexpected order kind");
      return await fillOrderAction(tracked, trade.sell);
    });
  };

  // Optimistic-oracle (MarketOpt) lifecycle flags (Item 4).
  const optimistic = isOptimistic(tracked);
  const proposed = st === Status.PROPOSED_YES || st === Status.PROPOSED_NO;
  const proposedSide = st === Status.PROPOSED_YES ? "YES" : "NO";
  const canPropose =
    optimistic && open && live !== null && live.height >= tracked.expiry;
  const challengeLeft =
    optimistic && proposed && live
      ? challengeBlocksRemaining(tracked, live)
      : 0;
  const canFinalize = proposed && challengeLeft === 0;

  return (
    <Box mx={{ base: 2, md: 4 }}>
      {/* Neon market hero — dark glass card with the question, RadiantSwap badge, live
          YES/NO odds, split probability bar, and one-click buy buttons. */}
      <MarketHeroFrame
        question={tracked.question}
        headerMb={open && odds && odds.yesProb !== null ? 6 : 3}
        mb={4}
      >
        {open && odds && odds.yesProb !== null ? (
          <>
            <Flex
              justify="space-between"
              align="flex-end"
              mb={3}
              fontFamily="mono"
            >
              <Box textShadow="0 0 22px rgba(63, 230, 164, 0.55)">
                <Text
                  as="span"
                  fontSize={{ base: "3xl", md: "4xl" }}
                  fontWeight="bold"
                  color={NEON.yes}
                  lineHeight="1"
                >
                  {pct(odds.yesProb)}
                </Text>{" "}
                <Text
                  as="span"
                  fontSize={{ base: "lg", md: "2xl" }}
                  color={NEON.yes}
                  fontWeight="bold"
                  letterSpacing="0.06em"
                >
                  YES
                </Text>
              </Box>
              <Box
                textAlign="right"
                textShadow="0 0 22px rgba(255, 101, 133, 0.5)"
              >
                <Text
                  as="span"
                  fontSize={{ base: "lg", md: "2xl" }}
                  color={NEON.no}
                  fontWeight="bold"
                  letterSpacing="0.06em"
                >
                  NO
                </Text>{" "}
                <Text
                  as="span"
                  fontSize={{ base: "3xl", md: "4xl" }}
                  fontWeight="bold"
                  color={NEON.no}
                  lineHeight="1"
                >
                  {/* Derive NO from the rounded YES so the two halves always sum to 100%. */}
                  {100 - Math.round(odds.yesProb * 100)}%
                </Text>
              </Box>
            </Flex>
            <NeonSplitBar yesPct={odds.yesProb * 100} mb={6} />
            <Flex gap={4} wrap="wrap">
              <NeonBuyButton
                side="yes"
                isLoading={busy === "Buy YES"}
                isDisabled={!yesAsk || !live}
                onClick={() => buyBest("yes", yesAsk)}
              >
                BUY YES
                {yesAsk
                  ? ` · ${pct(askProbability(yesAsk.priceSats, yesAsk.amount))}`
                  : ""}
              </NeonBuyButton>
              <NeonBuyButton
                side="no"
                isLoading={busy === "Buy NO"}
                isDisabled={!noAsk || !live}
                onClick={() => buyBest("no", noAsk)}
              >
                BUY NO
                {noAsk
                  ? ` · ${pct(askProbability(noAsk.priceSats, noAsk.amount))}`
                  : ""}
              </NeonBuyButton>
            </Flex>
          </>
        ) : (
          <Text fontSize="sm" color="whiteAlpha.500" fontFamily="mono">
            {open
              ? "No live odds yet — post or fill an order below to set the price."
              : "Market closed — see resolution below."}
          </Text>
        )}
      </MarketHeroFrame>

      <Text fontFamily="mono" fontSize="xs" color="gray.500" mb={5}>
        market {tracked.marketRef.substring(0, 16)}… · created{" "}
        {tracked.createTxid.substring(0, 8)}…
      </Text>

      {error && (
        <Alert status="error" mb={4} borderRadius="md">
          <AlertIcon />
          {error}
        </Alert>
      )}

      {!live ? (
        error ? (
          <Button
            size="sm"
            isLoading={busy !== ""}
            onClick={() => {
              refresh();
              loadBook();
            }}
          >
            Retry
          </Button>
        ) : (
          <Spinner />
        )
      ) : (
        <>
          <Grid
            templateColumns={{ base: "1fr 1fr", md: "repeat(4, 1fr)" }}
            gap={4}
            mb={6}
          >
            <GridItem as={Stat}>
              <StatLabel>Status</StatLabel>
              <StatNumber>
                <Badge
                  fontSize="md"
                  colorScheme={
                    open
                      ? "blue"
                      : proposed
                      ? "purple"
                      : st === Status.REVERTED
                      ? "orange"
                      : "green"
                  }
                >
                  {statusLabel[live.state.status]}
                </Badge>
              </StatNumber>
            </GridItem>
            <GridItem as={Stat}>
              <StatLabel>Collateral pool</StatLabel>
              <StatNumber>
                <Photons value={live.market.satoshis} />
              </StatNumber>
            </GridItem>
            <GridItem as={Stat}>
              <StatLabel>Expiry / grace</StatLabel>
              <StatNumber fontSize="lg">
                {tracked.expiry.toLocaleString()} +{" "}
                {tracked.grace.toLocaleString()}
              </StatNumber>
            </GridItem>
            <GridItem as={Stat}>
              <StatLabel>Chain height</StatLabel>
              <StatNumber fontSize="lg">
                {live.height.toLocaleString()}
              </StatNumber>
            </GridItem>
          </Grid>

          {open && (
            <Box mb={6}>
              <Heading size="sm" mb={2}>
                Mint complete sets
              </Heading>
              <Text fontSize="sm" color="gray.400" mb={2}>
                Lock N RXD collateral (plus N+N carrier value) to mint N YES + N
                NO. A complete set can always be merged back — only a losing
                single side at resolution loses value.
              </Text>
              <Flex gap={2} maxW="md">
                <InputGroup>
                  <Input
                    type="number"
                    value={splitRxd}
                    onChange={(e) => setSplitRxd(e.target.value)}
                  />
                  <InputRightAddon>RXD</InputRightAddon>
                </InputGroup>
                <Button
                  minW="24"
                  isLoading={busy === "Split"}
                  onClick={() => {
                    const n = Math.round(parseFloat(splitRxd) * RXD);
                    if (!Number.isFinite(n) || n < 546) {
                      toast({
                        title: "Enter an amount ≥ 546 photons",
                        status: "warning",
                      });
                      return;
                    }
                    run("Split", () => splitAction(tracked, live, n));
                  }}
                >
                  Split
                </Button>
              </Flex>
            </Box>
          )}

          <Heading size="sm" mb={2}>
            My positions
          </Heading>
          {live.myYes.length + live.myNo.length === 0 ? (
            <Text fontSize="sm" color="gray.400" mb={6}>
              None.
            </Text>
          ) : (
            <Table size="sm" maxW="3xl" mb={6}>
              <Thead>
                <Tr>
                  <Th>Side</Th>
                  <Th>UTXO</Th>
                  <Th textAlign="right">Amount</Th>
                  <Th width="120px" />
                </Tr>
              </Thead>
              <Tbody fontFamily="mono">
                {[
                  ...live.myYes.map((u) => ({ u, side: "YES" })),
                  ...live.myNo.map((u) => ({ u, side: "NO" })),
                ].map(({ u, side }) => (
                  <Tr key={`${side}-${u.txid}-${u.vout}`}>
                    <Td>
                      <Badge colorScheme={side === "YES" ? "green" : "red"}>
                        {side}
                      </Badge>
                    </Td>
                    <Td>
                      {u.txid.substring(0, 8)}…:{u.vout}
                    </Td>
                    <Td textAlign="right">
                      <Photons value={u.satoshis} />
                    </Td>
                    <Td>
                      {resolved && side === winningSide && (
                        <Button
                          size="xs"
                          isLoading={busy === "Redeem"}
                          onClick={() =>
                            run("Redeem", () => redeemAction(tracked, live, u))
                          }
                        >
                          Redeem 1:1
                        </Button>
                      )}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}

          {sets.length > 0 && (
            <Box mb={6}>
              <Heading size="sm" mb={2}>
                Complete sets (merge to reclaim collateral)
              </Heading>
              <HStack wrap="wrap">
                {sets.map((s) => (
                  <Button
                    key={`${s.yes.txid}-${s.yes.vout}`}
                    size="sm"
                    isLoading={busy === "Merge"}
                    onClick={() =>
                      run("Merge", () =>
                        mergeAction(tracked, live, s.yes, s.no)
                      )
                    }
                  >
                    Merge <Photons value={s.yes.satoshis} />
                  </Button>
                ))}
              </HStack>
            </Box>
          )}

          <OrdersPanel
            tracked={tracked}
            live={live}
            busy={busy}
            run={run}
            book={book}
            reloadBook={loadBook}
          />

          <Heading size="sm" mb={2}>
            Resolution
          </Heading>
          {/* Committee/oracle key inputs — needed to resolve a classic market, or to OVERRIDE a
              proposal on an optimistic one. Shown while the market is open or has a live proposal. */}
          {!soloOracle && (open || proposed) && (
            <Box mb={2} maxW="2xl">
              <Text fontSize="sm" color="gray.400" mb={1}>
                Committee market ({threshold}-of-N). Member pubkeys in slot
                order and ≥{threshold} member WIFs:
              </Text>
              <Textarea
                fontFamily="mono"
                fontSize="xs"
                rows={3}
                mb={2}
                placeholder={"member pubkeys, one per line (slot order)"}
                value={ckeys}
                onChange={(e) => setCkeys(e.target.value)}
              />
              <Textarea
                fontFamily="mono"
                fontSize="xs"
                rows={2}
                placeholder={"signing member WIFs, one per line"}
                value={cwifs}
                onChange={(e) => setCwifs(e.target.value)}
              />
            </Box>
          )}

          {/* Optimistic proposal status + challenge-window countdown. */}
          {optimistic && proposed && live && tracked.optimistic && (
            <Alert
              status="info"
              mb={3}
              borderRadius="md"
              maxW="2xl"
              alignItems="flex-start"
            >
              <AlertIcon />
              <Box fontSize="sm">
                <Text>
                  Proposed <b>{proposedSide}</b> — challenge window{" "}
                  {proposalConfirmations(live)}/{tracked.optimistic.liveness}{" "}
                  blocks.{" "}
                  {challengeLeft > 0
                    ? `${challengeLeft} block(s) until anyone can finalize.`
                    : "Finalizable now."}
                </Text>
                <Text color="gray.400" mt={1}>
                  Proposer bond <Photons value={tracked.optimistic.bond} /> is
                  repaid on finalize, or slashed if the committee overrides the
                  proposal.
                </Text>
              </Box>
            </Alert>
          )}

          <HStack wrap="wrap" mb={2}>
            {/* Optimistic OPEN: anyone may propose an outcome (and lock a bond) after expiry. */}
            {optimistic && open && (
              <>
                <Button
                  size="sm"
                  colorScheme="green"
                  isLoading={busy === "Propose YES"}
                  isDisabled={!canPropose}
                  onClick={() =>
                    run("Propose YES", () =>
                      proposeAction(tracked, live, Status.PROPOSED_YES)
                    )
                  }
                >
                  Propose YES
                </Button>
                <Button
                  size="sm"
                  colorScheme="red"
                  isLoading={busy === "Propose NO"}
                  isDisabled={!canPropose}
                  onClick={() =>
                    run("Propose NO", () =>
                      proposeAction(tracked, live, Status.PROPOSED_NO)
                    )
                  }
                >
                  Propose NO
                </Button>
              </>
            )}

            {/* Optimistic PROPOSED: anyone finalizes after liveness; committee may override. */}
            {optimistic && proposed && (
              <>
                <Button
                  size="sm"
                  colorScheme="blue"
                  isLoading={busy === "Finalize"}
                  isDisabled={!canFinalize}
                  onClick={() =>
                    run("Finalize", () => finalizeAction(tracked, live))
                  }
                >
                  {canFinalize
                    ? `Finalize ${proposedSide}`
                    : `Finalize (in ${challengeLeft})`}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  colorScheme="green"
                  isLoading={busy === "Override YES"}
                  onClick={() =>
                    run("Override YES", () =>
                      resolveAction(
                        tracked,
                        live,
                        Status.RESOLVED_YES,
                        committeeInput()
                      )
                    )
                  }
                >
                  Override → YES
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  colorScheme="red"
                  isLoading={busy === "Override NO"}
                  onClick={() =>
                    run("Override NO", () =>
                      resolveAction(
                        tracked,
                        live,
                        Status.RESOLVED_NO,
                        committeeInput()
                      )
                    )
                  }
                >
                  Override → NO
                </Button>
              </>
            )}

            {/* Committee/oracle resolve (classic markets, or an immediate settle on an optimistic
                open market) + permissionless revert after expiry + grace. */}
            {open && (
              <>
                <Button
                  size="sm"
                  colorScheme="green"
                  variant={optimistic ? "outline" : "solid"}
                  isLoading={busy === "Resolve YES"}
                  onClick={() =>
                    run("Resolve YES", () =>
                      resolveAction(
                        tracked,
                        live,
                        Status.RESOLVED_YES,
                        committeeInput()
                      )
                    )
                  }
                >
                  Resolve YES
                </Button>
                <Button
                  size="sm"
                  colorScheme="red"
                  variant={optimistic ? "outline" : "solid"}
                  isLoading={busy === "Resolve NO"}
                  onClick={() =>
                    run("Resolve NO", () =>
                      resolveAction(
                        tracked,
                        live,
                        Status.RESOLVED_NO,
                        committeeInput()
                      )
                    )
                  }
                >
                  Resolve NO
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={!canRevert}
                  isLoading={busy === "Revert"}
                  onClick={() =>
                    run("Revert", () => revertAction(tracked, live))
                  }
                >
                  Revert{!canRevert && ` (at ${revertibleAt.toLocaleString()})`}
                </Button>
              </>
            )}
            {!open && !proposed && (
              <Text fontSize="sm" color="gray.400">
                Final.
              </Text>
            )}
          </HStack>

          {optimistic && open && live && live.height < tracked.expiry && (
            <Text fontSize="xs" color="gray.500" maxW="2xl" mb={1}>
              Proposals open at block {tracked.expiry.toLocaleString()} (current{" "}
              {live.height.toLocaleString()}).
            </Text>
          )}
          <Text fontSize="xs" color="gray.500" maxW="2xl">
            {optimistic
              ? "Optimistic market: after expiry anyone may propose the outcome by locking a bond; the committee can override within the challenge window (slashing the bond), after which anyone may finalize and the bond returns to the proposer. "
              : soloOracle
              ? "This wallet holds the market's operator oracle key. "
              : "Resolution needs the committee threshold; the chain stores only the keyset hash, so the member pubkeys must be supplied in their original slot order. "}
            Revert is permissionless once the chain passes expiry + grace, and
            leaves every complete set reclaimable via merge.
          </Text>

          <Button size="sm" mt={6} onClick={refresh}>
            Refresh
          </Button>
        </>
      )}
    </Box>
  );
}
