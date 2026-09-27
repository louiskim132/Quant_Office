import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { removeTreeSync } from '../src/main/fsx';
import {
  AssignmentController,
  type ObserveResult,
  type ProviderAdapter,
  type SubmitContext,
} from '../src/main/controller';
import { prepareInputSnapshot } from '../src/main/locations';
import type { Agent, CapabilityEvidence, CapabilityOperation, ProviderJob } from '../src/shared/types';

/**
 * project.delete only hides an archived project from pickers and lists. The project row, its
 * requests and experiments, and every lineage event stay intact: removal is a view change,
 * never a rewrite of history — the same contract task.delete has for queue rows.
 */
const key = () => randomUUID();
const base = Date.UTC(2026, 8, 16, 15, 0, 0);
const at = (minutes: number) => new Date(base + minutes * 60000).toISOString();
const ROUTES = ['FAKE_ADAPTER', 'OFFICIAL_TERMINAL_HANDOFF', 'OFFICIAL_CLI_PTY'] as const;
const CLOUD: CapabilityOperation[] = [
  'CLOUD_SUBMIT',
  'CLOUD_OBSERVE',
  'CLOUD_OUTPUT_FETCH',
  'CLOUD_CANCEL_REQUEST',
  'CLOUD_CANCEL_ACK',
  'MODEL_APPLICATION',
  'EFFORT_APPLICATION',
  'ENVIRONMENT_IDENTITY',
  'DELEGATION_CONTROL',
  'TOOL_CONFINEMENT',
];
const seen = (
  operation: CapabilityOperation,
  minutes: number,
  extra: Partial<CapabilityEvidence> = {},
): CapabilityEvidence => ({
  operation,
  level: 'ACCOUNT_VERIFIED',
  detail: 'Exercised.',
  evidence: 'OBSERVED',
  verifiedAt: at(minutes),
  source: 'fixture',
  ...extra,
});
const verified = (minutes: number) => ({
  provider: 'claude' as const,
  identity: 'researcher@example.com',
  credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const,
  allowance: [],
  note: '',
  toolVersion: '2.1.236',
  transport: 'OFFICIAL_CLI_TERMINAL' as const,
  environment: 'anthropic-managed',
  models: [{ id: 'opus', name: 'Opus' }],
  operations: [
    seen('ACCOUNT_STATUS', minutes),
    seen('MODEL_CATALOG', minutes),
    ...CLOUD.flatMap(o =>
      ROUTES.flatMap(route =>
        o === 'DELEGATION_CONTROL'
          ? [
              seen(o, minutes, { model: 'opus', route, delegation: false }),
              seen(o, minutes, { model: 'opus', route, delegation: true }),
            ]
          : o === 'EFFORT_APPLICATION'
            ? [seen(o, minutes, { model: 'opus', route, effort: 'default' })]
            : o === 'TOOL_CONFINEMENT'
              ? [
                  seen(o, minutes, {
                    model: 'opus',
                    route,
                    confinement: {
                      tools: 'Only the read-only fixture tools were offered.',
                      filesystem: 'Confined to the staged snapshot directory.',
                      network: 'No outbound network was reachable from the session.',
                      environment: 'anthropic-managed',
                    },
                  }),
                ]
              : [seen(o, minutes, { model: 'opus', route })],
      ),
    ),
  ],
  source: 'fixture',
  observedAt: at(minutes),
});

class Adapter implements ProviderAdapter {
  readonly route = 'FAKE_ADAPTER' as const;
  async submit(context: SubmitContext) {
    return {
      externalId: 'session_' + context.assignment.id.slice(0, 10).replace(/-/g, ''),
      externalUrl: '',
      detail: 'accepted',
    };
  }
  async observe(_job: ProviderJob): Promise<ObserveResult> {
    return { state: 'RUNNING', detail: 'working' };
  }
  async cancel(_job: ProviderJob) {
    return { acknowledged: true, detail: 'ok' };
  }
}

test('only an existing archived project can be removed', t => {
  const store = new OfficeStore(':memory:');
  try {
    const project = store.execute({
      type: 'project.create',
      idempotencyKey: key(),
      name: 'Active',
      mandate: '',
      budgetCents: 0,
    }).projects[0];
    assert.throws(
      () => store.execute({ type: 'project.delete', idempotencyKey: key(), projectId: project.id }),
      /Archive the project before removing/,
    );
    assert.throws(
      () => store.execute({ type: 'project.delete', idempotencyKey: key(), projectId: randomUUID() }),
      /not found/i,
    );
  } finally {
    store.close();
  }
});

