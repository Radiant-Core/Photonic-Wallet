/**
 * Recently Minted — the Market hub's global token-discovery feed.
 *
 * Lists the newest glyphs on the network straight from RXinDexer's v4 recency
 * index (glyph.get_recent), across every token type or narrowed to WAVE names
 * for the name marketplace. Rows are indexer rows (other wallets' mints
 * included) rendered without any per-row network fetches; opening a row seeds
 * the glyph into the local DB (fetchGlyph) and routes to the existing detail
 * view for its type. Pagination is an opaque forward cursor held in memory
 * only — cursors are order- and filter-specific, so they are never persisted
 * and never carried across a filter change.
 */
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  ButtonGroup,
  Flex,
  HStack,
  Icon,
  Skeleton,
  Spacer,
  Spinner,
  Text,
  useToast,
  VStack,
} from "@chakra-ui/react";
import { MdRefresh } from "react-icons/md";
import {
  TbAt,
  TbChevronRight,
  TbCoins,
  TbFileDescription,
  TbFolder,
  TbHexagon,
  TbPhoto,
  TbPick,
  TbShieldCheck,
  TbSparkles,
} from "react-icons/tb";
import { IconType } from "react-icons/lib";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import Card from "@app/components/Card";
import NoContent from "@app/components/NoContent";
import TokenContent from "@app/components/TokenContent";
import db from "@app/db";
import { electrumWorker } from "@app/electrum/Electrum";
import type { RecentGlyphToken } from "@app/electrum/worker/electrumWorker";
import { electrumStatus } from "@app/signals";
import { ElectrumStatus, SmartToken, SmartTokenType } from "@app/types";
import { getWaveDisplay } from "@lib/wave";
import { reverseRef } from "@lib/Outpoint";
import { shortRef } from "@app/marketModel";

const PAGE_SIZE = 30;
// GlyphTokenType.WAVE in the indexer's id space (1=FT 2=NFT 3=DAT 4=DMINT
// 5=WAVE 6=Container 7=Authority).
const WAVE_TOKEN_TYPE = 5;

type RecentFilter = "all" | "names";

// Per-type row icon + badge colour, keyed by the indexer's GlyphTokenType id.
const TYPE_META: Record<number, { icon: IconType; color: string }> = {
  1: { icon: TbCoins, color: "cyan" },
  2: { icon: TbPhoto, color: "purple" },
  3: { icon: TbFileDescription, color: "gray" },
  4: { icon: TbPick, color: "orange" },
  5: { icon: TbAt, color: "blue" },
  6: { icon: TbFolder, color: "green" },
  7: { icon: TbShieldCheck, color: "red" },
};
const DEFAULT_TYPE_META = { icon: TbHexagon, color: "gray" };

// BE 72-hex ref — the form db.glyph and the detail routes key on. `ref_hex` is
// the raw LE (script-operand) form; fall back to parsing the display
// `txid_vout` if a server omits it.
function rowRefBE(row: RecentGlyphToken): string | null {
  if (row.ref_hex && /^[0-9a-f]{72}$/i.test(row.ref_hex)) {
    return reverseRef(row.ref_hex);
  }
  const m = row.ref?.match(/^([0-9a-f]{64})_(\d+)$/i);
  if (!m) return null;
  return m[1] + parseInt(m[2], 10).toString(16).padStart(8, "0");
}

// Best display name for a row: the local glyph (WAVE display name first) wins,
// else the indexer row's own attrs/name. WAVE names live in attrs, not `name`,
// so a bare row.name would show most names as untitled.
function displayName(
  row: RecentGlyphToken,
  glyph: SmartToken | undefined
): string | null {
  if (glyph) {
    const wave = getWaveDisplay(glyph);
    if (wave?.full) return wave.full;
    if (glyph.name) return glyph.name;
  }
  const wave = getWaveDisplay({ p: row.protocols, attrs: row.attrs });
  if (wave?.full) return wave.full;
  return row.name || null;
}

