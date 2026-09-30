import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutMemory,
  memoryDegrees,
  memoryRadius,
  memoryEdgeTrim,
} from '../src/renderer/memory-layout';

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
    ...star.slice(1).map(leaf => Math.hypot(points[leaf.findingId].x - points.hub.x, points[leaf.findingId].y - points.hub.y)),
  );
  assert.ok(hubDist > 120, `hub distance ${hubDist} should exceed the plain repulsion zone`);
  assert.deepEqual(layoutMemory([...star].reverse(), [...edges].reverse()), points);
  // Refuted links never feed the degree map or the spread.
  assert.deepEqual(
    layoutMemory(star, edges.map(e => ({ ...e, status: 'REFUTED' }))),
    layoutMemory(star, []),
  );
});
