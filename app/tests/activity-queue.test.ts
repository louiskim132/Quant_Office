import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import {
  AssignmentController,
  type ObserveResult,
  type ProviderAdapter,
  type SubmitContext,
} from '../src/main/controller';
import { prepareInputSnapshot } from '../src/main/locations';
import { officeActivity, ACTIVITY_FRESHNESS_MS } from '../src/shared/activity';
import { queueScope } from '../src/shared/queue';
import type { Agent, CapabilityEvidence, CapabilityOperation, ProviderJob, Role } from '../src/shared/types';
import type { LocalSessionRecord, StopStatus } from '../src/shared/local-session';

const key = () => randomUUID();
const base = Date.UTC(2026, 8, 8, 15, 0, 0);
const at = (minutes: number) => new Date(base + minutes * 60000).toISOString();
const ms = (minutes: number) => base + minutes * 60000;
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

async function fixture(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-activity-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => {
    try {
      store.close();
    } catch {}
    removeTreeSync(root);
  });
  const alpha = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  const beta = store
    .execute({ type: 'project.create', idempotencyKey: key(), name: 'Beta', mandate: 'm', budgetCents: 0 })
    .projects.find(p => p.name === 'Beta')!;
  const source = path.join(root, 'source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'input.csv'), 'a\n1\n');
  store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: alpha.id,
    expectedRevision: 0,
    localFolder: source,
    inputPaths: ['input.csv'],
    outputFolder: '',
  });
  let first = true;
  const addAgent = (name: string, role: Role, createdAt: string) => {
    const agent: Agent = {
      id: randomUUID(),
      name,
      provider: 'claude',
      model: 'opus',
      team: 'Research',
      role,
      instructions: '',
      account: 'researcher@example.com',
      createdAt,
      connectionVerifiedAt: at(0),
      execution: 'HOSTED_SETUP_REQUIRED',
    };
    if (first) {
      store.confirmAgentBinding({ observation: verified(0), agent });
      first = false;
    } else {
      store.addAgent(agent);
      store.bindAgentConnection({ agentId: agent.id, expectedRevision: 0, intent: 'VERIFY', observation: verified(0) });
    }
    return agent;
  };
  const worker = addAgent('Worker one', 'WORKER', at(0));
  const helper = addAgent('Helper', 'PM_B', at(1));
  const idle = addAgent('Unassigned', 'WORKER', at(2));
  const alphaRequest = store.execute({
    type: 'request.create',
    idempotencyKey: key(),
    projectId: alpha.id,
    name: 'Alpha question',
    hypothesis: 'Explain alpha',
    workType: 'QUESTION',
    mode: 'GROUP',
    leadAgentId: worker.id,
    participantIds: [helper.id],
  }).requests![0];
  const betaRequest = store
    .execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: beta.id,
      name: 'Beta question',
      hypothesis: 'Explain beta',
      workType: 'QUESTION',
      mode: 'SINGLE',
      leadAgentId: idle.id,
      participantIds: [],
    })
    .requests!.find(r => r.projectId === beta.id)!;
  const snapshot = await prepareInputSnapshot({
    store,
    stagingRoot: path.join(root, 'staging'),
    projectId: alpha.id,
    requestId: alphaRequest.id,
    requestRevision: alphaRequest.revision,
  });
  // One injected clock, held just inside the account-freshness window, so a run's result never
  // depends on the calendar date the suite happens to execute on.
  let tick = 0;
  const clock = () => at(++tick / 60);
  return {
    root,
    store,
    alpha,
    beta,
    alphaRequest,
    betaRequest,
    worker,
    helper,
    idle,
    snapshot,
    clock,
    controller: new AssignmentController(store, new Adapter(), clock),
  };
}

