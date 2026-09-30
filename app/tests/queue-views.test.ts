import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { QueueViewFilters } from '../src/renderer/queue';

// The component module imports its stylesheets for the bundler; Node can't load .css, so the
// unit-level import stubs them. This tests the real exported helpers, not a copy.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { MAX_QUEUE_VIEWS, parseQueueDensity, parseQueueViews, sameQueueFilters, snapshotQueueFilters } =
  await import('../src/renderer/queue');

const filters: QueueViewFilters = { projectId: 'p1', agentId: 'a1', teamId: 't1', search: 'noise', group: 'needs' };
const view = (id: string, name: string, f = filters) => ({ id, name, filters: { ...f } });

test('missing or malformed stored views degrade to an empty list without throwing', () => {
  assert.deepEqual(parseQueueViews(null), []);
  assert.deepEqual(parseQueueViews(''), []);
  assert.deepEqual(parseQueueViews('not json {'), []);
  assert.deepEqual(parseQueueViews('{"not":"an array"}'), []);
  assert.deepEqual(parseQueueViews('42'), []);
});

test('stored views survive a save/parse round-trip unchanged', () => {
  const views = [view('v1', 'Mine'), view('v2', 'All running', { ...filters, group: 'running' })];
  assert.deepEqual(parseQueueViews(JSON.stringify(views)), views);
});

test('corrupt entries drop out while valid neighbours are kept', () => {
  const raw = JSON.stringify([
    view('v1', 'Mine'),
    null,
    'a string',
    { id: 'v2' }, // no name
    { name: 'No id' },
    { id: 'v3', name: '   ' }, // whitespace-only name
    view('v4', 'Kept'),
  ]);
  assert.deepEqual(
    parseQueueViews(raw).map(v => v.id),
    ['v1', 'v4'],
  );
});

test('missing filter fields and unknown groups coerce to safe defaults', () => {
  const parsed = parseQueueViews(
    JSON.stringify([{ id: 'v1', name: 'Odd', filters: { projectId: 7, group: 'bogus' } }]),
  );
  assert.deepEqual(parsed, [
    {
      id: 'v1',
      name: 'Odd',
      filters: { projectId: '', agentId: '', teamId: '', search: '', group: '' },
    },
  ]);
});

test('view names are trimmed and the saved list is capped', () => {
  const many = Array.from({ length: MAX_QUEUE_VIEWS + 5 }, (_, i) => view(`v${i}`, `View ${i}`));
  assert.equal(parseQueueViews(JSON.stringify(many)).length, MAX_QUEUE_VIEWS);
  assert.equal(parseQueueViews(JSON.stringify([{ id: 'v1', name: '  padded  ' }]))[0].name, 'padded');
});

test('snapshotQueueFilters captures exactly the five filters the page exposes', () => {
  assert.deepEqual(
    snapshotQueueFilters({ scopeProject: 'p1', scopeAgent: 'a1', scopeTeam: '', search: 'x', only: 'awaiting' }),
    { projectId: 'p1', agentId: 'a1', teamId: '', search: 'x', group: 'awaiting' },
  );
});

test('sameQueueFilters is exact — one changed field releases the active view', () => {
  const a = snapshotQueueFilters({ scopeProject: 'p1', scopeAgent: '', scopeTeam: '', search: '', only: '' });
  assert.ok(sameQueueFilters(a, { ...a }));
  assert.ok(!sameQueueFilters(a, { ...a, search: 'q' }));
  assert.ok(!sameQueueFilters(a, { ...a, group: 'needs' }));
});

test('density parsing accepts only the compact marker; anything else is the comfortable default', () => {
  assert.equal(parseQueueDensity('compact'), 'compact');
  assert.equal(parseQueueDensity('comfortable'), 'comfortable');
  assert.equal(parseQueueDensity('{"x":1'), 'comfortable');
  assert.equal(parseQueueDensity(null), 'comfortable');
});
