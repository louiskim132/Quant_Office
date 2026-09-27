import test from 'node:test';
import assert from 'node:assert/strict';
import { queueScope } from '../src/shared/queue';
import type { AppState, RequestPipeline } from '../src/shared/types';

const at = '2026-09-24T12:00:00.000Z';
function state(pipeline: RequestPipeline | undefined, jobStates: string[]) {
  const request = {
    id: 'r1',
    projectId: 'p1',
    experimentId: null,
    name: 'Planning',
    objective: 'o',
    workType: 'PLANNING',
    mode: 'SINGLE',
    leadAgentId: 'a1',
    participantIds: [],
    acceptanceCriteria: '',
    status: 'READY',
    blockers: [],
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...(pipeline ? { pipeline } : {}),
  };
  return {
    tasks: [],
    experiments: [],
    agents: [],
    memberships: [],
    projects: [{ id: 'p1', name: 'P', archived: false }],
    requests: [request],
    assignments: jobStates.map((_, i) => ({ id: `as${i}`, requestId: 'r1', agentId: 'a1', projectId: 'p1' })),
    jobs: jobStates.map((s, i) => ({
      id: `j${i}`,
      assignmentId: `as${i}`,
      state: s,
      evidence: 'OFFICE_LOCAL',
      externalId: '',
    })),
  } as unknown as AppState;
}

test('a pipeline whose only minted hop (the brief) completed is still active, not completed', () => {
  const scope = queueScope(
    state({ kind: 'PLANNING', specHash: null, phase: 'BRIEFING', briefAssignmentId: 'as0' }, ['COMPLETED']),
  );
  assert.equal(scope.counts.active, 1, 'the user still has to confirm the brief and launch the arms');
  assert.equal(scope.counts.completed, 0);
  assert.equal(
    queueScope(
      state({ kind: 'PLANNING', specHash: 'h', phase: 'LAUNCHED', briefAssignmentId: 'as0' }, [
        'COMPLETED',
        'COMPLETED',
      ]),
      { lifecycle: 'ACTIVE' },
    ).entries.length,
    1,
  );
});

test('a decided pipeline with every hop settled is completed', () => {
  const scope = queueScope(
    state({ kind: 'PLANNING', specHash: 'h', phase: 'DECIDED', briefAssignmentId: 'as0' }, ['COMPLETED', 'COMPLETED']),
  );
  assert.equal(scope.counts.completed, 1);
  assert.equal(scope.counts.active, 0);
});

test('a non-pipeline request still completes when its jobs settle', () => {
  const scope = queueScope(state(undefined, ['COMPLETED']));
  assert.equal(scope.counts.completed, 1);
});

test('office-spawned launch evidence is bounded to the store field limits', async () => {
  const { boundEvidence } = await import('../src/main/controller');
  const long = 'x'.repeat(5000);
  const bounded = boundEvidence({
    operation: 'TOOL_CONFINEMENT',
    level: 'ACCOUNT_VERIFIED',
    detail: long,
    confinement: { tools: long, filesystem: 'fs', network: long, environment: 'env' },
  });
  assert.equal(bounded.detail.length, 1000);
  assert.equal(bounded.confinement!.tools.length, 400);
  assert.equal(bounded.confinement!.filesystem, 'fs');
  assert.equal(bounded.confinement!.network.length, 400);
});
