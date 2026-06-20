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
  Input,
  InputGroup,
  InputRightAddon,
  Select,
  Spinner,
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
import { CAT_OPEN, CAT_REVERTED, type Utxo } from "radiantswap";
import Photons from "@app/components/Photons";
import { MarketHeroFrame, OutcomeChips } from "@app/predict/ui";
import { OracleTrustBadge, TrustPanel } from "@app/predict/trust";
import {
  catStatusLabel,
  fetchLiveCatMarket,
  listTracked,
  marketKind,
  mergeCatAction,
  redeemCatAction,
  resolveCatAction,
  resolveScalarAction,
  revertCatAction,
  splitCatAction,
  walletIsCatSoloOracle,
  type LiveCatMarket,
  type TrackedMarket,
} from "@app/predict/predict";

const RXD = 100_000_000;

/** Greedily pair one equal-value share from EVERY outcome into mergeable complete sets. */
function completeCatSets(myShares: Utxo[][]): Utxo[][] {
  if (myShares.length === 0) return [];
  const pools = myShares.map((s) => [...s]);
  const sets: Utxo[][] = [];
  for (const u0 of [...pools[0]]) {
    const picked: Utxo[] = [u0];
    let ok = true;
    for (let i = 1; i < pools.length; i++) {
      const j = pools[i].findIndex((x) => x.satoshis === u0.satoshis);
      if (j < 0) {
        ok = false;
        break;
      }
      picked.push(pools[i][j]);
    }
    if (ok) {
      for (let i = 1; i < pools.length; i++) {
        const j = pools[i].findIndex((x) => x.satoshis === u0.satoshis);
        pools[i].splice(j, 1);
      }
      const j0 = pools[0].findIndex((x) => x === u0);
      if (j0 >= 0) pools[0].splice(j0, 1);
      sets.push(picked);
    }
  }
  return sets;
}

