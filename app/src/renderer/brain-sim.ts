/**
 * The memory "brain": a live force simulation in the style of Obsidian's graph view. Findings are
 * bodies, recorded links are springs, and the whole thing is held in a round, dense cloud by a
 * gentle pull to the centre and by collisions that pack circles instead of letting them overlap.
 *
 * Repulsion uses a Barnes–Hut quadtree, so thousands of findings stay interactive. The layout is a
 * pure function of the data and the seed: the same findings always settle into the same picture,
 * and no computed position is ever stored (only positions a person drags are, by the caller).
 */
export interface BrainNodeInput {
  id: string;
  /** Recorded non-refuted link count; drives size and gravity. */
  degree: number;
}
export interface BrainLinkInput {
  from: string;
  to: string;
}
export interface BrainNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  degree: number;
  /** Pinned by the user (or by an active drag): the simulation does not move it. */
  fx: number | null;
  fy: number | null;
}
export interface BrainLink {
  source: number;
  target: number;
  strength: number;
  bias: number;
}
/** Slider positions, each 0–1, so the controls panel stays unit-free. */
export interface BrainForces {
  center: number;
  repel: number;
  linkStrength: number;
  linkDistance: number;
}
export const DEFAULT_FORCES: BrainForces = { center: 0.55, repel: 0.35, linkStrength: 0.7, linkDistance: 0.2 };

export const brainRadius = (degree: number, scale = 1) =>
  (3.4 + Math.min(14, 2.1 * Math.sqrt(Math.max(0, degree)))) * scale;

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const THETA2 = 0.81;
const PAD = 1.6;

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const jiggle = (a: number, b: number) => ((hash(`${a}:${b}`) % 1000) / 1000 - 0.5) * 1e-3;

/** Barnes–Hut quadtree over typed arrays: rebuilt every tick without allocating. */
class Quad {
  private cap = 0;
  x0!: Float64Array;
  y0!: Float64Array;
  size!: Float64Array;
  mass!: Float64Array;
  cx!: Float64Array;
  cy!: Float64Array;
  child!: Int32Array;
  body!: Int32Array;
  count = 0;

  private grow(n: number) {
    if (n <= this.cap) return;
    this.cap = Math.max(n, this.cap * 2);
    this.x0 = new Float64Array(this.cap);
    this.y0 = new Float64Array(this.cap);
    this.size = new Float64Array(this.cap);
    this.mass = new Float64Array(this.cap);
    this.cx = new Float64Array(this.cap);
    this.cy = new Float64Array(this.cap);
    this.child = new Int32Array(this.cap * 4);
    this.body = new Int32Array(this.cap);
  }
  private make(x0: number, y0: number, size: number) {
    const id = this.count++;
    this.x0[id] = x0;
    this.y0[id] = y0;
    this.size[id] = size;
    this.mass[id] = 0;
    this.cx[id] = 0;
    this.cy[id] = 0;
    this.body[id] = -1;
    this.child.fill(-1, id * 4, id * 4 + 4);
    return id;
  }

