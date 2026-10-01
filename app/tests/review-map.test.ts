import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { AppState, Assignment, JobOutput, ProviderJob, Request, ReviewDecision } from '../src/shared/types';
import type { PipelineRecord, StageContext } from '../src/shared/pipeline';

// review.tsx imports its stylesheets for the bundler; Node can't load .css, so the unit-level
// import stubs it. This tests the real Positions mapper, not a copy.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { requestReviewLanes } = await import('../src/renderer/review');

const at = '2026-09-25T12:00:00.000Z';
const sha = (n: number) => n.toString(16).padStart(64, '0');
const out = (path: string, sha256: string, bytes: number, stored = true): JobOutput => ({
  path,
  sha256,
  bytes,
  ...(stored ? { stored: true as const } : {}),
});
const request = (id: string, pipeline = true): Request => ({
  id,
  projectId: 'p1',
  experimentId: null,
  name: `Request ${id}`,
  objective: 'o',
  workType: 'PLANNING',
  mode: 'SINGLE',
  leadAgentId: 'a1',
  participantIds: [],
  acceptanceCriteria: '',
  revision: 1,
  status: 'READY',
  blockers: [],
  delegation: false,
  createdAt: at,
  updatedAt: at,
  ...(pipeline
    ? { pipeline: { kind: 'PLANNING' as const, specHash: 's', phase: 'LAUNCHED' as const, briefAssignmentId: null } }
    : {}),
});
const assignment = (
  id: string,
  requestId: string,
  agentId: string,
  pipelineKey?: string,
  research?: Partial<StageContext>,
): Assignment =>
  ({
    id,
    requestId,
    projectId: 'p1',
    agentId,
    createdAt: at,
    ...(pipelineKey ? { pipelineKey } : {}),
    ...(research ? { research } : {}),
  }) as Assignment;
const job = (id: string, assignmentId: string, requestId: string, opts: Partial<ProviderJob> = {}): ProviderJob => ({
  id,
  assignmentId,
  projectId: 'p1',
  requestId,
  provider: 'claude',
  route: 'LOCAL_CLI_EXEC',
  state: 'COMPLETED',
  evidence: 'OFFICE_LOCAL',
  detail: '',
  externalId: '',
  externalUrl: '',
  outputs: [],
  revision: 1,
  createdAt: at,
  updatedAt: at,
  dispatchedAt: at,
  settledAt: at,
  ...opts,
});
const report = (id: string, assignmentId: string, verdict: 'SUPPORTS' | 'OPPOSES', opened = true): PipelineRecord =>
  ({
    id,
    kind: 'REVIEW_REPORT',
    projectId: 'p1',
    branchId: 'b1',
    createdAt: at,
    assignmentId,
    stage: 'S7',
    verdict,
    defectFound: verdict === 'OPPOSES',
    opened,
    independence: 'SEPARATE_SESSION_UNVERIFIED',
    detail: 'd',
  }) as PipelineRecord;
const decision = (
  id: string,
  requestId: string,
  reviewerAssignmentId: string,
  verdict: ReviewDecision['verdict'],
  phase: ReviewDecision['phase'] = 'FIRST',
): ReviewDecision =>
  ({ id, projectId: 'p1', requestId, reviewerAssignmentId, verdict, phase, createdAt: at }) as ReviewDecision;
const state = (parts: Partial<AppState>): AppState =>
  ({
    projects: [{ id: 'p1', name: 'P1', archived: false }],
    agents: [
      { id: 'a1', name: 'PM A' },
      { id: 'a2', name: 'PM D' },
      { id: 'a3', name: 'Advocate' },
    ],
    tasks: [],
    experiments: [],
    artifacts: [],
    reviews: [],
    events: [],
    ...parts,
  }) as unknown as AppState;

test("a request's review hops lay into per-function lanes; production hops stay out", () => {
  const s = state({
    requests: [request('r1')],
    assignments: [
      assignment('as1', 'r1', 'a1', 'plan-draft-a'),
      assignment('as2', 'r1', 'a1', 'plan-critique-a-on-b'),
      assignment('as3', 'r1', 'a2', 'analysis-falsify'),
      assignment('as4', 'r1', 'a2', 'analysis-response-falsify'),
      assignment('as5', 'r1', 'a1', 'verify'),
      assignment('as6', 'r1', 'a3', undefined, { function: 'ADVOCATE', stage: 'S7' }),
      assignment('as7', 'r1', 'a3', undefined, { function: 'DIRECTOR', stage: 'S7' }),
      assignment('as8', 'r2', 'a1', 'plan-critique-a-on-b'),
    ],
  });
  const lanes = requestReviewLanes(s, 'r1');
  assert.deepEqual(
    lanes.map(lane => lane.function),
    ['CRITIQUE', 'FALSIFICATION', 'RESPONSE', 'VERIFICATION', 'ADVOCATE'],
    'lanes keep mint order and the research hop lands in its recorded stage-function lane',
  );
  assert.equal(lanes.flatMap(lane => lane.hops).length, 5);
  assert.equal(
    lanes.find(lane => lane.function === 'CRITIQUE')!.hops[0].assignmentId,
    'as2',
    'plan-draft-a is production, not review — excluded',
  );
});

