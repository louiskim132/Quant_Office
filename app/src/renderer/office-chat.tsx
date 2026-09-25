import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, MessageCircle, RefreshCw, Users } from 'lucide-react';
import type { AppState } from '../shared/types';
import type { OfficeChatEntry, OfficeChatPage } from '../shared/office-chat';
import './office-chat.css';

const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = (value: string) => {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString() ? 'Today' : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};
const initials = (name: string) => name.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
const compare = (a: OfficeChatEntry, b: OfficeChatEntry) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);

export function OfficeChat({ state }: { state: AppState }) {
  const [projectId, setProjectId] = useState(''), [agentId, setAgentId] = useState('');
  const [entries, setEntries] = useState<OfficeChatEntry[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [unread, setUnread] = useState(false);
  const [historyNotice, setHistoryNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const latestEntries = useRef(entries); latestEntries.current = entries;
  const pagedBack = useRef(false);
  const feed = useRef<HTMLDivElement>(null), atBottom = useRef(true), epoch = useRef(0);
  const scrollMode = useRef<'bottom' | 'preserve' | 'none'>('bottom'), oldHeight = useRef(0);
  const scope = useRef({ projectId, agentId }); scope.current = { projectId, agentId };
  const request = useRef(0);
  const agent = (id: string | null) => state.agents.find(a => a.id === id);
  const name = (id: string | null) => agent(id)?.name ?? (id ? 'Former agent' : 'Office');

  useEffect(() => {
    const currentEpoch = ++epoch.current;
    let disposed = false, loading = false, queued = false;
    setEntries([]); latestEntries.current = []; setCursor(null); setError(''); setHistoryNotice(''); setUnread(false); atBottom.current = true; pagedBack.current = false;
    const load = async () => {
      if (loading) { queued = true; return; }
      loading = true;
      const ticket = ++request.current;
      setBusy(true);
      try {
        const page = await window.office.officeChatPage({ ...(projectId ? { projectId } : {}), ...(agentId ? { agentId } : {}), limit: 50 });
        if (disposed || currentEpoch !== epoch.current || ticket !== request.current) return;
        scrollMode.current = atBottom.current ? 'bottom' : 'none';
        const knownEntries = new Map(latestEntries.current.map(e => [e.id, e]));
        const priorMessages = latestEntries.current.filter(e => e.source !== 'OFFICE_STATUS');
        const resetWindow = !!page.nextCursor && priorMessages.length > 0
          && !page.entries.some(e => e.source !== 'OFFICE_STATUS' && knownEntries.has(e.id));
        if (resetWindow) {
          pagedBack.current = false;
          setHistoryNotice('A new batch of updates arrived. Load earlier updates to catch up.');
        }
        if (!atBottom.current && page.entries.some(e => !knownEntries.has(e.id) || knownEntries.get(e.id)?.text !== e.text)) setUnread(true);
        setEntries(previous => {
          const known = new Map((resetWindow ? [] : previous).map(e => [e.id, e]));
          for (const entry of page.entries) known.set(entry.id, entry);
          return [...known.values()].sort(compare);
        });
        // Keep the oldest cursor after the reader has loaded earlier pages.
        if (!pagedBack.current) setCursor(page.nextCursor);
        setError('');
      } catch (e) { if (!disposed && ticket === request.current) setError((e as Error).message); }
      finally {
        loading = false;
        if (!disposed && currentEpoch === epoch.current) {
          setBusy(false);
          if (queued) { queued = false; void load(); }
        }
      }
    };
    void load();
    const unsubscribe = window.office.onChanged(() => { void load(); });
    return () => { disposed = true; unsubscribe(); };
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
    const currentEpoch = epoch.current, ticket = ++request.current;
    const currentScope = scope.current;
    setBusy(true);
    try {
      const page: OfficeChatPage = await window.office.officeChatPage({ ...(currentScope.projectId ? { projectId: currentScope.projectId } : {}), ...(currentScope.agentId ? { agentId: currentScope.agentId } : {}), cursor, limit: 50 });
      if (currentEpoch !== epoch.current || ticket !== request.current) return;
      oldHeight.current = feed.current?.scrollHeight ?? 0; scrollMode.current = 'preserve';
      pagedBack.current = true;
      setEntries(previous => [...new Map([...page.entries, ...previous].map(e => [e.id, e])).values()].sort(compare));
      setCursor(page.nextCursor); setError('');
    } catch (e) { if (currentEpoch === epoch.current && ticket === request.current) setError((e as Error).message); }
    finally { if (currentEpoch === epoch.current && ticket === request.current) setBusy(false); }
  }
  const participants = [...new Set(entries.flatMap(e => [e.agentId, e.toAgentId]).filter((id): id is string => !!id))];
  return <section className="office-chat" aria-label="Office group chat">
    <header className="office-chat-heading">
      <span className="office-chat-icon"><Users size={21}/></span>
      <div><h2>Office chat</h2><p>{participants.length ? `${participants.length} participants · ${projectId ? state.projects.find(p => p.id === projectId)?.name ?? 'Project' : 'All projects'}` : 'Your team’s work, in one conversation'}</p></div>
      <button className="office-chat-refresh" aria-label="Refresh office chat" disabled={busy} onClick={() => setRevision(v => v + 1)}><RefreshCw size={16}/></button>
    </header>
    <div className="office-chat-filters">
      <label>Project<select aria-label="Chat project" value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">All projects</option>{state.projects.filter(p => !p.removedAt).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label>Participant<select aria-label="Chat participant" value={agentId} onChange={e => setAgentId(e.target.value)}><option value="">Everyone</option>{state.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    </div>
    {error && <div className="office-chat-error" role="alert">Couldn’t load updates. {error}<button onClick={() => setRevision(v => v + 1)}>Retry</button></div>}
    {historyNotice && <div className="office-chat-history-notice" role="status">{historyNotice}</div>}
    <div className="office-chat-feed" ref={feed} role="log" aria-label="Agent conversation" aria-live="polite" aria-relevant="additions" aria-busy={busy} tabIndex={0}
      onScroll={() => { const node = feed.current!; atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 55; if (atBottom.current) setUnread(false); }}>
      {cursor && <button className="office-chat-older" disabled={busy} onClick={() => void older()}>Load earlier updates</button>}
      {!entries.length && <div className="office-chat-empty"><MessageCircle size={34}/><h3>{busy ? 'Loading conversation…' : 'The conversation starts here'}</h3><p>{agentId || projectId ? 'No recorded updates match these filters.' : 'Agent messages, handoffs and work updates will appear here as they are recorded.'}</p></div>}
      {entries.map((entry, index) => {
        const author = agent(entry.agentId), system = entry.kind === 'STATUS', role = author?.role.replaceAll('_', ' ');
        const requestName = state.requests?.find(r => r.id === entry.requestId)?.name;
        const color = author?.role === 'DIRECTOR' ? '#9c641b' : author?.role.startsWith('PM') ? '#7a5bad' : '#167d78';
        // Status updates show their first line; anything further stays behind the expander.
        const firstLine = entry.text.split('\n', 1)[0];
        const preview = firstLine.length > 220 ? `${firstLine.slice(0, 220)}…` : firstLine;
        return <React.Fragment key={entry.id}>
          {(index === 0 || day(entries[index - 1].timestamp) !== day(entry.timestamp)) && <div className="office-chat-day"><span>{day(entry.timestamp)}</span></div>}
          {system ? <article className="office-chat-system" data-chat-source={entry.source}><strong>{name(entry.agentId)} · {entry.label}</strong><p>{preview}</p>{preview !== entry.text && <details><summary>Details</summary><p>{entry.text}</p></details>}<time dateTime={entry.timestamp}>{time(entry.timestamp)}</time></article>
            : <article className={`office-chat-message ${author?.role === 'DIRECTOR' ? 'director-message' : ''}`} data-chat-source={entry.source}>
              <span className="office-chat-avatar" style={{ color }} aria-hidden="true">{initials(name(entry.agentId))}</span>
              <div className="office-chat-bubble"><div className="office-chat-author"><strong style={{ color }}>{name(entry.agentId)}</strong>{role && <span>{role}</span>}</div>
                <div className="office-chat-context">{entry.toAgentId ? `To ${name(entry.toAgentId)} · ${entry.label} · ` : ''}{requestName || 'Office work'}{entry.kind === 'TOOL' ? ' · Tool activity' : ''}</div>
                <p>{entry.text.length > 1400 ? `${entry.text.slice(0, 1400)}…` : entry.text}</p>{entry.text.length > 1400 && <details><summary>Read full message</summary><p>{entry.text}</p></details>}
                <footer><span>{entry.evidence === 'USER_REPORTED' ? 'User reported' : entry.evidence === 'OFFICE_LOCAL' ? 'Office record' : 'Provider reported'}</span><time dateTime={entry.timestamp} title={new Date(entry.timestamp).toLocaleString()}>{time(entry.timestamp)}</time></footer>
              </div>
            </article>}
        </React.Fragment>;
      })}
    </div>
    {unread && <button className="office-chat-latest" onClick={() => { atBottom.current = true; setUnread(false); if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }}><ArrowDown size={14}/>New updates</button>}
    <div className="office-chat-footer"><span className="office-chat-record-dot"/>Recorded messages &amp; activity · view only</div>
  </section>;
}
