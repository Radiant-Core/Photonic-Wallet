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
import { Status, type Utxo } from "radiantswap";
import Photons from "@app/components/Photons";
import {
  fetchLiveMarket,
  listTracked,
  mergeAction,
  redeemAction,
  resolveAction,
  revertAction,
  splitAction,
  statusLabel,
  type LiveMarket,
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

export default function PredictMarket() {
  const { createTxid } = useParams<{ createTxid: string }>();
  const toast = useToast();
  const [tracked, setTracked] = useState<TrackedMarket | null>(null);
  const [live, setLive] = useState<LiveMarket | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [splitRxd, setSplitRxd] = useState("1");

  useEffect(() => {
    listTracked().then((rows) => {
      const t = rows.find((r) => r.createTxid === createTxid) || null;
      setTracked(t);
      if (!t) setError("Market not tracked — import it from the Markets page");
    });
  }, [createTxid]);

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

          <Heading size="sm" mb={2}>
            Resolution
          </Heading>
          <HStack wrap="wrap" mb={2}>
            {open && (
              <>
                <Button
                  size="sm"
                  colorScheme="green"
                  isLoading={busy === "Resolve YES"}
                  onClick={() =>
                    run("Resolve YES", () =>
                      resolveAction(tracked, live, Status.RESOLVED_YES)
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
                      resolveAction(tracked, live, Status.RESOLVED_NO)
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
            Resolving requires this wallet to hold the market's oracle key
            (1-of-1 operator markets). Revert is permissionless once the chain
            passes expiry + grace, and leaves every complete set reclaimable
            via merge.
          </Text>

          <Button size="sm" mt={6} onClick={refresh}>
            Refresh
          </Button>
        </>
      )}
    </Box>
  );
}
