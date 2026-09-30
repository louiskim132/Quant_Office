import { useCallback, useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import type { AgentLog, AppState, LineageEvent } from '../shared/types';
import { Empty } from './components';
import { formatDateTime, plural } from './format';
import './history.css';

type RecordView = 'all' | 'yours' | 'messages' | 'work' | 'between';
type Row = { id: string; time: string; sequence: number; event: LineageEvent | null; log: AgentLog | null };

/* ---------- saved views: pure helpers (covered by tests/history-views.test.ts) ---------- */

/** A named set of saved filter values. Renderer-local state only — never an office record. */
export type SavedViews<F> = { name: string; filters: F }[];
const MAX_SAVED_VIEWS = 24;
export const HISTORY_VIEWS_KEY = 'qro.history-views';
export const ACTIVITY_VIEWS_KEY = 'qro.activity-views';

/** Parse the stored blob. A corrupted payload yields an empty list; a corrupted entry is skipped, never fatal. */
export function parseSavedViews<F>(raw: string | null, sanitize: (value: unknown) => F | null): SavedViews<F> {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    const list = Array.isArray(data) ? data : (data as { views?: unknown })?.views;
    if (!Array.isArray(list)) return [];
    const views: SavedViews<F> = [];
    for (const item of list) {
      const name = typeof (item as { name?: unknown })?.name === 'string' ? (item as { name: string }).name.trim() : '';
      const filters = sanitize((item as { filters?: unknown })?.filters);
      if (name && filters && !views.some(v => v.name === name)) views.push({ name, filters });
    }
    return views;
  } catch {
    return [];
  }
}

export function serializeSavedViews<F>(views: SavedViews<F>): string {
  return JSON.stringify({ version: 1, views });
}

/** Insert or overwrite a named view; the list stays bounded, most-recently-saved last. */
export function upsertView<F>(views: SavedViews<F>, name: string, filters: F): SavedViews<F> {
  const label = name.trim();
  if (!label) return views;
  return [...views.filter(v => v.name !== label), { name: label, filters }].slice(-MAX_SAVED_VIEWS);
}

/** Rename a view; blank, unchanged or colliding names are a no-op. */
export function renameView<F>(views: SavedViews<F>, from: string, to: string): SavedViews<F> {
  const label = to.trim();
  if (!label || label === from || views.some(v => v.name === label)) return views;
  return views.map(v => (v.name === from ? { ...v, name: label } : v));
}

export function deleteView<F>(views: SavedViews<F>, name: string): SavedViews<F> {
  return views.filter(v => v.name !== name);
}

/** Shallow equality over plain filter records — a saved view is "active" only while the filters match it exactly. */
export function sameFilters(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a),
    kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => a[k] === b[k]);
}

export function currentViewName<F extends Record<string, unknown>>(views: SavedViews<F>, filters: F): string {
  return views.find(v => sameFilters(v.filters as Record<string, unknown>, filters))?.name ?? '';
}

export function loadViews<F>(key: string, sanitize: (value: unknown) => F | null): SavedViews<F> {
  try {
    return parseSavedViews(localStorage.getItem(key), sanitize);
  } catch {
    /* storage can be unavailable or corrupted — falling back to no saved views is honest */
    return [];
  }
}

export function storeViews<F>(key: string, views: SavedViews<F>): void {
  try {
    localStorage.setItem(key, serializeSavedViews(views));
  } catch {
    /* a failed write loses nothing recorded elsewhere */
  }
}

/** The filters History owns today: display mode, subject/peer agents, record view and search text. */
export type HistoryFilters = {
  technical: boolean;
  subject: string;
  peer: string;
  view: RecordView;
  search: string;
};
export const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  technical: false,
  subject: '',
  peer: '',
  view: 'all',
  search: '',
};
const RECORD_VIEWS: RecordView[] = ['all', 'yours', 'messages', 'work', 'between'];

/** Validate a stored filter set; missing or wrong-typed fields coerce to the page defaults. */
export function sanitizeHistoryFilters(raw: unknown): HistoryFilters | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    technical: f.technical === true,
    subject: text(f.subject),
    peer: text(f.peer),
    view: RECORD_VIEWS.includes(f.view as RecordView) ? (f.view as RecordView) : 'all',
    search: text(f.search),
  };
}

