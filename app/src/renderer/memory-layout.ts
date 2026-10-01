type Edge = { from: string; to: string; status: string };

/** Recorded non-refuted link count per finding — drives dot size and gravity. */
export function memoryDegrees(edges: readonly Edge[]) {
  const degrees: Record<string, number> = {};
  for (const edge of edges) {
    if (edge.status === 'REFUTED') continue;
    degrees[edge.from] = (degrees[edge.from] ?? 0) + 1;
    degrees[edge.to] = (degrees[edge.to] ?? 0) + 1;
  }
  return degrees;
}

/**
 * The findings within `depth` links of `start` (Obsidian's local graph). Refuted links are not
 * followed, and direction does not matter: a backlink is as near as a link.
 */
export function memoryNeighborhood(start: string, edges: readonly Edge[], depth: number): Set<string> {
  const reach = new Set<string>([start]);
  let frontier = [start];
  for (let step = 0; step < Math.max(0, Math.floor(depth)) && frontier.length; step++) {
    const next: string[] = [];
    for (const edge of edges) {
      if (edge.status === 'REFUTED') continue;
      for (const [a, b] of [
        [edge.from, edge.to],
        [edge.to, edge.from],
      ])
        if (frontier.includes(a) && !reach.has(b)) {
          reach.add(b);
          next.push(b);
        }
    }
    frontier = next;
  }
  return reach;
}

/** Display-filter windows for the graph — a view cut, never a record change. */
export const MEMORY_WINDOWS = [
  { id: 'all', label: 'All', ms: null },
  { id: '24h', label: '24h', ms: 24 * 3600_000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 3600_000 },
  { id: '30d', label: '30d', ms: 30 * 24 * 3600_000 },
] as const;

/**
 * Pure display filter: the ids whose finding creation time falls inside the window.
 * 'all' and unknown ids admit everything (a bad filter value must fail open — hiding
 * records silently is worse than showing too much). A node with no parseable createdAt
 * is admitted only by 'all': we never guess an age. `now` is injectable for tests.
 */
export function memoryInWindow<N extends { findingId: string }>(
  nodes: readonly N[],
  createdAtOf: (findingId: string) => string | undefined,
  windowId: string,
  now = Date.now(),
) {
  const win = MEMORY_WINDOWS.find(w => w.id === windowId);
  const visible = new Set<string>();
  for (const node of nodes) {
    if (!win || win.ms === null) {
      visible.add(node.findingId);
      continue;
    }
    const stamp = createdAtOf(node.findingId);
    const t = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(t) && now - t <= win.ms) visible.add(node.findingId);
  }
  return visible;
}

/** The most findings the brain draws; beyond this the page says so rather than slowing down. */
export const MEMORY_NODE_LIMIT = 5000;
export const MEMORY_EDGE_LIMIT = 20000;
