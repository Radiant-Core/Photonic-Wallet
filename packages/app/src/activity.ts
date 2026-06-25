/**
 * Shared activity model.
 *
 * Both the history page (`pages/Coins.tsx`) and the notification surfaces
 * (`components/ActivityNotifications.tsx`) classify the same `db.broadcast`
 * `description` strings, so the mapping lives here to keep labels, icons,
 * categories and colors consistent across the app.
 */
import { IconType } from "react-icons";
import {
  TbArrowUpRight,
  TbArrowDownLeft,
  TbStack2,
  TbLock,
  TbLockOpen,
  TbFlame,
  TbPencil,
  TbSparkles,
  TbShieldCheck,
  TbArrowsExchange,
} from "react-icons/tb";
import { RiSwap2Line } from "react-icons/ri";
import { HiOutlineAtSymbol } from "react-icons/hi";

// Broad buckets used by the history-page filter chips.
export type ActivityCategory =
  | "send"
  | "receive"
  | "swap"
  | "token"
  | "nft"
  | "name"
  | "vault"
  | "mint"
  | "other";

export type ActivityDirection = "in" | "out" | "neutral";

export interface ActivityMeta {
  /** Human-readable title, e.g. "Tokens Sent". */
  label: string;
  category: ActivityCategory;
  icon: IconType;
  /** Chakra color scheme used for the icon chip + badge. */
  color: string;
  direction: ActivityDirection;
}

// Exact description → metadata. Keep keys in sync with the `description`
// strings passed to `db.broadcast.put` across the app.
const EXACT: Record<string, ActivityMeta> = {
  rxd_send: { label: "Sent RXD", category: "send", icon: TbArrowUpRight, color: "red", direction: "out" },
  rxd_receive: { label: "Received RXD", category: "receive", icon: TbArrowDownLeft, color: "green", direction: "in" },
  batch_send: { label: "Batch Send", category: "send", icon: TbArrowUpRight, color: "red", direction: "out" },
  sweep: { label: "Wallet Swept", category: "send", icon: TbArrowUpRight, color: "red", direction: "out" },
  ft_send: { label: "Tokens Sent", category: "token", icon: TbArrowUpRight, color: "orange", direction: "out" },
  ft_receive: { label: "Tokens Received", category: "token", icon: TbArrowDownLeft, color: "green", direction: "in" },
  ft_mint: { label: "Tokens Minted", category: "mint", icon: TbSparkles, color: "teal", direction: "in" },
  ft_melt: { label: "Tokens Melted", category: "token", icon: TbFlame, color: "red", direction: "out" },
  nft_send: { label: "NFT Sent", category: "nft", icon: TbArrowUpRight, color: "purple", direction: "out" },
  nft_receive: { label: "NFT Received", category: "nft", icon: TbArrowDownLeft, color: "green", direction: "in" },
  nft_mint: { label: "NFT Minted", category: "mint", icon: TbSparkles, color: "teal", direction: "in" },
  nft_melt: { label: "NFT Melted", category: "nft", icon: TbFlame, color: "red", direction: "out" },
  nft_edit: { label: "NFT Edited", category: "nft", icon: TbPencil, color: "blue", direction: "neutral" },
  consolidate: { label: "Coins Consolidated", category: "other", icon: TbStack2, color: "gray", direction: "neutral" },
  ft_swap_prepare: { label: "Token Swap Prepared", category: "swap", icon: RiSwap2Line, color: "orange", direction: "neutral" },
  nft_swap_prepare: { label: "NFT Swap Prepared", category: "swap", icon: RiSwap2Line, color: "orange", direction: "neutral" },
  rxd_swap_prepare: { label: "Swap Prepared", category: "swap", icon: RiSwap2Line, color: "orange", direction: "neutral" },
  swap_advertisement: { label: "Swap Listed", category: "swap", icon: RiSwap2Line, color: "orange", direction: "neutral" },
  rxd_swap: { label: "Swap Completed", category: "swap", icon: TbArrowsExchange, color: "green", direction: "neutral" },
  rxd_swap_cancel: { label: "Swap Cancelled", category: "swap", icon: RiSwap2Line, color: "red", direction: "neutral" },
  swap_cancel: { label: "Swap Cancelled", category: "swap", icon: RiSwap2Line, color: "red", direction: "neutral" },
  vault_create: { label: "Vault Created", category: "vault", icon: TbLock, color: "purple", direction: "out" },
  vault_vesting: { label: "Vesting Created", category: "vault", icon: TbLock, color: "blue", direction: "out" },
  vault_claim: { label: "Vault Claimed", category: "vault", icon: TbLockOpen, color: "green", direction: "in" },
  authority_commit: { label: "Authority Committed", category: "other", icon: TbShieldCheck, color: "cyan", direction: "neutral" },
  authority_reveal: { label: "Authority Created", category: "other", icon: TbShieldCheck, color: "teal", direction: "neutral" },
  wave_name_commit: { label: "Name Registering", category: "name", icon: HiOutlineAtSymbol, color: "pink", direction: "neutral" },
  wave_name_reveal: { label: "Name Registered", category: "name", icon: HiOutlineAtSymbol, color: "pink", direction: "in" },
  wave_name_reclaim: { label: "Name Reclaimed", category: "name", icon: HiOutlineAtSymbol, color: "pink", direction: "neutral" },
  wave_name_burn: { label: "Name Burned", category: "name", icon: TbFlame, color: "red", direction: "out" },
  wave_name_transfer: { label: "Name Transferred", category: "name", icon: TbArrowUpRight, color: "pink", direction: "out" },
};

