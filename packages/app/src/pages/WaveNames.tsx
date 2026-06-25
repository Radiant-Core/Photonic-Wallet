import { useState, useEffect } from "react";
import {
  Container,
  VStack,
  HStack,
  Text,
  Button,
  Badge,
  Box,
  Flex,
  Input,
  InputGroup,
  InputLeftElement,
  Icon,
  Tabs,
  TabList,
  TabPanels,
  Tab,
  TabPanel,
  useToast,
  Spinner,
  Alert,
  AlertIcon,
  FormControl,
  FormLabel,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalFooter,
  ModalBody,
  ModalCloseButton,
  useDisclosure,
  Divider,
  IconButton,
  Tooltip,
} from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import { useNavigate } from "react-router-dom";
import {
  SearchIcon,
  ExternalLinkIcon,
  CopyIcon,
  DeleteIcon,
} from "@chakra-ui/icons";
import { HiOutlineAtSymbol } from "react-icons/hi";
import {
  MdEdit,
  MdRefresh,
  MdOpenInNew,
  MdContentCopy,
  MdDelete,
  MdSend,
  MdStar,
  MdStarBorder,
  MdSell,
  MdStorefront,
  MdAccountBalanceWallet,
} from "react-icons/md";
import PageHeader from "@app/components/PageHeader";
import ContentContainer from "@app/components/ContentContainer";
import NoContent from "@app/components/NoContent";
import Card from "@app/components/Card";
import { wallet, feeRate, openModal } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import db from "@app/db";
import {
  SmartTokenType,
  TxO,
  ContractType,
  SwapStatus,
  SwapError,
} from "@app/types";
import { cancelSwap } from "@app/swap";
import { GLYPH_WAVE } from "@lib/protocols";
import {
  validateWaveName,
  canReclaimWaveName,
  createWaveReclaimMetadata,
  GRACE_PERIOD,
} from "@lib/wave";
import { updateWaveTarget } from "@app/waveTarget";
import { photonsToRXD } from "@lib/format";
import createExplorerUrl from "@app/network/createExplorerUrl";
import Outpoint from "@lib/Outpoint";
import { isP2pkh, p2pkhScript } from "@lib/script";
import { updateRxdBalances, updateWalletUtxos } from "@app/utxos";
import { burnNft } from "@lib/burn";
import { transferNonFungible, TransferError } from "@lib/transfer";
import { SelectableInput } from "@lib/coinSelect";
import { UnfinalizedInput } from "@lib/types";

interface WaveNameRecord {
  ref: string;
  name: string;
  target: string;
  domain: string;
  expires?: number;
  height: number;
  status: "active" | "expiring" | "expired" | "grace" | "reclaimable";
  id?: number;
  txoId?: number;
  needsTargetUpdate?: boolean;
  reclaimableAfter?: number;
  gracePeriodEnd?: number;
  // True while the name is escrowed in a pending swap (listed for sale). The
  // NFT has been moved to the swap address, so on-chain actions that spend it
  // (edit/send/burn/reclaim) must be blocked until the listing is cancelled.
  listed?: boolean;
}

interface RecentLookup {
  name: string;
  target: string;
  timestamp: number;
}