test('nobody moves without a confirmed provider event', async t => {
  const f = await fixture(t);
  const before = officeActivity(f.store.snapshot(), { now: ms(1) });
  assert.equal(before.length, 3, 'one entry per active agent, never a duplicate avatar');
  assert.deepEqual([...new Set(before.map(item => item.kind))], ['IDLE']);
  const { assignment } = f.controller.prepare({
    requestId: f.alphaRequest.id,
    agentId: f.worker.id,
    snapshotId: f.snapshot.id,
  });
  const prepared = officeActivity(f.store.snapshot(), { now: ms(1) });
  assert.equal(
    prepared.find(item => item.agentId === f.worker.id)!.kind,
    'IDLE',
    'preparing work is local bookkeeping, not activity',
  );
  await f.controller.dispatch(assignment.id);
  // Freshness is measured against the same clock the events were recorded with, so this asserts
  // what the office does rather than what time the suite happened to run at.
  const dispatched = officeActivity(f.store.snapshot(), { now: Date.parse(f.clock()) });
  assert.equal(
    dispatched.find(item => item.agentId === f.worker.id)!.kind,
    'WORKING',
    'an accepted job with a provider receipt is live work',
  );
});

test('a stale feed reads as unknown, never as idle', async t => {
  const f = await fixture(t);
  const { assignment } = f.controller.prepare({
    requestId: f.alphaRequest.id,
    agentId: f.worker.id,
    snapshotId: f.snapshot.id,
  });
  await f.controller.dispatch(assignment.id);
  const job = f.store.snapshot().jobs![0];
  f.store.recordJobEvents(job.id, [
    {
      externalId: 'evt-1',
      cursor: '1',
      kind: 'STATUS',
      text: 'Running.',
      occurredAt: at(2),
      receivedAt: at(2),
      evidence: 'PROVIDER_REPORTED',
    },
  ]);
  const fresh = officeActivity(f.store.snapshot(), { now: ms(3) });
  assert.equal(fresh.find(item => item.agentId === f.worker.id)!.kind, 'WORKING');
  const stale = officeActivity(f.store.snapshot(), { now: ms(2) + ACTIVITY_FRESHNESS_MS + 1000 });
  const entry = stale.find(item => item.agentId === f.worker.id)!;
  assert.equal(entry.kind, 'UNKNOWN');
  assert.match(entry.detail, /unknown/i);
});

test('imported transcripts never drive the office', async t => {
  const f = await fixture(t);
  const now = Date.now();
  f.store.importWorkLogs([
    {
      id: randomUUID(),
      conversationId: 'imported',
      from: f.worker.id,
      to: f.helper.id,
      kind: 'MESSAGE',
      text: 'Historical conversation',
      timestamp: new Date(now).toISOString(),
      sourceHash: 'a'.repeat(64),
      externalId: 'imported-1',
      provenance: 'USER_IMPORTED',
    },
  ]);
  const activity = officeActivity(f.store.snapshot(), { now });
  assert.deepEqual(
    [...new Set(activity.map(item => item.kind))],
    ['IDLE'],
    'an imported log is evidence of the past, not of current work',
  );
});

test('a delivered message between agents on live work gathers them, with one stable meeting', async t => {
  const f = await fixture(t);
  // The fixture clock, not the wall clock: these events are stamped by the injected controller clock.
  const now = Date.parse(f.clock());
  const workerAssignment = f.controller.prepare({
    requestId: f.alphaRequest.id,
    agentId: f.worker.id,
    snapshotId: f.snapshot.id,
  });
  await f.controller.dispatch(workerAssignment.assignment.id);
  const helperAssignment = f.controller.prepare({
    requestId: f.alphaRequest.id,
    agentId: f.helper.id,
    snapshotId: f.snapshot.id,
  });
  await f.controller.dispatch(helperAssignment.assignment.id);
  const message = {
    id: randomUUID(),
    projectId: f.alpha.id,
    requestId: f.alphaRequest.id,
    assignmentId: workerAssignment.assignment.id,
    fromAgentId: f.worker.id,
    toAgentId: f.helper.id,
    kind: 'HANDOFF' as const,
    body: 'Taking a look together.',
    scopeSnapshotId: f.snapshot.id,
    scopeOutputHashes: [],
    sentAt: new Date(now).toISOString(),
    deliveredAt: '',
    receipt: '',
    evidence: 'OFFICE_LOCAL' as const,
  };
  f.store.recordMessage(message);
  assert.equal(
    officeActivity(f.store.snapshot(), { now }).find(item => item.agentId === f.worker.id)!.kind,
    'WORKING',
    'an undelivered message gathers nobody',
  );
  f.store.recordMessageDelivery({
    messageId: message.id,
    receipt: 'delivered',
    evidence: 'PROVIDER_REPORTED',
    at: new Date(now).toISOString(),
  });
  const meeting = officeActivity(f.store.snapshot(), { now });
  const both = meeting.filter(item => item.kind === 'MEETING');
  assert.equal(both.length, 2);
  assert.equal(new Set(both.map(item => item.meetingId)).size, 1, 'both agents join the same meeting');
});

