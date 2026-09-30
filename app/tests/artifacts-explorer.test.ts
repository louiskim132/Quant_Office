import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// artifacts.tsx imports its stylesheet for the bundler; Node has no css loader, so the unit-level
// import stubs it — this tests the component module's real helpers, not a copy.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { artifactMatches, artifactSearchText, artifactGroupName, groupArtifacts } =
  await import('../src/renderer/artifacts');

const row = (over: Partial<import('../src/renderer/artifacts').ArtifactExplorerRow> = {}) => ({
  key: 'k',
  name: 'results/sweep.csv',
  context: 'Imported · reference · stored',
  bytes: 120,
  hash: 'ab12cd34ef56ff0099',
  source: 'imported' as const,
  old: false,
  time: '2026-09-30T10:00:00.000Z',
  kind: 'REFERENCE',
  projectName: 'Volatility research',
  experimentName: 'EMA sweep',
  producer: '',
  ...over,
});

test('search hits every metadata field the record carries', () => {
  const r = row();
  for (const term of [
    'sweep.csv', // name/path
    'reference', // kind/context
    'ab12cd', // hash prefix
    'ab12cd34ef56ff0099', // full hash
    'volatility', // project label
    'ema sweep', // experiment label
    '2026-09-30', // recorded timestamp
    'imported', // source word
  ])
    assert.ok(artifactMatches(r, term), `expected '${term}' to match`);
  assert.ok(artifactMatches(r, '  '), 'blank query matches everything');
  assert.ok(!artifactMatches(r, 'no-such-file'));
});

test('an output row is searchable by its recorded producer', () => {
  const out = row({ source: 'output', kind: 'OUTPUT', producer: 'Test worker 1', context: 'Req · Test worker 1' });
  assert.ok(artifactMatches(out, 'test worker'));
  assert.ok(artifactSearchText(out).includes('Test worker 1'));
});

test('group-by names come only from recorded fields', () => {
  const imp = row();
  const out = row({ source: 'output', kind: 'OUTPUT', producer: 'Test worker 1' });
  assert.equal(artifactGroupName(imp, 'kind'), 'Reference import');
  assert.equal(artifactGroupName(out, 'kind'), 'Agent output');
  assert.equal(artifactGroupName(imp, 'project'), 'Volatility research');
  assert.equal(artifactGroupName(imp, 'source'), 'Imported reference');
  assert.equal(artifactGroupName(out, 'source'), 'Produced by Test worker 1');
  assert.equal(artifactGroupName(row({ projectName: '' }), 'project'), 'No project recorded');
});

test('groupArtifacts re-buckets rows with counts and keeps order inside groups', () => {
  const a = row({ key: 'a', kind: 'REFERENCE' });
  const b = row({ key: 'b', kind: 'RESULT' });
  const c = row({ key: 'c', source: 'output', kind: 'OUTPUT', producer: 'W1' });
  const d = row({ key: 'd', kind: 'REFERENCE' });
  const byKind = groupArtifacts([a, b, c, d], 'kind');
  assert.deepEqual(
    byKind.map(g => [g.label, g.count]),
    [
      ['Reference import', 2],
      ['Result import', 1],
      ['Agent output', 1],
    ],
  );
  assert.deepEqual(
    byKind[0].rows.map(r => r.key),
    ['a', 'd'],
    'rows keep list order in the group',
  );
  const none = groupArtifacts([a, b], 'none');
  assert.equal(none.length, 1);
  assert.equal(none[0].label, '');
  assert.equal(none[0].count, 2);
  const bySource = groupArtifacts([a, c], 'source');
  assert.deepEqual(
    bySource.map(g => g.label),
    ['Imported reference', 'Produced by W1'],
  );
});
