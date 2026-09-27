import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store';
import { chatEventText, officeChatPage } from '../src/shared/office-chat';
import type { Agent, Message } from '../src/shared/types';

function fixture(t: test.TestContext) {
  const store = new OfficeStore(':memory:');
  t.after(() => store.close());
  const now = new Date().toISOString();
  const agents: Agent[] = ['DIRECTOR', 'PM_A', 'WORKER'].map((role, i) => ({
    id: randomUUID(),
    name: `Agent ${i}`,
    role: role as Agent['role'],
    provider: 'claude',
    model: 'fixture',
    team: 'Research',
    instructions: '',
    account: 'test',
    createdAt: now,
    connectionVerifiedAt: now,
    execution: 'LOCAL',
  }));
  agents.forEach(a => store.addAgent(a));
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: randomUUID(),
    name: 'Chat fixture',
    mandate: 'Synthetic messages',
    budgetCents: 0,
  }).projects[0];
  const request = store.execute({
    type: 'request.create',
    idempotencyKey: randomUUID(),
    projectId: project.id,
    name: 'Plan',
    hypothesis: 'Plan',
    workType: 'QUESTION',
    mode: 'SINGLE',
    leadAgentId: agents[0].id,
    participantIds: [],
  }).requests![0];
  const send = (index: number) => {
    const message: Message = {
      id: randomUUID(),
      projectId: project.id,
      requestId: request.id,
      assignmentId: null,
      fromAgentId: agents[index % 2].id,
      toAgentId: agents[2].id,
      kind: 'HANDOFF',
      body: `Message ${index}`,
      scopeSnapshotId: null,
      scopeOutputHashes: [],
      sentAt: new Date(Date.UTC(2026, 8, 21, 10, index)).toISOString(),
      deliveredAt: '',
      receipt: '',
      evidence: 'PROVIDER_REPORTED',
    };
    store.recordMessage(message);
    return message;
  };
  return { store, agents, project, request, send };
}

test('office chat queries durable messages without exposing them in public state or changing history', t => {
  const f = fixture(t);
  f.send(0);
  const before = f.store.lineageTip();
  assert.deepEqual(OfficeStore.publicState(f.store.snapshot()).messages, []);
  const page = f.store.officeChatPage({ projectId: f.project.id });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].text, 'Message 0');
  assert.equal(page.entries[0].agentId, f.agents[0].id);
  assert.match(page.entries[0].label, /delivery unconfirmed/);
  assert.deepEqual(f.store.lineageTip(), before);
});

test('chat pages are scoped, newest first, stable across new arrivals and do not overlap', t => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) f.send(i);
  const first = f.store.officeChatPage({ projectId: f.project.id, limit: 5 });
  assert.equal(first.entries[0].text, 'Message 11');
  assert.ok(first.nextCursor);
  f.send(12);
  const second = f.store.officeChatPage({ projectId: f.project.id, cursor: first.nextCursor!, limit: 5 });
  assert.equal(second.entries[0].text, 'Message 6');
  assert.equal(new Set([...first.entries, ...second.entries].map(e => e.id)).size, 10);
  assert.throws(
    () => f.store.officeChatPage({ agentId: f.agents[0].id, cursor: first.nextCursor! }),
    /another conversation/,
  );
  assert.throws(() => f.store.officeChatPage({ cursor: '{broken' }), /malformed/);
  assert.equal(f.store.officeChatPage({ projectId: randomUUID() }).total, 0);
  const filtered = f.store.officeChatPage({ agentId: f.agents[1].id });
  assert.equal(filtered.entries.length, 6);
  assert.ok(filtered.entries.every(e => e.agentId === f.agents[1].id));
  assert.equal(f.store.officeChatPage({ requestId: randomUUID() }).total, 0);
});

