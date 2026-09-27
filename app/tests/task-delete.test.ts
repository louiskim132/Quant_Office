import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OfficeStore } from '../src/core/store';
import { queueScope } from '../src/shared/queue';
import type { Agent } from '../src/shared/types';

const at = (index: number) => new Date(Date.UTC(2026, 8, 8, 16, 0, 0) + index * 1000).toISOString();

/**
 * task.delete only hides a terminal queue row. The underlying request/task records and every
 * lineage event stay intact: removal is a view change, never a rewrite of history.
 */
test('a canceled request leaves the queue and keeps its record and history', () => {
  const store = new OfficeStore(':memory:');
  try {
    const project = store.execute({
      type: 'project.create',
      idempotencyKey: randomUUID(),
      name: 'Test',
      mandate: '',
      budgetCents: 0,
    }).projects[0];
    const created = store.execute({
      type: 'request.create',
      idempotencyKey: randomUUID(),
      projectId: project.id,
      name: 'Request',
      hypothesis: 'Compare baselines',
      workType: 'QUESTION',
    });
    const request = created.requests![0];
    assert.equal(
      queueScope(created, { lifecycle: 'ALL' }).entries.some(e => e.id === request.id),
      true,
    );
    assert.equal(queueScope(created, { lifecycle: 'ALL' }).entries[0].deletable, false);
    // Open requests cannot be removed.
    assert.throws(
      () => store.execute({ type: 'task.delete', idempotencyKey: randomUUID(), taskId: request.id }),
      /completed or canceled/,
    );
    const canceled = store.execute({
      type: 'request.cancel',
      idempotencyKey: randomUUID(),
      requestId: request.id,
      expectedRevision: request.revision,
    });
    assert.equal(queueScope(canceled, { lifecycle: 'ALL' }).entries[0].deletable, true);
    // A stale revision is refused before removal.
    assert.throws(
      () =>
        store.execute({
          type: 'task.delete',
          idempotencyKey: randomUUID(),
          taskId: request.id,
          expectedRevision: request.revision + 9,
        }),
      /changed/,
    );
    const removed = store.execute({
      type: 'task.delete',
      idempotencyKey: randomUUID(),
      taskId: request.id,
      expectedRevision: canceled.requests![0].revision,
    });
    assert.ok(removed.requests![0].removedAt);
    assert.equal(removed.requests![0].status, 'CANCELED');
    // The row is gone from every queue scope while the record stays in state.
    for (const lifecycle of ['ACTIVE', 'COMPLETED', 'CANCELED', 'ALL'] as const)
      assert.equal(
        queueScope(removed, { lifecycle }).entries.some(e => e.id === request.id),
        false,
        lifecycle,
      );
    assert.ok(removed.requests!.some(r => r.id === request.id));
    // A second removal is refused.
    assert.throws(
      () => store.execute({ type: 'task.delete', idempotencyKey: randomUUID(), taskId: request.id }),
      /already removed/,
    );
    // Every event, including the removal itself, remains in history.
    const history = store.historyPage({ limit: 100 });
    assert.ok(history.entries.some(e => e.kind === 'TASK_DELETE'));
    assert.ok(history.entries.some(e => e.kind === 'REQUEST_CANCEL'));
    assert.ok(history.entries.some(e => e.kind === 'REQUEST_CREATE'));
  } finally {
    store.close();
  }
});

