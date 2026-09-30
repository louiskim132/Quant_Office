import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionItems } from '../src/shared/attention';
import type { OfficeActivity } from '../src/shared/activity';
import type { Agent, Assignment, ProviderJob, Request } from '../src/shared/types';

const at = '2026-09-29T10:00:00Z';
const base = (requests: Request[], assignments: Assignment[] = [], jobs: ProviderJob[] = []) => ({
  tasks: [],
  experiments: [],
  projects: [{ id: 'p1', archived: false }] as never,
  requests,
  assignments,
  jobs,
  localSessions: [],
  agents: [{ id: 'a1', name: 'Test worker 1' } as Agent],
});
const request = (patch: Partial<Request>): Request =>
  ({
    id: 'r1',
    projectId: 'p1',
    experimentId: null,
    name: 'Analyze sma5',
    objective: 'o',
    status: 'READY',
    blockers: [],
    createdAt: at,
    updatedAt: at,
    ...patch,
  }) as Request;

test('a sealed round and a stalled process are the only things that call for the user', () => {
  const sealed = request({
    pipeline: { kind: 'PLANNING', specHash: null, phase: 'AWAITING_DECISION', briefAssignmentId: null },
  });
  const running = request({
    id: 'r2',
    name: 'Quiet one',
    pipeline: { kind: 'PLANNING', specHash: null, phase: 'LAUNCHED', briefAssignmentId: null },
  });
  const stalled = { agentId: 'a1', kind: 'WORKING', stalled: true } as OfficeActivity;
  const items = attentionItems(base([sealed, running]), [stalled, { agentId: 'a2', kind: 'IDLE' } as OfficeActivity]);
  assert.deepEqual(
    items.map(i => [i.kind, i.status, i.targetId]),
    [
      ['request', 'needs', 'r1'],
      ['agent', 'stalled', 'a1'],
    ],
  );
  assert.match(items[0].detail, /Decision needed/);
});

test('nothing waiting means an empty list', () => {
  assert.deepEqual(attentionItems(base([request({})]), []), []);
});
