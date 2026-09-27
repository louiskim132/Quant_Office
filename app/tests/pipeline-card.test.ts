import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { ProviderJob } from '../src/shared/types';

// The component module imports its stylesheets for the bundler; Node can't load .css, so the
// unit-level import stubs them. This tests the card's real helpers, not a copy.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { pipelineHopRetryable, observeDisabledReason, previewCaption } = await import('../src/renderer/pipeline-card');

const job = (state: ProviderJob['state']) => ({ state }) as ProviderJob;
const bound = { lastReceipt: { sequence: 1, hash: 'a'.repeat(64), observedAt: '2026-09-25T12:00:00.000Z' } };

test('a dead brief in BRIEFING shows Retry; DECIDED and AWAITING_DECISION never do', () => {
  // The store's gate refuses only the two decision phases — BRIEFING retries like LAUNCHED.
  assert.equal(
    pipelineHopRetryable('BRIEFING', job('FAILED'), undefined),
    true,
    'the stranded-brief case from acceptance',
  );
  assert.equal(pipelineHopRetryable('LAUNCHED', job('FAILED'), undefined), true);
  for (const phase of ['DECIDED', 'AWAITING_DECISION'] as const)
    assert.equal(
      pipelineHopRetryable(phase, job('FAILED'), undefined),
      false,
      `${phase} is past the point where hops retry`,
    );
});

test('an UNKNOWN hop retries only while its binding carries no verified receipt', () => {
  assert.equal(pipelineHopRetryable('BRIEFING', job('UNKNOWN'), undefined), true);
  assert.equal(pipelineHopRetryable('LAUNCHED', job('UNKNOWN'), { lastReceipt: null }), true);
  assert.equal(
    pipelineHopRetryable('BRIEFING', job('UNKNOWN'), bound),
    false,
    'a verified receipt means an outcome exists — observe it, never rerun past it',
  );
  assert.equal(pipelineHopRetryable('DECIDED', job('UNKNOWN'), undefined), false);
});

test('live, settled and missing jobs never offer Retry', () => {
  for (const phase of ['BRIEFING', 'LAUNCHED'] as const)
    for (const state of [
      'INTENT',
      'SUBMITTING',
      'ACCEPTED',
      'RUNNING',
      'COMPLETED',
      'CANCEL_ACKNOWLEDGED',
      'CANCEL_REQUESTED',
    ] as const)
      assert.equal(pipelineHopRetryable(phase, job(state), undefined), false, `${phase}/${state}`);
  assert.equal(pipelineHopRetryable('BRIEFING', undefined, undefined), false, 'no job — nothing to retry');
});

test('observe is disabled with the honest reason for INTENT, SUBMITTING and no job', () => {
  for (const state of ['INTENT', 'SUBMITTING'] as const)
    assert.match(observeDisabledReason(job(state))!, /nothing dispatched/i, `${state} names why`);
  assert.match(observeDisabledReason(undefined)!, /nothing dispatched/i, 'a hop with no job record says so');
  for (const state of [
    'ACCEPTED',
    'RUNNING',
    'UNKNOWN',
    'FAILED',
    'COMPLETED',
    'CANCEL_REQUESTED',
    'CANCEL_ACKNOWLEDGED',
  ] as const)
    assert.equal(observeDisabledReason(job(state)), undefined, `${state} is observable`);
});

test('the preview caption claims verified only when the response flag says so', () => {
  assert.equal(previewCaption({ verified: true }), 'office-verified bytes');
  assert.equal(previewCaption({ verified: undefined }), 'output bytes', 'an absent flag claims nothing');
  assert.equal(previewCaption(undefined), 'output bytes');
});
