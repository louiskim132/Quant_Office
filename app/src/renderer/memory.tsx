import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Network} from 'lucide-react';
import type {AppState, FindingEvidenceRef, FindingKind, MemoryAuthor, MemoryFinding, MemoryGraph} from '../shared/types';
import {Empty, SearchField, label} from './components';
import './memory.css';

const KINDS: FindingKind[] = ['OBSERVATION', 'HYPOTHESIS', 'RESULT', 'DEFECT', 'DECISION', 'NOTE'];
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
 const [cKind, setCKind] = useState<FindingKind>('NOTE');
 const [cTitle, setCTitle] = useState('');
 const [cBody, setCBody] = useState('');
 const [cRequest, setCRequest] = useState('');
 const [cRefs, setCRefs] = useState<string[]>([]);
 const [cSupersedes, setCSupersedes] = useState('');
 const svgRef = useRef<SVGSVGElement>(null);
 const gRef = useRef<SVGGElement>(null);
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

 // Deterministic first layout: nodes sorted by a stable hash sit on an ellipse. Positions a user
 // dragged survive for nodes still on the graph; new nodes take their seat by the same rule.
 useEffect(() => {
  const nodes = [...(graph?.nodes ?? [])].sort((a, b) => hashOf(a.findingId) - hashOf(b.findingId));
  setPos(current => {
   const next: Record<string, {x: number; y: number}> = {};
   const radius = Math.max(150, Math.min(290, nodes.length * 42));
   nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1) - Math.PI / 2;
    next[node.findingId] = current[node.findingId] ?? {x: W / 2 + radius * Math.cos(angle), y: H / 2 + radius * Math.sin(angle)};
   });
   return next;
  });
 }, [graph]);

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
  else if (drag.kind === 'node' && drag.id && drag.moved) { const p = toGraph(e.clientX, e.clientY); setPos(current => ({...current, [drag.id!]: p})); }
  drag.x = e.clientX; drag.y = e.clientY;
 };
 const onPointerUp = () => {
  const drag = dragRef.current;
  dragRef.current = null;
  if (!drag || drag.moved) return;
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
  const art = state.artifacts.find(item => item.sha256 === ref.id);
  return `Artifact · ${art ? `${art.name} · ` : ''}${shortHash(ref.id)}`;
 };
 const visibleEdges = (graph?.edges ?? []).filter(edge => edge.status !== 'REFUTED' && pos[edge.from] && pos[edge.to]);
 const refutedCount = (graph?.edges ?? []).filter(edge => edge.status === 'REFUTED').length;
 const selNode = graph?.nodes.find(n => n.findingId === selectedNode);
 const selFinding = projectFindings.find(f => f.id === selectedNode);
 const selEdge = graph?.edges.find(e => e.relationshipId === selectedEdge);
 const selRel = relationships.find(r => r.id === selectedEdge);
 const refOptions = [
  ...projectRequests.map(item => ({value: `REQUEST|${item.id}`, text: `Request · ${item.name}`})),
  ...projectArtifacts.map(item => ({value: `OBJECT|${item.sha256}`, text: `Artifact · ${item.name} · ${shortHash(item.sha256)}`})),
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
      <div className="button-row"><button className="text-button" onClick={() => { setSelectedNode(hit.id); setSelectedEdge(''); }}>Show on graph</button></div>
     </article>)}</div>
   : <p className="muted">No findings match that search.</p>)}
  {!graph && !error && <p className="muted">Loading memory…</p>}
  {graph && !graph.nodes.length &&
   <Empty icon={Network} title="Nothing recorded yet" description="Findings recorded by sessions or by you appear here as an explorable graph. Record the first one below."/>}
  {!!graph?.nodes.length && <div className="memory-layout">
   <div className="memory-graph">
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
      {(graph?.nodes ?? []).map(node => {
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
    <p className="muted memory-hint">Drag to pan · scroll to zoom · drag a node to place it{refutedCount ? ` · ${refutedCount} refuted link${refutedCount === 1 ? '' : 's'} hidden` : ''}</p>
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
