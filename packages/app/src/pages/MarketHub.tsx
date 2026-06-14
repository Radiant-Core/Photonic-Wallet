/**
 * Market — the unified marketplace hub.
 *
 * One browsable place for every way to buy/sell on Radiant, folding together what
 * used to be three separate surfaces (Browse Market, Names for Sale, the royalty
 * Marketplace). Two on-chain mechanisms coexist here, each clearly badged:
 *   - "Swap"    — RSWP atomic-swap offers (global discovery via RXinDexer). Filled
 *                 by opening the per-token order book (/swap/orders) which runs the
 *                 audited accept flow.
 *   - "Royalty" — royalty-covenant listings (price + creator royalty enforced
 *                 on-chain, no signature). Bought inline. Discovered today from
 *                 local tracking + shared descriptors; cross-seller indexer
 *                 discovery is wired in a later stage.
 *
 * See marketModel.ts (the discriminated-union seam) and royaltyActions.ts.
 */
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  ButtonGroup,
  Container,
  Flex,
  Heading,
  HStack,
  Icon,
  Image,
  Skeleton,
  Table,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tooltip,
  Tr,
  useClipboard,
  useToast,
  VStack,
} from "@chakra-ui/react";
import { MdRefresh, MdOutlineSwapHoriz } from "react-icons/md";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import Card from "@app/components/Card";
import ContentContainer from "@app/components/ContentContainer";
import PageHeader from "@app/components/PageHeader";
import TokenContent from "@app/components/TokenContent";
import db from "@app/db";
import { electrumWorker } from "@app/electrum/Electrum";
import type {
  SwapOpenOrder,
  RoyaltyIndexListing,
} from "@app/electrum/worker/electrumWorker";
import { electrumStatus, openModal } from "@app/signals";
import {
  CovenantStatus,
  CovenantType,
  ElectrumStatus,
  SmartToken,
  SmartTokenType,
} from "@app/types";
import { isWaveNameGlyph } from "@lib/wave";
import { photonsToRXD } from "@lib/format";
import { swapIndexRefToRef } from "@app/swapBroadcast";
import { decodeListingDescriptor } from "@app/covenant";
import {
  executeRoyaltyBuy,
  executeRoyaltyCancel,
  WalletLockedError,
} from "@app/royaltyActions";
import {
  UnifiedListing,
  UnifiedRoyaltyListing,
  UnifiedSwapListing,
  royaltyFromCovenant,
  royaltyFromIndexer,
  shortRef,
  swapOrderToListing,
} from "@app/marketModel";
import rxdIcon from "/rxd.png";

const PAGE_SIZE = 50;

type MarketFilter = "all" | "ft" | "nft" | "names" | "royalty";

const FILTERS: { key: MarketFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ft", label: "Fungible" },
  { key: "nft", label: "NFTs" },
  { key: "names", label: "Names" },
  { key: "royalty", label: "Royalty" },
];

function statusColor(status: string): string {
  switch (status) {
    case "open":
    case "active":
      return "green";
    case "partial":
      return "yellow";
    case "expired":
    case "cancelled":
      return "red";
    case "filled":
      return "blue";
    default:
      return "gray";
  }
}

function AssetLabel({
  displayRef,
  ticker,
  glyph,
  fallback,
}: {
  displayRef: string | null;
  ticker?: string | null;
  glyph?: SmartToken;
  fallback?: string;
}) {
  if (!displayRef) {
    return (
      <HStack spacing={2}>
        <Image src={rxdIcon} boxSize={5} />
        <Text fontWeight="medium">{fallback || "RXD"}</Text>
      </HStack>
    );
  }
  const name = glyph?.name || ticker || undefined;
  return (
    <HStack spacing={2} minW={0}>
      {glyph ? (
        <Box boxSize={5} flexShrink={0}>
          <TokenContent glyph={glyph} thumbnail />
        </Box>
      ) : null}
      <VStack align="start" spacing={0} minW={0}>
        <Text fontWeight="medium" isTruncated maxW="200px">
          {name || shortRef(displayRef)}
        </Text>
        {ticker && name && ticker !== name ? (
          <Text fontSize="xs" color="gray.500">
            ${ticker}
          </Text>
        ) : null}
      </VStack>
    </HStack>
  );
}

