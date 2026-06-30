import { useState, useEffect, useCallback, useMemo } from "react";
import { t } from "@lingui/macro";
import {
  Alert,
  AlertIcon,
  Box,
  Button,
  Checkbox,
  CloseButton,
  Code,
  Collapse,
  Container,
  Divider,
  FormControl,
  FormLabel,
  FormHelperText,
  Heading,
  HStack,
  Icon,
  IconButton,
  Input,
  Link,
  Progress,
  Select,
  SimpleGrid,
  Switch,
  Table,
  Tag,
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
import {
  TbDownload,
  TbGift,
  TbKey,
  TbLock,
  TbLockOpen,
  TbPlus,
  TbTrash,
  TbUpload,
  TbWand,
} from "react-icons/tb";
import { CopyIcon, ExternalLinkIcon } from "@chakra-ui/icons";
import PageHeader from "@app/components/PageHeader";
import ContentContainer from "@app/components/ContentContainer";
import NoContent from "@app/components/NoContent";
import Photons from "@app/components/Photons";
import VaultDetailModal from "@app/components/VaultDetailModal";
import { saveFile } from "@app/platform";
import { wallet, feeRate, openModal } from "@app/signals";
import createExplorerUrl from "@app/network/createExplorerUrl";
import { electrumWorker } from "@app/electrum/Electrum";
import db from "@app/db";
import {
  ContractType,
  SmartToken,
  SmartTokenType,
  VaultRecord,
  VaultLastScan,
  VAULT_SCAN_FAILED,
} from "@app/types";
import { reverseRef } from "@lib/Outpoint";
import { parseFtScript, parseNftScript } from "@lib/script";
import { useLiveQuery } from "dexie-react-hooks";
import {
  buildVaultTx,
  buildVestingTx,
  p2shOutputScript,
  isVaultClaimable,
  formatLocktime,
  vaultClaimableIn,
  claimVaultTx,
  recoverVaultsFromTx,
  verifyVaultRecoveryInfo,
  extractVaultSenderAddress,
  isVaultRecipientAddress,
  vaultScriptHash,
  VAULT_MAX_LOCKTIME_BLOCKS,
  VAULT_MAX_TRANCHES,
  type VaultParams,
  type VaultAssetType,
  type VaultMode,
  type VestingTranche,
  type FundingUtxo,
} from "@lib/vault";
import {
  serializeRecoveryInfo,
  parseRecoveryPayload,
} from "@app/vaultRecovery";

// ── Constants ──────────────────────────────────────────────
const AVG_BLOCK_TIME_SEC = 300; // ~5 min per block

// ── Helpers ────────────────────────────────────────────────

/** Convert a local datetime-local string to UNIX timestamp */
function dateInputToUnix(val: string): number {
  if (!val) return 0;
  return Math.floor(new Date(val).getTime() / 1000);
}

/** Convert a UNIX timestamp to a datetime-local input string */
function unixToDateInput(ts: number): string {
  if (!ts || ts <= 0) return "";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** Estimate duration in human-readable form from block count */
function blocksToDuration(blocks: number): string {
  if (blocks <= 0) return "";
  const secs = blocks * AVG_BLOCK_TIME_SEC;
  if (secs < 3600) return `~${Math.ceil(secs / 60)} min`;
  if (secs < 86400) return `~${(secs / 3600).toFixed(1)}h`;
  if (secs < 86400 * 365) return `~${(secs / 86400).toFixed(1)} days`;
  return `~${(secs / (86400 * 365)).toFixed(1)} years`;
}

/** Estimate duration from seconds */
function secsToDuration(secs: number): string {
  if (secs <= 0) return "";
  if (secs < 3600) return `~${Math.ceil(secs / 60)} min`;
  if (secs < 86400) return `~${(secs / 3600).toFixed(1)}h`;
  if (secs < 86400 * 365) return `~${(secs / 86400).toFixed(1)} days`;
  return `~${(secs / (86400 * 365)).toFixed(1)} years`;
}

/** Format a timestamp for human-readable display */
function formatScanTime(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return "Never";
  const diff = Date.now() - timestamp;
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

// ── Types ──────────────────────────────────────────────────

type Tranche = {
  locktime: string;
  value: string;
  pct: string;
};

type VestingInputMode = "manual" | "percentage";

type PresetId =
  | "linear-6"
  | "linear-12"
  | "cliff-linear"
  | "back-loaded"
  | "custom";

interface PresetDef {
  id: PresetId;
  label: string;
  description: string;
  params: { months?: number; cliffMonths?: number };
  build: (count: number) => number[];
}

const PRESETS: PresetDef[] = [
  {
    id: "linear-6",
    label: "Linear 6-month",
    description: "Equal portions every month for 6 months",
    params: { months: 6 },
    build: () => Array(6).fill(100 / 6),
  },
  {
    id: "linear-12",
    label: "Linear 12-month",
    description: "Equal portions every month for 12 months",
    params: { months: 12 },
    build: () => Array(12).fill(100 / 12),
  },
  {
    id: "cliff-linear",
    label: "Cliff + Linear",
    description: "25% cliff at month 3, then equal monthly over 9 months",
    params: { cliffMonths: 3, months: 12 },
    build: () => {
      const pcts: number[] = [];
      pcts.push(25); // cliff
      const remaining = 75;
      const monthlyCount = 9;
      for (let i = 0; i < monthlyCount; i++)
        pcts.push(remaining / monthlyCount);
      return pcts; // 10 tranches
    },
  },
  {
    id: "back-loaded",
    label: "Back-loaded",
    description: "10% for first 6 months, 40% in final 2 months",
    params: { months: 8 },
    build: () => {
      const pcts: number[] = [];
      for (let i = 0; i < 6; i++) pcts.push(10 / 6);
      pcts.push(45);
      pcts.push(45);
      return pcts; // 8 tranches
    },
  },
];

export default function VaultPage() {
  const toast = useToast();

  // ────────────────────────────────────────────────────────
  // Tab state
  // ────────────────────────────────────────────────────────
  const [tab, setTab] = useState<"create" | "list">("list");

  // ────────────────────────────────────────────────────────
  // Create form state
  // ────────────────────────────────────────────────────────
  const [assetType, setAssetType] = useState<VaultAssetType>("rxd");
  const [mode, setMode] = useState<VaultMode>("block");
  const [recipient, setRecipient] = useState("");
  const [locktime, setLocktime] = useState("");
  const [datePickerValue, setDatePickerValue] = useState("");
  const [amount, setAmount] = useState("");
  const [label, setLabel] = useState("");
  const [ref, setRef] = useState("");
  const [refManual, setRefManual] = useState(false);
  const [vesting, setVesting] = useState(false);
  const [tranches, setTranches] = useState<Tranche[]>([
    { locktime: "", value: "", pct: "" },
  ]);
  const [loading, setLoading] = useState(false);

  // Vesting-specific state
  const [vestingInputMode, setVestingInputMode] =
    useState<VestingInputMode>("manual");

  // Default recipient to self when create tab is opened
  useEffect(() => {
    if (tab === "create" && wallet.value.address && !recipient) {
      setRecipient(wallet.value.address);
    }
  }, [tab, wallet.value.address, recipient]);
  const [totalVestingAmount, setTotalVestingAmount] = useState("");

  // Owned tokens for the picker (reactive to assetType)
  const ownedTokens = useLiveQuery(
    async () => {
      if (assetType === "rxd") return [];
      const tokenType =
        assetType === "nft" ? SmartTokenType.NFT : SmartTokenType.FT;
      return db.glyph
        .where("tokenType")
        .equals(tokenType)
        .filter((g) => g.spent === 0)
        .toArray();
    },
    [assetType],
    []
  );

  // When assetType changes reset ref selection
  useEffect(() => {
    setRef("");
    setRefManual(false);
  }, [assetType]);

  // Interval auto-fill state
  const [intervalStart, setIntervalStart] = useState("");
  const [intervalStep, setIntervalStep] = useState("");
  const [intervalStartDate, setIntervalStartDate] = useState("");

  // Preset state
  const [selectedPreset, setSelectedPreset] = useState<PresetId>("custom");

  // List filter state
  const [showClaimed, setShowClaimed] = useState(false);

  // Scan tracking state. `complete` is false when the last scan skipped any
  // transactions (timeouts) — surfaced in amber so "no vaults" is never trusted
  // blindly. Optional fields tolerate legacy records that predate the counts.
  const [lastScan, setLastScan] = useState<Partial<VaultLastScan> | null>(null);

  // Vault discovery state
  const [scanning, setScanning] = useState(false);

  // Manual transaction check state
  const [checkTxId, setCheckTxId] = useState("");
  const [checkingTx, setCheckingTx] = useState(false);
  // "Recover by TXID" toggle (always available, not just empty-state)
  const [showRecover, setShowRecover] = useState(false);

  // "Import recovery info" (gifted/inherited vaults shared by the sender)
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importing, setImporting] = useState(false);

  // Acknowledgment required before creating a vault for a third-party address
  // (the sender must share recovery info or the recipient can't claim it).
  const [ackGift, setAckGift] = useState(false);

  // Persistent post-create panel. For a self-vault this surfaces the TXID to
  // back up; for a gift it surfaces the shareable recovery info the recipient
  // needs. Vault metadata lives only in IndexedDB, never in the seed backup.
  const [lastCreated, setLastCreated] = useState<{
    txid: string;
    isSelf: boolean;
    recoveryInfo: string;
  } | null>(null);
  const { onCopy: copyCreatedTxid, hasCopied: copiedCreated } = useClipboard(
    lastCreated?.txid ?? ""
  );
  const { onCopy: copyCreatedRecovery, hasCopied: copiedCreatedRecovery } =
    useClipboard(lastCreated?.recoveryInfo ?? "");

  // A vault is a "gift" when its recipient is neither of this wallet's own
  // (main / swap) addresses. Vaulting to our OWN swap address is self-custody
  // but still needs self-encryption (the sender key is always main).
  const recipientTrimmed = recipient.trim();
  const isOwnSwap =
    !!wallet.value.swapAddress &&
    recipientTrimmed === wallet.value.swapAddress;
  const isGift =
    !!recipientTrimmed &&
    recipientTrimmed !== wallet.value.address &&
    !isOwnSwap;

  // Vault detail modal state
  const [selectedVault, setSelectedVault] = useState<VaultRecord | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);

  // Sort state
  type SortCol =
    | "status"
    | "type"
    | "value"
    | "locktime"
    | "remaining"
    | "label";
  const [sortCol, setSortCol] = useState<SortCol>("locktime");
  const [sortAsc, setSortAsc] = useState(true);

  const handleSort = useCallback((col: SortCol) => {
    setSortCol((prev) => {
      if (prev === col) {
        setSortAsc((a) => !a);
        return prev;
      }
      setSortAsc(true);
      return col;
    });
  }, []);

  // ────────────────────────────────────────────────────────
  // Vault detail modal handlers
  // ────────────────────────────────────────────────────────
  const handleVaultClick = useCallback((vault: VaultRecord) => {
    setSelectedVault(vault);
    setIsDetailModalOpen(true);
  }, []);

  const handleCloseDetailModal = useCallback(() => {
    setIsDetailModalOpen(false);
    setSelectedVault(null);
  }, []);

  // ────────────────────────────────────────────────────────
  // Vault list from DB (live query)
  // ────────────────────────────────────────────────────────
  const vaultsRaw = useLiveQuery(
    () =>
      db.vault
        .orderBy("date")
        .reverse()
        .toArray()
        .then((vaults) => {
          console.log(
            "[Vault List] Loaded from DB:",
            vaults?.length || 0,
            "vaults"
          );
          if (vaults?.length) {
            console.log(
              "[Vault List] First vault:",
              vaults[0].txid,
              vaults[0].recipientAddress
            );
          }
          return vaults;
        }),
    []
  );

  // ────────────────────────────────────────────────────────
  // Load last scan timestamp
  // ────────────────────────────────────────────────────────
  useEffect(() => {
    const loadLastScan = async () => {
      if (!wallet.value.address) return;
      try {
        const scanKey = `vaultLastScan_${wallet.value.address}`;
        const scanData = (await db.kvp.get(scanKey)) as
          | Partial<VaultLastScan>
          | undefined;
        if (scanData) {
          setLastScan(scanData);
        }
      } catch (e) {
        console.warn("[Vault] Failed to load last scan:", e);
      }
    };
    loadLastScan();
  }, [wallet.value.address]);

  // ────────────────────────────────────────────────────────
  // Current blockchain height
  // Primary: ElectrumX blockchain.headers.subscribe  |  Fallback: local DB header table
  // ────────────────────────────────────────────────────────
  const latestHeader = useLiveQuery(
    () => db.header.orderBy("height").reverse().first(),
    []
  );
  const [apiHeight, setApiHeight] = useState(0);

  useEffect(() => {
    const cancelledRef = { current: false };
    let retryId: ReturnType<typeof setTimeout>;
    let pollId: ReturnType<typeof setInterval>;

    const tryFetch = async () => {
      try {
        const h = await electrumWorker.value.getBlockHeight();
        if (!cancelledRef.current && h > 0) {
          setApiHeight(h);
          // Got a valid height — now just refresh every 60s
          pollId = setInterval(async () => {
            try {
              const next = await electrumWorker.value.getBlockHeight();
              if (!cancelledRef.current && next > 0) setApiHeight(next);
            } catch {
              /* ignore */
            }
          }, 60_000);
        } else if (!cancelledRef.current) {
          // Worker not ready yet — retry in 5s
          retryId = setTimeout(tryFetch, 5_000);
        }
      } catch {
        if (!cancelledRef.current) retryId = setTimeout(tryFetch, 5_000);
      }
    };

    tryFetch();
    return () => {
      cancelledRef.current = true;
      clearTimeout(retryId);
      clearInterval(pollId);
    };
  }, []);

  const currentHeight = apiHeight || latestHeader?.height || 0;
  const currentTimestamp = Math.floor(Date.now() / 1000);

  const vaults = useMemo(() => {
    if (!vaultsRaw) return vaultsRaw;
    const dir = sortAsc ? 1 : -1;
    return [...vaultsRaw].sort((a, b) => {
      switch (sortCol) {
        case "status": {
          const rank = (v: typeof a) =>
            v.claimed
              ? 2
              : isVaultClaimable(
                  v.locktime,
                  v.mode,
                  currentHeight,
                  currentTimestamp
                )
              ? 0
              : 1;
          return dir * (rank(a) - rank(b));
        }
        case "type":
          return dir * a.assetType.localeCompare(b.assetType);
        case "value":
          return dir * (a.value - b.value);
        case "locktime":
          return dir * (a.locktime - b.locktime);
        case "remaining": {
          const ra = vaultClaimableIn(
            a.locktime,
            a.mode,
            currentHeight,
            currentTimestamp
          );
          const rb = vaultClaimableIn(
            b.locktime,
            b.mode,
            currentHeight,
            currentTimestamp
          );
          return dir * (ra.value - rb.value);
        }
        case "label":
          return dir * (a.label ?? "").localeCompare(b.label ?? "");
        default:
          return 0;
      }
    });
  }, [vaultsRaw, sortCol, sortAsc, currentHeight, currentTimestamp]);

  // ────────────────────────────────────────────────────────
  // Locktime validation
  // ────────────────────────────────────────────────────────
  const locktimeInvalid = useMemo(() => {
    const lt = parseInt(locktime, 10);
    if (!lt) return false;
    if (mode === "block") {
      return currentHeight > 0 && lt <= currentHeight;
    }
    return lt <= currentTimestamp;
  }, [locktime, mode, currentHeight, currentTimestamp]);

  // ────────────────────────────────────────────────────────
  // Locktime hint text
  // ────────────────────────────────────────────────────────
  const locktimeHint = useMemo(() => {
    if (mode === "block") {
      const lt = parseInt(locktime, 10);
      if (!currentHeight) return t`Waiting for block data…`;
      if (!lt) return t`Current block: ${currentHeight.toLocaleString()}`;
      const diff = lt - currentHeight;
      if (diff <= 0)
        return t`⚠ Must be greater than current block (${currentHeight.toLocaleString()})`;
      return t`Current block: ${currentHeight.toLocaleString()} — locks for ${blocksToDuration(
        diff
      )}`;
    }
    const lt = parseInt(locktime, 10);
    if (!lt) return t`Current time: ${new Date().toLocaleString()}`;
    const diff = lt - currentTimestamp;
    if (diff <= 0) return t`⚠ Must be in the future`;
    return t`Current time: ${new Date().toLocaleString()} — locks for ${secsToDuration(
      diff
    )}`;
  }, [mode, locktime, currentHeight, currentTimestamp]);

  // ────────────────────────────────────────────────────────
  // Date picker <-> UNIX timestamp sync
  // ────────────────────────────────────────────────────────
  const handleLocktimeChange = useCallback(
    (val: string) => {
      setLocktime(val);
      if (mode === "time") {
        const ts = parseInt(val, 10);
        setDatePickerValue(ts > 0 ? unixToDateInput(ts) : "");
      }
    },
    [mode]
  );

  const handleDatePickerChange = useCallback((val: string) => {
    setDatePickerValue(val);
    const ts = dateInputToUnix(val);
    if (ts > 0) setLocktime(String(ts));
  }, []);

  // ────────────────────────────────────────────────────────
  // Self-fill recipient
  // ────────────────────────────────────────────────────────
  const fillSelf = useCallback(() => {
    setRecipient(wallet.value.address);
  }, [wallet.value.address]);

  // ────────────────────────────────────────────────────────
  // Tranche helpers
  // ────────────────────────────────────────────────────────
  const addTranche = useCallback(() => {
    if (tranches.length < VAULT_MAX_TRANCHES) {
      setTranches((prev) => [...prev, { locktime: "", value: "", pct: "" }]);
    }
  }, [tranches.length]);

  const removeTranche = useCallback(
    (index: number) => {
      if (tranches.length > 1) {
        setTranches((prev) => prev.filter((_, i) => i !== index));
      }
    },
    [tranches.length]
  );

  const updateTranche = useCallback(
    (index: number, field: keyof Tranche, val: string) => {
      setTranches((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], [field]: val };
        return updated;
      });
    },
    []
  );

  // ────────────────────────────────────────────────────────
  // Percentage mode: compute amounts from total + pct
  // Using basis points (1/100 of a percent) to avoid floating-point errors
  // ────────────────────────────────────────────────────────
  const pctAllocated = useMemo(() => {
    // Use basis points (divide by 100 for display, multiply for calculation)
    const totalBps = tranches.reduce((sum, tr) => {
      const bps = Math.round((parseFloat(tr.pct) || 0) * 100);
      return sum + bps;
    }, 0);
    return totalBps / 100;
  }, [tranches]);

  const pctRemaining = Math.max(0, 100 - pctAllocated);

  const autoFillLastPct = useCallback(() => {
    if (tranches.length === 0 || pctRemaining <= 0) return;
    setTranches((prev) => {
      const updated = [...prev];
      const lastIdx = updated.length - 1;
      const currentPct = parseFloat(updated[lastIdx].pct || "0");
      updated[lastIdx] = {
        ...updated[lastIdx],
        pct: (currentPct + pctRemaining).toFixed(2),
      };
      return updated;
    });
  }, [tranches.length, pctRemaining]);

  // Resolve tranche amounts: in percentage mode, compute from total
  const resolvedTranches = useMemo((): {
    locktime: number;
    value: number;
  }[] => {
    if (vestingInputMode === "percentage") {
      const total = Math.round(parseFloat(totalVestingAmount || "0") * 1e8);
      return tranches.map((tr) => ({
        locktime: parseInt(tr.locktime, 10) || 0,
        value: Math.round(total * ((parseFloat(tr.pct) || 0) / 100)),
      }));
    }
    return tranches.map((tr) => ({
      locktime: parseInt(tr.locktime, 10) || 0,
      value: Math.round(parseFloat(tr.value || "0") * 1e8),
    }));
  }, [tranches, vestingInputMode, totalVestingAmount]);

  // ────────────────────────────────────────────────────────
  // Apply a vesting preset
  // ────────────────────────────────────────────────────────
  const applyPreset = (presetId: PresetId) => {
    setSelectedPreset(presetId);
    if (presetId === "custom") return;

    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return;

    const pcts = preset.build(0);
    const count = pcts.length;

    // Switch to percentage mode
    setVestingInputMode("percentage");

    // Build tranches with percentages, locktimes left for interval auto-fill
    // Use basis points to avoid floating-point precision issues
    const bpsValues = pcts.map((pct) => Math.round(pct * 100));
    const sumBps = bpsValues.reduce((s, p) => s + p, 0);
    const diffBps = 10000 - sumBps; // 100% = 10000 basis points
    if (diffBps !== 0 && bpsValues.length > 0) {
      bpsValues[bpsValues.length - 1] += diffBps;
    }
    const formatted = bpsValues.map((bps) => (bps / 100).toFixed(2));
    const newTranches: Tranche[] = formatted.map((pct) => ({
      locktime: "",
      value: "",
      pct,
    }));
    setTranches(newTranches);

    // Auto-set interval step to ~1 month worth of blocks or seconds
    if (mode === "block") {
      const monthBlocks = Math.round((30 * 86400) / AVG_BLOCK_TIME_SEC);
      setIntervalStep(String(monthBlocks));
      if (currentHeight) setIntervalStart(String(currentHeight));
    } else {
      const monthSecs = 30 * 86400;
      setIntervalStep(String(monthSecs));
      setIntervalStartDate(unixToDateInput(currentTimestamp));
    }

    toast({
      title: preset.label,
      description: t`${count} tranches generated`,
      status: "info",
      duration: 2000,
    });
  };

  // ────────────────────────────────────────────────────────
  // Interval auto-fill: generate tranche locktimes
  // ────────────────────────────────────────────────────────
  const generateIntervalTranches = useCallback(() => {
    const count = tranches.length;
    if (count === 0) return;

    let start: number;
    const step = parseInt(intervalStep, 10);

    if (mode === "block") {
      start = parseInt(intervalStart, 10);
    } else {
      start = dateInputToUnix(intervalStartDate);
    }

    if (!start || !step || step <= 0) {
      toast({
        title: t`Error`,
        description: t`Fill in start and interval`,
        status: "error",
      });
      return;
    }

    const updated = tranches.map((tr, i) => ({
      ...tr,
      locktime: String(start + step * (i + 1)),
    }));
    setTranches(updated);
  }, [tranches, mode, intervalStart, intervalStartDate, intervalStep, toast]);

  // ────────────────────────────────────────────────────────
  // Create vault
  // ────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock" };
      return;
    }

    setLoading(true);
    try {
      const wif = wallet.value.wif.toString();
      const fromAddress = wallet.value.address;

      // Fetch RXD UTXOs for funding
      const coins = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();

      const coinInputs = coins.map((c) => ({
        txid: c.txid,
        vout: c.vout,
        script: c.script,
        value: c.value,
      }));

      // Fetch token UTXO for NFT/FT vaults
      let tokenUtxos:
        | { txid: string; vout: number; script: string; value: number }[]
        | undefined;
      if (assetType !== "rxd" && ref) {
        const refLE = ref.trim().toLowerCase();
        const contractType =
          assetType === "nft" ? ContractType.NFT : ContractType.FT;
        const tokenTxos = await db.txo
          .where({ contractType, spent: 0 })
          .filter((txo) => {
            const parsed =
              assetType === "nft"
                ? parseNftScript(txo.script)
                : parseFtScript(txo.script);
            return parsed.ref === refLE;
          })
          .toArray();
        if (tokenTxos.length === 0) {
          throw new Error(
            `No unspent ${assetType.toUpperCase()} UTXO found for ref ${refLE}. Make sure the token is in your wallet.`
          );
        }
        // For NFT take exactly 1; for FT take all UTXOs carrying this ref
        tokenUtxos = (
          assetType === "nft" ? tokenTxos.slice(0, 1) : tokenTxos
        ).map((t) => ({
          txid: t.txid,
          vout: t.vout,
          script: t.script,
          value: t.value,
        }));
      }

      // FT balance check: total available must cover the requested amount
      if (assetType === "ft" && tokenUtxos && !vesting) {
        const ftTotal = tokenUtxos.reduce((s, u) => s + u.value, 0);
        const valRequested = parseInt(amount, 10);
        if (valRequested > ftTotal) {
          throw new Error(
            `Insufficient FT balance: need ${valRequested} units but only ${ftTotal} available`
          );
        }
      }

      if (!vesting) {
        // Simple vault
        const lt = parseInt(locktime, 10);
        // For FT, amount is in token units (integer); for RXD, amount is in RXD (parsed as photons)
        const val =
          assetType === "ft"
            ? parseInt(amount, 10)
            : Math.round(parseFloat(amount) * 1e8);
        if (!lt || !val) {
          throw new Error("Fill in locktime and amount");
        }
        if (!recipientTrimmed) {
          throw new Error(
            t`Recipient address is required. Click 'Self' to use your own address.`
          );
        }
        if (!isVaultRecipientAddress(recipientTrimmed, wallet.value.net)) {
          throw new Error(
            t`Recipient must be a valid ${wallet.value.net} address. Funds locked to an invalid or wrong-network address can never be claimed.`
          );
        }
        if (isGift && !ackGift) {
          throw new Error(
            t`To lock funds to another address, confirm you'll share the recovery info with the recipient.`
          );
        }
        if (mode === "block" && currentHeight > 0 && lt <= currentHeight) {
          throw new Error(
            t`Block must be greater than current height (${currentHeight})`
          );
        }
        if (mode === "time" && lt <= currentTimestamp) {
          throw new Error(t`Timestamp must be in the future`);
        }

        const params: VaultParams = {
          mode,
          locktime: lt,
          assetType,
          recipientAddress: recipientTrimmed,
          // Third-party gift OR our own swap address: self-encrypt the OP_RETURN
          // (the sender key is always main). Gifts are claimed via the recovery
          // info we surface below, not by decrypting the OP_RETURN.
          shareRecoveryInfo: isGift || isOwnSwap || undefined,
          ref: assetType !== "rxd" ? ref : undefined,
          value: val,
          label: label || undefined,
        };

        const result = buildVaultTx(
          coinInputs,
          fromAddress,
          wif,
          params,
          feeRate.value,
          tokenUtxos
        );

        // Broadcast
        const txid = await electrumWorker.value.broadcast(result.rawTx);

        // Store vault record
        const now = Date.now();
        const record: VaultRecord = {
          txid,
          vout: 0,
          value: val,
          assetType,
          mode,
          locktime: lt,
          recipientAddress: recipientTrimmed,
          senderAddress: fromAddress,
          ref: assetType !== "rxd" ? ref : undefined,
          label: label || undefined,
          redeemScriptHex: result.redeemScriptHex,
          p2shScriptHex: p2shOutputScript(result.redeemScriptHex),
          claimed: 0,
          date: now,
          activityLog: [
            {
              timestamp: now,
              action: "created",
              txid,
              details: `Created ${assetType.toUpperCase()} vault with ${
                val / 1e8
              } ${assetType.toUpperCase()}`,
            },
          ],
        };
        console.log("[Vault Create] Storing record:", record);
        await db.vault.put(record);
        await electrumWorker.value.addVault(record);
        const verifyRecord = await db.vault.where({ txid }).first();
        console.log("[Vault Create] Verified stored record:", verifyRecord);
        await db.broadcast.put({
          txid,
          date: Date.now(),
          description: "vault_create",
        });

        toast({
          title: t`Vault Created`,
          description: txid,
          status: "success",
          duration: 8000,
          isClosable: true,
        });

        // Surface the TXID (self) or the shareable recovery info (gift).
        setLastCreated({
          txid,
          isSelf: !isGift,
          recoveryInfo: serializeRecoveryInfo([record]),
        });

        // Reset form and go to list
        setLocktime("");
        setDatePickerValue("");
        setAmount("");
        setLabel("");
        setRef("");
        setAckGift(false);
        setTab("list");
      } else {
        // Vesting schedule
        if (!recipientTrimmed) {
          throw new Error(
            t`Recipient address is required. Click 'Self' to use your own address.`
          );
        }
        if (!isVaultRecipientAddress(recipientTrimmed, wallet.value.net)) {
          throw new Error(
            t`Recipient must be a valid ${wallet.value.net} address. Funds locked to an invalid or wrong-network address can never be claimed.`
          );
        }
        if (isGift && !ackGift) {
          throw new Error(
            t`To lock funds to another address, confirm you'll share the recovery info with the recipient.`
          );
        }
        if (
          vestingInputMode === "percentage" &&
          Math.abs(pctAllocated - 100) > 0.01
        ) {
          throw new Error(
            t`Percentages must sum to 100% (currently ${pctAllocated.toFixed(
              2
            )}%)`
          );
        }

        for (let i = 0; i < resolvedTranches.length; i++) {
          const lt = resolvedTranches[i].locktime;
          if (!lt || lt <= 0) {
            const lockTypeLabel =
              mode === "block" ? "Block number" : "Timestamp";
            throw new Error(t`Tranche ${i + 1}: ${lockTypeLabel} is required`);
          }
          if (mode === "block" && currentHeight > 0 && lt <= currentHeight) {
            throw new Error(
              t`Tranche ${
                i + 1
              }: Block ${lt} must be greater than current height (${currentHeight})`
            );
          }
          if (mode === "time" && lt <= currentTimestamp) {
            throw new Error(
              t`Tranche ${i + 1}: Timestamp must be in the future`
            );
          }
        }

        // FT vesting balance check
        if (assetType === "ft" && tokenUtxos) {
          const ftTotal = tokenUtxos.reduce((s, u) => s + u.value, 0);
          const trancheTotal = resolvedTranches.reduce(
            (s, rt) => s + rt.value,
            0
          );
          if (trancheTotal > ftTotal) {
            throw new Error(
              `Insufficient FT balance: tranches total ${trancheTotal} units but only ${ftTotal} available`
            );
          }
        }

        const vestingTranches: VestingTranche[] = resolvedTranches.map(
          (rt) => ({
            mode,
            locktime: rt.locktime,
            assetType,
            recipientAddress: recipientTrimmed,
            shareRecoveryInfo: isGift || isOwnSwap || undefined,
            ref: assetType !== "rxd" ? ref : undefined,
            value: rt.value,
            label: label || undefined,
          })
        );

        const result = buildVestingTx(
          coinInputs,
          fromAddress,
          wif,
          vestingTranches,
          feeRate.value,
          tokenUtxos
        );

        const txid = await electrumWorker.value.broadcast(result.rawTx);

        // Store vault records for each tranche
        const vestingDate = Date.now();
        const createdRecords: VaultRecord[] = [];
        for (let i = 0; i < vestingTranches.length; i++) {
          const record: VaultRecord = {
            txid,
            vout: i,
            value: vestingTranches[i].value,
            assetType,
            mode,
            locktime: vestingTranches[i].locktime,
            recipientAddress: recipientTrimmed,
            senderAddress: fromAddress,
            ref: assetType !== "rxd" ? ref : undefined,
            label: label
              ? `${label} (${i + 1}/${vestingTranches.length})`
              : undefined,
            redeemScriptHex: result.redeemScripts[i],
            p2shScriptHex: p2shOutputScript(result.redeemScripts[i]),
            claimed: 0,
            date: vestingDate,
            activityLog: [
              {
                timestamp: vestingDate,
                action: "created",
                txid,
                details: `Created ${assetType.toUpperCase()} vesting tranche ${
                  i + 1
                }/${vestingTranches.length} with ${
                  vestingTranches[i].value / 1e8
                } ${assetType.toUpperCase()}`,
              },
            ],
          };
          await db.vault.put(record);
          await electrumWorker.value.addVault(record);
          createdRecords.push(record);
        }
        await db.broadcast.put({
          txid,
          date: Date.now(),
          description: "vault_vesting",
        });

        toast({
          title: t`Vesting Schedule Created`,
          description: t`${txid} — ${vestingTranches.length} tranches`,
          status: "success",
          duration: 8000,
          isClosable: true,
        });

        setLastCreated({
          txid,
          isSelf: !isGift,
          recoveryInfo: serializeRecoveryInfo(createdRecords),
        });
        setAckGift(false);
        setTranches([{ locktime: "", value: "", pct: "" }]);
        setTotalVestingAmount("");
        setLabel("");
        setRef("");
        setTab("list");
      }
    } catch (err: unknown) {
      toast({
        title: t`Error`,
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  // ────────────────────────────────────────────────────────
  // Claim vault
  // ────────────────────────────────────────────────────────
  const handleClaim = async (vault: VaultRecord) => {
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock" };
      return;
    }

    try {
      // A vault may be locked to either of this wallet's addresses (main or
      // swap). Sign the VAULT input with the key whose pkh matches the redeem
      // script; fee/funding inputs come from main coins, so they are signed
      // with the main key. Claimed funds always land in main.
      const useSwap =
        !!wallet.value.swapWif &&
        !!wallet.value.swapAddress &&
        vault.recipientAddress === wallet.value.swapAddress;
      const wif = (
        useSwap ? wallet.value.swapWif! : wallet.value.wif
      ).toString();
      const fundingWif = useSwap ? wallet.value.wif.toString() : undefined;
      const toAddress = wallet.value.address;

      // Don't waste a fee on an already-spent vault: confirm the UTXO is still
      // live before building the claim (covers a stale claimed flag / a claim
      // made on another device).
      try {
        const liveUtxos = await electrumWorker.value.getUtxosByScriptHash(
          vaultScriptHash(vault.redeemScriptHex)
        );
        const stillLive = liveUtxos?.some(
          (u) => u.tx_hash === vault.txid && u.tx_pos === vault.vout
        );
        if (liveUtxos && !stillLive) {
          await db.vault
            .where({ txid: vault.txid, vout: vault.vout })
            .modify({ claimed: 1 });
          toast({
            title: t`Already claimed`,
            description: t`This vault has already been spent.`,
            status: "info",
          });
          return;
        }
      } catch {
        // Couldn't check — proceed; a spent vault fails the broadcast safely.
      }

      // For NFT/FT vaults the locked value is dust (546 photons) and the fee
      // must come from additional RXD UTXOs. For RXD vaults the fee comes out
      // of the vault value unless the vault is too small (in which case we
      // fall through to the same funding callback).
      //
      // Pre-fetch all spendable RXD UTXOs sorted by descending value so the
      // selectMoreFunding callback can serve them on demand as
      // claimVaultTx iterates fee estimation.
      const rxdTxos = await db.txo
        .where({ contractType: ContractType.RXD, spent: 0 })
        .toArray();
      const fundingPool: FundingUtxo[] = rxdTxos
        .sort((a, b) => b.value - a.value)
        .map((t) => ({
          txid: t.txid,
          vout: t.vout,
          script: t.script,
          value: t.value,
        }));

      const selectMoreFunding = (
        needed: number,
        alreadyHave: FundingUtxo[]
      ): FundingUtxo[] => {
        const usedKeys = new Set(alreadyHave.map((u) => `${u.txid}:${u.vout}`));
        const additional: FundingUtxo[] = [];
        let accumulated = 0;
        for (const utxo of fundingPool) {
          if (accumulated >= needed) break;
          const key = `${utxo.txid}:${utxo.vout}`;
          if (usedKeys.has(key)) continue;
          additional.push(utxo);
          accumulated += utxo.value;
        }
        return additional;
      };

      const result = claimVaultTx(
        {
          txid: vault.txid,
          vout: vault.vout,
          value: vault.value,
          redeemScriptHex: vault.redeemScriptHex,
        },
        toAddress,
        wif,
        feeRate.value,
        // Start with zero funding; let the callback iterate fee → UTXOs.
        // For RXD vaults this lets claimVaultTx try to pay from the vault
        // itself first and only pull funding if the vault is too small.
        undefined,
        toAddress,
        selectMoreFunding,
        fundingWif
      );

      const claimTxid = await electrumWorker.value.broadcast(result.rawTx);
      const claimDate = Date.now();

      // Optimistically mark the token glyph as spent so the UI updates
      // before the next ElectrumX sync (NFT/FT vaults only)
      if (vault.assetType !== "rxd" && vault.ref) {
        const glyphRef = reverseRef(vault.ref);
        await db.glyph.where({ ref: glyphRef }).modify({ spent: 1 });
      }

      // Update vault with claim information and activity log
      await db.vault
        .where({ txid: vault.txid, vout: vault.vout })
        .modify((v) => {
          v.claimed = 1;
          v.claimTxid = claimTxid;
          v.claimDate = claimDate;
          // claimHeight will be set when we receive confirmation
          if (!v.activityLog) {
            v.activityLog = [];
          }
          v.activityLog.push({
            timestamp: claimDate,
            action: "claimed",
            txid: claimTxid,
            details: `Claimed ${v.value / 1e8} ${v.assetType.toUpperCase()}`,
          });
        });
      await db.broadcast.put({
        txid: claimTxid,
        date: claimDate,
        description: "vault_claim",
      });

      toast({
        title: t`Vault Claimed`,
        description: claimTxid,
        status: "success",
        duration: 8000,
        isClosable: true,
      });
    } catch (err: unknown) {
      toast({
        title: t`Claim Failed`,
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    }
  };

  // ────────────────────────────────────────────────────────
  // Scan for vaults (manual discovery)
  // ────────────────────────────────────────────────────────
  const handleScan = async () => {
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock" };
      return;
    }

    setScanning(true);
    try {
      const wif = wallet.value.wif.toString();
      const swapWif = wallet.value.swapWif?.toString();
      // Scan main address - also try swapWif for decryption if main fails
      const mainResult = await electrumWorker.value.discoverVaults(
        wif,
        wallet.value.address,
        swapWif // Try swap WIF if main fails to decrypt
      );

      // Scan swap address if different, then aggregate both scans so a partial
      // result on either address is reflected in the combined skipped count.
      let agg = { ...mainResult };
      if (swapWif && wallet.value.swapAddress) {
        const swapResult = await electrumWorker.value.discoverVaults(
          swapWif,
          wallet.value.swapAddress,
          wif // Try main WIF if swap fails to decrypt
        );
        agg = {
          discovered: agg.discovered + swapResult.discovered,
          scanned: agg.scanned + swapResult.scanned,
          total: agg.total + swapResult.total,
          skipped: agg.skipped + swapResult.skipped,
        };
      }

      const complete = agg.skipped === 0;

      // Update last scan state
      const now = Date.now();
      setLastScan({ timestamp: now, ...agg, complete });

      if (agg.skipped > 0) {
        // Partial scan — do NOT show a bare success that could read as "all
        // clear". Tell the user some history couldn't be reached and to retry.
        toast({
          title: t`Scan Incomplete`,
          description: t`Found ${agg.discovered} vault(s). ${agg.skipped} transaction(s) could not be scanned — tap Scan again to retry.`,
          status: "warning",
          duration: 9000,
          isClosable: true,
        });
      } else if (agg.discovered > 0) {
        toast({
          title: t`Vaults Discovered`,
          description: t`Found ${agg.discovered} vault(s) in transaction history`,
          status: "success",
          duration: 5000,
        });
      } else {
        toast({
          title: t`No Vaults Found`,
          description: t`No timelocked coins found in transaction history`,
          status: "info",
          duration: 3000,
        });
      }
    } catch (err: unknown) {
      // A history-load failure throws VAULT_SCAN_FAILED across the worker
      // boundary (instanceof is lost, so match on the message). Show a load
      // error rather than the misleading "No vaults found".
      const historyFailed =
        err instanceof Error && err.message === VAULT_SCAN_FAILED;
      toast({
        title: t`Scan Failed`,
        description: historyFailed
          ? t`Could not load transaction history — try again`
          : err instanceof Error
          ? err.message
          : String(err),
        status: "error",
        duration: 7000,
        isClosable: true,
      });
    } finally {
      setScanning(false);
    }
  };

  // ────────────────────────────────────────────────────────
  // Export the full vault list to a JSON file. This is the durable backup
  // that the recovery phrase does NOT provide — it carries the txids and redeem
  // scripts needed to find and claim every vault after a wallet rebuild.
  // ────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    try {
      const all = await db.vault.toArray();
      if (all.length === 0) {
        toast({
          title: t`No vaults to export`,
          description: t`Create or recover a vault first.`,
          status: "info",
        });
        return;
      }
      const payload = {
        type: "photonic-vault-backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        address: wallet.value.address,
        vaults: all,
      };
      await saveFile(
        `photonic-vaults-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(payload, null, 2),
        "application/json",
      );
      toast({
        title: t`Vault list exported`,
        description: t`${all.length} vault(s) saved. Keep this file with your recovery phrase.`,
        status: "success",
        duration: 6000,
      });
    } catch (err: unknown) {
      toast({
        title: t`Export Failed`,
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    }
  }, [toast]);

  // ────────────────────────────────────────────────────────
  // Import recovery info shared by a sender (gift / inheritance / vesting).
  // Trustless: each entry is verified against the on-chain output using THIS
  // wallet's own address, so only vaults actually locked to us are imported —
  // a forged blob cannot make us adopt a vault that isn't ours.
  // ────────────────────────────────────────────────────────
  const handleImportRecovery = useCallback(async () => {
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock" };
      return;
    }
    const { kind, entries } = parseRecoveryPayload(importText);
    if (entries.length === 0) {
      toast({
        title: t`Nothing to import`,
        description: t`Paste the recovery info (JSON) the sender shared with you.`,
        status: "warning",
      });
      return;
    }
    const MAX_IMPORT = 500;
    if (entries.length > MAX_IMPORT) {
      toast({
        title: t`Too many entries`,
        description: t`Import is limited to ${MAX_IMPORT} vaults at a time.`,
        status: "warning",
      });
      return;
    }
    setImporting(true);
    try {
      const ownAddresses = [
        wallet.value.address,
        wallet.value.swapAddress,
      ].filter(Boolean) as string[];

      // Fetch each referenced transaction once.
      const byTxid = new Map<string, typeof entries>();
      for (const e of entries) {
        const list = byTxid.get(e.txid) ?? [];
        list.push(e);
        byTxid.set(e.txid, list);
      }

      let added = 0;
      let rejected = 0;
      let duplicate = 0;
      for (const [txid, group] of byTxid) {
        const rawTx = await electrumWorker.value.getTransaction(txid);
        if (!rawTx) {
          rejected += group.length;
          continue;
        }
        // Best-effort provenance: who funded (i.e. sent) this vault. Empty when
        // it can't be derived — never the importer's own address.
        const senderAddress =
          extractVaultSenderAddress(rawTx, wallet.value.net) ?? "";
        const existing = await db.vault.where("txid").equals(txid).toArray();
        const knownVouts = new Set(existing.map((v) => v.vout));
        for (const entry of group) {
          let matched: ReturnType<typeof verifyVaultRecoveryInfo> = null;
          for (const addr of ownAddresses) {
            matched = verifyVaultRecoveryInfo(rawTx, entry, addr);
            if (matched) break;
          }
          if (!matched) {
            rejected++;
            continue;
          }
          const v = matched; // non-null, stable snapshot for the closures below
          if (knownVouts.has(v.vout)) {
            duplicate++;
            continue;
          }

          // Capture the confirmation height when the vault output is present in
          // the (confirmed) UTXO set, so the worker's spent-detection — which
          // skips height-less records — can reconcile it later. Absence here is
          // NOT treated as spent: listunspent omits mempool, so a just-broadcast
          // unconfirmed gift would look absent. A genuinely already-spent vault
          // is caught by the pre-claim check in handleClaim (a claimable vault
          // is long past confirmation, so an empty UTXO set there means spent).
          let height: number | undefined;
          try {
            const utxos = await electrumWorker.value.getUtxosByScriptHash(
              vaultScriptHash(v.redeemScriptHex)
            );
            const live = utxos?.find(
              (u) => u.tx_hash === txid && u.tx_pos === v.vout
            );
            if (live && live.height > 0) height = live.height;
          } catch {
            // Network hiccup — import without a height; a later scan reconciles.
          }

          const now = Date.now();
          const record: VaultRecord = {
            txid,
            vout: v.vout,
            value: v.params.value,
            assetType: v.params.assetType,
            mode: v.params.mode,
            locktime: v.params.locktime,
            recipientAddress: v.params.recipientAddress,
            senderAddress,
            ref: v.params.ref,
            label: entry.label || v.params.label,
            redeemScriptHex: v.redeemScriptHex,
            p2shScriptHex: v.p2shScriptHex,
            claimed: 0,
            height,
            date: now,
            activityLog: [
              {
                timestamp: now,
                action: "restored",
                txid,
                details: `Imported ${v.params.assetType.toUpperCase()} vault from shared recovery info`,
                height,
              },
            ],
          };
          try {
            await electrumWorker.value.addVault(record);
            knownVouts.add(v.vout);
            added++;
          } catch {
            // Unique [txid+vout] constraint hit by a concurrent writer — treat
            // as already present rather than aborting the whole batch.
            duplicate++;
          }
        }
      }

      // A backup file also lists vaults the user SENT to others; those
      // correctly fail to import (locked to the recipient), so frame the
      // "rejected" count as expected rather than alarming.
      const isBackup = kind === "backup";
      const rejectedNote = isBackup
        ? t`${rejected} are held by their recipients (vaults you sent)`
        : t`${rejected} not for this wallet`;

      if (added > 0) {
        toast({
          title: t`Recovery info imported`,
          description: t`Added ${added} vault(s). ${rejectedNote}, ${duplicate} already present.`,
          status: "success",
          duration: 7000,
        });
        setImportText("");
        setShowImport(false);
      } else {
        toast({
          title: t`No vaults imported`,
          description: isBackup
            ? t`Every vault in this backup is either already in your list or was sent to someone else (only the recipient can import those).`
            : rejected > 0
            ? t`None of these vaults are locked to this wallet (they may be for a different address), or the transaction couldn't be found.`
            : t`These vaults are already in your list.`,
          status: rejected > 0 && !isBackup ? "error" : "info",
          duration: 7000,
        });
      }
    } catch (err: unknown) {
      toast({
        title: t`Import failed`,
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setImporting(false);
    }
  }, [
    importText,
    toast,
    wallet.value.locked,
    wallet.value.wif,
    wallet.value.address,
    wallet.value.swapAddress,
  ]);

  // ────────────────────────────────────────────────────────
  // Check specific transaction for vault (manual recovery by TXID)
  const handleCheckTx = useCallback(async () => {
    if (wallet.value.locked || !wallet.value.wif) {
      openModal.value = { modal: "unlock" };
      return;
    }
    if (!checkTxId.trim()) {
      toast({
        title: t`Enter Transaction ID`,
        description: t`Please paste a transaction ID to check`,
        status: "warning",
      });
      return;
    }

    setCheckingTx(true);
    try {
      const txid = checkTxId.trim();
      console.log(`[Vault Check] Checking transaction: ${txid}`);

      // Fetch the raw transaction
      const rawTx = await electrumWorker.value.getTransaction(txid);
      if (!rawTx) {
        toast({
          title: t`Transaction Not Found`,
          description: t`Could not fetch tx ${txid}`,
          status: "error",
        });
        return;
      }

      console.log(`[Vault Check] Raw tx length: ${rawTx.length}`);

      // Try to recover vaults with main address first
      console.log(
        `[Vault Check] Trying with main address: ${wallet.value.address}`
      );
      const wif = wallet.value.wif.toString();
      let recovered = recoverVaultsFromTx(
        rawTx,
        txid,
        wif,
        wallet.value.address
      );

      // If no vaults found and we have a swap address, try that too
      if (
        recovered.length === 0 &&
        wallet.value.swapAddress &&
        wallet.value.swapWif
      ) {
        console.log(
          `[Vault Check] Trying with swap address: ${wallet.value.swapAddress}`
        );
        const swapWif = wallet.value.swapWif.toString();
        recovered = recoverVaultsFromTx(
          rawTx,
          txid,
          swapWif,
          wallet.value.swapAddress
        );
      }

      if (recovered.length > 0) {
        // Skip outputs already in the DB (re-paste, or a tranche we already
        // have) — the [txid+vout] unique index would otherwise reject the put.
        const now = Date.now();
        const existing = await db.vault.where("txid").equals(txid).toArray();
        const knownVouts = new Set(existing.map((v) => v.vout));
        let added = 0;
        for (const vaultData of recovered) {
          if (knownVouts.has(vaultData.vout)) continue;
          const record: VaultRecord = {
            txid,
            vout: vaultData.vout,
            value: vaultData.params.value,
            assetType: vaultData.params.assetType,
            mode: vaultData.params.mode,
            locktime: vaultData.params.locktime,
            // recoverVaultsFromTx only returns a vault when THIS wallet is the
            // recipient, so the matched address is the recipient (and, for
            // self-vaults, also the sender). Don't fabricate a different sender.
            recipientAddress: vaultData.params.recipientAddress,
            senderAddress: vaultData.params.recipientAddress,
            ref: vaultData.params.ref,
            label: vaultData.params.label,
            redeemScriptHex: vaultData.redeemScriptHex,
            p2shScriptHex: vaultData.p2shScriptHex,
            claimed: 0,
            date: now,
            activityLog: [
              {
                timestamp: now,
                action: "restored",
                txid,
                details: `Recovered ${vaultData.params.assetType.toUpperCase()} vault by transaction ID`,
              },
            ],
          };
          // addVault persists AND subscribes for spent/claim detection.
          await electrumWorker.value.addVault(record);
          added++;
        }
        toast({
          title: added > 0 ? t`Vault recovered` : t`Already in your list`,
          description:
            added > 0
              ? t`Added ${added} vault(s) from this transaction to My Vaults.`
              : t`This vault is already in My Vaults.`,
          status: "success",
          duration: 6000,
        });
        setCheckTxId("");
        setShowRecover(false);
      } else {
        toast({
          title: t`No vault found`,
          description: t`No vault for this wallet was found in that transaction. If someone gifted you a vault, use "Import recovery info" with the details they shared instead. Otherwise, double-check the transaction ID and that you're using the right wallet.`,
          status: "info",
          duration: 8000,
        });
      }
    } catch (err: unknown) {
      console.error("[Vault Check] Error:", err);
      toast({
        title: t`Check Failed`,
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setCheckingTx(false);
    }
  }, [
    checkTxId,
    wallet.value.locked,
    wallet.value.wif,
    wallet.value.address,
    wallet.value.swapAddress,
    wallet.value.swapWif,
    toast,
  ]);

  // ────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────
  return (
    <ContentContainer>
      <Container maxW="container.md" px={4}>
        <PageHeader>{t`Vault`}</PageHeader>

        {/* Tabs */}
        <HStack mb={6} gap={2}>
          <Button
            size="sm"
            variant={tab === "list" ? "subtle" : "ghost"}
            onClick={() => setTab("list")}
          >
            {t`My Vaults`}
          </Button>
          <Button
            size="sm"
            variant={tab === "create" ? "subtle" : "ghost"}
            onClick={() => setTab("create")}
          >
            {t`Create Vault`}
          </Button>
        </HStack>

        {/* ───────── CREATE TAB ───────── */}
        {tab === "create" && (
          <VStack gap={4} align="stretch">
            <FormControl>
              <FormLabel>{t`Recipient Address`}</FormLabel>
              <HStack>
                <Input
                  value={recipient}
                  onChange={(e) => {
                    setRecipient(e.target.value);
                    // Re-confirm the gift acknowledgment for each new recipient.
                    setAckGift(false);
                  }}
                  placeholder={t`Radiant address`}
                  fontFamily="mono"
                  size="sm"
                />
                <Button size="sm" onClick={fillSelf} variant="solid">
                  {t`Self`}
                </Button>
              </HStack>
            </FormControl>

            {/* Gifting / inheritance / vesting-to-others guidance */}
            {isGift && (
              <Alert
                status="warning"
                variant="subtle"
                borderRadius="md"
                alignItems="flex-start"
                fontSize="sm"
              >
                <AlertIcon as={TbGift} />
                <Box>
                  <Text fontWeight="semibold">
                    {t`You're locking funds to someone else's address`}
                  </Text>
                  <Text fontSize="xs" color="whiteAlpha.700" mb={2}>
                    {t`This is a gift, inheritance, or vesting for another person. Their wallet can't discover it on its own and their recovery phrase won't reveal it. After you create it, you'll get a "recovery info" blob — send it to them so they can import and claim the vault when it unlocks.`}
                  </Text>
                  <Checkbox
                    size="sm"
                    isChecked={ackGift}
                    onChange={(e) => setAckGift(e.target.checked)}
                  >
                    <Text fontSize="xs">
                      {t`I understand I must share the recovery info with the recipient, or they can't claim it.`}
                    </Text>
                  </Checkbox>
                </Box>
              </Alert>
            )}

            <SimpleGrid columns={2} gap={4}>
              <FormControl>
                <FormLabel>{t`Asset Type`}</FormLabel>
                <Select
                  size="sm"
                  value={assetType}
                  title={t`Asset Type`}
                  aria-label={t`Asset Type`}
                  onChange={(e) =>
                    setAssetType(e.target.value as VaultAssetType)
                  }
                >
                  <option value="rxd">{t`RXD`}</option>
                  <option value="nft">{t`NFT`}</option>
                  <option value="ft">{t`FT`}</option>
                </Select>
              </FormControl>

              <FormControl>
                <FormLabel>{t`Lock Mode`}</FormLabel>
                <Select
                  size="sm"
                  value={mode}
                  title={t`Lock Mode`}
                  aria-label={t`Lock Mode`}
                  onChange={(e) => setMode(e.target.value as VaultMode)}
                >
                  <option value="block">{t`Block Height`}</option>
                  <option value="time">{t`Unix Timestamp`}</option>
                </Select>
              </FormControl>
            </SimpleGrid>

            {assetType !== "rxd" && (
              <FormControl>
                <FormLabel>
                  {assetType === "nft" ? t`NFT Token` : t`FT Token`}
                </FormLabel>
                {!refManual ? (
                  <>
                    <Select
                      size="sm"
                      value={ref}
                      title={assetType === "nft" ? t`NFT Token` : t`FT Token`}
                      aria-label={
                        assetType === "nft" ? t`NFT Token` : t`FT Token`
                      }
                      onChange={(e) => setRef(e.target.value)}
                      placeholder={t`Select a token from your wallet…`}
                      fontFamily="mono"
                    >
                      {(ownedTokens || []).map((g: SmartToken) => (
                        <option key={g.ref} value={reverseRef(g.ref)}>
                          {g.name || g.ticker || g.ref.slice(0, 16) + "…"}
                          {assetType === "nft" ? " [NFT]" : ""}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="xs"
                      variant="ghost"
                      mt={1}
                      onClick={() => setRefManual(true)}
                    >
                      {t`Enter ref manually`}
                    </Button>
                  </>
                ) : (
                  <>
                    <Input
                      value={ref}
                      onChange={(e) => setRef(e.target.value)}
                      placeholder={t`72 character LE hex`}
                      fontFamily="mono"
                      size="sm"
                    />
                    <Button
                      size="xs"
                      variant="ghost"
                      mt={1}
                      onClick={() => setRefManual(false)}
                    >
                      {t`Pick from wallet`}
                    </Button>
                  </>
                )}
              </FormControl>
            )}

            <FormControl display="flex" alignItems="center" gap={2}>
              <Switch
                isChecked={vesting}
                onChange={(e) => setVesting(e.target.checked)}
              />
              <FormLabel mb={0}>{t`Vesting Schedule`}</FormLabel>
            </FormControl>

            {!vesting ? (
              /* ───── Simple vault locktime + amount ───── */
              <VStack gap={4} align="stretch">
                <SimpleGrid columns={2} gap={4}>
                  <FormControl isInvalid={locktimeInvalid}>
                    <FormLabel>
                      {mode === "block"
                        ? t`Lock Until Block`
                        : t`Lock Until (Unix)`}
                    </FormLabel>
                    <Input
                      size="sm"
                      value={locktime}
                      onChange={(e) => handleLocktimeChange(e.target.value)}
                      placeholder={
                        mode === "block"
                          ? currentHeight
                            ? `e.g. ${currentHeight + 8640}`
                            : `Max ${VAULT_MAX_LOCKTIME_BLOCKS}`
                          : "Unix timestamp"
                      }
                      type="number"
                    />
                    <FormHelperText
                      fontSize="xs"
                      color={locktimeInvalid ? "red.300" : "whiteAlpha.500"}
                    >
                      {locktimeHint}
                    </FormHelperText>
                  </FormControl>
                  <FormControl>
                    <FormLabel>
                      {assetType === "ft"
                        ? t`Amount (token units)`
                        : assetType === "nft"
                        ? t`Amount (RXD dust)`
                        : t`Amount (RXD)`}
                    </FormLabel>
                    <Input
                      size="sm"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder={assetType === "ft" ? "0" : "0.00"}
                    />
                  </FormControl>
                </SimpleGrid>

                {/* Date picker for timestamp mode */}
                {mode === "time" && (
                  <FormControl>
                    <FormLabel>{t`Pick a Date`}</FormLabel>
                    <Input
                      type="datetime-local"
                      size="sm"
                      value={datePickerValue}
                      onChange={(e) => handleDatePickerChange(e.target.value)}
                    />
                  </FormControl>
                )}
              </VStack>
            ) : (
              /* ───── Vesting tranches ───── */
              <VStack gap={3} align="stretch">
                {/* Mode toggle + total amount (percentage mode) */}
                <HStack justify="space-between" align="center">
                  <Heading size="xs">
                    {t`Tranches`} ({tranches.length}/{VAULT_MAX_TRANCHES})
                  </Heading>
                  <HStack gap={1}>
                    <Button
                      size="xs"
                      variant={
                        vestingInputMode === "manual" ? "solid" : "ghost"
                      }
                      onClick={() => setVestingInputMode("manual")}
                    >
                      {t`Manual`}
                    </Button>
                    <Button
                      size="xs"
                      variant={
                        vestingInputMode === "percentage" ? "solid" : "ghost"
                      }
                      onClick={() => setVestingInputMode("percentage")}
                    >
                      {t`Percentage`}
                    </Button>
                  </HStack>
                </HStack>

                {/* Preset templates */}
                <Box
                  p={3}
                  borderWidth="1px"
                  borderColor="border.default"
                  borderRadius="md"
                >
                  <Text
                    fontSize="xs"
                    fontWeight="bold"
                    mb={2}
                  >{t`Preset Templates`}</Text>
                  <SimpleGrid columns={2} gap={2}>
                    {PRESETS.map((p) => (
                      <Button
                        key={p.id}
                        size="xs"
                        variant={selectedPreset === p.id ? "solid" : "outline"}
                        onClick={() => applyPreset(p.id)}
                        whiteSpace="normal"
                        textAlign="left"
                        h="auto"
                        py={2}
                      >
                        <VStack align="start" gap={0}>
                          <Text fontSize="xs" fontWeight="bold">
                            {p.label}
                          </Text>
                          <Text fontSize="2xs" opacity={0.7}>
                            {p.description}
                          </Text>
                        </VStack>
                      </Button>
                    ))}
                  </SimpleGrid>
                </Box>

                {vestingInputMode === "percentage" && (
                  <FormControl>
                    <FormLabel>{t`Total Vesting Amount (RXD)`}</FormLabel>
                    <Input
                      size="sm"
                      value={totalVestingAmount}
                      onChange={(e) => setTotalVestingAmount(e.target.value)}
                      placeholder={t`e.g. 10000`}
                    />
                  </FormControl>
                )}

                {/* Interval auto-fill */}
                <Box
                  p={3}
                  borderWidth="1px"
                  borderColor="border.default"
                  borderRadius="md"
                >
                  <HStack mb={2}>
                    <Icon as={TbWand} />
                    <Text
                      fontSize="xs"
                      fontWeight="bold"
                    >{t`Auto-fill Schedule`}</Text>
                  </HStack>
                  <SimpleGrid columns={2} gap={2}>
                    {mode === "block" ? (
                      <Input
                        size="xs"
                        value={intervalStart}
                        onChange={(e) => setIntervalStart(e.target.value)}
                        placeholder={
                          t`Start block` +
                          (currentHeight
                            ? ` (${t`now`}: ${currentHeight})`
                            : "")
                        }
                      />
                    ) : (
                      <Input
                        type="datetime-local"
                        size="xs"
                        value={intervalStartDate}
                        onChange={(e) => setIntervalStartDate(e.target.value)}
                      />
                    )}
                    <Input
                      size="xs"
                      value={intervalStep}
                      onChange={(e) => setIntervalStep(e.target.value)}
                      placeholder={
                        mode === "block"
                          ? t`Interval (blocks)`
                          : t`Interval (seconds)`
                      }
                    />
                  </SimpleGrid>
                  {mode === "block" && intervalStep && (
                    <Text fontSize="xs" color="whiteAlpha.500" mt={1}>
                      {t`Interval`}:{" "}
                      {blocksToDuration(parseInt(intervalStep, 10) || 0)}
                    </Text>
                  )}
                  {mode === "time" && intervalStep && (
                    <Text fontSize="xs" color="whiteAlpha.500" mt={1}>
                      {t`Interval`}:{" "}
                      {secsToDuration(parseInt(intervalStep, 10) || 0)}
                    </Text>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    leftIcon={<TbWand />}
                    onClick={generateIntervalTranches}
                    mt={2}
                  >
                    {t`Generate`}
                  </Button>
                </Box>

                <Divider borderColor="border.subtle" />

                {/* Tranche rows */}
                {tranches.map((tr, i) => {
                  const lt = parseInt(tr.locktime, 10);
                  const locktimeEmpty = !tr.locktime;
                  const locktimePast =
                    mode === "block"
                      ? currentHeight > 0 && !!lt && lt <= currentHeight
                      : !!lt && lt <= currentTimestamp;
                  const locktimeInvalidRow = locktimeEmpty || locktimePast;
                  return (
                    <HStack key={i} gap={2}>
                      <Input
                        flex={1}
                        size="sm"
                        value={tr.locktime}
                        onChange={(e) =>
                          updateTranche(i, "locktime", e.target.value)
                        }
                        placeholder={
                          mode === "block"
                            ? t`Block #${i + 1}`
                            : t`Timestamp #${i + 1}`
                        }
                        isInvalid={locktimeInvalidRow}
                        borderColor={locktimeInvalidRow ? "red.400" : undefined}
                      />
                      {vestingInputMode === "manual" ? (
                        <Input
                          flex={1}
                          size="sm"
                          value={tr.value}
                          onChange={(e) =>
                            updateTranche(i, "value", e.target.value)
                          }
                          placeholder={t`Amount (RXD)`}
                        />
                      ) : (
                        <Input
                          flex={1}
                          size="sm"
                          value={tr.pct}
                          onChange={(e) =>
                            updateTranche(i, "pct", e.target.value)
                          }
                          placeholder={`% ${t`of total`}`}
                        />
                      )}
                      {vestingInputMode === "percentage" && (
                        <Text
                          fontSize="xs"
                          color="whiteAlpha.500"
                          minW="60px"
                          textAlign="right"
                        >
                          {resolvedTranches[i]
                            ? (resolvedTranches[i].value / 1e8).toFixed(2)
                            : "0.00"}{" "}
                          {t`RXD`}
                        </Text>
                      )}
                      <IconButton
                        aria-label={t`Remove`}
                        icon={<TbTrash />}
                        size="sm"
                        variant="ghost"
                        isDisabled={tranches.length <= 1}
                        onClick={() => removeTranche(i)}
                      />
                    </HStack>
                  );
                })}

                {/* Add tranche button */}
                {tranches.length < VAULT_MAX_TRANCHES && (
                  <Button
                    size="xs"
                    variant="ghost"
                    leftIcon={<TbPlus />}
                    onClick={addTranche}
                    alignSelf="flex-start"
                  >
                    {t`Add Tranche`}
                  </Button>
                )}

                {/* Percentage allocation bar */}
                {vestingInputMode === "percentage" && (
                  <Box>
                    <HStack justify="space-between" mb={1}>
                      <Text fontSize="xs" color="whiteAlpha.600">
                        {t`Allocated`}: {pctAllocated.toFixed(1)}%
                      </Text>
                      <HStack gap={2}>
                        <Text fontSize="xs" color="whiteAlpha.600">
                          {t`Remaining`}: {pctRemaining.toFixed(1)}%
                        </Text>
                        {pctRemaining > 0 && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={autoFillLastPct}
                          >
                            {t`Auto-fill`}
                          </Button>
                        )}
                      </HStack>
                    </HStack>
                    <Progress
                      value={pctAllocated}
                      size="xs"
                      colorScheme={
                        Math.abs(pctAllocated - 100) < 0.01
                          ? "green"
                          : pctAllocated > 100
                          ? "red"
                          : "blue"
                      }
                      borderRadius="full"
                    />
                  </Box>
                )}
              </VStack>
            )}

            <FormControl>
              <FormLabel>{t`Label (optional)`}</FormLabel>
              <Input
                size="sm"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t`e.g. Savings, Vesting Q1`}
              />
            </FormControl>

            <Button
              variant="primary"
              isLoading={loading}
              onClick={handleCreate}
              mt={2}
            >
              {vesting ? t`Create Vesting Schedule` : t`Lock in Vault`}
            </Button>
          </VStack>
        )}

        {/* ───────── LIST TAB ───────── */}
        {tab === "list" && (
          <Box overflowX="auto">
            {/* Durability reminder — vault records live only on this device */}
            <Alert
              status="info"
              variant="subtle"
              borderRadius="md"
              mb={4}
              alignItems="flex-start"
              fontSize="sm"
            >
              <AlertIcon />
              <Box>
                <Text fontWeight="semibold">
                  {t`Vault records are stored only on this device`}
                </Text>
                <Text fontSize="xs" color="whiteAlpha.700">
                  {t`Your recovery phrase does not back up vaults. Save each vault's transaction ID — and export your vault list — so you can restore access after a wallet rebuild, a browser-data clear, or on a new device.`}
                </Text>
              </Box>
            </Alert>

            {/* Just-created vault — surface the TXID to back up */}
            {lastCreated && (
              <Alert
                status="success"
                variant="subtle"
                borderRadius="md"
                mb={4}
                alignItems="flex-start"
              >
                <AlertIcon />
                <Box flex={1} minW={0}>
                  <Text fontWeight="semibold" fontSize="sm">
                    {lastCreated.isSelf
                      ? t`Vault created — save this transaction ID`
                      : t`Vault created — send the recovery info to the recipient`}
                  </Text>
                  <Text fontSize="xs" color="whiteAlpha.700" mb={2}>
                    {lastCreated.isSelf
                      ? t`This TXID is your off-chain record. Keep it safe — you can recover this vault by pasting it into "Recover by TXID" after a wallet rebuild.`
                      : t`The recipient's wallet can't find this vault on its own. Send them the recovery info below — it's the only way they can import and claim it. Their recovery phrase alone won't reveal it.`}
                  </Text>
                  <HStack
                    bg="blackAlpha.300"
                    borderRadius="md"
                    px={2}
                    py={1}
                    gap={2}
                  >
                    <Code
                      bg="transparent"
                      fontSize="xs"
                      wordBreak="break-all"
                      flex={1}
                    >
                      {lastCreated.txid}
                    </Code>
                    <Tooltip
                      label={copiedCreated ? t`Copied!` : t`Copy TXID`}
                      placement="top"
                    >
                      <IconButton
                        aria-label={t`Copy TXID`}
                        icon={<CopyIcon />}
                        size="xs"
                        variant="ghost"
                        onClick={copyCreatedTxid}
                      />
                    </Tooltip>
                  </HStack>
                  {!lastCreated.isSelf && (
                    <Button
                      size="xs"
                      mt={2}
                      leftIcon={<CopyIcon />}
                      variant="primary"
                      onClick={copyCreatedRecovery}
                    >
                      {copiedCreatedRecovery
                        ? t`Recovery info copied`
                        : t`Copy recovery info for recipient`}
                    </Button>
                  )}
                </Box>
                <CloseButton onClick={() => setLastCreated(null)} size="sm" />
              </Alert>
            )}

            {/* Controls: filters (when populated) + Scan + Recover + Export */}
            <HStack mb={2} gap={3} justify="space-between" wrap="wrap">
              <HStack gap={3}>
                {vaults && vaults.length > 0 && (
                  <>
                    <FormControl
                      display="flex"
                      alignItems="center"
                      gap={2}
                      w="auto"
                    >
                      <Switch
                        size="sm"
                        isChecked={showClaimed}
                        onChange={(e) => setShowClaimed(e.target.checked)}
                      />
                      <FormLabel mb={0} fontSize="xs">
                        {t`Show Claimed`}
                      </FormLabel>
                    </FormControl>
                    <Text fontSize="xs" color="whiteAlpha.500">
                      {vaults.filter((v) => !v.claimed).length} {t`active`}
                      {showClaimed &&
                        ` / ${
                          vaults.filter((v) => v.claimed).length
                        } ${t`claimed`}`}
                    </Text>
                  </>
                )}
              </HStack>
              <HStack gap={1}>
                <Button
                  size="xs"
                  variant="ghost"
                  leftIcon={<Icon as={TbWand} />}
                  onClick={handleScan}
                  isLoading={scanning}
                  loadingText={t`Scanning...`}
                >
                  {t`Scan for Vaults`}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  leftIcon={<Icon as={TbKey} />}
                  onClick={() => setShowRecover((s) => !s)}
                >
                  {t`Recover by TXID`}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  leftIcon={<Icon as={TbUpload} />}
                  onClick={() => setShowImport((s) => !s)}
                >
                  {t`Import recovery info`}
                </Button>
                {vaults && vaults.length > 0 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    leftIcon={<Icon as={TbDownload} />}
                    onClick={handleExport}
                  >
                    {t`Export`}
                  </Button>
                )}
              </HStack>
            </HStack>
            {lastScan && (
              <Text
                fontSize="xs"
                color={
                  lastScan.complete === false ? "orange.300" : "whiteAlpha.500"
                }
                textAlign="right"
                mb={2}
              >
                {t`Last scan`}: {formatScanTime(lastScan.timestamp ?? 0)}
                {lastScan.complete === false ? (
                  <Text as="span" color="orange.300" ml={1}>
                    — {t`incomplete (${lastScan.skipped ?? 0} not scanned)`}
                  </Text>
                ) : (
                  (lastScan.discovered ?? 0) > 0 && (
                    <Text as="span" color="green.400" ml={1}>
                      ({lastScan.discovered} {t`found`})
                    </Text>
                  )
                )}
              </Text>
            )}

            {/* Recover by TXID — always available, not just empty-state */}
            <Collapse in={showRecover} animateOpacity>
              <Box
                mb={4}
                p={3}
                borderWidth="1px"
                borderColor="border.default"
                borderRadius="md"
              >
                <Text fontSize="xs" color="whiteAlpha.600" mb={2}>
                  {t`Paste a vault's creation transaction ID to recover it. Use this to restore a vault that didn't appear after a rebuild, or one someone sent you.`}
                </Text>
                <HStack>
                  <Input
                    size="sm"
                    placeholder={t`Paste transaction ID (txid)`}
                    value={checkTxId}
                    onChange={(e) => setCheckTxId(e.target.value)}
                    fontFamily="mono"
                  />
                  <Button
                    size="sm"
                    onClick={handleCheckTx}
                    isLoading={checkingTx}
                    loadingText={t`Checking...`}
                  >
                    {t`Recover`}
                  </Button>
                </HStack>
              </Box>
            </Collapse>

            {/* Import recovery info shared by a sender (gift / inheritance) */}
            <Collapse in={showImport} animateOpacity>
              <Box
                mb={4}
                p={3}
                borderWidth="1px"
                borderColor="border.default"
                borderRadius="md"
              >
                <Text fontSize="xs" color="whiteAlpha.600" mb={2}>
                  {t`Someone locked a vault to your address and shared its recovery info? Paste it here. It's verified against the blockchain — only vaults actually locked to your wallet are imported.`}
                </Text>
                <Textarea
                  size="sm"
                  rows={4}
                  placeholder={t`Paste recovery info (JSON)`}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  fontFamily="mono"
                  fontSize="xs"
                  mb={2}
                />
                <Button
                  size="sm"
                  onClick={handleImportRecovery}
                  isLoading={importing}
                  loadingText={t`Importing...`}
                >
                  {t`Import`}
                </Button>
              </Box>
            </Collapse>

            {!vaults || vaults.length === 0 ? (
              <NoContent
                icon={TbLock}
                subtitle={t`Already have vaults? Use "Scan for Vaults" to find timelocked coins in your history, or "Recover by TXID" to restore a specific one.`}
              >
                {t`No vaults yet. Create one to get started.`}
              </NoContent>
            ) : vaults.filter((v) => showClaimed || !v.claimed).length === 0 ? (
              <Text color="whiteAlpha.500" py={8} textAlign="center">
                {t`All vaults claimed. Toggle "Show Claimed" to view history.`}
              </Text>
            ) : (
              <Table size="sm" variant="simple">
                <Thead bg="surface.sunken">
                  <Tr>
                    {(
                      [
                        ["status", t`Status`],
                        ["type", t`Type`],
                        ["value", t`Value`],
                        ["locktime", t`Unlock At`],
                        ["remaining", t`Remaining`],
                        ["label", t`Label`],
                      ] as [SortCol, string][]
                    ).map(([col, label]) => (
                      <Th
                        key={col}
                        textStyle="label"
                        cursor="pointer"
                        userSelect="none"
                        onClick={() => handleSort(col)}
                        _hover={{ color: "whiteAlpha.800" }}
                        whiteSpace="nowrap"
                      >
                        {label}
                        {sortCol === col ? (sortAsc ? " ↑" : " ↓") : ""}
                      </Th>
                    ))}
                    <Th />
                  </Tr>
                </Thead>
                <Tbody fontFamily="mono">
                  {vaults
                    .filter((v) => showClaimed || !v.claimed)
                    .map((v) => {
                      // `claimable` reflects relay-readiness (includes MTP buffer for
                      // time-mode), so the Claim button only enables when broadcast
                      // is actually likely to succeed.
                      const claimable = isVaultClaimable(
                        v.locktime,
                        v.mode,
                        currentHeight,
                        currentTimestamp
                      );
                      const remaining = vaultClaimableIn(
                        v.locktime,
                        v.mode,
                        currentHeight,
                        currentTimestamp
                      );
                      // The wallet is a fixed two-address model (main + swap);
                      // a vault addressed to EITHER is claimable by this wallet.
                      const isRecipient =
                        v.recipientAddress === wallet.value.address ||
                        v.recipientAddress === wallet.value.swapAddress;

                      return (
                        <Tr
                          key={`${v.txid}-${v.vout}`}
                          opacity={v.claimed ? 0.4 : 1}
                          onClick={() => handleVaultClick(v)}
                          cursor="pointer"
                          borderTopWidth="1px"
                          borderColor="border.subtle"
                          _hover={{ bg: "bg.50" }}
                        >
                          <Td>
                            {v.claimed ? (
                              <Tag size="sm" colorScheme="gray">
                                {t`Claimed`}
                              </Tag>
                            ) : claimable ? (
                              <Tag size="sm" colorScheme="green">
                                <Icon as={TbLockOpen} mr={1} />
                                {t`Unlockable`}
                              </Tag>
                            ) : (
                              <Tag size="sm" colorScheme="orange">
                                <Icon as={TbLock} mr={1} />
                                {t`Locked`}
                              </Tag>
                            )}
                          </Td>
                          <Td textTransform="uppercase">{v.assetType}</Td>
                          <Td sx={{ fontVariantNumeric: "tabular-nums" }}>
                            <Photons value={v.value} />
                          </Td>
                          <Td sx={{ fontVariantNumeric: "tabular-nums" }}>
                            {formatLocktime(v.locktime, v.mode)}
                          </Td>
                          <Td sx={{ fontVariantNumeric: "tabular-nums" }}>
                            {v.claimed ? (
                              "—"
                            ) : remaining.value === 0 ? (
                              t`Now`
                            ) : remaining.unit === "blocks" ? (
                              <Tooltip
                                label={t`${remaining.value.toLocaleString()} blocks`}
                                placement="top"
                              >
                                <Text as="span" cursor="default">
                                  {blocksToDuration(remaining.value)}
                                </Text>
                              </Tooltip>
                            ) : (
                              secsToDuration(remaining.value)
                            )}
                          </Td>
                          <Td>
                            <VStack align="start" spacing={0}>
                              <Link
                                href={createExplorerUrl(v.txid)}
                                isExternal
                                fontSize="xs"
                                fontFamily="mono"
                                color="whiteAlpha.400"
                                _hover={{ color: "whiteAlpha.700" }}
                                title={v.txid}
                              >
                                {v.txid.slice(0, 8)}...{v.txid.slice(-8)}
                              </Link>
                              {v.label && (
                                <Text
                                  fontSize="xs"
                                  noOfLines={1}
                                  maxW="120px"
                                  color="whiteAlpha.500"
                                >
                                  {v.label}
                                </Text>
                              )}
                              {v.claimed && v.claimTxid && (
                                <Link
                                  href={createExplorerUrl(v.claimTxid)}
                                  isExternal
                                  fontSize="xs"
                                  fontFamily="mono"
                                  color="green.400"
                                  _hover={{ color: "green.300" }}
                                  title={`Claimed: ${v.claimTxid}`}
                                >
                                  {t`Claimed`}: {v.claimTxid.slice(0, 6)}...
                                  {v.claimTxid.slice(-6)}
                                </Link>
                              )}
                            </VStack>
                          </Td>
                          <Td>
                            <HStack gap={2}>
                              <Tooltip
                                label={t`View on explorer`}
                                placement="top"
                              >
                                <Link
                                  href={createExplorerUrl(v.txid)}
                                  isExternal
                                  fontSize="xs"
                                  color="whiteAlpha.400"
                                  _hover={{ color: "whiteAlpha.700" }}
                                >
                                  <ExternalLinkIcon />
                                </Link>
                              </Tooltip>
                              {!v.claimed &&
                                claimable &&
                                (isRecipient ? (
                                  <Button
                                    size="xs"
                                    variant="primary"
                                    onClick={() => handleClaim(v)}
                                  >
                                    {t`Claim`}
                                  </Button>
                                ) : (
                                  <Tooltip
                                    label={t`You created this vault for another address. Only the recipient's wallet can claim it once it unlocks.`}
                                    placement="top"
                                  >
                                    <Button
                                      size="xs"
                                      variant="outline"
                                      isDisabled
                                    >
                                      {t`Claim`}
                                    </Button>
                                  </Tooltip>
                                ))}
                              {!v.claimed &&
                                !claimable &&
                                currentHeight > 0 && (
                                  <Tooltip
                                    label={
                                      v.mode === "block"
                                        ? t`Unlocks at block ${v.locktime.toLocaleString()} — ${blocksToDuration(
                                            v.locktime - currentHeight
                                          )} remaining`
                                        : t`Unlocks ${new Date(
                                            v.locktime * 1000
                                          ).toLocaleString()} (claimable ~1h later — network propagation)`
                                    }
                                    placement="top"
                                  >
                                    <Box cursor="default">
                                      <Icon
                                        as={TbLock}
                                        color="whiteAlpha.300"
                                        boxSize={3.5}
                                      />
                                    </Box>
                                  </Tooltip>
                                )}
                            </HStack>
                          </Td>
                        </Tr>
                      );
                    })}
                </Tbody>
              </Table>
            )}
          </Box>
        )}
      </Container>

      {/* Vault Detail Modal */}
      <VaultDetailModal
        isOpen={isDetailModalOpen}
        onClose={handleCloseDetailModal}
        vault={selectedVault}
        currentHeight={currentHeight}
        currentTimestamp={currentTimestamp}
      />
    </ContentContainer>
  );
}
