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
  HStack,
  Icon,
  Image,
  Skeleton,
  Text,
  Textarea,
  Tooltip,
  useClipboard,
  useToast,
  VStack,
} from "@chakra-ui/react";
import { MdRefresh, MdOutlineSwapHoriz, MdArrowUpward, MdArrowDownward } from "react-icons/md";
import { TbTagOff } from "react-icons/tb";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import Card from "@app/components/Card";
import ContentContainer from "@app/components/ContentContainer";
import NoContent from "@app/components/NoContent";
import PageHeader from "@app/components/PageHeader";
import SectionHeading from "@app/components/SectionHeading";
import TokenContent from "@app/components/TokenContent";
import db from "@app/db";
import { electrumWorker } from "@app/electrum/Electrum";
import type {
  SwapOpenOrder,
  RoyaltyIndexListing,
} from "@app/electrum/worker/electrumWorker";
import { electrumStatus, openModal } from "@app/signals";
import {
  ContractType,
  CovenantStatus,
  CovenantType,
  ElectrumStatus,
  SmartToken,
  SmartTokenType,
} from "@app/types";
import { isWaveNameGlyph, getWaveDisplay } from "@lib/wave";
import { photonsToRXD } from "@lib/format";
import { assetToSwapTokenId } from "@app/swapBroadcast";
import { parseNftScript, parseFtScript } from "@lib/script";
import { reverseRef } from "@lib/Outpoint";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — radiantjs ships partial types
import { Transaction } from "@radiant-core/radiantjs";
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
// Per-round cap on glyph fetches for tokens not in the local DB (other wallets'
// names/NFTs). Mirrors OpenOrders' bounded resolver; the resolver re-runs as
// results arrive, walking the feed in batches of this size.
const RESOLVE_CAP = 30;

type MarketFilter = "all" | "ft" | "nft" | "names" | "royalty";

const FILTERS: { key: MarketFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ft", label: "Fungible" },
  { key: "nft", label: "NFTs" },
  { key: "names", label: "Names" },
  { key: "royalty", label: "Royalty" },
];

// The order's token-of-interest id. The swap index normalises pair refs
// token-as-base, so base_ref carries the token's SWAP token-id (sha256 of the
// LE/script-operand ref — same as assetToSwapTokenId) as its leading 64 hex;
// quote is RXD. (base_ref is NOT the real ref.)
function orderTokenId(l: UnifiedSwapListing): string | null {
  return l.baseRef ? l.baseRef.split("_")[0] : null;
}

