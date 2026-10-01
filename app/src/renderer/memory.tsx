import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LocateFixed, Network, Pause, PanelLeft, Play, RotateCcw, SlidersHorizontal, Tag, X } from 'lucide-react';
import type {
  AppState,
  FindingEvidenceRef,
  FindingKind,
  MemoryAuthor,
  MemoryFinding,
  MemoryGraph,
  RelationshipKind,
} from '../shared/types';
import { Empty, SearchField, label } from './components';
import './memory.css';
import { formatDateTime } from './format';
import {
  memoryDegrees,
  memoryInWindow,
  memoryNeighborhood,
  MEMORY_EDGE_LIMIT,
  MEMORY_NODE_LIMIT,
  MEMORY_WINDOWS,
} from './memory-layout';
import { MemoryBrain } from './memory-brain';
import { DEFAULT_FORCES } from './brain-sim';
import { useBoolPref, usePref } from './prefs';

const KINDS: FindingKind[] = ['OBSERVATION', 'HYPOTHESIS', 'RESULT', 'DEFECT', 'DECISION', 'NOTE'];
const REL_KINDS: RelationshipKind[] = ['SUPPORTS', 'CONTRADICTS', 'RELATES', 'DUPLICATES', 'REFINES'];
// v2 holds only user-dragged seats. Computed positions are never stored: the layout is derived.
const posKey = (projectId: string) => `qro.memory.seats.v2.${projectId}`;
const legacyPosKey = (projectId: string) => `qro.memory.pos.${projectId}`;

/** Proposed relationships with at least one endpoint in the selection — the bulk-settle target set. */
export function memorySettleTargets(
  edges: readonly { relationshipId: string; from: string; to: string; status: string }[],
  selected: ReadonlySet<string>,
) {
  return edges.filter(e => e.status === 'PROPOSED' && (selected.has(e.from) || selected.has(e.to)));
}

const shortHash = (s: string) => `${s.slice(0, 12)}…`;
const stamp = (iso: string) => formatDateTime(iso);
const authorLine = (a: MemoryAuthor) =>
  `${a.surface.toLowerCase().replaceAll('_', ' ')}${a.agentId ? ` · agent ${a.agentId.slice(0, 8)}` : ''}${a.receiptHash ? ` · receipt ${shortHash(a.receiptHash)}` : ''}`;

/** A numeric preference stored as text. */
function useNumPref(name: string, fallback: number): [number, (value: number) => void] {
  const [raw, set] = usePref(name, String(fallback));
  const value = Number(raw);
  return [Number.isFinite(value) ? value : fallback, (next: number) => set(String(next))];
}