const FALLBACK: ActivityMeta = {
  label: "Transaction",
  category: "other",
  icon: TbArrowsExchange,
  color: "gray",
  direction: "neutral",
};

/**
 * Map a broadcast `description` to display metadata. Falls back to substring
 * matching for older / unrecognised descriptions, then to a generic entry, so
 * the UI never renders a raw snake_case string or breaks on a new type.
 */
export function classifyActivity(description?: string): ActivityMeta {
  if (!description) return FALLBACK;
  const key = description.trim();
  if (EXACT[key]) return EXACT[key];

  // Substring fallbacks (specific → generic).
  if (key.includes("swap")) {
    if (key.includes("cancel"))
      return EXACT.swap_cancel;
    return EXACT.rxd_swap_prepare;
  }
  if (key.includes("vault")) {
    if (key.includes("claim")) return EXACT.vault_claim;
    return EXACT.vault_create;
  }
  if (key.includes("wave_name") || key.includes("name"))
    return EXACT.wave_name_reveal;
  if (key.includes("authority")) return EXACT.authority_reveal;
  if (key.includes("mint")) return EXACT.ft_mint;
  if (key.includes("melt")) return EXACT.ft_melt;
  if (key.includes("nft")) return EXACT.nft_send;
  if (key.includes("ft")) return EXACT.ft_send;
  if (key.includes("receive")) return EXACT.rxd_receive;
  if (key.includes("send")) return EXACT.rxd_send;

  return FALLBACK;
}

// Categories offered as filter chips, in display order.
export const ACTIVITY_FILTERS: { key: ActivityCategory | "all"; label: string }[] =
  [
    { key: "all", label: "All" },
    { key: "send", label: "Sent" },
    { key: "receive", label: "Received" },
    { key: "swap", label: "Swaps" },
    { key: "token", label: "Tokens" },
    { key: "nft", label: "NFTs" },
    { key: "name", label: "Names" },
    { key: "vault", label: "Vault" },
  ];

/** Compact relative time, e.g. "just now", "5m", "3h", "2d", or a date. */
export function relativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(ts).toLocaleDateString();
}

/** Date-group bucket label for a timestamp ("Today", "Yesterday", or date). */
export function dateGroup(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  const dayMs = 86_400_000;
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - dayMs) return "Yesterday";
  if (ts >= startOfToday - 7 * dayMs)
    return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export function shortTxid(txid: string): string {
  if (!txid) return "";
  return `${txid.slice(0, 8)}…${txid.slice(-8)}`;
}
