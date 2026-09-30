import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutMemory, fitMemory, memoryLabels } from '../src/renderer/memory-layout';
import { previewCsv } from '../src/renderer/preview-data';
const nodes = Array.from({ length: 20 }, (_, i) => ({ findingId: `finding-${i}`, title: `Finding ${i}` }));
test('twenty unlinked findings separate rather than overlap in a dense ellipse', () => {
  const points = layoutMemory(nodes, []),
    values = Object.values(points);
  for (let i = 0; i < values.length; i++)
    for (let j = i + 1; j < values.length; j++)
      assert.ok(Math.hypot(values[i].x - values[j].x, values[i].y - values[j].y) > 70);
  assert.deepEqual(layoutMemory([...nodes].reverse(), []), points);
  const fit = fitMemory(points);
  assert.ok(
    values.every(
      p =>
        p.x * fit.k + fit.x >= 0 &&
        p.x * fit.k + fit.x <= 820 &&
        p.y * fit.k + fit.y >= 0 &&
        p.y * fit.k + fit.y <= 540,
    ),
  );
});
test('pins stay fixed, invalid pins recover, orphan and refuted links do not affect layout', () => {
  const pins = { 'finding-0': { x: 90, y: 100 }, 'finding-1': { x: NaN, y: Infinity } };
  const points = layoutMemory(
    nodes,
    [
      { from: 'missing', to: 'finding-0', status: 'CONFIRMED' },
      { from: 'finding-0', to: 'finding-1', status: 'REFUTED' },
    ],
    pins,
  );
  assert.deepEqual(points['finding-0'], pins['finding-0']);
  assert.ok(Number.isFinite(points['finding-1'].x));
  assert.deepEqual(points, layoutMemory(nodes, [], pins));
  assert.equal(
    Object.keys(
      layoutMemory(
        Array.from({ length: 150 }, (_, i) => ({ findingId: String(i) })),
        [],
      ),
    ).length,
    100,
  );
});
test('labels suppress collisions and honor focus at low zoom', () => {
  const positions = Object.fromEntries(nodes.map(n => [n.findingId, { x: 100, y: 100 }]));
  assert.equal(memoryLabels(nodes, positions, 1).size, 1);
  assert.deepEqual([...memoryLabels(nodes, positions, 0.4, 'finding-2')], ['finding-2']);
});
test('CSV preview retains quoted commas, newlines and escaped quotes with a bounded row count', () => {
  assert.deepEqual(previewCsv('name,value\r\n"a,b","line 1\nline 2"\r\n"a""b",3')?.rows, [
    ['name', 'value'],
    ['a,b', 'line 1\nline 2'],
    ['a"b', '3'],
  ]);
  assert.equal(previewCsv('"unfinished'), null);
  assert.equal(previewCsv('a\nb\nc', 2)?.truncated, true);
});