test('each hop carries its latest recorded job state and stored outputs only', () => {
  const s = state({
    requests: [request('r1')],
    assignments: [assignment('as1', 'r1', 'a1', 'verify'), assignment('as2', 'r1', 'a2', 'analysis-falsify')],
    jobs: [
      job('j1', 'as1', 'r1', { state: 'FAILED', attempt: 1, createdAt: '2026-09-25T11:00:00.000Z' }),
      job('j2', 'as1', 'r1', {
        state: 'COMPLETED',
        attempt: 2,
        createdAt: '2026-09-25T12:30:00.000Z',
        outputs: [out('verification.md', sha(1), 90), out('scratch.tmp', sha(2), 4, false)],
      }),
    ],
  });
  const lanes = requestReviewLanes(s, 'r1');
  const verify = lanes.find(lane => lane.function === 'VERIFICATION')!.hops[0];
  assert.equal(verify.state, 'COMPLETED');
  assert.equal(verify.attempt, 2);
  assert.deepEqual(
    verify.outputs.map(o => o.path),
    ['verification.md'],
    'reported-but-unstored bytes never appear',
  );
  assert.equal(verify.outputs[0].jobId, 'j2', 'the preview link targets the job that stored the bytes');
  const falsify = lanes.find(lane => lane.function === 'FALSIFICATION')!.hops[0];
  assert.equal(falsify.state, null);
  assert.equal(falsify.attempt, null, 'a minted-but-undispatched hop is recorded without a job');
});

test('verdict chips repeat the recorded labels — sealed reports never leak their verdict', () => {
  const s = state({
    requests: [request('r1')],
    assignments: [
      assignment('as1', 'r1', 'a1', 'plan-critique-a-on-b'),
      assignment('as2', 'r1', 'a2', 'analysis-falsify'),
      assignment('as3', 'r1', 'a2', 'verify'),
    ],
    jobs: [job('j1', 'as1', 'r1'), job('j2', 'as2', 'r1'), job('j3', 'as3', 'r1')],
    pipeline: [report('rp1', 'as1', 'SUPPORTS'), report('rp2', 'as2', 'OPPOSES', false)],
    decisions: [
      decision('d1', 'r1', 'as1', 'APPROVED'),
      decision('d2', 'r1', 'as1', 'CHANGES_REQUESTED', 'REBUTTAL'),
      decision('d3', 'r1', 'as3', 'REJECTED'),
      decision('d4', 'r9', 'as1', 'APPROVED'), // belongs to another request — never leaks in
    ],
  });
  const lanes = requestReviewLanes(s, 'r1');
  const critique = lanes.find(lane => lane.function === 'CRITIQUE')!.hops[0];
  assert.deepEqual(
    critique.verdicts.map(v => v.text),
    ['supports', 'approved', 'rebuttal · changes requested'],
  );
  const falsify = lanes.find(lane => lane.function === 'FALSIFICATION')!.hops[0];
  assert.deepEqual(
    falsify.verdicts.map(v => v.text),
    ['sealed'],
    'the unopened report shows its record exists, not its verdict',
  );
  assert.equal(falsify.verdicts[0].tone, 'sealed');
  const verify = lanes.find(lane => lane.function === 'VERIFICATION')!.hops[0];
  assert.deepEqual(
    verify.verdicts.map(v => v.text),
    ['rejected'],
  );
});

test('a request with no review records returns empty lanes — the section can say so', () => {
  const s = state({
    requests: [request('r1'), request('r2', false)],
    assignments: [assignment('as1', 'r1', 'a1', 'implement-1'), assignment('as2', 'r1', 'a1', 'plan-brief')],
  });
  assert.deepEqual(requestReviewLanes(s, 'r1'), []);
  assert.deepEqual(requestReviewLanes(s, 'r2'), []);
  assert.deepEqual(requestReviewLanes(s, 'r-missing'), []);
});

test('hops with no verdict records carry an empty verdict list, not an invented one', () => {
  const s = state({
    requests: [request('r1')],
    assignments: [assignment('as1', 'r1', 'a1', 'analysis-falsify')],
    jobs: [job('j1', 'as1', 'r1', { state: 'RUNNING' })],
  });
  const hop = requestReviewLanes(s, 'r1')[0].hops[0];
  assert.deepEqual(hop.verdicts, []);
  assert.equal(hop.state, 'RUNNING');
});