  build(xs: Float64Array, ys: Float64Array, weight: Float64Array, n: number) {
    this.grow(n * 4 + 64);
    this.count = 0;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i] < minX) minX = xs[i];
      if (xs[i] > maxX) maxX = xs[i];
      if (ys[i] < minY) minY = ys[i];
      if (ys[i] > maxY) maxY = ys[i];
    }
    const size = Math.max(maxX - minX, maxY - minY, 1) + 1;
    this.make(minX - 0.5, minY - 0.5, size);
    for (let i = 0; i < n; i++) this.insert(i, xs, ys);
    this.summarise(0, xs, ys, weight);
  }

  private quadrant(node: number, x: number, y: number) {
    const half = this.size[node] / 2;
    return (x >= this.x0[node] + half ? 1 : 0) + (y >= this.y0[node] + half ? 2 : 0);
  }
  private childAt(node: number, q: number) {
    let c = this.child[node * 4 + q];
    if (c < 0) {
      const half = this.size[node] / 2;
      c = this.make(this.x0[node] + (q & 1 ? half : 0), this.y0[node] + (q & 2 ? half : 0), half);
      this.child[node * 4 + q] = c;
    }
    return c;
  }
  private insert(i: number, xs: Float64Array, ys: Float64Array) {
    let node = 0;
    for (let depth = 0; depth < 48; depth++) {
      const internal =
        this.child[node * 4] >= 0 ||
        this.child[node * 4 + 1] >= 0 ||
        this.child[node * 4 + 2] >= 0 ||
        this.child[node * 4 + 3] >= 0;
      if (!internal) {
        const there = this.body[node];
        if (there < 0) {
          this.body[node] = i;
          return;
        }
        // Leaf already holds someone: push them down one level, then place the newcomer.
        this.body[node] = -1;
        const moved = this.childAt(node, this.quadrant(node, xs[there], ys[there]));
        this.body[moved] = there;
      }
      node = this.childAt(node, this.quadrant(node, xs[i], ys[i]));
    }
    // Coincident points: leave the newcomer out of the tree; its repulsion is negligible.
  }
  private summarise(node: number, xs: Float64Array, ys: Float64Array, weight: Float64Array) {
    const b = this.body[node];
    if (b >= 0) {
      this.mass[node] = weight[b];
      this.cx[node] = xs[b];
      this.cy[node] = ys[b];
      return;
    }
    let m = 0,
      sx = 0,
      sy = 0;
    for (let q = 0; q < 4; q++) {
      const c = this.child[node * 4 + q];
      if (c < 0) continue;
      this.summarise(c, xs, ys, weight);
      m += this.mass[c];
      sx += this.cx[c] * this.mass[c];
      sy += this.cy[c] * this.mass[c];
    }
    this.mass[node] = m;
    this.cx[node] = m ? sx / m : 0;
    this.cy[node] = m ? sy / m : 0;
  }
}

export class BrainSim {
  nodes: BrainNode[] = [];
  links: BrainLink[] = [];
  alpha = 1;
  alphaTarget = 0;
  forces: BrainForces = { ...DEFAULT_FORCES };
  nodeScale = 1;
  private index = new Map<string, number>();
  private xs = new Float64Array(0);
  private ys = new Float64Array(0);
  private charge = new Float64Array(0);
  private quad = new Quad();
  private stack = new Int32Array(512);
  private alphaDecay = 1 - Math.pow(0.002, 1 / 260);
  private velocityDecay = 0.52;

  get settled() {
    return this.alpha < 0.0025 && this.alphaTarget === 0;
  }

