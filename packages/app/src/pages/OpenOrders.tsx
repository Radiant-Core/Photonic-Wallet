/**
 * Open Orders page - Browse and accept broadcast swap offers
 */
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Container,
  Flex,
  Heading,
  Icon,
  Image,
  Input,
  InputGroup,
  InputLeftElement,
  Skeleton,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useToast,
  VStack,
  HStack,
  Badge,
} from "@chakra-ui/react";
import { SearchIcon } from "@chakra-ui/icons";
import { MdOutlineSwapHoriz, MdRefresh } from "react-icons/md";
import { useCallback, useEffect, useState } from "react";
import Card from "@app/components/Card";
import TokenContent from "@app/components/TokenContent";
import { SmartToken, ContractType, SmartTokenType } from "@app/types";
import db from "@app/db";
import opfs from "@app/opfs";
import {
  SwapOffer,
  getOpenOrders,
  getOpenOrdersByWant,
  parsePriceTerms,
  isSwapIndexAvailable,
  getSwapRpcConfig,
  setSwapRpcConfig,
} from "@app/swapBroadcast";
import { useLiveQuery } from "dexie-react-hooks";
import { wallet, openModal, feeRate } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import { reverseRef } from "@lib/Outpoint";
import { ftScript, nftScript, p2pkhScript } from "@lib/script";
import { fundTx, SelectableInput } from "@lib/coinSelect";
import { buildTx } from "@lib/tx";
import rxdIcon from "/rxd.png";
import { t } from "@lingui/macro";
import dayjs from "dayjs";
import Outpoint from "@lib/Outpoint";
import { decodeGlyph } from "@lib/token";
import { Transaction } from "@radiant-core/radiantjs";

type RoyaltySplit = { address: string; bps: number };

function parseRoyalty(payload: unknown): {
  enforced: boolean;
  bps: number;
  address: string;
  minimum: number;
  maximum: number | null;
  splits: RoyaltySplit[];
} | null {
  if (!payload || typeof payload !== "object") return null;
  const royalty = (payload as { royalty?: unknown }).royalty;
  if (!royalty || typeof royalty !== "object") return null;

  const r = royalty as {
    enforced?: unknown;
    bps?: unknown;
    address?: unknown;
    minimum?: unknown;
    maximum?: unknown;
    splits?: unknown;
  };

  const enforced = r.enforced === true;
  const bps = typeof r.bps === "number" ? r.bps : NaN;
  const address = typeof r.address === "string" ? r.address : "";
  const minimum = typeof r.minimum === "number" ? r.minimum : 0;
  const maximum = typeof r.maximum === "number" ? r.maximum : null;

  const splits: RoyaltySplit[] = Array.isArray(r.splits)
    ? (r.splits
        .map((s) => {
          if (!s || typeof s !== "object") return null;
          const so = s as { address?: unknown; bps?: unknown };
          const a = typeof so.address === "string" ? so.address : "";
          const b = typeof so.bps === "number" ? so.bps : NaN;
          if (!a || !Number.isFinite(b)) return null;
          return { address: a, bps: b };
        })
        .filter(Boolean) as RoyaltySplit[])
    : [];

  if (!Number.isFinite(bps) || bps <= 0 || bps > 10000) return null;
  if (!address) return null;

  return { enforced, bps, address, minimum, maximum, splits };
}

function computeRoyaltyAmount(
  salePrice: number,
  bps: number,
  minimum: number,
  maximum: number | null
): number {
  const raw = Math.floor((salePrice * bps) / 10000);
  let clamped = Math.max(raw, minimum);
  if (maximum !== null) clamped = Math.min(clamped, maximum);
  return clamped;
}

async function getOfferedTokenRoyalty(
  offeredGlyph: SmartToken
): Promise<ReturnType<typeof parseRoyalty> | null> {
  if (!offeredGlyph.revealOutpoint) return null;
  try {
    const reveal = Outpoint.fromString(offeredGlyph.revealOutpoint);
    const txid = reveal.getTxid();
    let hex = await opfs.getTx(txid);
    if (!hex) {
      hex = await electrumWorker.value.getTransaction(txid);
      if (hex) {
        await opfs.putTx(txid, hex);
      }
    }
    if (!hex) return null;
    const tx = new Transaction(hex);
    const input = tx.inputs[reveal.getVout()];
    if (!input?.script) return null;
    const decoded = decodeGlyph(input.script);
    if (!decoded) return null;
    return parseRoyalty(decoded.payload);
  } catch {
    return null;
  }
}

interface ParsedOrder {
  offer: SwapOffer;
  offeredGlyph?: SmartToken;
  wantGlyph?: SmartToken;
  wantValue?: number;
  wantScript?: string;
}

