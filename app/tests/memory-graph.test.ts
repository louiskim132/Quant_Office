import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { memoryDegrees, memoryInWindow, memoryNeighborhood, MEMORY_WINDOWS } from '../src/renderer/memory-layout';

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

test('memoryNeighborhood walks links in both directions to the asked depth and never follows refuted ones', () => {
  const edges = [
    { from: 'a', to: 'b', status: 'CONFIRMED' },
    { from: 'c', to: 'b', status: 'PROPOSED' }, // a backlink is as near as a link
    { from: 'c', to: 'd', status: 'CONFIRMED' },
    { from: 'd', to: 'e', status: 'REFUTED' },
  ];
  assert.deepEqual([...memoryNeighborhood('a', edges, 0)], ['a']);
  assert.deepEqual([...memoryNeighborhood('a', edges, 1)].sort(), ['a', 'b']);
  assert.deepEqual([...memoryNeighborhood('a', edges, 2)].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...memoryNeighborhood('a', edges, 9)].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual([...memoryNeighborhood('lonely', edges, 3)], ['lonely']);
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
