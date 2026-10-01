import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { AppState, ProviderJob, Request, ReviewDecision, ReviewReport } from '../src/shared/types';
import type { QueueEntry } from '../src/shared/queue';

// research.tsx imports its stylesheet for the bundler; Node can't load .css, so the unit-level
// import stubs it — the same trick request-form.test.ts uses for main.tsx.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { requestGridCells } = await import('../src/renderer/research');

const request = (id: string, over: Partial<Request> = {}): Request => ({
  id,
  projectId: 'p1',
  experimentId: null,
  name: `Request ${id}`,
  objective: 'objective',
  workType: 'PLANNING',
  mode: 'SINGLE',
  leadAgentId: null,
  participantIds: [],
  acceptanceCriteria: '',
  revision: 1,
  status: 'READY',
  blockers: [],
  delegation: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});
const job = (id: string, over: Partial<ProviderJob> = {}): ProviderJob => ({
  id,
  assignmentId: `a-${id}`,
  projectId: 'p1',
  requestId: 'r1',
  provider: 'openai',
  route: 'LOCAL_CLI_EXEC',
  state: 'RUNNING',
  evidence: 'OFFICE_LOCAL',
  detail: '',
  externalId: '',
  externalUrl: '',
  outputs: [],
  revision: 1,
  createdAt: '2026-01-02T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  dispatchedAt: '',
  settledAt: '',
  ...over,
});
const summary = (j: ProviderJob, over = {}) => ({
  jobId: j.id,
  assignmentId: j.assignmentId,
  agentId: 'a1',
  state: j.state,
  evidence: j.evidence,
  externalId: j.externalId,
  settled: ['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED'].includes(j.state),
  unresolved: !['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED'].includes(j.state),
  attempt: j.attempt ?? 1,
  ...over,
});
const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
  id: 'r1',
  root: {
    id: 'r1',
    projectId: 'p1',
    experimentId: null,
    prompt: 'objective',
    recipient: 'WORKER',
    status: 'BLOCKED',
    blocker: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  tasks: [],
  status: 'READY',
  active: true,
  settled: false,
  canCancel: true,
  deletable: false,
  request: request('r1'),
  ...over,
});
const state = (over: Partial<Pick<AppState, 'decisions' | 'jobs' | 'reviews'>> = {}) => ({
  decisions: [],
  jobs: [],
  reviews: [],
  ...over,
});

test('a request with no job record renders dashes, never invented provider state', () => {
  const cells = requestGridCells(entry(), state());
  assert.equal(cells.minted.text, 'ready');
  assert.equal(cells.dispatched.text, '—');
  assert.equal(cells.dispatched.title, 'No provider job on record');
  assert.equal(cells.terminal.text, '—');
  assert.equal(cells.reviewed.text, '—');
});

test('minted carries the recorded request status word', () => {
  assert.equal(requestGridCells(entry({ status: 'READY' }), state()).minted.text, 'ready');
  assert.equal(requestGridCells(entry({ status: 'BLOCKED' }), state()).minted.text, 'blocked');
  assert.equal(
    requestGridCells(entry({ request: request('r1', { status: 'CANCELED' }), status: 'CANCELED' }), state()).minted
      .text,
    'canceled',
  );
});

test('dispatched only reflects a recorded dispatchedAt, with the attempt number', () => {
  const j = job('j1', { dispatchedAt: '2026-01-02T01:00:00Z', attempt: 3 });
  const cells = requestGridCells(entry({ jobs: [summary(j)] }), state({ jobs: [j] }));
  assert.equal(cells.dispatched.text, 'dispatched · attempt 3');
  const noDispatch = job('j2', { dispatchedAt: '' });
  const undispatched = requestGridCells(entry({ jobs: [summary(noDispatch)] }), state({ jobs: [noDispatch] }));
  assert.equal(undispatched.dispatched.text, '—');
});

test('the terminal cell states the settled record and keeps its provenance tag', () => {
  const failed = job('j1', { state: 'FAILED', evidence: 'PROVIDER_REPORTED', settledAt: '2026-01-02T02:00:00Z' });
  const provider = requestGridCells(entry({ jobs: [summary(failed)] }), state({ jobs: [failed] }));
  assert.equal(provider.terminal.text, 'failed');
  assert.equal(provider.terminal.status, 'failed');
  assert.equal(provider.terminal.provenance, 'provider-reported');
  // The same recorded outcome under office observation is not presented as a provider claim.
  const local = job('j2', { state: 'FAILED', evidence: 'OFFICE_LOCAL', settledAt: '2026-01-02T02:00:00Z' });
  const office = requestGridCells(entry({ jobs: [summary(local)] }), state({ jobs: [local] }));
  assert.equal(office.terminal.provenance, 'office-observed');
  const user = job('j3', { state: 'COMPLETED', evidence: 'USER_REPORTED', settledAt: '2026-01-02T02:00:00Z' });
  const reported = requestGridCells(entry({ jobs: [summary(user)] }), state({ jobs: [user] }));
  assert.equal(reported.terminal.text, 'completed');
  assert.equal(reported.terminal.provenance, 'user-reported');
});

