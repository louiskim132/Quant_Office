import test from 'node:test';
import assert from 'node:assert/strict';
import { pipelineReviewHops, projectJobOutputs } from '../src/renderer/job-outputs';
import type { AppState, Assignment, JobOutput, ProviderJob, Request } from '../src/shared/types';

const at = '2026-09-25T12:00:00.000Z';
const sha = (n: number) => n.toString(16).padStart(64, '0');
const out = (path: string, sha256: string, bytes: number, stored = true): JobOutput => ({
  path,
  sha256,
  bytes,
  ...(stored ? { stored: true as const } : {}),
});
const request = (id: string, projectId: string, name: string, pipeline = false): Request => ({
  id,
  projectId,
  experimentId: null,
  name,
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
  projectId: string,
  agentId: string,
  pipelineKey?: string,
): Assignment =>
  ({
    id,
    requestId,
    projectId,
    agentId,
    createdAt: at,
    ...(pipelineKey ? { pipelineKey } : {}),
  }) as Assignment;
const job = (
  id: string,
  assignmentId: string,
  projectId: string,
  requestId: string,
  outputs: JobOutput[],
  opts: Partial<ProviderJob> = {},
): ProviderJob => ({
  id,
  assignmentId,
  projectId,
  requestId,
  provider: 'claude',
  route: 'LOCAL_CLI_EXEC',
  state: 'COMPLETED',
  evidence: 'OFFICE_LOCAL',
  detail: '',
  externalId: '',
  externalUrl: '',
  outputs,
  revision: 1,
  createdAt: at,
  updatedAt: at,
  dispatchedAt: at,
  settledAt: at,
  ...opts,
});
const fixture = (jobs: ProviderJob[], assignments: Assignment[], requests: Request[]): AppState =>
  ({
    projects: [
      { id: 'p1', name: 'P1', archived: false },
      { id: 'p2', name: 'P2', archived: false },
    ],
    agents: [
      { id: 'a1', name: 'Director' },
      { id: 'a2', name: 'Worker' },
      { id: 'a3', name: 'Critic' },
    ],
    requests,
    assignments,
    jobs,
    tasks: [],
    experiments: [],
    artifacts: [],
    reviews: [],
    events: [],
  }) as unknown as AppState;

test('only durably stored outputs are listed — reported-but-unstored entries never appear', () => {
  const jobs = [job('j1', 'as1', 'p1', 'r1', [out('report.md', sha(1), 100), out('scratch.tmp', sha(2), 5, false)])];
  const groups = projectJobOutputs(
    fixture(jobs, [assignment('as1', 'r1', 'p1', 'a1', 'verify')], [request('r1', 'p1', 'Round', true)]),
    'p1',
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].hops[0].outputs.map(o => o.path),
    ['report.md'],
  );
});

test('identical bytes at the same path reported by two jobs collapse to one row under the first job', () => {
  const jobs = [
    job('j1', 'as1', 'p1', 'r1', [out('report.md', sha(1), 100)], { attempt: 1 }),
    job('j2', 'as1', 'p1', 'r1', [out('report.md', sha(1), 100), out('notes.md', sha(3), 40)], { attempt: 2 }),
  ];
  const groups = projectJobOutputs(
    fixture(jobs, [assignment('as1', 'r1', 'p1', 'a1', 'verify')], [request('r1', 'p1', 'Round', true)]),
    'p1',
  );
  const hop = groups[0].hops[0];
  assert.equal(hop.outputs.length, 2);
  assert.equal(
    hop.outputs.find(o => o.path === 'report.md')!.jobId,
    'j1',
    'the first job carrying the pair owns the row',
  );
  // Same path with different bytes is a different file, not a duplicate.
  const changed = [job('j3', 'as1', 'p1', 'r1', [out('report.md', sha(9), 200)])];
  const groups2 = projectJobOutputs(
    fixture(
      [...jobs, ...changed],
      [assignment('as1', 'r1', 'p1', 'a1', 'verify')],
      [request('r1', 'p1', 'Round', true)],
    ),
    'p1',
  );
  assert.equal(groups2[0].hops[0].outputs.length, 3);
});

