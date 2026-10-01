import type React from 'react';
import { useEffect, useMemo, useRef } from 'react';
import type { FindingKind, RelationshipKind, RelationshipStatus } from '../shared/types';
import { BrainSim, brainLabels, fitBounds, type BrainForces } from './brain-sim';

export interface BrainNodeView {
  id: string;
  kind: FindingKind;
  title: string;
  superseded: boolean;
}
export interface BrainEdgeView {
  id: string;
  from: string;
  to: string;
  kind: RelationshipKind;
  status: RelationshipStatus;
}
export interface BrainProps {
  nodes: readonly BrainNodeView[];
  edges: readonly BrainEdgeView[];
  degrees: Readonly<Record<string, number>>;
  selectedNode: string;
  selectedEdge: string;
  compare: ReadonlySet<string>;
  pins: Readonly<Record<string, { x: number; y: number }>>;
  names: boolean;
  arrows: boolean;
  nodeScale: number;
  linkWidth: number;
  textFade: number;
  forces: BrainForces;
  animate: boolean;
  reducedMotion: boolean;
  /** Pixels at the right edge covered by the detail card, so fitting and focusing centre in what is visible. */
  insetRight?: number;
  /** Findings that match the search box: they stay lit and the rest dim, like neurons lighting up. */
  highlight: ReadonlySet<string> | null;
  /** Bumped to ask for a refit / a fresh layout / a camera move to a finding. */
  fitSignal: number;
  resetSignal: number;
  focus: { id: string; n: number } | null;
  onSelectNode(id: string): void;
  onSelectEdge(id: string): void;
  onClear(): void;
  onToggleCompare(id: string): void;
  onPin(id: string, x: number, y: number): void;
  onUnpin(id: string): void;
}

interface Palette {
  kinds: Record<FindingKind, string>;
  edge: string;
  confirmed: string;
  proposed: string;
  refuted: string;
  accent: string;
  text: string;
  halo: string;
  bg: string;
}
const KIND_VARS: Record<FindingKind, string> = {
  OBSERVATION: '--brain-observation',
  HYPOTHESIS: '--brain-hypothesis',
  RESULT: '--brain-result',
  DEFECT: '--brain-defect',
  DECISION: '--brain-decision',
  NOTE: '--brain-note',
};
function readPalette(el: HTMLElement): Palette {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    kinds: Object.fromEntries(
      (Object.keys(KIND_VARS) as FindingKind[]).map(kind => [kind, v(KIND_VARS[kind], '#8794a3')]),
    ) as Record<FindingKind, string>,
    edge: v('--brain-edge', '#8794a3'),
    confirmed: v('--brain-confirmed', '#b9c4cf'),
    proposed: v('--brain-proposed', '#8794a3'),
    refuted: v('--brain-refuted', '#ef7a6a'),
    accent: v('--brain-accent', '#e4b97b'),
    text: v('--brain-text', '#efe9de'),
    halo: v('--brain-halo', '#14100d'),
    bg: v('--brain-bg', '#1a1511'),
  };
}

const MIN_K = 0.03;
const MAX_K = 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The memory brain, drawn on a canvas. Obsidian-style: a live force layout in a round cloud, dots
 * sized by link count, colour by finding kind, hover dims everything but a finding and its
 * neighbours, names fade with zoom (or are switched off). Only a person's own drags are stored
 * (by the caller); every computed position is derived afresh from the records.
 */
