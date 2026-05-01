import { useState, useEffect, useRef } from "react";
import {
  Container,
  VStack,
  HStack,
  Text,
  Button,
  Badge,
  Box,
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
  Select,
} from "@chakra-ui/react";
import { useLiveQuery } from "dexie-react-hooks";
import { SearchIcon, ExternalLinkIcon, CopyIcon, DeleteIcon } from "@chakra-ui/icons";
import { HiOutlineAtSymbol } from "react-icons/hi";
import { MdEdit, MdRefresh, MdOpenInNew, MdContentCopy, MdDelete, MdSend, MdStar, MdStarBorder } from "react-icons/md";
import PageHeader from "@app/components/PageHeader";
import ContentContainer from "@app/components/ContentContainer";
import { wallet, feeRate } from "@app/signals";
import { electrumWorker } from "@app/electrum/Electrum";
import db from "@app/db";
import { SmartTokenType, TxO, ContractType } from "@app/types";
import { GLYPH_WAVE } from "@lib/protocols";
import { 
  validateWaveName, 
  calculateNameCost, 
  createWaveNameMetadata,
  canReclaimWaveName,
  createWaveReclaimMetadata,
  DEFAULT_REGISTRATION_DURATION,
  GRACE_PERIOD,
} from "@lib/wave";
import { photonsToRXD } from "@lib/format";
import createExplorerUrl from "@app/network/createExplorerUrl";
import Outpoint from "@lib/Outpoint";
import { encodeGlyphMutable } from "@lib/token";
import { fundTx } from "@lib/coinSelect";
import {
  mutableNftScript,
  nftAuthScript,
  p2pkhScript,
  parseMutableScript,
  isP2pkh,
} from "@lib/script";
import { burnNft } from "@lib/burn";
import { transferNonFungible, TransferError } from "@lib/transfer";
import { SelectableInput } from "@lib/coinSelect";
import { buildTx, findTokenOutput } from "@lib/tx";
import { SmartTokenPayload, UnfinalizedInput } from "@lib/types";
import { Transaction } from "@radiant-core/radiantjs";

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
}

interface RecentLookup {
  name: string;
  target: string;
  timestamp: number;
}

