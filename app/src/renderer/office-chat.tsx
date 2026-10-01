import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, MessageCircle, RefreshCw, Users } from 'lucide-react';
import type { AppState } from '../shared/types';
import type { OfficeChatEntry, OfficeChatPage } from '../shared/office-chat';
import './office-chat.css';
import { formatDateTime, plural, UI_LOCALE } from './format';
import { Avatar, Empty, ProvChip } from './components';
import { useOfficeActivity } from './use-activity';

/** Chat timestamps use the fixed UI locale, not the host locale, so copy and dates never mix languages. */
export const chatTime = (value: string) =>
  new Date(value).toLocaleTimeString(UI_LOCALE, { hour: 'numeric', minute: '2-digit' });
export const chatDay = (value: string) => {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? 'Today'
    : date.toLocaleDateString(UI_LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
};
const compare = (a: OfficeChatEntry, b: OfficeChatEntry) =>
  a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);

export function OfficeChat({ state, initialAgentId = '' }: { state: AppState; initialAgentId?: string }) {
  const { activity } = useOfficeActivity(state);
  const [requestId, setRequestId] = useState(''),
    [search, setSearch] = useState(''),
    [kind, setKind] = useState('');
  const [projectId, setProjectId] = useState(''),
    [agentId, setAgentId] = useState(initialAgentId);
  const [entries, setEntries] = useState<OfficeChatEntry[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [unread, setUnread] = useState(false);
  const [historyNotice, setHistoryNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const latestEntries = useRef(entries);
  latestEntries.current = entries;
  const pagedBack = useRef(false);
  const feed = useRef<HTMLDivElement>(null),
    atBottom = useRef(true),
    epoch = useRef(0);
  const scrollMode = useRef<'bottom' | 'preserve' | 'none'>('bottom'),
    oldHeight = useRef(0);
  const scope = useRef({ projectId, agentId });
  scope.current = { projectId, agentId };
  const request = useRef(0);
  const agent = (id: string | null) => state.agents.find(a => a.id === id);
  const name = (id: string | null) => agent(id)?.name ?? (id ? 'Former agent' : 'Office');

  useEffect(() => {
    const currentEpoch = ++epoch.current;
    let disposed = false,
      loading = false,
      queued = false;
    setEntries([]);
    latestEntries.current = [];
    setCursor(null);
    setError('');
    setHistoryNotice('');
    setUnread(false);
    atBottom.current = true;
    pagedBack.current = false;
    const load = async () => {
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      const ticket = ++request.current;
      setBusy(true);
      try {
        const page = await window.office.officeChatPage({
          ...(projectId ? { projectId } : {}),
          ...(agentId ? { agentId } : {}),
          limit: 50,
        });
        if (disposed || currentEpoch !== epoch.current || ticket !== request.current) return;
        scrollMode.current = atBottom.current ? 'bottom' : 'none';
        const knownEntries = new Map(latestEntries.current.map(e => [e.id, e]));
        const priorMessages = latestEntries.current.filter(e => e.source !== 'OFFICE_STATUS');
        const resetWindow =
          !!page.nextCursor &&
          priorMessages.length > 0 &&
          !page.entries.some(e => e.source !== 'OFFICE_STATUS' && knownEntries.has(e.id));
        if (resetWindow) {
          pagedBack.current = false;
          setHistoryNotice('A new batch of updates arrived. Load earlier updates to catch up.');
        }
        if (
          !atBottom.current &&
          page.entries.some(e => !knownEntries.has(e.id) || knownEntries.get(e.id)?.text !== e.text)
        )
          setUnread(true);
        setEntries(previous => {
          const known = new Map((resetWindow ? [] : previous).map(e => [e.id, e]));
          for (const entry of page.entries) known.set(entry.id, entry);
          return [...known.values()].sort(compare);
        });
        // Keep the oldest cursor after the reader has loaded earlier pages.
        if (!pagedBack.current) setCursor(page.nextCursor);
        setError('');
      } catch (e) {
        if (!disposed && ticket === request.current) setError((e as Error).message);
      } finally {
        loading = false;
        if (!disposed && currentEpoch === epoch.current) {
          setBusy(false);
          if (queued) {
            queued = false;
            void load();
          }
        }
      }
    };
    void load();
    const unsubscribe = window.office.onChanged(() => {
      void load();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [projectId, agentId, revision]);

  useEffect(() => {
    const node = feed.current;
    if (!node) return;
    if (scrollMode.current === 'bottom') node.scrollTop = node.scrollHeight;
    if (scrollMode.current === 'preserve') node.scrollTop += node.scrollHeight - oldHeight.current;
    scrollMode.current = 'none';
  }, [entries]);

  async function older() {
    if (!cursor || busy) return;
    const currentEpoch = epoch.current,
      ticket = ++request.current;
    const currentScope = scope.current;
    setBusy(true);
    try {
      const page: OfficeChatPage = await window.office.officeChatPage({
        ...(currentScope.projectId ? { projectId: currentScope.projectId } : {}),
        ...(currentScope.agentId ? { agentId: currentScope.agentId } : {}),
        cursor,
        limit: 50,
      });
      if (currentEpoch !== epoch.current || ticket !== request.current) return;
      oldHeight.current = feed.current?.scrollHeight ?? 0;
      scrollMode.current = 'preserve';
      pagedBack.current = true;
      setEntries(previous => [...new Map([...page.entries, ...previous].map(e => [e.id, e])).values()].sort(compare));
      setCursor(page.nextCursor);
      setError('');
    } catch (e) {
      if (currentEpoch === epoch.current && ticket === request.current) setError((e as Error).message);
    } finally {
      if (currentEpoch === epoch.current && ticket === request.current) setBusy(false);
    }
  }
  const participants = [...new Set(entries.flatMap(e => [e.agentId, e.toAgentId]).filter((id): id is string => !!id))];
  const shown = entries.filter(
    e =>
      (!requestId || e.requestId === requestId) &&
      (!kind ||
        (kind === 'HANDOFF' ? e.source === 'AGENT_MESSAGE' && e.label.startsWith('handoff') : e.kind === kind)) &&
      `${e.text} ${name(e.agentId)}`.toLowerCase().includes(search.toLowerCase()),
  );
  // An empty feed is either a truly silent scope or a filter/scope miss — never blur the two.
  const filteredEmpty = !shown.length && (!!entries.length || !!(agentId || projectId || requestId || kind || search));
  const plainText = (text: string) => text.replace(/\b[a-f0-9]{64}\b/gi, 'stored packet');
  return (
    <section className="office-chat" aria-label="Office group chat">
      <header className="office-chat-heading">
        <span className="office-chat-icon">
          <Users size={21} />
        </span>
        <div>
          <h2>Office chat</h2>
          <p>
            {participants.length
              ? `${plural(participants.length, 'participant')} · ${projectId ? (state.projects.find(p => p.id === projectId)?.name ?? 'Project') : 'All projects'} · office records`
              : 'The office channel — every update is a recorded entry, labeled by its source'}
          </p>
        </div>
        <button
          className="office-chat-refresh"
          aria-label="Refresh office chat"
          disabled={busy}
          onClick={() => setRevision(v => v + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </header>
      <div className="office-chat-filters">
        <label>
          Project
          <select
            aria-label="Chat project"
            value={projectId}
            onChange={e => {
              setProjectId(e.target.value);
              setRequestId('');
            }}
          >
            <option value="">All projects</option>
            {state.projects
              .filter(p => !p.removedAt)
              .map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Participant
          <select
            disabled={!!initialAgentId}
            aria-label="Chat participant"
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
          >
            <option value="">Everyone</option>
            {state.agents.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="office-chat-filters">
        <label>
          Thread
          <select aria-label="Chat thread" value={requestId} onChange={e => setRequestId(e.target.value)}>
            <option value="">All request threads</option>
            {(state.requests ?? [])
              .filter(r => !projectId || r.projectId === projectId)
              .map(r => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Search
          <input
            aria-label="Search conversation"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search loaded messages only"
          />
        </label>
        <label>
          Updates
          <select aria-label="Chat update type" value={kind} onChange={e => setKind(e.target.value)}>
            <option value="">All updates</option>
            <option value="STATUS">Status</option>
            <option value="HANDOFF">Handoffs</option>
            <option value="MESSAGE">Messages</option>
            <option value="TOOL">Tools</option>
          </select>
        </label>
      </div>
      {error && (
        <div className="office-chat-error" role="alert">
          Couldn’t load updates. {error}
          <button onClick={() => setRevision(v => v + 1)}>Retry</button>
        </div>
      )}
      {historyNotice && (
        <div className="office-chat-history-notice" role="status">
          {historyNotice}
        </div>
      )}
      <div
        className="office-chat-feed"
        ref={feed}
        role="log"
        aria-label="Agent conversation"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={busy}
        tabIndex={0}
        onScroll={() => {
          const node = feed.current!;
          atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 55;
          if (atBottom.current) setUnread(false);
        }}
      >
        {cursor && (
          <button className="office-chat-older" disabled={busy} onClick={() => void older()}>
            Load earlier updates
          </button>
        )}
        {!shown.length && (
          <Empty
            icon={MessageCircle}
            title={
              busy
                ? 'Loading conversation…'
                : filteredEmpty
                  ? 'No recorded updates match these filters'
                  : 'The conversation starts here'
            }
            description={
              filteredEmpty
                ? 'Search and filters cover only the loaded conversation — widen them, or load earlier updates.'
                : 'Agent messages, handoffs and work updates will appear here as they are recorded.'
            }
            secondary={
              cursor && filteredEmpty ? (
                <button className="secondary" disabled={busy} onClick={() => void older()}>
                  Load earlier updates
                </button>
              ) : undefined
            }
          />
        )}
        {shown.map((entry, index) => {
          const author = agent(entry.agentId),
            system = entry.kind === 'STATUS',
            role = author?.role.replaceAll('_', ' ');
          const requestName = state.requests?.find(r => r.id === entry.requestId)?.name;
          const color = author?.role === 'DIRECTOR' ? '#9c641b' : author?.role.startsWith('PM') ? '#7a5bad' : '#167d78';
          // Status updates show their first line; anything further stays behind the expander.
          const firstLine = plainText(entry.text).split('\n', 1)[0];
          const preview = firstLine.length > 220 ? `${firstLine.slice(0, 220)}…` : firstLine;
          return (
            <React.Fragment key={entry.id}>
              {(index === 0 || chatDay(shown[index - 1].timestamp) !== chatDay(entry.timestamp)) && (
                <div className="office-chat-day">
                  <span>{chatDay(entry.timestamp)}</span>
                </div>
              )}
              {system ? (
                <article className="office-chat-system" data-chat-source={entry.source}>
                  <strong>
                    {name(entry.agentId)} · {entry.label}
                  </strong>
                  <p>{preview}</p>
                  {preview !== entry.text && (
                    <details>
                      <summary>Technical details</summary>
                      <p>{entry.text}</p>
                    </details>
                  )}
                  <time dateTime={entry.timestamp}>{chatTime(entry.timestamp)}</time>
                </article>
              ) : (
                <article
                  className={`office-chat-message ${author?.role === 'DIRECTOR' ? 'director-message' : ''}`}
                  data-chat-source={entry.source}
                >
                  <Avatar id={entry.agentId ?? 'office'} name={name(entry.agentId)} />
                  <div className="office-chat-bubble">
                    <div className="office-chat-author">
                      <strong style={{ color }}>{name(entry.agentId)}</strong>
                      {role && <span>{role}</span>}
                    </div>
                    <div className="office-chat-context">
                      {entry.toAgentId ? `To ${name(entry.toAgentId)} · ${entry.label} · ` : ''}
                      {requestName || 'Office work'}
                      {entry.kind === 'TOOL' ? ' · Tool activity' : ''}
                    </div>
                    <p>
                      {plainText(entry.text).length > 1400
                        ? `${plainText(entry.text).slice(0, 1400)}…`
                        : plainText(entry.text)}
                    </p>
                    {(entry.text.length > 1400 || plainText(entry.text) !== entry.text) && (
                      <details>
                        <summary>Read full message</summary>
                        <p>{entry.text}</p>
                      </details>
                    )}
                    <footer>
                      <ProvChip evidence={entry.evidence} />
                      <time dateTime={entry.timestamp} title={formatDateTime(entry.timestamp)}>
                        {chatTime(entry.timestamp)}
                      </time>
                    </footer>
                  </div>
                </article>
              )}
            </React.Fragment>
          );
        })}
        {activity
          .filter(
            a =>
              a.kind === 'WORKING' &&
              (!agentId || a.agentId === agentId) &&
              (!requestId || a.requestId === requestId) &&
              (!projectId || state.requests?.find(r => r.id === a.requestId)?.projectId === projectId),
          )
          .map(a => (
            <p key={a.agentId} className="office-chat-working">
              <Avatar id={a.agentId} name={name(a.agentId)} /> {name(a.agentId)} is working ·{' '}
              {a.evidence === 'OFFICE_OBSERVED' ? 'office-observed process' : 'provider-reported activity'}
            </p>
          ))}
      </div>
      {unread && (
        <button
          className="office-chat-latest"
          onClick={() => {
            atBottom.current = true;
            setUnread(false);
            if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
          }}
        >
          <ArrowDown size={14} />
          New updates
        </button>
      )}
      <div className="office-chat-footer">
        <span className="office-chat-record-dot" />
        Recorded messages &amp; activity · view only
      </div>
    </section>
  );
}