test('a canceled request with an unresolved provider job stays visible and cannot be removed', () => {
  const store = new OfficeStore(':memory:');
  try {
    const project = store.execute({
      type: 'project.create',
      idempotencyKey: randomUUID(),
      name: 'Test',
      mandate: '',
      budgetCents: 0,
    }).projects[0];
    const worker: Agent = {
      id: randomUUID(),
      name: 'Worker',
      provider: 'claude',
      model: 'opus',
      team: 'Research',
      role: 'WORKER',
      instructions: '',
      account: 'researcher@example.com',
      createdAt: at(0),
      connectionVerifiedAt: at(0),
      execution: 'HOSTED_SETUP_REQUIRED',
    };
    store.addAgent(worker);
    const request = store.execute({
      type: 'request.create',
      idempotencyKey: randomUUID(),
      projectId: project.id,
      name: 'Question',
      hypothesis: 'Ask',
      workType: 'QUESTION',
      mode: 'SINGLE',
      leadAgentId: worker.id,
      participantIds: [],
    }).requests![0];
    const snapshot = {
      id: randomUUID(),
      projectId: project.id,
      requestId: request.id,
      locationRevision: 0,
      requestRevision: request.revision,
      route: 'GENERATED_REQUEST_ONLY' as const,
      files: [],
      totalBytes: 0,
      manifestHash: '0'.repeat(64),
      stagingCommit: '',
      stagingPath: '',
      warnings: [],
      provenance: 'OFFICE_STAGED' as const,
      createdAt: at(0),
    };
    store.recordInputSnapshot(snapshot);
    const observation = {
      provider: 'claude' as const,
      identity: 'researcher@example.com',
      credentialContext: 'claude-code-cli',
      state: 'SIGNED_IN' as const,
      allowance: [],
      note: '',
      toolVersion: '2.1.236',
      transport: 'NONE' as const,
      environment: '',
      models: [{ id: 'opus', name: 'Opus' }],
      operations: [
        {
          operation: 'ACCOUNT_STATUS' as const,
          level: 'ACCOUNT_VERIFIED' as const,
          detail: 'ok',
          evidence: 'OBSERVED' as const,
          verifiedAt: at(0),
        },
      ],
      source: 'fixture',
      observedAt: at(0),
    };
    store.recordAccountObservation(observation);
    store.bindAgentConnection({
      agentId: worker.id,
      expectedRevision: 0,
      intent: 'VERIFY',
      observation: { ...observation, observedAt: at(1) },
    });
    const connection = store.snapshot().connections![0];
    const capability = store.snapshot().capabilities![0];
    const assignment = {
      id: randomUUID(),
      projectId: project.id,
      requestId: request.id,
      requestRevision: request.revision,
      agentId: worker.id,
      agentRevision: 1,
      connectionId: connection.id,
      capabilitySnapshotId: capability.id,
      snapshotId: snapshot.id,
      route: 'FAKE_ADAPTER' as const,
      requestedModel: 'opus',
      resolvedModel: '',
      requestedEffort: 'default' as const,
      appliedEffort: 'UNVERIFIED' as const,
      delegation: false,
      objectiveHash: '0'.repeat(64),
      createdAt: at(1),
    };
    store.createAssignment({
      assignment,
      job: {
        id: randomUUID(),
        assignmentId: assignment.id,
        projectId: project.id,
        requestId: request.id,
        provider: 'claude',
        route: 'FAKE_ADAPTER',
      },
    });
    // Move the job to SUBMITTING: dispatched work whose outcome the office never saw is unresolved,
    // and canceling the request cannot settle it.
    const job = store.snapshot().jobs![0];
    store.recordJobTransition({
      jobId: job.id,
      expectedRevision: job.revision,
      to: 'SUBMITTING',
      evidence: 'OFFICE_LOCAL',
      detail: 'Submission in flight.',
      at: at(2),
    });
    const canceled = store.execute({
      type: 'request.cancel',
      idempotencyKey: randomUUID(),
      requestId: request.id,
      expectedRevision: request.revision,
    });
    const entry = queueScope(canceled, { lifecycle: 'ALL' }).entries.find(e => e.id === request.id)!;
    assert.equal(entry.status, 'CANCELED');
    assert.equal(entry.deletable, false, 'an unresolved provider outcome keeps the row non-deletable');
    // The unresolved outcome also keeps the canceled row in the default active view rather than
    // letting it vanish before it is reconciled.
    assert.equal(entry.active, true);
    assert.equal(
      queueScope(canceled, { lifecycle: 'ACTIVE' }).entries.some(e => e.id === request.id),
      true,
    );
    assert.throws(
      () =>
        store.execute({
          type: 'task.delete',
          idempotencyKey: randomUUID(),
          taskId: request.id,
          expectedRevision: canceled.requests![0].revision,
        }),
      /unresolved/,
    );
  } finally {
    store.close();
  }
});