test('outputs group request -> hop with agent, path, size and hash on each row', () => {
  const jobs = [
    job('j1', 'as1', 'p1', 'r1', [out('critique.md', sha(1), 10)]),
    job('j2', 'as2', 'p1', 'r1', [out('verify.md', sha(2), 20)]),
    job('j3', 'as3', 'p1', 'r2', [out('brief.md', sha(3), 30)]),
  ];
  const groups = projectJobOutputs(
    fixture(
      jobs,
      [
        assignment('as1', 'r1', 'p1', 'a3', 'plan-critique-a-on-b'),
        assignment('as2', 'r1', 'p1', 'a1', 'verify'),
        assignment('as3', 'r2', 'p1', 'a2'),
      ],
      [request('r1', 'p1', 'Planning round', true), request('r2', 'p1', 'Single dispatch')],
    ),
    'p1',
  );
  assert.equal(groups.length, 2);
  const round = groups.find(g => g.requestName === 'Planning round')!;
  assert.deepEqual(
    round.hops.map(h => h.pipelineKey),
    ['plan-critique-a-on-b', 'verify'],
  );
  assert.equal(round.hops[0].agentName, 'Critic');
  const single = groups.find(g => g.requestName === 'Single dispatch')!;
  assert.equal(single.hops[0].pipelineKey, null, 'a direct dispatch groups under its assignment');
  assert.equal(single.hops[0].key, 'as3');
});

test('a job in another project is excluded, and a removed request still groups honestly', () => {
  const jobs = [
    job('j1', 'as1', 'p1', 'r1', [out('report.md', sha(1), 10)]),
    job('j2', 'as2', 'p2', 'r3', [out('other.md', sha(4), 10)]),
  ];
  const groups = projectJobOutputs(
    fixture(
      jobs,
      [assignment('as1', 'r1', 'p1', 'a1', 'verify'), assignment('as2', 'r3', 'p2', 'a1', 'verify')],
      [request('r1', 'p1', 'Round', true), request('r3', 'p2', 'Elsewhere', true)],
    ),
    'p1',
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].requestId, 'r1');
  // A job whose request record is gone still lists under 'Removed request' rather than vanishing.
  const orphaned = projectJobOutputs(
    fixture(
      jobs,
      [assignment('as1', 'r1', 'p1', 'a1', 'verify'), assignment('as2', 'r3', 'p2', 'a1', 'verify')],
      [request('r3', 'p2', 'Elsewhere', true)],
    ),
    'p1',
  );
  assert.equal(orphaned[0].requestName, 'Removed request');
});

test('pipelineReviewHops lists critique/falsify/response/verify hops with state and stored outputs only', () => {
  const requests = [request('r1', 'p1', 'Planning round', true), request('r2', 'p1', 'Not a pipeline')];
  const assignments = [
    assignment('as1', 'r1', 'p1', 'a3', 'plan-critique-a-on-b'),
    assignment('as2', 'r1', 'p1', 'a2', 'plan-draft-a'),
    assignment('as3', 'r1', 'p1', 'a1', 'verify'),
    assignment('as4', 'r1', 'p1', 'a1', 'analysis-falsify'),
    assignment('as5', 'r2', 'p1', 'a1', 'verify'), // pipelineKey on a non-pipeline request is not a pipeline review
  ];
  const jobs = [
    job('j1', 'as1', 'p1', 'r1', [out('critique.md', sha(1), 10), out('draft.tmp', sha(2), 1, false)]),
    job('j2', 'as3', 'p1', 'r1', [], { state: 'RUNNING', lastObservation: 'Verifying the candidate' }),
    job('j3', 'as5', 'p1', 'r2', [out('v.md', sha(5), 5)]),
  ];
  const groups = pipelineReviewHops(fixture(jobs, assignments, requests), 'p1');
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].hops.map(h => h.pipelineKey),
    ['plan-critique-a-on-b', 'verify', 'analysis-falsify'],
    'production hops and non-pipeline requests are excluded',
  );
  assert.deepEqual(
    groups[0].hops[0].outputs.map(o => o.path),
    ['critique.md'],
    'unstored outputs are not previewable',
  );
  assert.equal(groups[0].hops[1].state, 'RUNNING');
  assert.equal(groups[0].hops[1].detail, 'Verifying the candidate');
  assert.equal(groups[0].hops[2].state, null, 'a minted hop with no job is recorded-but-undispatched');
});

