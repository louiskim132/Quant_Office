import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { ProviderJob } from '../src/shared/types';
import type { AttentionItem } from '../src/shared/attention';

// The component module imports its stylesheets for the bundler; Node can't load .css, so the
// unit-level import stubs them. This tests the bell's real helpers, not a copy.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { recordedProgress, dismissalFingerprint, parseDismissed, splitAttention } =
  await import('../src/renderer/shell-widgets');

const job = (state: ProviderJob['state']) => ({ state }) as ProviderJob;
const item = (id: string, kind: AttentionItem['kind'], status: AttentionItem['status']): AttentionItem => ({
  id,
  kind,
  status,
  title: id,
  detail: '',
  targetId: id,
});

test('recordedProgress is null with no recorded jobs and counts only terminal states', () => {
  assert.equal(recordedProgress(undefined), null, 'no job records means nothing to show');
  assert.equal(recordedProgress([]), null);
  // COMPLETED, FAILED and CANCEL_ACKNOWLEDGED are the recorded terminals the lifecycle grid uses.
  assert.equal(recordedProgress([job('COMPLETED'), job('FAILED'), job('CANCEL_ACKNOWLEDGED')]), 1);
  assert.equal(recordedProgress([job('RUNNING'), job('SUBMITTING')]), 0);
  // UNKNOWN is a record without an outcome — it counts in the denominator, never the numerator.
  assert.equal(recordedProgress([job('COMPLETED'), job('UNKNOWN'), job('RUNNING'), job('INTENT')]), 0.25);
});

test('a dismissal resurfaces when the recorded kind or status changes', () => {
  const request = item('request:r1', 'request', 'needs');
  const stored = { 'request:r1': { ...dismissalFingerprint(request), dismissedAt: '2026-09-30T12:00:00.000Z' } };
  assert.deepEqual(splitAttention([request], stored).dismissed, [request], 'same fingerprint stays dismissed');
  const changed = splitAttention([{ ...request, status: 'stalled' }], stored);
  assert.equal(changed.dismissed.length, 0);
  assert.equal(changed.visible.length, 1, 'a recorded-status change puts the item back in view');
});

test('dismissal never hides an item that left and came back or was never recorded', () => {
  const request = item('request:r1', 'request', 'needs');
  const stored = { 'request:r2': { kind: 'request' as const, status: 'needs' as const, dismissedAt: 'x' } };
  // A different live id is its own item — an old record for an absent id dismisses nothing.
  assert.deepEqual(splitAttention([request], stored), { visible: [request], dismissed: [] });
  assert.equal(splitAttention([request], {}).dismissed.length, 0);
});

test('parseDismissed keeps well-formed records and drops everything malformed', () => {
  assert.deepEqual(parseDismissed(null), {});
  assert.deepEqual(parseDismissed('not json'), {});
  assert.deepEqual(parseDismissed('42'), {});
  const parsed = parseDismissed(
    JSON.stringify({
      'request:a': { kind: 'request', status: 'needs', dismissedAt: 't' },
      'agent:b': { kind: 'agent', status: 'stalled' },
      'bad:c': { kind: 'request' },
      'bad:d': 'nope',
    }),
  );
  assert.deepEqual(parsed, {
    'request:a': { kind: 'request', status: 'needs', dismissedAt: 't' },
    'agent:b': { kind: 'agent', status: 'stalled', dismissedAt: '' },
  });
});
