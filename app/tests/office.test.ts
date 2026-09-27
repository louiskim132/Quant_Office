import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store';
test('request creation is atomic and cancellation closes linked details and every open review', () => {
  const store = new OfficeStore(':memory:');
  try {
    const project = store.execute({
      type: 'project.create',
      idempotencyKey: randomUUID(),
      name: 'Test',
      mandate: '',
      budgetCents: 0,
    }).projects[0];
    const command = {
      type: 'request.create',
      idempotencyKey: randomUUID(),
      projectId: project.id,
      name: 'Request',
      hypothesis: 'Compare baselines',
    };
    const state = store.execute(command),
      exp = state.experiments[0];
    assert.equal(state.tasks[0].experimentId, exp.id);
    assert.equal(store.execute(command).tasks.length, 1);
    store.execute({ type: 'contract.submit', idempotencyKey: randomUUID(), experimentId: exp.id, expectedRevision: 0 });
    const canceled = store.execute({ type: 'task.cancel', idempotencyKey: randomUUID(), taskId: state.tasks[0].id });
    assert.equal(canceled.experiments[0].stage, 'CANCELED');
    assert.ok(canceled.tasks.every(t => t.status === 'CANCELED'));
    assert.throws(
      () =>
        store.execute({
          type: 'contract.save',
          idempotencyKey: randomUUID(),
          experimentId: exp.id,
          expectedRevision: 2,
          contract: exp.contract,
        }),
      /Canceled/,
    );
    assert.throws(
      () =>
        store.execute({
          type: 'contract.submit',
          idempotencyKey: randomUUID(),
          experimentId: exp.id,
          expectedRevision: 2,
        }),
      /Canceled/,
    );
    assert.throws(
      () =>
        store.execute({
          type: 'task.create',
          idempotencyKey: randomUUID(),
          projectId: project.id,
          experimentId: exp.id,
          prompt: 'Restart',
          recipient: 'DIRECTOR',
        }),
      /Canceled/,
    );
  } finally {
    store.close();
  }
});
test('agent removal is reversible and preserves profile history', () => {
  const store = new OfficeStore(':memory:');
  try {
    const id = randomUUID(),
      now = new Date().toISOString();
    store.addAgent({
      id,
      name: 'A',
      team: 'Research',
      role: 'DIRECTOR',
      provider: 'openai',
      model: 'test',
      instructions: '',
      account: 'test',
      createdAt: now,
      connectionVerifiedAt: now,
      execution: 'HOSTED_SETUP_REQUIRED',
    });
    store.execute({
      type: 'agent.update',
      idempotencyKey: randomUUID(),
      agentId: id,
      expectedRevision: 0,
      name: 'Renamed',
      team: 'Verification',
      role: 'PM_B',
      instructions: 'Check evidence',
    });
    const state = store.execute({ type: 'agent.remove', idempotencyKey: randomUUID(), agentId: id, removed: true });
    assert.ok(state.agents[0].removedAt);
    assert.equal(state.agents[0].name, 'Renamed');
    assert.ok(store.workLogs().some(l => l.text.includes('Archived')));
    assert.equal(
      store.execute({ type: 'agent.remove', idempotencyKey: randomUUID(), agentId: id, removed: false }).agents[0]
        .removedAt,
      undefined,
    );
  } finally {
    store.close();
  }
});