function Toggle({
  on,
  onChange,
  children,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="brain-row">
      <span>{children}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={typeof children === 'string' ? children : undefined}
        className={`switch ${on ? 'on' : ''}`}
        onClick={() => onChange(!on)}
      >
        <span />
      </button>
    </div>
  );
}
function Slider({
  name,
  value,
  min,
  max,
  step,
  onChange,
}: {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="brain-row brain-slider">
      <span>{name}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={name}
        onChange={e => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function MemoryView({ state, projectId }: { state: AppState; projectId: string }) {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryFinding[] | null>(null);
  const [selectedNode, setSelectedNode] = useState('');
  const [selectedEdge, setSelectedEdge] = useState('');
  const [localOnly, setLocalOnly] = useState(false);
  const [listQuery, setListQuery] = useState('');
  const [pins, setPins] = useState<Record<string, { x: number; y: number }>>({});
  const [hiddenKinds, setHiddenKinds] = useState<Set<FindingKind>>(new Set());
  const [showRefuted, setShowRefuted] = useState(false);
  const [windowSel, setWindowSel] = useState('all');
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [bulkAsk, setBulkAsk] = useState<'' | 'CONFIRMED' | 'REFUTED'>('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState('');
  const [linkKind, setLinkKind] = useState<RelationshipKind>('RELATES');
  const [linkNote, setLinkNote] = useState('');
  const [cKind, setCKind] = useState<FindingKind>('NOTE');
  const [cTitle, setCTitle] = useState('');
  const [cBody, setCBody] = useState('');
  const [cRequest, setCRequest] = useState('');
  const [cRefs, setCRefs] = useState<string[]>([]);
  const [cSupersedes, setCSupersedes] = useState('');
  const [fitSignal, setFitSignal] = useState(0);
  const [resetSignal, setResetSignal] = useState(0);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  // Display preferences (per viewer): the Names switch, arrows, sizes, forces and open panels.
  const [names, setNames] = useBoolPref('memory-names', true);
  const [arrows, setArrows] = useBoolPref('memory-arrows', true);
  const [orphans, setOrphans] = useBoolPref('memory-orphans', true);
  const [animate, setAnimate] = useBoolPref('memory-animate', true);
  const [panelOpen, setPanelOpen] = useBoolPref('memory-panel', false);
  const [listOpen, setListOpen] = useBoolPref(
    'memory-list',
    typeof window !== 'undefined' && window.innerWidth >= 1700,
  );
  const [nodeScale, setNodeScale] = useNumPref('memory-node-size', 1);
  const [linkWidth, setLinkWidth] = useNumPref('memory-link-width', 1);
  const [textFade, setTextFade] = useNumPref('memory-text-fade', 0.35);
  const [localDepth, setLocalDepth] = useNumPref('memory-local-depth', 1);
  const [center, setCenter] = useNumPref('memory-force-center', DEFAULT_FORCES.center);
  const [repel, setRepel] = useNumPref('memory-force-repel', DEFAULT_FORCES.repel);
  const [linkStrength, setLinkStrength] = useNumPref('memory-force-link', DEFAULT_FORCES.linkStrength);
  const [linkDistance, setLinkDistance] = useNumPref('memory-force-distance', DEFAULT_FORCES.linkDistance);
  const forces = useMemo(
    () => ({ center, repel, linkStrength, linkDistance }),
    [center, repel, linkStrength, linkDistance],
  );
  const composerRef = useRef<HTMLDetailsElement>(null);
  const reducedMotion =
    typeof document !== 'undefined' &&
    (document.documentElement.dataset.motion === 'reduced' ||
      (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
  const findings = state.findings ?? [];
  const relationships = state.relationships ?? [];
  const projectFindings = findings.filter(item => item.projectId === projectId);
  const liveFindings = projectFindings.filter(item => !item.supersededById);
  const projectRequests = (state.requests ?? []).filter(item => item.projectId === projectId && !item.removedAt);
  const projectArtifacts = state.artifacts.filter(item => item.projectId === projectId);

  const load = useCallback(async () => setGraph(await window.office.memoryGraph(projectId)), [projectId]);
  useEffect(() => {
    setSelectedNode('');
    setSelectedEdge('');
    setHits(null);
    setError('');
    void load().catch(e => setError((e as Error).message));
    return window.office.onChanged(() => {
      void load().catch(() => {});
    });
  }, [load]);

  // Dragged seats persist per project in localStorage; embedders that forbid storage keep them
  // session-local — a guarded access never blocks the page.
  useEffect(() => {
    try {
      window.localStorage.removeItem(legacyPosKey(projectId));
    } catch {
      /* storage unavailable */
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(posKey(projectId)) ?? '{}');
      setPins(
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, { x: number; y: number }>)
          : {},
      );
    } catch {
      setPins({});
    }
  }, [projectId]);
  const savePins = (next: Record<string, { x: number; y: number }>) => {
    setPins(next);
    try {
      window.localStorage.setItem(posKey(projectId), JSON.stringify(next));
    } catch {
      /* positions stay session-local */
    }
  };

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(done);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const doSearch = () => {
    if (!query.trim()) return;
    void run(
      async () => setHits((await window.office.searchMemory({ projectId, text: query.trim(), limit: 10 })).findings),
      'Search complete.',
    );
  };
  const settle = (relationshipId: string, status: 'CONFIRMED' | 'REFUTED') =>
    void run(
      () =>
        window.office.command({
          type: 'memory.relationship.settle',
          idempotencyKey: crypto.randomUUID(),
          relationshipId,
          status,
        }),
      `Link ${status.toLowerCase()}.`,
    );
  // Bulk settle loops the existing per-link command — append-only, no batch record exists.
  const bulkSettle = async (status: 'CONFIRMED' | 'REFUTED') => {
    const targets = memorySettleTargets(graph?.edges ?? [], compareIds);
    setBulkAsk('');
    setBusy('bulk');
    setError('');
    setNotice('');
    let done = 0,
      failed = 0;
    for (const edge of targets) {
      try {
        await window.office.command({
          type: 'memory.relationship.settle',
          idempotencyKey: crypto.randomUUID(),
          relationshipId: edge.relationshipId,
          status,
        });
        done++;
      } catch {
        failed++;
      }
    }
    setBusy('');
    const verb = status === 'CONFIRMED' ? 'confirmed' : 'refuted';
    if (failed && done) setNotice(`${done} ${verb} · ${failed} failed — see History`);
    else if (failed) setError(`${failed} proposed link${failed === 1 ? '' : 's'} could not be ${verb} — see History`);
    else setNotice(`${done} proposed link${done === 1 ? '' : 's'} ${verb}.`);
  };
  const supersedeSelected = () => {
    const id = [...compareIds][0];
    if (!id) return;
    setCSupersedes(id);
    setComposerOpen(true);
    setTimeout(() => composerRef.current?.scrollIntoView({ block: 'start' }), 0);
  };
  const proposeLink = () =>
    void run(async () => {
      await window.office.command({
        type: 'memory.relationship.propose',
        idempotencyKey: crypto.randomUUID(),
        projectId,
        fromFindingId: selectedNode,
        toFindingId: linkTarget,
        kind: linkKind,
        ...(linkNote.trim() ? { note: linkNote.trim() } : {}),
      });
      setLinkTarget('');
      setLinkNote('');
    }, 'Link proposed — it renders dashed until confirmed or refuted.');
  const findingCreated = new Map(projectFindings.map(f => [f.id, f.createdAt]));
  const focusNode = (id: string) => {
    setSelectedNode(id);
    setSelectedEdge('');
    // A search hit whose kind is filtered out would otherwise focus an invisible node.
    const kind = graph?.nodes.find(n => n.findingId === id)?.kind;
    if (kind)
      setHiddenKinds(current => {
        if (!current.has(kind)) return current;
        const next = new Set(current);
        next.delete(kind);
        return next;
      });
    // Same for the window: focusing a finding outside it widens the display filter.
    if (!memoryInWindow([{ findingId: id }], i => findingCreated.get(i), windowSel).has(id)) setWindowSel('all');
    setLocalOnly(false);
    setFocus(f => ({ id, n: (f?.n ?? 0) + 1 }));
  };
  const post = () =>
    void run(async () => {
      const evidenceRefs: FindingEvidenceRef[] = cRefs.map(entry => {
        const [kind, id] = entry.split('|');
        return { kind: kind as FindingEvidenceRef['kind'], id };
      });
      await window.office.command({
        type: 'memory.finding.note',
        idempotencyKey: crypto.randomUUID(),
        projectId,
        requestId: cRequest || null,
        kind: cKind,
        title: cTitle,
        body: cBody,
        ...(evidenceRefs.length ? { evidenceRefs } : {}),
        ...(cSupersedes ? { supersedesFindingId: cSupersedes } : {}),
      });
      setCTitle('');
      setCBody('');
      setCRequest('');
      setCRefs([]);
      setCSupersedes('');
    }, 'Finding recorded.');

  const titleOf = (id: string) => graph?.nodes.find(n => n.findingId === id)?.title ?? `${id.slice(0, 8)}…`;
  const refLabel = (ref: FindingEvidenceRef) => {
    if (ref.kind === 'REQUEST') {
      const r = state.requests?.find(item => item.id === ref.id);
      return `Request · ${r?.name ?? `${ref.id.slice(0, 8)}…`}`;
    }
    if (ref.kind === 'ASSIGNMENT') {
      const a = state.assignments?.find(item => item.id === ref.id);
      return `Assignment · ${a?.pipelineKey ?? `${ref.id.slice(0, 8)}…`}`;
    }
    if (ref.kind === 'JOB') {
      const j = state.jobs?.find(item => item.id === ref.id);
      return `Job · ${ref.id.slice(0, 8)}…${j ? ` · ${j.state.toLowerCase().replaceAll('_', ' ')}` : ''}`;
    }
    if (ref.kind === 'FINDING') {
      const f = projectFindings.find(item => item.id === ref.id);
      return `Finding · ${f?.title ?? `${ref.id.slice(0, 8)}…`}`;
    }
    const art = state.artifacts.find(item => item.sha256 === ref.id);
    return `Artifact · ${art ? `${art.name} · ` : ''}${shortHash(ref.id)}`;
  };

  // ---- what the brain shows ---------------------------------------------------------------
  const allEdges = graph?.edges ?? [];
  // Dot size reflects every recorded non-refuted link, even ones a filter currently hides.
  const degrees = useMemo(() => memoryDegrees(allEdges), [allEdges]);
  const kindCounts = useMemo(() => {
    const counts: Partial<Record<FindingKind, number>> = {};
    for (const n of graph?.nodes ?? []) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
    return counts;
  }, [graph]);
  const presentKinds = KINDS.filter(kind => (kindCounts[kind] ?? 0) > 0);
  // Window + kind + local filters are display cuts over loaded graph data — records never change.
  const inWindow = memoryInWindow(graph?.nodes ?? [], id => findingCreated.get(id), windowSel);
  const local = localOnly && selectedNode ? memoryNeighborhood(selectedNode, allEdges, localDepth) : null;
  const eligible = (graph?.nodes ?? []).filter(
    node =>
      inWindow.has(node.findingId) &&
      !hiddenKinds.has(node.kind) &&
      (orphans || (degrees[node.findingId] ?? 0) > 0 || node.findingId === selectedNode) &&
      (!local || local.has(node.findingId)),
  );
  const visibleNodes = useMemo(
    () => eligible.slice(0, MEMORY_NODE_LIMIT),
    [graph, hiddenKinds, windowSel, orphans, localOnly, selectedNode, localDepth],
  );
  const visibleIds = useMemo(() => new Set(visibleNodes.map(n => n.findingId)), [visibleNodes]);
  const eligibleEdges = allEdges.filter(
    edge => (edge.status !== 'REFUTED' || showRefuted) && visibleIds.has(edge.from) && visibleIds.has(edge.to),
  );
  const visibleEdges = useMemo(
    () => eligibleEdges.slice(0, MEMORY_EDGE_LIMIT),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, visibleIds, showRefuted],
  );
  const brainNodes = useMemo(
    () => visibleNodes.map(n => ({ id: n.findingId, kind: n.kind, title: n.title, superseded: n.superseded })),
    [visibleNodes],
  );
  const brainEdges = useMemo(
    () => visibleEdges.map(e => ({ id: e.relationshipId, from: e.from, to: e.to, kind: e.kind, status: e.status })),
    [visibleEdges],
  );
  const highlight = useMemo(() => {
    const needle = listQuery.trim().toLowerCase();
    if (!needle) return null;
    return new Set((graph?.nodes ?? []).filter(n => n.title.toLowerCase().includes(needle)).map(n => n.findingId));
  }, [graph, listQuery]);
  const refutedCount = allEdges.filter(edge => edge.status === 'REFUTED').length;
  const selNode = graph?.nodes.find(n => n.findingId === selectedNode);
  const selFinding = projectFindings.find(f => f.id === selectedNode);
  const selEdge = graph?.edges.find(e => e.relationshipId === selectedEdge);
  const selRel = relationships.find(r => r.id === selectedEdge);
  const hasDetail = !!selNode || !!selEdge;
  // Proposed links touching the selection drive the bulk-settle affordances in the tray.
  const settleTargets = memorySettleTargets(graph?.edges ?? [], compareIds);
  const onlySelected = compareIds.size === 1 ? graph?.nodes.find(n => n.findingId === [...compareIds][0]) : undefined;
  const canSupersede = !!onlySelected && !onlySelected.superseded;
  const refOptions = [
    ...projectRequests.map(item => ({ value: `REQUEST|${item.id}`, text: `Request · ${item.name}` })),
    ...(state.assignments ?? [])
      .filter(item => item.projectId === projectId)
      .map(item => ({
        value: `ASSIGNMENT|${item.id}`,
        text: `Assignment · ${item.pipelineKey ?? `${(state.agents.find(agent => agent.id === item.agentId)?.role ?? 'agent').toLowerCase()} ${item.id.slice(0, 8)}`}`,
      })),
    ...(state.jobs ?? [])
      .filter(item => item.projectId === projectId)
      .map(item => ({
        value: `JOB|${item.id}`,
        text: `Job · ${item.state.toLowerCase().replaceAll('_', ' ')} · ${item.id.slice(0, 8)}`,
      })),
    ...projectArtifacts.map(item => ({
      value: `OBJECT|${item.sha256}`,
      text: `Artifact · ${item.name} · ${shortHash(item.sha256)}`,
    })),
    ...projectFindings.map(item => ({
      value: `FINDING|${item.id}`,
      text: `Finding · ${item.title}${item.supersededById ? ' (superseded)' : ''}`,
    })),
  ];
  const toggleKind = (kind: FindingKind) =>
    setHiddenKinds(current => {
      const next = new Set(current);
      if (current.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  const toggleCompare = (id: string) =>
    setCompareIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const stageClass = `memory-stage${listOpen ? ' with-list' : ''}${hasDetail ? ' has-detail' : ''}`;

  return (
    <section className="memory-page">
      <form
        className="memory-search section-toolbar"
        onSubmit={e => {
          e.preventDefault();
          void doSearch();
        }}
      >
        <SearchField value={query} onChange={setQuery} placeholder="Search findings" />
        <button className="secondary" disabled={!!busy || !query.trim()}>
          {busy === 'Search complete.' ? 'Searching…' : 'Search'}
        </button>
      </form>
      {hits &&
        (hits.length ? (
          <div className="task-list memory-hits">
            {hits.map(hit => (
              <article className="task-card memory-hit" key={hit.id}>
                <div className="card-heading">
                  <h3>{hit.title}</h3>
                  <span>
                    <span className="quiet-badge small">{label(hit.kind)}</span>
                    {hit.supersededById && <span className="quiet-badge small superseded-badge">superseded</span>}
                  </span>
                </div>
                <p className="task-prompt">{hit.body}</p>
                <p className="muted">
                  {authorLine(hit.createdBy)} · {stamp(hit.createdAt)}
                </p>
                <div className="button-row">
                  <button className="text-button" onClick={() => focusNode(hit.id)}>
                    Show on graph
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">No findings match that search.</p>
        ))}
      {!graph && !error && <p className="muted">Loading memory…</p>}
      {graph && !graph.nodes.length && (
        <Empty
          icon={Network}
          title="Nothing recorded yet"
          description="Findings recorded by sessions or by you appear here as an explorable graph. Record the first one below."
        />
      )}
      {!!graph?.nodes.length && (
        <div className={`memory-layout ${stageClass}`}>
          {listOpen && (
            <aside className="memory-list" aria-label="Findings">
              <h3>
                Findings <span className="muted">{graph?.nodes.length}</span>
              </h3>
              <SearchField value={listQuery} onChange={setListQuery} placeholder="Filter finding titles" />
              {(graph?.nodes ?? [])
                .filter(n => n.title.toLowerCase().includes(listQuery.toLowerCase()))
                .map(node => (
                  <button
                    key={node.findingId}
                    className={`memory-list-row${selectedNode === node.findingId ? ' selected' : ''}`}
                    aria-pressed={selectedNode === node.findingId}
                    onClick={() => focusNode(node.findingId)}
                  >
                    <span className={`memory-kind kind-${node.kind.toLowerCase()}`}>{label(node.kind)}</span>
                    <strong>{node.title}</strong>
                    {node.superseded && <small>Superseded</small>}
                  </button>
                ))}
            </aside>
          )}
          <div className="brain-frame">
            <MemoryBrain
              nodes={brainNodes}
              edges={brainEdges}
              degrees={degrees}
              selectedNode={selectedNode}
              selectedEdge={selectedEdge}
              compare={compareIds}
              pins={pins}
              names={names}
              arrows={arrows}
              nodeScale={nodeScale}
              linkWidth={linkWidth}
              textFade={textFade}
              forces={forces}
              animate={animate}
              reducedMotion={reducedMotion}
              highlight={highlight}
              insetRight={hasDetail ? 354 : 0}
              fitSignal={fitSignal}
              resetSignal={resetSignal}
              focus={focus}
              onSelectNode={id => {
                setSelectedNode(id);
                setSelectedEdge('');
              }}
              onSelectEdge={id => {
                setSelectedEdge(id);
                setSelectedNode('');
              }}
              onClear={() => {
                setSelectedNode('');
                setSelectedEdge('');
              }}
              onToggleCompare={toggleCompare}
              onPin={(id, x, y) => savePins({ ...pins, [id]: { x, y } })}
              onUnpin={id => {
                const { [id]: _removed, ...rest } = pins;
                savePins(rest);
              }}
            />
            <div className="brain-kinds" role="group" aria-label="Finding kinds">
              {presentKinds.map(kind => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={!hiddenKinds.has(kind)}
                  className={`memory-kind kind-${kind.toLowerCase()}${hiddenKinds.has(kind) ? ' off' : ''}`}
                  onClick={() => toggleKind(kind)}
                >
                  <span className="mem-legend-dot" aria-hidden="true" />
                  {label(kind)}
                  <small>{kindCounts[kind]}</small>
                </button>
              ))}
            </div>
            <div className="brain-toolbar" role="toolbar" aria-label="Graph controls">
              <button
                type="button"
                className={`brain-tool${listOpen ? ' on' : ''}`}
                aria-pressed={listOpen}
                aria-label="Findings list"
                title="Findings list"
                onClick={() => setListOpen(!listOpen)}
              >
                <PanelLeft size={15} />
              </button>
              <button
                type="button"
                className={`brain-tool wide${names ? ' on' : ''}`}
                aria-pressed={names}
                aria-label="Names"
                title={names ? 'Hide names on the graph (hover still shows one)' : 'Show names on the graph'}
                onClick={() => setNames(!names)}
              >
                <Tag size={15} />
                <span>Names</span>
              </button>
              <button
                type="button"
                className="brain-tool wide"
                aria-label="Fit graph"
                title="Fit graph"
                onClick={() => setFitSignal(n => n + 1)}
              >
                <LocateFixed size={15} />
                <span>Fit graph</span>
              </button>
              <button
                type="button"
                className="brain-tool"
                aria-label="Reset layout"
                title="Reset layout (also releases pinned findings)"
                onClick={() => {
                  savePins({});
                  try {
                    window.localStorage.removeItem(posKey(projectId));
                  } catch {
                    /* session-local */
                  }
                  setResetSignal(n => n + 1);
                }}
              >
                <RotateCcw size={15} />
              </button>
              <button
                type="button"
                className={`brain-tool wide${localOnly ? ' on' : ''}`}
                aria-pressed={localOnly}
                aria-label="Local graph"
                disabled={!selectedNode}
                title="Show only the selected finding and what it links to"
                onClick={() => setLocalOnly(v => !v)}
              >
                <Network size={15} />
                <span>Local graph</span>
              </button>
              <button
                type="button"
                className={`brain-tool${animate ? '' : ' on'}`}
                aria-pressed={!animate}
                aria-label={animate ? 'Pause physics' : 'Resume physics'}
                title={animate ? 'Pause the layout physics' : 'Resume the layout physics'}
                onClick={() => setAnimate(!animate)}
              >
                {animate ? <Pause size={15} /> : <Play size={15} />}
              </button>
              <button
                type="button"
                className={`brain-tool${panelOpen ? ' on' : ''}`}
                aria-pressed={panelOpen}
                aria-label="Graph settings"
                title="Graph settings"
                onClick={() => setPanelOpen(!panelOpen)}
              >
                <SlidersHorizontal size={15} />
              </button>
            </div>
            {panelOpen && (
              <div className="brain-panel" role="group" aria-label="Graph settings">
                <details open>
                  <summary>Filters</summary>
                  <div className="brain-chips" role="group" aria-label="Graph window — display filter only">
                    <span className="muted">Window · display only</span>
                    {MEMORY_WINDOWS.map(w => (
                      <button
                        key={w.id}
                        type="button"
                        aria-pressed={windowSel === w.id}
                        className={`memory-window-chip${windowSel === w.id ? ' on' : ''}`}
                        onClick={() => setWindowSel(w.id)}
                      >
                        {w.label}
                      </button>
                    ))}
                  </div>
                  <Toggle on={showRefuted} onChange={setShowRefuted}>
                    Show refuted links
                  </Toggle>
                  <Toggle on={orphans} onChange={setOrphans}>
                    Show unlinked findings
                  </Toggle>
                  <Slider
                    name="Local graph depth"
                    value={localDepth}
                    min={1}
                    max={3}
                    step={1}
                    onChange={setLocalDepth}
                  />
                </details>
                <details open>
                  <summary>Display</summary>
                  <Toggle on={names} onChange={setNames}>
                    Show names
                  </Toggle>
                  <Toggle on={arrows} onChange={setArrows}>
                    Show arrows
                  </Toggle>
                  <Slider
                    name="Text fade threshold"
                    value={textFade}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={setTextFade}
                  />
                  <Slider name="Node size" value={nodeScale} min={0.6} max={2.2} step={0.1} onChange={setNodeScale} />
                  <Slider
                    name="Link thickness"
                    value={linkWidth}
                    min={0.5}
                    max={3}
                    step={0.25}
                    onChange={setLinkWidth}
                  />
                </details>
                <details>
                  <summary>Forces</summary>
                  <Slider name="Center force" value={center} min={0} max={1} step={0.05} onChange={setCenter} />
                  <Slider name="Repel force" value={repel} min={0} max={1} step={0.05} onChange={setRepel} />
                  <Slider
                    name="Link force"
                    value={linkStrength}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={setLinkStrength}
                  />
                  <Slider
                    name="Link distance"
                    value={linkDistance}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={setLinkDistance}
                  />
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setCenter(DEFAULT_FORCES.center);
                      setRepel(DEFAULT_FORCES.repel);
                      setLinkStrength(DEFAULT_FORCES.linkStrength);
                      setLinkDistance(DEFAULT_FORCES.linkDistance);
                    }}
                  >
                    Reset forces
                  </button>
                </details>
              </div>
            )}
            <div className="brain-legend" aria-hidden="true">
              <span className="mem-legend-item">
                <svg viewBox="0 0 26 10" width="26" height="10">
                  <line className="legend-line confirmed" x1="1" y1="5" x2="25" y2="5" />
                </svg>
                confirmed
              </span>
              <span className="mem-legend-item">
                <svg viewBox="0 0 26 10" width="26" height="10">
                  <line className="legend-line proposed" x1="1" y1="5" x2="25" y2="5" />
                </svg>
                proposed
              </span>
              <span className="mem-legend-item">
                <svg viewBox="0 0 26 10" width="26" height="10">
                  <line className="legend-line refuted" x1="1" y1="5" x2="25" y2="5" />
                </svg>
                refuted
              </span>
              <span className="mem-legend-item">
                <svg className="legend-mark" viewBox="0 0 12 12" width="12" height="12">
                  <circle className="legend-dot superseded" cx="6" cy="6" r="4" />
                </svg>
                superseded
              </span>
            </div>
            <p className="brain-hint">
              {brainNodes.length} finding{brainNodes.length === 1 ? '' : 's'} · {brainEdges.length} link
              {brainEdges.length === 1 ? '' : 's'} · drag to pan · scroll to zoom · drag a finding to pin it ·
              double-click a pinned one to release it
              {eligible.length > MEMORY_NODE_LIMIT || eligibleEdges.length > MEMORY_EDGE_LIMIT
                ? ` · Bounded view: at most ${MEMORY_NODE_LIMIT} findings / ${MEMORY_EDGE_LIMIT} links`
                : ''}
              {refutedCount
                ? ` · ${refutedCount} refuted link${refutedCount === 1 ? '' : 's'} ${showRefuted ? 'shown' : 'hidden'}`
                : ''}
              {graph && graph.nodes.length > 1 && !graph.edges.length
                ? ' · No links yet: lines appear only for links agents report or you add (select a finding, then Link to…)'
                : ''}
            </p>
            {!brainNodes.length && (
              <p className="mem-empty" role="status">
                {windowSel !== 'all'
                  ? 'No findings in this window — display filter only; records are unchanged.'
                  : 'All finding kinds are filtered out.'}
              </p>
            )}
            {hasDetail && (
              <aside className="memory-detail" aria-label="Finding details">
                <button
                  type="button"
                  className="brain-close"
                  aria-label="Close details"
                  title="Close details"
                  onClick={() => {
                    setSelectedNode('');
                    setSelectedEdge('');
                  }}
                >
                  <X size={14} />
                </button>
                {selNode && (
                  <div className="memory-detail-card">
                    <div className="card-heading">
                      <h3>{selNode.title}</h3>
                      <span>
                        <span className="quiet-badge small">{label(selNode.kind)}</span>
                        {selNode.superseded && <span className="quiet-badge small superseded-badge">superseded</span>}
                      </span>
                    </div>
                    {selFinding ? (
                      <>
                        <p className="memory-body">{selFinding.body}</p>
                        <p className="muted">
                          {authorLine(selFinding.createdBy)} · {stamp(selFinding.createdAt)}
                        </p>
                        {!!selFinding.evidenceRefs.length && (
                          <ul className="evidence-list">
                            {selFinding.evidenceRefs.map(ref => (
                              <li key={ref.kind + ref.id}>{refLabel(ref)}</li>
                            ))}
                          </ul>
                        )}
                        {selFinding.supersededById && (
                          <p className="muted">
                            Superseded by{' '}
                            <button className="text-button" onClick={() => focusNode(selFinding.supersededById!)}>
                              {projectFindings.find(f => f.id === selFinding.supersededById)?.title ??
                                'a later finding'}
                            </button>
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="muted">The finding record is not in the current workspace state.</p>
                    )}
                    <div className="memory-connections">
                      <h4>Links &amp; backlinks</h4>
                      {(graph?.edges ?? [])
                        .filter(e => e.from === selectedNode || e.to === selectedNode)
                        .map(e => (
                          <button
                            className="memory-list-row"
                            key={e.relationshipId}
                            onClick={() => {
                              setSelectedEdge(e.relationshipId);
                              setSelectedNode('');
                            }}
                          >
                            <strong>
                              {e.to === selectedNode ? '←' : '→'} {titleOf(e.to === selectedNode ? e.from : e.to)}
                            </strong>
                            <small>
                              {label(e.kind)} · {label(e.status)}
                            </small>
                          </button>
                        ))}
                      {!(graph?.edges ?? []).some(e => e.from === selectedNode || e.to === selectedNode) && (
                        <p className="muted">No recorded links yet.</p>
                      )}
                    </div>
                    <details className="memory-link">
                      <summary>Link to…</summary>
                      <label className="field">
                        Target
                        <select value={linkTarget} onChange={e => setLinkTarget(e.target.value)}>
                          <option value="">Pick a finding…</option>
                          {projectFindings
                            .filter(item => item.id !== selectedNode)
                            .map(item => (
                              <option key={item.id} value={item.id}>
                                {item.title}
                                {item.supersededById ? ' (superseded)' : ''}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className="field">
                        Kind
                        <select value={linkKind} onChange={e => setLinkKind(e.target.value as RelationshipKind)}>
                          {REL_KINDS.map(kind => (
                            <option key={kind} value={kind}>
                              {label(kind)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        Note (optional)
                        <input
                          value={linkNote}
                          onChange={e => setLinkNote(e.target.value)}
                          maxLength={1000}
                          placeholder="Why these relate"
                        />
                      </label>
                      <button type="button" className="primary" disabled={!!busy || !linkTarget} onClick={proposeLink}>
                        Propose link
                      </button>
                    </details>
                  </div>
                )}
                {selEdge && (
                  <div className="memory-detail-card">
                    <div className="card-heading">
                      <h3>
                        {titleOf(selEdge.from)} → {titleOf(selEdge.to)}
                      </h3>
                      <span>
                        <span className="quiet-badge small">{label(selEdge.kind)}</span>
                        <span className="quiet-badge small">{label(selEdge.status)}</span>
                      </span>
                    </div>
                    {selRel ? (
                      <>
                        {selRel.note && <p className="memory-body">{selRel.note}</p>}
                        <p className="muted">
                          {authorLine(selRel.createdBy)} · {stamp(selRel.createdAt)}
                          {selRel.decidedAt ? ` · settled ${stamp(selRel.decidedAt)}` : ''}
                        </p>
                      </>
                    ) : (
                      <p className="muted">The link record is not in the current workspace state.</p>
                    )}
                    {selEdge.status === 'PROPOSED' && (
                      <>
                        <p className="muted">A proposed link is unconfirmed — settle it to record the user's call.</p>
                        <div className="button-row">
                          <button
                            className="primary"
                            disabled={!!busy}
                            onClick={() => settle(selEdge.relationshipId, 'CONFIRMED')}
                          >
                            Confirm link
                          </button>
                          <button
                            className="cancel-request"
                            disabled={!!busy}
                            onClick={() => settle(selEdge.relationshipId, 'REFUTED')}
                          >
                            Refute link
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </aside>
            )}
          </div>
        </div>
      )}
      {!!compareIds.size && (
        <div className="memory-tray" role="group" aria-label="Selected findings">
          <span className="muted">{compareIds.size} selected</span>
          {[...compareIds].map(id => {
            const node = graph?.nodes.find(n => n.findingId === id);
            if (!node) return null;
            return (
              <button
                key={id}
                type="button"
                className="memory-tray-item"
                onClick={() => focusNode(id)}
                title={node.title}
              >
                <span className={`mem-legend-dot kind-${node.kind.toLowerCase()}`} aria-hidden="true" />
                <span className="memory-tray-title">{node.title}</span>
                <small className="muted">{node.superseded ? 'Superseded' : 'Recorded'}</small>
              </button>
            );
          })}
          {canSupersede && (
            <button type="button" className="secondary" onClick={supersedeSelected}>
              Supersede…
            </button>
          )}
          {!!settleTargets.length && !bulkAsk && (
            <>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => setBulkAsk('CONFIRMED')}>
                Confirm {settleTargets.length} proposed
              </button>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => setBulkAsk('REFUTED')}>
                Refute {settleTargets.length} proposed
              </button>
            </>
          )}
          {bulkAsk && !!settleTargets.length && (
            <span
              className="memory-bulk-ask"
              role="alertdialog"
              aria-label={`${bulkAsk === 'CONFIRMED' ? 'Confirm' : 'Refute'} proposed links`}
            >
              {bulkAsk === 'CONFIRMED' ? 'Confirm' : 'Refute'} {settleTargets.length} proposed link
              {settleTargets.length === 1 ? '' : 's'} touching the selection? Each records its own settlement — nothing
              is edited or deleted.
              <button type="button" className="primary" disabled={!!busy} onClick={() => void bulkSettle(bulkAsk)}>
                {bulkAsk === 'CONFIRMED' ? 'Yes, confirm' : 'Yes, refute'}
              </button>
              <button type="button" className="secondary" disabled={!!busy} onClick={() => setBulkAsk('')}>
                Cancel
              </button>
            </span>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setCompareIds(new Set());
              setBulkAsk('');
            }}
          >
            Clear
          </button>
        </div>
      )}
      <details
        ref={composerRef}
        className="memory-composer"
        open={composerOpen}
        onToggle={e => setComposerOpen(e.currentTarget.open)}
      >
        <summary>New finding</summary>
        <form
          onSubmit={e => {
            e.preventDefault();
            post();
          }}
        >
          {cSupersedes && (
            <p className="muted memory-supersede-note">
              Recording a correction for “
              {projectFindings.find(f => f.id === cSupersedes)?.title ?? 'the selected finding'}”. Findings cannot be
              edited or deleted — the original stays on record and this new finding supersedes it.
            </p>
          )}
          <label className="field">
            Kind
            <select value={cKind} onChange={e => setCKind(e.target.value as FindingKind)}>
              {KINDS.map(kind => (
                <option key={kind} value={kind}>
                  {label(kind)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Title
            <input
              value={cTitle}
              onChange={e => setCTitle(e.target.value)}
              maxLength={160}
              required
              placeholder="One-line claim"
            />
          </label>
          <label className="field">
            Body
            <textarea
              value={cBody}
              onChange={e => setCBody(e.target.value)}
              maxLength={4000}
              required
              placeholder="The finding itself — bounded, never a transcript dump"
            />
          </label>
          <label className="field">
            Request (optional)
            <select value={cRequest} onChange={e => setCRequest(e.target.value)}>
              <option value="">Not tied to a request</option>
              {projectRequests.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {!!refOptions.length && (
            <label className="field">
              Evidence (optional)
              <select multiple value={cRefs} onChange={e => setCRefs([...e.target.selectedOptions].map(o => o.value))}>
                {refOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.text}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!!liveFindings.length && (
            <label className="field">
              Supersedes (optional)
              <select value={cSupersedes} onChange={e => setCSupersedes(e.target.value)}>
                <option value="">A new finding, not a correction</option>
                {liveFindings.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="primary" disabled={!!busy || !cTitle.trim() || !cBody.trim()}>
            Record finding
          </button>
        </form>
      </details>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
