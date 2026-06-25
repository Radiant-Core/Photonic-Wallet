/**
 * Shared notification "seen" state.
 *
 * The notification bell (`components/NotificationBell.tsx`) and the toast
 * surface (`components/ActivityNotifications.tsx`) both read `db.broadcast`,
 * but only the bell owns the unread marker: `lastSeen` is the timestamp the
 * user last opened the notification center, NOT auto-advanced on arrival, so an
 * unread count actually accrues. Stored in localStorage (cleared on logout via
 * pages/LogOut.tsx) and mirrored in a signal so every reader stays in sync
 * within a session.
 */
import { signal } from "@preact/signals-react";

const STORAGE_KEY = "activity-last-seen";

function readStored(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(raw) ? raw : 0;
}

/** Timestamp (ms) of the most recent activity the user has acknowledged. */
export const lastSeen = signal<number>(readStored());

/** Mark all current activity as read, up to now. */
export function markAllSeen(): void {
  const now = Date.now();
  lastSeen.value = now;
  localStorage.setItem(STORAGE_KEY, String(now));
}
