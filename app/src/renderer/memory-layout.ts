export type Point = { x: number; y: number };
type Node = { findingId: string };
type Edge = { from: string; to: string; status: string };

/** Recorded non-refuted link count per finding — drives dot size and repulsion room. */
export function memoryDegrees(edges: readonly Edge[]) {
  const degrees: Record<string, number> = {};
  for (const edge of edges) {
    if (edge.status === 'REFUTED') continue;
    degrees[edge.from] = (degrees[edge.from] ?? 0) + 1;
    degrees[edge.to] = (degrees[edge.to] ?? 0) + 1;
  }
  return degrees;
}

/** Obsidian-style dot radius: subtly larger with link count, bounded 6.5–15. */
export function memoryRadius(degree: number) {
  return Math.round((6.5 + Math.min(8.5, 1.7 * Math.sqrt(Math.max(0, degree)))) * 10) / 10;
}

/**
 * Deterministic trim of a directed edge so the line stops at each dot's rim and the
 * arrowhead lands on the target rim. `short` means the dots nearly touch — callers
 * draw the untrimmed line and no arrow.
 */
export function memoryEdgeTrim(a: Point, b: Point, fromRadius: number, toRadius: number) {
  const dx = b.x - a.x || 0.01,
    dy = b.y - a.y || 0.01;
  const distance = Math.hypot(dx, dy),
    ux = dx / distance,
    uy = dy / distance;
  const gap = 2;
  const x1 = a.x + ux * (fromRadius + 1),
    y1 = a.y + uy * (fromRadius + 1);
  const x2 = b.x - ux * (toRadius + gap),
    y2 = b.y - uy * (toRadius + gap);
  const wing = 4.6,
    depth = 7;
  const arrow = `M ${x2} ${y2} L ${x2 - ux * depth - uy * wing} ${y2 - uy * depth + ux * wing} L ${x2 - ux * depth + uy * wing} ${y2 - uy * depth - ux * wing} Z`;
  return { x1, y1, x2, y2, arrow, short: distance <= fromRadius + toRadius + gap + 2 };
}

/** Bounded deterministic force layout. User pins are fixed; computed positions never enter storage. */
export function layoutMemory(nodes: readonly Node[], edges: readonly Edge[], pins: Record<string, Point> = {}) {
  const sorted = [...nodes].sort((a, b) => a.findingId.localeCompare(b.findingId)).slice(0, 100);
  const points: Record<string, Point> = {};
  sorted.forEach((node, i) => {
    const pin = pins[node.findingId];
    const angle = i * 2.399963;
    const radius = Math.sqrt(i + 1) * 48;
    points[node.findingId] =
      pin && Number.isFinite(pin.x) && Number.isFinite(pin.y)
        ? { ...pin }
        : { x: 410 + Math.cos(angle) * radius, y: 270 + Math.sin(angle) * radius };
  });
  const fixed = new Set(
    sorted
      .filter(n => pins[n.findingId] && Number.isFinite(pins[n.findingId].x) && Number.isFinite(pins[n.findingId].y))
      .map(n => n.findingId),
  );
  // Links are canonically ordered before the bound so the same edge set yields the same
  // accumulation order — output is identical for any input ordering.
  const links = edges
    .filter(e => e.status !== 'REFUTED' && points[e.from] && points[e.to])
    .sort((a, b) => `${a.from}|${a.to}|${a.status}`.localeCompare(`${b.from}|${b.to}|${b.status}`))
    .slice(0, 200);
  const degrees = memoryDegrees(links);
  for (let tick = 0; tick < 180; tick++) {
    const forces = Object.fromEntries(sorted.map(n => [n.findingId, { x: 0, y: 0 }]));
    for (let i = 0; i < sorted.length; i++)
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i].findingId,
          b = sorted[j].findingId;
        const dx = points[b].x - points[a].x || 0.01,
          dy = points[b].y - points[a].y || 0.01;
        const distance = Math.max(0.1, Math.hypot(dx, dy));
        // High-degree dots are drawn bigger; give their pairs more repulsion room.
        const spread = 105 + Math.min(45, ((degrees[a] ?? 0) + (degrees[b] ?? 0)) * 3);
        const strength = distance < spread ? (spread - distance) * 0.3 : 150 / (distance * distance);
        forces[a].x -= (dx / distance) * strength;
        forces[a].y -= (dy / distance) * strength;
        forces[b].x += (dx / distance) * strength;
        forces[b].y += (dy / distance) * strength;
      }
    for (const edge of links) {
      const a = points[edge.from],
        b = points[edge.to];
      const dx = b.x - a.x,
        dy = b.y - a.y,
        distance = Math.max(1, Math.hypot(dx, dy));
      const strength = (distance - 145) * 0.025;
      forces[edge.from].x += (dx / distance) * strength;
      forces[edge.from].y += (dy / distance) * strength;
      forces[edge.to].x -= (dx / distance) * strength;
      forces[edge.to].y -= (dy / distance) * strength;
    }
    for (const node of sorted) {
      const id = node.findingId,
        p = points[id],
        f = forces[id];
      if (!fixed.has(id)) {
        p.x += Math.max(-12, Math.min(12, f.x + (410 - p.x) * 0.003));
        p.y += Math.max(-12, Math.min(12, f.y + (270 - p.y) * 0.003));
      }
    }
  }
  return points;
}

export function fitMemory(points: Record<string, Point>, width = 820, height = 540) {
  const values = Object.values(points);
  if (!values.length) return { x: 0, y: 0, k: 1 };
  const minX = Math.min(...values.map(p => p.x)) - 70,
    maxX = Math.max(...values.map(p => p.x)) + 70;
  const minY = Math.min(...values.map(p => p.y)) - 55,
    maxY = Math.max(...values.map(p => p.y)) + 55;
  const k = Math.min(1.5, width / (maxX - minX), height / (maxY - minY));
  return { k, x: width / 2 - ((minX + maxX) / 2) * k, y: height / 2 - ((minY + maxY) / 2) * k };
}

/** Greedy label collision in graph coordinates; priority labels (selection/hover) win. */
export function memoryLabels(
  nodes: readonly { findingId: string; title: string }[],
  points: Record<string, Point>,
  zoom: number,
  priority = '',
) {
  const result = new Set<string>(),
    boxes: { x: number; y: number; w: number }[] = [];
  const ordered = [...nodes].sort((a, b) => Number(b.findingId === priority) - Number(a.findingId === priority));
  for (const node of ordered) {
    const p = points[node.findingId];
    if (!p || (zoom < 0.65 && node.findingId !== priority)) continue;
    const w = (Math.min(24, node.title.length) * 6) / zoom;
    const box = { x: p.x - w / 2, y: p.y + 18 + 15 / zoom, w };
    if (boxes.some(b => Math.abs(b.y - box.y) < 18 / zoom && b.x < box.x + box.w && box.x < b.x + b.w)) continue;
    boxes.push(box);
    result.add(node.findingId);
  }
  return result;
}
