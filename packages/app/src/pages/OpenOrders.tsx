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
  IconButton,
  Tooltip,
  Select,
  Grid,
  GridItem,
  Divider,
  ButtonGroup,
  Tag,
  TagLabel,
  Checkbox,
} from "@chakra-ui/react";
import {
  SearchIcon,
  CopyIcon,
  TimeIcon,
  ExternalLinkIcon,
} from "@chakra-ui/icons";
import {
  MdOutlineSwapHoriz,
  MdRefresh,
  MdGridView,
  MdTableRows,
  MdFilterList,
} from "react-icons/md";
import { useCallback, useEffect, useMemo, useState } from "react";
import Card from "@app/components/Card";
import NoContent from "@app/components/NoContent";
import { copyText } from "@app/platform";
import { TbInbox } from "react-icons/tb";
import TokenContent from "@app/components/TokenContent";
import { WaveExpiryBadge } from "@app/components/WaveAssetLabel";
import { isWaveNameGlyph, getWaveDisplay } from "@lib/wave";
import { HiOutlineAtSymbol } from "react-icons/hi";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  SmartToken,
  ContractType,
  SmartTokenType,
  SwapError,
  SwapMode,
  SwapStatus,
  TokenSwap,
} from "@app/types";
import db from "@app/db";
import opfs from "@app/opfs";
import createExplorerUrl from "@app/network/createExplorerUrl";
import { cancelSwap } from "@app/swap";
import { photonsToRXD, formatAmountCompact } from "@lib/format";
import {
  SwapOffer,
  assetToSwapTokenId,
  getOpenOrders,
  getOpenOrdersByWant,
  parsePriceTerms,
  getSwapIndexInfo,
  getSwapRpcConfig,
  setSwapRpcConfig,
  isOfferExpiredOnChain,
} from "@app/swapBroadcast";
import { isOfferStale, offerAgeLabel } from "@app/swapExpiry";
import { useLiveQuery } from "dexie-react-hooks";
import { wallet, openModal, feeRate } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import { reverseRef } from "@lib/Outpoint";
import {
  ftScript,
  nftScript,
  p2pkhScript,
  parseFtScript,
  parseNftScript,
  parseP2pkhScript,
} from "@lib/script";
import { accumulateInputs, fundTx, SelectableInput } from "@lib/coinSelect";
import { buildTx } from "@lib/tx";
import rxdIcon from "/rxd.png";
import dayjs from "dayjs";
import Outpoint from "@lib/Outpoint";
import { decodeGlyph } from "@lib/token";
import { Transaction, Script } from "@radiant-core/radiantjs";
import { TransferError } from "@lib/transfer";
import { SwapPrepareError } from "./Swap";
import { Utxo } from "@lib/types";

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

function scriptMatchesContract(
  script: string,
  contractType: ContractType,
  tokenRefLE?: string
): boolean {
  if (contractType === ContractType.RXD) {
    return Boolean(parseP2pkhScript(script).address);
  }

  if (!tokenRefLE) {
    return false;
  }

  if (contractType === ContractType.NFT) {
    return parseNftScript(script).ref === tokenRefLE;
  }

  return parseFtScript(script).ref === tokenRefLE;
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
  offeredValue?: number;
  wantValue?: number;
  wantScript?: string;
  wantOutputs?: { script: string; value: number }[];
}

type SortField = "block" | "name" | "value" | "price";
type SortDirection = "asc" | "desc";
type ViewMode = "table" | "grid";
type FilterType = "all" | "ft" | "nft" | "names" | "rxd-in" | "rxd-out";

function formatRxd(satoshis: number): string {
  return `${(satoshis / 100000000).toFixed(8)} RXD`;
}

function formatCompactRxd(satoshis: number): string {
  const rxd = satoshis / 100000000;
  if (rxd >= 1000000) return `${(rxd / 1000000).toFixed(2)}M RXD`;
  if (rxd >= 1000) return `${(rxd / 1000).toFixed(2)}K RXD`;
  return `${rxd.toFixed(4)} RXD`;
}

function getPriceRatio(order: ParsedOrder): string | null {
  if (!order.wantValue || order.wantValue === 0) return null;
  if (order.offeredGlyph && !order.wantGlyph) {
    // Token for RXD (sell order)
    if (order.offeredValue && order.offeredValue > 0) {
      if (order.offeredGlyph.tokenType === SmartTokenType.FT) {
        const rxdPerToken = order.wantValue / order.offeredValue;
        return `1 ${
          order.offeredGlyph.ticker || order.offeredGlyph.name || "Token"
        } = ${rxdPerToken.toFixed(8)} RXD`;
      }
    }
    // NFT or unknown offered amount — show total price for 1 unit
    const rxdPerToken = order.wantValue / 100000000;
    return `1 ${
      order.offeredGlyph.ticker || order.offeredGlyph.name || "Token"
    } = ${rxdPerToken.toFixed(4)} RXD`;
  }
  if (!order.offeredGlyph && order.wantGlyph) {
    // RXD for Token (buy order)
    if (order.wantGlyph.tokenType === SmartTokenType.FT && order.wantValue > 0) {
      if (order.offeredValue && order.offeredValue > 0) {
        const tokensPerRxd = order.offeredValue / order.wantValue;
        return `1 RXD = ${tokensPerRxd.toFixed(8)} ${
          order.wantGlyph.ticker || order.wantGlyph.name || "Token"
        }`;
      }
      // Fallback: assume 1 RXD offered if UTXO value not yet resolved
      const tokensPerRxd = 100000000 / order.wantValue;
      return `1 RXD = ${tokensPerRxd.toFixed(8)} ${
        order.wantGlyph.ticker || order.wantGlyph.name || "Token"
      }`;
    }
    // NFT
    const rxdPrice = order.wantValue / 100000000;
    return `${rxdPrice.toFixed(4)} RXD per ${
      order.wantGlyph.ticker || order.wantGlyph.name || "Token"
    }`;
  }
  if (order.offeredGlyph && order.wantGlyph) {
    // Token for Token
    return `1 ${order.offeredGlyph.ticker || "Token"} ↔ ${
      order.wantGlyph.ticker || "Token"
    }`;
  }
  return null;
}

function useCopyToClipboard() {
  const toast = useToast();
  return useCallback(
    async (text: string, label?: string) => {
      try {
        await copyText(text);
        toast({
          status: "success",
          title: "Copied",
          description: `${label || "Text"} copied to clipboard`,
          duration: 2000,
        });
      } catch {
        toast({
          status: "error",
          title: "Copy failed",
          description: "Could not copy to clipboard",
          duration: 3000,
        });
      }
    },
    [toast]
  );
}

type TokenFunding = {
  inputs: SelectableInput[];
  outputs: { script: string; value: number }[];
};