test('removal retains the project row, its requests and experiments, and the recorded history', t => {
  const store = new OfficeStore(':memory:');
  try {
    const project = store.execute({
      type: 'project.create',
      idempotencyKey: key(),
      name: 'Study',
      mandate: 'm',
      budgetCents: 0,
    }).projects[0];
    const created = store.execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: project.id,
      name: 'Study request',
      hypothesis: 'A bounded experiment',
      workType: 'EXPERIMENT',
    });
    const request = created.requests![0];
    const experiment = created.experiments.find(e => e.id === request.experimentId)!;
    // Archiving is the gate removal depends on: it refuses while any request is still open.
    assert.throws(
      () => store.execute({ type: 'project.archive', idempotencyKey: key(), projectId: project.id, archived: true }),
      /Cancel outstanding requests/,
    );
    store.execute({
      type: 'request.cancel',
      idempotencyKey: key(),
      requestId: request.id,
      expectedRevision: request.revision,
    });
    const archived = store.execute({
      type: 'project.archive',
      idempotencyKey: key(),
      projectId: project.id,
      archived: true,
    });
    assert.equal(archived.projects.find(p => p.id === project.id)!.archived, true);
    const removed = store.execute({ type: 'project.delete', idempotencyKey: key(), projectId: project.id });
    const row = removed.projects.find(p => p.id === project.id)!;
    assert.ok(row.removedAt, 'the project row stays and carries the removal timestamp');
    assert.equal(row.archived, true, 'removal does not unarchive the project');
    // Removal hides; it never deletes. Every record under the project is still in state.
    assert.ok(
      removed.requests!.some(r => r.id === request.id),
      'the request record is retained',
    );
    assert.ok(
      removed.experiments.some(e => e.id === experiment.id),
      'the experiment record is retained',
    );
    const history = store.historyPage({ limit: 100 });
    for (const kind of ['PROJECT_CREATE', 'REQUEST_CREATE', 'PROJECT_ARCHIVE', 'PROJECT_DELETE'])
      assert.ok(
        history.entries.some(e => e.kind === kind),
        `${kind} stays in history`,
      );
    // A second removal and a plain re-archive both leave the removal in place.
    assert.throws(
      () => store.execute({ type: 'project.delete', idempotencyKey: key(), projectId: project.id }),
      /already removed/,
    );
    const reArchived = store.execute({
      type: 'project.archive',
      idempotencyKey: key(),
      projectId: project.id,
      archived: true,
    });
    assert.ok(
      reArchived.projects.find(p => p.id === project.id)!.removedAt,
      're-archiving a removed project does not undo the removal',
    );
  } finally {
    store.close();
  }
});

test('restoring a removed project clears the removal and lands it in the archived list', t => {
  const store = new OfficeStore(':memory:');
  try {
    const project = store.execute({
      type: 'project.create',
      idempotencyKey: key(),
      name: 'Recoverable',
      mandate: '',
      budgetCents: 0,
    }).projects[0];
    store.execute({ type: 'project.archive', idempotencyKey: key(), projectId: project.id, archived: true });
    store.execute({ type: 'project.delete', idempotencyKey: key(), projectId: project.id });
    assert.ok(store.snapshot().projects[0].removedAt);
    const restored = store.execute({
      type: 'project.archive',
      idempotencyKey: key(),
      projectId: project.id,
      archived: false,
    });
    const row = restored.projects.find(p => p.id === project.id)!;
    assert.equal(row.removedAt, undefined, 'restore clears the removal flag');
    assert.equal(row.archived, true, 'a mistaken remove lands back in the archived list, not active');
  } finally {
    store.close();
  }
});

test('an archived project whose request carries an unresolved provider job cannot be removed', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-project-delete-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => {
    try {
      store.close();
    } catch {}
    removeTreeSync(root);
  });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Live work',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  const source = path.join(root, 'source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'input.csv'), 'a\n1\n');
  store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: project.id,
    expectedRevision: 0,
    localFolder: source,
    inputPaths: ['input.csv'],
    outputFolder: '',
  });
  const agent: Agent = {
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
  store.confirmAgentBinding({ observation: verified(0), agent });
  const request = store
    .execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: project.id,
      name: 'Alpha question',
      hypothesis: 'Explain alpha',
      workType: 'QUESTION',
      mode: 'SINGLE',
      leadAgentId: agent.id,
      participantIds: [],
    })
    .requests!.find(r => r.projectId === project.id)!;
  const snapshot = await prepareInputSnapshot({
    store,
    stagingRoot: path.join(root, 'staging'),
    projectId: project.id,
    requestId: request.id,
    requestRevision: request.revision,
  });
  let tick = 0;
  const clock = () => at(++tick / 60);
  const controller = new AssignmentController(store, new Adapter(), clock);
  const { assignment } = controller.prepare({ requestId: request.id, agentId: agent.id, snapshotId: snapshot.id });
  await controller.dispatch(assignment.id);
  assert.equal(
    store.snapshot().jobs![0].state,
    'ACCEPTED',
    'the provider accepted the work; its outcome is unresolved',
  );
  // Canceling the request is office bookkeeping; it cannot settle the provider-side job.
  store.execute({
    type: 'request.cancel',
    idempotencyKey: key(),
    requestId: request.id,
    expectedRevision: request.revision,
  });
  store.execute({ type: 'project.archive', idempotencyKey: key(), projectId: project.id, archived: true });
  assert.throws(
    () => store.execute({ type: 'project.delete', idempotencyKey: key(), projectId: project.id }),
    /unresolved/,
  );
  assert.equal(
    store.snapshot().projects.find(p => p.id === project.id)!.removedAt,
    undefined,
    'the refused removal leaves the row untouched',
  );
});