export function MemoryBrain(props: BrainProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const sim = useRef(new BrainSim());
  const live = useRef(props);
  live.current = props;
  const cam = useRef({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 800, h: 560, dpr: 1 });
  const palette = useRef<Palette | null>(null);
  const hover = useRef('');
  const raf = useRef(0);
  const pulse = useRef(0);
  const remembered = useRef(new Map<string, { x: number; y: number }>());
  const drag = useRef<{
    kind: 'pan' | 'node';
    id: string;
    x: number;
    y: number;
    moved: boolean;
    ox: number;
    oy: number;
  } | null>(null);
  const tween = useRef<{
    t: number;
    from: { x: number; y: number; k: number };
    to: { x: number; y: number; k: number };
  } | null>(null);
  const fitted = useRef(false);
  const widths = useRef(new Map<string, number>());
  const byId = useMemo(() => new Map(props.nodes.map(n => [n.id, n])), [props.nodes]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const edgesRef = useRef(props.edges);
  edgesRef.current = props.edges;

  const wake = () => {
    if (!raf.current) raf.current = requestAnimationFrame(frame);
  };

  /** The part of the canvas not covered by the detail card: where the picture should be centred. */
  const usable = () => {
    const { w, h } = size.current;
    return { w: Math.max(240, w - (live.current.insetRight ?? 0)), h };
  };
  const ensureFit = (animate: boolean) => {
    const { w, h } = usable();
    const target = fitBounds(sim.current.bounds(0.03), w, h, 56);
    if (animate && !live.current.reducedMotion) tween.current = { t: 0, from: { ...cam.current }, to: target };
    else cam.current = target;
    wake();
  };

  // ---- data into the simulation ------------------------------------------------------------
  const dataKey = useMemo(
    () =>
      JSON.stringify([
        props.nodes.map(n => [n.id, props.degrees[n.id] ?? 0]),
        props.edges.map(e => [e.from, e.to]),
        props.pins,
      ]),
    [props.nodes, props.edges, props.degrees, props.pins],
  );
  useEffect(() => {
    const s = sim.current;
    for (const n of s.nodes) remembered.current.set(n.id, { x: n.x, y: n.y });
    const first = s.nodes.length === 0;
    s.setNodeScale(live.current.nodeScale);
    s.setData(
      live.current.nodes.map(n => ({ id: n.id, degree: live.current.degrees[n.id] ?? 0 })),
      live.current.edges.filter(e => e.status !== 'REFUTED').map(e => ({ from: e.from, to: e.to })),
      live.current.pins,
      remembered.current,
    );
    if (first || !fitted.current) {
      // Warm up before the first paint so the cloud arrives formed, not as a scatter.
      s.settle(live.current.reducedMotion ? 400 : 70, live.current.reducedMotion ? 400 : 120);
      ensureFit(false);
      fitted.current = s.nodes.length > 0;
    } else relax();
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey]);

  // With reduced motion nothing animates: a change settles synchronously and draws once.
  const relax = () => {
    if (live.current.reducedMotion) sim.current.settle(400, 200);
  };
  useEffect(() => {
    sim.current.forces = props.forces;
    sim.current.reheat(0.45);
    relax();
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.forces]);
  useEffect(() => {
    sim.current.setNodeScale(props.nodeScale);
    sim.current.reheat(0.3);
    relax();
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nodeScale]);
  useEffect(() => {
    if (props.resetSignal === 0) return;
    sim.current.restart(live.current.pins);
    sim.current.settle(live.current.reducedMotion ? 400 : 70, 150);
    ensureFit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.resetSignal]);
  useEffect(() => {
    if (props.fitSignal === 0) return;
    ensureFit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitSignal]);
  useEffect(() => {
    const f = props.focus;
    if (!f) return;
    const s = sim.current;
    const node = s.nodes[s.indexOf(f.id)];
    if (!node) return;
    const { w, h } = usable();
    const k = clamp(Math.max(cam.current.k, 1.1), MIN_K, MAX_K);
    const to = { k, x: w / 2 - node.x * k, y: h / 2 - node.y * k };
    if (live.current.reducedMotion) cam.current = to;
    else tween.current = { t: 0, from: { ...cam.current }, to };
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus]);
  useEffect(() => {
    pulse.current = 0;
    wake();
  }, [
    props.selectedNode,
    props.selectedEdge,
    props.compare,
    props.names,
    props.arrows,
    props.linkWidth,
    props.textFade,
    props.animate,
  ]);

  // ---- canvas size, palette, teardown ------------------------------------------------------
  useEffect(() => {
    const el = wrap.current,
      cv = canvas.current;
    if (!el || !cv) return;
    const resize = () => {
      const rect = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width)),
        h = Math.max(1, Math.round(rect.height));
      const before = size.current;
      cam.current.x += (w - before.w) / 2;
      cam.current.y += (h - before.h) / 2;
      size.current = { w, h, dpr };
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      palette.current = readPalette(el);
      wake();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    const theme = new MutationObserver(() => {
      palette.current = readPalette(el);
      wake();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect();
      theme.disconnect();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- the frame ---------------------------------------------------------------------------
  function frame(time: number) {
    raf.current = 0;
    const cv = canvas.current;
    const pal = palette.current;
    if (!cv || !pal) return;
    const p = live.current;
    const s = sim.current;
    let active = false;
    if (tween.current) {
      tween.current.t = Math.min(1, tween.current.t + 0.07);
      const e = 1 - Math.pow(1 - tween.current.t, 3);
      const { from, to } = tween.current;
      cam.current = {
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        k: from.k + (to.k - from.k) * e,
      };
      if (tween.current.t >= 1) tween.current = null;
      active = true;
    }
    const dragging = drag.current?.kind === 'node' && drag.current.moved;
    if (dragging) s.alphaTarget = 0.3;
    else s.alphaTarget = 0;
    if ((p.animate || dragging) && (!s.settled || dragging) && !p.reducedMotion) {
      s.tick();
      s.tick();
      active = true;
    }
    pulse.current = Math.min(1, pulse.current + 0.03);
    draw(cv, pal, p, time);
    if (active || (!p.reducedMotion && pulse.current < 1)) wake();
  }

  function draw(cv: HTMLCanvasElement, pal: Palette, p: BrainProps, time: number) {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const { w, h, dpr } = size.current;
    const { x: cx, y: cy, k } = cam.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = sim.current;
    const nodes = s.nodes;
    const hov = hover.current;
    // The hovered (or selected) finding and its neighbours stay lit; failing that, the findings the
    // search matched. Everything else dims.
    const focusId = hov || p.selectedNode;
    let lit: Set<string> | null = null;
    if (focusId) {
      lit = new Set([focusId]);
      for (const l of s.links) {
        const a = nodes[l.source].id,
          b = nodes[l.target].id;
        if (a === focusId) lit.add(b);
        if (b === focusId) lit.add(a);
      }
    } else if (p.highlight) lit = new Set(p.highlight);
    const dim = lit ? 0.22 : 1;
    const isLit = (id: string) => !lit || lit.has(id);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    const lw = Math.max(0.5, p.linkWidth) / k;
    const pos = (id: string) => nodes[s.indexOf(id)];
    // Edges, batched by style.
    const groups: Record<string, BrainEdgeView[]> = { confirmed: [], proposed: [], refuted: [] };
    for (const e of p.edges) {
      const bucket = e.status === 'CONFIRMED' ? 'confirmed' : e.status === 'REFUTED' ? 'refuted' : 'proposed';
      groups[bucket].push(e);
    }
    const stroke = (
      list: BrainEdgeView[],
      color: string,
      alpha: number,
      dash: number[] | null,
      width: number,
      only?: (e: BrainEdgeView) => boolean,
    ) => {
      if (!list.length) return;
      ctx.beginPath();
      let any = false;
      for (const e of list) {
        if (only && !only(e)) continue;
        const a = pos(e.from),
          b = pos(e.to);
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        any = true;
      }
      if (!any) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash && list.length < 2500 && k > 0.35 ? dash.map(d => d / k) : []);
      ctx.stroke();
    };
    const incident = (e: BrainEdgeView) => e.from === focusId || e.to === focusId;
    const base = focusId ? 0.07 : lit ? 0.12 : 0.34;
    stroke(groups.confirmed, pal.confirmed, base * 1.5, null, lw, focusId ? e => !incident(e) : undefined);
    stroke(groups.proposed, pal.proposed, base, [5, 4], lw, focusId ? e => !incident(e) : undefined);
    stroke(groups.refuted, pal.refuted, base * 1.4, [2, 4], lw, focusId ? e => !incident(e) : undefined);
    if (focusId) {
      stroke(groups.confirmed, pal.accent, 0.9, null, lw * 1.6, incident);
      stroke(groups.proposed, pal.accent, 0.8, [5, 4], lw * 1.6, incident);
      stroke(groups.refuted, pal.refuted, 0.8, [2, 4], lw * 1.6, incident);
    }
    const selEdge = p.selectedEdge ? p.edges.find(e => e.id === p.selectedEdge) : undefined;
    if (selEdge) {
      const a = pos(selEdge.from),
        b = pos(selEdge.to);
      if (a && b) {
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = pal.accent;
        ctx.lineWidth = lw * 3;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    // Arrows: only where they are legible.
    if (p.arrows && k > 0.45) {
      ctx.fillStyle = pal.confirmed;
      for (const e of p.edges) {
        if (e.status === 'REFUTED') continue;
        const a = pos(e.from),
          b = pos(e.to);
        if (!a || !b) continue;
        const dx = b.x - a.x,
          dy = b.y - a.y,
          d = Math.hypot(dx, dy);
        if (d < a.r + b.r + 6) continue;
        const ux = dx / d,
          uy = dy / d;
        const tipX = b.x - ux * (b.r + 1),
          tipY = b.y - uy * (b.r + 1);
        const L = 6 / k,
          W = 3.2 / k;
        ctx.globalAlpha = focusId && !incident(e) ? 0.1 : lit && !focusId ? 0.2 : 0.75;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ux * L - uy * W, tipY - uy * L + ux * W);
        ctx.lineTo(tipX - ux * L + uy * W, tipY - uy * L - ux * W);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Nodes, batched by colour and lit state.
    const byKind = new Map<string, number[]>();
    const hollow: number[] = [];
    nodes.forEach((n, i) => {
      const view = byIdRef.current.get(n.id);
      if (!view) return;
      if (view.superseded) {
        hollow.push(i);
        return;
      }
      const key = `${pal.kinds[view.kind]}|${isLit(n.id) ? 1 : 0}`;
      (byKind.get(key) ?? byKind.set(key, []).get(key)!).push(i);
    });
    for (const [key, list] of byKind) {
      const [color, on] = key.split('|');
      ctx.globalAlpha = on === '1' ? 1 : dim;
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const i of list) {
        const n = nodes[i];
        ctx.moveTo(n.x + n.r, n.y);
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    // Superseded findings stay on the graph as hollow, dashed rings.
    if (hollow.length) {
      ctx.lineWidth = 1.4 / k;
      ctx.setLineDash([2.5 / k, 2.2 / k]);
      for (const i of hollow) {
        const n = nodes[i];
        const view = byIdRef.current.get(n.id)!;
        ctx.globalAlpha = (isLit(n.id) ? 0.85 : dim) * 0.8;
        ctx.strokeStyle = pal.kinds[view.kind];
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // Pinned findings carry a small anchor ring.
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = pal.text;
    ctx.lineWidth = 1 / k;
    for (const n of nodes)
      if (n.fx !== null && !(drag.current?.id === n.id && drag.current.moved)) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 2.2 / k, 0, Math.PI * 2);
        ctx.stroke();
      }
    // Selection (compare) rings and the selected halo.
    ctx.lineWidth = 2 / k;
    ctx.strokeStyle = pal.accent;
    ctx.globalAlpha = 1;
    for (const id of p.compare) {
      const n = pos(id);
      if (!n) continue;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 3.4 / k, 0, Math.PI * 2);
      ctx.stroke();
    }
    const sel = p.selectedNode ? pos(p.selectedNode) : undefined;
    if (sel) {
      const grow = p.reducedMotion ? 0 : Math.sin(Math.min(1, pulse.current) * Math.PI) * 5;
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = pal.accent;
      ctx.beginPath();
      ctx.arc(sel.x, sel.y, sel.r + (7 + grow) / k, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.4 / k;
      ctx.beginPath();
      ctx.arc(sel.x, sel.y, sel.r + 3 / k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // Names, in screen space so they stay crisp at every zoom.
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '600 11.5px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.lineJoin = 'round';
    const priority = new Set<string>();
    // Hovered / selected / compared findings are always named; their neighbours (or the search
    // matches) are named first among the rest, but never on top of each other.
    const preferred = new Set<string>();
    if (lit && (hov || p.selectedNode)) for (const id of lit) preferred.add(id);
    else if (lit && p.highlight) for (const id of lit) if (preferred.size < 80) preferred.add(id);
    if (hov) priority.add(hov);
    if (p.selectedNode) priority.add(p.selectedNode);
    for (const id of p.compare) priority.add(id);
    const names = p.names;
    const clipped = (title: string) => (title.length > 34 ? `${title.slice(0, 32)}…` : title);
    if (names || hov) {
      const items = nodes
        .map(n => {
          const view = byIdRef.current.get(n.id);
          if (!view) return null;
          const text = clipped(view.title);
          let width = widths.current.get(text);
          if (width === undefined) {
            width = ctx.measureText(text).width;
            widths.current.set(text, width);
          }
          return {
            id: n.id,
            x: n.x * k + cx,
            y: n.y * k + cy,
            r: n.r * k,
            degree: n.degree,
            width,
            text,
            superseded: view.superseded,
          };
        })
        .filter(Boolean) as {
        id: string;
        x: number;
        y: number;
        r: number;
        degree: number;
        width: number;
        text: string;
        superseded: boolean;
      }[];
      const forced = names ? priority : new Set(hov ? [hov] : []);
      const { shown, alpha } = names
        ? brainLabels(items, k, p.textFade, priority, { width: w, height: h }, 260, preferred)
        : { shown: forced, alpha: 1 };
      for (const item of items) {
        if (!shown.has(item.id)) continue;
        const forcedNow = forced.has(item.id);
        ctx.globalAlpha = forcedNow ? 1 : preferred.has(item.id) ? 0.92 : alpha * (isLit(item.id) ? 1 : 0.25);
        if (ctx.globalAlpha <= 0.02) continue;
        const y = item.y + item.r + 4;
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = pal.halo;
        ctx.strokeText(item.text, item.x, y);
        ctx.fillStyle = item.superseded ? pal.proposed : pal.text;
        ctx.fillText(item.text, item.x, y);
      }
      ctx.globalAlpha = 1;
    }
    void time;
    // Accessible, test-visible summary.
    const host = wrap.current;
    if (host) {
      host.dataset.nodes = String(nodes.length);
      host.dataset.edges = String(p.edges.length);
      host.dataset.settled = s.settled ? 'true' : 'false';
      host.dataset.zoom = cam.current.k.toFixed(3);
    }
  }

  // ---- pointer ----------------------------------------------------------------------------
  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvas.current!.getBoundingClientRect();
    const sx = clientX - rect.left,
      sy = clientY - rect.top;
    return { sx, sy, x: (sx - cam.current.x) / cam.current.k, y: (sy - cam.current.y) / cam.current.k };
  };
  const nodeAt = (x: number, y: number): string => {
    const k = cam.current.k;
    let best = '';
    let bestScore = Infinity;
    for (const n of sim.current.nodes) {
      if (!byIdRef.current.has(n.id)) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      const reach = n.r + 4 / k;
      if (d <= reach && d / reach < bestScore) {
        bestScore = d / reach;
        best = n.id;
      }
    }
    return best;
  };
  const edgeAt = (x: number, y: number): string => {
    const k = cam.current.k;
    const reach = 6 / k;
    let best = '';
    let bestD = reach;
    const s = sim.current;
    for (const e of edgesRef.current) {
      const a = s.nodes[s.indexOf(e.from)],
        b = s.nodes[s.indexOf(e.to)];
      if (!a || !b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1);
      const d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
      if (d < bestD) {
        bestD = d;
        best = e.id;
      }
    }
    return best;
  };
  const showTip = (id: string, clientX: number, clientY: number) => {
    const el = tip.current;
    if (!el) return;
    const view = id ? byIdRef.current.get(id) : undefined;
    if (!view) {
      el.hidden = true;
      return;
    }
    const rect = wrap.current!.getBoundingClientRect();
    el.hidden = false;
    el.textContent = `${view.title}${view.superseded ? ' (superseded)' : ''}`;
    el.dataset.kind = view.kind.toLowerCase();
    el.style.transform = `translate(${Math.min(clientX - rect.left + 14, rect.width - 40)}px, ${clientY - rect.top + 16}px)`;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const w = toWorld(e.clientX, e.clientY);
    const id = nodeAt(w.x, w.y);
    drag.current = id
      ? { kind: 'node', id, x: e.clientX, y: e.clientY, moved: false, ox: 0, oy: 0 }
      : { kind: 'pan', id: '', x: e.clientX, y: e.clientY, moved: false, ox: 0, oy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) {
      const w = toWorld(e.clientX, e.clientY);
      const id = nodeAt(w.x, w.y);
      if (id !== hover.current) {
        hover.current = id;
        canvas.current!.style.cursor = id ? 'pointer' : '';
        wake();
      }
      showTip(id, e.clientX, e.clientY);
      return;
    }
    if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) {
      d.moved = true;
      tween.current = null;
    }
    if (!d.moved) return;
    if (d.kind === 'pan') {
      cam.current.x += e.clientX - d.x;
      cam.current.y += e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      wake();
    } else {
      const w = toWorld(e.clientX, e.clientY);
      sim.current.pin(d.id, w.x, w.y);
      showTip('', 0, 0);
      wake();
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const p = live.current;
    if (d.moved) {
      if (d.kind === 'node') {
        const n = sim.current.nodes[sim.current.indexOf(d.id)];
        if (n) p.onPin(d.id, n.x, n.y);
      }
      wake();
      return;
    }
    if (d.kind === 'node') {
      if (e.ctrlKey || e.metaKey) p.onToggleCompare(d.id);
      else p.onSelectNode(d.id);
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    const edge = edgeAt(w.x, w.y);
    if (edge) p.onSelectEdge(edge);
    else p.onClear();
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    const id = nodeAt(w.x, w.y);
    if (id) {
      // Double-click a pinned finding to let the layout move it again; otherwise focus it.
      const n = sim.current.nodes[sim.current.indexOf(id)];
      if (n && n.fx !== null) {
        sim.current.release(id);
        live.current.onUnpin(id);
        sim.current.reheat(0.5);
        wake();
      } else {
        const k = clamp(Math.max(cam.current.k, 1.4), MIN_K, MAX_K);
        const { w: vw, h: vh } = usable();
        const to = { k, x: vw / 2 - (n?.x ?? 0) * k, y: vh / 2 - (n?.y ?? 0) * k };
        tween.current = { t: 0, from: { ...cam.current }, to };
        wake();
      }
    } else ensureFit(true);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = canvas.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left,
      sy = e.clientY - rect.top;
    const c = cam.current;
    const k = clamp(c.k * Math.exp(-e.deltaY * 0.0016), MIN_K, MAX_K);
    cam.current = { k, x: sx - ((sx - c.x) * k) / c.k, y: sy - ((sy - c.y) * k) / c.k };
    tween.current = null;
    wake();
  };
  useEffect(() => {
    const cv = canvas.current;
    cv?.addEventListener('wheel', onWheel, { passive: false });
    return () => cv?.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const p = live.current;
    const ordered = [...p.nodes].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const step = (delta: number) => {
      if (!ordered.length) return;
      const at = ordered.findIndex(n => n.id === p.selectedNode);
      const next =
        ordered[at < 0 ? (delta > 0 ? 0 : ordered.length - 1) : (at + delta + ordered.length) % ordered.length];
      p.onSelectNode(next.id);
      const n = sim.current.nodes[sim.current.indexOf(next.id)];
      if (n) {
        const { w, h } = usable();
        const sxp = n.x * cam.current.k + cam.current.x,
          syp = n.y * cam.current.k + cam.current.y;
        if (sxp < 40 || syp < 40 || sxp > w - 40 || syp > h - 40)
          cam.current = { ...cam.current, x: w / 2 - n.x * cam.current.k, y: h / 2 - n.y * cam.current.k };
        wake();
      }
    };
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') (step(1), e.preventDefault());
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') (step(-1), e.preventDefault());
    else if (e.key === 'Escape') p.onClear();
    else if (e.key === '0') ensureFit(true);
    else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      const f = e.key === '+' || e.key === '=' ? 1.25 : 0.8;
      const { w, h } = size.current;
      const c = cam.current;
      const k = clamp(c.k * f, MIN_K, MAX_K);
      cam.current = { k, x: w / 2 - ((w / 2 - c.x) * k) / c.k, y: h / 2 - ((h / 2 - c.y) * k) / c.k };
      wake();
    }
  };

  return (
    <div
      ref={wrap}
      className="brain-canvas"
      tabIndex={0}
      role="application"
      aria-label={`Memory graph, ${props.nodes.length} findings and ${props.edges.length} links. Arrow keys step through the findings, plus and minus zoom, zero fits the graph, Escape clears the selection.`}
      data-selected={props.selectedNode}
      data-names={props.names ? 'on' : 'off'}
      onKeyDown={onKeyDown}
    >
      <canvas
        ref={canvas}
        style={{ width: '100%', height: '100%', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (!drag.current) {
            hover.current = '';
            showTip('', 0, 0);
            wake();
          }
        }}
        onDoubleClick={onDoubleClick}
      />
      <div ref={tip} className="brain-tip" hidden role="presentation" />
    </div>
  );
}
