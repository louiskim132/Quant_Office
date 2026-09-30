import React, { useEffect, useRef, useState } from 'react';
import { Bell, Check, X } from 'lucide-react';
import type { Agent } from '../shared/types';
import type { OfficeActivity } from '../shared/activity';
import type { AttentionItem } from '../shared/attention';
import { Avatar, StatusPill } from './components';
import { activityStatus, STATUS } from './status';
import './shell.css';

/** The bell: one place that lists everything waiting on the user, each item a deep link. */
export function AttentionBell({ items, onPick }: { items: AttentionItem[]; onPick: (item: AttentionItem) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="bell" ref={box}>
      <button
        className="bell-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={items.length ? `${items.length} items need you` : 'Nothing needs you'}
        onClick={() => setOpen(v => !v)}
      >
        <Bell size={16} />
        {items.length > 0 && <b>{items.length}</b>}
      </button>
      {open && (
        <div className="bell-pop" role="region" aria-label="Needs you">
          <h3>Needs you</h3>
          {items.length ? (
            <ul>
              {items.map(item => (
                <li key={item.id}>
                  <button
                    onClick={() => {
                      setOpen(false);
                      onPick(item);
                    }}
                  >
                    <StatusPill status={item.status} label={item.kind === 'request' ? 'Request' : 'Agent'} />
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
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
