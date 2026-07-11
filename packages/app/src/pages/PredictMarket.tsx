import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
  Link,
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
  disputeAction,
  disputeTimeoutAction,
  isDisputed,
  proposeBondFloor,
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
  postLadderAction,
  postOrderAction,
  priceSatsForProb,
  rungsForProb,
  slopedRungs,
  rampProbs,
  seedLiquidityAction,
  proposalConfirmations,
  proposeAction,
  redeemAction,
  resolveAction,
  revertAction,
  splitAction,
  statusLabel,
  tradeFromAdTxid,
  walletIsSoloOracle,
  walletPkh,
  type AdTrade,
  type IndexedAsk,
  type LiveMarket,
  type PostedOrder,
  type TrackedMarket,
} from "@app/predict/predict";
import { bestDirectAsk, deriveMarketOdds } from "@app/predict/odds";
import {
  HeroCard,
  MarketHeroFrame,
  NeonBuyButton,
  NeonSplitBar,
  NEON,
} from "@app/predict/ui";
import {
  OracleTrustBadge,
  ProposerTag,
  ResolutionTimeline,
  TrustPanel,
} from "@app/predict/trust";
import { blockEta, blocksToDuration } from "@app/predict/time";
import {
  fetchReferenceOdds,
  type ReferenceOdds,
} from "@app/predict/referenceOdds";

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
  refOdds,
}: {
  tracked: TrackedMarket;
  live: LiveMarket;
  busy: string;
  run: (label: string, fn: () => Promise<string>) => Promise<void>;
  book: { available: boolean; asks: IndexedAsk[] } | null;
  reloadBook: () => void;
  refOdds: ReferenceOdds | null;
}) {
  const toast = useToast();
  const positions = [
    ...live.myYes.map((u) => ({ u, side: "yes" as const })),
    ...live.myNo.map((u) => ({ u, side: "no" as const })),
  ];
  const [posIdx, setPosIdx] = useState("0");
  // Order prices are entered as a PROBABILITY in ¢ (1–99), not raw RXD — a share of `amount`
  // photons carries `amount` and pays 2·`amount` if it wins, so price = amount·(1+prob).
  const [sellCents, setSellCents] = useState("");
  // Optional upper price for a SLOPED ladder — rungs ramp from sellCents to sellToCents. Blank = flat.
  const [sellToCents, setSellToCents] = useState("");
  // Split the sell into N tranches so takers can buy partial amounts (1 = one order).
  const [sellRungs, setSellRungs] = useState("1");
  const [bidSide, setBidSide] = useState<"yes" | "no">("yes");
  const [bidAmountRxd, setBidAmountRxd] = useState("1");
  const [bidCents, setBidCents] = useState("");
  // Seed-liquidity panel (shown when the book is empty): mint sets + post YES/NO ladders.
  const [seedSetsRxd, setSeedSetsRxd] = useState("10");
  const [seedProbCents, setSeedProbCents] = useState("");
  const [seedSpreadCents, setSeedSpreadCents] = useState("3");
  const [seedStepCents, setSeedStepCents] = useState("2");
  const [seedRungs, setSeedRungs] = useState("3");
  // Prefill the seed probability from the reference market (Polymarket) when available.
  useEffect(() => {
    if (refOdds && seedProbCents === "") {
      setSeedProbCents(String(Math.round(refOdds.yesProb * 100)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refOdds]);
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
    const cents = Number(sellCents);
    const rungs = Math.max(1, Math.floor(Number(sellRungs) || 1));
    if (!pos) {
      toast({ title: "Pick a position to sell", status: "warning" });
      return;
    }
    if (!Number.isFinite(cents) || cents < 1 || cents > 99) {
      toast({
        title: "Enter a price from 1–99¢",
        description: "The price is the probability of this side — 60¢ = 60%.",
        status: "warning",
      });
      return;
    }
    const prob = cents / 100;
    const price = priceSatsForProb(pos.u.satoshis, prob);
    // A "to" price makes a SLOPED ladder (rungs ramp from `cents` to `toCents`); blank = flat.
    const toCents = Number(sellToCents);
    const sloped = sellToCents.trim() !== "" && toCents >= 1 && toCents <= 99;
    if (rungs > 1) {
      // Each tranche's shares must clear the 546-sat dust floor (its price always does, since
      // price = shares·(1+prob) ≥ shares).
      if (rungs > Math.floor(pos.u.satoshis / 546)) {
        toast({
          title: "Too many orders",
          description: "Each order needs ≥ 546 shares — reduce the split.",
          status: "warning",
        });
        return;
      }
      run(`Post ${rungs} orders`, async () => {
        const ladder = sloped
          ? slopedRungs(pos.u.satoshis, rampProbs(prob, toCents / 100, rungs))
          : rungsForProb(pos.u.satoshis, prob, rungs);
        const posted = await postLadderAction(tracked, pos.side, pos.u, ladder);
        return posted[0].adTxid;
      });
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
    const cents = Number(bidCents);
    if (!Number.isFinite(amount) || amount < 546) {
      toast({ title: "Enter a share amount ≥ 546 photons", status: "warning" });
      return;
    }
    if (!Number.isFinite(cents) || cents < 1 || cents > 99) {
      toast({ title: "Enter a bid price from 1–99¢", status: "warning" });
      return;
    }
    const total = priceSatsForProb(amount, cents / 100);
    run("Post bid", async () => {
      const posted = await postBidAction(tracked, bidSide, amount, total);
      return posted.adTxid;
    });
  };

  // Seed the empty book with two-sided liquidity so the market shows live odds and is chunk-buyable.
  const seed = () => {
    const sets = Math.round(parseFloat(seedSetsRxd) * 100_000_000);
    const probCents = Number(seedProbCents);
    const spreadCents = Number(seedSpreadCents);
    const rungs = Math.max(1, Math.floor(Number(seedRungs) || 1));
    if (!Number.isFinite(sets) || sets < 546 * rungs) {
      toast({
        title: "Provide more RXD",
        description: `Need at least ${rungs} × 546 photons of collateral for ${rungs} orders per side.`,
        status: "warning",
      });
      return;
    }
    if (!Number.isFinite(probCents) || probCents < 1 || probCents > 99) {
      toast({ title: "Enter a starting probability from 1–99¢", status: "warning" });
      return;
    }
    const stepCents = Number(seedStepCents);
    run(`Seed ${rungs * 2} orders`, async () => {
      const posted = await seedLiquidityAction(tracked, live, {
        sets,
        yesProb: probCents / 100,
        spread: (Number.isFinite(spreadCents) ? spreadCents : 0) / 100,
        step: (Number.isFinite(stepCents) ? Math.max(0, stepCents) : 0) / 100,
        rungs,
      });
      return posted[0].adTxid;
    });
  };

  const bookEmpty = !book?.asks?.length;

  return (
    <Box mb={6}>
      {live.state.status === Status.OPEN && bookEmpty && (
        <Box
          mb={5}
          p={4}
          borderRadius="lg"
          borderWidth="1px"
          borderColor="whiteAlpha.200"
          bg="whiteAlpha.50"
        >
          <Heading size="sm" mb={1}>
            Seed liquidity
          </Heading>
          <Text fontSize="sm" color="text.muted" mb={3}>
            This market has no orders yet, so it shows no odds. Provide some RXD as
            collateral and this posts YES + NO orders around a starting probability —
            the market goes live and others can trade partial amounts.
            {refOdds
              ? ` Prefilled from the Polymarket reference (${Math.round(
                  refOdds.yesProb * 100
                )}%).`
              : ""}
          </Text>
          <Flex gap={2} mb={2} wrap="wrap" align="center">
            <InputGroup maxW="40">
              <Input
                type="number"
                min={1}
                placeholder="10"
                value={seedSetsRxd}
                onChange={(e) => setSeedSetsRxd(e.target.value)}
              />
              <InputRightAddon>RXD</InputRightAddon>
            </InputGroup>
            <InputGroup maxW="36">
              <Input
                type="number"
                min={1}
                max={99}
                placeholder="prob"
                value={seedProbCents}
                onChange={(e) => setSeedProbCents(e.target.value)}
                title="Starting probability of YES — 60¢ means 60%"
              />
              <InputRightAddon>¢ YES</InputRightAddon>
            </InputGroup>
            <InputGroup maxW="32">
              <Input
                type="number"
                min={0}
                placeholder="3"
                value={seedSpreadCents}
                onChange={(e) => setSeedSpreadCents(e.target.value)}
                title="Edge to the best price either side of the starting probability"
              />
              <InputRightAddon>¢ spread</InputRightAddon>
            </InputGroup>
            <InputGroup maxW="28">
              <Input
                type="number"
                min={0}
                placeholder="2"
                value={seedStepCents}
                onChange={(e) => setSeedStepCents(e.target.value)}
                title="Price gap between rungs — 0 = flat, higher = deeper book"
              />
              <InputRightAddon>¢ step</InputRightAddon>
            </InputGroup>
            <InputGroup maxW="28">
              <Input
                type="number"
                min={1}
                placeholder="3"
                value={seedRungs}
                onChange={(e) => setSeedRungs(e.target.value)}
                title="Orders per side (more = buyers can take smaller chunks)"
              />
              <InputRightAddon>×2 orders</InputRightAddon>
            </InputGroup>
            <Button
              variant="primary"
              isLoading={busy.startsWith("Seed")}
              onClick={seed}
            >
              Seed market
            </Button>
          </Flex>
          <Text fontSize="xs" color="text.muted">
            Locks {seedSetsRxd || 0} RXD of collateral (reclaimable by merging unsold
            YES+NO). You keep the spread if both sides fill.
          </Text>
        </Box>
      )}

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
          <InputGroup maxW="40">
            <Input
              type="number"
              min={1}
              max={99}
              placeholder="price"
              value={sellCents}
              onChange={(e) => setSellCents(e.target.value)}
              title="The probability of this side — 60¢ means 60%"
            />
            <InputRightAddon>¢</InputRightAddon>
          </InputGroup>
          {Math.floor(Number(sellRungs) || 1) > 1 && (
            <InputGroup maxW="36">
              <Input
                type="number"
                min={1}
                max={99}
                placeholder="to"
                value={sellToCents}
                onChange={(e) => setSellToCents(e.target.value)}
                title="Optional: ramp the ladder up to this price for depth at several levels"
              />
              <InputRightAddon>¢</InputRightAddon>
            </InputGroup>
          )}
          <InputGroup maxW="32">
            <Input
              type="number"
              min={1}
              placeholder="1"
              value={sellRungs}
              onChange={(e) => setSellRungs(e.target.value)}
              title="Split into N orders so buyers can take partial amounts"
            />
            <InputRightAddon>orders</InputRightAddon>
          </InputGroup>
          <Button
            minW="28"
            isLoading={busy.startsWith("Post ") && busy.includes("order")}
            onClick={post}
          >
            {Math.floor(Number(sellRungs) || 1) > 1
              ? "Post ladder"
              : "Post sell order"}
          </Button>
        </Flex>
      )}
      {positions.length > 0 && live.state.status === Status.OPEN && (
        <Text fontSize="xs" color="text.muted" mt={-1} mb={3}>
          Price is this side's probability (60¢ = 60%).
          {(() => {
            const pos = positions[parseInt(posIdx, 10)];
            const c = Number(sellCents);
            if (!pos || !(c >= 1 && c <= 99)) return null;
            const rxd = priceSatsForProb(pos.u.satoshis, c / 100) / RXD;
            return ` You'd receive ≈ ${rxd.toLocaleString(undefined, {
              maximumFractionDigits: 4,
            })} RXD if fully filled.`;
          })()}
          {Math.floor(Number(sellRungs) || 1) > 1 &&
            (sellToCents.trim() !== ""
              ? ` Ramps ${Math.floor(Number(sellRungs))} orders from ${
                  sellCents || "?"
                }¢ to ${sellToCents}¢ for depth.`
              : ` Split into ${Math.floor(
                  Number(sellRungs)
                )} orders so buyers can take partial amounts.`)}
        </Text>
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
          <InputGroup maxW="36">
            <Input
              type="number"
              min={1}
              max={99}
              placeholder="price"
              value={bidCents}
              onChange={(e) => setBidCents(e.target.value)}
              title="The probability you're bidding — 60¢ means 60%"
            />
            <InputRightAddon>¢</InputRightAddon>
          </InputGroup>
          <Button minW="28" isLoading={busy === "Post bid"} onClick={postBid}>
            Post buy order
          </Button>
        </Flex>
      )}

      {myOrders.length > 0 && (
        <Box mb={4}>
          <Text fontSize="sm" color="text.muted" mb={1}>
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
        <Text fontSize="sm" color="text.muted">
          Order book (indexer)
        </Text>
        <Button size="xs" onClick={reloadBook}>
          Refresh
        </Button>
      </Flex>
      {live.state.status === Status.OPEN &&
        bookOdds &&
        bookOdds.mid !== null && (
          <Flex align="center" gap={2} my={1} color="text.muted" fontSize="xs">
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
        <Text fontSize="sm" color="text.muted" mb={4}>
          The connected indexer has no swap index — orders can still be filled
          from an advertisement txid below.
        </Text>
      ) : book.asks.length === 0 ? (
        <Text fontSize="sm" color="text.muted" mb={4}>
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

/** Kalshi-style buy panel: pick a side, see the best fillable order's cost, implied odds and BOTH
 *  outcomes, then one-click market-buy it. Shares are downside-protected — per the carrier model
 *  (math.js splitCost) a share of N carries N (its floor, always recoverable) and the winner
 *  additionally redeems N collateral → 2N, while the loser keeps N (NOT a total loss). Orders fill
 *  whole (atomic SINGLE|ACP), so this buys the single best order on that side; for a custom size,
 *  post a bid in the order book below. */
function BuyPanel({
  yesAsk,
  noAsk,
  busy,
  live,
  onBuy,
}: {
  yesAsk: IndexedAsk | null;
  noAsk: IndexedAsk | null;
  busy: string;
  live: LiveMarket | null;
  onBuy: (side: "yes" | "no", ask: IndexedAsk | null) => void;
}) {
  const [side, setSide] = useState<"yes" | "no">("yes");
  const ask = side === "yes" ? yesAsk : noAsk;
  const N = ask?.amount ?? 0;
  const P = ask?.priceSats ?? 0;
  const oddsLabel = ask ? pct(askProbability(P, N)) : "—";
  const SIDE = side.toUpperCase();

  const priceTab = (s: "yes" | "no", available: boolean) => {
    const active = side === s;
    const c = s === "yes" ? NEON.yes : NEON.no;
    const a = s === "yes" ? yesAsk : noAsk;
    const label = a ? pct(askProbability(a.priceSats, a.amount)) : "—";
    return (
      <Button
        flex="1"
        h="60px"
        variant="unstyled"
        onClick={() => setSide(s)}
        borderRadius="lg"
        border="1.5px solid"
        borderColor={active ? c : "whiteAlpha.200"}
        bg={
          active
            ? s === "yes"
              ? "rgba(43, 213, 138, 0.12)"
              : "rgba(242, 84, 122, 0.12)"
            : "transparent"
        }
        boxShadow={
          active
            ? `0 0 18px ${
                s === "yes" ? "rgba(70, 230, 160, 0.25)" : "rgba(255, 90, 120, 0.25)"
              }`
            : "none"
        }
        opacity={available ? 1 : 0.55}
        transition="all 0.15s ease"
        _hover={{ borderColor: c }}
      >
        <Flex direction="column" align="center" justify="center" h="full">
          <Text
            fontFamily="mono"
            fontWeight="bold"
            letterSpacing="0.1em"
            color={active ? c : "whiteAlpha.800"}
          >
            {s.toUpperCase()}
          </Text>
          <Text
            fontFamily="mono"
            fontSize="sm"
            color={active ? c : "whiteAlpha.500"}
          >
            {label}
          </Text>
        </Flex>
      </Button>
    );
  };

  const row = (label: string, value: ReactNode, sub?: ReactNode) => (
    <Flex justify="space-between" align="baseline" py={1.5}>
      <Text fontSize="sm" color="whiteAlpha.600">
        {label}
      </Text>
      <Flex align="baseline" gap={2} fontFamily="mono">
        {sub}
        <Text fontWeight="semibold" color="whiteAlpha.900">
          {value}
        </Text>
      </Flex>
    </Flex>
  );

  return (
    <HeroCard maxW="3xl" mb={6} px={{ base: 5, md: 6 }} py={{ base: 5, md: 6 }}>
      <Flex justify="space-between" align="center" mb={4}>
        <Heading size="sm" color="whiteAlpha.900">
          Buy shares
        </Heading>
        <Badge
          colorScheme="green"
          variant="subtle"
          borderRadius="full"
          px={2.5}
          fontFamily="mono"
        >
          No fees
        </Badge>
      </Flex>

      <Flex gap={3} mb={5}>
        {priceTab("yes", !!yesAsk)}
        {priceTab("no", !!noAsk)}
      </Flex>

      {ask ? (
        <>
          <Box borderTop="1px solid" borderColor="whiteAlpha.100" pt={2} mb={4}>
            {row("Implied odds", `${oddsLabel} chance`)}
            {row("You pay", <Photons value={P} />)}
            {row(
              `If ${SIDE} wins`,
              <Photons value={2 * N} />,
              <Text fontSize="sm" color={NEON.yes}>
                +<Photons value={2 * N - P} />
              </Text>
            )}
            {row(
              `If ${SIDE} loses`,
              <Photons value={N} />,
              <Text fontSize="sm" color={NEON.no}>
                −<Photons value={P - N} />
              </Text>
            )}
          </Box>

          <NeonBuyButton
            side={side}
            w="full"
            isLoading={busy === `Buy ${SIDE}`}
            isDisabled={!live}
            onClick={() => onBuy(side, ask)}
          >
            BUY {SIDE} · {oddsLabel}
          </NeonBuyButton>

          <Text fontSize="xs" color="whiteAlpha.400" mt={3} textAlign="center">
            Fills the best order (<Photons value={N} /> shares). A losing share
            keeps its <Photons value={N} /> floor — not a total loss. For a custom
            size, post a buy order below.
          </Text>
        </>
      ) : (
        <Text
          fontSize="sm"
          color="whiteAlpha.500"
          fontFamily="mono"
          py={5}
          textAlign="center"
        >
          No {SIDE} sell orders to fill yet — post a buy order below to bid at
          your price.
        </Text>
      )}
    </HeroCard>
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
  const [counterBond, setCounterBond] = useState(""); // photons; defaults to the proposer bond
  const [book, setBook] = useState<{
    available: boolean;
    asks: IndexedAsk[];
  } | null>(null);
  // Off-chain reference odds (creator-linked external market), shown only when the on-chain book
  // has no price. Best-effort — null when there's no reference or the fetch fails.
  const [refOdds, setRefOdds] = useState<ReferenceOdds | null>(null);

  useEffect(() => {
    setRefOdds(null);
    if (!tracked?.oddsRef) return;
    const ctrl = new AbortController();
    fetchReferenceOdds(tracked.oddsRef, ctrl.signal)
      .then((r) => setRefOdds(r))
      .catch(() => setRefOdds(null));
    return () => ctrl.abort();
  }, [tracked?.oddsRef]);

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
    // A legacy-covenant market is read-only — this build can't build spends against its older
    // covenant, so refuse every mutating action here rather than broadcasting a doomed tx.
    if (live?.legacyVersion) {
      toast({
        title: "Read-only market",
        description:
          "This market was created with an older RadiantSwap covenant and can't be traded in this build.",
        status: "warning",
      });
      return;
    }
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

  // Optimistic-oracle (MarketOpt) lifecycle flags.
  const optimistic = isOptimistic(tracked);
  const proposed = st === Status.PROPOSED_YES || st === Status.PROPOSED_NO;
  const proposedSide = st === Status.PROPOSED_YES ? "YES" : "NO";
  const disputed = optimistic && live ? isDisputed(live) : false;
  // HONESTY #4: the bond is fixed at creation, so a market grown past 8×bond can no longer be
  // proposed (the covenant rejects it) — disable propose + explain rather than build a doomed tx.
  const bondFloor = optimistic && live ? proposeBondFloor(live) : 0;
  const belowFloor =
    optimistic && live ? (tracked.optimistic?.bond ?? 0) < bondFloor : false;
  const canPropose =
    optimistic &&
    open &&
    live !== null &&
    live.height >= tracked.expiry &&
    !belowFloor;
  const challengeLeft =
    optimistic && proposed && live
      ? challengeBlocksRemaining(tracked, live)
      : 0;
  const canFinalize = proposed && challengeLeft === 0;
  // HONESTY #1: anyone may dispute a live proposal; after `liveness` blocks of an unresolved dispute,
  // anyone may time it out (refund both bonds, revert) so the bonds can't strand on a dead committee.
  const canDispute = optimistic && proposed && live !== null;
  const timeoutLeft =
    optimistic && disputed && live ? challengeBlocksRemaining(tracked, live) : 0;
  const canTimeout = disputed && timeoutLeft === 0;

  // Proposer identity for a live optimistic proposal (trust transparency): who put the outcome
  // up, and whether it's this wallet. walletPkh() throws on a locked/empty wallet → guard it.
  const proposerPkh = live?.state.optimistic?.proposerPkh ?? null;
  const disputerPkh = live?.state.optimistic?.disputerPkh ?? null;
  const pkhIsYou = (pkh: Uint8Array | Buffer | null): boolean => {
    if (!pkh) return false;
    try {
      return (
        Buffer.from(pkh).toString("hex") === walletPkh().toString("hex")
      );
    } catch {
      return false;
    }
  };
  const proposerIsYou = pkhIsYou(proposerPkh);
  const disputerIsYou = pkhIsYou(disputerPkh);

  return (
    <Box mx={{ base: 2, md: 4 }}>
      {live?.legacyVersion && (
        <Alert status="warning" mb={4} borderRadius="md">
          <AlertIcon />
          This market was created with an older RadiantSwap covenant. This build
          can read its state but can't build trades or resolutions against it, so
          it's shown read-only.
        </Alert>
      )}
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
            <NeonSplitBar yesPct={odds.yesProb * 100} />
          </>
        ) : refOdds ? (
          <Box>
            <Flex align="center" gap={2} mb={1.5} flexWrap="wrap">
              <Text
                fontFamily="mono"
                color={NEON.yes}
                fontWeight="bold"
                fontSize="lg"
              >
                {Math.round(refOdds.yesProb * 100)}%{" "}
                <Text as="span" fontSize="xs">
                  YES
                </Text>
              </Text>
              <Badge colorScheme="purple" variant="outline">
                Reference · Polymarket
              </Badge>
              {refOdds.closed && (
                <Badge colorScheme="orange" variant="subtle">
                  closed
                </Badge>
              )}
            </Flex>
            <NeonSplitBar yesPct={refOdds.yesProb * 100} />
            <Text
              fontSize="xs"
              color="whiteAlpha.500"
              fontFamily="mono"
              mt={1.5}
            >
              Off-chain reference from{" "}
              <Link
                href={refOdds.url}
                isExternal
                color="whiteAlpha.700"
                textDecoration="underline"
              >
                Polymarket
              </Link>{" "}
              — not the on-chain price.
              {open
                ? " Post or fill an order below to set the on-chain price."
                : ""}
            </Text>
          </Box>
        ) : (
          <Text fontSize="sm" color="whiteAlpha.500" fontFamily="mono">
            {open
              ? "No live odds yet — post or fill an order below to set the price."
              : "Market closed — see resolution below."}
          </Text>
        )}
      </MarketHeroFrame>

      {open && (
        <BuyPanel
          yesAsk={yesAsk}
          noAsk={noAsk}
          busy={busy}
          live={live}
          onBuy={buyBest}
        />
      )}

      <Flex align="center" gap={3} mb={5} flexWrap="wrap">
        <OracleTrustBadge t={tracked} pool={live?.market.satoshis} />
        <Text fontFamily="mono" fontSize="xs" color="text.muted">
          market {tracked.marketRef.substring(0, 16)}… · created{" "}
          {tracked.createTxid.substring(0, 8)}…
        </Text>
      </Flex>

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
                      : disputed
                      ? "orange"
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
              {open && live.height < tracked.expiry && (
                <Text fontSize="xs" color="whiteAlpha.500" fontFamily="mono">
                  expires {blockEta(live.height, tracked.expiry)}
                </Text>
              )}
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
              <Text fontSize="sm" color="text.muted" mb={2}>
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
            <Text fontSize="sm" color="text.muted" mb={6}>
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
            refOdds={refOdds}
          />

          <Heading size="sm" mb={2}>
            Resolution
          </Heading>

          {/* Plain-language trust + recourse: who can call the outcome, what it costs them to
              lie, and the trader's fallback if the resolver goes dark. */}
          <Box mb={4}>
            <TrustPanel t={tracked} live={live} />
          </Box>

          {/* Committee/oracle key inputs — needed to resolve a classic market, or to OVERRIDE a
              proposal on an optimistic one. Shown while the market is open or has a live proposal. */}
          {!soloOracle && (open || proposed || disputed) && (
            <Box mb={2} maxW="2xl">
              <Text fontSize="sm" color="text.muted" mb={1}>
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

          {/* Optimistic proposal status + challenge-window countdown + lifecycle timeline. */}
          {optimistic && proposed && live && tracked.optimistic && (
            <Box maxW="2xl" mb={3}>
              <ResolutionTimeline t={tracked} live={live} />
              <Alert
                status="info"
                mt={2}
                borderRadius="md"
                alignItems="flex-start"
              >
                <AlertIcon />
                <Box fontSize="sm">
                  <Text>
                    Proposed <b>{proposedSide}</b> — challenge window{" "}
                    {proposalConfirmations(live)}/{tracked.optimistic.liveness}{" "}
                    blocks.{" "}
                    {challengeLeft > 0
                      ? `${challengeLeft} block(s) (≈${blocksToDuration(
                          challengeLeft
                        )}) until anyone can finalize.`
                      : "Finalizable now."}
                  </Text>
                  {proposerPkh && (
                    <Text color="text.muted" mt={1}>
                      Proposed by{" "}
                      <ProposerTag pkh={proposerPkh} isYou={proposerIsYou} />
                    </Text>
                  )}
                  <Text color="text.muted" mt={1}>
                    Proposer bond <Photons value={tracked.optimistic.bond} /> is
                    repaid on finalize, or slashed if the committee overrides the
                    proposal. Anyone may <b>dispute</b> it by locking a counter-bond.
                  </Text>
                </Box>
              </Alert>
            </Box>
          )}

          {/* Optimistic DISPUTED: escalation pending + dead-committee timeout countdown. */}
          {optimistic && disputed && live && tracked.optimistic && (
            <Box maxW="2xl" mb={3}>
              <ResolutionTimeline t={tracked} live={live} />
              <Alert
                status="warning"
                mt={2}
                borderRadius="md"
                alignItems="flex-start"
              >
                <AlertIcon />
                <Box fontSize="sm">
                  <Text>
                    <b>Disputed</b> — both bonds (proposer{" "}
                    <Photons value={tracked.optimistic.bond} /> + counter-bond{" "}
                    <Photons value={live.state.optimistic?.counterBond ?? 0} />)
                    are escrowed. The committee escalates to the true outcome and
                    the winner takes the whole pot; the loser forfeits their bond.
                  </Text>
                  {live.state.optimistic?.disputerPkh && (
                    <Text color="text.muted" mt={1}>
                      Disputed by{" "}
                      <ProposerTag
                        pkh={live.state.optimistic.disputerPkh}
                        isYou={disputerIsYou}
                      />
                    </Text>
                  )}
                  <Text color="text.muted" mt={1}>
                    {timeoutLeft > 0
                      ? `If the committee never acts, anyone may refund both bonds and revert in ${timeoutLeft} block(s) (≈${blocksToDuration(
                          timeoutLeft
                        )}).`
                      : "The committee did not escalate within the window — anyone may now time the dispute out (refund both bonds, revert)."}
                  </Text>
                </Box>
              </Alert>
            </Box>
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
                    : `Finalize (≈${blocksToDuration(challengeLeft)})`}
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
                {/* HONESTY #1: anyone may dispute a wrong proposal by locking a counter-bond
                    (≥ the proposer bond), forcing committee escalation. Wins both bonds if upheld. */}
                <Input
                  size="sm"
                  maxW="44"
                  fontFamily="mono"
                  placeholder={`counter-bond ≥ ${tracked.optimistic?.bond ?? 0}`}
                  value={counterBond}
                  onChange={(e) => setCounterBond(e.target.value)}
                />
                <Button
                  size="sm"
                  colorScheme="orange"
                  isLoading={busy === "Dispute"}
                  isDisabled={!canDispute}
                  onClick={() =>
                    run("Dispute", () =>
                      disputeAction(
                        tracked,
                        live,
                        parseInt(
                          counterBond ||
                            String(tracked.optimistic?.bond ?? 0),
                          10
                        )
                      )
                    )
                  }
                >
                  Dispute → {proposedSide === "YES" ? "NO" : "YES"}
                </Button>
              </>
            )}

            {/* Optimistic DISPUTED: the committee escalates via resolve (winner takes both bonds); if
                the committee never acts, anyone times the dispute out after liveness (refund + revert). */}
            {optimistic && disputed && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  colorScheme="green"
                  isLoading={busy === "Escalate YES"}
                  onClick={() =>
                    run("Escalate YES", () =>
                      resolveAction(
                        tracked,
                        live,
                        Status.RESOLVED_YES,
                        committeeInput()
                      )
                    )
                  }
                >
                  Escalate → YES
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  colorScheme="red"
                  isLoading={busy === "Escalate NO"}
                  onClick={() =>
                    run("Escalate NO", () =>
                      resolveAction(
                        tracked,
                        live,
                        Status.RESOLVED_NO,
                        committeeInput()
                      )
                    )
                  }
                >
                  Escalate → NO
                </Button>
                <Button
                  size="sm"
                  colorScheme="orange"
                  isLoading={busy === "Timeout"}
                  isDisabled={!canTimeout}
                  onClick={() =>
                    run("Timeout", () => disputeTimeoutAction(tracked, live))
                  }
                >
                  {canTimeout
                    ? "Time out (refund both bonds)"
                    : `Time out (≈${blocksToDuration(timeoutLeft)})`}
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
                  Revert
                  {!canRevert &&
                    ` (at ${revertibleAt.toLocaleString()} · ${blockEta(
                      live.height,
                      revertibleAt
                    )})`}
                </Button>
              </>
            )}
            {!open && !proposed && !disputed && (
              <Text fontSize="sm" color="text.muted">
                Final.
              </Text>
            )}
          </HStack>

          {optimistic && open && live && live.height < tracked.expiry && (
            <Text fontSize="xs" color="text.muted" maxW="2xl" mb={1}>
              Proposals open at block {tracked.expiry.toLocaleString()} (current{" "}
              {live.height.toLocaleString()} · {blockEta(live.height, tracked.expiry)}
              ).
            </Text>
          )}
          {optimistic && open && live && live.height >= tracked.expiry && belowFloor && (
            <Text fontSize="xs" color="orange.300" maxW="2xl" mb={1}>
              This market grew past its proposer bond (
              <Photons value={tracked.optimistic?.bond ?? 0} /> &lt; required{" "}
              <Photons value={bondFloor} /> = pool/8), so the optimistic fast-path is closed — it can
              only be resolved by the committee or reverted after expiry + grace.
            </Text>
          )}
          <Text fontSize="xs" color="text.muted" maxW="2xl">
            {optimistic
              ? "Optimistic market: after expiry anyone proposes the outcome by locking a bond (≥ pool/8); if unchallenged, anyone finalizes after the window and the bond returns. ANYONE may dispute a wrong proposal by locking a counter-bond — that escalates to the committee, and the winner takes both bonds. If the committee never escalates, anyone times the dispute out after the window (both bonds refunded, market reverts). "
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