async function fundFungible(
  refLE: string,
  value: number
): Promise<TokenFunding> {
  const fromScript = ftScript(wallet.value.address, refLE);
  const tokens = await db.txo.where({ script: fromScript, spent: 0 }).toArray();
  const accum = accumulateInputs(tokens, value);

  if (accum.sum < value) {
    throw new TransferError("Insufficient token balance");
  }

  const outputs = [];
  if (accum.sum > value) {
    outputs.push({ script: fromScript, value: accum.sum - value });
  }

  return { inputs: accum.inputs, outputs };
}

async function fundNonFungible(refLE: string): Promise<TokenFunding> {
  const fromScript = nftScript(wallet.value.address, refLE);
  const nft = await db.txo.where({ script: fromScript, spent: 0 }).first();
  if (!nft) {
    throw new SwapPrepareError("Token not found");
  }
  return { inputs: [nft], outputs: [] };
}

function TokenIcon({ glyph, size = 6 }: { glyph?: SmartToken; size?: number }) {
  if (!glyph) {
    return <Image src={rxdIcon} width={size} height={size} />;
  }
  if (isWaveNameGlyph(glyph)) {
    return <Icon as={HiOutlineAtSymbol} color="brand.400" boxSize={size} />;
  }
  return (
    <Box w={size} h={size}>
      <TokenContent glyph={glyph} thumbnail />
    </Box>
  );
}

function formatOfferedAmount(order: ParsedOrder): string {
  const { offeredGlyph, offeredValue } = order;
  if (!offeredValue) return "";
  if (!offeredGlyph) {
    return formatCompactRxd(offeredValue);
  }
  if (offeredGlyph.tokenType === SmartTokenType.FT) {
    return `${formatAmountCompact(offeredValue)} ${offeredGlyph.ticker || offeredGlyph.name || "tokens"}`;
  }
  return offeredGlyph.name || "NFT";
}

function formatWantAmount(order: ParsedOrder): string {
  const { wantGlyph, wantValue } = order;
  if (!wantValue) return "";
  if (!wantGlyph) {
    return formatCompactRxd(wantValue);
  }
  if (wantGlyph.tokenType === SmartTokenType.FT) {
    return `${formatAmountCompact(wantValue)} ${wantGlyph.ticker || wantGlyph.name || "tokens"}`;
  }
  return wantGlyph.name || "NFT";
}

function OrderCard({
  order,
  onAccept,
  onCopy,
  currentHeight = 0,
}: {
  order: ParsedOrder;
  onAccept: (order: ParsedOrder) => void;
  onCopy: (text: string, label: string) => void;
  currentHeight?: number;
}) {
  const { offer, offeredGlyph, wantGlyph, wantValue } = order;
  const priceRatio = getPriceRatio(order);
  const expired = isOfferStale(offer.block_height, currentHeight);
  const ageLabel = offerAgeLabel(offer.block_height, currentHeight);
  const offeredAmt = formatOfferedAmount(order);
  const wantAmt = formatWantAmount(order);

  return (
    <Card p={4}>
      <VStack align="stretch" spacing={3}>
        {/* Token icons and swap direction */}
        <Flex justify="space-between" align="center">
          <HStack spacing={2}>
            <TokenIcon glyph={offeredGlyph} size={8} />
            <Icon as={MdOutlineSwapHoriz} boxSize={5} color="gray.400" />
            <TokenIcon glyph={wantGlyph} size={8} />
          </HStack>
          <HStack spacing={1}>
            {expired && (
              <Badge colorScheme="red" variant="solid">
                Expired
              </Badge>
            )}
            <Badge colorScheme="blue" variant="subtle">
              Block {offer.block_height.toLocaleString()}
            </Badge>
          </HStack>
        </Flex>

        {/* Token names and amounts */}
        <Box>
          <HStack spacing={2}>
            <Text fontWeight="bold" fontSize="md">
              {offeredAmt || offeredGlyph?.name || "RXD"}
              {offeredGlyph?.ticker && (
                <Text as="span" fontSize="sm" color="gray.500" ml={2}>
                  ${offeredGlyph.ticker}
                </Text>
              )}
            </Text>
            <WaveExpiryBadge glyph={offeredGlyph} />
          </HStack>
          <Text fontSize="sm" color="gray.400">
            for{" "}
            <Text as="span" fontWeight="medium" color="gray.300">
              {wantAmt || wantGlyph?.name || formatCompactRxd(wantValue || 0)}
            </Text>
            {wantGlyph?.ticker && (
              <Text as="span" color="gray.500" ml={1}>
                (${wantGlyph.ticker})
              </Text>
            )}
          </Text>
        </Box>

        {/* Price ratio */}
        {priceRatio && (
          <Tag size="sm" colorScheme="green" variant="subtle">
            <TagLabel>{priceRatio}</TagLabel>
          </Tag>
        )}

        {/* Token ref with copy button */}
        {offeredGlyph && (
          <HStack spacing={2}>
            <Text fontSize="xs" color="gray.500" isTruncated maxW="200px">
              Ref: {offeredGlyph.ref.slice(0, 16)}...
              {offeredGlyph.ref.slice(-8)}
            </Text>
            <IconButton
              aria-label="Copy token ref"
              icon={<CopyIcon />}
              size="xs"
              variant="ghost"
              onClick={() => onCopy(offeredGlyph.ref, "Token ref")}
            />
          </HStack>
        )}

        <Divider />

        {expired && (
          <Text fontSize="xs" color="red.300">
            This offer is {ageLabel ?? "old"}. The price may be outdated — the
            maker has not cancelled it, so it can still execute at the original
            terms.
          </Text>
        )}

        {/* Accept button */}
        <Button
          size="sm"
          colorScheme={expired ? "red" : "blue"}
          width="100%"
          onClick={() => onAccept(order)}
        >
          {expired ? "Accept expired offer" : "Accept Offer"}
        </Button>
      </VStack>
    </Card>
  );
}