test('a canceled request still lists every durably stored output it produced, marked canceled', () => {
  const jobs = [
    job('j1', 'as1', 'p1', 'r1', [out('report.md', sha(1), 100)], { state: 'COMPLETED' }),
    // Office-terminated mid-run: the file it reported was never fetched or stored.
    job('j2', 'as2', 'p1', 'r1', [out('draft.md', sha(2), 40, false)], { state: 'CANCEL_ACKNOWLEDGED' }),
  ];
  const requests = [{ ...request('r1', 'p1', 'Round', true), status: 'CANCELED' as const }];
  const groups = projectJobOutputs(
    fixture(
      jobs,
      [assignment('as1', 'r1', 'p1', 'a1', 'verify'), assignment('as2', 'r1', 'p1', 'a2', 'plan-draft-a')],
      requests,
    ),
    'p1',
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].requestName, 'Round', "the record is kept under the request's own name");
  assert.equal(groups[0].requestStatus, 'CANCELED');
  assert.deepEqual(
    groups[0].hops.map(h => h.pipelineKey),
    ['verify'],
    'the terminated hop contributes nothing it did not durably store',
  );
  assert.deepEqual(
    groups[0].hops[0].outputs.map(o => o.path),
    ['report.md'],
  );
});

test('a superseded attempt keeps its stored bytes labeled attempt 1; re-stored bytes are not marked', () => {
  const jobs = [
    job('j1', 'as1', 'p1', 'r1', [out('report.md', sha(1), 100), out('notes.md', sha(3), 40)], {
      attempt: 1,
      state: 'FAILED',
    }),
    job('j2', 'as1', 'p1', 'r1', [out('report.md', sha(9), 200), out('notes.md', sha(3), 40)], {
      attempt: 2,
      state: 'COMPLETED',
    }),
  ];
  const groups = projectJobOutputs(
    fixture(jobs, [assignment('as1', 'r1', 'p1', 'a1', 'verify')], [request('r1', 'p1', 'Round', true)]),
    'p1',
  );
  const outputs = groups[0].hops[0].outputs;
  const report1 = outputs.find(o => o.sha256 === sha(1))!;
  const report2 = outputs.find(o => o.sha256 === sha(9))!;
  const notes = outputs.find(o => o.sha256 === sha(3))!;
  assert.equal(report1.attempt, 1);
  assert.equal(report1.superseded, true, 'bytes a newer attempt replaced stay listed, marked superseded');
  assert.equal(report2.attempt, 2);
  assert.equal(report2.superseded, false);
  assert.equal(notes.attempt, 1, 'the first storing attempt keeps provenance');
  assert.equal(notes.superseded, false, 'identical bytes re-stored by attempt 2 are still the current output');
});

test("pipelineReviewHops reports the latest attempt and only that attempt's stored outputs", () => {
  const requests = [request('r1', 'p1', 'Planning round', true)];
  const assignments = [assignment('as1', 'r1', 'p1', 'a3', 'plan-critique-a-on-b')];
  const jobs = [
    job('j1', 'as1', 'p1', 'r1', [out('critique-v1.md', sha(1), 10)], { attempt: 1, state: 'FAILED' }),
    job('j2', 'as1', 'p1', 'r1', [out('critique.md', sha(2), 20)], { attempt: 2, state: 'COMPLETED' }),
  ];
  const groups = pipelineReviewHops(fixture(jobs, assignments, requests), 'p1');
  const hop = groups[0].hops[0];
  assert.equal(hop.attempt, 2);
  assert.equal(hop.state, 'COMPLETED');
  assert.deepEqual(
    hop.outputs.map(o => o.path),
    ['critique.md'],
    "a superseded attempt's outputs stay under Artifacts, not here",
  );
});