test('queue filters and their counts describe the same scope', async t => {
  const f = await fixture(t);
  const state = f.store.snapshot();
  const all = queueScope(state);
  assert.equal(all.counts.all, 2);
  assert.equal(all.entries.length, 2);
  const alphaOnly = queueScope(state, { projectId: f.alpha.id });
  assert.equal(alphaOnly.counts.all, 1);
  assert.equal(alphaOnly.entries[0].request!.name, 'Alpha question');
  const byAgent = queueScope(state, { agentId: f.helper.id });
  assert.equal(byAgent.counts.all, 1, 'a participant counts as involved');
  assert.equal(queueScope(state, { agentId: f.idle.id }).entries[0].request!.name, 'Beta question');
  const search = queueScope(state, { search: 'beta' });
  assert.equal(search.counts.all, 1);
  assert.equal(queueScope(state, { search: 'Worker one' }).counts.all, 1, 'searching by agent name finds their work');
  assert.equal(queueScope(state, { search: 'nothing here' }).counts.all, 0);
});

test('a canceled request with an unresolved job stays in the queue, and removal keeps its rows resolvable', async t => {
  const f = await fixture(t);
  const { assignment } = f.controller.prepare({
    requestId: f.alphaRequest.id,
    agentId: f.worker.id,
    snapshotId: f.snapshot.id,
  });
  await f.controller.dispatch(assignment.id);
  // Canceling the request is office bookkeeping; the provider-side outcome is still unknown.
  const canceled = f.store.execute({
    type: 'request.cancel',
    idempotencyKey: key(),
    requestId: f.alphaRequest.id,
    expectedRevision: f.alphaRequest.revision,
  });
  const openEntry = queueScope(canceled).entries.find(e => e.id === f.alphaRequest.id)!;
  assert.equal(openEntry.status, 'CANCELED');
  assert.equal(openEntry.active, true, 'an unresolved provider outcome keeps the row in view');
  assert.equal(openEntry.deletable, false, 'and the row cannot leave the queue before reconciliation');
  // The renderer mounts its reconcile controls on exactly these flags — pin them here.
  assert.equal(openEntry.actions!.awaitingReconciliation, true);
  assert.equal(
    openEntry.jobs!.some(job => job.unresolved),
    true,
  );
  assert.equal(openEntry.canCancel, false, 'a canceled request is not cancelable again');
  // Archiving the project strands the same job: the row must still carry reconcile semantics.
  const archived = f.store.execute({
    type: 'project.archive',
    idempotencyKey: key(),
    projectId: f.alpha.id,
    archived: true,
  });
  const archivedEntry = queueScope(archived).entries.find(e => e.id === f.alphaRequest.id)!;
  assert.equal(archivedEntry.canCancel, false, 'an archived project offers no cancel');
  assert.equal(
    archivedEntry.actions!.awaitingReconciliation,
    true,
    'the unresolved job still surfaces reconcile controls',
  );
  assert.equal(archivedEntry.deletable, false);
  f.store.execute({ type: 'project.archive', idempotencyKey: key(), projectId: f.alpha.id, archived: false });
  // Settle the job, archive, then remove the project: the retained record still resolves its name.
  const job = f.store.snapshot({ history: false }).jobs![0];
  f.store.recordJobTransition({
    jobId: job.id,
    expectedRevision: job.revision,
    to: 'COMPLETED',
    evidence: 'PROVIDER_REPORTED',
    detail: 'Done.',
    outputs: [{ path: 'out/result.json', sha256: 'a'.repeat(64), bytes: 1 }],
    at: at(3),
  });
  f.store.execute({ type: 'project.archive', idempotencyKey: key(), projectId: f.alpha.id, archived: true });
  const removed = f.store.execute({ type: 'project.delete', idempotencyKey: key(), projectId: f.alpha.id });
  assert.ok(removed.projects.find(p => p.id === f.alpha.id)!.removedAt);
  const entry = queueScope(removed).entries.find(e => e.id === f.alphaRequest.id);
  assert.ok(entry, 'the canceled row is not hidden by removing its project');
  assert.equal(
    removed.projects.find(p => p.id === f.alpha.id)?.name,
    'Alpha',
    'the retained project record still resolves the row name',
  );
});