function TokenIcon({ glyph }: { glyph?: SmartToken }) {
  if (!glyph) {
    return <Image src={rxdIcon} width={6} height={6} />;
  }
  return (
    <Box w={6} h={6}>
      <TokenContent glyph={glyph} thumbnail />
    </Box>
  );
}

function OrderRow({
  order,
  onAccept,
}: {
  order: ParsedOrder;
  onAccept: (order: ParsedOrder) => void;
}) {
  const { offer, offeredGlyph, wantGlyph, wantValue } = order;

  return (
    <Tr>
      <Td>
        <Flex gap={2} alignItems="center">
          <TokenIcon glyph={offeredGlyph} />
          <Icon as={MdOutlineSwapHoriz} boxSize={4} color="gray.400" />
          <TokenIcon glyph={wantGlyph} />
        </Flex>
      </Td>
      <Td>
        <VStack align="start" spacing={0}>
          <Text fontSize="sm" fontWeight="medium">
            {offeredGlyph?.name || "RXD"}
          </Text>
          <Text fontSize="xs" color="gray.500">
            {offeredGlyph?.ticker || ""}
          </Text>
        </VStack>
      </Td>
      <Td>
        <VStack align="start" spacing={0}>
          <Text fontSize="sm" fontWeight="medium">
            {wantGlyph?.name || "RXD"}
          </Text>
          {wantValue && !wantGlyph && (
            <Text fontSize="xs" color="gray.500">
              {(wantValue / 100000000).toFixed(8)} RXD
            </Text>
          )}
        </VStack>
      </Td>
      <Td display={{ base: "none", md: "table-cell" }}>
        <Text fontSize="xs" color="gray.500">
          Block {offer.block_height}
        </Text>
      </Td>
      <Td>
        <Button size="sm" colorScheme="blue" onClick={() => onAccept(order)}>
          {t`Accept`}
        </Button>
      </Td>
    </Tr>
  );
}