export default function WaveNames() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState(0);
  const [resolveQuery, setResolveQuery] = useState("");
  const [resolveResult, setResolveResult] = useState<{
    name: string;
    target: string;
  } | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentLookups, setRecentLookups] = useState<RecentLookup[]>([]);
  const [cachedNames, setCachedNames] = useState<WaveNameRecord[] | null>(null);
  const [isLoadingNames, setIsLoadingNames] = useState(true);
  const toast = useToast();
  const [showRecover, setShowRecover] = useState(false);
  const [recoverQuery, setRecoverQuery] = useState("");
  const [isRecovering, setIsRecovering] = useState(false);

  // Recover a WAVE name you own that's missing from the list. Needed when the
  // local record was lost (e.g. a wallet rebuild) AND the name rests under an
  // auth-covenant singleton after a target update, so it never appears in the
  // ordinary NFT sync. Seeds it from the chain by name; see
  // NFTWorker.recoverWaveName.
  const handleRecover = async () => {
    const q = recoverQuery.trim();
    if (!q || isRecovering) return;
    setIsRecovering(true);
    try {
      const res = await electrumWorker.value.recoverWaveName(q);
      if (res.recovered) {
        toast({
          title: "Name recovered",
          description: `${res.name}.rxd is back in your wallet.`,
          status: "success",
          duration: 6000,
          isClosable: true,
        });
        setRecoverQuery("");
        setShowRecover(false);
      } else {
        toast({
          title: "Could not recover that name",
          description: res.reason || "Unknown error",
          status: "warning",
          duration: 8000,
          isClosable: true,
        });
      }
    } catch (e) {
      toast({
        title: "Recovery failed",
        description: e instanceof Error ? e.message : String(e),
        status: "error",
        duration: 8000,
        isClosable: true,
      });
    } finally {
      setIsRecovering(false);
    }
  };

  // Load recent lookups from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("waveRecentLookups");
    if (saved) {
      try {
        setRecentLookups(JSON.parse(saved));
      } catch {
        // ignore parse errors
      }
    }
  }, []);

  // Load cached names from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("waveCachedNames");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Convert date strings back to dates if needed
        setCachedNames(parsed);
      } catch {
        // ignore parse errors
      }
    }
    setIsLoadingNames(false);
  }, []);

  // Save recent lookups
  const addRecentLookup = (name: string, target: string) => {
    const newLookup: RecentLookup = {
      name,
      target,
      timestamp: Date.now(),
    };
    const updated = [
      newLookup,
      ...recentLookups.filter((l) => l.name !== name),
    ].slice(0, 10);
    setRecentLookups(updated);
    localStorage.setItem("waveRecentLookups", JSON.stringify(updated));
  };

  const clearRecentLookups = () => {
    setRecentLookups([]);
    localStorage.removeItem("waveRecentLookups");
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copied!",
      description: `${label} copied to clipboard`,
      status: "success",
      duration: 2000,
    });
  };

  // Fetch user's primary WAVE name preference
  const primaryWaveName = useLiveQuery(async () => {
    const preference = (await db.kvp.get("primaryWaveName")) as
      | string
      | undefined;
    return preference;
  }, []);

  // Fetch WAVE names owned by wallet
  const waveNames = useLiveQuery(async () => {
    const tokens = await db.glyph
      .where("tokenType")
      .equals(SmartTokenType.NFT)
      .filter((glyph) => {
        // Check if it's a WAVE name (has WAVE protocol)
        return glyph.spent === 0 && !!glyph.p?.includes(GLYPH_WAVE);
      })
      .toArray();

    const records: WaveNameRecord[] = [];
    for (const token of tokens) {
      const attrs = token.attrs as Record<string, string> | undefined;
      if (attrs?.name) {
        // Always use expiration (defaults to 2 years from registration)
        const expires = attrs.expires ? parseInt(attrs.expires) : 0;
        const now = Math.floor(Date.now() / 1000);
        const gracePeriodEnd = expires + GRACE_PERIOD;

        // Get current blockchain height for reclaim check
        const currentHeight = await electrumWorker.value.getBlockHeight();
        const { canReclaim, reclaimableAfter } = canReclaimWaveName(
          expires,
          currentHeight,
          token.height || 0
        );

        let status:
          | "active"
          | "expiring"
          | "expired"
          | "grace"
          | "reclaimable" = "active";

        if (expires > 0) {
          const daysUntilExpiry = Math.floor((expires - now) / 86400);

          if (canReclaim) {
            status = "reclaimable";
          } else if (now > gracePeriodEnd) {
            status = "expired";
          } else if (now > expires) {
            status = "grace";
          } else if (daysUntilExpiry <= 30) {
            status = "expiring";
          }
        }

        // Check if target needs update (transferred from another owner)
        const target = attrs.target || "";
        const needsTargetUpdate = !!(
          target &&
          target !== wallet.value.address &&
          !target.startsWith("ref:") &&
          !target.startsWith("op:") &&
          isP2pkh(target)
        );

        records.push({
          ref: token.ref,
          name: `${attrs.name}${attrs.domain ? `.${attrs.domain}` : ".rxd"}`,
          target,
          domain: attrs.domain || "rxd",
          expires,
          height: token.height || 0,
          status,
          id: token.id,
          txoId: token.lastTxoId,
          needsTargetUpdate,
          reclaimableAfter,
          gracePeriodEnd,
          listed: !!token.swapPending,
        });
      }
    }
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  // Save names to localStorage when they load
  useEffect(() => {
    if (waveNames && waveNames.length > 0) {
      localStorage.setItem("waveCachedNames", JSON.stringify(waveNames));
      setCachedNames(waveNames);
      setIsLoadingNames(false);
    } else if (waveNames !== undefined) {
      // If waveNames is empty array (not undefined), still update cache
      localStorage.setItem("waveCachedNames", JSON.stringify(waveNames));
      setCachedNames(waveNames);
      setIsLoadingNames(false);
    }
  }, [waveNames]);

  // Use cached names while loading, or live data when available
  const displayNames = waveNames ?? cachedNames ?? [];

  // Filter names based on search
  const filteredNames = displayNames.filter(
    (record) =>
      searchQuery === "" ||
      record.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      record.target.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleResolve = async () => {
    if (!resolveQuery.trim()) return;

    const fullName = resolveQuery.includes(".")
      ? resolveQuery
      : `${resolveQuery}.rxd`;
    const validation = validateWaveName(fullName);

    if (!validation.valid) {
      toast({
        title: "Invalid name",
        description: validation.error,
        status: "error",
      });
      return;
    }

    setIsResolving(true);
    try {
      // Query RXinDexer for WAVE resolution
      const result = await electrumWorker.value.resolveWaveName(fullName);
      if (result) {
        setResolveResult({ name: fullName, target: result.target });
        addRecentLookup(fullName, result.target);
      } else {
        toast({
          title: "Name not found",
          description: `${fullName} is not registered`,
          status: "warning",
        });
        setResolveResult(null);
      }
    } catch (error) {
      toast({
        title: "Resolution failed",
        description: String(error),
        status: "error",
      });
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <Container maxW="container.lg" py={8}>
      <PageHeader>{"WAVE Names"}</PageHeader>

      <Tabs
        index={activeTab}
        onChange={setActiveTab}
        variant="enclosed"
        colorScheme="brand"
      >
        <TabList>
          <Tab>{"My Names"}</Tab>
          <Tab>{"Resolver"}</Tab>
          <Tab>{"Register"}</Tab>
        </TabList>

        <TabPanels>
          {/* My Names Tab */}
          <TabPanel>
            <ContentContainer>
              <Flex justify="space-between" align="center" mb={4} gap={2}>
                <Button
                  size="sm"
                  variant="ghost"
                  colorScheme="purple"
                  onClick={() => setShowRecover((v) => !v)}
                >
                  {"Recover a name"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  colorScheme="purple"
                  leftIcon={<Icon as={MdStorefront} />}
                  onClick={() => navigate("/market?filter=names")}
                >
                  {"Browse Names for Sale"}
                </Button>
              </Flex>
              {showRecover && (
                <Flex gap={2} mb={4} align="center">
                  <Input
                    placeholder={"Name to recover (e.g. 12345.rxd)"}
                    value={recoverQuery}
                    onChange={(e) => setRecoverQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRecover();
                    }}
                  />
                  <Button
                    colorScheme="brand"
                    isLoading={isRecovering}
                    loadingText={"Recovering"}
                    onClick={handleRecover}
                  >
                    {"Recover"}
                  </Button>
                </Flex>
              )}
              {isLoadingNames && displayNames.length === 0 ? (
                <VStack spacing={4} align="center" py={8}>
                  <Spinner size="lg" color="brand.400" />
                  <Text color="text.secondary">Loading your WAVE names...</Text>
                </VStack>
              ) : !displayNames.length ? (
                <NoContent
                  icon={HiOutlineAtSymbol}
                  subtitle="Register a name to give your wallet a memorable, human-readable identity."
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setActiveTab(2)}
                    >
                      {"Register your first name"}
                    </Button>
                  }
                >
                  {"You don't own any WAVE names yet."}
                </NoContent>
              ) : (
                <VStack spacing={4} align="stretch">
                  {/* Loading indicator for cached data */}
                  {isLoadingNames && cachedNames && !waveNames && (
                    <HStack spacing={2} color="text.muted">
                      <Spinner size="xs" />
                      <Text fontSize="xs">Refreshing names...</Text>
                    </HStack>
                  )}

                  {/* Search */}
                  <InputGroup>
                    <InputLeftElement pointerEvents="none">
                      <SearchIcon color="text.muted" />
                    </InputLeftElement>
                    <Input
                      placeholder={"Search your names..."}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </InputGroup>

                  {/* Results count */}
                  {(searchQuery || isLoadingNames) && (
                    <Text fontSize="sm" color="text.muted">
                      {filteredNames.length === 0
                        ? "No names found"
                        : `Showing ${filteredNames.length} of ${
                            displayNames.length
                          } names${isLoadingNames ? " (loading...)" : ""}`}
                    </Text>
                  )}

                  {filteredNames.map((record) => (
                    <WaveNameCard
                      key={record.ref}
                      record={record}
                      primaryName={primaryWaveName}
                      onCopy={(text, label) => copyToClipboard(text, label)}
                    />
                  ))}
                </VStack>
              )}
            </ContentContainer>
          </TabPanel>

          {/* Resolver Tab */}
          <TabPanel>
            <ContentContainer>
              <VStack spacing={6} align="stretch">
                <FormControl>
                  <FormLabel textStyle="label">{"Lookup WAVE Name"}</FormLabel>
                  <InputGroup>
                    <InputLeftElement pointerEvents="none">
                      <Icon as={HiOutlineAtSymbol} color="text.muted" />
                    </InputLeftElement>
                    <Input
                      value={resolveQuery}
                      onChange={(e) => setResolveQuery(e.target.value)}
                      placeholder={"alice.rxd"}
                      onKeyDown={(e) => e.key === "Enter" && handleResolve()}
                    />
                  </InputGroup>
                </FormControl>

                <Button
                  variant="primary"
                  onClick={handleResolve}
                  isLoading={isResolving}
                  loadingText={"Resolving..."}
                  leftIcon={<SearchIcon />}
                >
                  {"Resolve Name"}
                </Button>

                {resolveResult && (
                  <Box
                    p={4}
                    borderWidth="1px"
                    borderRadius="lg"
                    borderColor="green.500"
                    bg="surface.raised"
                  >
                    <VStack align="start" spacing={2}>
                      <HStack>
                        <Badge colorScheme="green">{"Found"}</Badge>
                        <Text fontWeight="bold" fontSize="lg">
                          {resolveResult.name}
                        </Text>
                      </HStack>
                      <Text
                        fontFamily="mono"
                        fontSize="sm"
                        wordBreak="break-all"
                      >
                        {"Target:"} {resolveResult.target}
                      </Text>
                      <HStack>
                        <Button
                          size="sm"
                          leftIcon={<Icon as={MdContentCopy} />}
                          onClick={() =>
                            copyToClipboard(
                              resolveResult.target,
                              "Target address"
                            )
                          }
                        >
                          {"Copy Target"}
                        </Button>
                        <Button
                          size="sm"
                          leftIcon={<Icon as={MdOpenInNew} />}
                          onClick={() => {
                            window.location.href = `#/send?address=${encodeURIComponent(
                              resolveResult.target
                            )}`;
                          }}
                        >
                          {"Send To"}
                        </Button>
                      </HStack>
                    </VStack>
                  </Box>
                )}

                {/* Recent Lookups */}
                {recentLookups.length > 0 && (
                  <>
                    <Divider />
                    <VStack align="stretch" spacing={3}>
                      <HStack justify="space-between">
                        <Text fontWeight="bold">{"Recent Lookups"}</Text>
                        <Button
                          size="xs"
                          variant="ghost"
                          leftIcon={<DeleteIcon />}
                          onClick={clearRecentLookups}
                        >
                          {"Clear"}
                        </Button>
                      </HStack>
                      <VStack spacing={2} align="stretch">
                        {recentLookups.map((lookup) => (
                          <Box
                            key={lookup.name}
                            p={2}
                            borderWidth="1px"
                            borderRadius="md"
                            borderColor="border.subtle"
                            cursor="pointer"
                            onClick={() => {
                              setResolveQuery(lookup.name);
                              setResolveResult({
                                name: lookup.name,
                                target: lookup.target,
                              });
                            }}
                            _hover={{ bg: "bg.50" }}
                          >
                            <HStack justify="space-between">
                              <VStack align="start" spacing={0}>
                                <Text fontWeight="medium">{lookup.name}</Text>
                                <Text
                                  fontSize="xs"
                                  color="text.muted"
                                  fontFamily="mono"
                                >
                                  {lookup.target.slice(0, 20)}...
                                </Text>
                              </VStack>
                              <IconButton
                                size="xs"
                                icon={<CopyIcon />}
                                aria-label={"Copy target"}
                                variant="ghost"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  copyToClipboard(
                                    lookup.target,
                                    "Target address"
                                  );
                                }}
                              />
                            </HStack>
                          </Box>
                        ))}
                      </VStack>
                    </VStack>
                  </>
                )}
              </VStack>
            </ContentContainer>
          </TabPanel>

          {/* Register Tab - Link to existing registration */}
          <TabPanel>
            <ContentContainer>
              <VStack spacing={4} align="center" py={8}>
                <Text fontSize="lg">
                  {"Ready to register a new WAVE name?"}
                </Text>
                <Button
                  variant="primary"
                  size="lg"
                  leftIcon={<Icon as={HiOutlineAtSymbol} />}
                  onClick={() => (window.location.href = "#/names")}
                >
                  {"Go to Registration Page"}
                </Button>
              </VStack>
            </ContentContainer>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </Container>
  );
}