function MechanismBadge({ mechanism }: { mechanism: "swap" | "royalty" }) {
  return mechanism === "royalty" ? (
    <Badge colorScheme="purple" variant="subtle">
      Royalty
    </Badge>
  ) : (
    <Badge colorScheme="teal" variant="subtle">
      Swap
    </Badge>
  );
}

function MyListingRow({
  listing,
  onCancelled,
}: {
  listing: UnifiedRoyaltyListing;
  onCancelled: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { onCopy, hasCopied } = useClipboard(
    btoa(JSON.stringify(listing.descriptor))
  );

  const cancel = async () => {
    setBusy(true);
    try {
      const cov = await db.covenant
        .where("[txid+vout]")
        .equals([listing.covenantUtxo.txid, listing.covenantUtxo.vout])
        .first();
      if (!cov) throw new Error("Listing no longer tracked locally");
      await executeRoyaltyCancel(cov);
      toast({ status: "success", title: "Listing cancelled — NFT reclaimed" });
      onCancelled();
    } catch (error) {
      if (error instanceof WalletLockedError) {
        openModal.value = { modal: "unlock" };
      } else {
        toast({
          status: "error",
          title: "Cancel failed",
          description: error instanceof Error ? error.message : undefined,
        });
      }
    }
    setBusy(false);
  };

  return (
    <Card p={4}>
      <Flex align="center" gap={3} wrap="wrap">
        <Box flex={1} minW="200px">
          <Text fontWeight="bold">{listing.name || "Unnamed token"}</Text>
          <Text fontSize="xs" color="gray.500" fontFamily="mono">
            {shortRef(listing.ref)}
          </Text>
          <Text fontSize="sm" color="gray.400" mt={1}>
            Price {photonsToRXD(listing.price)} RXD · Royalty{" "}
            {photonsToRXD(listing.royaltyTotal)} RXD
          </Text>
        </Box>
        <HStack>
          <Button size="sm" onClick={onCopy}>
            {hasCopied ? "Copied" : "Copy descriptor"}
          </Button>
          <Button size="sm" onClick={cancel} isLoading={busy}>
            Cancel
          </Button>
        </HStack>
      </Flex>
    </Card>
  );
}

export default function MarketHub() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [orders, setOrders] = useState<SwapOpenOrder[]>([]);
  const [royaltyFeed, setRoyaltyFeed] = useState<RoyaltyIndexListing[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [buyInput, setBuyInput] = useState("");
  const [buying, setBuying] = useState(false);
  const [buyingKey, setBuyingKey] = useState<string | null>(null);

  const filter = (searchParams.get("filter") as MarketFilter) || "all";
  const setFilter = (f: MarketFilter) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (f === "all") next.delete("filter");
        else next.set("filter", f);
        return next;
      },
      { replace: true }
    );
  };

  const connected = electrumStatus.value === ElectrumStatus.CONNECTED;

  // Local glyphs give friendly names/thumbnails + asset-type classification for
  // listings the wallet already knows, with no extra network round-trips. Keyed
  // by 72-hex ref (the form swapIndexRefToRef and CovenantRecord.ref both use).
  const glyphs = useLiveQuery(() => db.glyph.toArray(), []);
  const glyphByRef = useMemo(
    () => new Map((glyphs || []).map((g) => [g.ref, g])),
    [glyphs]
  );
  // Resolve a swap-index display ref ("txid_vout") to a local glyph, if known.
  const glyphForDisplayRef = useCallback(
    (displayRef: string | null): SmartToken | undefined => {
      if (!displayRef) return undefined;
      const r = swapIndexRefToRef(displayRef);
      return r ? glyphByRef.get(r) : undefined;
    },
    [glyphByRef]
  );

  // This wallet's own active royalty listings (local tracking).
  const myCovenants = useLiveQuery(
    () =>
      db.covenant
        .where({ status: CovenantStatus.ACTIVE })
        .filter((c) => c.type === CovenantType.ROYALTY_LISTING)
        .toArray(),
    [],
    []
  );

  const fetchPage = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const page = await electrumWorker.value.getOpenSwapOrders(
        PAGE_SIZE,
        offset
      );
      setOrders((prev) => {
        const base = offset === 0 ? [] : prev;
        const seen = new Set(base.map((o) => o.order_id || `${o.tx_hash}:${o.vout}`));
        const merged = [...base];
        for (const o of page) {
          const k = o.order_id || `${o.tx_hash}:${o.vout}`;
          if (!seen.has(k)) {
            seen.add(k);
            merged.push(o);
          }
        }
        return merged;
      });
      setHasMore(page.length >= PAGE_SIZE);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  // Cross-seller royalty listings from the indexer (royalty index, default OFF on
  // prod until deployed → returns [] and we fall back to local/descriptor only).
  const fetchRoyalties = useCallback(async () => {
    try {
      setRoyaltyFeed(await electrumWorker.value.getRoyaltyListings(200, 0));
    } catch {
      setRoyaltyFeed([]);
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchPage(0);
    fetchRoyalties();
  }, [fetchPage, fetchRoyalties]);

  useEffect(() => {
    if (connected) refreshAll();
  }, [connected, refreshAll]);

  // Build the unified listing set from both sources.
  const swapListings: UnifiedSwapListing[] = useMemo(
    () => orders.map(swapOrderToListing),
    [orders]
  );
  const myRoyaltyListings: UnifiedRoyaltyListing[] = useMemo(
    () =>
      (myCovenants || [])
        .map((c) => royaltyFromCovenant(c, glyphByRef.get(c.ref)?.name))
        .filter((x): x is UnifiedRoyaltyListing => x !== null),
    [myCovenants, glyphByRef]
  );

  // All royalty listings: indexer-discovered (cross-seller) merged with this
  // wallet's own local tracking. Local "mine" rows override the same covenant so
  // they carry the mine flag and appear even before the indexer catches up.
  const royaltyListings: UnifiedRoyaltyListing[] = useMemo(() => {
    const byKey = new Map<string, UnifiedRoyaltyListing>();
    for (const r of royaltyFeed) {
      const u = royaltyFromIndexer(r);
      if (u) byKey.set(u.key, u);
    }
    for (const r of myRoyaltyListings) byKey.set(r.key, r);
    return [...byKey.values()];
  }, [royaltyFeed, myRoyaltyListings]);

  // assetKind classification (best-effort from local glyphs; unknown swap tokens
  // surface under "All" only — the global swap feed doesn't carry FT/NFT type).
  const swapAssetKind = useCallback(
    (l: UnifiedSwapListing): "ft" | "nft" | "name" | "rxd" | "unknown" => {
      if (!l.baseRef && !l.quoteRef) return "rxd";
      const g = l.tokenRef72 ? glyphByRef.get(l.tokenRef72) : undefined;
      if (g && isWaveNameGlyph(g)) return "name";
      if (g?.tokenType === SmartTokenType.FT) return "ft";
      if (g?.tokenType === SmartTokenType.NFT) return "nft";
      return "unknown";
    },
    [glyphByRef]
  );

  const visible: UnifiedListing[] = useMemo(() => {
    const all: UnifiedListing[] = [...royaltyListings, ...swapListings];
    if (filter === "all") return all;
    if (filter === "royalty") return all.filter((l) => l.kind === "royalty");
    return all.filter((l) => {
      if (l.kind === "royalty") {
        const g = glyphByRef.get(l.ref);
        if (filter === "names") return !!g && isWaveNameGlyph(g);
        return filter === "nft"; // royalty listings are NFT sales
      }
      const kind = swapAssetKind(l);
      if (filter === "ft") return kind === "ft";
      if (filter === "nft") return kind === "nft";
      if (filter === "names") return kind === "name";
      return false;
    });
  }, [filter, royaltyListings, swapListings, swapAssetKind, glyphByRef]);

  const openSwap = (l: UnifiedSwapListing) => {
    if (l.tokenRef72) navigate(`/swap/orders?ref=${l.tokenRef72}`);
    else navigate("/swap/orders");
  };

  const buyRoyalty = async (l: UnifiedRoyaltyListing) => {
    setBuyingKey(l.key);
    try {
      const txid = await executeRoyaltyBuy(l.descriptor);
      toast({
        status: "success",
        title: "Purchased — royalty paid to creator on-chain",
        description: `${txid.slice(0, 16)}…`,
      });
      refreshAll();
    } catch (error) {
      if (error instanceof WalletLockedError) {
        openModal.value = { modal: "unlock" };
      } else {
        toast({
          status: "error",
          title: "Purchase failed",
          description: error instanceof Error ? error.message : undefined,
        });
      }
    }
    setBuyingKey(null);
  };

  const buyFromDescriptor = async () => {
    let descriptor;
    try {
      descriptor = decodeListingDescriptor(buyInput);
    } catch {
      toast({ status: "error", title: "Invalid listing descriptor" });
      return;
    }
    setBuying(true);
    try {
      const txid = await executeRoyaltyBuy(descriptor);
      setBuyInput("");
      toast({
        status: "success",
        title: "Purchased — royalty paid to creator on-chain",
        description: `${txid.slice(0, 16)}…`,
      });
    } catch (error) {
      if (error instanceof WalletLockedError) {
        openModal.value = { modal: "unlock", onClose: (u) => u && buyFromDescriptor() };
      } else {
        toast({
          status: "error",
          title: "Purchase failed",
          description: error instanceof Error ? error.message : undefined,
        });
      }
    }
    setBuying(false);
  };

  const empty = loaded && !loading && visible.length === 0;

  return (
    <ContentContainer>
      <PageHeader
        toolbar={
          <Button
            size="sm"
            leftIcon={<Icon as={MdRefresh} />}
            onClick={refreshAll}
            isLoading={loading && orders.length === 0}
          >
            Refresh
          </Button>
        }
      >
        Market
      </PageHeader>

      <Container maxW="container.xl" px={4}>
        <VStack spacing={4} align="stretch">
          <Alert status="info" variant="subtle" borderRadius="md" fontSize="sm">
            <AlertIcon />
            <Box>
              <Text fontWeight="medium">
                Every active listing on the network
              </Text>
              <Text>
                Atomic swaps and royalty-enforced listings in one place. Swap
                prices are indicative — open a listing for exact terms. Royalty
                listings enforce the seller's price and the creator's royalty
                on-chain.
              </Text>
            </Box>
          </Alert>

          {/* Filters */}
          <ButtonGroup size="sm" isAttached variant="outline" flexWrap="wrap">
            {FILTERS.map((f) => (
              <Button
                key={f.key}
                onClick={() => setFilter(f.key)}
                colorScheme={filter === f.key ? "blue" : undefined}
                variant={filter === f.key ? "solid" : "outline"}
              >
                {f.label}
              </Button>
            ))}
          </ButtonGroup>

          {/* My royalty listings */}
          {myRoyaltyListings.length > 0 && (
            <Box>
              <Heading size="sm" mb={2}>
                My Listings
              </Heading>
              <VStack align="stretch" spacing={2}>
                {myRoyaltyListings.map((l) => (
                  <MyListingRow
                    key={l.key}
                    listing={l}
                    onCancelled={refreshAll}
                  />
                ))}
              </VStack>
            </Box>
          )}

          {/* Listings table */}
          <Card>
            {!loaded ? (
              connected ? (
                <VStack p={8} spacing={4}>
                  <Skeleton height="40px" width="100%" />
                  <Skeleton height="40px" width="100%" />
                  <Skeleton height="40px" width="100%" />
                </VStack>
              ) : (
                <Box p={8} textAlign="center">
                  <Text color="gray.500" fontWeight="medium">
                    Connecting to the network…
                  </Text>
                </Box>
              )
            ) : empty ? (
              <Box p={8} textAlign="center">
                <Text color="gray.500" fontWeight="medium">
                  No active listings
                </Text>
                <Text fontSize="sm" color="gray.400" mt={2}>
                  Nothing matches this filter right now. Create an offer from the
                  Swap page, or list an NFT with enforced royalties.
                </Text>
              </Box>
            ) : (
              <Box overflowX="auto">
                <Table size="sm">
                  <Thead>
                    <Tr>
                      <Th>Item</Th>
                      <Th>Price / For</Th>
                      <Th display={{ base: "none", md: "table-cell" }}>Type</Th>
                      <Th></Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {visible.map((l) =>
                      l.kind === "royalty" ? (
                        <Tr key={l.key}>
                          <Td>
                            <AssetLabel
                              displayRef={l.ref}
                              glyph={glyphByRef.get(l.ref)}
                            />
                          </Td>
                          <Td>
                            <VStack align="start" spacing={0}>
                              <Text fontWeight="medium">
                                {photonsToRXD(l.price)} RXD
                              </Text>
                              {l.royaltyTotal > 0 && (
                                <Text fontSize="xs" color="gray.500">
                                  +{photonsToRXD(l.royaltyTotal)} royalty
                                </Text>
                              )}
                            </VStack>
                          </Td>
                          <Td display={{ base: "none", md: "table-cell" }}>
                            <MechanismBadge mechanism="royalty" />
                          </Td>
                          <Td textAlign="right">
                            {l.mine ? (
                              <Badge colorScheme="gray">Yours</Badge>
                            ) : (
                              <Button
                                size="sm"
                                colorScheme="purple"
                                onClick={() => buyRoyalty(l)}
                                isLoading={buyingKey === l.key}
                              >
                                Buy
                              </Button>
                            )}
                          </Td>
                        </Tr>
                      ) : (
                        <Tr key={l.key}>
                          <Td>
                            <AssetLabel
                              displayRef={l.baseRef}
                              ticker={l.order.base_ticker}
                              glyph={glyphForDisplayRef(l.baseRef)}
                            />
                          </Td>
                          <Td>
                            <HStack spacing={2} minW={0}>
                              <Icon
                                as={MdOutlineSwapHoriz}
                                boxSize={4}
                                color="gray.400"
                                display={{ base: "none", sm: "inline" }}
                              />
                              <AssetLabel
                                displayRef={l.quoteRef}
                                ticker={l.order.quote_ticker}
                                glyph={glyphForDisplayRef(l.quoteRef)}
                              />
                            </HStack>
                          </Td>
                          <Td display={{ base: "none", md: "table-cell" }}>
                            <HStack spacing={1}>
                              <MechanismBadge mechanism="swap" />
                              <Badge
                                colorScheme={statusColor(l.status)}
                                variant="subtle"
                              >
                                {l.status}
                              </Badge>
                            </HStack>
                          </Td>
                          <Td textAlign="right">
                            <Tooltip
                              label={
                                l.tokenRef72
                                  ? "Open this token's order book to view exact terms and buy"
                                  : "RXD-only order"
                              }
                            >
                              <Button
                                size="sm"
                                colorScheme="blue"
                                variant="outline"
                                isDisabled={!l.tokenRef72}
                                onClick={() => openSwap(l)}
                              >
                                View / Buy
                              </Button>
                            </Tooltip>
                          </Td>
                        </Tr>
                      )
                    )}
                  </Tbody>
                </Table>
              </Box>
            )}

            {hasMore && !empty && (
              <Box p={4} textAlign="center">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fetchPage(orders.length)}
                  isLoading={loading && orders.length > 0}
                >
                  Load More
                </Button>
              </Box>
            )}
          </Card>

          {/* Buy a royalty listing from a shared descriptor */}
          <Box>
            <Heading size="sm" mb={2}>
              Buy with a listing descriptor
            </Heading>
            <Card p={4}>
              <VStack align="stretch" spacing={3}>
                <Text fontSize="sm" color="gray.400">
                  Paste a royalty listing descriptor shared by a seller. The
                  covenant enforces the committed price and royalty on-chain — no
                  maker signature needed.
                </Text>
                <Textarea
                  value={buyInput}
                  onChange={(e) => setBuyInput(e.target.value)}
                  placeholder="Listing descriptor"
                  fontFamily="mono"
                  fontSize="xs"
                  rows={3}
                />
                <Flex justify="flex-end">
                  <Button
                    variant="primary"
                    onClick={buyFromDescriptor}
                    isLoading={buying}
                    isDisabled={!buyInput.trim()}
                  >
                    Buy
                  </Button>
                </Flex>
              </VStack>
            </Card>
          </Box>
        </VStack>
      </Container>
    </ContentContainer>
  );
}