test('CLI envelopes show speech and tool names but never thinking, credentials metadata, or raw JSON', () => {
  assert.equal(
    chatEventText(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'PRIVATE_REASONING' },
            { type: 'text', text: 'I am checking the handoff.' },
            { type: 'tool_use', name: 'Read', input: { path: 'private' } },
          ],
        },
      }),
    ),
    'I am checking the handoff.\nUsing Read',
  );
  assert.equal(
    chatEventText(JSON.stringify({ type: 'result', result: 'The report is ready.', modelUsage: { secret: 123 } })),
    'The report is ready.',
  );
  assert.equal(
    chatEventText(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } })),
    'Done',
  );
  assert.equal(
    chatEventText(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE_REASONING' } })),
    '',
  );
  assert.equal(
    chatEventText(
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'echo PRIVATE_ARGUMENT' } }),
    ),
    'Ran a shell command.',
  );
  assert.equal(chatEventText('{"partial":'), '');
  assert.equal(chatEventText('A plain visible update'), 'A plain visible update');
});

test('office-internal diagnostic events never reach the conversation feed', t => {
  const f = fixture(t),
    state = f.store.snapshot();
  const jobId = randomUUID(),
    assignmentId = randomUUID(),
    timestamp = new Date().toISOString();
  state.assignments = [{ id: assignmentId, agentId: f.agents[0].id } as NonNullable<typeof state.assignments>[number]];
  state.jobs = [
    {
      id: jobId,
      assignmentId,
      projectId: f.project.id,
      requestId: f.request.id,
      state: 'RUNNING',
      evidence: 'PROVIDER_REPORTED',
      detail: 'Working.',
      updatedAt: timestamp,
    } as NonNullable<typeof state.jobs>[number],
  ];
  const event = (externalId: string, text: string) => ({
    id: randomUUID(),
    jobId,
    externalId,
    cursor: '',
    kind: 'STATUS' as const,
    text,
    occurredAt: timestamp,
    receivedAt: timestamp,
    evidence: 'PROVIDER_REPORTED' as const,
  });
  // The diagnostics carry plainly visible text — only the externalId prefix keeps them out.
  state.jobEvents = [
    event('transport-evidence:session-open', 'transport bytes observed'),
    event('observe:cli-poll', 'poll detail observed'),
    event('observe-later-1', 'Kept — the prefix is anchored.'),
    event('agent-visible-1', 'A plainly visible update.'),
  ];
  const page = officeChatPage(state);
  const providerEntries = page.entries.filter(e => e.source === 'PROVIDER_EVENT');
  assert.deepEqual(
    providerEntries.map(e => e.text).sort(),
    ['A plainly visible update.', 'Kept — the prefix is anchored.'],
    'transport-evidence:/observe: bookkeeping stays in History, never in the conversation',
  );
});

test('provider messages are attributed to the assigned agent, retain provenance, and do not create outcomes', t => {
  const f = fixture(t),
    state = f.store.snapshot();
  const jobId = randomUUID(),
    assignmentId = randomUUID(),
    timestamp = new Date().toISOString();
  // A projection fixture: the page consumes existing records; it must not interpret speech as completion.
  state.assignments = [{ id: assignmentId, agentId: f.agents[2].id } as NonNullable<typeof state.assignments>[number]];
  state.jobs = [
    {
      id: jobId,
      assignmentId,
      projectId: f.project.id,
      requestId: f.request.id,
      state: 'UNKNOWN',
      evidence: 'OFFICE_LOCAL',
      detail: 'Awaiting receipt',
      updatedAt: timestamp,
    } as NonNullable<typeof state.jobs>[number],
  ];
  state.jobEvents = [
    {
      id: randomUUID(),
      jobId,
      externalId: 'visible-1',
      cursor: '',
      kind: 'MESSAGE',
      text: '{"type":"result","result":"All done"}',
      occurredAt: timestamp,
      receivedAt: timestamp,
      evidence: 'PROVIDER_REPORTED',
    },
  ];
  const page = officeChatPage(state);
  assert.equal(page.entries.find(e => e.kind === 'MESSAGE')?.agentId, f.agents[2].id);
  assert.equal(page.entries.find(e => e.kind === 'MESSAGE')?.evidence, 'PROVIDER_REPORTED');
  assert.equal(page.entries.find(e => e.source === 'OFFICE_STATUS')?.label, 'Awaiting a verified update');
  assert.equal(state.jobs[0].state, 'UNKNOWN');
});
