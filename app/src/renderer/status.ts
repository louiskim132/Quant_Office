import {
  Bell,
  CheckCircle2,
  CircleDashed,
  Coffee,
  HelpCircle,
  Loader,
  MessagesSquare,
  PauseCircle,
  XCircle,
} from 'lucide-react';
import type React from 'react';
import type { OfficeActivity } from '../shared/activity';

/**
 * One status vocabulary for the whole app (Office, Agents, queue, chat, nav): the same word, icon and
 * colour token everywhere, and never colour alone. `needs` is the one status the office does not
 * derive per agent; it comes from requests that wait on the user.
 */
export type StatusKey = 'working' | 'stalled' | 'needs' | 'failed' | 'done' | 'unknown' | 'idle' | 'meeting';
export interface StatusInfo {
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  /** Sort weight: lower is more urgent, so a list of agents reads attention-first. */
  rank: number;
}
export const STATUS: Record<StatusKey, StatusInfo> = {
  needs: { label: 'Needs you', icon: Bell, rank: 0 },
  failed: { label: 'Failed', icon: XCircle, rank: 1 },
  stalled: { label: 'Stalled', icon: PauseCircle, rank: 2 },
  working: { label: 'Working', icon: Loader, rank: 3 },
  meeting: { label: 'In a meeting', icon: MessagesSquare, rank: 4 },
  unknown: { label: 'Unknown', icon: HelpCircle, rank: 5 },
  done: { label: 'Done', icon: CheckCircle2, rank: 6 },
  idle: { label: 'Idle', icon: Coffee, rank: 7 },
};
export const statusIconFallback = CircleDashed;

/** The status one agent's seat shows, from the derived office activity alone. */
export function activityStatus(activity?: OfficeActivity): StatusKey {
  if (!activity) return 'unknown';
  if (activity.kind === 'WORKING') return activity.stalled ? 'stalled' : 'working';
  if (activity.kind === 'MEETING') return 'meeting';
  if (activity.kind === 'UNKNOWN') return 'unknown';
  if (activity.recent) return activity.recent.outcome === 'FAILED' ? 'failed' : 'done';
  return 'idle';
}

/** "3m 12s" style duration for a live elapsed clock. Never negative, never fractional. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(s / 3600);
  return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** "just now", "4 min ago", "3 h ago", "2 d ago" — coarse on purpose, for lists. */
export function timeAgo(from: string | number, now = Date.now()): string {
  const then = typeof from === 'number' ? from : Date.parse(from);
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
