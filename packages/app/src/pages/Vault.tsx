import { useState, useEffect, useCallback, useMemo } from "react";
import { t } from "@lingui/macro";
import {
  Box,
  Button,
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
  Th,
  Thead,
  Tooltip,
  Tr,
  useToast,
  VStack,
} from "@chakra-ui/react";
import { TbLock, TbLockOpen, TbPlus, TbTrash, TbWand } from "react-icons/tb";
import { ExternalLinkIcon } from "@chakra-ui/icons";
import PageHeader from "@app/components/PageHeader";
import ContentContainer from "@app/components/ContentContainer";
import Photons from "@app/components/Photons";
import { wallet, feeRate, openModal } from "@app/signals";
import createExplorerUrl from "@app/network/createExplorerUrl";
import { electrumWorker } from "@app/electrum/Electrum";
import db from "@app/db";
import { ContractType, VaultRecord } from "@app/types";
import { useLiveQuery } from "dexie-react-hooks";
import {
  buildVaultTx,
  buildVestingTx,
  p2shOutputScript,
  isVaultUnlockable,
  formatLocktime,
  vaultTimeRemaining,
  claimVaultTx,
  recoverVaultsFromTx,
  VAULT_MAX_LOCKTIME_BLOCKS,
  VAULT_MAX_TRANCHES,
  type VaultParams,
  type VaultAssetType,
  type VaultMode,
  type VestingTranche,
} from "@lib/vault";

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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

// ── Types ──────────────────────────────────────────────────

type Tranche = {
  locktime: string;
  value: string;
  pct: string;
};

type VestingInputMode = "manual" | "percentage";