  /**
   * Replace the data, keeping every known body where it is so a refresh never makes the picture
   * jump. A new finding appears beside the first neighbour that already has a place; one with none
   * is seeded on a golden-angle spiral, biggest hubs first, so hubs start near the middle. `seeds`
   * remembers where findings were before a filter hid them.
   */
  setData(
    nodes: readonly BrainNodeInput[],
    links: readonly BrainLinkInput[],
    pins: Record<string, { x: number; y: number }> = {},
    seeds: ReadonlyMap<string, { x: number; y: number }> = new Map(),
  ) {
    const previous = new Map(this.nodes.map(n => [n.id, n]));
    const ordered = [...nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
    const neighbours = new Map<string, string[]>();
    for (const l of links) {
      (neighbours.get(l.from) ?? neighbours.set(l.from, []).get(l.from)!).push(l.to);
      (neighbours.get(l.to) ?? neighbours.set(l.to, []).get(l.to)!).push(l.from);
    }
    let fresh = 0;
    let changed = previous.size !== nodes.length;
    const next: BrainNode[] = [];
    ordered.forEach((input, i) => {
      const old = previous.get(input.id);
      const pin = pins[input.id];
      const pinned = pin && Number.isFinite(pin.x) && Number.isFinite(pin.y) ? pin : null;
      const node: BrainNode = old ?? { id: input.id, x: 0, y: 0, vx: 0, vy: 0, r: 0, degree: 0, fx: null, fy: null };
      const seed = old ? undefined : seeds.get(input.id);
      if (seed && Number.isFinite(seed.x) && Number.isFinite(seed.y)) {
        // A finding that was hidden by a filter returns to where it was.
        node.x = seed.x;
        node.y = seed.y;
        changed = true;
      } else if (!old) {
        changed = true;
        const anchor = (neighbours.get(input.id) ?? []).map(id => previous.get(id)).find(Boolean);
        if (anchor) {
          const a = (hash(input.id) % 628) / 100;
          node.x = anchor.x + Math.cos(a) * 18;
          node.y = anchor.y + Math.sin(a) * 18;
        } else {
          const radius = 14 * Math.sqrt(i + 1 + fresh);
          node.x = Math.cos(i * GOLDEN) * radius;
          node.y = Math.sin(i * GOLDEN) * radius;
          fresh++;
        }
      }
      node.degree = input.degree;
      node.r = brainRadius(input.degree, this.nodeScale);
      node.fx = pinned ? pinned.x : null;
      node.fy = pinned ? pinned.y : null;
      if (pinned) {
        node.x = pinned.x;
        node.y = pinned.y;
      }
      next.push(node);
    });
    this.nodes = next;
    this.index = new Map(next.map((n, i) => [n.id, i]));
    const count = new Int32Array(next.length);
    const seen = new Set<string>();
    const kept: [number, number][] = [];
    for (const l of links) {
      const s = this.index.get(l.from),
        t = this.index.get(l.to);
      if (s === undefined || t === undefined || s === t) continue;
      const key = s < t ? `${s}|${t}` : `${t}|${s}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Canonical direction and order, so the same links give the same springs whatever order they arrive in.
      kept.push(s < t ? [s, t] : [t, s]);
      count[s]++;
      count[t]++;
    }
    kept.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.links = kept.map(([s, t]) => ({
      source: s,
      target: t,
      strength: 1 / Math.min(count[s], count[t]),
      bias: count[s] / (count[s] + count[t]),
    }));
    const n = next.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.charge = new Float64Array(n);
    if (changed) this.alpha = Math.max(this.alpha, 0.7);
  }

  indexOf(id: string) {
    return this.index.get(id) ?? -1;
  }

  setNodeScale(scale: number) {
    this.nodeScale = scale;
    for (const n of this.nodes) n.r = brainRadius(n.degree, scale);
  }

  reheat(alpha = 0.5) {
    this.alpha = Math.max(this.alpha, alpha);
  }

  pin(id: string, x: number, y: number) {
    const node = this.nodes[this.indexOf(id)];
    if (!node) return;
    node.fx = node.x = x;
    node.fy = node.y = y;
  }
  release(id: string) {
    const node = this.nodes[this.indexOf(id)];
    if (node) node.fx = node.fy = null;
  }

  /** Forget every position and start again from the seed layout. */
  restart(pins: Record<string, { x: number; y: number }> = {}) {
    const inputs = this.nodes.map(n => ({ id: n.id, degree: n.degree }));
    const links = this.links.map(l => ({ from: this.nodes[l.source].id, to: this.nodes[l.target].id }));
    this.nodes = [];
    this.alpha = 1;
    this.setData(inputs, links, pins);
  }

  tick() {
    const nodes = this.nodes;
    const n = nodes.length;
    if (!n) return;
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
    const alpha = this.alpha;
    const f = this.forces;
    const linkDistance = 2 + f.linkDistance * 70;
    const linkStrength = 0.15 + f.linkStrength * 0.85;
    const repel = 6 + f.repel * 100;
    const centre = 0.004 + f.center * 0.08;

    // Springs along recorded links.
    for (const link of this.links) {
      const s = nodes[link.source],
        t = nodes[link.target];
      let dx = t.x + t.vx - s.x - s.vx || jiggle(link.source, link.target);
      let dy = t.y + t.vy - s.y - s.vy || jiggle(link.target, link.source);
      const len = Math.sqrt(dx * dx + dy * dy);
      const k = ((len - (linkDistance + s.r + t.r)) / len) * alpha * link.strength * linkStrength;
      dx *= k;
      dy *= k;
      t.vx -= dx * link.bias;
      t.vy -= dy * link.bias;
      s.vx += dx * (1 - link.bias);
      s.vy += dy * (1 - link.bias);
    }

    // Many-body repulsion, Barnes–Hut.
    for (let i = 0; i < n; i++) {
      this.xs[i] = nodes[i].x;
      this.ys[i] = nodes[i].y;
      this.charge[i] = 1 + nodes[i].r * 0.05;
    }
    const q = this.quad;
    q.build(this.xs, this.ys, this.charge, n);
    const maxDist2 = 900 * 900;
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      let top = 0;
      this.stack[top++] = 0;
      while (top) {
        const k = this.stack[--top];
        const body = q.body[k];
        const dx = q.cx[k] - node.x;
        const dy = q.cy[k] - node.y;
        let l = dx * dx + dy * dy;
        if (body >= 0 || (q.size[k] * q.size[k]) / THETA2 < l) {
          if (body === i || l > maxDist2 || !q.mass[k]) continue;
          if (l < 1) l = Math.sqrt(l);
          const w = (-repel * alpha * q.mass[k] * this.charge[i]) / l;
          node.vx += dx * w;
          node.vy += dy * w;
        } else {
          if (top + 4 > this.stack.length) {
            const grown = new Int32Array(this.stack.length * 2);
            grown.set(this.stack);
            this.stack = grown;
          }
          for (let c = 0; c < 4; c++) {
            const child = q.child[k * 4 + c];
            if (child >= 0) this.stack[top++] = child;
          }
        }
      }
    }

    // Gravity to the middle, a little stronger on loose bodies, so isolated findings stay in view.
    for (const node of nodes) {
      const loose = node.degree === 0 ? 3 : 1;
      node.vx -= node.x * centre * alpha * loose;
      node.vy -= node.y * centre * alpha * loose;
    }

    // Collisions pack circles instead of letting them overlap.
    this.collide();

    for (const node of nodes) {
      if (node.fx !== null && node.fy !== null) {
        node.x = node.fx;
        node.y = node.fy;
        node.vx = node.vy = 0;
      } else {
        node.vx *= 1 - this.velocityDecay;
        node.vy *= 1 - this.velocityDecay;
        node.x += node.vx;
        node.y += node.vy;
      }
    }
  }

  private collide() {
    const nodes = this.nodes;
    let maxR = 0;
    for (const nd of nodes) maxR = Math.max(maxR, nd.r);
    const cell = (maxR + PAD) * 2;
    const grid = new Map<number, number[]>();
    nodes.forEach((nd, i) => {
      const key = Math.floor(nd.x / cell) * 73856093 + Math.floor(nd.y / cell) * 19349663;
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    });
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const cx = Math.floor(a.x / cell),
        cy = Math.floor(a.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++)
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = grid.get(gx * 73856093 + gy * 19349663);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const b = nodes[j];
            let dx = a.x + a.vx - b.x - b.vx || jiggle(i, j);
            let dy = a.y + a.vy - b.y - b.vy || jiggle(j, i);
            const reach = a.r + b.r + PAD;
            const d2 = dx * dx + dy * dy;
            if (d2 >= reach * reach) continue;
            const d = Math.sqrt(d2) || 1e-6;
            const push = ((reach - d) / d) * 0.7;
            dx *= push;
            dy *= push;
            const wa = (b.r * b.r) / (a.r * a.r + b.r * b.r);
            a.vx += dx * wa;
            a.vy += dy * wa;
            b.vx -= dx * (1 - wa);
            b.vy -= dy * (1 - wa);
          }
        }
    }
  }

  /** Run ticks until settled or the budget is spent; returns the ticks run. */
  settle(maxTicks = 300, budgetMs = 160): number {
    const start = performance.now();
    let ran = 0;
    while (ran < maxTicks && !this.settled) {
      this.tick();
      ran++;
      if ((ran & 7) === 0 && performance.now() - start > budgetMs) break;
    }
    return ran;
  }

  /**
   * The box around the findings. With `trim` the extreme fraction at each end is ignored (when
   * there are enough findings for that to mean anything), so a few stragglers never shrink the
   * main body of the cloud to a speck when the view is fitted.
   */
  bounds(trim = 0) {
    const n = this.nodes.length;
    if (!n) return { x0: -1, y0: -1, x1: 1, y1: 1 };
    if (trim <= 0 || n < 40) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const node of this.nodes) {
        x0 = Math.min(x0, node.x - node.r);
        x1 = Math.max(x1, node.x + node.r);
        y0 = Math.min(y0, node.y - node.r);
        y1 = Math.max(y1, node.y + node.r);
      }
      return { x0, y0, x1, y1 };
    }
    const xs = this.nodes.map(node => node.x).sort((a, b) => a - b);
    const ys = this.nodes.map(node => node.y).sort((a, b) => a - b);
    const lo = Math.floor(n * trim),
      hi = Math.ceil(n * (1 - trim)) - 1;
    return { x0: xs[lo] - 6, x1: xs[hi] + 6, y0: ys[lo] - 6, y1: ys[hi] + 6 };
  }
}

/** Camera that frames a bounds box inside a viewport with a margin: screen = world * k + (x, y). */
export function fitBounds(
  box: { x0: number; y0: number; x1: number; y1: number },
  width: number,
  height: number,
  margin = 40,
  maxK = 2.5,
) {
  const w = Math.max(1, box.x1 - box.x0),
    h = Math.max(1, box.y1 - box.y0);
  const k = Math.min(maxK, Math.max(0.02, Math.min((width - margin * 2) / w, (height - margin * 2) / h)));
  return { k, x: width / 2 - ((box.x0 + box.x1) / 2) * k, y: height / 2 - ((box.y0 + box.y1) / 2) * k };
}

/**
 * Which names to draw, with items in screen pixels. Hubs first; a name is skipped when it would sit
 * on one already placed. `fade` (0–1) moves the zoom at which names begin to appear, so zooming
 * out thins them out the way Obsidian's text-fade threshold does. Priority names (hovered,
 * selected, neighbours of the hovered one) are always drawn.
 */
export function brainLabels(
  items: readonly { id: string; x: number; y: number; r: number; degree: number; width: number }[],
  k: number,
  fade: number,
  priority: ReadonlySet<string>,
  viewport: { width: number; height: number },
  limit = 260,
  /** Placed first among the rest (a hovered finding's neighbours) but still kept from overlapping. */
  preferred: ReadonlySet<string> = new Set(),
): { shown: Set<string>; alpha: number } {
  const shown = new Set<string>();
  // Names appear from `appear` zoom and are fully opaque by `full`.
  const appear = 0.25 + fade * 1.1;
  const full = appear + 0.45;
  const alpha = Math.max(0, Math.min(1, (k - appear) / (full - appear)));
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const ordered = [...items].sort(
    (a, b) =>
      Number(priority.has(b.id)) - Number(priority.has(a.id)) ||
      Number(preferred.has(b.id)) - Number(preferred.has(a.id)) ||
      b.degree - a.degree,
  );
  for (const item of ordered) {
    const forced = priority.has(item.id);
    const wanted = forced || preferred.has(item.id);
    if (!wanted && alpha <= 0) continue;
    if (!wanted && shown.size >= limit) continue;
    const x = item.x,
      y = item.y + item.r + 9;
    if (x < -80 || y < -20 || x > viewport.width + 80 || y > viewport.height + 20) continue;
    const box = { x0: x - item.width / 2, x1: x + item.width / 2, y0: y - 8, y1: y + 8 };
    if (!forced && boxes.some(b => box.x0 < b.x1 && b.x0 < box.x1 && box.y0 < b.y1 && b.y0 < box.y1)) continue;
    boxes.push(box);
    shown.add(item.id);
  }
  return { shown, alpha };
}
