import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Assignment, ProviderJob, Request } from '../src/shared/types';
import type { QueueEntry } from '../src/shared/queue';
import type { RequestBucket, RequestSummary } from '../src/shared/request-summary';

// The component module imports its stylesheets for the bundler; Node can't load .css, so the
// unit-level import stubs them. This tests the real exported helpers, not a copy.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { attentionGroupOf, groupByAttention, requestTimeline } = await import('../src/renderer/queue');

const t0 = '2026-09-29T10:00:00Z';
const t1 = '2026-09-29T10:05:00Z';
const t2 = '2026-09-29T10:10:00Z';
const t3 = '2026-09-29T10:20:00Z';

const req = (patch: Partial<Request> = {}): Request =>
  ({
    id: 'r1',
    projectId: 'p1',
    name: 'Baseline study',
    status: 'READY',
    blockers: [],
    createdAt: t0,
    updatedAt: t0,
    ...patch,
  }) as Request;
const entryOf = (r: Request, id = r.id): QueueEntry =>
  ({ id, request: r, status: r.status, settled: false, root: { createdAt: t0, updatedAt: t0 } }) as unknown as QueueEntry;
const summaryOf = (bucket: RequestBucket, label: string, lastAt = t0): RequestSummary =>
  ({
    bucket,
    label,
    reason: '',
    steps: { done: 0, total: 0 },
    runningAgentIds: [],
    failedHops: 0,
    unknownHops: 0,
    lastAt,
  }) as RequestSummary;
const row = (id: string, bucket: RequestBucket, label: string, lastAt = t0) => ({
  entry: entryOf(req({ id }), id),
  summary: summaryOf(bucket, label, lastAt),
});
const hop = (id: string, pipelineKey: string | undefined, agentId = 'a1', createdAt = t1): Assignment =>
  ({ id, requestId: 'r1', agentId, pipelineKey, createdAt }) as Assignment;
const job = (assignmentId: string, patch: Partial<ProviderJob> = {}): ProviderJob =>
  ({
    id: 'j-' + assignmentId,
    assignmentId,
    state: 'RUNNING',
    evidence: 'PROVIDER_REPORTED',
    createdAt: t1,
    updatedAt: t2,
    dispatchedAt: t1,
    settledAt: '',
    attempt: 1,
    ...patch,
  }) as ProviderJob;
const agents = [{ id: 'a1', name: 'Test PM A' }] as never;

test('attentionGroupOf maps recorded buckets to attention classes, never inventing state', () => {
  assert.equal(attentionGroupOf(summaryOf('needs', 'Step failed')), 'needs');
  assert.equal(attentionGroupOf(summaryOf('needs', 'Decision needed')), 'awaiting');
  assert.equal(attentionGroupOf(summaryOf('needs', 'Brief ready')), 'awaiting');
  // Any other needs label stays with the urgent class — a new label can never hide as routine.
  assert.equal(attentionGroupOf(summaryOf('needs', 'Something unforeseen')), 'needs');
  assert.equal(attentionGroupOf(summaryOf('running', 'Running')), 'running');
  assert.equal(attentionGroupOf(summaryOf('queued', 'Draft')), 'drafts');
  assert.equal(attentionGroupOf(summaryOf('done', 'Approved')), 'settled');
  assert.equal(attentionGroupOf(summaryOf('canceled', 'Canceled')), 'settled');
});

test('groupByAttention orders needs > awaiting > running > drafts > settled and hides empty groups', () => {
  const groups = groupByAttention([
    row('done1', 'done', 'Completed'),
    row('draft1', 'queued', 'Draft'),
    row('await1', 'needs', 'Decision needed'),
    row('run1', 'running', 'Running'),
    row('fail1', 'needs', 'Step failed'),
    row('cancel1', 'canceled', 'Canceled'),
  ]);
  assert.deepEqual(
    groups.map(g => g.key),
    ['needs', 'awaiting', 'running', 'drafts', 'settled'],
  );
  assert.equal(groups.find(g => g.key === 'settled')!.rows.length, 2); // done + canceled settle together
});

test('groupByAttention sorts each group newest-first and drops empty classes', () => {
  const groups = groupByAttention([
    row('a', 'needs', 'Step failed', t1),
    row('b', 'needs', 'A job failed', t3),
    row('c', 'done', 'Approved'),
  ]);
  assert.deepEqual(
    groups.map(g => g.key),
    ['needs', 'settled'],
  );
  assert.deepEqual(
    groups[0].rows.map(r => r.entry.id),
    ['b', 'a'],
  );
});

test('requestTimeline walks minted → dispatched → observed → settled with honest provenance tags', () => {
  const events = requestTimeline(
    {
      agents,
      assignments: [hop('h1', 'plan-brief')],
      jobs: [job('h1', { state: 'COMPLETED', settledAt: t3 })],
      localSessions: [{ jobId: 'j-h1', lastReceipt: { sequence: 7, hash: 'x', observedAt: t2 } } as never],
    },
    entryOf(req()),
  );
  assert.deepEqual(
    events.map(e => e.provenance),
    ['office-observed', 'office-observed', 'office-observed', 'office-observed', 'provider-reported'],
  );
  assert.equal(events[0].label, 'Request minted');
  assert.equal(events.at(-1)!.label, 'Settled — completed');
  assert.equal(events.at(-1)!.at, t3);
  // The office-verified receipt is a distinct office-observed event, not a provider claim.
  assert.ok(events.some(e => e.label === 'Receipt 7 verified' && e.provenance === 'office-observed'));
  assert.ok(events.some(e => e.label.includes('plan-brief')));
});

test('requestTimeline marks a running job as observed, never as settled', () => {
  const events = requestTimeline(
    {
      agents,
      assignments: [hop('h1', undefined)],
      jobs: [job('h1', { state: 'RUNNING', settledAt: '' })],
      localSessions: [],
    },
    entryOf(req()),
  );
  assert.ok(events.some(e => e.label === 'Observed — running' && e.provenance === 'provider-reported'));
  assert.ok(!events.some(e => e.label.startsWith('Settled')));
});

test('requestTimeline shows a minted hop with no job on record — nothing invented', () => {
  const events = requestTimeline(
    { agents, assignments: [hop('h1', 'draft-a')], jobs: [], localSessions: [] },
    entryOf(req()),
  );
  assert.equal(events.length, 2); // request minted + hop minted
  assert.ok(events[1].label.includes('no provider job on record'));
  assert.ok(events.every(e => e.provenance === 'office-observed'));
});
