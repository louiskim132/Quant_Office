import { useEffect, useRef, useState } from 'react';
import { Bell, Check, EyeOff, X } from 'lucide-react';
import type { Agent, ProviderJob } from '../shared/types';
import type { OfficeActivity } from '../shared/activity';
import type { AttentionItem } from '../shared/attention';
import { Avatar, StatusPill } from './components';
import { activityStatus, STATUS } from './status';
import './shell.css';

/**
 * Needs-you items split by kind: requests that need an action first, then agents gone quiet.
 * Exported pure so the grouping stays testable.
 */
export function attentionGroups(items: AttentionItem[]): { label: string; items: AttentionItem[] }[] {
  return [
    { label: 'Requests needing action', items: items.filter(i => i.kind === 'request') },
    { label: 'Agents gone quiet', items: items.filter(i => i.kind !== 'request') },
  ].filter(group => group.items.length > 0);
}

/** The recorded terminal job states — the same vocabulary the request lifecycle grid treats as an
 *  outcome on record. UNKNOWN is deliberately not terminal: it is an unreconciled record, and
 *  counting it as done would claim an outcome the office does not have. */
const TERMINAL_JOB = new Set<ProviderJob['state']>(['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED']);

/**
 * The taskbar-bar ratio: recorded terminal jobs ÷ recorded jobs, and nothing more. Returns null
 * when no jobs are on record — a project with no recorded work has no progress to claim. The bar
 * also clears (ratio outside 0..1) when every recorded job is already terminal.
 */
export function recordedProgress(jobs: ReadonlyArray<Pick<ProviderJob, 'state'>> | undefined): number | null {
  if (!jobs?.length) return null;
  return jobs.filter(job => TERMINAL_JOB.has(job.state)).length / jobs.length;
}

/** localStorage key for needs-you dismissal. Local-only: nothing here reaches the office record. */
export const NEEDS_YOU_DISMISSED_KEY = 'qro.needsyou-dismissed';

/** What 'the same state' means for a dismissed item: the kind and status recorded at dismiss time. */
export interface DismissalRecord {
  kind: AttentionItem['kind'];
  status: AttentionItem['status'];
  dismissedAt: string;
}
export type DismissalMap = Record<string, DismissalRecord>;

/** The fingerprint stored at dismiss time; a live item with a different one has changed state. */
export function dismissalFingerprint(
  item: Pick<AttentionItem, 'kind' | 'status'>,
): Pick<DismissalRecord, 'kind' | 'status'> {
  return { kind: item.kind, status: item.status };
}