function OrderRow({
  order,
  onAccept,
  onCopy,
  currentHeight = 0,
}: {
  order: ParsedOrder;
  onAccept: (order: ParsedOrder) => void;
  onCopy?: (text: string, label: string) => void;
  currentHeight?: number;
}) {
  const { offer, offeredGlyph, wantGlyph, wantValue } = order;
  const priceRatio = getPriceRatio(order);
  const expired = isOfferStale(offer.block_height, currentHeight);
  const offeredAmt = formatOfferedAmount(order);
  const wantAmt = formatWantAmount(order);

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
          <HStack spacing={1}>
            <Text fontSize="sm" fontWeight="medium">
              {offeredAmt || offeredGlyph?.name || "RXD"}
            </Text>
            {onCopy && offeredGlyph && (
              <IconButton
                aria-label="Copy token ref"
                icon={<CopyIcon boxSize={3} />}
                size="xs"
                variant="ghost"
                height="16px"
                minW="16px"
                onClick={() => onCopy(offeredGlyph.ref, "Token ref")}
              />
            )}
          </HStack>
          <Text fontSize="xs" color="gray.500">
            {offeredGlyph?.ticker || ""}
          </Text>
          <WaveExpiryBadge glyph={offeredGlyph} />
          {priceRatio && (
            <Tag size="sm" colorScheme="green" variant="subtle" mt={1}>
              <TagLabel fontSize="10px">{priceRatio}</TagLabel>
            </Tag>
          )}
        </VStack>
      </Td>
      <Td>
        <VStack align="start" spacing={0}>
          <Text fontSize="sm" fontWeight="medium">
            {wantAmt || wantGlyph?.name || formatCompactRxd(wantValue || 0)}
          </Text>
          <WaveExpiryBadge glyph={wantGlyph} />
          {wantValue && !wantGlyph && (
            <Text fontSize="xs" color="gray.500">
              {formatRxd(wantValue)}
            </Text>
          )}
        </VStack>
      </Td>
      <Td display={{ base: "none", md: "table-cell" }}>
        <VStack align="start" spacing={0}>
          <HStack spacing={1}>
            <Text fontSize="xs" color="gray.500">
              Block {offer.block_height.toLocaleString()}
            </Text>
            {expired && (
              <Badge colorScheme="red" variant="solid" fontSize="9px">
                Expired
              </Badge>
            )}
          </HStack>
          {offerAgeLabel(offer.block_height, currentHeight) && (
            <Text fontSize="10px" color={expired ? "red.300" : "gray.600"}>
              {offerAgeLabel(offer.block_height, currentHeight)}
            </Text>
          )}
        </VStack>
      </Td>
      <Td>
        <Button
          size="sm"
          colorScheme={expired ? "red" : "blue"}
          onClick={() => onAccept(order)}
        >
          {"Accept"}
        </Button>
      </Td>
    </Tr>
  );
}

function describeAsset(
  contractType: ContractType,
  value: number,
  glyph?: SmartToken
): string {
  if (contractType === ContractType.RXD) {
    return `${photonsToRXD(value)} RXD`;
  }
  if (!glyph) {
    return contractType === ContractType.FT ? `${formatAmountCompact(value)} tokens` : "NFT";
  }
  if (glyph.tokenType === SmartTokenType.FT) {
    return `${formatAmountCompact(value)} ${glyph.ticker || glyph.name || "tokens"}`;
  }
  return glyph.name || "NFT";
}

function MyOfferRow({
  swap,
  onCopy,
  onCancel,
  cancelling,
}: {
  swap: TokenSwap;
  onCopy: (text: string, label: string) => void;
  onCancel: (swap: TokenSwap) => void;
  cancelling: boolean;
}) {
  const [fromGlyph, toGlyph] =
    useLiveQuery(
      async () => [
        swap.fromGlyph
          ? await db.glyph.where({ ref: swap.fromGlyph }).first()
          : undefined,
        swap.toGlyph
          ? await db.glyph.where({ ref: swap.toGlyph }).first()
          : undefined,
      ],
      [swap.fromGlyph, swap.toGlyph]
    ) || [];

  const fromText = describeAsset(swap.from, swap.fromValue, fromGlyph);
  const toText = describeAsset(swap.to, swap.toValue, toGlyph);

  const statusBadge =
    swap.status === SwapStatus.PENDING ? (
      <Badge colorScheme="green">Live</Badge>
    ) : swap.status === SwapStatus.COMPLETE ? (
      <Badge colorScheme="blue">Settled</Badge>
    ) : (
      <Badge colorScheme="gray">Cancelled</Badge>
    );

  const offeredIcon = fromGlyph ? (
    <Box w={6} h={6} flexShrink={0}>
      <TokenContent glyph={fromGlyph} thumbnail />
    </Box>
  ) : (
    <Image src={rxdIcon} width={6} height={6} flexShrink={0} />
  );
  const wantedIcon = toGlyph ? (
    <Box w={6} h={6} flexShrink={0}>
      <TokenContent glyph={toGlyph} thumbnail />
    </Box>
  ) : (
    <Image src={rxdIcon} width={6} height={6} flexShrink={0} />
  );

  return (
    <Tr>
      <Td>
        <Flex gap={2} alignItems="center" minW={0}>
          {offeredIcon}
          <Text isTruncated>{fromText}</Text>
          <Icon as={MdOutlineSwapHoriz} boxSize={5} color="gray.400" />
          {wantedIcon}
          <Text isTruncated>{toText}</Text>
        </Flex>
      </Td>
      <Td>{statusBadge}</Td>
      <Td display={{ base: "none", md: "table-cell" }} color="gray.500">
        {dayjs(swap.date).format("L LT")}
      </Td>
      <Td textAlign="right">
        <HStack spacing={1} justify="flex-end">
          {swap.broadcastTxid && (
            <>
              <Tooltip label="Copy advertisement txid">
                <IconButton
                  aria-label="Copy advertisement txid"
                  icon={<CopyIcon />}
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    onCopy(swap.broadcastTxid as string, "Advertisement txid")
                  }
                />
              </Tooltip>
              <Tooltip label="View on explorer">
                <IconButton
                  as="a"
                  aria-label="View advertisement on explorer"
                  icon={<ExternalLinkIcon />}
                  size="sm"
                  variant="ghost"
                  href={createExplorerUrl(swap.broadcastTxid)}
                  target="_blank"
                  rel="noreferrer"
                />
              </Tooltip>
            </>
          )}
          {swap.status === SwapStatus.PENDING && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onCancel(swap)}
              isLoading={cancelling}
            >
              Cancel
            </Button>
          )}
        </HStack>
      </Td>
    </Tr>
  );
}