export default function PredictCatMarket() {
  const { createTxid } = useParams<{ createTxid: string }>();
  const toast = useToast();
  const [tracked, setTracked] = useState<TrackedMarket | null>(null);
  const [live, setLive] = useState<LiveCatMarket | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [splitRxd, setSplitRxd] = useState("1");
  const [resolveOutcome, setResolveOutcome] = useState("1");
  const [scalarValue, setScalarValue] = useState("");

  useEffect(() => {
    listTracked().then((rows) => {
      const t = rows.find((r) => r.createTxid === createTxid) || null;
      setTracked(t);
      if (!t) setError("Market not tracked by this wallet");
    });
  }, [createTxid]);

  const refresh = useCallback(async () => {
    if (!tracked) return;
    setError("");
    try {
      setLive(await fetchLiveCatMarket(tracked));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tracked]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const sets = useMemo(
    () => (live ? completeCatSets(live.myShares) : []),
    [live]
  );
  const soloOracle = useMemo(
    () => (tracked ? walletIsCatSoloOracle(tracked) : false),
    [tracked]
  );
  const isScalar = tracked ? marketKind(tracked) === "scalar" : false;

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      const txid = await fn();
      toast({
        title: `${label} broadcast`,
        description: txid,
        status: "success",
      });
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

  const labels = tracked.outcomeLabels || [];
  const st = live?.state.status;
  const open = st === CAT_OPEN;
  const reverted = st === CAT_REVERTED;
  const resolvedOutcome =
    st !== undefined && st >= 1 && st <= (live?.outcomes ?? 0) ? st : 0; // 1-based, 0 = not resolved
  const revertibleAt = tracked.expiry + tracked.grace;
  const canRevert = open && live !== null && live.height >= revertibleAt;

  return (
    <Box mx={{ base: 2, md: 4 }}>
      <MarketHeroFrame question={tracked.question} headerMb={4} mb={4}>
        <Text
          fontSize="xs"
          fontFamily="mono"
          letterSpacing="0.1em"
          textTransform="uppercase"
          color="whiteAlpha.500"
          mb={4}
        >
          {marketKind(tracked) === "scalar" ? "Scalar" : "Categorical"} ·{" "}
          {tracked.outcomeRefs?.length ?? 0} outcomes
          {resolvedOutcome > 0 && labels[resolvedOutcome - 1]
            ? ` · resolved ${labels[resolvedOutcome - 1]}`
            : ""}
        </Text>
        {labels.length > 0 ? (
          <OutcomeChips labels={labels} winner={resolvedOutcome} />
        ) : (
          <Text fontSize="sm" color="whiteAlpha.500" fontFamily="mono">
            {tracked.outcomeRefs?.length ?? 0} outcomes
          </Text>
        )}
      </MarketHeroFrame>

      <Flex align="center" gap={3} mb={4} flexWrap="wrap">
        <OracleTrustBadge t={tracked} />
        <Text fontFamily="mono" fontSize="xs" color="text.muted">
          market {tracked.marketRef.substring(0, 16)}… · created{" "}
          {tracked.createTxid.substring(0, 8)}…
        </Text>
      </Flex>

      <Alert status="warning" mb={4} borderRadius="md" maxW="3xl">
        <AlertIcon />
        Advanced market type — mint, settle, redeem and merge are supported
        here, but there is no peer-to-peer order book or market discovery for it
        yet (only binary markets are fully tradeable and discoverable).
      </Alert>

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
                  colorScheme={open ? "blue" : reverted ? "orange" : "green"}
                >
                  {catStatusLabel(tracked, live.state.status)}
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

          {/* Plain-language trust + recourse (committee/solo only — categorical/scalar markets carry
              no optimistic terms). Terminal state is passed explicitly since the status enum and the
              winning outcome aren't binary YES/NO. */}
          <Box mb={6}>
            <TrustPanel
              t={tracked}
              height={live.height}
              terminal={
                open
                  ? undefined
                  : {
                      reverted,
                      label:
                        resolvedOutcome > 0
                          ? labels[resolvedOutcome - 1] ||
                            `outcome ${resolvedOutcome}`
                          : undefined,
                    }
              }
            />
          </Box>

          {open && (
            <Box mb={6}>
              <Heading size="sm" mb={2}>
                Mint complete sets
              </Heading>
              <Text fontSize="sm" color="text.muted" mb={2}>
                Lock N RXD to mint N of every outcome. A complete set (one share
                of each outcome) can always be merged back for the collateral —
                only holding a non-winning outcome at resolution loses value.
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
                    run("Split", () => splitCatAction(tracked, live, n));
                  }}
                >
                  Split
                </Button>
              </Flex>
            </Box>
          )}

          <Heading size="sm" mb={2}>
            My positions by outcome
          </Heading>
          {live.myShares.every((s) => s.length === 0) ? (
            <Text fontSize="sm" color="text.muted" mb={6}>
              None.
            </Text>
          ) : (
            <Table size="sm" maxW="3xl" mb={4}>
              <Thead>
                <Tr>
                  <Th>Outcome</Th>
                  <Th>UTXO</Th>
                  <Th textAlign="right">Amount</Th>
                  <Th width="120px" />
                </Tr>
              </Thead>
              <Tbody fontFamily="mono">
                {live.myShares.flatMap((shares, oi) =>
                  shares.map((u) => (
                    <Tr key={`${oi}-${u.txid}-${u.vout}`}>
                      <Td>
                        <Badge
                          colorScheme={
                            resolvedOutcome === oi + 1 ? "green" : "gray"
                          }
                        >
                          {labels[oi] || `outcome ${oi + 1}`}
                        </Badge>
                      </Td>
                      <Td>
                        {u.txid.substring(0, 8)}…:{u.vout}
                      </Td>
                      <Td textAlign="right">
                        <Photons value={u.satoshis} />
                      </Td>
                      <Td>
                        {resolvedOutcome === oi + 1 && (
                          <Button
                            size="xs"
                            isLoading={busy === "Redeem"}
                            onClick={() =>
                              run("Redeem", () =>
                                redeemCatAction(tracked, live, u)
                              )
                            }
                          >
                            Redeem 1:1
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))
                )}
              </Tbody>
            </Table>
          )}

          {sets.length > 0 && (
            <Box mb={6}>
              <Text fontSize="sm" color="text.muted" mb={2}>
                {sets.length} complete set{sets.length > 1 ? "s" : ""} mergeable
                back to RXD:
              </Text>
              {sets.map((set, i) => (
                <Flex key={i} align="center" gap={3} mb={1}>
                  <Photons value={set[0].satoshis} />
                  <Text fontSize="sm" color="text.muted">
                    × {set.length} outcomes
                  </Text>
                  <Button
                    size="xs"
                    isLoading={busy === "Merge"}
                    onClick={() =>
                      run("Merge", () => mergeCatAction(tracked, live, set))
                    }
                  >
                    Merge → RXD
                  </Button>
                </Flex>
              ))}
            </Box>
          )}

          {/* resolution */}
          {open && soloOracle && (
            <Box mb={6}>
              <Heading size="sm" mb={2}>
                Resolve (you are the oracle)
              </Heading>
              {isScalar ? (
                <Flex gap={2} maxW="md" align="center">
                  <InputGroup maxW="48">
                    <Input
                      placeholder="observed value"
                      value={scalarValue}
                      onChange={(e) => setScalarValue(e.target.value)}
                    />
                    {tracked.scalar?.unit && (
                      <InputRightAddon>{tracked.scalar.unit}</InputRightAddon>
                    )}
                  </InputGroup>
                  <Button
                    isLoading={busy === "Resolve"}
                    onClick={() => {
                      const v = parseFloat(scalarValue);
                      if (!Number.isFinite(v)) {
                        toast({
                          title: "Enter a numeric value",
                          status: "warning",
                        });
                        return;
                      }
                      run("Resolve", () =>
                        resolveScalarAction(tracked, live, v)
                      );
                    }}
                  >
                    Resolve to bucket
                  </Button>
                </Flex>
              ) : (
                <Flex gap={2} maxW="md" align="center">
                  <Select
                    maxW="xs"
                    value={resolveOutcome}
                    onChange={(e) => setResolveOutcome(e.target.value)}
                  >
                    {labels.map((l, i) => (
                      <option key={i} value={i + 1}>
                        {l}
                      </option>
                    ))}
                  </Select>
                  <Button
                    isLoading={busy === "Resolve"}
                    onClick={() =>
                      run("Resolve", () =>
                        resolveCatAction(
                          tracked,
                          live,
                          parseInt(resolveOutcome, 10)
                        )
                      )
                    }
                  >
                    Resolve
                  </Button>
                </Flex>
              )}
            </Box>
          )}
          {open && !soloOracle && (
            <Alert status="info" mb={6} borderRadius="md" maxW="2xl">
              <AlertIcon />
              This market resolves via a committee — in-wallet resolution
              currently supports solo-operator markets only.
            </Alert>
          )}

          {/* safety hatch */}
          {open && (
            <Button
              variant="outline"
              isDisabled={!canRevert}
              isLoading={busy === "Revert"}
              onClick={() =>
                run("Revert", () => revertCatAction(tracked, live))
              }
            >
              {canRevert
                ? "Revert (reclaim via merge)"
                : `Revertible at height ${revertibleAt.toLocaleString()}`}
            </Button>
          )}
        </>
      )}
    </Box>
  );
}