test('a job-side cancel acknowledgment terminalizes the request, its experiment, and its review tasks', () => {
  const store = new OfficeStore(':memory:');
  try {
    const project = store.execute({
      type: 'project.create',
      idempotencyKey: randomUUID(),
      name: 'Test',
      mandate: '',
      budgetCents: 0,
    }).projects[0];
    const worker: Agent = {
      id: randomUUID(),
      name: 'Worker',
      provider: 'claude',
      model: 'opus',
      team: 'Research',
      role: 'WORKER',
      instructions: '',
      account: 'researcher@example.com',
      createdAt: at(0),
      connectionVerifiedAt: at(0),
      execution: 'HOSTED_SETUP_REQUIRED',
    };
    store.addAgent(worker);
    const created = store.execute({
      type: 'request.create',
      idempotencyKey: randomUUID(),
      projectId: project.id,
      name: 'Experiment',
      hypothesis: 'Compare',
      workType: 'EXPERIMENT',
      mode: 'SINGLE',
      leadAgentId: worker.id,
      participantIds: [],
    });
    const request = created.requests![0];
    const experiment = created.experiments![0];
    // A pending contract review leaves a BLOCKED review task under the experiment.
    store.execute({
      type: 'contract.submit',
      idempotencyKey: randomUUID(),
      experimentId: experiment.id,
      expectedRevision: 0,
    });
    const reviewTask = store.snapshot().tasks.find(t => t.experimentId === experiment.id)!;
    assert.equal(reviewTask.status, 'BLOCKED');
    const snapshot = {
      id: randomUUID(),
      projectId: project.id,
      requestId: request.id,
      locationRevision: 0,
      requestRevision: request.revision,
      route: 'GENERATED_REQUEST_ONLY' as const,
      files: [],
      totalBytes: 0,
      manifestHash: '0'.repeat(64),
      stagingCommit: '',
      stagingPath: '',
      warnings: [],
      provenance: 'OFFICE_STAGED' as const,
      createdAt: at(0),
    };
    store.recordInputSnapshot(snapshot);
    const observation = {
      provider: 'claude' as const,
      identity: 'researcher@example.com',
      credentialContext: 'claude-code-cli',
      state: 'SIGNED_IN' as const,
      allowance: [],
      note: '',
      toolVersion: '2.1.236',
      transport: 'NONE' as const,
      environment: '',
      models: [{ id: 'opus', name: 'Opus' }],
      operations: [
        {
          operation: 'ACCOUNT_STATUS' as const,
          level: 'ACCOUNT_VERIFIED' as const,
          detail: 'ok',
          evidence: 'OBSERVED' as const,
          verifiedAt: at(0),
        },
      ],
      source: 'fixture',
      observedAt: at(0),
    };
    store.recordAccountObservation(observation);
    store.bindAgentConnection({
      agentId: worker.id,
      expectedRevision: 0,
      intent: 'VERIFY',
      observation: { ...observation, observedAt: at(1) },
    });
    const connection = store.snapshot().connections![0];
    const capability = store.snapshot().capabilities![0];
    const assignment = {
      id: randomUUID(),
      projectId: project.id,
      requestId: request.id,
      requestRevision: request.revision,
      agentId: worker.id,
      agentRevision: 1,
      connectionId: connection.id,
      capabilitySnapshotId: capability.id,
      snapshotId: snapshot.id,
      route: 'FAKE_ADAPTER' as const,
      requestedModel: 'opus',
      resolvedModel: '',
      requestedEffort: 'default' as const,
      appliedEffort: 'UNVERIFIED' as const,
      delegation: false,
      objectiveHash: '0'.repeat(64),
      createdAt: at(1),
    };
    store.createAssignment({
      assignment,
      job: {
        id: randomUUID(),
        assignmentId: assignment.id,
        projectId: project.id,
        requestId: request.id,
        provider: 'claude',
        route: 'FAKE_ADAPTER',
      },
    });
    const job = store.snapshot().jobs![0];
    store.recordJobTransition({
      jobId: job.id,
      expectedRevision: job.revision,
      to: 'SUBMITTING',
      evidence: 'OFFICE_LOCAL',
      detail: 'Submission in flight.',
      at: at(2),
    });
    const submitted = store.snapshot().jobs![0];
    store.recordJobTransition({
      jobId: job.id,
      expectedRevision: submitted.revision,
      to: 'UNKNOWN',
      evidence: 'OFFICE_LOCAL',
      detail: 'Packet written; awaiting a manual session.',
      at: at(3),
    });
    const unknown = store.snapshot().jobs![0];
    store.recordJobTransition({
      jobId: job.id,
      expectedRevision: unknown.revision,
      to: 'CANCEL_REQUESTED',
      evidence: 'OFFICE_LOCAL',
      detail: 'Cancellation requested.',
      at: at(4),
    });
    const requested = store.snapshot().jobs![0];
    // The provider acknowledging cancellation cancels the request — and must run the same
    // experiment/task cascade request.cancel runs, or the review child becomes unreachable.
    const settled = store.recordJobTransition({
      jobId: job.id,
      expectedRevision: requested.revision,
      to: 'CANCEL_ACKNOWLEDGED',
      evidence: 'PROVIDER_REPORTED',
      detail: 'Cancellation acknowledged.',
      at: at(5),
    });
    assert.equal(settled.requests![0].status, 'CANCELED');
    assert.equal(settled.experiments![0].stage, 'CANCELED');
    assert.equal(settled.tasks.find(t => t.id === reviewTask.id)!.status, 'CANCELED');
    // The request removes normally once the job is settled.
    const removed = store.execute({
      type: 'task.delete',
      idempotencyKey: randomUUID(),
      taskId: request.id,
      expectedRevision: settled.requests![0].revision,
    });
    assert.ok(removed.requests![0].removedAt);
    // Children whose parent request is already removed are orphans: they are hidden from the
    // queue and the parent can no longer propagate, so they are removable directly.
    const taskRemoved = store.execute({ type: 'task.delete', idempotencyKey: randomUUID(), taskId: reviewTask.id });
    assert.ok(taskRemoved.tasks.find(t => t.id === reviewTask.id)!.removedAt);
  } finally {
    store.close();
  }
});

