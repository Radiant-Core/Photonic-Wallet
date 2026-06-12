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
import { Status, type SellOrder, type Utxo } from "radiantswap";
import Photons from "@app/components/Photons";
import { useLiveQuery } from "dexie-react-hooks";
import { wallet } from "@app/signals";
import {
  askProbability,
  cancelOrderAction,
  fetchLiveMarket,
  fillBidAction,
  fillOrderAction,
  indexedOrderbook,
  listMyOrders,
  listTracked,
  mergeAction,
  postBidAction,
  postedKind,
  postedOrderIsOpen,
  postOrderAction,
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
}: {
  tracked: TrackedMarket;
  live: LiveMarket;
  busy: string;
  run: (label: string, fn: () => Promise<string>) => Promise<void>;
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
  const [book, setBook] = useState<{ available: boolean; asks: IndexedAsk[] } | null>(null);
  const [adTxid, setAdTxid] = useState("");
  const [preview, setPreview] = useState<AdTrade | null>(null);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const myOrders = useLiveQuery(
    () => listMyOrders(tracked.createTxid),
    [tracked.createTxid],
    [] as PostedOrder[]
  );

  const loadBook = async () => {
    try {
      setBook(await indexedOrderbook(tracked));
    } catch {
      setBook({ available: false, asks: [] });
    }
  };
  useEffect(() => {
    loadBook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked.createTxid]);

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
      toast({ title: "Ad lookup failed", description: (e as Error).message, status: "error" });
    }
  };

  const fillTrade = async (trade: AdTrade): Promise<string> => {
    if (!trade.open) throw new Error("Order already filled or cancelled");
    if (trade.kind === "bid") return await fillBidAction(tracked, live, trade.buy!);
    return await fillOrderAction(tracked, trade.sell!);
  };

  const fillFromBook = (ask: IndexedAsk) => {
    run("Fill", async () => fillTrade(await tradeFromAdTxid(tracked, ask.adTxid)));
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
                {p.side.toUpperCase()} {(p.u.satoshis / 100_000_000).toLocaleString()} RXD ({p.u.txid.substring(0, 6)}…:{p.u.vout})
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
                    for <Photons value={o.priceSats} /> ({pct(askProbability(o.priceSats, o.amount))})
                  </Td>
                  <Td>
                    <Badge colorScheme={openMap[o.adTxid] ? "blue" : "gray"} fontSize="xs">
                      {openMap[o.adTxid] === undefined ? "…" : openMap[o.adTxid] ? "open" : "closed"}
                    </Badge>
                  </Td>
                  <Td>
                    {openMap[o.adTxid] && (
                      <Button
                        size="xs"
                        isLoading={busy === "Cancel order"}
                        onClick={() => run("Cancel order", () => cancelOrderAction(o))}
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
          Open orders (indexer)
        </Text>
        <Button size="xs" onClick={loadBook}>
          Refresh
        </Button>
      </Flex>
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
                <Td textAlign="right">{pct(askProbability(a.priceSats, a.amount))}</Td>
                <Td>
                  {a.makerAddress === wallet.value.address ? (
                    <Badge fontSize="xs">you</Badge>
                  ) : (
                    `${a.makerAddress?.substring(0, 8) ?? "?"}…`
                  )}
                </Td>
                <Td>
                  {a.makerAddress !== wallet.value.address && (
                    <Button size="xs" isLoading={busy === "Fill"} onClick={() => fillFromBook(a)}>
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

  useEffect(() => {
    listTracked().then((rows) => {
      const t = rows.find((r) => r.createTxid === createTxid) || null;
      setTracked(t);
      if (t?.committeeKeys?.length) setCkeys(t.committeeKeys.join("\n"));
      if (!t) setError("Market not tracked — import it from the Markets page");
    });
  }, [createTxid]);

  const soloOracle = useMemo(
    () => (tracked ? walletIsSoloOracle(tracked) : false),
    [tracked]
  );
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
      // Singleton chain advances one tx per action; refetch the live view.
      await refresh();
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
      <Box mx={4}>{error ? <Alert status="warning"><AlertIcon />{error}</Alert> : <Spinner />}</Box>
    );
  }

  const st = live?.state.status;
  const open = st === Status.OPEN;
  const resolved = st === Status.RESOLVED_YES || st === Status.RESOLVED_NO;
  const winningSide = st === Status.RESOLVED_YES ? "YES" : "NO";
  const myWinning =
    st === Status.RESOLVED_YES ? live?.myYes : st === Status.RESOLVED_NO ? live?.myNo : [];
  const revertibleAt = tracked.expiry + tracked.grace;
  const canRevert = open && live !== null && live.height >= revertibleAt;

  return (
    <Box mx={{ base: 2, md: 4 }}>
      <Heading size="md" mb={1}>
        {tracked.question}
      </Heading>
      <Text fontFamily="mono" fontSize="xs" color="gray.500" mb={4}>
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
        !error && <Spinner />
      ) : (
        <>
          <Grid templateColumns={{ base: "1fr 1fr", md: "repeat(4, 1fr)" }} gap={4} mb={6}>
            <GridItem as={Stat}>
              <StatLabel>Status</StatLabel>
              <StatNumber>
                <Badge
                  fontSize="md"
                  colorScheme={
                    open ? "blue" : st === Status.REVERTED ? "orange" : "green"
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
                {tracked.expiry.toLocaleString()} + {tracked.grace.toLocaleString()}
              </StatNumber>
            </GridItem>
            <GridItem as={Stat}>
              <StatLabel>Chain height</StatLabel>
              <StatNumber fontSize="lg">{live.height.toLocaleString()}</StatNumber>
            </GridItem>
          </Grid>

          {open && (
            <Box mb={6}>
              <Heading size="sm" mb={2}>
                Mint complete sets
              </Heading>
              <Text fontSize="sm" color="gray.400" mb={2}>
                Lock N RXD collateral (plus N+N carrier value) to mint N YES +
                N NO. A complete set can always be merged back — only a losing
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
                      toast({ title: "Enter an amount ≥ 546 photons", status: "warning" });
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
                      <Badge colorScheme={side === "YES" ? "green" : "red"}>{side}</Badge>
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
                          onClick={() => run("Redeem", () => redeemAction(tracked, live, u))}
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
                    onClick={() => run("Merge", () => mergeAction(tracked, live, s.yes, s.no))}
                  >
                    Merge <Photons value={s.yes.satoshis} />
                  </Button>
                ))}
              </HStack>
            </Box>
          )}

          <OrdersPanel tracked={tracked} live={live} busy={busy} run={run} />

          <Heading size="sm" mb={2}>
            Resolution
          </Heading>
          {open && !soloOracle && (
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
          <HStack wrap="wrap" mb={2}>
            {open && (
              <>
                <Button
                  size="sm"
                  colorScheme="green"
                  isLoading={busy === "Resolve YES"}
                  onClick={() =>
                    run("Resolve YES", () =>
                      resolveAction(tracked, live, Status.RESOLVED_YES, committeeInput())
                    )
                  }
                >
                  Resolve YES
                </Button>
                <Button
                  size="sm"
                  colorScheme="red"
                  isLoading={busy === "Resolve NO"}
                  onClick={() =>
                    run("Resolve NO", () =>
                      resolveAction(tracked, live, Status.RESOLVED_NO, committeeInput())
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
                  onClick={() => run("Revert", () => revertAction(tracked, live))}
                >
                  Revert{!canRevert && ` (at ${revertibleAt.toLocaleString()})`}
                </Button>
              </>
            )}
            {!open && <Text fontSize="sm" color="gray.400">Final.</Text>}
          </HStack>
          <Text fontSize="xs" color="gray.500" maxW="2xl">
            {soloOracle
              ? "This wallet holds the market's operator oracle key."
              : "Resolution needs the committee threshold; the chain stores only the keyset hash, so the member pubkeys must be supplied in their original slot order."}{" "}
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
