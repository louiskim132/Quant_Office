import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Network} from 'lucide-react';
import type {AppState, FindingEvidenceRef, FindingKind, MemoryAuthor, MemoryFinding, MemoryGraph, RelationshipKind} from '../shared/types';
import {Empty, SearchField, label} from './components';
import './memory.css';

const KINDS: FindingKind[] = ['OBSERVATION', 'HYPOTHESIS', 'RESULT', 'DEFECT', 'DECISION', 'NOTE'];
const REL_KINDS: RelationshipKind[] = ['SUPPORTS', 'CONTRADICTS', 'RELATES', 'DUPLICATES', 'REFINES'];
// v2 holds only user-dragged seats. The v1 key stored every computed position once any node was
// dragged, which froze stale ellipse seats that new nodes then landed on; it is discarded on load.
const posKey = (projectId: string) => `qro.memory.seats.v2.${projectId}`;
const legacyPosKey = (projectId: string) => `qro.memory.pos.${projectId}`;
const W = 820, H = 540, R = 30;

/** FNV-1a — the first layout sorts on this, so a given node set always opens in the same shape. */
function hashOf(id: string) { let h = 0x811c9dc5; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
const shortHash = (s: string) => `${s.slice(0, 12)}…`;
const stamp = (iso: string) => new Date(iso).toLocaleString();
const authorLine = (a: MemoryAuthor) => `${a.surface.toLowerCase().replaceAll('_', ' ')}${a.agentId ? ` · agent ${a.agentId.slice(0, 8)}` : ''}${a.receiptHash ? ` · receipt ${shortHash(a.receiptHash)}` : ''}`;

export function MemoryView({state, projectId}: {state: AppState; projectId: string}) {
 const [graph, setGraph] = useState<MemoryGraph | null>(null);
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');
 const [busy, setBusy] = useState('');
 const [query, setQuery] = useState('');
 const [hits, setHits] = useState<MemoryFinding[] | null>(null);
 const [selectedNode, setSelectedNode] = useState('');
 const [selectedEdge, setSelectedEdge] = useState('');
 const [pos, setPos] = useState<Record<string, {x: number; y: number}>>({});
 const [view, setView] = useState({x: 0, y: 0, k: 1});
 const [hiddenKinds, setHiddenKinds] = useState<Set<FindingKind>>(new Set());
 const [showRefuted, setShowRefuted] = useState(false);
 const [linkTarget, setLinkTarget] = useState('');
 const [linkKind, setLinkKind] = useState<RelationshipKind>('RELATES');
 const [linkNote, setLinkNote] = useState('');
 const [cKind, setCKind] = useState<FindingKind>('NOTE');
 const [cTitle, setCTitle] = useState('');
 const [cBody, setCBody] = useState('');
 const [cRequest, setCRequest] = useState('');
 const [cRefs, setCRefs] = useState<string[]>([]);
 const [cSupersedes, setCSupersedes] = useState('');
 const svgRef = useRef<SVGSVGElement>(null);
 const gRef = useRef<SVGGElement>(null);
 const posRef = useRef<Record<string, {x: number; y: number}>>({});
 const draggedRef = useRef<Set<string>>(new Set());
 const dragRef = useRef<{kind: 'pan' | 'node' | 'edge'; id?: string; x: number; y: number; moved: boolean} | null>(null);
 const findings = state.findings ?? [];
 const relationships = state.relationships ?? [];
 const projectFindings = findings.filter(item => item.projectId === projectId);
 const liveFindings = projectFindings.filter(item => !item.supersededById);
 const projectRequests = (state.requests ?? []).filter(item => item.projectId === projectId && !item.removedAt);
 const projectArtifacts = state.artifacts.filter(item => item.projectId === projectId);

 const load = useCallback(async () => setGraph(await window.office.memoryGraph(projectId)), [projectId]);
 useEffect(() => {
  setSelectedNode(''); setSelectedEdge(''); setHits(null); setError('');
  void load().catch(e => setError((e as Error).message));
  return window.office.onChanged(() => { void load().catch(() => {}); });
 }, [load]);

 // Dragged seats persist per project in localStorage; embedders that forbid storage keep them
 // session-local — a guarded access never blocks the page.
 const loadStored = () => {
  try { window.localStorage.removeItem(legacyPosKey(projectId)); } catch { /* storage unavailable */ }
  try { const parsed = JSON.parse(window.localStorage.getItem(posKey(projectId)) ?? '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, {x: number; y: number}> : {}; }
  catch { return {}; }
 };
 const savePos = () => {
  const seats = Object.fromEntries(Object.entries(posRef.current).filter(([id]) => draggedRef.current.has(id)));
  try { window.localStorage.setItem(posKey(projectId), JSON.stringify(seats)); } catch { /* positions stay session-local */ }
 };
 useEffect(() => { draggedRef.current = new Set(); }, [projectId]);

 // Deterministic first layout: nodes sorted by a stable hash sit on an ellipse sized for the current
 // node count. Only user-dragged seats are kept — a seat dragged this session wins over a stored one.
 // Computed seats are never kept, so every undragged node re-flows when the node set changes.
 useEffect(() => {
  const nodes = [...(graph?.nodes ?? [])].sort((a, b) => hashOf(a.findingId) - hashOf(b.findingId));
  const stored = loadStored();
  for (const id of Object.keys(stored)) draggedRef.current.add(id);
  setPos(current => {
   const next: Record<string, {x: number; y: number}> = {};
   // The ellipse stays inside the canvas: a circle wider than H/2 cut the top and bottom nodes off
   // once a project held a dozen findings. Vertical room leaves space for the label under each node.
   const spread = Math.max(150, Math.min(290, nodes.length * 42));
   const rx = Math.min(spread, W / 2 - 80), ry = Math.min(spread, H / 2 - R - 26);
   nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1) - Math.PI / 2;
    const kept = draggedRef.current.has(node.findingId) ? current[node.findingId] ?? stored[node.findingId] : undefined;
    next[node.findingId] = kept && typeof kept.x === 'number' && typeof kept.y === 'number' ? kept : {x: W / 2 + rx * Math.cos(angle), y: H / 2 + ry * Math.sin(angle)};
   });
   posRef.current = next;
   return next;
  });
 }, [graph, projectId]);

 const toGraph = (clientX: number, clientY: number) => {
  const ctm = gRef.current?.getScreenCTM();
  const p = ctm ? new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse()) : {x: 0, y: 0};
  return {x: p.x, y: p.y};
 };
 const onPointerDown = (e: React.PointerEvent) => {
  const target = e.target as Element;
  const nodeEl = target.closest?.('[data-finding]');
  const edgeEl = target.closest?.('[data-rel]');
  dragRef.current = nodeEl
   ? {kind: 'node', id: nodeEl.getAttribute('data-finding')!, x: e.clientX, y: e.clientY, moved: false}
   : edgeEl
   ? {kind: 'edge', id: edgeEl.getAttribute('data-rel')!, x: e.clientX, y: e.clientY, moved: false}
   : {kind: 'pan', x: e.clientX, y: e.clientY, moved: false};
  e.currentTarget.setPointerCapture(e.pointerId);
 };
 const onPointerMove = (e: React.PointerEvent) => {
  const drag = dragRef.current;
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 2) drag.moved = true;
  if (drag.kind === 'pan') setView(v => ({...v, x: v.x + (e.clientX - drag.x), y: v.y + (e.clientY - drag.y)}));
  else if (drag.kind === 'node' && drag.id && drag.moved) { draggedRef.current.add(drag.id); const p = toGraph(e.clientX, e.clientY); setPos(current => { const next = {...current, [drag.id!]: p}; posRef.current = next; return next; }); }
  drag.x = e.clientX; drag.y = e.clientY;
 };
 const onPointerUp = () => {
  const drag = dragRef.current;
  dragRef.current = null;
  if (!drag) return;
  if (drag.moved) { if (drag.kind === 'node' && drag.id) savePos(); return; }
  if (drag.kind === 'node' && drag.id) { setSelectedNode(drag.id); setSelectedEdge(''); }
  else if (drag.kind === 'edge' && drag.id) { setSelectedEdge(drag.id); setSelectedNode(''); }
  else { setSelectedNode(''); setSelectedEdge(''); }
 };
 const onWheel = (e: React.WheelEvent) => setView(v => ({...v, k: Math.min(4, Math.max(0.25, v.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))}));

 async function run(action: () => Promise<unknown>, done: string) {
  setBusy(done); setError(''); setNotice('');
  try { await action(); setNotice(done); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
 }
 const doSearch = () => { if (!query.trim()) return; void run(async () => setHits((await window.office.searchMemory({projectId, text: query.trim(), limit: 10})).findings), 'Search complete.'); };
 const settle = (relationshipId: string, status: 'CONFIRMED' | 'REFUTED') => void run(() => window.office.command({type: 'memory.relationship.settle', idempotencyKey: crypto.randomUUID(), relationshipId, status}), `Link ${status.toLowerCase()}.`);
 const proposeLink = () => void run(async () => {
  await window.office.command({type: 'memory.relationship.propose', idempotencyKey: crypto.randomUUID(), projectId, fromFindingId: selectedNode, toFindingId: linkTarget, kind: linkKind, ...(linkNote.trim() ? {note: linkNote.trim()} : {})});
  setLinkTarget(''); setLinkNote('');
 }, 'Link proposed — it renders dashed until confirmed or refuted.');
 const focusNode = (id: string) => {
  setSelectedNode(id); setSelectedEdge('');
  // A search hit whose kind is filtered out would otherwise focus an invisible node.
  const kind = graph?.nodes.find(n => n.findingId === id)?.kind;
  if (kind) setHiddenKinds(current => { if (!current.has(kind)) return current; const next = new Set(current); next.delete(kind); return next; });
  const p = posRef.current[id];
  if (p) setView(v => ({k: v.k, x: W / 2 - p.x * v.k, y: H / 2 - p.y * v.k}));
 };
 const post = () => void run(async () => {
  const evidenceRefs: FindingEvidenceRef[] = cRefs.map(entry => { const [kind, id] = entry.split('|'); return {kind: kind as FindingEvidenceRef['kind'], id}; });
  await window.office.command({type: 'memory.finding.note', idempotencyKey: crypto.randomUUID(), projectId, requestId: cRequest || null, kind: cKind, title: cTitle, body: cBody,
   ...(evidenceRefs.length ? {evidenceRefs} : {}), ...(cSupersedes ? {supersedesFindingId: cSupersedes} : {})});
  setCTitle(''); setCBody(''); setCRequest(''); setCRefs([]); setCSupersedes('');
 }, 'Finding recorded.');

 const titleOf = (id: string) => graph?.nodes.find(n => n.findingId === id)?.title ?? `${id.slice(0, 8)}…`;
 const refLabel = (ref: FindingEvidenceRef) => {
  if (ref.kind === 'REQUEST') { const r = state.requests?.find(item => item.id === ref.id); return `Request · ${r?.name ?? `${ref.id.slice(0, 8)}…`}`; }
  if (ref.kind === 'ASSIGNMENT') { const a = state.assignments?.find(item => item.id === ref.id); return `Assignment · ${a?.pipelineKey ?? `${ref.id.slice(0, 8)}…`}`; }
  if (ref.kind === 'JOB') { const j = state.jobs?.find(item => item.id === ref.id); return `Job · ${ref.id.slice(0, 8)}…${j ? ` · ${j.state.toLowerCase().replaceAll('_', ' ')}` : ''}`; }
  if (ref.kind === 'FINDING') { const f = projectFindings.find(item => item.id === ref.id); return `Finding · ${f?.title ?? `${ref.id.slice(0, 8)}…`}`; }
  const art = state.artifacts.find(item => item.sha256 === ref.id);
  return `Artifact · ${art ? `${art.name} · ` : ''}${shortHash(ref.id)}`;
 };
 const nodeKind = new Map((graph?.nodes ?? []).map(node => [node.findingId, node.kind]));
 const visibleNodes = (graph?.nodes ?? []).filter(node => !hiddenKinds.has(node.kind));
 const visibleEdges = (graph?.edges ?? []).filter(edge => (edge.status !== 'REFUTED' || showRefuted) && pos[edge.from] && pos[edge.to] && !hiddenKinds.has(nodeKind.get(edge.from) ?? 'NOTE') && !hiddenKinds.has(nodeKind.get(edge.to) ?? 'NOTE'));
 const refutedCount = (graph?.edges ?? []).filter(edge => edge.status === 'REFUTED').length;
 const selNode = graph?.nodes.find(n => n.findingId === selectedNode);
 const selFinding = projectFindings.find(f => f.id === selectedNode);
 const selEdge = graph?.edges.find(e => e.relationshipId === selectedEdge);
 const selRel = relationships.find(r => r.id === selectedEdge);
 const refOptions = [
  ...projectRequests.map(item => ({value: `REQUEST|${item.id}`, text: `Request · ${item.name}`})),
  ...(state.assignments ?? []).filter(item => item.projectId === projectId).map(item => ({value: `ASSIGNMENT|${item.id}`, text: `Assignment · ${item.pipelineKey ?? `${(state.agents.find(agent => agent.id === item.agentId)?.role ?? 'agent').toLowerCase()} ${item.id.slice(0, 8)}`}`})),
  ...(state.jobs ?? []).filter(item => item.projectId === projectId).map(item => ({value: `JOB|${item.id}`, text: `Job · ${item.state.toLowerCase().replaceAll('_', ' ')} · ${item.id.slice(0, 8)}`})),
  ...projectArtifacts.map(item => ({value: `OBJECT|${item.sha256}`, text: `Artifact · ${item.name} · ${shortHash(item.sha256)}`})),
  ...projectFindings.map(item => ({value: `FINDING|${item.id}`, text: `Finding · ${item.title}${item.supersededById ? ' (superseded)' : ''}`})),
 ];

 return <section className="memory-page">
  <form className="memory-search section-toolbar" onSubmit={e => { e.preventDefault(); void doSearch(); }}>
   <SearchField value={query} onChange={setQuery} placeholder="Search findings"/>
   <button className="secondary" disabled={!!busy || !query.trim()}>{busy === 'Search complete.' ? 'Searching…' : 'Search'}</button>
  </form>
  {hits && (hits.length
   ? <div className="task-list memory-hits">{hits.map(hit => <article className="task-card memory-hit" key={hit.id}>
      <div className="card-heading"><h3>{hit.title}</h3><span><span className="quiet-badge small">{label(hit.kind)}</span>{hit.supersededById && <span className="quiet-badge small superseded-badge">superseded</span>}</span></div>
      <p className="task-prompt">{hit.body}</p>
      <p className="muted">{authorLine(hit.createdBy)} · {stamp(hit.createdAt)}</p>
      <div className="button-row"><button className="text-button" onClick={() => focusNode(hit.id)}>Show on graph</button></div>
     </article>)}</div>
   : <p className="muted">No findings match that search.</p>)}
  {!graph && !error && <p className="muted">Loading memory…</p>}
  {graph && !graph.nodes.length &&
   <Empty icon={Network} title="Nothing recorded yet" description="Findings recorded by sessions or by you appear here as an explorable graph. Record the first one below."/>}
  {!!graph?.nodes.length && <div className="memory-layout">
   <div className="memory-graph">
    <div className="memory-kindrow">
     {KINDS.map(kind => <button key={kind} type="button" aria-pressed={!hiddenKinds.has(kind)} className={`memory-kind kind-${kind.toLowerCase()}${hiddenKinds.has(kind) ? ' off' : ''}`}
      onClick={() => setHiddenKinds(current => { const next = new Set(current); if (current.has(kind)) next.delete(kind); else next.add(kind); return next; })}>{label(kind)}</button>)}
     <label className="memory-refuted"><input type="checkbox" checked={showRefuted} onChange={e => setShowRefuted(e.target.checked)}/>Show refuted</label>
    </div>
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Memory graph"
     onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} onWheel={onWheel}>
     <g ref={gRef} transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
      {visibleEdges.map(edge => {
       const a = pos[edge.from], b = pos[edge.to], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
       return <g key={edge.relationshipId} data-rel={edge.relationshipId} className={`mem-edge status-${edge.status.toLowerCase()}${selectedEdge === edge.relationshipId ? ' selected' : ''}`}>
        <line className="mem-edge-hit" x1={a.x} y1={a.y} x2={b.x} y2={b.y}/>
        <line className="mem-edge-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y}/>
        <text className="mem-edge-label" x={mx} y={my - 4} textAnchor="middle">{label(edge.kind)}</text>
       </g>;
      })}
      {visibleNodes.map(node => {
       const p = pos[node.findingId];
       if (!p) return null;
       return <g key={node.findingId} data-finding={node.findingId} className={`mem-node kind-${node.kind.toLowerCase()}${node.superseded ? ' superseded' : ''}${selectedNode === node.findingId ? ' selected' : ''}`} transform={`translate(${p.x} ${p.y})`}>
        <circle r={R}/>
        {node.superseded && <line className="mem-supersede" x1={-R + 9} y1={R - 9} x2={R - 9} y2={-R + 9}/>}
        <text className="mem-node-title" y={R + 16} textAnchor="middle">{node.title.length > 30 ? `${node.title.slice(0, 28)}…` : node.title}</text>
       </g>;
      })}
     </g>
    </svg>
    <p className="muted memory-hint">Drag to pan · scroll to zoom · drag a node to place it{refutedCount ? ` · ${refutedCount} refuted link${refutedCount === 1 ? '' : 's'} ${showRefuted ? 'shown struck-through' : 'hidden'}` : ''}</p>
   </div>
   <aside className="memory-detail">
    {selNode && <div className="memory-detail-card">
     <div className="card-heading"><h3>{selNode.title}</h3><span><span className="quiet-badge small">{label(selNode.kind)}</span>{selNode.superseded && <span className="quiet-badge small superseded-badge">superseded</span>}</span></div>
     {selFinding ? <>
      <p className="memory-body">{selFinding.body}</p>
      <p className="muted">{authorLine(selFinding.createdBy)} · {stamp(selFinding.createdAt)}</p>
      {!!selFinding.evidenceRefs.length && <ul className="evidence-list">{selFinding.evidenceRefs.map(ref => <li key={ref.kind + ref.id}>{refLabel(ref)}</li>)}</ul>}
      {selFinding.supersededById && <p className="muted">Superseded by <button className="text-button" onClick={() => setSelectedNode(selFinding.supersededById!)}>{projectFindings.find(f => f.id === selFinding.supersededById)?.title ?? 'a later finding'}</button></p>}
     </> : <p className="muted">The finding record is not in the current workspace state.</p>}
     <details className="memory-link"><summary>Link to…</summary>
      <label className="field">Target<select value={linkTarget} onChange={e => setLinkTarget(e.target.value)}>
       <option value="">Pick a finding…</option>
       {projectFindings.filter(item => item.id !== selectedNode).map(item => <option key={item.id} value={item.id}>{item.title}{item.supersededById ? ' (superseded)' : ''}</option>)}
      </select></label>
      <label className="field">Kind<select value={linkKind} onChange={e => setLinkKind(e.target.value as RelationshipKind)}>{REL_KINDS.map(kind => <option key={kind} value={kind}>{label(kind)}</option>)}</select></label>
      <label className="field">Note (optional)<input value={linkNote} onChange={e => setLinkNote(e.target.value)} maxLength={1000} placeholder="Why these relate"/></label>
      <button type="button" className="primary" disabled={!!busy || !linkTarget} onClick={proposeLink}>Propose link</button>
     </details>
    </div>}
    {selEdge && <div className="memory-detail-card">
     <div className="card-heading"><h3>{titleOf(selEdge.from)} → {titleOf(selEdge.to)}</h3><span><span className="quiet-badge small">{label(selEdge.kind)}</span><span className="quiet-badge small">{label(selEdge.status)}</span></span></div>
     {selRel ? <>
      {selRel.note && <p className="memory-body">{selRel.note}</p>}
      <p className="muted">{authorLine(selRel.createdBy)} · {stamp(selRel.createdAt)}{selRel.decidedAt ? ` · settled ${stamp(selRel.decidedAt)}` : ''}</p>
     </> : <p className="muted">The link record is not in the current workspace state.</p>}
     {selEdge.status === 'PROPOSED' && <>
      <p className="muted">A proposed link is unconfirmed — settle it to record the user's call.</p>
      <div className="button-row">
       <button className="primary" disabled={!!busy} onClick={() => settle(selEdge.relationshipId, 'CONFIRMED')}>Confirm link</button>
       <button className="cancel-request" disabled={!!busy} onClick={() => settle(selEdge.relationshipId, 'REFUTED')}>Refute link</button>
      </div>
     </>}
    </div>}
    {!selNode && !selEdge && <div className="memory-detail-card memory-detail-empty"><p className="muted">Select a node for its finding record, or an edge for the link record. Dashed links are proposed, not established.</p></div>}
   </aside>
  </div>}
  <details className="memory-composer"><summary>New finding</summary>
   <form onSubmit={e => { e.preventDefault(); post(); }}>
    <label className="field">Kind<select value={cKind} onChange={e => setCKind(e.target.value as FindingKind)}>{KINDS.map(kind => <option key={kind} value={kind}>{label(kind)}</option>)}</select></label>
    <label className="field">Title<input value={cTitle} onChange={e => setCTitle(e.target.value)} maxLength={160} required placeholder="One-line claim"/></label>
    <label className="field">Body<textarea value={cBody} onChange={e => setCBody(e.target.value)} maxLength={4000} required placeholder="The finding itself — bounded, never a transcript dump"/></label>
    <label className="field">Request (optional)<select value={cRequest} onChange={e => setCRequest(e.target.value)}><option value="">Not tied to a request</option>{projectRequests.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {!!refOptions.length && <label className="field">Evidence (optional)<select multiple value={cRefs} onChange={e => setCRefs([...e.target.selectedOptions].map(o => o.value))}>{refOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.text}</option>)}</select></label>}
    {!!liveFindings.length && <label className="field">Supersedes (optional)<select value={cSupersedes} onChange={e => setCSupersedes(e.target.value)}><option value="">A new finding, not a correction</option>{liveFindings.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
    <button className="primary" disabled={!!busy || !cTitle.trim() || !cBody.trim()}>Record finding</button>
   </form>
  </details>
  {error && <p className="notice error" role="alert">{error}</p>}
  {notice && <p className="notice success" role="status">{notice}</p>}
 </section>;
}
