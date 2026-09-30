import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { ProviderJob, Request } from '../src/shared/types';

// research.tsx imports its stylesheet for the bundler; Node has no css loader, so the unit-level
// import stubs it — this tests the component module's real helpers, not a copy.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { requestLifecycle, provenanceTag } = await import('../src/renderer/research');

const request = (over: Partial<Request> = {}): Request => ({
  id: 'r1',
  projectId: 'p1',
  experimentId: null,
  name: 'Volatility probe',
  objective: 'Estimate the spread.',
  workType: 'EXPERIMENT',
  mode: 'SINGLE',
  leadAgentId: null,
  participantIds: [],
  acceptanceCriteria: '',
  revision: 1,
  status: 'READY',
  blockers: [],
  delegation: false,
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  ...over,
});

const job = (over: Partial<ProviderJob> = {}): ProviderJob => ({
  id: 'j1',
  assignmentId: 'a1',
  projectId: 'p1',
  requestId: 'r1',
  provider: 'claude',
  route: 'OFFICIAL_CLI_PTY',
  state: 'RUNNING',
  evidence: 'PROVIDER_REPORTED',
  detail: '',
  externalId: 'ext-1',
  externalUrl: '',
  outputs: [],
  revision: 1,
  createdAt: '2026-09-30T10:01:00.000Z',
  updatedAt: '2026-09-30T10:05:00.000Z',
  dispatchedAt: '2026-09-30T10:02:00.000Z',
  settledAt: '',
  ...over,
});

test('provenanceTag names who stands behind a recorded state', () => {
  assert.equal(provenanceTag('PROVIDER_REPORTED'), 'provider-reported');
  assert.equal(provenanceTag('USER_REPORTED'), 'user-reported');
  assert.equal(provenanceTag('OFFICE_LOCAL'), 'office-observed');
  assert.equal(provenanceTag(undefined), 'office-observed');
});

test('a request with no job shows minted only — nothing is inferred past the record', () => {
  const steps = requestLifecycle(request(), '2026-09-30T10:00:00.000Z', undefined);
  assert.deepEqual(
    steps.map(s => s.key),
    ['minted', 'dispatched', 'observed', 'settled'],
  );
  assert.equal(steps[0].at, '2026-09-30T10:00:00.000Z');
  assert.equal(steps[0].source, 'office-observed');
  for (const step of steps.slice(1)) {
    assert.equal(step.at, null);
    assert.equal(step.pending, 'No provider job on record');
  }
});

test('a running provider-reported job is dispatched and observed, never settled', () => {
  const steps = requestLifecycle(request(), 'x', job({ lastObservation: 'turn 3 of 12' }));
  assert.equal(steps[1].at, '2026-09-30T10:02:00.000Z');
  assert.equal(steps[2].label, 'Observed running');
  assert.equal(steps[2].at, '2026-09-30T10:05:00.000Z');
  assert.equal(steps[2].source, 'provider-reported');
  assert.equal(steps[2].detail, 'turn 3 of 12');
  assert.equal(steps[3].at, null);
  assert.equal(steps[3].pending, 'No settled outcome on record');
});

test('a failed job settles with the provider-reported tag and its recorded time', () => {
  const steps = requestLifecycle(
    request(),
    'x',
    job({ state: 'FAILED', settledAt: '2026-09-30T10:20:00.000Z', updatedAt: '2026-09-30T10:20:00.000Z' }),
  );
  assert.equal(steps[3].label, 'Settled: failed');
  assert.equal(steps[3].at, '2026-09-30T10:20:00.000Z');
  assert.equal(steps[3].source, 'provider-reported');
});

test('an undispatched job never reads as observed; attempt detail rides on dispatch', () => {
  const steps = requestLifecycle(request(), 'x', job({ state: 'INTENT', dispatchedAt: '', attempt: 2 }));
  assert.equal(steps[1].at, null);
  assert.equal(steps[1].detail, 'attempt 2');
  assert.equal(steps[2].at, null);
  assert.equal(steps[2].pending, 'Nothing dispatched to observe');
});

test('office-local evidence tags the observed stage as office-observed', () => {
  const steps = requestLifecycle(request(), 'x', job({ evidence: 'OFFICE_LOCAL' }));
  assert.equal(steps[2].source, 'office-observed');
});