/**
 * History reads one page at a time from the indexed event log and merges it with the recorded
 * agent work log in one timeline. The workspace can hold far more events than the window ever
 * renders, so nothing here loads the whole event log to show the top of it.
 */
export function HistoryView({
  state,
  projectId,
  label,
}: {
  state: AppState;
  projectId: string | null;
  label: (value: string) => string;
  date: (value: string) => string;
}) {
  const [technical, setTechnical] = useState(false);
  const [subject, setSubject] = useState('');
  const [peer, setPeer] = useState('');
  const [view, setView] = useState<RecordView>('all');
  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState<LineageEvent[]>([]);
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const load = useCallback(
    async (next: number | null, reset: boolean) => {
      const ticket = ++request.current;
      setBusy(true);
      setError('');
      try {
        const page = await window.office.historyPage({ projectId, limit: 50, ...(next ? { cursor: next } : {}) });
        if (ticket !== request.current) return;
        setEntries(current => (reset ? page.entries : [...current, ...page.entries]));
        setCursor(page.nextCursor);
        setTotal(page.total);
      } catch (e) {
        if (ticket === request.current) setError((e as Error).message);
      } finally {
        if (ticket === request.current) setBusy(false);
      }
    },
    [projectId],
  );
  const refreshLogs = useCallback(async () => {
    try {
      setLogs(await window.office.getWorkLogs());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load(null, true);
  }, [load, subject, peer, view, search]);
  useEffect(() => {
    void refreshLogs();
  }, [refreshLogs]);
  useEffect(
    () =>
      window.office.onChanged(() => {
        void load(null, true);
        void refreshLogs();
      }),
    [load, refreshLogs],
  );
  const name = (id: string) =>
    state.agents.find(a => a.id === id)?.name ?? { USER: 'You', SYSTEM: 'Office', TOOL: 'Tool' }[id] ?? id;
  const isAgent = (id: string) => state.agents.some(a => a.id === id);
  const parties = [
    { id: 'USER', label: 'You' },
    { id: 'SYSTEM', label: 'Office' },
    { id: 'TOOL', label: 'Tool' },
    ...state.agents.map(a => ({ id: a.id, label: a.name })),
  ];
  const needle = search.toLowerCase();
  const clearFilters = () => {
    setSubject('');
    setPeer('');
    setView('all');
    setSearch('');
  };
  const [savedViews, setSavedViews] = useState(() => loadViews(HISTORY_VIEWS_KEY, sanitizeHistoryFilters));
  const [naming, setNaming] = useState<'' | 'save' | 'rename'>('');
  const [draft, setDraft] = useState('');
  useEffect(() => storeViews(HISTORY_VIEWS_KEY, savedViews), [savedViews]);
  const current: HistoryFilters = { technical, subject, peer, view, search };
  const activeView = currentViewName(savedViews, current);
  const applyView = (name: string) => {
    const saved = savedViews.find(v => v.name === name);
    if (!saved) return;
    const f = saved.filters;
    setTechnical(f.technical);
    setSubject(f.subject);
    setPeer(f.peer);
    setView(f.view);
    setSearch(f.search);
  };
  const commitName = () => {
    const label = draft.trim();
    if (!label) return;
    setSavedViews(
      naming === 'rename' ? renameView(savedViews, activeView, label) : upsertView(savedViews, label, current),
    );
    setNaming('');
    setDraft('');
  };
  const rows: Row[] = [
    ...entries.map(event => ({ id: event.id, time: event.createdAt, sequence: event.sequence, event, log: null })),
    ...logs
      .filter(log => subject !== '' || log.provenance !== 'OFFICE_EVENT')
      .map(log => ({ id: log.id, time: log.timestamp, sequence: -1, event: null, log })),
  ];
  const visible = rows
    .filter(row => {
      if (row.event) {
        if (subject && subject !== 'USER') return false;
        if (peer) return false;
        if (view === 'messages' || view === 'between') return false;
        return `${row.event.kind} ${row.event.reason}`.toLowerCase().includes(needle);
      }
      const log = row.log!;
      if (subject && log.from !== subject && log.to !== subject) return false;
      if (peer && log.from !== peer && log.to !== peer) return false;
      if (view === 'yours') return false;
      if (view === 'messages' && log.kind !== 'MESSAGE') return false;
      if (view === 'work' && log.kind === 'MESSAGE') return false;
      if (view === 'between' && !(isAgent(log.from) && isAgent(log.to))) return false;
      return `${log.text} ${name(log.from)} ${name(log.to)}`.toLowerCase().includes(needle);
    })
    .sort(
      (a, b) =>
        Date.parse(b.time) - Date.parse(a.time) || b.sequence - a.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const recorded = total + logs.length;
  const groups = new Map<string, Row[]>();
  for (const row of visible) {
    const day = formatDateTime(row.time).split(',').slice(0, 2).join(',');
    const scope = row.event?.experimentId ?? row.event?.projectId ?? row.log?.conversationId ?? 'office';
    const key = `${day}|${scope}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const title = (row: Row) => row.log?.text ?? row.event?.reason ?? '';
  const subjectTitle = (row: Row) => {
    const event = row.event;
    if (!event) return `${name(row.log!.from)} → ${name(row.log!.to)}`;
    return (
      state.experiments.find(e => e.id === event.experimentId)?.name ??
      state.projects.find(p => p.id === event.projectId)?.name ??
      'Office activity'
    );
  };
  return (
    <>
      <div className="section-toolbar">
        <span>
          {plural(recorded, 'event')} · showing {visible.length}
        </span>
      </div>
      <div className="button-row history-mode" role="group" aria-label="History display">
        <button className="secondary" aria-pressed={!technical} onClick={() => setTechnical(false)}>
          Activity
        </button>
        <button className="secondary" aria-pressed={technical} onClick={() => setTechnical(true)}>
          Technical events
        </button>
      </div>
      <p className="muted">
        {plural(entries.length, 'loaded event')} of {total}. Integrity hashes are available in Technical events; this
        view does not perform a new chain verification.
      </p>
      <div className="saved-views">
        <label className="field">
          Saved views
          <select aria-label="Saved view" value={activeView} onChange={e => applyView(e.target.value)}>
            <option value="">Unsaved filters</option>
            {savedViews.map(v => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        {naming ? (
          <>
            <label className="field">
              {naming === 'rename' ? 'Rename view' : 'Name this view'}
              <input
                aria-label="Saved view name"
                autoFocus
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitName();
                  if (e.key === 'Escape') {
                    setNaming('');
                    setDraft('');
                  }
                }}
              />
            </label>
            <button className="secondary" disabled={!draft.trim()} onClick={commitName}>
              {naming === 'rename' ? 'Rename' : 'Save'}
            </button>
            <button
              className="secondary"
              onClick={() => {
                setNaming('');
                setDraft('');
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              className="secondary"
              onClick={() => {
                setNaming('save');
                setDraft('');
              }}
            >
              Save view…
            </button>
            {activeView && (
              <>
                <button
                  className="secondary"
                  onClick={() => {
                    setNaming('rename');
                    setDraft(activeView);
                  }}
                >
                  Rename
                </button>
                <button className="secondary" onClick={() => setSavedViews(deleteView(savedViews, activeView))}>
                  Delete
                </button>
              </>
            )}
            <button className="secondary" onClick={clearFilters}>
              Clear filters
            </button>
          </>
        )}
      </div>
      <div className="history-filters">
        <label className="field">
          Subject
          <select
            aria-label="Subject"
            value={subject}
            onChange={e => {
              setSubject(e.target.value);
              setPeer('');
            }}
          >
            <option value="">All subjects</option>
            <option value="USER">You</option>
            <option value="SYSTEM">Office</option>
            <option value="TOOL">Tool</option>
            {state.agents.map(a => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.team}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Other participant
          <select aria-label="Other participant" value={peer} onChange={e => setPeer(e.target.value)}>
            <option value="">Anyone</option>
            {parties
              .filter(p => p.id !== subject)
              .map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          Record view
          <select aria-label="Record view" value={view} onChange={e => setView(e.target.value as RecordView)}>
            <option value="all">All records</option>
            <option value="yours">Your actions</option>
            <option value="messages">Conversation messages</option>
            <option value="work">Work &amp; office events</option>
            <option value="between">Between agents</option>
          </select>
        </label>
        <label className="field">
          Search
          <input aria-label="Search records" value={search} onChange={e => setSearch(e.target.value)} />
        </label>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {visible.length === 0 ? (
        entries.length + logs.length === 0 ? (
          <Empty
            icon={History}
            title="Nothing recorded in this scope yet"
            description="Office events and work-log records appear here as they are recorded."
          />
        ) : (
          <Empty
            icon={History}
            title="No loaded records match these filters"
            description="Widen the filters, or load older events — only the loaded records are searched."
            action={
              <button className="secondary" onClick={clearFilters}>
                Clear filters
              </button>
            }
            secondary={
              cursor !== null ? (
                <button className="secondary" disabled={busy} onClick={() => void load(cursor, false)}>
                  {busy ? 'Loading…' : 'Load older events'}
                </button>
              ) : undefined
            }
          />
        )
      ) : !technical ? (
        <div className="timeline history-activity">
          {[...groups.entries()].map(([key, rows]) => (
            <article key={key}>
              <div className="card-heading">
                <h3>{subjectTitle(rows[0])}</h3>
                <time>{formatDateTime(rows[0].time)}</time>
              </div>
              <p>{title(rows[0]).split('\n')[0]}</p>
              <details>
                <summary>
                  {rows.length} loaded update{rows.length === 1 ? '' : 's'} · {key.split('|')[0]}
                </summary>
                {rows.map(row => (
                  <div className="activity-record" key={row.id}>
                    <time>{formatDateTime(row.time)}</time>
                    <p>{title(row)}</p>
                    <small className="muted">
                      {row.event ? name(row.event.actor) : `${name(row.log!.from)} → ${name(row.log!.to)}`}
                    </small>
                  </div>
                ))}
              </details>
            </article>
          ))}
        </div>
      ) : (
        <div className="timeline">
          {visible.map(row =>
            row.event ? (
              <article key={row.id}>
                <span className="timeline-dot" />
                <div className="card-heading">
                  <h3>{label(row.event.kind.replaceAll('.', ' '))}</h3>
                  <time>{formatDateTime(row.event.createdAt)}</time>
                </div>
                <p>{row.event.reason}</p>
                <div className="event-meta">
                  <span>
                    #{row.event.sequence} · {name(row.event.actor)}
                  </span>
                  <details>
                    <summary>Event integrity</summary>
                    <code className="hash">{row.event.hash}</code>
                  </details>
                </div>
              </article>
            ) : (
              <article key={row.id}>
                <span className="timeline-dot" />
                <div className="card-heading">
                  <h3>
                    {name(row.log!.from)} → {name(row.log!.to)}
                  </h3>
                  <time>{formatDateTime(row.log!.timestamp)}</time>
                </div>
                <p>{row.log!.text}</p>
                <div className="event-meta">
                  <span>
                    {row.log!.kind.toLowerCase()} · {row.log!.conversationId} ·{' '}
                    {row.log!.provenance === 'OFFICE_EVENT' ? 'Office event' : 'Imported transcript'}
                  </span>
                  <details>
                    <summary>Record integrity</summary>
                    <code className="hash">
                      {row.log!.externalId}
                      <br />
                      {row.log!.provenance === 'OFFICE_EVENT' ? 'Event' : 'Source file'} SHA-256: {row.log!.sourceHash}
                    </code>
                  </details>
                </div>
              </article>
            ),
          )}
        </div>
      )}
      <div className="button-row">
        {cursor !== null && (
          <p className="muted">{plural(Math.max(0, total - entries.length), 'older event')} not yet loaded.</p>
        )}
        {cursor !== null && (
          <button className="secondary" disabled={busy} onClick={() => void load(cursor, false)}>
            {busy ? 'Loading…' : 'Load older events'}
          </button>
        )}
        {cursor === null && entries.length > 0 && (
          <p className="muted">The whole recorded history for this scope is shown.</p>
        )}
      </div>
    </>
  );
}