export default function OpenOrders() {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [orders, setOrders] = useState<ParsedOrder[]>([]);
  const [searchRef, setSearchRef] = useState("");
  const [indexAvailable, setIndexAvailable] = useState<boolean | null>(null);
  const [rpcUrl, setRpcUrl] = useState(getSwapRpcConfig().url);
  const [showConfig, setShowConfig] = useState(false);

  // Get all known glyphs for display
  const glyphs = useLiveQuery(() => db.glyph.toArray(), []);
  const glyphMap = new Map(glyphs?.map((g) => [g.ref, g]) || []);

  const checkIndexAvailability = useCallback(async () => {
    const available = await isSwapIndexAvailable();
    setIndexAvailable(available);
    return available;
  }, []);

  const fetchOrders = useCallback(
    async (tokenRef?: string) => {
      setLoading(true);
      try {
        let rawOrders: SwapOffer[] = [];

        if (tokenRef) {
          // Search by specific token
          const [byOffered, byWant] = await Promise.all([
            getOpenOrders(tokenRef, 50).catch(() => []),
            getOpenOrdersByWant(tokenRef, 50).catch(() => []),
          ]);
          rawOrders = [...byOffered, ...byWant];
        } else {
          // Get orders for all tokens the user owns
          const userGlyphs = glyphs?.filter((g) => g.spent === 0) || [];
          const allOrders: SwapOffer[] = [];

          for (const glyph of userGlyphs.slice(0, 10)) {
            // Limit to first 10 tokens
            try {
              const wantOrders = await getOpenOrdersByWant(glyph.ref, 20);
              allOrders.push(...wantOrders);
            } catch {
              // Ignore errors for individual tokens
            }
          }
          rawOrders = allOrders;
        }

        // Parse and enrich orders
        const parsed: ParsedOrder[] = rawOrders.map((offer) => {
          const terms = parsePriceTerms(offer.price_terms);
          return {
            offer,
            offeredGlyph: glyphMap.get(offer.tokenid),
            wantGlyph: offer.want_tokenid
              ? glyphMap.get(offer.want_tokenid)
              : undefined,
            wantValue: terms?.value,
            wantScript: terms?.script,
          };
        });

        // Remove duplicates
        const uniqueOrders = parsed.filter(
          (order, index, self) =>
            index ===
            self.findIndex(
              (o) =>
                o.offer.utxo.txid === order.offer.utxo.txid &&
                o.offer.utxo.vout === order.offer.utxo.vout
            )
        );

        setOrders(uniqueOrders);
      } catch (error) {
        console.error("Failed to fetch orders:", error);
        toast({
          status: "error",
          title: "Failed to fetch open orders",
          description:
            error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setLoading(false);
      }
    },
    [glyphs, glyphMap, toast]
  );

  useEffect(() => {
    checkIndexAvailability().then((available) => {
      if (available) {
        fetchOrders();
      }
    });
  }, [checkIndexAvailability, fetchOrders]);

  const handleSearch = () => {
    if (searchRef.trim()) {
      fetchOrders(searchRef.trim());
    } else {
      fetchOrders();
    }
  };

  const handleAcceptOrder = async (order: ParsedOrder) => {
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock" };
      return;
    }

    try {
      // Fetch the PSRT from the offered UTXO
      const rawTx = await electrumWorker.value.getTransaction(
        order.offer.utxo.txid
      );
      if (!rawTx) {
        throw new Error("Could not fetch transaction");
      }

      // Build the completing transaction
      const coins: SelectableInput[] = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      // Determine what we need to provide
      const wantGlyph = order.wantGlyph;
      let myInputs: SelectableInput[] = [];

      if (wantGlyph) {
        // They want a token from us
        const refLE = reverseRef(wantGlyph.ref);
        const script =
          wantGlyph.tokenType === SmartTokenType.FT
            ? ftScript(wallet.value.address, refLE)
            : nftScript(wallet.value.address, refLE);

        const utxos = await db.txo
          .where({ script, spent: 0 })
          .toArray();

        if (utxos.length === 0) {
          throw new Error("You don't have the required token");
        }

        myInputs = utxos.map((u) => ({
          ...u,
          required: true,
        }));
      }

      // Build outputs - what we receive + what they receive
      const outputs = [];

      // What we receive (the offered asset)
      if (order.offeredGlyph) {
        const refLE = reverseRef(order.offeredGlyph.ref);
        const receiveScript =
          order.offeredGlyph.tokenType === SmartTokenType.FT
            ? ftScript(wallet.value.address, refLE)
            : nftScript(wallet.value.address, refLE);
        outputs.push({
          script: receiveScript,
          value: 1, // NFT or token dust
        });
      } else {
        // RXD output for us
        outputs.push({
          script: p2pkhScript(wallet.value.address),
          value: order.wantValue || 0,
        });
      }

      // What they receive (from price_terms)
      if (order.wantScript && order.wantValue) {
        outputs.push({
          script: order.wantScript,
          value: order.wantValue,
        });
      }

      // Enforced royalties (REP-3012): only apply to RXD-priced NFT sales.
      // Canonical ordering: vout0 = NFT to buyer, vout1 = seller payment, vout2..N = royalty outputs, change after.
      if (
        order.offeredGlyph &&
        order.offeredGlyph.tokenType === SmartTokenType.NFT &&
        !order.wantGlyph &&
        order.wantValue &&
        order.wantValue > 0 &&
        outputs.length >= 2
      ) {
        const royalty = await getOfferedTokenRoyalty(order.offeredGlyph);
        if (royalty?.enforced) {
          const salePrice = order.wantValue;
          const totalRoyalty = computeRoyaltyAmount(
            salePrice,
            royalty.bps,
            royalty.minimum,
            royalty.maximum
          );

          if (totalRoyalty > 0) {
            const royaltyOutputs: { script: string; value: number }[] = [];

            if (royalty.splits.length > 0) {
              // Allocate split amounts deterministically. Last split receives remainder.
              let remaining = totalRoyalty;
              for (let i = 0; i < royalty.splits.length; i++) {
                const split = royalty.splits[i];
                const isLast = i === royalty.splits.length - 1;
                const amt = isLast
                  ? remaining
                  : Math.floor((totalRoyalty * split.bps) / royalty.bps);
                remaining -= amt;
                if (amt > 0) {
                  const script = p2pkhScript(split.address);
                  if (!script) {
                    throw new Error("Invalid royalty split address");
                  }
                  royaltyOutputs.push({
                    script,
                    value: amt,
                  });
                }
              }
            } else {
              const script = p2pkhScript(royalty.address);
              if (!script) {
                throw new Error("Invalid royalty address");
              }
              royaltyOutputs.push({
                script,
                value: totalRoyalty,
              });
            }

            // Insert royalties immediately after seller payment output.
            if (royaltyOutputs.length > 0) {
              outputs.splice(2, 0, ...royaltyOutputs);
            }
          }
        }
      }

      const changeScript = p2pkhScript(wallet.value.address);
      const fund = fundTx(
        wallet.value.address,
        coins,
        [...myInputs],
        outputs,
        changeScript,
        feeRate.value
      );

      if (!fund.funded) {
        throw new Error("Insufficient funds to complete swap");
      }

      const allInputs = [...myInputs, ...fund.funding];
      const allOutputs = [...outputs, ...fund.change];

      // Build and sign our portion
      const tx = buildTx(
        wallet.value.address,
        wallet.value.wif,
        allInputs,
        allOutputs,
        false
      );

      // Broadcast the completed transaction
      const txid = await electrumWorker.value.broadcast(tx.toString());

      toast({
        status: "success",
        title: "Swap accepted!",
        description: `Transaction: ${txid.substring(0, 16)}...`,
      });

      // Refresh orders
      fetchOrders();
    } catch (error) {
      console.error("Failed to accept order:", error);
      toast({
        status: "error",
        title: "Failed to accept swap",
        description:
          error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  const handleSaveConfig = () => {
    setSwapRpcConfig({ url: rpcUrl });
    setShowConfig(false);
    checkIndexAvailability().then((available) => {
      if (available) {
        fetchOrders();
      }
    });
  };

  if (indexAvailable === false) {
    return (
      <Container maxW="container.lg" px={4}>
        <Card p={8}>
          <VStack spacing={4}>
            <Alert status="warning">
              <AlertIcon />
              Swap index not available. Connect to a Radiant Core node with
              -swapindex=1 enabled.
            </Alert>
            <HStack>
              <Input
                placeholder="RPC URL (e.g., http://127.0.0.1:7332)"
                value={rpcUrl}
                onChange={(e) => setRpcUrl(e.target.value)}
                width="300px"
              />
              <Button onClick={handleSaveConfig}>Connect</Button>
            </HStack>
          </VStack>
        </Card>
      </Container>
    );
  }

  return (
    <Container maxW="container.lg" px={4}>
      <VStack spacing={6} align="stretch">
        <Flex justify="space-between" align="center">
          <Heading size="lg">{t`Open Orders`}</Heading>
          <HStack>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowConfig(!showConfig)}
            >
              Settings
            </Button>
            <Button
              size="sm"
              leftIcon={<Icon as={MdRefresh} />}
              onClick={() => fetchOrders()}
              isLoading={loading}
            >
              {t`Refresh`}
            </Button>
          </HStack>
        </Flex>

        {showConfig && (
          <Card p={4}>
            <HStack>
              <Input
                placeholder="RPC URL"
                value={rpcUrl}
                onChange={(e) => setRpcUrl(e.target.value)}
                size="sm"
              />
              <Button size="sm" onClick={handleSaveConfig}>
                Save
              </Button>
            </HStack>
          </Card>
        )}

        <Card p={4}>
          <InputGroup>
            <InputLeftElement pointerEvents="none">
              <SearchIcon color="gray.400" />
            </InputLeftElement>
            <Input
              placeholder={t`Search by token ref...`}
              value={searchRef}
              onChange={(e) => setSearchRef(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleSearch()}
            />
            <Button ml={2} onClick={handleSearch} isLoading={loading}>
              {t`Search`}
            </Button>
          </InputGroup>
        </Card>

        <Card>
          {loading && orders.length === 0 ? (
            <VStack p={8} spacing={4}>
              <Skeleton height="40px" width="100%" />
              <Skeleton height="40px" width="100%" />
              <Skeleton height="40px" width="100%" />
            </VStack>
          ) : orders.length === 0 ? (
            <Box p={8} textAlign="center">
              <Text color="gray.500">{t`No open orders found`}</Text>
              <Text fontSize="sm" color="gray.400" mt={2}>
                {t`Orders will appear here when users broadcast swap offers for tokens you own`}
              </Text>
            </Box>
          ) : (
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>{t`Swap`}</Th>
                  <Th>{t`Offering`}</Th>
                  <Th>{t`Wants`}</Th>
                  <Th display={{ base: "none", md: "table-cell" }}>
                    {t`Block`}
                  </Th>
                  <Th></Th>
                </Tr>
              </Thead>
              <Tbody>
                {orders.map((order, idx) => (
                  <OrderRow
                    key={`${order.offer.utxo.txid}-${order.offer.utxo.vout}-${idx}`}
                    order={order}
                    onAccept={handleAcceptOrder}
                  />
                ))}
              </Tbody>
            </Table>
          )}
        </Card>

        <Alert status="info">
          <AlertIcon />
          <Box>
            <Text fontWeight="medium">{t`How it works`}</Text>
            <Text fontSize="sm">
              {t`Browse swap offers broadcast to the network. When you accept an offer, you complete the atomic swap by providing the requested asset and broadcasting the final transaction.`}
            </Text>
          </Box>
        </Alert>
      </VStack>
    </Container>
  );
}