function MyOffersPanel() {
  const toast = useToast();
  const copy = useCopyToClipboard();
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  const mySwaps = useLiveQuery(
    async () =>
      (await db.swap.where({ mode: SwapMode.BROADCAST }).toArray())
        .filter((s) => !!s.broadcastTxid)
        .sort((a, b) => b.date - a.date),
    []
  );

  if (!mySwaps || mySwaps.length === 0) return null;

  const handleCancel = async (swap: TokenSwap) => {
    if (wallet.value.locked) {
      openModal.value = { modal: "unlock" };
      return;
    }
    if (typeof swap.id !== "number") return;
    setCancellingId(swap.id);
    try {
      await cancelSwap(
        swap.from,
        swap.txid,
        swap.fromValue,
        swap.fromGlyph || undefined,
        swap.vout ?? 0,
        swap.swapAddress
      );
      await db.swap.update(swap.id, { status: SwapStatus.CANCEL });
      toast({ status: "success", title: "Swap cancelled" });
    } catch (error) {
      console.debug(error);
      toast({
        status: "error",
        title:
          error instanceof SwapError ? error.message : "Failed to cancel swap",
      });
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <Card p={4}>
      <VStack align="stretch" spacing={3}>
        <Flex justify="space-between" align="center" wrap="wrap" gap={2}>
          <Heading textStyle="h3">My Public Offers</Heading>
          <Text fontSize="xs" color="gray.500">
            Offers you have broadcast on-chain. Cancel to reclaim the asset.
          </Text>
        </Flex>
        <Box overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr bg="surface.sunken">
                <Th textStyle="label">Swap</Th>
                <Th textStyle="label">Status</Th>
                <Th textStyle="label" display={{ base: "none", md: "table-cell" }}>
                  Date
                </Th>
                <Th textStyle="label" textAlign="right">
                  Actions
                </Th>
              </Tr>
            </Thead>
            <Tbody>
              {mySwaps.map((swap) => (
                <MyOfferRow
                  key={swap.id ?? swap.txid}
                  swap={swap}
                  onCopy={copy}
                  onCancel={handleCancel}
                  cancelling={cancellingId === swap.id}
                />
              ))}
            </Tbody>
          </Table>
        </Box>
      </VStack>
    </Card>
  );
}

export default function OpenOrders({
  defaultFilter = "all",
}: {
  defaultFilter?: FilterType;
} = {}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const copyToClipboard = useCopyToClipboard();
  const [loading, setLoading] = useState(false);
  const [orders, setOrders] = useState<ParsedOrder[]>([]);
  // Glyphs resolved from an offer's prevout for offered NFTs not in local db
  // (the swap advertisement only carries a one-way hash of the ref, so the
  // recoverable identifier is the offered UTXO). Keyed by `${txid}:${vout}`.
  // `null` marks an attempt that found no glyph, so we don't retry it.
  const [resolvedGlyphs, setResolvedGlyphs] = useState<
    Map<string, SmartToken | null>
  >(new Map());
  // Offered UTXO values resolved by fetching the prevout transaction. Keyed by
  // `${txid}:${vout}`. Needed for FT price-per-token calculation (the swap index
  // amount/price fields carry the quote-side total, not the offered token amount).
  const [offeredValues, setOfferedValues] = useState<
    Map<string, number | null>
  >(new Map());
  const [searchRef, setSearchRef] = useState("");
  const [indexAvailable, setIndexAvailable] = useState<boolean | null>(null);
  const [rpcUrl, setRpcUrl] = useState(getSwapRpcConfig().url);
  const [showConfig, setShowConfig] = useState(false);

  // Sorting and filtering state
  const [sortField, setSortField] = useState<SortField>("block");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [filterType, setFilterType] = useState<FilterType>(defaultFilter);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [displayCount, setDisplayCount] = useState(20);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  // Chain tip reported by the swap index, used to date offers for soft expiry.
  const [currentHeight, setCurrentHeight] = useState(0);
  // Soft expiry: stale offers are hidden unless the user opts in. See
  // swapExpiry.ts and docs/swap-offer-expiry-cancellation.md.
  const [showExpired, setShowExpired] = useState(false);

  // Get all known glyphs for display
  const glyphs = useLiveQuery(() => db.glyph.toArray(), []);
  const glyphByTokenId = useMemo(
    () =>
      new Map(
        glyphs?.map((g) => [
          assetToSwapTokenId(
            g.tokenType === SmartTokenType.NFT
              ? ContractType.NFT
              : ContractType.FT,
            g.ref
          ),
          g,
        ]) || []
      ),
    [glyphs]
  );

  const normalizeTokenSearch = (tokenRef?: string) => {
    if (!tokenRef) {
      return undefined;
    }

    const trimmed = tokenRef.trim();
    if (trimmed.length === 72) {
      // A 72-hex glyph.ref (display/BE). The node swapindex tokenid is sha256 of
      // the little-endian ref, so derive it via assetToSwapTokenId (which reverses
      // before hashing) rather than refHash() — refHash would hash the BE form and
      // query the wrong book. The contract type only matters for the RXD
      // short-circuit, which a 72-hex ref never hits.
      return assetToSwapTokenId(ContractType.NFT, trimmed);
    }
    return trimmed;
  };

  const checkIndexAvailability = useCallback(async () => {
    try {
      const info = await getSwapIndexInfo();
      setIndexAvailable(info.enabled);
      if (typeof info.current_height === "number" && info.current_height > 0) {
        setCurrentHeight(info.current_height);
      }
      return info.enabled;
    } catch {
      setIndexAvailable(false);
      return false;
    }
  }, []);

  const fetchOrders = useCallback(
    async (tokenRef?: string) => {
      setLoading(true);
      try {
        let rawOrders: SwapOffer[] = [];

        if (tokenRef) {
          const tokenId = normalizeTokenSearch(tokenRef) as string;
          // Search by specific token
          const [byOffered, byWant] = await Promise.all([
            getOpenOrders(tokenId, 50).catch(() => []),
            getOpenOrdersByWant(tokenId, 50).catch(() => []),
          ]);
          rawOrders = [...byOffered, ...byWant];
        } else {
          // Get orders for all tokens the user owns. Two angles per token:
          //   - by-want: offers we could fulfill with the token (buyer side)
          //   - by-offered: offers selling the same token (liquidity view,
          //     plus surfaces our own published listings)
          const userGlyphs = glyphs?.filter((g) => g.spent === 0) || [];
          const tokenIds = userGlyphs
            .slice(0, 10)
            .map((glyph) =>
              assetToSwapTokenId(
                glyph.tokenType === SmartTokenType.NFT
                  ? ContractType.NFT
                  : ContractType.FT,
                glyph.ref
              )
            );

          const fetched = await Promise.all(
            tokenIds.flatMap((tokenId) => [
              getOpenOrders(tokenId, 20).catch(() => [] as SwapOffer[]),
              getOpenOrdersByWant(tokenId, 20).catch(() => [] as SwapOffer[]),
            ])
          );
          rawOrders = fetched.flat();
        }

        // Parse and enrich orders
        const parsed: ParsedOrder[] = rawOrders.map((offer) => {
          const terms = parsePriceTerms(offer.price_terms);
          return {
            offer,
            offeredGlyph:
              offer.tokenid === "00".repeat(32)
                ? undefined
                : glyphByTokenId.get(offer.tokenid),
            wantGlyph: offer.want_tokenid
              ? glyphByTokenId.get(offer.want_tokenid)
              : undefined,
            wantValue: terms?.value,
            wantScript: terms?.script,
            wantOutputs: terms?.outputs,
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
        setLastUpdated(new Date());
        setDisplayCount(20); // Reset pagination on new fetch
      } catch (error) {
        console.error("Failed to fetch orders:", error);
        toast({
          status: "error",
          title: "Failed to fetch open orders",
          description: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setLoading(false);
      }
    },
    [glyphByTokenId, glyphs, toast]
  );

  useEffect(() => {
    // A `?ref=` deep-link (e.g. from Browse Market) lands the user directly on a
    // specific token's order book. The ref is the 72-hex form, which
    // normalizeTokenSearch resolves to the swap-index tokenid.
    const refParam = searchParams.get("ref")?.trim();
    checkIndexAvailability().then((available) => {
      if (!available) return;
      if (refParam) {
        setSearchRef(refParam);
        fetchOrders(refParam);
      } else {
        fetchOrders();
      }
    });
  }, [checkIndexAvailability, fetchOrders, searchParams]);

  // Auto-refresh every 30 seconds when tab is visible
  useEffect(() => {
    if (!autoRefreshEnabled) return;

    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && !loading) {
        fetchOrders(searchRef.trim() || undefined);
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [autoRefreshEnabled, fetchOrders, loading, searchRef]);

  // Stable key for an offer's prevout
  const offerKey = (o: ParsedOrder) =>
    `${o.offer.utxo.txid}:${o.offer.utxo.vout}`;

  const RESOLVE_CAP = 30;

  // Merge any prevout-resolved glyphs AND offered UTXO values into the orders so
  // display and the "names" filter can see offered NFTs (incl. WAVE names) the
  // wallet doesn't own locally, and price-per-token ratios use the real offered
  // amount (the swap index amount/price fields carry the quote-side total only).
  const mergedOrders = useMemo(() => {
    if (resolvedGlyphs.size === 0 && offeredValues.size === 0) return orders;
    return orders.map((order) => {
      let patched = order;
      if (!order.offeredGlyph) {
        const resolved = resolvedGlyphs.get(offerKey(order));
        if (resolved) patched = { ...patched, offeredGlyph: resolved };
      }
      if (order.offeredValue === undefined) {
        const val = offeredValues.get(offerKey(order));
        if (val !== undefined && val !== null) {
          patched = { ...patched, offeredValue: val };
        }
      }
      return patched;
    });
  }, [orders, resolvedGlyphs, offeredValues]);

  // Resolve offered UTXO values by fetching each prevout transaction. The swap
  // index does not carry the offered amount — only the quote-side payout total
  // (amount/price/remaining_amount). For FT sell orders we need the offered
  // token quantity (the UTXO value in base units) to compute a correct
  // per-unit price ratio. Bounded per round to avoid excessive network calls.
  useEffect(() => {
    const pending = orders.filter(
      (o) => o.offeredValue === undefined && !offeredValues.has(offerKey(o))
    );
    if (pending.length === 0) return;
    const batch = pending.slice(0, RESOLVE_CAP);
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled(
        batch.map(async (o) => {
          const hex = await electrumWorker.value.getTransaction(
            o.offer.utxo.txid
          );
          if (!hex) return [offerKey(o), null] as const;
          const prevTx = new Transaction(hex);
          const out = prevTx.outputs[o.offer.utxo.vout];
          if (!out) return [offerKey(o), null] as const;
          return [offerKey(o), out.satoshis] as const;
        })
      );
      if (cancelled) return;
      setOfferedValues((prev) => {
        const next = new Map(prev);
        for (const o of batch) if (!next.has(offerKey(o))) next.set(offerKey(o), null);
        for (const r of results) {
          if (r.status === "fulfilled") next.set(r.value[0], r.value[1]);
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [orders, offeredValues]);

  // Resolve offered NFTs not in local db so the names market can identify and
  // display them. Only runs for the "names" filter to avoid extra network
  // calls elsewhere. The swap index has no "is-a-WAVE-name" predicate, so this
  // resolution is client-side and bounded per round — names beyond the cap
  // surface as you Load More or search by ref.
  useEffect(() => {
    if (filterType !== "names") return;
    const pending = orders.filter(
      (o) =>
        !o.offeredGlyph &&
        o.offer.offered_type === ContractType.NFT &&
        !resolvedGlyphs.has(offerKey(o))
    );
    if (pending.length === 0) return;
    const batch = pending.slice(0, RESOLVE_CAP);
    if (pending.length > RESOLVE_CAP) {
      console.warn(
        `Names market: resolving ${RESOLVE_CAP} of ${pending.length} unknown NFT offers this round; Load More or search by ref for the rest.`
      );
    }
    let cancelled = false;
    (async () => {
      const results = await Promise.allSettled(
        batch.map(async (o) => {
          const hex = await electrumWorker.value.getTransaction(
            o.offer.utxo.txid
          );
          if (!hex) return [offerKey(o), null] as const;
          const prevTx = new Transaction(hex);
          const out = prevTx.outputs[o.offer.utxo.vout];
          const refLE = out ? parseNftScript(out.script.toHex()).ref : "";
          if (!refLE) return [offerKey(o), null] as const;
          const glyph = await electrumWorker.value.fetchGlyph(
            reverseRef(refLE)
          );
          return [offerKey(o), glyph || null] as const;
        })
      );
      if (cancelled) return;
      setResolvedGlyphs((prev) => {
        const next = new Map(prev);
        // Mark every attempted offer (even failures) so we don't retry it.
        for (const o of batch) {
          if (!next.has(offerKey(o))) next.set(offerKey(o), null);
        }
        for (const r of results) {
          if (r.status === "fulfilled") next.set(r.value[0], r.value[1]);
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [filterType, orders, resolvedGlyphs]);

  // Filter and sort orders
  const filteredAndSortedOrders = useMemo(() => {
    let result = [...mergedOrders];

    // Apply filter
    if (filterType !== "all") {
      result = result.filter((order) => {
        const offeredIsFt = order.offeredGlyph?.tokenType === SmartTokenType.FT;
        const offeredIsNft =
          order.offeredGlyph?.tokenType === SmartTokenType.NFT;
        const offeredIsRxd = !order.offeredGlyph;
        const wantIsRxd = !order.wantGlyph;

        switch (filterType) {
          case "ft":
            return (
              offeredIsFt || order.wantGlyph?.tokenType === SmartTokenType.FT
            );
          case "nft":
            return (
              offeredIsNft || order.wantGlyph?.tokenType === SmartTokenType.NFT
            );
          case "names":
            return (
              isWaveNameGlyph(order.offeredGlyph) ||
              isWaveNameGlyph(order.wantGlyph)
            );
          case "rxd-in":
            return offeredIsRxd; // Offering RXD
          case "rxd-out":
            return wantIsRxd; // Wanting RXD
          default:
            return true;
        }
      });
    }

    // Soft expiry: hide stale offers unless the user opts in. Only applies when
    // we know the chain tip; an undateable offer is never hidden. This does not
    // bind an attacker holding a raw PSRT (see swapExpiry.ts) — it is taker
    // protection plus a cleaner default book.
    //
    // RSWP v3 consensus expiry: an offer past its on-chain `expiry_height` is
    // hidden by the SAME toggle (it is at least as stale as a soft-expired one);
    // unlike soft expiry, it is also hard-blocked at fill time (handleAcceptOrder).
    if (!showExpired && currentHeight > 0) {
      result = result.filter(
        (order) =>
          !isOfferStale(order.offer.block_height, currentHeight) &&
          !isOfferExpiredOnChain(order.offer, currentHeight)
      );
    }

    // Apply sort
    result.sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case "block":
          comparison = a.offer.block_height - b.offer.block_height;
          break;
        case "name": {
          const nameA = a.offeredGlyph?.name || "RXD";
          const nameB = b.offeredGlyph?.name || "RXD";
          comparison = nameA.localeCompare(nameB);
          break;
        }
        case "value": {
          const valueA = a.wantValue || 0;
          const valueB = b.wantValue || 0;
          comparison = valueA - valueB;
          break;
        }
        case "price": {
          // Sort by implied price ratio
          const getPrice = (o: ParsedOrder) => {
            if (o.wantValue && o.wantValue > 0) {
              if (o.offeredGlyph && !o.wantGlyph) return o.wantValue; // RXD per token
              if (!o.offeredGlyph && o.wantGlyph)
                return 100000000 / o.wantValue; // Tokens per RXD
            }
            return 0;
          };
          comparison = getPrice(a) - getPrice(b);
          break;
        }
      }

      return sortDirection === "asc" ? comparison : -comparison;
    });

    return result;
  }, [
    mergedOrders,
    sortField,
    sortDirection,
    filterType,
    showExpired,
    currentHeight,
  ]);

  // Number of currently-loaded offers past the soft-expiry window, for the
  // "Show expired" toggle caption.
  const expiredCount = useMemo(() => {
    if (currentHeight <= 0) return 0;
    return mergedOrders.filter((o) =>
      isOfferStale(o.offer.block_height, currentHeight)
    ).length;
  }, [mergedOrders, currentHeight]);

  // Paginated orders
  const displayedOrders = filteredAndSortedOrders.slice(0, displayCount);
  const hasMoreOrders = filteredAndSortedOrders.length > displayCount;

  // Sort toggle helper
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  // Load more handler
  const handleLoadMore = () => {
    setDisplayCount((prev) => prev + 20);
  };

  // Resolve a typed WAVE name (e.g. "alice.rxd") to its token ref via the
  // local glyph db (the indexer syncs other wallets' names here too).
  const resolveNameToRef = async (
    query: string
  ): Promise<string | undefined> => {
    const parts = query.toLowerCase().split(".");
    const bareName = parts[0];
    const domain = parts[1] || "rxd";
    const match = await db.glyph
      .filter((g) => {
        if (!isWaveNameGlyph(g) || g.spent !== 0) return false;
        const attrs = g.attrs as Record<string, string> | undefined;
        if (!attrs) return false;
        return (
          (attrs.name || "").toLowerCase() === bareName &&
          (attrs.domain || "rxd").toLowerCase() === domain
        );
      })
      .first();
    return match?.ref;
  };

  const handleSearch = async () => {
    const query = searchRef.trim();
    if (!query) {
      fetchOrders();
      return;
    }
    // A 72-hex token ref is handled directly by fetchOrders.
    if (/^[0-9a-f]{72}$/i.test(query)) {
      fetchOrders(query);
      return;
    }
    // Otherwise try to resolve it as a WAVE name to its token ref.
    const ref = await resolveNameToRef(query);
    if (ref) {
      setFilterType("names");
      fetchOrders(ref);
    } else {
      fetchOrders(query);
    }
  };

  const handleAcceptOrder = async (order: ParsedOrder) => {
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock" };
      return;
    }

    // RSWP v3 CONSENSUS expiry (hard block). An offer carrying an
    // `expiry_height` is held in a timelocked-refund covenant and becomes
    // unfillable once the chain reaches that height — the maker can (and will)
    // reclaim the reserved asset, so any completion we build would be a
    // guaranteed double-spend race we should never broadcast. Refuse outright.
    // (v2 offers have no expiry_height and fall through to the soft check.)
    if (isOfferExpiredOnChain(order.offer, currentHeight)) {
      toast({
        status: "error",
        title: "Offer has expired",
        description: `This offer expired at block ${order.offer.expiry_height?.toLocaleString()} (chain tip ${currentHeight.toLocaleString()}). The maker can reclaim the reserved asset, so it can no longer be filled.`,
      });
      return;
    }

    // Soft expiry: warn before filling a stale offer. The user must have toggled
    // "Show expired" to reach this (stale offers are hidden by default), so this
    // is a reminder, not a hard block — the offer is still on-chain and valid.
    if (isOfferStale(order.offer.block_height, currentHeight)) {
      const label = offerAgeLabel(order.offer.block_height, currentHeight);
      toast({
        status: "warning",
        title: "Accepting an expired offer",
        description: `This offer is ${
          label ?? "old"
        }. Its price may be outdated — confirm the terms before it broadcasts.`,
      });
    }

    try {
      const rawTx = await electrumWorker.value.getTransaction(
        order.offer.utxo.txid
      );
      if (!rawTx) {
        throw new Error("Could not fetch transaction");
      }
      const prevTx = new Transaction(rawTx);
      const offeredOutput = prevTx.outputs[order.offer.utxo.vout];
      if (!offeredOutput) {
        throw new Error("Could not locate offered output");
      }

      if (!order.offer.signature) {
        throw new Error("Offer is missing maker signature");
      }

      const makerTerms = parsePriceTerms(order.offer.price_terms);
      if (!makerTerms || makerTerms.outputs.length === 0) {
        throw new Error("Offer has invalid price terms");
      }

      // SECURITY: Reject multi-output offers until UI can properly display all outputs
      // See: Security Audit C3 - Open-orders swap take silently funds attacker-controlled extra outputs
      if (makerTerms.outputs.length > 1) {
        throw new Error(
          "Multi-output swap offers are not supported. The offer may be malicious."
        );
      }

      const coins: SelectableInput[] = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      const fromRefLE = order.offeredGlyph?.ref
        ? reverseRef(order.offeredGlyph.ref)
        : "";
      const wantRefLE = order.wantGlyph?.ref
        ? reverseRef(order.wantGlyph.ref)
        : undefined;

      if (
        !scriptMatchesContract(
          offeredOutput.script.toHex(),
          order.offeredGlyph
            ? order.offeredGlyph.tokenType === SmartTokenType.NFT
              ? ContractType.NFT
              : ContractType.FT
            : ContractType.RXD,
          fromRefLE || undefined
        )
      ) {
        throw new Error("Offer prevout script does not match advertised asset");
      }

      if (
        !scriptMatchesContract(
          makerTerms.outputs[0].script,
          order.wantGlyph
            ? order.wantGlyph.tokenType === SmartTokenType.NFT
              ? ContractType.NFT
              : ContractType.FT
            : ContractType.RXD,
          wantRefLE
        )
      ) {
        throw new Error(
          "Offer payment output does not match advertised wanted asset"
        );
      }

      try {
        Script.fromHex(order.offer.signature);
      } catch {
        throw new Error("Offer signature is not valid scriptSig hex");
      }

      const receiveScript = !order.offeredGlyph
        ? p2pkhScript(wallet.value.address)
        : order.offeredGlyph.tokenType === SmartTokenType.FT
        ? ftScript(wallet.value.address, fromRefLE)
        : nftScript(wallet.value.address, fromRefLE);

      const inputs: Utxo[] = [
        {
          txid: order.offer.utxo.txid,
          vout: order.offer.utxo.vout,
          script: offeredOutput.script.toString(),
          value: offeredOutput.satoshis,
        },
      ];

      const outputs = [
        ...makerTerms.outputs,
        {
          script: receiveScript,
          value: offeredOutput.satoshis,
        },
      ];

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

      if (order.wantGlyph) {
        const toRefLE = reverseRef(order.wantGlyph.ref);
        if (order.wantGlyph.tokenType === SmartTokenType.FT) {
          const prepared = await fundFungible(toRefLE, order.wantValue || 0);
          inputs.push(...prepared.inputs);
          outputs.push(...prepared.outputs);
        } else {
          const prepared = await fundNonFungible(toRefLE);
          inputs.push(...prepared.inputs);
          outputs.push(...prepared.outputs);
        }
      }

      const changeScript = p2pkhScript(wallet.value.address);
      const fund = fundTx(
        wallet.value.address,
        coins,
        inputs,
        outputs,
        changeScript,
        feeRate.value
      );

      if (!fund.funded) {
        throw new Error("Insufficient funds to complete swap");
      }

      const allInputs = [...inputs, ...fund.funding];
      const allOutputs = [...outputs, ...fund.change];

      const tx = buildTx(
        wallet.value.address,
        wallet.value.wif.toString(),
        allInputs,
        allOutputs,
        false,
        (index, script) => {
          if (index === 0) {
            return Script.fromHex(order.offer.signature);
          }
          return script;
        }
      );

      // Broadcast the completed transaction
      const txid = await electrumWorker.value.broadcast(tx.toString());

      // If a WAVE name was acquired, nudge the buyer to re-point it at their
      // own address. The new NFT UTXO may not be indexed yet, so route them to
      // the WAVE Names page where the "Target Update Required" prompt fires
      // once the wallet syncs (rather than repointing inline here).
      const acquiredName = getWaveDisplay(order.offeredGlyph);
      if (acquiredName) {
        toast({
          status: "success",
          duration: 12000,
          isClosable: true,
          render: ({ onClose }) => (
            <Alert status="success" borderRadius="md" alignItems="start">
              <AlertIcon />
              <Box flex={1}>
                <Text fontWeight="bold">Acquired {acquiredName.full}</Text>
                <Text fontSize="sm">
                  Point this name at your address from WAVE Names.
                </Text>
                <Button
                  size="sm"
                  mt={2}
                  colorScheme="green"
                  onClick={() => {
                    onClose();
                    navigate("/wave-names");
                  }}
                >
                  Go to WAVE Names
                </Button>
              </Box>
            </Alert>
          ),
        });
      } else {
        toast({
          status: "success",
          title: "Swap accepted!",
          description: `Transaction: ${txid.substring(0, 16)}...`,
        });
      }

      // Refresh orders
      fetchOrders();
    } catch (error) {
      console.error("Failed to accept order:", error);
      toast({
        status: "error",
        title: "Failed to accept swap",
        description: error instanceof Error ? error.message : "Unknown error",
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
      <Container maxW="container.xl" px={4}>
        <VStack spacing={4} align="stretch">
          <MyOffersPanel />
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
        </VStack>
      </Container>
    );
  }

  // Smart empty state message
  const getEmptyStateMessage = () => {
    const hasSearch = searchRef.trim().length > 0;
    // "No tokens in wallet" only applies to the default (own-tokens) view. When the
    // user is looking at a specific listing (e.g. deep-linked from Browse Market),
    // the wallet's own holdings are irrelevant — speak to the search instead.
    if (!hasSearch && (!glyphs || glyphs.length === 0)) {
      return {
        title: "No tokens in wallet",
        description:
          "You don't own any tokens yet. Acquire tokens to see swap offers for them here.",
      };
    }
    if (orders.length === 0) {
      return hasSearch
        ? {
            title: "No open orders for this listing",
            description:
              "This offer may have been filled or cancelled, or it isn't in this swap server's index. Try a different swap server in Settings, or check back later.",
          }
        : {
            title: "No open orders found",
            description:
              "There are currently no open swap orders for tokens you own. Check back later or create your own swap offer.",
          };
    }
    if (filteredAndSortedOrders.length === 0) {
      return {
        title: "No matching orders",
        description:
          "Try adjusting your filters or search criteria to see more results.",
      };
    }
    return null;
  };

  const emptyState = getEmptyStateMessage();

  return (
    <Container maxW="container.xl" px={4}>
      <VStack spacing={4} align="stretch">
        {/* Header with controls */}
        <Flex justify="space-between" align="center" wrap="wrap" gap={2}>
          <Heading textStyle="h2">{"Open Orders"}</Heading>
          <HStack spacing={2}>
            {lastUpdated && (
              <HStack
                spacing={1}
                color="gray.500"
                fontSize="xs"
                display={{ base: "none", md: "flex" }}
              >
                <Icon as={TimeIcon} boxSize={3} />
                <Text>Updated {dayjs(lastUpdated).format("HH:mm:ss")}</Text>
              </HStack>
            )}
            <Tooltip
              label={
                autoRefreshEnabled ? "Auto-refresh on" : "Auto-refresh off"
              }
            >
              <IconButton
                aria-label="Toggle auto-refresh"
                icon={<Icon as={MdRefresh} />}
                size="sm"
                variant={autoRefreshEnabled ? "solid" : "ghost"}
                colorScheme={autoRefreshEnabled ? "green" : "gray"}
                onClick={() => setAutoRefreshEnabled(!autoRefreshEnabled)}
              />
            </Tooltip>
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
              {"Refresh"}
            </Button>
          </HStack>
        </Flex>

        {/* Config panel */}
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

        {/* The wallet's own broadcast offers, read from local db */}
        <MyOffersPanel />

        {/* Search and filters */}
        <Card p={4}>
          <VStack spacing={3} align="stretch">
            {/* Search bar */}
            <InputGroup>
              <InputLeftElement pointerEvents="none">
                <SearchIcon color="gray.400" />
              </InputLeftElement>
              <Input
                placeholder={"Search by token ref or name..."}
                value={searchRef}
                onChange={(e) => setSearchRef(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && handleSearch()}
              />
              <Button ml={2} onClick={handleSearch} isLoading={loading}>
                {"Search"}
              </Button>
            </InputGroup>

            {/* Filter and view controls */}
            <Flex justify="space-between" align="center" wrap="wrap" gap={2}>
              <HStack spacing={2}>
                <Icon as={MdFilterList} color="gray.400" />
                <Select
                  size="sm"
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value as FilterType)}
                  width="140px"
                  aria-label="Filter by type"
                >
                  <option value="all">All Types</option>
                  <option value="ft">Fungible</option>
                  <option value="nft">NFT</option>
                  <option value="names">WAVE Names</option>
                  <option value="rxd-in">Buying RXD</option>
                  <option value="rxd-out">Selling RXD</option>
                </Select>
                <Tooltip label="Offers older than ~30 days are hidden by default. They have no on-chain expiry and can still execute at the original price unless the maker cancels them.">
                  <Box>
                    <Checkbox
                      size="sm"
                      isChecked={showExpired}
                      onChange={(e) => setShowExpired(e.target.checked)}
                    >
                      Show expired
                      {expiredCount > 0 ? ` (${expiredCount})` : ""}
                    </Checkbox>
                  </Box>
                </Tooltip>
              </HStack>

              <ButtonGroup size="sm" isAttached variant="outline">
                <IconButton
                  aria-label="Table view"
                  icon={<Icon as={MdTableRows} />}
                  colorScheme={viewMode === "table" ? "blue" : undefined}
                  onClick={() => setViewMode("table")}
                />
                <IconButton
                  aria-label="Grid view"
                  icon={<Icon as={MdGridView} />}
                  colorScheme={viewMode === "grid" ? "blue" : undefined}
                  onClick={() => setViewMode("grid")}
                />
              </ButtonGroup>
            </Flex>

            {/* Names market discovery notice */}
            {filterType === "names" && (
              <Alert status="info" borderRadius="md" fontSize="sm">
                <AlertIcon />
                <Text>
                  Showing WAVE name listings among loaded offers. The swap index
                  can't enumerate every name for sale — search a name (e.g.{" "}
                  <Text as="span" fontFamily="mono">
                    alice.rxd
                  </Text>
                  ) or paste a token ref to find a specific listing.
                </Text>
              </Alert>
            )}

            {/* Stats */}
            {orders.length > 0 && (
              <Flex
                justify="space-between"
                align="center"
                fontSize="sm"
                color="gray.500"
              >
                <Text>
                  Showing {displayedOrders.length} of{" "}
                  {filteredAndSortedOrders.length} orders
                  {filteredAndSortedOrders.length !== orders.length &&
                    ` (filtered from ${orders.length})`}
                </Text>
              </Flex>
            )}
          </VStack>
        </Card>

        {/* Results */}
        <Card>
          {loading && orders.length === 0 ? (
            <VStack p={8} spacing={4}>
              <Skeleton height="40px" width="100%" bg="surface.sunken" />
              <Skeleton height="40px" width="100%" bg="surface.sunken" />
              <Skeleton height="40px" width="100%" bg="surface.sunken" />
            </VStack>
          ) : emptyState ? (
            <Box pb={8}>
              <NoContent icon={TbInbox} subtitle={emptyState.description}>
                {emptyState.title}
              </NoContent>
            </Box>
          ) : viewMode === "table" ? (
            <Box overflowX="auto">
              <Table size="sm">
                <Thead>
                  <Tr bg="surface.sunken">
                    <Th textStyle="label">{"Swap"}</Th>
                    <Th
                      textStyle="label"
                      cursor="pointer"
                      onClick={() => handleSort("name")}
                      _hover={{ color: "blue.400" }}
                    >
                      {"Offering"}{" "}
                      {sortField === "name" &&
                        (sortDirection === "asc" ? "↑" : "↓")}
                    </Th>
                    <Th
                      textStyle="label"
                      cursor="pointer"
                      onClick={() => handleSort("value")}
                      _hover={{ color: "blue.400" }}
                    >
                      {"Wants"}{" "}
                      {sortField === "value" &&
                        (sortDirection === "asc" ? "↑" : "↓")}
                    </Th>
                    <Th
                      textStyle="label"
                      display={{ base: "none", md: "table-cell" }}
                      cursor="pointer"
                      onClick={() => handleSort("block")}
                      _hover={{ color: "blue.400" }}
                    >
                      {"Block"}{" "}
                      {sortField === "block" &&
                        (sortDirection === "asc" ? "↑" : "↓")}
                    </Th>
                    <Th></Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {displayedOrders.map((order, idx) => (
                    <OrderRow
                      key={`${order.offer.utxo.txid}-${order.offer.utxo.vout}-${idx}`}
                      order={order}
                      onAccept={handleAcceptOrder}
                      onCopy={copyToClipboard}
                      currentHeight={currentHeight}
                    />
                  ))}
                </Tbody>
              </Table>
            </Box>
          ) : (
            <Grid
              templateColumns={{
                base: "1fr",
                md: "repeat(2, 1fr)",
                lg: "repeat(3, 1fr)",
              }}
              gap={4}
              p={4}
            >
              {displayedOrders.map((order, idx) => (
                <GridItem
                  key={`${order.offer.utxo.txid}-${order.offer.utxo.vout}-${idx}`}
                >
                  <OrderCard
                    order={order}
                    onAccept={handleAcceptOrder}
                    onCopy={copyToClipboard}
                    currentHeight={currentHeight}
                  />
                </GridItem>
              ))}
            </Grid>
          )}

          {/* Load more */}
          {hasMoreOrders && (
            <Box p={4} textAlign="center">
              <Button
                size="sm"
                variant="outline"
                onClick={handleLoadMore}
                isLoading={loading}
              >
                Load More ({filteredAndSortedOrders.length - displayCount}{" "}
                remaining)
              </Button>
            </Box>
          )}
        </Card>

        {/* Help text */}
        <Alert status="info" variant="subtle">
          <AlertIcon />
          <Box>
            <Text fontWeight="medium">{"How it works"}</Text>
            <Text fontSize="sm">
              {
                "Browse swap offers broadcast to the network. When you accept an offer, you complete the atomic swap by providing the requested asset and broadcasting the final transaction."
              }
            </Text>
          </Box>
        </Alert>
      </VStack>
    </Container>
  );
}
