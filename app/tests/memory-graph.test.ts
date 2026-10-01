import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import {
  layoutMemory,
  memoryDegrees,
  memoryRadius,
  memoryEdgeTrim,
  memoryInWindow,
  MEMORY_WINDOWS,
} from '../src/renderer/memory-layout';

// memory.tsx imports .css as a side effect; stub them so node can reach its exported pure helpers.
register(
  'data:text/javascript,export function load(u,o,n){if(u.endsWith(".css"))return{format:"module",source:"export default {}",shortCircuit:true};return n(u,o)}',
);
const { memorySettleTargets } = await import('../src/renderer/memory');

test('memoryDegrees counts both endpoints of non-refuted links only', () => {
  const edges = [
    { from: 'a', to: 'b', status: 'CONFIRMED' },
    { from: 'a', to: 'c', status: 'PROPOSED' },
    { from: 'b', to: 'c', status: 'REFUTED' },
  ];
  assert.deepEqual(memoryDegrees(edges), { a: 2, b: 1, c: 1 });
  assert.deepEqual(memoryDegrees([]), {});
});

test('memoryRadius grows subtly with degree and stays bounded', () => {
  assert.equal(memoryRadius(0), 6.5);
  assert.ok(memoryRadius(1) > memoryRadius(0));
  assert.ok(memoryRadius(9) > memoryRadius(1));
  assert.ok(memoryRadius(100) <= 15);
  assert.equal(memoryRadius(4), memoryRadius(4));
});

test('memoryEdgeTrim stops at dot rims and lands a deterministic arrowhead', () => {
  const t = memoryEdgeTrim({ x: 0, y: 0 }, { x: 100, y: 0 }, 7, 9);
  assert.equal(t.short, false);
  assert.ok(Math.abs(t.x1 - 8) < 0.01 && Math.abs(t.y1) < 0.01);
  assert.ok(Math.abs(t.x2 - 89) < 0.01 && Math.abs(t.y2) < 0.01);
  assert.match(t.arrow, /^M .* L .* L .* Z$/);
  assert.equal((t.arrow.match(/ L /g) ?? []).length, 2);
  assert.deepEqual(t, memoryEdgeTrim({ x: 0, y: 0 }, { x: 100, y: 0 }, 7, 9));
  // Nearly touching dots fall back to an untrimmed line with no arrow.
  assert.equal(memoryEdgeTrim({ x: 0, y: 0 }, { x: 15, y: 0 }, 7, 9).short, true);
});

test('layoutMemory stays deterministic and separated while degree-aware spread opens hubs', () => {
  const star = [{ findingId: 'hub' }, ...Array.from({ length: 12 }, (_, i) => ({ findingId: `leaf-${i}` }))];
  const edges = star.slice(1).map(leaf => ({ from: 'hub', to: leaf.findingId, status: 'CONFIRMED' }));
  const points = layoutMemory(star, edges);
  const values = Object.values(points);
  for (let i = 0; i < values.length; i++)
    for (let j = i + 1; j < values.length; j++)
      assert.ok(Math.hypot(values[i].x - values[j].x, values[i].y - values[j].y) > 70);
  // Degree-aware repulsion gives the high-degree hub visibly more room than the 105 baseline.
  const hubDist = Math.min(
    ...star
      .slice(1)
      .map(leaf => Math.hypot(points[leaf.findingId].x - points.hub.x, points[leaf.findingId].y - points.hub.y)),
  );
  assert.ok(hubDist > 120, `hub distance ${hubDist} should exceed the plain repulsion zone`);
  assert.deepEqual(layoutMemory([...star].reverse(), [...edges].reverse()), points);
  // Refuted links never feed the degree map or the spread.
  assert.deepEqual(
    layoutMemory(
      star,
      edges.map(e => ({ ...e, status: 'REFUTED' })),
    ),
    layoutMemory(star, []),
  );
});

test('memoryInWindow filters by createdAt, fails open on unknown ids and never guesses ages', () => {
  assert.deepEqual(
    MEMORY_WINDOWS.map(w => w.id),
    ['all', '24h', '7d', '30d'],
  );
  const nodes = [{ findingId: 'a' }, { findingId: 'b' }, { findingId: 'c' }];
  const now = Date.parse('2026-09-30T12:00:00Z');
  const stamps: Record<string, string> = {
    a: '2026-09-30T11:00:00Z', // 1h old
    b: '2026-09-28T12:00:00Z', // 2d old
    // c has no recorded createdAt — admitted only by 'all', never by a guessed age
  };
  const of = (id: string) => stamps[id];
  assert.deepEqual([...memoryInWindow(nodes, of, 'all', now)].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...memoryInWindow(nodes, of, '24h', now)], ['a']);
  assert.deepEqual([...memoryInWindow(nodes, of, '7d', now)].sort(), ['a', 'b']);
  // An unknown window id must fail open — a bad filter value must not hide records.
  assert.deepEqual([...memoryInWindow(nodes, of, 'bogus', now)].sort(), ['a', 'b', 'c']);
  // Boundary is inclusive and future stamps (clock skew) stay visible.
  const edge = [{ findingId: 'x' }, { findingId: 'y' }];
  const edgeStamps: Record<string, string> = { x: '2026-09-23T12:00:00Z', y: '2026-10-01T00:00:00Z' };
  assert.deepEqual([...memoryInWindow(edge, id => edgeStamps[id], '7d', now)], ['x', 'y']);
});

test('memorySettleTargets enumerates proposed links touching the selection, once each', () => {
  const edges = [
    { relationshipId: 'r1', from: 'a', to: 'b', status: 'PROPOSED' },
    { relationshipId: 'r2', from: 'c', to: 'a', status: 'PROPOSED' }, // selected node as `to`
    { relationshipId: 'r3', from: 'b', to: 'c', status: 'CONFIRMED' }, // already settled
    { relationshipId: 'r4', from: 'c', to: 'd', status: 'PROPOSED' }, // untouched
    { relationshipId: 'r5', from: 'a', to: 'd', status: 'REFUTED' }, // already settled
  ];
  assert.deepEqual(
    memorySettleTargets(edges, new Set(['a'])).map(e => e.relationshipId),
    ['r1', 'r2'],
  );
  // Both endpoints selected — the relationship still appears exactly once.
  const both = [
    { relationshipId: 'r1', from: 'a', to: 'b', status: 'PROPOSED' },
    { relationshipId: 'r2', from: 'b', to: 'a', status: 'PROPOSED' },
  ];
  assert.deepEqual(
    memorySettleTargets(both, new Set(['a', 'b'])).map(e => e.relationshipId),
    ['r1', 'r2'],
  );
  assert.deepEqual(memorySettleTargets(both, new Set()), []);
  assert.deepEqual(memorySettleTargets([], new Set(['a'])), []);
});