export default function WaveNames() {
  const [activeTab, setActiveTab] = useState(0);
  const [resolveQuery, setResolveQuery] = useState("");
  const [resolveResult, setResolveResult] = useState<{ name: string; target: string } | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentLookups, setRecentLookups] = useState<RecentLookup[]>([]);
  const toast = useToast();

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

  // Save recent lookups
  const addRecentLookup = (name: string, target: string) => {
    const newLookup: RecentLookup = {
      name,
      target,
      timestamp: Date.now(),
    };
    const updated = [newLookup, ...recentLookups.filter(l => l.name !== name)].slice(0, 10);
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
    const preference = await db.kvp.get("primaryWaveName") as string | undefined;
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
        
        let status: "active" | "expiring" | "expired" | "grace" | "reclaimable" = "active";
        
        if (expires > 0) {
          const daysUntilExpiry = Math.floor((expires - now) / 86400);
          const daysUntilGraceEnd = Math.floor((gracePeriodEnd - now) / 86400);
          
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
        const needsTargetUpdate = !!(target && target !== wallet.value.address && !target.startsWith("ref:") && !target.startsWith("op:") && isP2pkh(target));

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
        });
      }
    }
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  // Filter names based on search
  const filteredNames = waveNames?.filter(record =>
    searchQuery === "" ||
    record.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    record.target.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const handleResolve = async () => {
    if (!resolveQuery.trim()) return;

    const fullName = resolveQuery.includes(".") ? resolveQuery : `${resolveQuery}.rxd`;
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
          description: "${fullName} is not registered",
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

      <Tabs index={activeTab} onChange={setActiveTab} variant="enclosed" colorScheme="brand">
        <TabList>
          <Tab>{"My Names"}</Tab>
          <Tab>{"Resolver"}</Tab>
          <Tab>{"Register"}</Tab>
        </TabList>

        <TabPanels>
          {/* My Names Tab */}
          <TabPanel>
            <ContentContainer>
              {!waveNames?.length ? (
                <Alert status="info" borderRadius="md">
                  <AlertIcon />
                  <VStack align="start" spacing={2}>
                    <Text>{"You don't own any WAVE names yet."}</Text>
                    <Button
                      size="sm"
                      colorScheme="brand"
                      onClick={() => setActiveTab(2)}
                    >
                      {"Register your first name"}
                    </Button>
                  </VStack>
                </Alert>
              ) : (
                <VStack spacing={4} align="stretch">
                  {/* Search */}
                  <InputGroup>
                    <InputLeftElement pointerEvents="none">
                      <SearchIcon color="gray.400" />
                    </InputLeftElement>
                    <Input
                      placeholder={"Search your names..."}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </InputGroup>

                  {/* Results count */}
                  {searchQuery && (
                    <Text fontSize="sm" color="gray.500">
                      {filteredNames.length === 0
                        ? "No names found"
                        : "Showing ${filteredNames.length} of ${waveNames.length} names"}
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
                  <FormLabel>{"Lookup WAVE Name"}</FormLabel>
                  <InputGroup>
                    <InputLeftElement pointerEvents="none">
                      <Icon as={HiOutlineAtSymbol} color="gray.400" />
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
                  colorScheme="brand"
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
                    borderRadius="md"
                    borderColor="green.500"
                    bg="green.900"
                  >
                    <VStack align="start" spacing={2}>
                      <HStack>
                        <Badge colorScheme="green">{"Found"}</Badge>
                        <Text fontWeight="bold" fontSize="lg">
                          {resolveResult.name}
                        </Text>
                      </HStack>
                      <Text fontFamily="mono" fontSize="sm" wordBreak="break-all">
                        {"Target:"} {resolveResult.target}
                      </Text>
                      <HStack>
                        <Button
                          size="sm"
                          leftIcon={<Icon as={MdContentCopy} />}
                          onClick={() => copyToClipboard(resolveResult.target, "Target address")}
                        >
                          {"Copy Target"}
                        </Button>
                        <Button
                          size="sm"
                          leftIcon={<Icon as={MdOpenInNew} />}
                          onClick={() => {
                            window.location.href = `#/send?address=${encodeURIComponent(resolveResult.target)}`;
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
                            borderColor="whiteAlpha.200"
                            cursor="pointer"
                            onClick={() => {
                              setResolveQuery(lookup.name);
                              setResolveResult({ name: lookup.name, target: lookup.target });
                            }}
                            _hover={{ bg: "whiteAlpha.100" }}
                          >
                            <HStack justify="space-between">
                              <VStack align="start" spacing={0}>
                                <Text fontWeight="medium">{lookup.name}</Text>
                                <Text fontSize="xs" color="gray.500" fontFamily="mono">
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
                                  copyToClipboard(lookup.target, "Target address");
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
                <Text fontSize="lg">{"Ready to register a new WAVE name?"}</Text>
                <Button
                  colorScheme="brand"
                  size="lg"
                  leftIcon={<Icon as={HiOutlineAtSymbol} />}
                  onClick={() => window.location.href = "#/names"}
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

function WaveNameCard({ record, primaryName, onCopy }: { record: WaveNameRecord; primaryName?: string; onCopy?: (text: string, label: string) => void }) {
  const isPrimary = record.name === primaryName;
  const { isOpen, onOpen, onClose } = useDisclosure();
  const { isOpen: isRenewOpen, onOpen: onRenewOpen, onClose: onRenewClose } = useDisclosure();
  const { isOpen: isBurnOpen, onOpen: onBurnOpen, onClose: onBurnClose } = useDisclosure();
  const { isOpen: isTransferOpen, onOpen: onTransferOpen, onClose: onTransferClose } = useDisclosure();
  const { isOpen: isReclaimOpen, onOpen: onReclaimOpen, onClose: onReclaimClose } = useDisclosure();
  const toast = useToast();
  const [newTarget, setNewTarget] = useState(record.target);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isRenewing, setIsRenewing] = useState(false);
  const [isBurning, setIsBurning] = useState(false);
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferAddress, setTransferAddress] = useState("");
  const [burnReason, setBurnReason] = useState("");

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
      const txo = await db.txo.get({ id: record.txoId }) as TxO;
      if (!txo) {
        throw new Error("Token UTXO not found");
      }

      // Create reclaim metadata (burn envelope)
      const reclaimMetadata = createWaveReclaimMetadata(record.name, record.ref);

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
        wallet.value.wif,
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
        description: error instanceof Error ? error.message : "Unknown error occurred",
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
      // Get the NFT UTXO
      const txo = await db.txo.get({ id: record.txoId }) as TxO;
      if (!txo) {
        throw new Error("Token UTXO not found");
      }

      // Get NFT ref and calculate mutable contract ref
      const nftRefBE = Outpoint.fromString(record.ref);
      const nftRefLE = nftRefBE.reverse().toString();
      const { txid: nftTxid, vout: refVout } = nftRefBE.toObject();

      // Mutable contract ref is always token ref + 1
      const mutRefBE = Outpoint.fromUTXO(nftTxid, refVout + 1);
      const mutRefLE = mutRefBE.reverse().toString();

      // Fetch current location of the mutable contract UTXO
      const refResponse = await electrumWorker.value.getRef(mutRefBE.toString());
      if (!refResponse?.length) {
        throw new Error("Mutable contract UTXO not found");
      }
      const location = refResponse[refResponse.length - 1].tx_hash;
      const hex = await electrumWorker.value.getTransaction(location);
      const refTx = new Transaction(hex);

      const { vout: mutVout, output: mutOutput } = findTokenOutput(
        refTx,
        mutRefLE,
        parseMutableScript
      );

      if (mutVout === undefined || !mutOutput) {
        throw new Error("Could not locate mutable contract output");
      }

      // Build updated payload - only updating target
      const payload: Partial<SmartTokenPayload> = {
        attrs: {
          name: record.name.split(".")[0],
          domain: record.domain,
          target: newTarget,
          target_type: "address",
        },
      };

      // contractOutputIndex=0, refHashIndex=1, refIndex=0, tokenOutputIndex=1
      const glyph = encodeGlyphMutable("mod", payload, 0, 1, 0, 1);
      const mutOutputScript = mutableNftScript(mutRefLE, glyph.payloadHash);
      const nftOutputScript = nftAuthScript(
        wallet.value.address,
        nftRefLE,
        [{ ref: mutRefLE, scriptSigHash: glyph.scriptSigHash }]
      );

      const nftInput: UnfinalizedInput = { ...txo };
      const mutInput: UnfinalizedInput = {
        txid: refTx.id,
        vout: mutVout,
        script: mutOutput.script.toHex(),
        value: mutOutput.satoshis,
        scriptSigSize: mutOutputScript.length / 2,
      };

      const nftOutput = { script: nftOutputScript, value: txo.value };
      const mutContractOutput = {
        script: mutOutputScript,
        value: mutInput.value,
      };

      const inputs: UnfinalizedInput[] = [nftInput, mutInput];
      const outputs = [nftOutput, mutContractOutput];

      // Get RXD UTXOs for funding
      const rxdUtxos = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      const p2pkh = p2pkhScript(wallet.value.address);
      const fund = fundTx(
        wallet.value.address,
        rxdUtxos,
        inputs,
        outputs,
        p2pkh,
        feeRate.value
      );

      if (!fund.funded) {
        throw new Error("Insufficient funds for transaction fee");
      }

      inputs.push(...fund.funding);
      outputs.push(...fund.change);

      const rawTx = buildTx(
        wallet.value.address,
        wallet.value.wif,
        inputs,
        outputs,
        false,
        (index, script) => {
          if (index === 1) {
            // Mutable contract input: replace p2pkh scriptSig with glyph scriptSig
            script.set({ chunks: [] });
            script.add(glyph.scriptSig);
          }
        }
      ).toString();

      const txid = await electrumWorker.value.broadcast(rawTx);
      await db.broadcast.put({
        txid,
        date: Date.now(),
        description: "wave_name_update",
      });

      // Update local record immediately
      await db.glyph.update(record.id, {
        attrs: {
          ...record,
          target: newTarget,
        },
        height: Infinity,
      });

      toast({
        title: "Target updated",
        description: "Transaction: ${txid.slice(0, 16)}...",
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
      // Renewal extends expiration by 2 years from now
      const newExpires = Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 60 * 60;

      // Similar to update but only changing expires attribute
      // For now, show a message that renewal is not yet implemented on-chain
      toast({
        title: "Renewal not available",
        description: `On-chain renewal will be implemented in a future update. Your name is still active until ${record.expires ? new Date(record.expires * 1000).toLocaleDateString() : "N/A"}.`,
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
      const txo = await db.txo.get({ id: record.txoId }) as TxO;
      if (!txo) {
        throw new Error("Token UTXO not found");
      }

      const rxdUtxos = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      const result = burnNft(
        wallet.value.address,
        wallet.value.wif,
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

      // Mark as spent in DB
      if (record.id) {
        await db.glyph.update(record.id, { spent: 1 });
      }

      toast({
        title: "WAVE Name Burned",
        description: (
          <VStack align="start" spacing={1}>
            <Text>{record.name} has been permanently destroyed</Text>
            <Text fontSize="sm">Photons returned: {photonsToRXD(result.photonsReturned)} RXD</Text>
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
      const txo = await db.txo.get({ id: record.txoId }) as TxO;
      if (!txo) {
        throw new Error("Token UTXO not found");
      }

      const rxdUtxos = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      const ref = Outpoint.fromString(record.ref);

      const { tx, selected } = transferNonFungible(
        rxdUtxos as SelectableInput[],
        txo,
        ref.toString(),
        wallet.value.address,
        transferAddress,
        feeRate.value,
        wallet.value.wif
      );

      const txid = await electrumWorker.value.broadcast(tx.toString());

      await db.broadcast.put({
        txid,
        date: Date.now(),
        description: "wave_name_transfer",
      });

      // Update ownership in DB
      if (record.id) {
        await db.glyph.update(record.id, { spent: 1 });
      }

      toast({
        title: "WAVE Name Transferred",
        description: `${record.name} sent to ${transferAddress.substring(0, 20)}...`,
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
    <Box
      p={4}
      borderWidth="1px"
      borderRadius="lg"
      borderColor="whiteAlpha.200"
      bg="gray.800"
    >
      <HStack justify="space-between" align="start">
        <VStack align="start" spacing={1}>
          <HStack>
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
          </HStack>
          <HStack spacing={2}>
            <Text fontSize="sm" color="gray.400" fontFamily="mono">
              {"Target:"} {record.target || "Not set"}
            </Text>
            {record.target && onCopy && (
              <IconButton
                size="xs"
                icon={<CopyIcon />}
                aria-label={"Copy target"}
                variant="ghost"
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
                  {"This WAVE name was transferred to you. The target still points to the previous owner. Click 'Update Target' to set it to your address."}
                </Text>
                <Button
                  size="xs"
                  colorScheme="orange"
                  leftIcon={<Icon as={MdEdit} />}
                  onClick={onOpen}
                  mt={1}
                >
                  {"Update Target"}
                </Button>
              </VStack>
            </Alert>
          )}

          {(record.expires ?? 0) > 0 && (
            <VStack align="start" spacing={0}>
              <Text fontSize="xs" color={
                record.status === "expiring" ? "orange.400" : 
                record.status === "expired" || record.status === "grace" ? "red.400" : 
                record.status === "reclaimable" ? "purple.400" :
                "gray.500"
              }>
                {record.status === "expiring" && "⚠️ Expires soon: "}
                {record.status === "expired" && "❌ Expired: "}
                {record.status === "grace" && "⏰ Grace period ends: "}
                {record.status === "reclaimable" && "🔓 Reclaimable since: "}
                {record.status === "active" && "✓ Valid until: "}
                {new Date((record.expires ?? 0) * 1000).toLocaleDateString()}
              </Text>
              {record.gracePeriodEnd && record.status !== "reclaimable" && (
                <Text fontSize="xs" color="gray.500">
                  (Grace until: {new Date(record.gracePeriodEnd * 1000).toLocaleDateString()})
                </Text>
              )}
            </VStack>
          )}
        </VStack>

        <HStack>
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
            >
              {"Reclaim"}
            </Button>
          )}
          <Button
            size="sm"
            leftIcon={<Icon as={MdEdit} />}
            onClick={onOpen}
            variant="outline"
          >
            {"Edit"}
          </Button>
          <Button
            size="sm"
            leftIcon={<Icon as={MdSend} />}
            onClick={onTransferOpen}
            variant="outline"
            colorScheme="blue"
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
      </HStack>

      {/* Edit Modal */}
      <Modal isOpen={isOpen} onClose={onClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{"Update WAVE Name Target"}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack spacing={4}>
              <FormControl>
                <FormLabel>{"Name"}</FormLabel>
                <Input value={record.name} isReadOnly bg="whiteAlpha.100" />
              </FormControl>
              <FormControl>
                <FormLabel>{"New Target Address"}</FormLabel>
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
                  {"Renewal extends your name registration for another 2 years from the renewal date."}
                </Text>
              </Alert>
              <FormControl>
                <FormLabel>{"Name"}</FormLabel>
                <Input value={record.name} isReadOnly bg="whiteAlpha.100" />
              </FormControl>
              {record.expires && (
                <Box>
                  <Text fontSize="sm" color="gray.400">
                    {"Current expiration:"} {new Date(record.expires * 1000).toLocaleDateString()}
                  </Text>
                  <Text fontSize="sm" color="green.400">
                    {"New expiration:"} {new Date((Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 60 * 60) * 1000).toLocaleDateString()}
                  </Text>
                </Box>
              )}
              <Text fontSize="sm" color="gray.500">
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
                  <Text fontWeight="bold">{"Warning: This action is irreversible!"}</Text>
                  <Text fontSize="sm">
                    {"Burning will permanently destroy this WAVE name. The photons will be returned to your wallet."}
                  </Text>
                </VStack>
              </Alert>
              <FormControl>
                <FormLabel>{"Name to Burn"}</FormLabel>
                <Input value={record.name} isReadOnly bg="whiteAlpha.100" />
              </FormControl>
              <FormControl>
                <FormLabel>{"Reason (Optional)"}</FormLabel>
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
                <FormLabel>{"Name"}</FormLabel>
                <Input value={record.name} isReadOnly bg="whiteAlpha.100" />
              </FormControl>
              <FormControl>
                <FormLabel>{"Recipient Address"}</FormLabel>
                <Input
                  value={transferAddress}
                  onChange={(e) => setTransferAddress(e.target.value)}
                  placeholder="Enter RXD address"
                />
              </FormControl>
              <Alert status="info" borderRadius="md">
                <AlertIcon />
                <Text fontSize="sm">
                  {"The recipient will own this WAVE name and can update its target address. The new owner should update the target after receiving."}
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
                <FormLabel>{"Name to Reclaim"}</FormLabel>
                <Input value={record.name} isReadOnly bg="whiteAlpha.100" />
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
                  <Text fontSize="sm" color="gray.500">
                    {"Photons from the burned token will be returned to your wallet."}
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
    </Box>
  );
}
