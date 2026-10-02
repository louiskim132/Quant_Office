import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../src/shared/types';
import type { OfficeActivity } from '../src/shared/activity';
import { locate, projectDeskAgents, shouldRest } from '../src/renderer/office3d/visuals';

test('running projects bring their related agents to desks without inventing individual work', () => {
  const state = {
    agents: [],
    requests: [
      {
        id: 'r1',
        projectId: 'p1',
        status: 'READY',
        participantIds: ['runner', 'waiting'],
        leadAgentId: 'lead',
        teamId: 't1',
      },
      { id: 'r2', projectId: 'p1', status: 'READY', participantIds: ['other-request'] },
      { id: 'r3', projectId: 'p2', status: 'READY', participantIds: ['unrelated'] },
      { id: 'r4', projectId: 'p1', status: 'CANCELED', participantIds: ['cancelled'] },
      { id: 'r5', projectId: 'p1', status: 'READY', removedAt: 'removed', participantIds: ['removed'] },
    ],
    teams: [
      { id: 't1', projectId: null, archived: false },
      { id: 't2', projectId: 'p1', archived: false },
      { id: 't3', projectId: 'p2', archived: false },
      { id: 't4', projectId: 'p1', archived: true },
    ],
    memberships: [
      { teamId: 't1', agentId: 'request-team' },
      { teamId: 't2', agentId: 'project-team' },
      { teamId: 't3', agentId: 'unrelated-team' },
      { teamId: 't4', agentId: 'archived-team' },
      { teamId: 't2', agentId: 'ex-member', removedAt: 'removed' },
    ],
    assignments: [{ agentId: 'assigned', projectId: 'p1', requestId: 'r2' }],
  } as unknown as AppState;
  const activity = [{ agentId: 'runner', requestId: 'r1', kind: 'WORKING' }] as OfficeActivity[];
  assert.deepEqual(
    [...projectDeskAgents(state, activity)].sort(),
    ['runner', 'waiting', 'lead', 'other-request', 'request-team', 'project-team', 'assigned'].sort(),
  );
  assert.equal(shouldRest(projectDeskAgents(state, activity).has('waiting'), 70), false);
  assert.deepEqual([...projectDeskAgents(state, [{ ...activity[0], kind: 'UNKNOWN' }])], []);
  assert.deepEqual([...projectDeskAgents(state, [{ ...activity[0], kind: 'IDLE' }])], []);
  assert.ok(projectDeskAgents(state, [{ ...activity[0], kind: 'MEETING' }]).has('waiting'));
});

test('rest overrides meetings at the allowance boundary and preserves the home desk', () => {
  const meeting = { agentId: 'a', kind: 'MEETING' as const, meetingId: 'm' };
  const desks = new Map([['a', 3]]);
  assert.deepEqual(locate({ id: 'a' }, desks, meeting, ['m'], new Map(), ['a']), { kind: 'rest', spot: 0 });
  assert.deepEqual(locate({ id: 'a' }, desks, meeting, ['m'], new Map()), { kind: 'room', index: 0, seat: 0 });
  assert.deepEqual(locate({ id: 'a' }, desks, undefined, [], new Map()), { kind: 'desk', index: 3 });
});