test('a canceled legacy task group leaves the queue; open groups stay put', () => {
  const store = new OfficeStore(':memory:');
  try {
    const project = store.execute({
      type: 'project.create',
      idempotencyKey: randomUUID(),
      name: 'Test',
      mandate: '',
      budgetCents: 0,
    }).projects[0];
    const state = store.execute({
      type: 'task.create',
      idempotencyKey: randomUUID(),
      projectId: project.id,
      experimentId: null,
      prompt: 'Standalone investigation',
      recipient: 'WORKER',
    });
    const task = state.tasks[0];
    assert.equal(queueScope(state, { lifecycle: 'ALL' }).entries.length, 1);
    assert.throws(
      () => store.execute({ type: 'task.delete', idempotencyKey: randomUUID(), taskId: task.id }),
      /completed or canceled/,
    );
    store.execute({ type: 'task.cancel', idempotencyKey: randomUUID(), taskId: task.id });
    const removed = store.execute({ type: 'task.delete', idempotencyKey: randomUUID(), taskId: task.id });
    assert.ok(removed.tasks.every(t => t.removedAt));
    assert.equal(queueScope(removed, { lifecycle: 'ALL' }).entries.length, 0);
    assert.ok(removed.tasks.some(t => t.id === task.id));
    assert.throws(
      () => store.execute({ type: 'task.delete', idempotencyKey: randomUUID(), taskId: randomUUID() }),
      /not found/i,
    );
  } finally {
    store.close();
  }
});
