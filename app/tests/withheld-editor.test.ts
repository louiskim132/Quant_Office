import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { OfficeStore } from '../src/core/store';
import { removeTreeSync } from '../src/main/fsx';

// The helper lives in projects.tsx beside the panel that calls it; that module imports its
// stylesheet for the renderer bundle, and node has no css loader — so the test process stubs
// css modules before the component module is pulled in.
register(
  'data:text/javascript,export async function load(u,c,n){if(u.endsWith(".css"))return{format:"module",source:"export default {}",shortCircuit:true};return n(u,c);}',
  import.meta.url,
);
const { normalizeWithheldEntry } = await import('../src/renderer/projects');

const key = () => randomUUID();

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-withheld-'));
  const file = path.join(root, 'workspace.sqlite');
  const store = new OfficeStore(file);
  t.after(() => {
    store.close();
    removeTreeSync(root);
  });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha study',
    mandate: 'Test',
    budgetCents: 0,
  }).projects[0];
  const source = path.join(root, 'source');
  mkdirSync(source, { recursive: true });
  return { store, project, source, file };
}

test('typed entries normalize exactly like the store: trim, folded slashes, no ./ or trailing /', () => {
  assert.deepEqual(normalizeWithheldEntry('internal/', []), { entry: 'internal', duplicate: false });
  assert.deepEqual(normalizeWithheldEntry('  results\\daily\\  ', []), { entry: 'results/daily', duplicate: false });
  assert.deepEqual(normalizeWithheldEntry('./outputs/', []), { entry: 'outputs', duplicate: false });
  const doubled = normalizeWithheldEntry('data//raw', []);
  assert.ok('error' in doubled, 'a doubled slash is an empty segment, refused');
});

test('a directory that does not exist yet is accepted — the point of the field', () => {
  assert.deepEqual(normalizeWithheldEntry('results/planned-week-40/', []), {
    entry: 'results/planned-week-40',
    duplicate: false,
  });
  assert.deepEqual(normalizeWithheldEntry('internal/notes.txt', []), { entry: 'internal/notes.txt', duplicate: false });
});

test('empty, absolute, drive-qualified and traversing entries are refused with a reason', () => {
  for (const raw of ['   ', '/', './', '.']) {
    const verdict = normalizeWithheldEntry(raw, []);
    assert.ok('error' in verdict, `${JSON.stringify(raw)} should refuse`);
  }
  for (const raw of [
    'C:/x',
    'C:\\x',
    'd:\\results',
    '/abs/path',
    '\\\\srv\\share',
    '../x',
    'a/../b',
    'a/./b',
    '././x',
  ]) {
    const verdict = normalizeWithheldEntry(raw, []);
    assert.ok('error' in verdict, `${JSON.stringify(raw)} should refuse`);
    if ('error' in verdict) assert.ok(verdict.error.length > 20, 'the reason is visible, not a bare no');
  }
  assert.ok('error' in normalizeWithheldEntry('a\tb', []), 'a control character is refused');
  assert.ok('error' in normalizeWithheldEntry('x'.repeat(1001), []), 'the 1000-character bound matches the schema');
});

test("duplicates collapse under the matcher's case-folded rule", () => {
  assert.deepEqual(normalizeWithheldEntry('Results/', ['results']), { entry: 'Results', duplicate: true });
  assert.deepEqual(normalizeWithheldEntry('results', ['results']), { entry: 'results', duplicate: true });
  assert.deepEqual(
    normalizeWithheldEntry('results/weekly', ['results']),
    { entry: 'results/weekly', duplicate: false },
    'a deeper prefix is a distinct entry',
  );
  const full = Array.from({ length: 256 }, (_v, i) => `p${i}`);
  assert.ok('error' in normalizeWithheldEntry('one-more', full), "the store's 256-entry cap is refused before save");
  assert.deepEqual(
    normalizeWithheldEntry('P0', full),
    { entry: 'P0', duplicate: true },
    'a duplicate of a full list still collapses, not errors',
  );
});

test('the helper agrees with location.save on every input — the store schema is the authority', t => {
  const f = fixture(t);
  let revision = 0;
  const table: string[] = [
    'internal/',
    'results/planned/',
    'data\\in\\',
    './outputs/',
    'a spaced/dir',
    'C:/x',
    'C:\\x',
    '/abs',
    '\\\\srv\\s',
    '../x',
    'a/../b',
    'a/./b',
    'a//b',
    '   ',
    'x'.repeat(1001),
  ];
  for (const raw of table) {
    const verdict = normalizeWithheldEntry(raw, []);
    let stored: string[] | undefined;
    let refused = false;
    try {
      const state = f.store.execute({
        type: 'location.save',
        idempotencyKey: key(),
        projectId: f.project.id,
        expectedRevision: revision,
        localFolder: f.source,
        outputFolder: '',
        withheldPaths: [raw],
      });
      revision = state.locations![0].revision;
      stored = state.locations![0].withheldPaths;
    } catch {
      refused = true;
    }
    if ('error' in verdict) {
      assert.ok(refused, `${JSON.stringify(raw)}: helper refused but the store accepted`);
    } else {
      assert.ok(
        !refused,
        `${JSON.stringify(raw)}: helper accepted ${JSON.stringify(verdict.entry)} but the store refused`,
      );
      assert.deepEqual(
        stored,
        [verdict.entry],
        `${JSON.stringify(raw)}: stored form matches the helper's normalized entry`,
      );
    }
  }
});

test('a typed prefix saves and survives reload; the stale-save refusal is byte-for-byte intact', t => {
  const f = fixture(t);
  const saved = f.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: 0,
    localFolder: f.source,
    outputFolder: '',
    withheldPaths: ['internal/'],
  });
  assert.deepEqual(
    saved.locations![0].withheldPaths,
    ['internal'],
    'the prefix stores normalized, as the panel renders it',
  );
  const reopened = new OfficeStore(f.file);
  const persisted = reopened.snapshot().locations![0].withheldPaths;
  reopened.close();
  assert.deepEqual(persisted, ['internal'], 'a withheld prefix survives a reload');
  assert.throws(
    () =>
      f.store.execute({
        type: 'location.save',
        idempotencyKey: key(),
        projectId: f.project.id,
        expectedRevision: 0,
        localFolder: f.source,
        outputFolder: '',
        withheldPaths: ['internal'],
      }),
    /Project location changed in another view\. Reload before saving\./,
    'the baseline-pinned stale-save refusal is unchanged',
  );
});