test('team filters follow membership, and lifecycle filtering keeps scope counts intact', async t => {
  const f = await fixture(t);
  const team = f.store.execute({
    type: 'team.create',
    idempotencyKey: key(),
    name: 'Alpha desk',
    projectId: f.alpha.id,
  }).teams![0];
  f.store.execute({
    type: 'team.member',
    idempotencyKey: key(),
    teamId: team.id,
    agentId: f.helper.id,
    role: 'PM_B',
    member: true,
  });
  let state = f.store.snapshot();
  assert.equal(queueScope(state, { teamId: team.id }).counts.all, 1);
  state = f.store.execute({
    type: 'request.cancel',
    idempotencyKey: key(),
    requestId: f.betaRequest.id,
    expectedRevision: f.betaRequest.revision,
  });
  const scope = queueScope(state);
  assert.equal(scope.counts.all, 2);
  assert.equal(scope.counts.active, 1);
  assert.equal(scope.counts.canceled, 1);
  const activeOnly = queueScope(state, { lifecycle: 'ACTIVE' });
  assert.equal(activeOnly.entries.length, 1);
  assert.equal(activeOnly.counts.all, 2, 'counts describe the filtered scope, not the visible page');
  assert.equal(queueScope(state, { lifecycle: 'CANCELED' }).entries[0].request!.name, 'Beta question');
});

const binding = (
  jobId: string,
  assignmentId: string,
  projectId: string,
  stopStatus: StopStatus,
): LocalSessionRecord => ({
  schemaVersion: 1,
  id: randomUUID(),
  jobId,
  assignmentId,
  projectId,
  attemptId: randomUUID(),
  revision: 0,
  provider: 'claude',
  surface: 'CLAUDE_CLI',
  layout: 'FLAT_PACKET',
  packetVersion: 2,
  packetHash: null,
  storageRelativePath: 'session-fixture',
  originalCwd: null,
  repoRelativePath: null,
  seedCommit: null,
  worktreeOwner: 'NONE',
  providerSessionId: null,
  providerProjectId: null,
  bindingEvidence: 'UNBOUND',
  groupingStatus: 'UNKNOWN',
  requirement: 'SCOPED_DELIVERY',
  confinementStatus: 'UNVERIFIED',
  confinementEvidenceId: null,
  lifecycle: 'READY',
  archiveRelativePath: null,
  lastReceipt: null,
  cancelRequestId: null,
  stopStatus,
  createdAt: at(0),
  updatedAt: at(0),
});