// Recover the offered token's backing outpoint from a swap order_id. order_id is
// hash_to_hex_str(utxoHash_LE + vout_LE) = vout_BE(4) + txid_BE(32), so the
// display txid is the trailing 64 hex and the vout the leading 8 (big-endian).
function backingOutpoint(
  orderId: string | null
): { txid: string; vout: number } | null {
  if (!orderId || orderId.length !== 72 || !/^[0-9a-f]{72}$/i.test(orderId)) {
    return null;
  }
  return { txid: orderId.slice(8), vout: parseInt(orderId.slice(0, 8), 16) };
}

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
  // WAVE name glyphs carry their human name in attrs (getWaveDisplay), not
  // glyph.name — without this a resolved name would still show a raw ref.
  const wave = glyph ? getWaveDisplay(glyph) : undefined;
  const name = wave?.full || glyph?.name || ticker || undefined;
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
          <Text fontSize="xs" color="text.muted">
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
          <Text fontSize="xs" color="text.muted" fontFamily="mono">
            {shortRef(listing.ref)}
          </Text>
          <Text
            fontSize="sm"
            color="text.secondary"
            mt={1}
            sx={{ fontVariantNumeric: "tabular-nums" }}
          >
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
  const [hasMoreRoyalties, setHasMoreRoyalties] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [buyInput, setBuyInput] = useState("");
  const [buying, setBuying] = useState(false);
  const [buyingKey, setBuyingKey] = useState<string | null>(null);
  // Glyphs fetched by ref for tokens the wallet doesn't own locally (other
  // wallets' WAVE names / NFTs). Keyed by 72-hex ref; null = fetched-not-found
  // (don't retry). Without this, the global feed (which carries no names) shows
  // raw refs and the Names filter can't classify other wallets' listings.
  const [resolvedGlyphs, setResolvedGlyphs] = useState<
    Map<string, SmartToken | null>
  >(new Map());

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
  // Owned glyphs keyed by SWAP token-id (sha256 of the LE/script-operand ref) — the
  // form the global feed's base_ref carries. We match by token-id (NOT ref, since
  // base_ref is the hash, not a resolvable ref), so a token the wallet owns is named
  // with no fetch.
  const glyphByTokenId = useMemo(
    () =>
      new Map(
        (glyphs || []).map((g) => [
          assetToSwapTokenId(
            g.tokenType === SmartTokenType.NFT
              ? ContractType.NFT
              : ContractType.FT,
            g.ref
          ),
          g,
        ])
      ),
    [glyphs]
  );

  // The order's token glyph: owned (by token-id) first, else the network-resolved
  // cache (keyed by order key — populated by the resolver below).
  const tokenGlyphFor = useCallback(
    (l: UnifiedSwapListing): SmartToken | undefined => {
      const tid = orderTokenId(l);
      if (!tid) return undefined;
      return glyphByTokenId.get(tid) || resolvedGlyphs.get(l.key) || undefined;
    },
    [glyphByTokenId, resolvedGlyphs]
  );

  // The quote side's glyph iff it's a token the wallet owns (token-for-token
  // swaps; quote is normally RXD → null). No network resolve for the quote side.
  const quoteGlyphFor = useCallback(
    (l: UnifiedSwapListing): SmartToken | undefined =>
      l.quoteRef ? glyphByTokenId.get(l.quoteRef.split("_")[0]) : undefined,
    [glyphByTokenId]
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
  const fetchRoyalties = useCallback(async (offset: number) => {
    try {
      const page = await electrumWorker.value.getRoyaltyListings(
        PAGE_SIZE,
        offset
      );
      setRoyaltyFeed((prev) => {
        const base = offset === 0 ? [] : prev;
        const seen = new Set(
          base.map((r) => `${r.txid}:${r.vout}`)
        );
        const merged = [...base];
        for (const r of page) {
          const k = `${r.txid}:${r.vout}`;
          if (!seen.has(k)) {
            seen.add(k);
            merged.push(r);
          }
        }
        return merged;
      });
      setHasMoreRoyalties(page.length >= PAGE_SIZE);
    } catch {
      if (offset === 0) setRoyaltyFeed([]);
      setHasMoreRoyalties(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchPage(0);
    fetchRoyalties(0);
  }, [fetchPage, fetchRoyalties]);

  useEffect(() => {
    if (connected) refreshAll();
  }, [connected, refreshAll]);

  // Build the unified listing set from both sources.
  const swapListings: UnifiedSwapListing[] = useMemo(
    () => orders.map(swapOrderToListing),
    [orders]
  );

  // Resolve glyphs for offered tokens the wallet doesn't own (every other wallet's
  // WAVE name / NFT). The feed's base_ref is the sha256 token-id, NOT a resolvable
  // ref — so we recover the offered token's REAL ref from the order's backing UTXO
  // (order_id) → fetch that tx → parse the NFT/FT script → fetchGlyph. Same path
  // the per-token Open Orders book uses. Only SELL orders carry the offered token
  // at the backing UTXO; a BUY offers RXD (its base token is wanted, not there).
  useEffect(() => {
    const pending: UnifiedSwapListing[] = [];
    const seen = new Set<string>();
    for (const l of swapListings) {
      if (l.side !== "sell" || !orderTokenId(l)) continue;
      if (tokenGlyphFor(l) || resolvedGlyphs.has(l.key) || seen.has(l.key)) {
        continue;
      }
      seen.add(l.key);
      pending.push(l);
    }
    if (pending.length === 0) return;
    const batch = pending.slice(0, RESOLVE_CAP);
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled(
        batch.map(async (l) => {
          const op = backingOutpoint(l.order.order_id);
          if (!op) return [l.key, null] as const;
          const hex = await electrumWorker.value.getTransaction(op.txid);
          if (!hex) return [l.key, null] as const;
          const out = new Transaction(hex).outputs[op.vout];
          if (!out) return [l.key, null] as const;
          const script = out.script.toHex();
          let refLE = parseNftScript(script).ref || parseFtScript(script).ref;
          // Defensive fallback for covenant variants: pull the singleton ref
          // straight from the OP_PUSHINPUTREFSINGLETON operand (d8 <ref> 75).
          if (!refLE) {
            refLE = script.match(/d8([0-9a-f]{72})75/)?.[1];
          }
          if (!refLE) return [l.key, null] as const;
          const g = await electrumWorker.value.fetchGlyph(reverseRef(refLE));
          return [l.key, g || null] as const;
        })
      );
      if (cancelled) return;
      setResolvedGlyphs((prev) => {
        const next = new Map(prev);
        for (const l of batch) if (!next.has(l.key)) next.set(l.key, null);
        for (const res of results) {
          if (res.status === "fulfilled") next.set(res.value[0], res.value[1]);
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [swapListings, tokenGlyphFor, resolvedGlyphs]);
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

  // assetKind classification from the order's token glyph (owned-by-token-id or
  // network-resolved). Unresolved tokens are "unknown" → shown under "All" only.
  const swapAssetKind = useCallback(
    (l: UnifiedSwapListing): "ft" | "nft" | "name" | "rxd" | "unknown" => {
      if (!l.baseRef && !l.quoteRef) return "rxd";
      const g = tokenGlyphFor(l);
      if (g && isWaveNameGlyph(g)) return "name";
      if (g?.tokenType === SmartTokenType.FT) return "ft";
      if (g?.tokenType === SmartTokenType.NFT) return "nft";
      return "unknown";
    },
    [tokenGlyphFor]
  );

  // ── Column sorting ──
  type SortKey = "item" | "price" | "amount" | "type";
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const visible: UnifiedListing[] = useMemo(() => {
    const all: UnifiedListing[] = [...royaltyListings, ...swapListings];
    let filtered = all;
    if (filter !== "all") {
      if (filter === "royalty") {
        filtered = all.filter((l) => l.kind === "royalty");
      } else {
        filtered = all.filter((l) => {
          if (l.kind === "royalty") {
            const g = glyphByRef.get(l.ref);
            if (filter === "names") return !!g && isWaveNameGlyph(g);
            return filter === "nft";
          }
          const kind = swapAssetKind(l);
          if (filter === "ft") return kind === "ft";
          if (filter === "nft") return kind === "nft";
          if (filter === "names") return kind === "name";
          return false;
        });
      }
    }
    if (!sortKey) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "price") {
        const pa = a.kind === "royalty" ? a.price : a.order.price;
        const pb = b.kind === "royalty" ? b.price : b.order.price;
        cmp = pa - pb;
      } else if (sortKey === "amount") {
        const aa = a.kind === "royalty" ? 1 : a.order.remaining_amount;
        const ab = b.kind === "royalty" ? 1 : b.order.remaining_amount;
        cmp = aa - ab;
      } else if (sortKey === "type") {
        const ta = a.kind === "royalty" ? 0 : a.side === "buy" ? 1 : 2;
        const tb = b.kind === "royalty" ? 0 : b.side === "buy" ? 1 : 2;
        cmp = ta - tb;
      } else if (sortKey === "item") {
        const na = a.kind === "royalty" ? (a.name || a.ref) : (a.order.base_ticker || a.baseRef || "");
        const nb = b.kind === "royalty" ? (b.name || b.ref) : (b.order.base_ticker || b.baseRef || "");
        cmp = na.localeCompare(nb);
      }
      return cmp * dir;
    });
  }, [filter, royaltyListings, swapListings, swapAssetKind, glyphByRef, sortKey, sortDir]);

  // ── Virtualized list ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex =
    virtualItems.length > 0
      ? virtualItems[virtualItems.length - 1].index
      : 0;

  // Infinite scroll: auto-load more data when the user nears the bottom.
  useEffect(() => {
    if (lastVisibleIndex < visible.length - 4) return;
    if (loading || loadingMore) return;
    if (hasMore) {
      setLoadingMore(true);
      fetchPage(orders.length).finally(() => setLoadingMore(false));
    }
    if (hasMoreRoyalties) {
      setLoadingMore(true);
      fetchRoyalties(royaltyFeed.length).finally(() => setLoadingMore(false));
    }
  }, [
    lastVisibleIndex,
    visible.length,
    hasMore,
    hasMoreRoyalties,
    loading,
    loadingMore,
    fetchPage,
    fetchRoyalties,
    orders.length,
    royaltyFeed.length,
  ]);

  const openSwap = (l: UnifiedSwapListing) => {
    // Deep-link with the SWAP token-id (base_ref's 64-hex) — the per-token book's
    // getopenorders/getopenordersbywant key on it directly. (base_ref is already
    // the sha256 token-id, NOT a real ref, so we must NOT pass the 72-hex form,
    // which OpenOrders would re-hash into a wrong id and find nothing.)
    const tid = orderTokenId(l);
    if (tid) navigate(`/swap/orders?ref=${tid}`);
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
                variant={filter === f.key ? "subtle" : "ghost"}
              >
                {f.label}
              </Button>
            ))}
          </ButtonGroup>

          {/* My royalty listings */}
          {myRoyaltyListings.length > 0 && (
            <Box>
              <SectionHeading>My Listings</SectionHeading>
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
                  <Skeleton
                    height="40px"
                    width="100%"
                    startColor="surface.sunken"
                    endColor="bg.50"
                  />
                  <Skeleton
                    height="40px"
                    width="100%"
                    startColor="surface.sunken"
                    endColor="bg.50"
                  />
                  <Skeleton
                    height="40px"
                    width="100%"
                    startColor="surface.sunken"
                    endColor="bg.50"
                  />
                </VStack>
              ) : (
                <Box p={8} textAlign="center">
                  <Text color="text.muted" fontWeight="medium">
                    Connecting to the network…
                  </Text>
                </Box>
              )
            ) : empty ? (
              <NoContent
                icon={TbTagOff}
                subtitle="Nothing matches this filter right now. Create an offer from the Swap page, or list an NFT with enforced royalties."
              >
                No active listings
              </NoContent>
            ) : (
              <Box>
                {/* Header row */}
                <Flex
                  px={4}
                  py={2}
                  bg="surface.sunken"
                  fontSize="xs"
                  fontWeight="medium"
                  color="text.muted"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                  gap={2}
                >
                  <Flex
                    flex={1}
                    minW="100px"
                    align="center"
                    cursor="pointer"
                    userSelect="none"
                    _hover={{ color: "text.primary" }}
                    onClick={() => toggleSort("item")}
                  >
                    Item
                    {sortKey === "item" && (
                      <Icon as={sortDir === "asc" ? MdArrowUpward : MdArrowDownward} boxSize={3} ml={1} />
                    )}
                  </Flex>
                  <Flex
                    flex={1}
                    minW="100px"
                    align="center"
                    cursor="pointer"
                    userSelect="none"
                    _hover={{ color: "text.primary" }}
                    onClick={() => toggleSort("price")}
                  >
                    Price / For
                    {sortKey === "price" && (
                      <Icon as={sortDir === "asc" ? MdArrowUpward : MdArrowDownward} boxSize={3} ml={1} />
                    )}
                  </Flex>
                  <Flex
                    flex={1}
                    minW="80px"
                    align="center"
                    cursor="pointer"
                    userSelect="none"
                    _hover={{ color: "text.primary" }}
                    onClick={() => toggleSort("amount")}
                    display={{ base: "none", sm: "flex" }}
                  >
                    Amount
                    {sortKey === "amount" && (
                      <Icon as={sortDir === "asc" ? MdArrowUpward : MdArrowDownward} boxSize={3} ml={1} />
                    )}
                  </Flex>
                  <Flex
                    flex={1}
                    minW="80px"
                    align="center"
                    cursor="pointer"
                    userSelect="none"
                    _hover={{ color: "text.primary" }}
                    onClick={() => toggleSort("type")}
                    display={{ base: "none", md: "flex" }}
                  >
                    Type
                    {sortKey === "type" && (
                      <Icon as={sortDir === "asc" ? MdArrowUpward : MdArrowDownward} boxSize={3} ml={1} />
                    )}
                  </Flex>
                  <Box flex={1} minW="80px" textAlign="right"></Box>
                </Flex>

                {/* Virtualized scroll container */}
                <Box
                  ref={scrollRef}
                  maxH="600px"
                  overflowY="auto"
                  sx={{
                    "&::-webkit-scrollbar": { width: "8px" },
                    "&::-webkit-scrollbar-thumb": {
                      bg: "border.subtle",
                      borderRadius: "4px",
                    },
                  }}
                >
                  <Box
                    height={`${virtualizer.getTotalSize()}px`}
                    position="relative"
                    width="100%"
                  >
                    {virtualItems.map((virtualItem) => {
                      const l = visible[virtualItem.index];
                      if (!l) return null;
                      return (
                        <Box
                          key={l.key}
                          position="absolute"
                          top={0}
                          left={0}
                          width="100%"
                          height={`${virtualItem.size}px`}
                          transform={`translateY(${virtualItem.start}px)`}
                          borderTopWidth="1px"
                          borderColor="border.subtle"
                          _hover={{ bg: "bg.50" }}
                        >
                          {l.kind === "royalty" ? (
                            <Flex
                              px={4}
                              py={2}
                              align="center"
                              height="100%"
                              gap={2}
                            >
                              <Box flex={1} minW="100px">
                                <AssetLabel
                                  displayRef={l.ref}
                                  glyph={glyphByRef.get(l.ref)}
                                />
                              </Box>
                              <Box flex={1} minW="100px">
                                <VStack align="start" spacing={0}>
                                  <Text
                                    fontWeight="medium"
                                    sx={{ fontVariantNumeric: "tabular-nums" }}
                                  >
                                    {photonsToRXD(l.price)} RXD
                                  </Text>
                                  {l.royaltyTotal > 0 && (
                                    <Text
                                      fontSize="xs"
                                      color="text.muted"
                                      sx={{ fontVariantNumeric: "tabular-nums" }}
                                    >
                                      +{photonsToRXD(l.royaltyTotal)} royalty
                                    </Text>
                                  )}
                                </VStack>
                              </Box>
                              <Box
                                flex={1}
                                minW="80px"
                                display={{ base: "none", sm: "block" }}
                              >
                                <Text
                                  fontSize="sm"
                                  sx={{ fontVariantNumeric: "tabular-nums" }}
                                >
                                  1
                                </Text>
                              </Box>
                              <Box
                                flex={1}
                                minW="80px"
                                display={{ base: "none", md: "block" }}
                              >
                                <MechanismBadge mechanism="royalty" />
                              </Box>
                              <Box flex={1} minW="80px" textAlign="right">
                                {l.mine ? (
                                  <Badge colorScheme="gray">Yours</Badge>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="subtle"
                                    onClick={() => buyRoyalty(l)}
                                    isLoading={buyingKey === l.key}
                                  >
                                    Buy
                                  </Button>
                                )}
                              </Box>
                            </Flex>
                          ) : (
                            (() => {
                              const isBuy = l.side === "buy";
                              const tokenCell = (
                                <AssetLabel
                                  displayRef={l.baseRef}
                                  ticker={l.order.base_ticker}
                                  glyph={tokenGlyphFor(l)}
                                />
                              );
                              const quoteCell = (
                                <AssetLabel
                                  displayRef={l.quoteRef}
                                  ticker={l.order.quote_ticker}
                                  glyph={quoteGlyphFor(l)}
                                />
                              );
                              return (
                                <Flex
                                  px={4}
                                  py={2}
                                  align="center"
                                  height="100%"
                                  gap={2}
                                >
                                  <Box flex={1} minW="100px">
                                    {isBuy ? quoteCell : tokenCell}
                                  </Box>
                                  <Box flex={1} minW="100px">
                                    <HStack spacing={2} minW={0}>
                                      <Icon
                                        as={MdOutlineSwapHoriz}
                                        boxSize={4}
                                        color="text.muted"
                                        display={{ base: "none", sm: "inline" }}
                                      />
                                      {isBuy ? tokenCell : quoteCell}
                                    </HStack>
                                  </Box>
                                  <Box
                                    flex={1}
                                    minW="80px"
                                    display={{ base: "none", sm: "block" }}
                                  >
                                    <VStack align="start" spacing={0}>
                                      <Text
                                        fontSize="sm"
                                        sx={{ fontVariantNumeric: "tabular-nums" }}
                                      >
                                        {l.baseRef === null
                                          ? `${photonsToRXD(l.order.remaining_amount)} RXD`
                                          : l.order.remaining_amount.toLocaleString()}
                                      </Text>
                                      {l.order.filled_amount > 0 && (
                                        <Text
                                          fontSize="xs"
                                          color="text.muted"
                                          sx={{ fontVariantNumeric: "tabular-nums" }}
                                        >
                                          {l.order.percent_filled}% filled
                                        </Text>
                                      )}
                                    </VStack>
                                  </Box>
                                  <Box
                                    flex={1}
                                    minW="80px"
                                    display={{ base: "none", md: "block" }}
                                  >
                                    <HStack spacing={1}>
                                      <MechanismBadge mechanism="swap" />
                                      <Badge
                                        colorScheme={isBuy ? "green" : "orange"}
                                        variant="subtle"
                                      >
                                        {isBuy ? "Buy" : "Sell"}
                                      </Badge>
                                      <Badge
                                        colorScheme={statusColor(l.status)}
                                        variant="subtle"
                                      >
                                        {l.status}
                                      </Badge>
                                    </HStack>
                                  </Box>
                                  <Box flex={1} minW="80px" textAlign="right">
                                    <Tooltip
                                      label={
                                        orderTokenId(l)
                                          ? "Open this token's order book to view exact terms and buy"
                                          : "RXD-only order"
                                      }
                                    >
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        isDisabled={!orderTokenId(l)}
                                        onClick={() => openSwap(l)}
                                      >
                                        View / Buy
                                      </Button>
                                    </Tooltip>
                                  </Box>
                                </Flex>
                              );
                            })()
                          )}
                        </Box>
                      );
                    })}
                  </Box>
                </Box>

                {/* Loading indicator for infinite scroll */}
                {(loadingMore || (loading && visible.length > 0)) && (
                  <Box p={4} textAlign="center">
                    <Text fontSize="sm" color="text.muted">
                      Loading more…
                    </Text>
                  </Box>
                )}
              </Box>
            )}
          </Card>

          {/* Buy a royalty listing from a shared descriptor */}
          <Box>
            <SectionHeading>Buy with a listing descriptor</SectionHeading>
            <Card p={4}>
              <VStack align="stretch" spacing={3}>
                <Text fontSize="sm" color="text.secondary">
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