export default function RecentlyMinted() {
  const toast = useToast();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<RecentFilter>("all");
  const [tokens, setTokens] = useState<RecentGlyphToken[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [openingRef, setOpeningRef] = useState<string | null>(null);
  const [tipHeight, setTipHeight] = useState(0);
  // Monotonic id so a slow response from before a filter change / refresh
  // can't clobber the newer page.
  const requestSeq = useRef(0);

  const connected = electrumStatus.value === ElectrumStatus.CONNECTED;

  const fetchPage = useCallback(
    async (f: RecentFilter, cursor: string | null) => {
      const seq = ++requestSeq.current;
      const isFirst = cursor === null;
      if (isFirst) setLoading(true);
      else setLoadingMore(true);
      try {
        const page = await electrumWorker.value.getRecentGlyphs(
          PAGE_SIZE,
          cursor,
          f === "names" ? WAVE_TOKEN_TYPE : undefined
        );
        if (seq !== requestSeq.current) return;
        if (!page) {
          setUnavailable(true);
          if (isFirst) {
            setTokens([]);
            setNextCursor(null);
          }
          return;
        }
        setUnavailable(false);
        setTokens((prev) => {
          const base = isFirst ? [] : prev;
          const seen = new Set(base.map((t) => t.ref));
          const merged = [...base];
          for (const t of page.tokens) {
            if (!seen.has(t.ref)) {
              seen.add(t.ref);
              merged.push(t);
            }
          }
          return merged;
        });
        setNextCursor(page.next_cursor);
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
          setLoaded(true);
        }
      }
    },
    []
  );

  useEffect(() => {
    if (connected) fetchPage(filter, null);
  }, [connected, filter, fetchPage]);

  useEffect(() => {
    if (!connected) return;
    electrumWorker.value
      .getBlockHeight()
      .then(setTipHeight)
      .catch(() => {});
  }, [connected]);

  const changeFilter = (f: RecentFilter) => {
    if (f === filter) return;
    setFilter(f);
    setTokens([]);
    setNextCursor(null);
    setLoaded(false);
  };

  // Glyphs the wallet already has locally (own + previously fetched tokens):
  // real thumbnails and names for those rows, no network round-trips.
  const localGlyphs = useLiveQuery(async () => {
    const refs = tokens
      .map(rowRefBE)
      .filter((r): r is string => r !== null);
    if (refs.length === 0) return [] as SmartToken[];
    return db.glyph.where("ref").anyOf(refs).toArray();
  }, [tokens]);
  const glyphByRef = useMemo(
    () => new Map((localGlyphs || []).map((g) => [g.ref, g])),
    [localGlyphs]
  );

  // Seed the glyph locally (idempotent) so the existing detail views — which
  // read db.glyph — can render tokens minted by other wallets, then route by
  // the decoded token type.
  const openToken = async (row: RecentGlyphToken) => {
    const refBE = rowRefBE(row);
    if (!refBE || openingRef) return;
    setOpeningRef(refBE);
    try {
      let glyph: SmartToken | undefined =
        glyphByRef.get(refBE) ||
        (await db.glyph.get({ ref: refBE }).catch(() => undefined));
      if (!glyph) {
        glyph = await electrumWorker.value.fetchGlyph(refBE);
      }
      if (!glyph) {
        toast({
          status: "error",
          title: "Couldn't load token",
          description:
            "The token's reveal transaction could not be fetched from the network.",
        });
        return;
      }
      navigate(
        glyph.tokenType === SmartTokenType.FT
          ? `/fungible/token/${refBE}`
          : `/objects/token/${refBE}`
      );
    } finally {
      setOpeningRef(null);
    }
  };

  const empty = loaded && !loading && tokens.length === 0;

  return (
    <VStack spacing={4} align="stretch">
      <Alert status="info" variant="subtle" borderRadius="md" fontSize="sm">
        <AlertIcon />
        <Box>
          <Text fontWeight="medium">Newest tokens on the network</Text>
          <Text>
            Every glyph as it is minted — NFTs, fungible tokens, dMint
            contracts and WAVE names. Open a token to view its content and
            trade it from its detail page.
          </Text>
        </Box>
      </Alert>

      <Flex align="center" gap={3} wrap="wrap">
        <ButtonGroup size="sm" isAttached variant="outline">
          <Button
            variant={filter === "all" ? "subtle" : "ghost"}
            onClick={() => changeFilter("all")}
          >
            All
          </Button>
          <Button
            variant={filter === "names" ? "subtle" : "ghost"}
            onClick={() => changeFilter("names")}
          >
            WAVE names
          </Button>
        </ButtonGroup>
        <Spacer />
        <Button
          size="sm"
          leftIcon={<Icon as={MdRefresh} />}
          onClick={() => fetchPage(filter, null)}
          isLoading={loading && tokens.length === 0}
        >
          Refresh
        </Button>
      </Flex>

      {unavailable && (
        <Alert status="warning" variant="subtle" borderRadius="md" fontSize="sm">
          <AlertIcon />
          The connected server doesn&apos;t serve the token discovery index
          yet. Try another server under Settings → Servers.
        </Alert>
      )}

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
            icon={TbSparkles}
            subtitle={
              filter === "names"
                ? "No WAVE names have been registered recently."
                : "No recently minted tokens were found on the network."
            }
          >
            Nothing minted yet
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
              <Box flex={2} minW="160px">
                Token
              </Box>
              <Box flex={1} minW="90px">
                Type
              </Box>
              <Box
                flex={1}
                minW="110px"
                display={{ base: "none", sm: "block" }}
              >
                Minted
              </Box>
              <Box w={6} />
            </Flex>

            {tokens.map((row) => {
              const refBE = rowRefBE(row);
              const glyph = refBE ? glyphByRef.get(refBE) : undefined;
              const meta = TYPE_META[row.type] || DEFAULT_TYPE_META;
              const name = displayName(row, glyph);
              const blocksAgo =
                tipHeight > 0 && row.deploy_height > 0
                  ? Math.max(0, tipHeight - row.deploy_height)
                  : null;
              return (
                <Flex
                  key={row.ref}
                  px={4}
                  py={2}
                  align="center"
                  gap={2}
                  borderTopWidth="1px"
                  borderColor="border.subtle"
                  cursor="pointer"
                  _hover={{ bg: "bg.50" }}
                  onClick={() => openToken(row)}
                >
                  <Box flex={2} minW="160px">
                    <HStack spacing={3} minW={0}>
                      {glyph ? (
                        <Box boxSize={8} flexShrink={0}>
                          <TokenContent glyph={glyph} thumbnail />
                        </Box>
                      ) : (
                        <Flex
                          boxSize={8}
                          flexShrink={0}
                          align="center"
                          justify="center"
                          borderRadius="md"
                          bg="surface.sunken"
                        >
                          <Icon as={meta.icon} boxSize={4} color="text.muted" />
                        </Flex>
                      )}
                      <VStack align="start" spacing={0} minW={0}>
                        <Text fontWeight="medium" isTruncated maxW="240px">
                          {name || (refBE ? shortRef(refBE) : row.ref)}
                        </Text>
                        <Text
                          fontSize="xs"
                          color="text.muted"
                          fontFamily="mono"
                          isTruncated
                          maxW="240px"
                        >
                          {row.ticker ? `$${row.ticker} · ` : ""}
                          {refBE ? shortRef(refBE) : ""}
                        </Text>
                      </VStack>
                    </HStack>
                  </Box>
                  <Box flex={1} minW="90px">
                    <HStack spacing={1}>
                      <Badge colorScheme={meta.color} variant="subtle">
                        {row.type_name}
                      </Badge>
                      {row.is_wave_duplicate && (
                        <Badge colorScheme="red" variant="subtle">
                          Duplicate
                        </Badge>
                      )}
                    </HStack>
                  </Box>
                  <Box
                    flex={1}
                    minW="110px"
                    display={{ base: "none", sm: "block" }}
                  >
                    <VStack align="start" spacing={0}>
                      <Text
                        fontSize="sm"
                        sx={{ fontVariantNumeric: "tabular-nums" }}
                      >
                        {row.deploy_height > 0
                          ? `Block ${row.deploy_height.toLocaleString()}`
                          : "Pending"}
                      </Text>
                      {blocksAgo !== null && (
                        <Text
                          fontSize="xs"
                          color="text.muted"
                          sx={{ fontVariantNumeric: "tabular-nums" }}
                        >
                          {blocksAgo === 0
                            ? "just now"
                            : `${blocksAgo.toLocaleString()} block${
                                blocksAgo === 1 ? "" : "s"
                              } ago`}
                        </Text>
                      )}
                    </VStack>
                  </Box>
                  <Flex w={6} justify="flex-end">
                    {openingRef === refBE ? (
                      <Spinner size="sm" color="text.muted" />
                    ) : (
                      <Icon
                        as={TbChevronRight}
                        boxSize={4}
                        color="text.muted"
                      />
                    )}
                  </Flex>
                </Flex>
              );
            })}

            {nextCursor && (
              <Flex
                justify="center"
                p={3}
                borderTopWidth="1px"
                borderColor="border.subtle"
              >
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fetchPage(filter, nextCursor)}
                  isLoading={loadingMore}
                >
                  Load more
                </Button>
              </Flex>
            )}
          </Box>
        )}
      </Card>
    </VStack>
  );
}