test('a running or unresolved job leaves the terminal stage at a dash', () => {
  const running = job('j1', { state: 'RUNNING' });
  assert.equal(requestGridCells(entry({ jobs: [summary(running)] }), state({ jobs: [running] })).terminal.text, '—');
  const unknown = job('j2', { state: 'UNKNOWN' });
  assert.equal(requestGridCells(entry({ jobs: [summary(unknown)] }), state({ jobs: [unknown] })).terminal.text, '—');
});

test('the unresolved attempt owns the row — an earlier failed attempt does not settle the cell', () => {
  const failedAttempt = job('j1', { state: 'FAILED', settledAt: '2026-01-02T02:00:00Z' });
  const runningAttempt = job('j2', { state: 'RUNNING', attempt: 2 });
  const cells = requestGridCells(
    entry({ jobs: [summary(failedAttempt), summary(runningAttempt)] }),
    state({ jobs: [failedAttempt, runningAttempt] }),
  );
  assert.equal(cells.terminal.text, '—');
  assert.equal(cells.terminal.title, 'No settled outcome on record');
});

test('reviewed shows the recorded gate, decision, verdict, or report — else a dash', () => {
  // Awaiting the user's recorded gate decision.
  const awaiting = request('r1', {
    pipeline: { kind: 'PLANNING', specHash: 's', phase: 'AWAITING_DECISION', briefAssignmentId: 'a' },
  });
  const gate = requestGridCells(entry({ request: awaiting }), state());
  assert.equal(gate.reviewed.text, 'Decision needed');
  assert.equal(gate.reviewed.status, 'needs');
  // A recorded user decision.
  const decided = request('r1', {
    pipeline: {
      kind: 'PLANNING',
      specHash: 's',
      phase: 'DECIDED',
      briefAssignmentId: 'a',
      decision: {
        decision: 'REVISE',
        note: null,
        specHash: 's',
        headReceiptHash: 'h',
        decidedAt: '2026-01-03T00:00:00Z',
      },
    },
  });
  assert.equal(requestGridCells(entry({ request: decided }), state()).reviewed.text, 'revision requested');
  // A reviewer verdict bound to this request's current revision.
  const decision2: ReviewDecision = {
    id: 'd1',
    projectId: 'p1',
    requestId: 'r1',
    requestRevision: 1,
    subjectAssignmentId: 'a1',
    subjectAgentId: 'ag1',
    reviewerAssignmentId: 'a2',
    reviewerAgentId: 'ag2',
    inputSnapshotId: 'snap',
    outputHashes: [],
    bundleHash: 'b',
    phase: 'FIRST',
    verdict: 'CHANGES_REQUESTED',
    rationale: 'r',
    createdAt: '2026-01-03T00:00:00Z',
  };
  assert.equal(requestGridCells(entry(), state({ decisions: [decision2] })).reviewed.text, 'changes requested');
  // A verdict on an older revision does not describe this revision.
  const stale = { ...decision2, requestRevision: 0 };
  assert.equal(
    requestGridCells(entry({ request: request('r1', { revision: 2 }) }), state({ decisions: [stale] })).reviewed.text,
    '—',
  );
  // A review report on the request's experiment, with no decision on record.
  const report: ReviewReport = {
    id: 'rev1',
    projectId: 'p1',
    experimentId: 'e1',
    role: 'WORKER',
    bundleHash: 'b',
    verdict: 'looks sound',
    content: 'c',
    disclosed: false,
    createdAt: '2026-01-03T00:00:00Z',
  };
  const withReport = requestGridCells(
    entry({ request: request('r1', { experimentId: 'e1' }) }),
    state({ reviews: [report] }),
  );
  assert.equal(withReport.reviewed.text, 'report recorded');
  // A legacy queue row carries no request — nothing is claimed.
  const legacy = requestGridCells(entry({ request: undefined, jobs: undefined }), state());
  assert.equal(legacy.reviewed.text, '—');
  assert.equal(legacy.reviewed.title, 'No request record');
});
