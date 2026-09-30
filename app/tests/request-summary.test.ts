import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRequest } from '../src/shared/request-summary';
import type { QueueEntry } from '../src/shared/queue';
import type { Assignment, ProviderJob, Request } from '../src/shared/types';

const at = '2026-09-29T10:00:00Z';
const request = (patch: Partial<Request> = {}): Request =>
  ({
    id: 'r1',
    projectId: 'p1',
    experimentId: null,
    name: 'Analyze sma5',
    objective: 'x',
    status: 'READY',
    blockers: [],
    createdAt: at,
    updatedAt: at,
    ...patch,
  }) as Request;
const hop = (id: string, key: string, agentId = 'a-' + id): Assignment =>
  ({ id, requestId: 'r1', agentId, pipelineKey: key }) as Assignment;
const job = (assignmentId: string, state: ProviderJob['state']): ProviderJob =>
  ({ id: 'j-' + assignmentId, assignmentId, state, createdAt: at, updatedAt: at, attempt: 1 }) as ProviderJob;
const entry = (r: Request, settled = false): QueueEntry =>
  ({ id: r.id, request: r, status: r.status, settled, root: { updatedAt: at } }) as unknown as QueueEntry;
const pipeline = (phase: NonNullable<Request['pipeline']>['phase'], extra: object = {}) =>
  ({ kind: 'PLANNING', specHash: null, phase, briefAssignmentId: 'h1', ...extra }) as NonNullable<Request['pipeline']>;

test('a sealed round waits on the user, and a decided one reports its outcome', () => {
  const waiting = summarizeRequest(
    { assignments: [hop('h1', 'plan-brief')], jobs: [job('h1', 'COMPLETED')], localSessions: [] },
    entry(request({ pipeline: pipeline('AWAITING_DECISION') })),
  );
  assert.equal(waiting.bucket, 'needs');
  assert.equal(waiting.label, 'Decision needed');
  const decided = summarizeRequest(
    { assignments: [hop('h1', 'plan-brief')], jobs: [job('h1', 'COMPLETED')], localSessions: [] },
    entry(request({ pipeline: pipeline('DECIDED', { decision: { decision: 'APPROVE' } }) }), true),
  );
  assert.equal(decided.bucket, 'done');
  assert.equal(decided.outcome, 'APPROVED');
  assert.equal(decided.steps.done, 1);
});

test('a finished brief needs confirmation; a running hop is running; a failed hop needs the user', () => {
  const briefed = summarizeRequest(
    { assignments: [hop('h1', 'plan-brief')], jobs: [job('h1', 'COMPLETED')], localSessions: [] },
    entry(request({ pipeline: pipeline('BRIEFING') })),
  );
  assert.equal(briefed.label, 'Brief ready');
  const running = summarizeRequest(
    {
      assignments: [hop('h1', 'plan-brief'), hop('h2', 'draft-a')],
      jobs: [job('h1', 'COMPLETED'), job('h2', 'RUNNING')],
      localSessions: [],
    },
    entry(request({ pipeline: pipeline('LAUNCHED') })),
  );
  assert.equal(running.bucket, 'running');
  assert.deepEqual(running.runningAgentIds, ['a-h2']);
  assert.deepEqual(running.steps, { done: 1, total: 2 });
  const failed = summarizeRequest(
    {
      assignments: [hop('h1', 'plan-brief'), hop('h2', 'draft-a')],
      jobs: [job('h1', 'COMPLETED'), job('h2', 'FAILED')],
      localSessions: [],
    },
    entry(request({ pipeline: pipeline('LAUNCHED') })),
  );
  assert.equal(failed.bucket, 'needs');
  assert.equal(failed.failedHops, 1);
});

test('canceled and not-yet-started requests are their own buckets', () => {
  const canceled = summarizeRequest(
    { assignments: [], jobs: [], localSessions: [] },
    entry(request({ status: 'CANCELED' })),
  );
  assert.equal(canceled.bucket, 'canceled');
  const draft = summarizeRequest({ assignments: [], jobs: [], localSessions: [] }, entry(request({ status: 'DRAFT' })));
  assert.equal(draft.bucket, 'queued');
  assert.equal(draft.label, 'Draft');
});