/** Parses the stored map and drops anything malformed — a corrupt record dismisses nothing. */
export function parseDismissed(raw: string | null): DismissalMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const map: DismissalMap = {};
    for (const [id, record] of Object.entries(parsed as Record<string, unknown>)) {
      const r = record as Partial<DismissalRecord>;
      if ((r?.kind === 'request' || r?.kind === 'agent') && (r?.status === 'needs' || r?.status === 'stalled'))
        map[id] = {
          kind: r.kind,
          status: r.status,
          dismissedAt: typeof r.dismissedAt === 'string' ? r.dismissedAt : '',
        };
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Splits live items into visible and dismissed. An item stays dismissed only while its live
 * kind/status still equals the fingerprint taken at dismiss time — a recorded-state change puts it
 * back in the visible list. An absent item is simply not in either list; its stale record drops on
 * the next write, so a reappearing item is never hidden by an old dismissal.
 */
export function splitAttention(
  items: AttentionItem[],
  records: DismissalMap,
): { visible: AttentionItem[]; dismissed: AttentionItem[] } {
  const visible: AttentionItem[] = [];
  const dismissed: AttentionItem[] = [];
  for (const item of items) {
    const record = records[item.id];
    (record && record.kind === item.kind && record.status === item.status ? dismissed : visible).push(item);
  }
  return { visible, dismissed };
}

/**
 * The bell: one place that lists everything waiting on the user, each item a deep link. Open state
 * is owned by the caller so the status bar and the palette can summon the same panel.
 */
export function AttentionBell({
  items,
  onPick,
  open,
  onOpenChange,
}: {
  items: AttentionItem[];
  onPick: (item: AttentionItem) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  /** Dismissal is a localStorage-only affordance; where storage is unavailable the control hides. */
  const [dismissalOn] = useState(() => {
    try {
      const probe = `${NEEDS_YOU_DISMISSED_KEY}.probe`;
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  });
  const [dismissed, setDismissed] = useState<DismissalMap>(() => {
    try {
      return parseDismissed(localStorage.getItem(NEEDS_YOU_DISMISSED_KEY));
    } catch {
      return {};
    }
  });
  const [showDismissed, setShowDismissed] = useState(false);
  /** Writes the map, keeping only records for live items whose fingerprint still matches. */
  const persistDismissed = (next: DismissalMap) => {
    setDismissed(next);
    try {
      localStorage.setItem(NEEDS_YOU_DISMISSED_KEY, JSON.stringify(next));
    } catch {}
  };
  const dismiss = (item: AttentionItem) => {
    const byId = new Map(items.map(i => [i.id, i]));
    const next: DismissalMap = {};
    for (const [id, record] of Object.entries(dismissed)) {
      const live = byId.get(id);
      if (live && record.kind === live.kind && record.status === live.status) next[id] = record;
    }
    next[item.id] = { ...dismissalFingerprint(item), dismissedAt: new Date().toISOString() };
    persistDismissed(next);
  };
  const split = splitAttention(items, dismissalOn ? dismissed : {});
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key);
    };
  }, [open, onOpenChange]);
  return (
    <div className="bell" ref={box}>
      <button
        className="bell-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={items.length ? `${items.length} items need you` : 'Nothing needs you'}
        onClick={() => onOpenChange(!open)}
      >
        <Bell size={16} />
        {items.length > 0 && <b>{items.length}</b>}
      </button>
      {open && (
        <div className="bell-pop" role="region" aria-label="Needs you">
          <h3>Needs you</h3>
          {items.length ? (
            <>
              {attentionGroups(split.visible).map(group => (
                <div className="bell-group" key={group.label}>
                  <div className="bell-group-label">{group.label}</div>
                  <ul>
                    {group.items.map(item => (
                      <li key={item.id}>
                        <button
                          onClick={() => {
                            onOpenChange(false);
                            onPick(item);
                          }}
                        >
                          <span className="bell-item-head">
                            <StatusPill status={item.status} label={item.kind === 'request' ? 'Request' : 'Agent'} />
                            <strong>{item.title}</strong>
                            <em className="bell-open">Open</em>
                          </span>
                          <span>{item.detail}</span>
                        </button>
                        {dismissalOn && (
                          <button
                            className="bell-dismiss"
                            aria-label={`Dismiss here: ${item.title}`}
                            title="Dismiss in this panel only — it comes back if its recorded state changes"
                            onClick={() => dismiss(item)}
                          >
                            <EyeOff size={14} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {split.dismissed.length > 0 && (
                <div className="bell-dismissed">
                  <span className="bell-dismissed-label">Dismissed here</span>
                  <button className="text-button" onClick={() => setShowDismissed(shown => !shown)}>
                    {split.dismissed.length} dismissed — {showDismissed ? 'hide' : 'show'}
                  </button>
                </div>
              )}
              {showDismissed &&
                split.dismissed.length > 0 &&
                attentionGroups(split.dismissed).map(group => (
                  <div className="bell-group bell-group-dismissed" key={group.label}>
                    <div className="bell-group-label">{group.label} — dismissed on this device only</div>
                    <ul>
                      {group.items.map(item => (
                        <li key={item.id}>
                          <button
                            onClick={() => {
                              onOpenChange(false);
                              onPick(item);
                            }}
                          >
                            <span className="bell-item-head">
                              <StatusPill status={item.status} label={item.kind === 'request' ? 'Request' : 'Agent'} />
                              <strong>{item.title}</strong>
                              <em className="bell-open">Open</em>
                            </span>
                            <span>{item.detail}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </>
          ) : (
            <p className="muted">Nothing is waiting on you.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Every agent as a small avatar with a status ring, on every page. Click opens the agent drawer. */
export function AgentStrip({
  agents,
  activity,
  onPick,
}: {
  agents: Agent[];
  activity: OfficeActivity[];
  onPick: (id: string) => void;
}) {
  const team = agents.filter(a => !a.removedAt);
  if (!team.length) return null;
  const shown = team.slice(0, 12);
  return (
    <div className="agent-strip" role="group" aria-label="Agents">
      {shown.map(a => {
        const status = activityStatus(activity.find(x => x.agentId === a.id));
        return (
          <button
            key={a.id}
            onClick={() => onPick(a.id)}
            aria-label={`${a.name}: ${STATUS[status].label}`}
            title={`${a.name} · ${STATUS[status].label}`}
          >
            <Avatar id={a.id} name={a.name} size={24} status={status} />
          </button>
        );
      })}
      {team.length > shown.length && <span className="muted">+{team.length - shown.length}</span>}
    </div>
  );
}

/** Command results stack bottom-right instead of pushing the page down. */
export function ToastStack({
  error,
  notice,
  onDismissError,
  onDismissNotice,
}: {
  error: string;
  notice: string;
  onDismissError: () => void;
  onDismissNotice: () => void;
}) {
  // A notice fades on its own; an error stays until it is read and dismissed.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(onDismissNotice, 9000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!error && !notice) return null;
  return (
    <div className="toast-stack">
      {error && (
        <div className="toast error" role="alert">
          <X size={16} />
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={onDismissError}>
            <X size={14} />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast success" role="status">
          <Check size={16} />
          <span>{notice}</span>
          <button aria-label="Dismiss notice" onClick={onDismissNotice}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
