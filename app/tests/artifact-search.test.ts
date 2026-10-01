import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// The component module imports its stylesheet for the bundler; Node can't load .css, so the
// unit-level import stubs it. This tests the real exported helpers, not a copy.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { MIN_CONTENT_QUERY, contentQueryReady, contentSearchBoundary } = await import('../src/renderer/artifacts');

test('the boundary line renders the returned counts verbatim, matching the honesty contract', () => {
  assert.equal(
    contentSearchBoundary({ scanned: 8, skippedBinary: 2, truncated: 1 }),
    'Searched 8 text artifacts · 2 binary skipped · 1 truncated at 1 MB',
  );
});

test('the boundary line still states its counts when nothing was searched', () => {
  assert.equal(
    contentSearchBoundary({ scanned: 0, skippedBinary: 0, truncated: 0 }),
    'Searched 0 text artifacts · 0 binary skipped · 0 truncated at 1 MB',
  );
});

test('the boundary line pluralizes honestly for a single scanned artifact', () => {
  assert.equal(
    contentSearchBoundary({ scanned: 1, skippedBinary: 3, truncated: 2 }),
    'Searched 1 text artifact · 3 binary skipped · 2 truncated at 1 MB',
  );
});

test('queries below the minimum are rejected before the seam is called', () => {
  assert.equal(contentQueryReady(''), false);
  assert.equal(contentQueryReady('a'), false);
  assert.equal(contentQueryReady('  a  '), false);
  assert.equal(contentQueryReady('ab'), true);
  assert.equal(contentQueryReady('   ab   '), true);
  assert.equal(MIN_CONTENT_QUERY, 2);
});