type PresetId = "linear-6" | "linear-12" | "cliff-linear" | "back-loaded" | "custom";

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
      for (let i = 0; i < monthlyCount; i++) pcts.push(remaining / monthlyCount);
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
  const [vesting, setVesting] = useState(false);
  const [tranches, setTranches] = useState<Tranche[]>([
    { locktime: "", value: "", pct: "" },
  ]);
  const [loading, setLoading] = useState(false);

  // Vesting-specific state
  const [vestingInputMode, setVestingInputMode] = useState<VestingInputMode>("manual");

  // Default recipient to self when create tab is opened
  useEffect(() => {
    if (tab === "create" && wallet.value.address && !recipient) {
      setRecipient(wallet.value.address);
    }
  }, [tab, wallet.value.address, recipient]);
  const [totalVestingAmount, setTotalVestingAmount] = useState("");

  // Interval auto-fill state
  const [intervalStart, setIntervalStart] = useState("");
  const [intervalStep, setIntervalStep] = useState("");
  const [intervalStartDate, setIntervalStartDate] = useState("");

  // Preset state
  const [selectedPreset, setSelectedPreset] = useState<PresetId>("custom");

  // List filter state
  const [showClaimed, setShowClaimed] = useState(false);

  // Vault discovery state
  const [scanning, setScanning] = useState(false);

  // Manual transaction check state
  const [checkTxId, setCheckTxId] = useState("");
  const [checkingTx, setCheckingTx] = useState(false);

  // Sort state
  type SortCol = "status" | "type" | "value" | "locktime" | "remaining" | "label";
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
  // Vault list from DB (live query)
  // ────────────────────────────────────────────────────────
  const vaultsRaw = useLiveQuery(
    () => db.vault.orderBy("date").reverse().toArray().then(vaults => {
      console.log("[Vault List] Loaded from DB:", vaults?.length || 0, "vaults");
      if (vaults?.length) {
        console.log("[Vault List] First vault:", vaults[0].txid, vaults[0].recipientAddress);
      }
      return vaults;
    }),
    []
  );

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
            } catch { /* ignore */ }
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
          const rank = (v: typeof a) => (v.claimed ? 2 : isVaultUnlockable(v.locktime, v.mode, currentHeight, currentTimestamp) ? 0 : 1);
          return dir * (rank(a) - rank(b));
        }
        case "type":
          return dir * a.assetType.localeCompare(b.assetType);
        case "value":
          return dir * (a.value - b.value);
        case "locktime":
          return dir * (a.locktime - b.locktime);
        case "remaining": {
          const ra = vaultTimeRemaining(a.locktime, a.mode, currentHeight, currentTimestamp);
          const rb = vaultTimeRemaining(b.locktime, b.mode, currentHeight, currentTimestamp);
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
      if (diff <= 0) return t`⚠ Must be greater than current block (${currentHeight.toLocaleString()})`;
      return t`Current block: ${currentHeight.toLocaleString()} — locks for ${blocksToDuration(diff)}`;
    }
    const lt = parseInt(locktime, 10);
    if (!lt) return t`Current time: ${new Date().toLocaleString()}`;
    const diff = lt - currentTimestamp;
    if (diff <= 0) return t`⚠ Must be in the future`;
    return t`Current time: ${new Date().toLocaleString()} — locks for ${secsToDuration(diff)}`;
  }, [mode, locktime, currentHeight, currentTimestamp]);

  // ────────────────────────────────────────────────────────
  // Date picker <-> UNIX timestamp sync
  // ────────────────────────────────────────────────────────
  const handleLocktimeChange = useCallback((val: string) => {
    setLocktime(val);
    if (mode === "time") {
      const ts = parseInt(val, 10);
      setDatePickerValue(ts > 0 ? unixToDateInput(ts) : "");
    }
  }, [mode]);

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
      setTranches(prev => [...prev, { locktime: "", value: "", pct: "" }]);
    }
  }, [tranches.length]);

  const removeTranche = useCallback((index: number) => {
    if (tranches.length > 1) {
      setTranches(prev => prev.filter((_, i) => i !== index));
    }
  }, [tranches.length]);

  const updateTranche = useCallback((
    index: number,
    field: keyof Tranche,
    val: string
  ) => {
    setTranches(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: val };
      return updated;
    });
  }, []);

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
    setTranches(prev => {
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
  const resolvedTranches = useMemo((): { locktime: number; value: number }[] => {
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
      toast({ title: t`Error`, description: t`Fill in start and interval`, status: "error" });
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
      const wif = wallet.value.wif;
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

      if (!vesting) {
        // Simple vault
        const lt = parseInt(locktime, 10);
        const val = Math.round(parseFloat(amount) * 1e8);
        if (!lt || !val) {
          throw new Error("Fill in locktime and amount");
        }
        if (!recipient) {
          throw new Error(t`Recipient address is required. Click 'Self' to use your own address.`);
        }
        if (mode === "block" && currentHeight > 0 && lt <= currentHeight) {
          throw new Error(t`Block must be greater than current height (${currentHeight})`);
        }
        if (mode === "time" && lt <= currentTimestamp) {
          throw new Error(t`Timestamp must be in the future`);
        }

        const params: VaultParams = {
          mode,
          locktime: lt,
          assetType,
          recipientAddress: recipient,
          ref: assetType !== "rxd" ? ref : undefined,
          value: val,
          label: label || undefined,
        };

        const result = buildVaultTx(
          coinInputs,
          fromAddress,
          wif,
          params,
          feeRate.value
        );

        // Broadcast
        const txid = await electrumWorker.value.broadcast(result.rawTx);

        // Store vault record
        const record: VaultRecord = {
          txid,
          vout: 0,
          value: val,
          assetType,
          mode,
          locktime: lt,
          recipientAddress: recipient,
          senderAddress: fromAddress,
          ref: assetType !== "rxd" ? ref : undefined,
          label: label || undefined,
          redeemScriptHex: result.redeemScriptHex,
          p2shScriptHex: p2shOutputScript(result.redeemScriptHex),
          claimed: 0,
          date: Date.now(),
        };
        console.log("[Vault Create] Storing record:", record);
        await db.vault.put(record);
        await electrumWorker.value.addVault(record);
        const verifyRecord = await db.vault.where({ txid }).first();
        console.log("[Vault Create] Verified stored record:", verifyRecord);
        await db.broadcast.put({ txid, date: Date.now(), description: "vault_create" });

        toast({
          title: t`Vault Created`,
          description: txid,
          status: "success",
          duration: 8000,
          isClosable: true,
        });

        // Reset form and go to list
        setLocktime("");
        setDatePickerValue("");
        setAmount("");
        setLabel("");
        setRef("");
        setTab("list");
      } else {
        // Vesting schedule
        if (vestingInputMode === "percentage" && Math.abs(pctAllocated - 100) > 0.01) {
          throw new Error(t`Percentages must sum to 100% (currently ${pctAllocated.toFixed(2)}%)`);
        }

        for (let i = 0; i < resolvedTranches.length; i++) {
          const lt = resolvedTranches[i].locktime;
          if (!lt || lt <= 0) {
            throw new Error(t`Tranche ${i + 1}: ${mode === "block" ? t`Block number` : t`Timestamp`} is required`);
          }
          if (mode === "block" && currentHeight > 0 && lt <= currentHeight) {
            throw new Error(t`Tranche ${i + 1}: Block ${lt} must be greater than current height (${currentHeight})`);
          }
          if (mode === "time" && lt <= currentTimestamp) {
            throw new Error(t`Tranche ${i + 1}: Timestamp must be in the future`);
          }
        }

        const vestingTranches: VestingTranche[] = resolvedTranches.map((rt) => ({
          mode,
          locktime: rt.locktime,
          assetType,
          recipientAddress: recipient,
          ref: assetType !== "rxd" ? ref : undefined,
          value: rt.value,
          label: label || undefined,
        }));

        const result = buildVestingTx(
          coinInputs,
          fromAddress,
          wif,
          vestingTranches,
          feeRate.value
        );

        const txid = await electrumWorker.value.broadcast(result.rawTx);

        // Store vault records for each tranche
        for (let i = 0; i < vestingTranches.length; i++) {
          const record: VaultRecord = {
            txid,
            vout: i,
            value: vestingTranches[i].value,
            assetType,
            mode,
            locktime: vestingTranches[i].locktime,
            recipientAddress: recipient,
            senderAddress: fromAddress,
            ref: assetType !== "rxd" ? ref : undefined,
            label: label ? `${label} (${i + 1}/${vestingTranches.length})` : undefined,
            redeemScriptHex: result.redeemScripts[i],
            p2shScriptHex: p2shOutputScript(result.redeemScripts[i]),
            claimed: 0,
            date: Date.now(),
          };
          await db.vault.put(record);
          await electrumWorker.value.addVault(record);
        }
        await db.broadcast.put({ txid, date: Date.now(), description: "vault_vesting" });

        toast({
          title: t`Vesting Schedule Created`,
          description: t`${txid} — ${vestingTranches.length} tranches`,
          status: "success",
          duration: 8000,
          isClosable: true,
        });

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
      const wif = wallet.value.wif;
      const toAddress = wallet.value.address;

      const result = claimVaultTx(
        {
          txid: vault.txid,
          vout: vault.vout,
          value: vault.value,
          redeemScriptHex: vault.redeemScriptHex,
        },
        toAddress,
        wif,
        feeRate.value
      );

      const txid = await electrumWorker.value.broadcast(result.rawTx);
      await db.vault.where({ txid: vault.txid, vout: vault.vout }).modify({ claimed: 1 });
      await db.broadcast.put({ txid, date: Date.now(), description: "vault_claim" });

      toast({
        title: t`Vault Claimed`,
        description: txid,
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
      // Scan main address - also try swapWif for decryption if main fails
      const mainCount = await electrumWorker.value.discoverVaults(
        wallet.value.wif,
        wallet.value.address,
        wallet.value.swapWif // Try swap WIF if main fails to decrypt
      );

      // Scan swap address if different
      let swapCount = 0;
      if (wallet.value.swapWif && wallet.value.swapAddress) {
        swapCount = await electrumWorker.value.discoverVaults(
          wallet.value.swapWif,
          wallet.value.swapAddress,
          wallet.value.wif // Try main WIF if swap fails to decrypt
        );
      }

      const totalCount = mainCount + swapCount;
      if (totalCount > 0) {
        toast({
          title: t`Vaults Discovered`,
          description: t`Found ${totalCount} vault(s) in transaction history`,
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
      toast({
        title: t`Scan Failed`,
        description: err instanceof Error ? err.message : String(err),
        status: "error",
      });
    } finally {
      setScanning(false);
    }
  };

  // ────────────────────────────────────────────────────────
  // Check specific transaction for vault (debug helper)
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
      console.log(`[Vault Check] Trying with main address: ${wallet.value.address}`);
      let recovered = recoverVaultsFromTx(rawTx, txid, wallet.value.wif, wallet.value.address, true);

      // If no vaults found and we have a swap address, try that too
      if (recovered.length === 0 && wallet.value.swapAddress && wallet.value.swapWif) {
        console.log(`[Vault Check] Trying with swap address: ${wallet.value.swapAddress}`);
        recovered = recoverVaultsFromTx(rawTx, txid, wallet.value.swapWif, wallet.value.swapAddress, true);
      }

      if (recovered.length > 0) {
        console.log(`[Vault Check] Found ${recovered.length} vault(s):`, recovered);
        toast({
          title: t`Vault Found!`,
          description: t`Found ${recovered.length} vault(s) in this transaction. Check console for details.`,
          status: "success",
          duration: 10000,
        });

        // Save to database
        for (const vaultData of recovered) {
          const record: VaultRecord = {
            txid,
            vout: vaultData.vout,
            value: vaultData.params.value,
            assetType: vaultData.params.assetType,
            mode: vaultData.params.mode,
            locktime: vaultData.params.locktime,
            recipientAddress: vaultData.params.recipientAddress,
            senderAddress: wallet.value.address,
            ref: vaultData.params.ref,
            label: vaultData.params.label,
            redeemScriptHex: vaultData.redeemScriptHex,
            p2shScriptHex: vaultData.p2shScriptHex,
            claimed: 0,
            date: Date.now(),
          };
          await db.vault.put(record);
        }
      } else {
        console.log(`[Vault Check] No vaults found in transaction ${txid}`);
        toast({
          title: t`No Vault Found`,
          description: t`This transaction does not contain a recoverable vault. Check console for debug info.`,
          status: "info",
          duration: 5000,
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
  }, [checkTxId, wallet.value.locked, wallet.value.wif, wallet.value.address, wallet.value.swapAddress, wallet.value.swapWif, toast]);

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
          variant={tab === "list" ? "primary" : "ghost"}
          onClick={() => setTab("list")}
        >
          {t`My Vaults`}
        </Button>
        <Button
          size="sm"
          variant={tab === "create" ? "primary" : "ghost"}
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
                onChange={(e) => setRecipient(e.target.value)}
                placeholder={t`Radiant address`}
                fontFamily="mono"
                size="sm"
              />
              <Button size="sm" onClick={fillSelf} variant="solid">
                {t`Self`}
              </Button>
            </HStack>
          </FormControl>

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
              <FormLabel>{t`Token Ref (LE hex)`}</FormLabel>
              <Input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder={t`72 character hex`}
                fontFamily="mono"
                size="sm"
              />
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
                    {mode === "block" ? t`Lock Until Block` : t`Lock Until (Unix)`}
                  </FormLabel>
                  <Input
                    size="sm"
                    value={locktime}
                    onChange={(e) => handleLocktimeChange(e.target.value)}
                    placeholder={
                      mode === "block"
                        ? (currentHeight ? t`e.g. ${currentHeight + 8640}` : t`Max ${VAULT_MAX_LOCKTIME_BLOCKS}`)
                        : t`Unix timestamp`
                    }
                    type="number"
                  />
                  <FormHelperText fontSize="xs" color={locktimeInvalid ? "red.300" : "whiteAlpha.500"}>
                    {locktimeHint}
                  </FormHelperText>
                </FormControl>
                <FormControl>
                  <FormLabel>{t`Amount (RXD)`}</FormLabel>
                  <Input
                    size="sm"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
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
                    variant={vestingInputMode === "manual" ? "solid" : "ghost"}
                    onClick={() => setVestingInputMode("manual")}
                  >
                    {t`Manual`}
                  </Button>
                  <Button
                    size="xs"
                    variant={vestingInputMode === "percentage" ? "solid" : "ghost"}
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
                borderColor="whiteAlpha.200"
                borderRadius="md"
              >
                <Text fontSize="xs" fontWeight="bold" mb={2}>{t`Preset Templates`}</Text>
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
                        <Text fontSize="xs" fontWeight="bold">{p.label}</Text>
                        <Text fontSize="2xs" opacity={0.7}>{p.description}</Text>
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
                borderColor="whiteAlpha.200"
                borderRadius="md"
              >
                <HStack mb={2}>
                  <Icon as={TbWand} />
                  <Text fontSize="xs" fontWeight="bold">{t`Auto-fill Schedule`}</Text>
                </HStack>
                <SimpleGrid columns={2} gap={2}>
                  {mode === "block" ? (
                    <Input
                      size="xs"
                      value={intervalStart}
                      onChange={(e) => setIntervalStart(e.target.value)}
                      placeholder={t`Start block` + (currentHeight ? ` (${t`now`}: ${currentHeight})` : "")}
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
                      mode === "block" ? t`Interval (blocks)` : t`Interval (seconds)`
                    }
                  />
                </SimpleGrid>
                {mode === "block" && intervalStep && (
                  <Text fontSize="xs" color="whiteAlpha.500" mt={1}>
                    {t`Interval`}: {blocksToDuration(parseInt(intervalStep, 10) || 0)}
                  </Text>
                )}
                {mode === "time" && intervalStep && (
                  <Text fontSize="xs" color="whiteAlpha.500" mt={1}>
                    {t`Interval`}: {secsToDuration(parseInt(intervalStep, 10) || 0)}
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

              <Divider borderColor="whiteAlpha.200" />

              {/* Tranche rows */}
              {tranches.map((tr, i) => {
                const lt = parseInt(tr.locktime, 10);
                const locktimeEmpty = !tr.locktime;
                const locktimePast = mode === "block"
                  ? (currentHeight > 0 && !!lt && lt <= currentHeight)
                  : (!!lt && lt <= currentTimestamp);
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
                      mode === "block" ? t`Block #${i + 1}` : t`Timestamp #${i + 1}`
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
                    <Text fontSize="xs" color="whiteAlpha.500" minW="60px" textAlign="right">
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
                        <Button size="xs" variant="ghost" onClick={autoFillLastPct}>
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
          {/* Filter controls */}
          {vaults && vaults.length > 0 && (
            <HStack mb={3} gap={3} justify="space-between">
              <HStack gap={3}>
                <FormControl display="flex" alignItems="center" gap={2} w="auto">
                  <Switch
                    size="sm"
                    isChecked={showClaimed}
                    onChange={(e) => setShowClaimed(e.target.checked)}
                  />
                  <FormLabel mb={0} fontSize="xs">{t`Show Claimed`}</FormLabel>
                </FormControl>
                <Text fontSize="xs" color="whiteAlpha.500">
                  {vaults.filter((v) => !v.claimed).length} {t`active`}
                  {showClaimed && ` / ${vaults.filter((v) => v.claimed).length} ${t`claimed`}`}
                </Text>
              </HStack>
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
            </HStack>
          )}

          {!vaults || vaults.length === 0 ? (
            <VStack gap={4} py={8} align="center">
              <Text color="whiteAlpha.500" textAlign="center">
                {t`No vaults yet. Create one to get started.`}
              </Text>
              <Text color="whiteAlpha.400" fontSize="sm" textAlign="center">
                {t`Or scan your transaction history for existing timelocked coins.`}
              </Text>
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Icon as={TbWand} />}
                onClick={handleScan}
                isLoading={scanning}
                loadingText={t`Scanning...`}
              >
                {t`Scan for Vaults`}
              </Button>

              <Divider my={4} />

              <Text color="whiteAlpha.400" fontSize="xs" textAlign="center">
                {t`Know a specific vault transaction? Paste the TXID below:`}
              </Text>
              <HStack w="100%" maxW="md">
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
                  {t`Check`}
                </Button>
              </HStack>
            </VStack>
          ) : vaults.filter((v) => showClaimed || !v.claimed).length === 0 ? (
            <Text color="whiteAlpha.500" py={8} textAlign="center">
              {t`All vaults claimed. Toggle "Show Claimed" to view history.`}
            </Text>
          ) : (
            <Table size="sm" variant="simple">
              <Thead>
                <Tr>
                  {([
                    ["status",    t`Status`],
                    ["type",      t`Type`],
                    ["value",     t`Value`],
                    ["locktime",  t`Unlock At`],
                    ["remaining", t`Remaining`],
                    ["label",     t`Label`],
                  ] as [SortCol, string][]).map(([col, label]) => (
                    <Th
                      key={col}
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
                {vaults.filter((v) => showClaimed || !v.claimed).map((v) => {
                  const unlockable = isVaultUnlockable(
                    v.locktime,
                    v.mode,
                    currentHeight,
                    currentTimestamp
                  );
                  const remaining = vaultTimeRemaining(
                    v.locktime,
                    v.mode,
                    currentHeight,
                    currentTimestamp
                  );
                  const isRecipient =
                    v.recipientAddress === wallet.value.address;

                  return (
                    <Tr
                      key={`${v.txid}-${v.vout}`}
                      opacity={v.claimed ? 0.4 : 1}
                    >
                      <Td>
                        {v.claimed ? (
                          <Tag size="sm" colorScheme="gray">
                            {t`Claimed`}
                          </Tag>
                        ) : unlockable ? (
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
                      <Td>
                        <Photons value={v.value} />
                      </Td>
                      <Td>{formatLocktime(v.locktime, v.mode)}</Td>
                      <Td>
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
                        <Text fontSize="xs" noOfLines={1} maxW="120px">
                          {v.label || "—"}
                        </Text>
                      </Td>
                      <Td>
                        <HStack gap={2}>
                          {!v.claimed && (
                            <Link
                              href={createExplorerUrl(v.txid)}
                              isExternal
                              fontSize="xs"
                              color="whiteAlpha.400"
                              _hover={{ color: "whiteAlpha.700" }}
                            >
                              <ExternalLinkIcon />
                            </Link>
                          )}
                          {!v.claimed && unlockable && (
                            isRecipient ? (
                              <Button
                                size="xs"
                                variant="primary"
                                onClick={() => handleClaim(v)}
                              >
                                {t`Claim`}
                              </Button>
                            ) : (
                              <Tooltip label={t`You are not the recipient`} placement="top">
                                <Button size="xs" variant="outline" isDisabled>
                                  {t`Claim`}
                                </Button>
                              </Tooltip>
                            )
                          )}
                          {!v.claimed && !unlockable && currentHeight > 0 && (
                            <Tooltip
                              label={v.mode === "block"
                                ? t`Unlocks at block ${v.locktime.toLocaleString()} — ${blocksToDuration(v.locktime - currentHeight)} remaining`
                                : t`Unlocks ${new Date(v.locktime * 1000).toLocaleString()}`
                              }
                              placement="top"
                            >
                              <Box cursor="default">
                                <Icon as={TbLock} color="whiteAlpha.300" boxSize={3.5} />
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
    </ContentContainer>
  );
}