test('a canceled request leaves the seat idle only once the process is durably dead', async t => {
  const f = await fixture(t);
  const { assignment } = f.controller.prepare({
    requestId: f.alphaRequest.id,
    agentId: f.worker.id,
    snapshotId: f.snapshot.id,
  });
  await f.controller.dispatch(assignment.id);
  const job = f.store.snapshot().jobs![0];
  f.store.execute({
    type: 'request.cancel',
    idempotencyKey: key(),
    requestId: f.alphaRequest.id,
    expectedRevision: f.alphaRequest.revision,
  });
  const stale = ms(600); // beyond the freshness window — no fresh provider evidence exists
  const seat = (withBinding?: StopStatus) => {
    const state = f.store.snapshot();
    if (withBinding) state.localSessions = [binding(job.id, assignment.id, f.alpha.id, withBinding)];
    return officeActivity(state, { now: stale }).find(item => item.agentId === f.worker.id)!;
  };
  // No recorded session at all: no office-owned process was ever observed for this job.
  assert.equal(seat().kind, 'IDLE');
  assert.equal(seat().detail, 'Last job cancelled; outcome unresolved');
  // Every durably-dead stop status resolves the canceled leftover the same way.
  for (const stopStatus of ['PROCESS_EXIT_OBSERVED', 'SESSION_REPORTED_STOPPED', 'LEGACY_UNVERIFIED'] as const) {
    const entry = seat(stopStatus);
    assert.equal(entry.kind, 'IDLE', stopStatus);
    assert.equal(entry.detail, 'Last job cancelled; outcome unresolved');
  }
  // A binding that could still be live keeps the honest unknown — the office cannot tell.
  for (const stopStatus of ['NOT_REQUESTED', 'REQUESTED'] as const)
    assert.equal(seat(stopStatus).kind, 'UNKNOWN', stopStatus);
});

test('a fresh provider event on a canceled request still reads as working', async t => {
  const f = await fixture(t);
  const { assignment } = f.controller.prepare({
    requestId: f.alphaRequest.id,
    agentId: f.worker.id,
    snapshotId: f.snapshot.id,
  });
  await f.controller.dispatch(assignment.id);
  const job = f.store.snapshot().jobs![0];
  f.store.execute({
    type: 'request.cancel',
    idempotencyKey: key(),
    requestId: f.alphaRequest.id,
    expectedRevision: f.alphaRequest.revision,
  });
  f.store.recordJobEvents(job.id, [
    {
      externalId: 'evt-live',
      cursor: '1',
      kind: 'STATUS',
      text: 'Still working.',
      occurredAt: at(5),
      receivedAt: at(5),
      evidence: 'PROVIDER_REPORTED',
    },
  ]);
  const state = f.store.snapshot();
  // Even with a durably-dead binding recorded, fresh provider evidence is live work.
  state.localSessions = [binding(job.id, assignment.id, f.alpha.id, 'PROCESS_EXIT_OBSERVED')];
  const entry = officeActivity(state, { now: ms(5) }).find(item => item.agentId === f.worker.id)!;
  assert.equal(entry.kind, 'WORKING', 'fresh provider evidence outranks the canceled bookkeeping');
});

test('a request whose jobs all settled reads completed, not active', async t => {
  const f = await fixture(t);
  const { assignment } = f.controller.prepare({
    requestId: f.alphaRequest.id,
    agentId: f.worker.id,
    snapshotId: f.snapshot.id,
  });
  await f.controller.dispatch(assignment.id);
  let state = f.store.snapshot({ history: false });
  const openEntry = queueScope(state).entries.find(e => e.id === f.alphaRequest.id)!;
  assert.equal(openEntry.active, true, 'an open request with an unresolved job stays active');
  assert.equal(openEntry.settled, false);
  assert.equal(
    queueScope(state, { lifecycle: 'COMPLETED' }).counts.completed,
    0,
    'no request is completed before its jobs settle',
  );
  const job = state.jobs![0];
  f.store.recordJobTransition({
    jobId: job.id,
    expectedRevision: job.revision,
    to: 'FAILED',
    evidence: 'OFFICE_LOCAL',
    detail: 'Receipt rejected.',
    at: at(3),
  });
  state = f.store.snapshot({ history: false });
  const settledEntry = queueScope(state).entries.find(e => e.id === f.alphaRequest.id)!;
  assert.equal(settledEntry.settled, true);
  assert.equal(settledEntry.active, false, 'a settled request leaves the active tab');
  const completedScope = queueScope(state, { lifecycle: 'COMPLETED' });
  assert.equal(completedScope.counts.completed, 1);
  assert.equal(
    completedScope.entries[0].id,
    f.alphaRequest.id,
    'a failed job still counts: settled means finished work, not a success claim',
  );
  assert.equal(queueScope(state).counts.active, 1, 'the still-open request without jobs stays active');
});