function WaveNameCard({
  record,
  primaryName,
  onCopy,
}: {
  record: WaveNameRecord;
  primaryName?: string;
  onCopy?: (text: string, label: string) => void;
}) {
  const isPrimary = record.name === primaryName;
  const { isOpen, onOpen, onClose } = useDisclosure();
  const {
    isOpen: isRenewOpen,
    onOpen: onRenewOpen,
    onClose: onRenewClose,
  } = useDisclosure();
  const {
    isOpen: isBurnOpen,
    onOpen: onBurnOpen,
    onClose: onBurnClose,
  } = useDisclosure();
  const {
    isOpen: isTransferOpen,
    onOpen: onTransferOpen,
    onClose: onTransferClose,
  } = useDisclosure();
  const {
    isOpen: isReclaimOpen,
    onOpen: onReclaimOpen,
    onClose: onReclaimClose,
  } = useDisclosure();
  const toast = useToast();
  const navigate = useNavigate();
  const [newTarget, setNewTarget] = useState(record.target);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRenewing, setIsRenewing] = useState(false);
  const [isBurning, setIsBurning] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferAddress, setTransferAddress] = useState("");
  const [burnReason, setBurnReason] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);

  // Navigate to the Swap page with this name pre-filled as the offered asset.
  // The seller picks the price (RXD or token) and listing mode there.
  const handleListForSale = () => {
    navigate("/swap", { state: { offerGlyphRef: record.ref } });
  };

  // Cancel a pending listing: move the escrowed NFT back to the spendable
  // address and clear swapPending. Reuses the same cancelSwap path as the
  // Pending Swaps page.
  const handleCancelListing = async () => {
    if (wallet.value.locked) {
      openModal.value = { modal: "unlock" };
      return;
    }
    setIsCancelling(true);
    try {
      const pending = await db.swap
        .where({ status: SwapStatus.PENDING })
        .toArray();
      const swap = pending.find((s) => s.fromGlyph === record.ref);
      if (!swap) {
        throw new SwapError("Could not find the pending listing for this name");
      }
      await cancelSwap(
        swap.from,
        swap.txid,
        swap.fromValue,
        swap.fromGlyph || undefined,
        swap.vout ?? 0,
        swap.swapAddress
      );
      if (swap.id) {
        await db.swap.update(swap.id, { status: SwapStatus.CANCEL });
      }
      toast({
        title: "Listing cancelled",
        description: `${record.name} is no longer for sale`,
        status: "success",
      });
    } catch (error) {
      toast({
        title: "Cancel failed",
        description: error instanceof Error ? error.message : String(error),
        status: "error",
      });
    } finally {
      setIsCancelling(false);
    }
  };

  const statusColors: Record<WaveNameRecord["status"], string> = {
    active: "green",
    expiring: "yellow",
    expired: "red",
    grace: "orange",
    reclaimable: "purple",
  };

  const handleReclaim = async () => {
    if (!wallet.value.wif) {
      toast({
        title: "Wallet locked",
        description: "Please unlock your wallet to reclaim this name",
        status: "error",
      });
      return;
    }

    setIsBurning(true);
    try {
      // Get the NFT UTXO
      const txo = (await db.txo.get({ id: record.txoId })) as TxO;
      if (!txo) {
        throw new Error("Token UTXO not found");
      }

      // Create reclaim metadata (burn envelope). Currently informational;
      // burnNft only accepts a reason string, so the metadata is not yet
      // attached on-chain — tracked separately as a follow-up.
      const _reclaimMetadata = createWaveReclaimMetadata(
        record.name,
        record.ref
      );
      void _reclaimMetadata;

      // Build burn transaction that includes reclaim metadata
      const nftRefBE = Outpoint.fromString(record.ref);
      const { txid: nftTxid, vout: nftVout } = nftRefBE.toObject();

      // Get RXD inputs for fee
      const rxdUtxos = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      // Burn the expired NFT
      const { tx } = burnNft(
        wallet.value.address,
        wallet.value.wif.toString(),
        { ...txo, txid: nftTxid, vout: nftVout },
        rxdUtxos,
        undefined,
        feeRate.value
      );

      // Broadcast reclaim transaction
      const txId = await electrumWorker.value.broadcast(tx.toString());
      await db.broadcast.put({
        txid: txId,
        date: Date.now(),
        description: "wave_name_reclaim",
      });

      // Mark as spent
      if (record.id) {
        await db.glyph.update(record.id, { spent: 1 });
      }
      await db.txo.update(record.txoId!, { spent: 1 });
      // The reclaim burned RXD for the fee — refresh the displayed RXD balance.
      await updateRxdBalances(wallet.value.address);

      toast({
        title: "Name Reclaimed",
        description: `${record.name} has been reclaimed and is now available for re-registration`,
        status: "success",
        duration: 5000,
      });

      onReclaimClose();
    } catch (error) {
      console.error("Reclaim failed:", error);
      toast({
        title: "Reclaim Failed",
        description:
          error instanceof Error ? error.message : "Unknown error occurred",
        status: "error",
      });
    } finally {
      setIsBurning(false);
    }
  };

  const handleUpdateTarget = async () => {
    if (!wallet.value.wif || !record.id || !record.txoId) {
      toast({
        title: "Wallet locked",
        description: "Please unlock your wallet to update the target",
        status: "error",
      });
      return;
    }

    setIsUpdating(true);
    try {
      const { txid, newNftTxo, rxdInputs, outputs } = await updateWaveTarget({
        ref: record.ref,
        txoId: record.txoId,
        name: record.name,
        domain: record.domain,
        newTarget,
      });

      // The update co-spent the NFT singleton and re-created it at a NEW
      // outpoint (txid:0). Keep the local db consistent so the name doesn't
      // vanish: (1) spend the old NFT txo, (2) insert the new NFT txo,
      // (3) re-point the glyph's `lastTxoId` at it. Without (3) the Electrum
      // sync would see the old txo consumed and flip the glyph row to
      // `spent: 1` (NFT.ts), dropping the name from the WaveNames list.
      await db.txo.update(record.txoId, { spent: 1 });
      const newTxoId = (await db.txo.put(newNftTxo)) as number;

      // RXD fee coins + change bookkeeping (mirrors the transfer/send flows).
      const changeScript = p2pkhScript(wallet.value.address);
      await updateWalletUtxos(
        ContractType.RXD,
        changeScript,
        changeScript,
        txid,
        rxdInputs,
        outputs as unknown as UnfinalizedInput[]
      );
      await updateRxdBalances(wallet.value.address);

      // Update local record immediately. Mirror exactly the attrs we wrote
      // on-chain above — NOT a spread of the WaveNameRecord, which would
      // pollute attrs with UI fields (ref/status/txoId/…) and store the
      // full "name.domain" label as `name`, corrupting the cached glyph.
      // Relink lastTxoId to the new NFT UTXO and keep spent: 0.
      await db.glyph.update(record.id, {
        attrs: {
          name: record.name.split(".")[0],
          domain: record.domain,
          target: newTarget,
          target_type: "address",
        },
        lastTxoId: newTxoId,
        spent: 0,
        height: Infinity,
      });

      toast({
        title: "Target updated",
        description: `Transaction: ${txid.slice(0, 16)}...`,
        status: "success",
      });
      onClose();
    } catch (error) {
      toast({
        title: "Update failed",
        description: error instanceof Error ? error.message : String(error),
        status: "error",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRenew = async () => {
    if (!wallet.value.wif || !record.id) {
      toast({
        title: "Wallet locked",
        description: "Please unlock your wallet to renew",
        status: "error",
      });
      return;
    }

    setIsRenewing(true);
    try {
      // Renewal would extend expiration by 2 years from now once implemented.
      // Currently this UI surface only informs the user — the on-chain
      // renewal flow is not wired up yet.
      toast({
        title: "Renewal not available",
        description: `On-chain renewal will be implemented in a future update. Your name is still active until ${
          record.expires
            ? new Date(record.expires * 1000).toLocaleDateString()
            : "N/A"
        }.`,
        status: "info",
      });
      onRenewClose();
    } catch (error) {
      toast({
        title: "Renewal failed",
        description: error instanceof Error ? error.message : String(error),
        status: "error",
      });
    } finally {
      setIsRenewing(false);
    }
  };

  const handleBurn = async () => {
    if (!wallet.value.wif || !record.txoId) {
      toast({
        title: "Wallet locked",
        description: "Please unlock your wallet to burn",
        status: "error",
      });
      return;
    }

    setIsBurning(true);
    try {
      const txo = (await db.txo.get({ id: record.txoId })) as TxO;
      if (!txo) {
        throw new Error("Token UTXO not found");
      }

      const rxdUtxos = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      const result = burnNft(
        wallet.value.address,
        wallet.value.wif.toString(),
        txo,
        rxdUtxos,
        burnReason || undefined,
        feeRate.value
      );

      const txid = await electrumWorker.value.broadcast(result.tx.toString());

      await db.broadcast.put({
        txid,
        date: Date.now(),
        description: "wave_name_burn",
      });

      // Mark as spent in DB. Also mark the NFT input spent so it isn't
      // reselected, and refresh the RXD balance burned for the fee.
      if (record.id) {
        await db.glyph.update(record.id, { spent: 1 });
      }
      await db.txo.update(record.txoId!, { spent: 1 });
      await updateRxdBalances(wallet.value.address);

      toast({
        title: "WAVE Name Burned",
        description: (
          <VStack align="start" spacing={1}>
            <Text>{record.name} has been permanently destroyed</Text>
            <Text fontSize="sm">
              Photons returned: {photonsToRXD(result.photonsReturned)} RXD
            </Text>
          </VStack>
        ),
        status: "success",
        duration: 10000,
      });

      onBurnClose();
    } catch (error) {
      toast({
        title: "Burn failed",
        description: error instanceof Error ? error.message : String(error),
        status: "error",
      });
    } finally {
      setIsBurning(false);
    }
  };

  const handleSetPrimary = async () => {
    try {
      await db.kvp.put(record.name, "primaryWaveName");
      toast({
        title: "Primary WAVE Name Set",
        description: `${record.name} is now your primary WAVE name`,
        status: "success",
        duration: 3000,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : String(error),
        status: "error",
      });
    }
  };

  const handleTransfer = async () => {
    if (!wallet.value.wif || !record.txoId) {
      toast({
        title: "Wallet locked",
        description: "Please unlock your wallet to transfer",
        status: "error",
      });
      return;
    }

    if (!transferAddress || !isP2pkh(transferAddress)) {
      toast({
        title: "Invalid address",
        description: "Please enter a valid recipient address",
        status: "error",
      });
      return;
    }

    setIsTransferring(true);
    try {
      const txo = (await db.txo.get({ id: record.txoId })) as TxO;
      if (!txo) {
        throw new Error("Token UTXO not found");
      }

      const rxdUtxos = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      const ref = Outpoint.fromString(record.ref);
      const refLE = ref.reverse().toString();

      const { tx, selected } = transferNonFungible(
        rxdUtxos as SelectableInput[],
        txo,
        refLE,
        wallet.value.address,
        transferAddress,
        feeRate.value,
        wallet.value.wif.toString()
      );

      const txid = await electrumWorker.value.broadcast(tx.toString());

      await db.broadcast.put({
        txid,
        date: Date.now(),
        description: "wave_name_transfer",
      });

      // Update ownership in DB. WAVE names are NFTs: the wallet view filters on
      // the glyph row's `spent` flag, so mark it spent so the name leaves this
      // wallet immediately. Also mark the NFT input + RXD fee coins spent (and
      // record RXD change) and refresh the RXD balance, so nothing is
      // reselected by a later send and the displayed balance is correct.
      if (record.id) {
        await db.glyph.update(record.id, { spent: 1 });
      }
      const changeScript = p2pkhScript(wallet.value.address);
      await updateWalletUtxos(
        ContractType.RXD,
        changeScript,
        changeScript,
        txid,
        selected.inputs,
        selected.outputs
      );
      await updateRxdBalances(wallet.value.address);

      toast({
        title: "WAVE Name Transferred",
        description: `${record.name} sent to ${transferAddress.substring(
          0,
          20
        )}...`,
        status: "success",
        duration: 10000,
      });

      onTransferClose();
    } catch (error) {
      if (error instanceof TransferError) {
        toast({
          title: "Transfer failed",
          description: error.message,
          status: "error",
        });
      } else {
        toast({
          title: "Transfer failed",
          description: error instanceof Error ? error.message : String(error),
          status: "error",
        });
      }
    } finally {
      setIsTransferring(false);
    }
  };

  return (
    <Card p={4}>
      <Flex
        justify="space-between"
        align="start"
        direction={{ base: "column", xl: "row" }}
        gap={3}
      >
        <VStack align="start" spacing={1} flex="1" minW={0} maxW="100%">
          <HStack flexWrap="wrap" rowGap={1}>
            <Icon as={HiOutlineAtSymbol} color="brand.400" boxSize={5} />
            <Text fontSize="xl" fontWeight="bold">
              {record.name}
            </Text>
            <Badge colorScheme={statusColors[record.status]}>
              {record.status === "active" && "Active"}
              {record.status === "expiring" && "Expiring Soon"}
              {record.status === "expired" && "Expired"}
              {record.status === "grace" && "Grace Period"}
              {record.status === "reclaimable" && "Reclaimable"}
            </Badge>
            {record.listed && (
              <Badge colorScheme="purple" display="flex" alignItems="center">
                <Icon as={MdSell} boxSize={3} mr={1} />
                Listed for Sale
              </Badge>
            )}
          </HStack>
          <HStack spacing={2} w="100%" minW={0}>
            <Text
              fontSize="sm"
              color="text.secondary"
              fontFamily="mono"
              isTruncated
              minW={0}
            >
              {"Target:"} {record.target || "Not set"}
            </Text>
            {record.target && onCopy && (
              <IconButton
                size="xs"
                icon={<CopyIcon />}
                aria-label={"Copy target"}
                variant="ghost"
                flexShrink={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onCopy(record.target, "Target address");
                }}
              />
            )}
          </HStack>

          {/* Target update alert for transferred names */}
          {record.needsTargetUpdate && (
            <Alert status="warning" size="sm" borderRadius="md" py={2}>
              <AlertIcon boxSize={4} />
              <VStack align="start" spacing={1} flex={1}>
                <Text fontSize="sm" fontWeight="bold">
                  {"⚠️ Target Update Required"}
                </Text>
                <Text fontSize="xs">
                  {record.listed
                    ? "This name is listed for sale. Cancel the listing before updating its target."
                    : "This WAVE name was transferred to you. The target still points to the previous owner. Click 'Update Target' to set it to your address."}
                </Text>
                <Button
                  size="xs"
                  colorScheme="orange"
                  leftIcon={<Icon as={MdEdit} />}
                  onClick={onOpen}
                  mt={1}
                  isDisabled={record.listed}
                >
                  {"Update Target"}
                </Button>
              </VStack>
            </Alert>
          )}

          {(record.expires ?? 0) > 0 && (
            <VStack align="start" spacing={0}>
              <Text
                fontSize="xs"
                color={
                  record.status === "expiring"
                    ? "orange.400"
                    : record.status === "expired" || record.status === "grace"
                    ? "red.400"
                    : record.status === "reclaimable"
                    ? "purple.400"
                    : "text.muted"
                }
              >
                {record.status === "expiring" && "⚠️ Expires soon: "}
                {record.status === "expired" && "❌ Expired: "}
                {record.status === "grace" && "⏰ Grace period ends: "}
                {record.status === "reclaimable" && "🔓 Reclaimable since: "}
                {record.status === "active" && "✓ Valid until: "}
                {new Date((record.expires ?? 0) * 1000).toLocaleDateString()}
              </Text>
              {record.gracePeriodEnd && record.status !== "reclaimable" && (
                <Text fontSize="xs" color="text.muted">
                  (Grace until:{" "}
                  {new Date(record.gracePeriodEnd * 1000).toLocaleDateString()})
                </Text>
              )}
            </VStack>
          )}
        </VStack>

        <HStack
          flexWrap="wrap"
          rowGap={2}
          justify={{ base: "flex-start", xl: "flex-end" }}
          flexShrink={0}
        >
          {/* Primary badge or Set Primary button */}
          {isPrimary ? (
            <Tooltip label="This is your primary WAVE name" placement="top">
              <Badge colorScheme="yellow" px={2} py={1} borderRadius="md">
                <Icon as={MdStar} boxSize={4} mr={1} />
                Primary
              </Badge>
            </Tooltip>
          ) : (
            <Tooltip label="Set as your primary WAVE name" placement="top">
              <IconButton
                size="sm"
                icon={<Icon as={MdStarBorder} />}
                onClick={handleSetPrimary}
                colorScheme="yellow"
                variant="outline"
                aria-label="Set as primary WAVE name"
              />
            </Tooltip>
          )}

          {/* Renew button for expiring/grace period names */}
          {(record.status === "expiring" || record.status === "grace") && (
            <Button
              size="sm"
              leftIcon={<Icon as={MdRefresh} />}
              onClick={onRenewOpen}
              colorScheme="orange"
              variant="outline"
            >
              {"Renew"}
            </Button>
          )}

          {/* Reclaim button for reclaimable names */}
          {record.status === "reclaimable" && (
            <Button
              size="sm"
              leftIcon={<Icon as={MdRefresh} />}
              onClick={onReclaimOpen}
              colorScheme="purple"
              variant="outline"
              isDisabled={record.listed}
            >
              {"Reclaim"}
            </Button>
          )}
          {/* List for sale / cancel an existing listing */}
          {record.listed ? (
            <Button
              size="sm"
              leftIcon={<Icon as={MdSell} />}
              onClick={handleCancelListing}
              isLoading={isCancelling}
              colorScheme="purple"
              variant="outline"
            >
              {"Cancel Listing"}
            </Button>
          ) : (
            <Button
              size="sm"
              leftIcon={<Icon as={MdSell} />}
              onClick={handleListForSale}
              colorScheme="purple"
              variant="outline"
            >
              {"List for Sale"}
            </Button>
          )}
          <Button
            size="sm"
            leftIcon={<Icon as={MdEdit} />}
            onClick={onOpen}
            variant="outline"
            isDisabled={record.listed}
          >
            {"Edit"}
          </Button>
          <Button
            size="sm"
            leftIcon={<Icon as={MdSend} />}
            onClick={onTransferOpen}
            variant="outline"
            colorScheme="blue"
            isDisabled={record.listed}
          >
            {"Send"}
          </Button>
          <IconButton
            size="sm"
            icon={<Icon as={MdDelete} />}
            onClick={onBurnOpen}
            colorScheme="red"
            variant="outline"
            aria-label="Burn WAVE name"
            isDisabled={record.listed}
          />
          <a
            href={createExplorerUrl(record.ref.slice(0, 64))}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Button size="sm" variant="ghost" leftIcon={<ExternalLinkIcon />}>
              {"View"}
            </Button>
          </a>
        </HStack>
      </Flex>

      {/* Edit Modal */}
      <Modal isOpen={isOpen} onClose={onClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{"Update WAVE Name Target"}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack spacing={4}>
              <FormControl>
                <FormLabel textStyle="label">{"Name"}</FormLabel>
                <Input value={record.name} isReadOnly bg="surface.sunken" />
              </FormControl>
              <FormControl>
                <Flex justify="space-between" align="center" mb={2}>
                  <FormLabel mb={0} textStyle="label">{"New Target Address"}</FormLabel>
                  <Button
                    size="xs"
                    variant="link"
                    colorScheme="brand"
                    leftIcon={<Icon as={MdAccountBalanceWallet} />}
                    onClick={() => setNewTarget(wallet.value.address)}
                    isDisabled={
                      !wallet.value.address ||
                      newTarget === wallet.value.address
                    }
                  >
                    {"Use my address"}
                  </Button>
                </Flex>
                <Input
                  value={newTarget}
                  onChange={(e) => setNewTarget(e.target.value)}
                  placeholder={"Enter new target address or reference"}
                />
              </FormControl>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onClose}>
              {"Cancel"}
            </Button>
            <Button
              colorScheme="brand"
              onClick={handleUpdateTarget}
              isLoading={isUpdating}
            >
              {"Update Target"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Renew Modal */}
      <Modal isOpen={isRenewOpen} onClose={onRenewClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{"Renew WAVE Name"}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack spacing={4} align="stretch">
              <Alert status="info" borderRadius="md">
                <AlertIcon />
                <Text>
                  {
                    "Renewal extends your name registration for another 2 years from the renewal date."
                  }
                </Text>
              </Alert>
              <FormControl>
                <FormLabel textStyle="label">{"Name"}</FormLabel>
                <Input value={record.name} isReadOnly bg="surface.sunken" />
              </FormControl>
              {record.expires && (
                <Box>
                  <Text fontSize="sm" color="text.secondary">
                    {"Current expiration:"}{" "}
                    {new Date(record.expires * 1000).toLocaleDateString()}
                  </Text>
                  <Text fontSize="sm" color="green.400">
                    {"New expiration:"}{" "}
                    {new Date(
                      (Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 60 * 60) *
                        1000
                    ).toLocaleDateString()}
                  </Text>
                </Box>
              )}
              <Text fontSize="sm" color="text.muted">
                {"Renewal cost: Same as registration based on name length"}
              </Text>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onRenewClose}>
              {"Cancel"}
            </Button>
            <Button
              colorScheme="orange"
              onClick={handleRenew}
              isLoading={isRenewing}
            >
              {"Renew Name"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Burn Modal */}
      <Modal isOpen={isBurnOpen} onClose={onBurnClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{"Burn WAVE Name"}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack spacing={4} align="stretch">
              <Alert status="error" borderRadius="md">
                <AlertIcon />
                <VStack align="start" spacing={1}>
                  <Text fontWeight="bold">
                    {"Warning: This action is irreversible!"}
                  </Text>
                  <Text fontSize="sm">
                    {
                      "Burning will permanently destroy this WAVE name. The photons will be returned to your wallet."
                    }
                  </Text>
                </VStack>
              </Alert>
              <FormControl>
                <FormLabel textStyle="label">{"Name to Burn"}</FormLabel>
                <Input value={record.name} isReadOnly bg="surface.sunken" />
              </FormControl>
              <FormControl>
                <FormLabel textStyle="label">{"Reason (Optional)"}</FormLabel>
                <Input
                  value={burnReason}
                  onChange={(e) => setBurnReason(e.target.value)}
                  placeholder="e.g., No longer needed, Transferring to new name, etc."
                />
              </FormControl>
              <Alert status="info" borderRadius="md">
                <AlertIcon />
                <VStack align="start" spacing={1}>
                  <Text fontWeight="bold">{"Photons to be returned:"}</Text>
                  <Text fontSize="lg" color="green.300">
                    {photonsToRXD(1)} RXD
                  </Text>
                </VStack>
              </Alert>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onBurnClose}>
              {"Cancel"}
            </Button>
            <Button
              colorScheme="red"
              onClick={handleBurn}
              isLoading={isBurning}
              loadingText={"Burning..."}
            >
              {"Burn Name"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Transfer Modal */}
      <Modal isOpen={isTransferOpen} onClose={onTransferClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{"Transfer WAVE Name"}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack spacing={4} align="stretch">
              <FormControl>
                <FormLabel textStyle="label">{"Name"}</FormLabel>
                <Input value={record.name} isReadOnly bg="surface.sunken" />
              </FormControl>
              <FormControl>
                <FormLabel textStyle="label">{"Recipient Address"}</FormLabel>
                <Input
                  value={transferAddress}
                  onChange={(e) => setTransferAddress(e.target.value)}
                  placeholder="Enter RXD address"
                />
              </FormControl>
              <Alert status="info" borderRadius="md">
                <AlertIcon />
                <Text fontSize="sm">
                  {
                    "The recipient will own this WAVE name and can update its target address. The new owner should update the target after receiving."
                  }
                </Text>
              </Alert>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onTransferClose}>
              {"Cancel"}
            </Button>
            <Button
              colorScheme="blue"
              onClick={handleTransfer}
              isLoading={isTransferring}
              loadingText={"Sending..."}
            >
              {"Transfer Name"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Reclaim Modal */}
      <Modal isOpen={isReclaimOpen} onClose={onReclaimClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{"Reclaim Expired WAVE Name"}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack spacing={4} align="stretch">
              <Alert status="warning" borderRadius="md">
                <AlertIcon />
                <VStack align="start" spacing={1}>
                  <Text fontWeight="bold">{"About Reclaiming"}</Text>
                  <Text fontSize="sm">
                    {`The grace period for ${record.name} has ended. This name is now reclaimable. Reclaiming will burn the expired NFT, making the name available for new registration.`}
                  </Text>
                </VStack>
              </Alert>
              <FormControl>
                <FormLabel textStyle="label">{"Name to Reclaim"}</FormLabel>
                <Input value={record.name} isReadOnly bg="surface.sunken" />
              </FormControl>
              <Alert status="info" borderRadius="md">
                <AlertIcon />
                <VStack align="start" spacing={1}>
                  <Text fontWeight="bold">{"What happens next?"}</Text>
                  <Text fontSize="sm">
                    {"1. The expired NFT will be burned on-chain"}
                  </Text>
                  <Text fontSize="sm">
                    {"2. The name will be removed from the registry"}
                  </Text>
                  <Text fontSize="sm">
                    {"3. The name becomes available for new registration"}
                  </Text>
                  <Text fontSize="sm" color="text.muted">
                    {
                      "Photons from the burned token will be returned to your wallet."
                    }
                  </Text>
                </VStack>
              </Alert>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onReclaimClose}>
              {"Cancel"}
            </Button>
            <Button
              colorScheme="purple"
              onClick={handleReclaim}
              isLoading={isBurning}
              loadingText={"Reclaiming..."}
            >
              {"Reclaim Name"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Card>
  );
}
