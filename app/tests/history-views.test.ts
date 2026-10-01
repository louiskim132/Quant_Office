import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// The renderer modules import their stylesheets for the bundler; Node can't load .css, so the
// unit-level import stubs them — same convention as pipeline-card.test.ts / empty-states.test.ts.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const {
  DEFAULT_HISTORY_FILTERS,
  currentViewName,
  deleteView,
  parseSavedViews,
  renameView,
  sanitizeHistoryFilters,
  serializeSavedViews,
  upsertView,
} = await import('../src/renderer/history');
const { sanitizeActivityFilters } = await import('../src/renderer/activity');

const filters = (over: Partial<import('../src/renderer/history').HistoryFilters> = {}) => ({
  ...DEFAULT_HISTORY_FILTERS,
  ...over,
});

test('parseSavedViews returns the saved list for a well-formed blob', () => {
  const raw = serializeSavedViews([{ name: 'mine', filters: filters({ subject: 'USER' }) }]);
  const views = parseSavedViews(raw, sanitizeHistoryFilters);
  assert.equal(views.length, 1);
  assert.equal(views[0].name, 'mine');
  assert.deepEqual(views[0].filters, filters({ subject: 'USER' }));
});

test('parseSavedViews degrades corrupted storage to defaults, never a throw', () => {
  assert.deepEqual(parseSavedViews(null, sanitizeHistoryFilters), []);
  assert.deepEqual(parseSavedViews('', sanitizeHistoryFilters), []);
  assert.deepEqual(parseSavedViews('{not json', sanitizeHistoryFilters), []);
  assert.deepEqual(parseSavedViews('"a string"', sanitizeHistoryFilters), []);
  assert.deepEqual(parseSavedViews('{"version":1}', sanitizeHistoryFilters), []);
});

test('parseSavedViews skips corrupt entries, trims names and dedupes', () => {
  const raw = JSON.stringify({
    views: [
      { name: ' good ', filters: filters({ search: 'x' }) },
      { filters: filters() },
      { name: '', filters: filters() },
      { name: 'also good', filters: 'nope' },
      { name: 'good', filters: filters({ peer: 'TOOL' }) },
      'not an object',
    ],
  });
  const views = parseSavedViews(raw, sanitizeHistoryFilters);
  assert.deepEqual(
    views.map(v => v.name),
    ['good'],
  );
  assert.deepEqual(views[0].filters, filters({ search: 'x' }));
});

test('sanitizeHistoryFilters coerces wrong-typed fields to the page defaults', () => {
  assert.equal(sanitizeHistoryFilters(null), null);
  assert.equal(sanitizeHistoryFilters('x'), null);
  assert.deepEqual(sanitizeHistoryFilters({}), DEFAULT_HISTORY_FILTERS);
  assert.deepEqual(
    sanitizeHistoryFilters({ technical: 'yes', subject: 42, view: 'bogus', search: null }),
    DEFAULT_HISTORY_FILTERS,
  );
  assert.equal(sanitizeHistoryFilters({ view: 'between' })?.view, 'between');
  assert.equal(sanitizeHistoryFilters({ technical: true })?.technical, true);
});

test('sanitizeActivityFilters validates the same way for the activity page', () => {
  assert.equal(sanitizeActivityFilters(undefined), null);
  assert.deepEqual(sanitizeActivityFilters({}), {
    agentId: '',
    peer: '',
    conversation: '',
    kind: 'all',
    search: '',
  });
  assert.equal(sanitizeActivityFilters({ kind: 'work' })?.kind, 'work');
  assert.equal(sanitizeActivityFilters({ kind: 'bogus' })?.kind, 'all');
});

test('upsertView appends, overwrites the same name and ignores blank names', () => {
  let views = upsertView([], ' a ', filters());
  assert.equal(views.length, 1);
  assert.equal(views[0].name, 'a');
  views = upsertView(views, 'b', filters({ search: 'b' }));
  views = upsertView(views, 'a', filters({ search: 'new' }));
  assert.deepEqual(
    views.map(v => v.name),
    ['b', 'a'],
    'overwriting a name moves it to the end',
  );
  assert.equal(views[1].filters.search, 'new');
  assert.equal(upsertView(views, '   ', filters()), views, 'blank name is a no-op');
  let big = views;
  for (let i = 0; i < 30; i++) big = upsertView(big, `v${i}`, filters());
  assert.ok(big.length <= 24, 'the list stays bounded');
});

test('renameView renames, and rejects blank, unchanged or colliding names', () => {
  const views = [
    { name: 'a', filters: filters() },
    { name: 'b', filters: filters({ search: 's' }) },
  ];
  assert.equal(renameView(views, 'a', 'renamed')[0].name, 'renamed');
  assert.equal(renameView(views, 'a', 'b'), views, 'collision is a no-op');
  assert.equal(renameView(views, 'a', 'a'), views, 'unchanged is a no-op');
  assert.equal(renameView(views, 'a', '  '), views, 'blank is a no-op');
});

test('deleteView removes only the named view', () => {
  const views = [
    { name: 'a', filters: filters() },
    { name: 'b', filters: filters() },
  ];
  assert.deepEqual(
    deleteView(views, 'a').map(v => v.name),
    ['b'],
  );
  assert.equal(deleteView(views, 'missing').length, 2);
});

test('currentViewName is the view whose filters match exactly, else empty', () => {
  const views = [
    { name: 'scoped', filters: filters({ subject: 'USER' }) },
    { name: 'technical', filters: filters({ technical: true }) },
  ];
  assert.equal(currentViewName(views, filters({ subject: 'USER' })), 'scoped');
  assert.equal(currentViewName(views, filters({ technical: true })), 'technical');
  assert.equal(currentViewName(views, filters({ subject: 'USER', search: 'x' })), '', 'a tweaked filter un-matches');
  assert.equal(currentViewName([], filters()), '');
});

test('serialize/parse round-trips a saved view list unchanged', () => {
  const views = [
    { name: 'messages from you', filters: filters({ view: 'messages' as const, subject: 'USER' }) },
    { name: 'tech', filters: filters({ technical: true }) },
  ];
  assert.deepEqual(parseSavedViews(serializeSavedViews(views), sanitizeHistoryFilters), views);
});
