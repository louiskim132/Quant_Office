import { OutputService } from '../src/main/outputs';
import test from 'node:test';
import assert from 'node:assert/strict';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
import { prepareInputSnapshot, reconstructSnapshot, verifySnapshotForTransfer } from '../src/main/locations';
import { resolveRoleSlots, dependencyStatus, reviewStatus } from '../src/shared/cooperation';
import { requestQueue } from '../src/shared/queue';
import { scopeMismatches } from '../src/shared/readiness';
import type {
  Agent,
  CapabilityEvidence,
  CapabilityOperation,
  Message,
  ProviderJob,
  ReviewDecision,
  Role,
} from '../src/shared/types';

const key = () => randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 14, 0, 0) + minutes * 60000).toISOString();
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
const verified = (minutes: number, environment = 'anthropic-managed') => ({
  provider: 'claude' as const,
  identity: 'researcher@example.com',
  credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const,
  allowance: [],
  note: '',
  toolVersion: '2.1.236',
  transport: 'OFFICIAL_CLI_TERMINAL' as const,
  environment,
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

/** Real bytes, so an output is certified by what arrived rather than by a hash string. */
const OUTPUT_BYTES = new Map<string, Uint8Array>();
const declare = (path: string, text: string) => {
  const bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  OUTPUT_BYTES.set(sha256, bytes);
  return { path, sha256, bytes: bytes.byteLength };
};
/** Serves the declared bytes back, as a route that could really retrieve them would. */
const fetchOutput = async (_job: ProviderJob, output: { sha256: string }) => {
  const bytes = OUTPUT_BYTES.get(output.sha256);
  if (!bytes) throw new Error('no bytes for this output');
  return bytes;
};

class Adapter implements ProviderAdapter {
  readonly route = 'FAKE_ADAPTER' as const;
  constructor(
    private readonly outputs: { path: string; sha256: string; bytes: number }[] = [
      declare('result.json', '{"finding":"none"}'),
    ],
  ) {}
  async submit(context: SubmitContext) {
    return {
      externalId: 'session_' + context.assignment.id.slice(0, 12).replace(/-/g, ''),
      externalUrl: '',
      detail: 'accepted',
    };
  }
  async observe(_job: ProviderJob): Promise<ObserveResult> {
    return { state: 'COMPLETED', detail: 'done', outputs: this.outputs };
  }
  async cancel(_job: ProviderJob) {
    return { acknowledged: true, detail: 'ok' };
  }
}

async function fixture(t: any, environment = 'anthropic-managed') {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-coop-'));
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
    name: 'Alpha',
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
  let firstObservation = true;
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
    if (firstObservation) {
      store.confirmAgentBinding({ observation: verified(0, environment), agent });
      firstObservation = false;
    } else {
      store.addAgent(agent);
      store.bindAgentConnection({
        agentId: agent.id,
        expectedRevision: 0,
        intent: 'VERIFY',
        observation: verified(0, environment),
      });
    }
    return agent;
  };
  const worker = addAgent('Worker one', 'WORKER', at(0));
  const reviewerA = addAgent('Reviewer A', 'PM_B', at(1));
  const reviewerB = addAgent('Reviewer B', 'PM_D', at(2));
  const worker2 = addAgent('Worker two', 'WORKER', at(3));
  const request = store.execute({
    type: 'request.create',
    idempotencyKey: key(),
    projectId: project.id,
    name: 'Team request',
    hypothesis: 'Do the work',
    workType: 'ANALYSIS',
    mode: 'GROUP',
    leadAgentId: worker.id,
    participantIds: [reviewerA.id],
  }).requests![0];
  // Independent reviewers are legitimately not participants, so their authority is recorded as an
  // explicit grant against this request rather than by widening who may act on it.
  for (const reviewer of [reviewerB, worker2])
    store.execute({
      type: 'request.grant',
      idempotencyKey: key(),
      requestId: request.id,
      agentId: reviewer.id,
      capacity: 'REVIEW',
      granted: true,
    });
  const snapshot = await prepareInputSnapshot({
    store,
    stagingRoot: path.join(root, 'staging'),
    projectId: project.id,
    requestId: request.id,
    requestRevision: request.revision,
  });
  // One injected clock, held just inside the account-freshness window, so a run's result never
  // depends on the calendar date the suite happens to execute on.
  let tick = 0;
  const clock = () => at(++tick / 60);
  return {
    root,
    store,
    project,
    request,
    snapshot,
    worker,
    worker2,
    reviewerA,
    reviewerB,
    clock,
    controller: (outputs?: { path: string; sha256: string; bytes: number }[]) =>
      new AssignmentController(
        store,
        new Adapter(outputs),
        clock,
        undefined,
        undefined,
        undefined,
        fetchOutput,
        new OutputService(store, root).storeBytes,
      ),
  };
}

test('team names are labels; membership decides routing and survives a rename', async t => {
  const f = await fixture(t);
  const team = f.store.execute({
    type: 'team.create',
    idempotencyKey: key(),
    name: 'Alpha desk',
    projectId: f.project.id,
  }).teams![0];
  f.store.execute({
    type: 'team.member',
    idempotencyKey: key(),
    teamId: team.id,
    agentId: f.worker.id,
    role: 'WORKER',
    member: true,
  });
  f.store.execute({
    type: 'team.member',
    idempotencyKey: key(),
    teamId: team.id,
    agentId: f.worker2.id,
    role: 'WORKER',
    member: true,
  });
  const state = f.store.execute({
    type: 'team.rename',
    idempotencyKey: key(),
    teamId: team.id,
    expectedRevision: 1,
    name: 'Renamed desk',
  });
  const resolved = resolveRoleSlots(state, { teamId: team.id, slots: [{ role: 'WORKER', count: 2 }] });
  assert.deepEqual(
    resolved.slots[0].agentIds,
    [f.worker.id, f.worker2.id],
    'two members hold the same role and both resolve',
  );
  assert.deepEqual(resolved.blockers, []);
  assert.equal(state.teams![0].name, 'Renamed desk');
  assert.throws(
    () =>
      f.store.execute({
        type: 'team.rename',
        idempotencyKey: key(),
        teamId: team.id,
        expectedRevision: 1,
        name: 'Third name',
      }),
    /changed in another view/,
  );
});

test('a shortfall is reported instead of silently substituting another role', async t => {
  const f = await fixture(t);
  const team = f.store.execute({
    type: 'team.create',
    idempotencyKey: key(),
    name: 'Small desk',
    projectId: f.project.id,
  }).teams![0];
  f.store.execute({
    type: 'team.member',
    idempotencyKey: key(),
    teamId: team.id,
    agentId: f.worker.id,
    role: 'WORKER',
    member: true,
  });
  f.store.execute({
    type: 'team.member',
    idempotencyKey: key(),
    teamId: team.id,
    agentId: f.reviewerA.id,
    role: 'PM_B',
    member: true,
  });
  const state = f.store.snapshot();
  const resolved = resolveRoleSlots(state, {
    teamId: team.id,
    slots: [
      { role: 'WORKER', count: 2 },
      { role: 'DIRECTOR', count: 1 },
    ],
  });
  assert.equal(resolved.slots[0].shortfall, 1);
  assert.equal(resolved.slots[1].agentIds.length, 0);
  assert.equal(resolved.blockers.length, 2);
  assert.ok(resolved.blockers[1].includes('DIRECTOR'));
  // Removing a member changes routing immediately; the old membership stays in history.
  const removed = f.store.execute({
    type: 'team.member',
    idempotencyKey: key(),
    teamId: team.id,
    agentId: f.worker.id,
    role: 'WORKER',
    member: false,
  });
  assert.equal(
    resolveRoleSlots(removed, { teamId: team.id, slots: [{ role: 'WORKER', count: 1 }] }).slots[0].agentIds.length,
    0,
  );
  assert.equal(removed.memberships!.length, 2, 'membership history is retained');
});

test('a request records requested slots against a team without routing anything yet', async t => {
  const f = await fixture(t);
  const team = f.store.execute({
    type: 'team.create',
    idempotencyKey: key(),
    name: 'Alpha desk',
    projectId: f.project.id,
  }).teams![0];
  const state = f.store.execute({
    type: 'request.slots',
    idempotencyKey: key(),
    requestId: f.request.id,
    expectedRevision: f.request.revision,
    teamId: team.id,
    slots: [
      { role: 'WORKER', count: 2 },
      { role: 'PM_B', count: 1 },
    ],
  });
  const request = state.requests!.find(item => item.id === f.request.id)!;
  assert.equal(request.teamId, team.id);
  assert.deepEqual(request.roleSlots, [
    { role: 'WORKER', count: 2 },
    { role: 'PM_B', count: 1 },
  ]);
  assert.equal(state.assignments, undefined, 'requesting slots dispatches nothing');
  assert.throws(
    () =>
      f.store.execute({
        type: 'request.slots',
        idempotencyKey: key(),
        requestId: f.request.id,
        expectedRevision: f.request.revision,
        teamId: team.id,
        slots: [],
      }),
    /changed in another view/,
  );
});

test('dependent work waits for its dependency to actually complete', async t => {
  const f = await fixture(t);
  const controller = f.controller();
  const first = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  const second = controller.prepare({
    requestId: f.request.id,
    agentId: f.reviewerA.id,
    snapshotId: f.snapshot.id,
    dependsOn: [first.assignment.id],
  });
  assert.equal(dependencyStatus(f.store.snapshot(), second.assignment).ready, false);
  await assert.rejects(controller.dispatch(second.assignment.id), /waits on other work/);
  await controller.dispatch(first.assignment.id);
  await controller.observe(first.assignment.id);
  assert.equal(dependencyStatus(f.store.snapshot(), second.assignment).ready, true);
  const state = await controller.dispatch(second.assignment.id);
  assert.equal(state.jobs!.find(job => job.assignmentId === second.assignment.id)!.state, 'ACCEPTED');
});

test('a failed dependency blocks the work that needed its result', async t => {
  const f = await fixture(t);
  const controller = f.controller();
  const first = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  const second = controller.prepare({
    requestId: f.request.id,
    agentId: f.reviewerA.id,
    snapshotId: f.snapshot.id,
    dependsOn: [first.assignment.id],
  });
  await controller.dispatch(first.assignment.id);
  const job = f.store.snapshot().jobs!.find(item => item.assignmentId === first.assignment.id)!;
  f.store.recordJobTransition({
    jobId: job.id,
    expectedRevision: job.revision,
    to: 'FAILED',
    evidence: 'PROVIDER_REPORTED',
    detail: 'The provider reported a failure.',
  });
  const status = dependencyStatus(f.store.snapshot(), second.assignment);
  assert.equal(status.ready, false);
  assert.match(status.blockers[0], /ended as failed/);
  await assert.rejects(controller.dispatch(second.assignment.id), /waits on other work/);
});

test('messages are scoped to real work, and delivery is recorded separately from sending', async t => {
  const f = await fixture(t);
  const controller = f.controller();
  const { assignment } = controller.prepare({
    requestId: f.request.id,
    agentId: f.worker.id,
    snapshotId: f.snapshot.id,
  });
  const message: Message = {
    id: randomUUID(),
    projectId: f.project.id,
    requestId: f.request.id,
    assignmentId: assignment.id,
    fromAgentId: f.worker.id,
    toAgentId: f.reviewerA.id,
    kind: 'HANDOFF',
    body: 'Here is the prepared input.',
    scopeSnapshotId: f.snapshot.id,
    scopeOutputHashes: [],
    sentAt: at(5),
    deliveredAt: '',
    receipt: '',
    evidence: 'OFFICE_LOCAL',
  };
  const sent = f.store.recordMessage(message);
  assert.equal(sent.messages![0].deliveredAt, '', 'sending is not delivery');
  assert.throws(() => f.store.recordMessage({ ...message, toAgentId: f.worker.id }), /cannot message itself/);
  assert.throws(
    () => f.store.recordMessage({ ...message, id: randomUUID(), scopeSnapshotId: randomUUID() }),
    /input snapshot from this project/,
  );
  assert.throws(() => f.store.recordMessage(message), /immutable/);
  const delivered = f.store.recordMessageDelivery({
    messageId: message.id,
    receipt: 'provider delivery receipt 42',
    evidence: 'PROVIDER_REPORTED',
    at: at(6),
  });
  assert.equal(delivered.messages![0].deliveredAt, at(6));
  assert.equal(delivered.messages![0].evidence, 'PROVIDER_REPORTED');
  assert.throws(
    () => f.store.recordMessageDelivery({ messageId: message.id, receipt: 'again', evidence: 'PROVIDER_REPORTED' }),
    /already has a delivery receipt/,
  );
});

async function reviewFixture(t: any) {
  const f = await fixture(t);
  const controller = f.controller();
  const subject = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  await controller.dispatch(subject.assignment.id);
  await controller.observe(subject.assignment.id);
  // The hashes the provider actually returned, not a placeholder: a review cites real outputs.
  const subjectOutputs = f.store
    .snapshot()
    .jobs!.find(job => job.assignmentId === subject.assignment.id)!
    .outputs.map(output => output.sha256);
  const reviewerOne = controller.prepare({
    requestId: f.request.id,
    agentId: f.reviewerA.id,
    snapshotId: f.snapshot.id,
  });
  await controller.dispatch(reviewerOne.assignment.id);
  await controller.observe(reviewerOne.assignment.id);
  const reviewerTwo = controller.prepare({
    requestId: f.request.id,
    agentId: f.reviewerB.id,
    snapshotId: f.snapshot.id,
  });
  await controller.dispatch(reviewerTwo.assignment.id);
  await controller.observe(reviewerTwo.assignment.id);
  const decision = (
    reviewer: { assignment: { id: string } },
    agentId: string,
    overrides: Partial<ReviewDecision> = {},
  ): ReviewDecision => ({
    id: randomUUID(),
    projectId: f.project.id,
    requestId: f.request.id,
    requestRevision: f.store.snapshot().requests![0].revision,
    subjectAssignmentId: subject.assignment.id,
    subjectAgentId: f.worker.id,
    reviewerAssignmentId: reviewer.assignment.id,
    reviewerAgentId: agentId,
    inputSnapshotId: f.snapshot.id,
    outputHashes: subjectOutputs,
    bundleHash: 'b'.repeat(64),
    phase: 'FIRST',
    verdict: 'APPROVED',
    rationale: 'Checked the outputs against the criteria.',
    createdAt: at(10),
    ...overrides,
  });
  return { ...f, subject, reviewerOne, reviewerTwo, decision };
}

test('a review needs a different agent, its own context and the real outputs', async t => {
  const f = await reviewFixture(t);
  assert.throws(
    () => f.store.recordReviewDecision(f.decision({ assignment: { id: f.subject.assignment.id } }, f.worker.id)),
    /own separate assignment context/,
  );
  assert.throws(
    () => f.store.recordReviewDecision(f.decision(f.reviewerOne, f.worker.id)),
    /do not match their assignments/,
  );
  assert.throws(
    () => f.store.recordReviewDecision(f.decision(f.reviewerOne, f.reviewerA.id, { outputHashes: ['c'.repeat(64)] })),
    /output hashes the provider actually returned/,
  );
  assert.throws(
    () => f.store.recordReviewDecision(f.decision(f.reviewerOne, f.reviewerA.id, { inputSnapshotId: randomUUID() })),
    /exact input snapshot/,
  );
  assert.throws(
    () => f.store.recordReviewDecision(f.decision(f.reviewerOne, f.reviewerA.id, { phase: 'REBUTTAL' })),
    /follows that reviewer/,
  );
  const state = f.store.recordReviewDecision(f.decision(f.reviewerOne, f.reviewerA.id));
  assert.equal(state.decisions!.length, 1);
  assert.throws(
    () => f.store.recordReviewDecision(f.decision(f.reviewerOne, f.reviewerA.id)),
    /already recorded that phase/,
  );
});

test('two independent approvals satisfy review, and a later amendment invalidates them', async t => {
  const f = await reviewFixture(t);
  f.store.recordReviewDecision(f.decision(f.reviewerOne, f.reviewerA.id));
  let state = f.store.recordReviewDecision(f.decision(f.reviewerTwo, f.reviewerB.id));
  let status = reviewStatus(state, f.request.id);
  assert.equal(status.independentReviewers, 2);
  assert.equal(status.approved, true);
  assert.deepEqual(status.blockers, []);
  // Amending the request invalidates the approvals that judged the previous version.
  state = f.store.execute({
    type: 'request.update',
    idempotencyKey: key(),
    requestId: f.request.id,
    expectedRevision: state.requests![0].revision,
    objective: 'A materially different objective',
    leadAgentId: f.worker.id,
    participantIds: [f.reviewerA.id],
    acceptanceCriteria: '',
  });
  status = reviewStatus(state, f.request.id);
  assert.equal(status.approved, false);
  assert.equal(status.independentReviewers, 0);
  assert.ok(status.blockers.some(blocker => blocker.includes('moved to revision')));
  assert.equal(
    status.decisions.every(decision => decision.stale),
    true,
    'the old decisions are kept, marked stale',
  );
});

test('one rejection blocks approval even with enough reviewers', async t => {
  const f = await reviewFixture(t);
  f.store.recordReviewDecision(f.decision(f.reviewerOne, f.reviewerA.id));
  const state = f.store.recordReviewDecision(
    f.decision(f.reviewerTwo, f.reviewerB.id, {
      verdict: 'CHANGES_REQUESTED',
      rationale: 'The evaluation is missing a control.',
    }),
  );
  const status = reviewStatus(state, f.request.id);
  assert.equal(status.independentReviewers, 2);
  assert.equal(status.approved, false);
  assert.ok(status.blockers.some(blocker => blocker.includes('changes requested')));
});

test('reviews of different bundles cannot pool into approval', async t => {
  const f = await reviewFixture(t);
  f.store.recordReviewDecision(f.decision(f.reviewerOne, f.reviewerA.id));
  const state = f.store.recordReviewDecision(f.decision(f.reviewerTwo, f.reviewerB.id, { bundleHash: 'c'.repeat(64) }));
  assert.equal(reviewStatus(state, f.request.id).approved, false);
  assert.equal(reviewStatus(state, f.request.id).independentReviewers, 0);
  const exact = reviewStatus(state, f.request.id, {
    subjectAssignmentId: f.subject.assignment.id,
    bundleHash: 'b'.repeat(64),
  });
  assert.equal(exact.independentReviewers, 1);
  assert.equal(exact.approved, false);
});

test('a prepared reviewer is not a completed independent review context', async t => {
  const f = await reviewFixture(t);
  const pending = f.controller().prepare({ requestId: f.request.id, agentId: f.worker2.id, snapshotId: f.snapshot.id });
  assert.throws(() => f.store.recordReviewDecision(f.decision(pending, f.worker2.id)), /completed provider outcome/);
});

test('canceling one group job leaves the request and other prepared jobs open', async t => {
  const f = await fixture(t),
    controller = f.controller();
  const one = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  const two = controller.prepare({ requestId: f.request.id, agentId: f.reviewerA.id, snapshotId: f.snapshot.id });
  await controller.cancel(one.assignment.id);
  const state = f.store.snapshot();
  assert.notEqual(state.requests![0].status, 'CANCELED');
  assert.equal(state.requests![0].revision, f.request.revision);
  assert.equal(state.jobs!.find(job => job.assignmentId === two.assignment.id)?.state, 'INTENT');
});

test('review, messages and teams replay and survive a restart', async t => {
  const f = await reviewFixture(t);
  f.store.recordReviewDecision(f.decision(f.reviewerOne, f.reviewerA.id));
  const team = f.store.execute({
    type: 'team.create',
    idempotencyKey: key(),
    name: 'Alpha desk',
    projectId: f.project.id,
  }).teams![0];
  f.store.execute({
    type: 'team.member',
    idempotencyKey: key(),
    teamId: team.id,
    agentId: f.worker.id,
    role: 'WORKER',
    member: true,
  });
  const before = f.store.snapshot();
  const file = path.join(f.root, 'workspace.sqlite');
  f.store.close();
  const reopened = new OfficeStore(file);
  const after = reopened.snapshot();
  reopened.close();
  assert.deepEqual(after.decisions, before.decisions);
  assert.deepEqual(after.teams, before.teams);
  assert.deepEqual(after.memberships, before.memberships);
  assert.equal(reviewStatus(after, f.request.id).independentReviewers, 1);
});

test('explicit group work dispatches, and its delegation policy is recorded rather than treated as tool confinement', async t => {
  const f = await fixture(t);
  const controller = f.controller();
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  assert.equal(f.request.mode, 'GROUP');
  assert.equal(
    prepared.assignment.delegation,
    true,
    'the frozen assignment keeps the collaboration policy the user authorized',
  );
  const state = await controller.dispatch(prepared.assignment.id);
  assert.equal(
    state.jobs!.find(job => job.assignmentId === prepared.assignment.id)!.state,
    'ACCEPTED',
    'authorized group work proceeds because confinement is proved by scoped evidence, not by delegation being off',
  );
});

test('an environment that is not provider-hosted is refused even when the request delegates nothing', async t => {
  // Same evidence, only the observed environment differs. The guard must key on hosting evidence,
  // so a single-agent request with delegation off is refused just as a delegating one would be.
  const f = await fixture(t, 'local-sandbox');
  const single = f.store
    .execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: f.project.id,
      name: 'Solo request',
      hypothesis: 'Do it alone',
      workType: 'ANALYSIS',
      mode: 'SINGLE',
      leadAgentId: f.worker.id,
      participantIds: [],
    })
    .requests!.find(r => r.name === 'Solo request')!;
  assert.equal(single.delegation, false);
  const snapshot = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: path.join(f.root, 'staging-solo'),
    projectId: f.project.id,
    requestId: single.id,
    requestRevision: single.revision,
  });
  const controller = f.controller();
  const prepared = controller.prepare({ requestId: single.id, agentId: f.worker.id, snapshotId: snapshot.id });
  await assert.rejects(controller.dispatch(prepared.assignment.id), /provider-hosted/);
});

test('a route that cannot reach this provider is refused outright, never substituted', async t => {
  const f = await fixture(t);
  // The office's native adapter is a Claude route. A profile it cannot serve must be refused before
  // anything is sent, rather than quietly handed to whatever happens to answer.
  class OpenAiOnly extends Adapter {
    readonly providers = ['openai'] as const;
  }
  const controller = new AssignmentController(f.store, new OpenAiOnly(), f.clock);
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  await assert.rejects(controller.dispatch(prepared.assignment.id), /No supported route/);
  const job = f.store.snapshot().jobs!.find(item => item.assignmentId === prepared.assignment.id)!;
  assert.equal(job.state, 'INTENT', 'a refused route leaves the job untouched, not stranded mid-submission');
});

test('evidence taken under other conditions does not authorize this exact scope', async t => {
  const f = await fixture(t);
  const controller = f.controller();
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  const state = f.store.snapshot();
  const now = Date.parse(f.clock());
  const scope = {
    provider: 'claude' as const,
    identity: 'researcher@example.com',
    credentialContext: 'claude-code-cli',
    toolVersion: '2.1.236',
    route: 'FAKE_ADAPTER' as const,
    environment: 'anthropic-managed',
    model: 'opus',
    effort: 'default' as const,
    delegation: prepared.assignment.delegation,
  };
  assert.deepEqual(scopeMismatches(state, scope, { now }), [], 'the exact observed scope is verified');
  // Each of these is a different question from the one the account was actually observed answering.
  assert.match(
    scopeMismatches(state, { ...scope, effort: 'high' }, { now }).join(' | '),
    /applied effort for this exact scope/,
  );
  assert.match(scopeMismatches(state, { ...scope, model: 'sonnet' }, { now }).join(' | '), /for this exact scope/);
  assert.match(
    scopeMismatches(state, { ...scope, toolVersion: '9.9.9' }, { now }).join(' | '),
    /official tool changed/,
  );
  assert.match(
    scopeMismatches(state, { ...scope, environment: 'somewhere-else' }, { now }).join(' | '),
    /no evidence recorded for these conditions/,
    'evidence taken in another environment is not evidence about this one',
  );
  assert.match(
    scopeMismatches(state, { ...scope, identity: 'other@example.com' }, { now }).join(' | '),
    /current account context/,
  );
  assert.match(
    scopeMismatches(state, { ...scope, credentialContext: 'something-else' }, { now }).join(' | '),
    /credential context changed/,
  );
  // Expiry is part of scope too: the same conditions, checked too long ago, are not verified now.
  assert.match(scopeMismatches(state, scope, { now: now + 25 * 60 * 60 * 1000 }).join(' | '), /evidence expired/);
});

test('the frozen payload is what the adapter receives, and an edited request blocks launch outright', async t => {
  const f = await fixture(t);
  const prepared = f.controller().prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  assert.equal(prepared.assignment.frozen!.objective, 'Do the work');
  assert.equal(prepared.assignment.frozen!.requestName, 'Team request');

  // With nothing changed, the adapter is handed the frozen text rather than a fresh read of the request.
  const seen: string[] = [];
  const spy = {
    route: 'FAKE_ADAPTER' as const,
    async submit(context: any) {
      seen.push(context.objective);
      return {
        externalId: 'session_' + context.assignment.id.slice(0, 12).replace(/-/g, ''),
        externalUrl: '',
        detail: 'accepted',
      };
    },
    async observe() {
      return { state: 'RUNNING' as const, detail: 'working' };
    },
    async cancel() {
      return { acknowledged: true, detail: 'ok' };
    },
  };
  await new AssignmentController(f.store, spy, f.clock).dispatch(prepared.assignment.id);
  assert.deepEqual(seen, ['Do the work'], 'the adapter receives the frozen objective');

  // A second assignment, then an edit to the request underneath it. The revision guard refuses the
  // launch rather than sending either the stale text or the new text against old frozen inputs.
  const second = f
    .controller()
    .prepare({ requestId: f.request.id, agentId: f.reviewerA.id, snapshotId: f.snapshot.id });
  f.store.execute({
    type: 'request.update',
    idempotencyKey: key(),
    requestId: f.request.id,
    expectedRevision: f.request.revision,
    objective: 'Completely different instructions, added after the inputs were frozen',
    leadAgentId: f.worker.id,
    participantIds: [f.reviewerA.id],
    acceptanceCriteria: '',
  });
  await assert.rejects(f.controller().dispatch(second.assignment.id), /changed since this work was frozen/);
  assert.equal(seen.length, 1, 'the edited request never reached an adapter');
});

test('an assignment frozen before the payload existed refuses to launch instead of guessing', async t => {
  const f = await fixture(t);
  const controller = f.controller();
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  // Simulate a record written by an older build: everything else intact, no frozen payload.
  const legacy = { ...prepared.assignment, frozen: undefined };
  const patched = new AssignmentController(
    {
      ...f.store,
      snapshot: () => ({ ...f.store.snapshot(), assignments: [legacy] }),
    } as any,
    new Adapter(),
    f.clock,
  );
  await assert.rejects(patched.dispatch(legacy.id), /Prepare the request again/);
});

test('a canceled request or an archived project cannot be launched from a stale view', async t => {
  const f = await fixture(t);
  const controller = f.controller();
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  const current = f.store.snapshot().requests!.find(item => item.id === f.request.id)!;
  f.store.execute({
    type: 'request.cancel',
    idempotencyKey: key(),
    requestId: f.request.id,
    expectedRevision: current.revision,
  });
  await assert.rejects(controller.dispatch(prepared.assignment.id), /was canceled/);
  // Preparing again from the same stale window is refused at the door.
  assert.throws(
    () => controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id }),
    /was canceled/,
  );
});

test("an adapter that cannot observe reports its own limits, never the provider's", async t => {
  const f = await fixture(t);
  // This adapter accepts a submission and then admits it cannot observe anything.
  const blind = {
    route: 'FAKE_ADAPTER' as const,
    async submit(context: any) {
      return {
        externalId: 'session_' + context.assignment.id.slice(0, 12).replace(/-/g, ''),
        externalUrl: '',
        detail: 'accepted',
      };
    },
    async observe() {
      return {
        state: 'UNKNOWN' as const,
        detail: 'No supported programmatic observation has been established for this account.',
      };
    },
    async cancel() {
      return { acknowledged: false, detail: 'not supported' };
    },
  };
  const controller = new AssignmentController(f.store, blind, f.clock);
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  await controller.dispatch(prepared.assignment.id);
  const accepted = f.store.snapshot().jobs!.find(item => item.assignmentId === prepared.assignment.id)!;
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(accepted.evidence, 'PROVIDER_REPORTED');
  assert.ok(accepted.externalId);

  await controller.observe(prepared.assignment.id);
  const after = f.store.snapshot().jobs!.find(item => item.assignmentId === prepared.assignment.id)!;
  assert.equal(after.state, 'ACCEPTED', 'a stub observation never overwrites a real receipt');
  assert.equal(after.externalId, accepted.externalId);
  assert.equal(after.evidence, 'PROVIDER_REPORTED');
});

/** A promise the test releases by hand, so a race is exercised deterministically, never by timing. */
function deferred<T>() {
  let release: (value: T) => void;
  const promise = new Promise<T>(resolve => {
    release = resolve;
  });
  return { promise, release: release! };
}

/** Counts what actually reached the provider, so "nothing was launched" is measured, not assumed. */
class CountingAdapter extends Adapter {
  public submits = 0;
  async submit(context: SubmitContext) {
    this.submits++;
    return super.submit(context);
  }
}

test('work invalidated while the frozen inputs are being verified never reaches the provider', async t => {
  // The window between the transfer check and the adapter call is a real one: verification is slow,
  // and the workspace stays writable. Each case cancels, archives or rebinds inside that window.
  const cases: { name: string; invalidate: (f: any) => void; expect: RegExp }[] = [
    {
      name: 'the request is canceled',
      expect: /was canceled/,
      invalidate: f => {
        const current = f.store.snapshot().requests!.find((item: any) => item.id === f.request.id)!;
        f.store.execute({
          type: 'request.cancel',
          idempotencyKey: key(),
          requestId: f.request.id,
          expectedRevision: current.revision,
        });
      },
    },
    // Archiving a project with outstanding requests is already refused by the store, so that race
    // cannot be reached from here; rebinding the profile is the reachable equivalent and is the case
    // the packet names alongside archival.
    {
      name: 'the profile is rebound to another account',
      expect: /no longer bound|account context changed|current account context/,
      invalidate: f => {
        f.store.bindAgentConnection({
          agentId: f.worker.id,
          expectedRevision: f.store.snapshot().agents.find((a: any) => a.id === f.worker.id)!.revision ?? 0,
          intent: 'CHANGE',
          observation: { ...verified(0), identity: 'second@example.com' },
        });
      },
    },
    // Archiving bumps the profile revision, so the frozen-revision guard is what fires first here.
    // Either refusal is correct; what matters is that nothing reaches the provider.
    {
      name: 'the profile is archived',
      expect: /archived|read-only|changed since this work was frozen/i,
      invalidate: f => {
        f.store.execute({ type: 'agent.remove', idempotencyKey: key(), agentId: f.worker.id, removed: true });
      },
    },
  ];
  for (const scenario of cases) {
    for (const kind of ['dispatch', 'handoff'] as const) {
      const f = await fixture(t);
      const adapter = new CountingAdapter();
      const gate = deferred<string[]>();
      const controller = new AssignmentController(f.store, adapter, f.clock, () => gate.promise);
      const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
      const running =
        kind === 'dispatch' ? controller.dispatch(prepared.assignment.id) : controller.handoff(prepared.assignment.id);
      const settled = running.then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      scenario.invalidate(f);
      gate.release([]);
      const outcome = await settled;
      assert.match(outcome, scenario.expect, `${kind}: ${scenario.name} must block the launch`);
      assert.equal(adapter.submits, 0, `${kind}: nothing was sent to the provider when ${scenario.name}`);
      const job = f.store.snapshot().jobs!.find(item => item.assignmentId === prepared.assignment.id)!;
      assert.notEqual(job.state, 'ACCEPTED', `${kind}: no accepted job exists when ${scenario.name}`);
    }
  }
});

test('a launch is refused when the account context changes underneath it, even at the same address', async t => {
  const f = await fixture(t);
  const adapter = new CountingAdapter();
  const gate = deferred<string[]>();
  const controller = new AssignmentController(f.store, adapter, f.clock, () => gate.promise);
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  const settled = controller.dispatch(prepared.assignment.id).then(
    () => 'resolved',
    (error: Error) => error.message,
  );
  // A different credential context for the same address is a different account context, and the
  // frozen work was not prepared against it.
  f.store.recordAccountObservation({ ...verified(0), credentialContext: 'claude-code-cli-other' });
  gate.release([]);
  const outcome = await settled;
  assert.match(outcome, /account context changed|current account context/);
  assert.equal(adapter.submits, 0, 'a changed context is caught before anything is sent');
});

test('a handoff refuses a profile its route cannot reach, before any observation or launch', async t => {
  const f = await fixture(t);
  // The default terminal handoff is a Claude route. Previously only automatic dispatch checked this,
  // so a profile bound elsewhere could still reach it through the handoff path.
  const adapter = new CountingAdapter();
  let observations = 0;
  const controller = new AssignmentController(
    f.store,
    new (class extends CountingAdapter {
      readonly providers = ['openai'] as const;
    })(),
    f.clock,
    undefined,
    async () => {
      observations++;
    },
  );
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  await assert.rejects(controller.handoff(prepared.assignment.id), /No supported route/);
  assert.equal(adapter.submits, 0);
  assert.equal(
    f.store.snapshot().jobs!.find(item => item.assignmentId === prepared.assignment.id)!.state,
    'INTENT',
    'the job is untouched by a refused route',
  );
  void observations;
});

test('work whose staging is gone is rebuilt from stored bytes on the real preflight path', async t => {
  const f = await fixture(t);
  // Prepared again with an object root, so the workspace holds the frozen bytes durably.
  const objectRoot = path.join(f.root, 'workspace');
  const stagingRoot = path.join(f.root, 'restored-staging');
  const durable = await prepareInputSnapshot({
    store: f.store,
    stagingRoot: path.join(f.root, 'staging2'),
    objectRoot,
    projectId: f.project.id,
    requestId: f.request.id,
    requestRevision: f.request.revision,
  });

  const adapter = new CountingAdapter();
  let rebuilds = 0;
  const controller = new AssignmentController(
    f.store,
    adapter,
    f.clock,
    snapshot => verifySnapshotForTransfer(snapshot, 'git', stagingRoot),
    undefined,
    async snapshot => {
      rebuilds++;
      const rebuilt = await reconstructSnapshot({ snapshot, objectRoot, stagingRoot });
      assert.deepEqual(rebuilt.problems, [], 'the rebuilt commit matches the frozen one');
      return rebuilt.stagingPath;
    },
  );
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: durable.id });

  // Everything a restore would not carry is destroyed: the staging directory and the source folder.
  removeTreeSync(durable.stagingPath);
  removeTreeSync(path.join(f.root, 'source'));

  const state = await controller.dispatch(prepared.assignment.id);
  assert.equal(rebuilds, 1, 'the preflight path rebuilt the missing staging itself');
  assert.equal(adapter.submits, 1);
  assert.equal(state.jobs!.find(job => job.assignmentId === prepared.assignment.id)!.state, 'ACCEPTED');

  // The recorded snapshot still describes where it was frozen, not where it was rebuilt.
  const recorded = f.store.snapshot().snapshots!.find(item => item.id === durable.id)!;
  assert.equal(recorded.stagingPath, durable.stagingPath, 'the historical record is not rewritten');
  assert.equal(existsSync(recorded.stagingPath), false, 'and the original location really is gone');
});

test('work with no stored bytes stays unreconstructable rather than being launched', async t => {
  const f = await fixture(t);
  const objectRoot = path.join(f.root, 'empty-workspace');
  const stagingRoot = path.join(f.root, 'restored-staging-2');
  const adapter = new CountingAdapter();
  const controller = new AssignmentController(
    f.store,
    adapter,
    f.clock,
    snapshot => verifySnapshotForTransfer(snapshot, 'git', stagingRoot),
    undefined,
    async snapshot => {
      const rebuilt = await reconstructSnapshot({ snapshot, objectRoot, stagingRoot });
      if (rebuilt.problems.length) throw new Error(`The prepared inputs could not be rebuilt: ${rebuilt.problems[0]}`);
      return rebuilt.stagingPath;
    },
  );
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  removeTreeSync(f.snapshot.stagingPath);
  await assert.rejects(
    controller.dispatch(prepared.assignment.id),
    /cannot be reconstructed|prepared before its bytes were stored/,
  );
  assert.equal(adapter.submits, 0, 'nothing is launched from inputs the office cannot produce');
});

test('the adapter receives the whole frozen contract, not just the objective', async t => {
  const f = await fixture(t);
  const seen: any[] = [];
  const spy = {
    route: 'FAKE_ADAPTER' as const,
    async submit(context: SubmitContext) {
      seen.push(context.payload);
      return {
        externalId: 'session_' + context.assignment.id.slice(0, 12).replace(/-/g, ''),
        externalUrl: '',
        detail: 'accepted',
      };
    },
    async observe() {
      return { state: 'RUNNING' as const, detail: 'working' };
    },
    async cancel() {
      return { acknowledged: true, detail: 'ok' };
    },
  };
  const controller = new AssignmentController(f.store, spy, f.clock);
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  await controller.dispatch(prepared.assignment.id);
  assert.equal(seen.length, 1);
  const payload = seen[0];
  // Acceptance criteria say when the work is done and instructions say how; shipping only the
  // objective delivers something the user never approved.
  assert.equal(payload.objective, prepared.assignment.frozen!.objective);
  assert.equal(payload.acceptanceCriteria, prepared.assignment.frozen!.acceptanceCriteria);
  assert.equal(payload.instructions, prepared.assignment.frozen!.instructions);
  assert.match(payload.text, /## Objective/);
  assert.match(payload.text, /Delegation is authorized for this request/);
  assert.ok(
    payload.text.includes(prepared.assignment.frozen!.objective),
    'the transmitted text carries the frozen objective',
  );
});

test('an agent neither listed nor granted is refused, while a granted independent reviewer works', async t => {
  const f = await fixture(t);
  const controller = f.controller();
  // worker2 holds a REVIEW grant from the fixture; idle-style agents do not.
  const stranger = {
    ...f.store.snapshot().agents.find(agent => agent.id === f.worker2.id)!,
    id: randomUUID(),
    name: 'Ungranted worker',
  };
  f.store.addAgent(stranger);
  f.store.bindAgentConnection({
    agentId: stranger.id,
    expectedRevision: f.store.snapshot().agents.find(agent => agent.id === stranger.id)!.revision ?? 0,
    intent: 'VERIFY',
    observation: verified(0),
  });
  assert.throws(
    () => controller.prepare({ requestId: f.request.id, agentId: stranger.id, snapshotId: f.snapshot.id }),
    /neither listed on this request nor granted/,
  );
  // The granted reviewer, who is deliberately not a participant, still works.
  assert.ok(
    controller.prepare({ requestId: f.request.id, agentId: f.worker2.id, snapshotId: f.snapshot.id }).assignment.id,
  );
  // Revoking the grant closes it again.
  f.store.execute({
    type: 'request.grant',
    idempotencyKey: key(),
    requestId: f.request.id,
    agentId: f.worker2.id,
    capacity: 'REVIEW',
    granted: false,
  });
  assert.throws(
    () => controller.prepare({ requestId: f.request.id, agentId: f.worker2.id, snapshotId: f.snapshot.id }),
    /neither listed on this request nor granted/,
  );
});

test('a single-agent request cannot have its roster widened by a grant', async t => {
  const f = await fixture(t);
  const single = f.store
    .execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: f.project.id,
      name: 'Solo',
      hypothesis: 'alone',
      workType: 'ANALYSIS',
      mode: 'SINGLE',
      leadAgentId: f.worker.id,
      participantIds: [],
    })
    .requests!.find(r => r.name === 'Solo')!;
  assert.throws(
    () =>
      f.store.execute({
        type: 'request.grant',
        idempotencyKey: key(),
        requestId: single.id,
        agentId: f.reviewerA.id,
        capacity: 'REVIEW',
        granted: true,
      }),
    /cannot grant work to another profile/,
  );
});

test('reported output is only recorded once its bytes arrive and match', async t => {
  const f = await fixture(t);
  const good = declare('result.json', '{"finding":"none"}');
  const wrongHash = { path: 'claimed.json', sha256: 'd'.repeat(64), bytes: 5 };
  const wrongLength = { ...declare('short.json', '12345'), bytes: 99 };

  const observing = (outputs: { path: string; sha256: string; bytes: number }[]) => ({
    route: 'FAKE_ADAPTER' as const,
    async submit(context: SubmitContext) {
      return {
        externalId: 'session_' + context.assignment.id.slice(0, 12).replace(/-/g, ''),
        externalUrl: '',
        detail: 'accepted',
      };
    },
    async observe() {
      return { state: 'COMPLETED' as const, detail: 'Finished.', outputs };
    },
    async cancel() {
      return { acknowledged: true, detail: 'ok' };
    },
  });

  // Bytes that match their claimed identity are retrieved and stored.
  const stored = new Map<string, Uint8Array>();
  const controller = new AssignmentController(
    f.store,
    observing([good]),
    f.clock,
    undefined,
    undefined,
    undefined,
    fetchOutput,
    async (sha256, bytes) => {
      stored.set(sha256, bytes);
    },
  );
  const first = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  await controller.dispatch(first.assignment.id);
  const done = await controller.observe(first.assignment.id);
  const job = done.jobs!.find(item => item.assignmentId === first.assignment.id)!;
  assert.equal(job.state, 'COMPLETED');
  assert.deepEqual(
    job.outputs.map(output => output.sha256),
    [good.sha256],
  );
  assert.equal(stored.size, 1, 'verified bytes are stored, addressed by what actually arrived');

  // A hash the bytes do not match is dropped, and the mismatch is reported rather than stored.
  const f2 = await fixture(t);
  const bad = new AssignmentController(
    f2.store,
    observing([wrongHash]),
    f2.clock,
    undefined,
    undefined,
    undefined,
    async () => Buffer.from('these are not the claimed bytes'),
  );
  const second = bad.prepare({ requestId: f2.request.id, agentId: f2.worker.id, snapshotId: f2.snapshot.id });
  await bad.dispatch(second.assignment.id);
  await assert.rejects(bad.observe(second.assignment.id), /attributable output/);

  // A length that disagrees with what arrived is refused the same way.
  const f3 = await fixture(t);
  const short = new AssignmentController(
    f3.store,
    observing([wrongLength]),
    f3.clock,
    undefined,
    undefined,
    undefined,
    fetchOutput,
  );
  const third = short.prepare({ requestId: f3.request.id, agentId: f3.worker.id, snapshotId: f3.snapshot.id });
  await short.dispatch(third.assignment.id);
  await assert.rejects(short.observe(third.assignment.id), /attributable output/);

  // A route with no retrieval at all cannot certify a deliverable from metadata alone.
  const f4 = await fixture(t);
  const none = new AssignmentController(f4.store, observing([good]), f4.clock);
  const fourth = none.prepare({ requestId: f4.request.id, agentId: f4.worker.id, snapshotId: f4.snapshot.id });
  await none.dispatch(fourth.assignment.id);
  await assert.rejects(none.observe(fourth.assignment.id), /attributable output/);
});

test('an UNKNOWN the provider really reported is recorded as provider testimony, not as office silence', async t => {
  const f = await fixture(t);
  const reported = {
    route: 'FAKE_ADAPTER' as const,
    async submit(context: SubmitContext) {
      return {
        externalId: 'session_' + context.assignment.id.slice(0, 12).replace(/-/g, ''),
        externalUrl: '',
        detail: 'accepted',
      };
    },
    async observe() {
      return {
        state: 'UNKNOWN' as const,
        detail: 'The provider reports this session in an indeterminate state.',
        provenance: 'PROVIDER_REPORTED' as const,
      };
    },
    async cancel() {
      return { acknowledged: true, detail: 'ok' };
    },
  };
  const controller = new AssignmentController(f.store, reported, f.clock);
  const prepared = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  await controller.dispatch(prepared.assignment.id);
  const state = await controller.observe(prepared.assignment.id);
  const job = state.jobs!.find(item => item.assignmentId === prepared.assignment.id)!;
  // The adapter heard this from the provider, so it is not the local "I cannot observe" branch.
  assert.equal(job.state, 'UNKNOWN');
  assert.equal(job.evidence, 'PROVIDER_REPORTED');
  assert.match(job.detail, /indeterminate/);
});

test('a request reports every job, so a later completed one cannot hide an unresolved one', async t => {
  const f = await fixture(t);
  const controller = f.controller();
  // Two authorized jobs on the same request: the worker's, and the granted reviewer's.
  const first = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  await controller.dispatch(first.assignment.id);
  const firstJob = f.store.snapshot().jobs!.find(job => job.assignmentId === first.assignment.id)!;
  f.store.recordJobTransition({
    jobId: firstJob.id,
    expectedRevision: firstJob.revision,
    to: 'UNKNOWN',
    evidence: 'OFFICE_LOCAL',
    detail: 'The office cannot establish what the provider did with this.',
  });

  const second = controller.prepare({ requestId: f.request.id, agentId: f.reviewerA.id, snapshotId: f.snapshot.id });
  await controller.dispatch(second.assignment.id);
  const secondJob = f.store.snapshot().jobs!.find(job => job.assignmentId === second.assignment.id)!;
  f.store.recordJobTransition({
    jobId: secondJob.id,
    expectedRevision: secondJob.revision,
    to: 'COMPLETED',
    evidence: 'PROVIDER_REPORTED',
    detail: 'Finished.',
    outputs: [declare('later.json', '{"done":true}')],
  });

  const entry = requestQueue(f.store.snapshot()).find(item => item.id === f.request.id)!;
  assert.equal(entry.jobs!.length, 2, 'both jobs are reported, not just the latest assignment');
  assert.equal(entry.jobs!.filter(job => job.unresolved).length, 1);
  assert.equal(entry.jobs!.filter(job => job.settled).length, 1);
  // The completed job settled its own work only. The request still carries something unreconciled.
  assert.equal(entry.actions!.awaitingReconciliation, true, 'an unresolved job is never hidden by a completed one');
  assert.equal(entry.active, true);
});

test('the allowed-actions projection matches what the main process would actually permit', async t => {
  const f = await fixture(t);
  const controller = f.controller();

  const open = requestQueue(f.store.snapshot()).find(item => item.id === f.request.id)!;
  assert.deepEqual(open.actions, {
    prepare: true,
    cancel: true,
    retryPreparation: false,
    awaitingReconciliation: false,
  });

  // A job blocked before dispatch never reached a provider, so preparing again is safe and offered.
  const blocked = controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id });
  const atIntent = requestQueue(f.store.snapshot()).find(item => item.id === f.request.id)!;
  assert.equal(atIntent.jobs![0].state, 'INTENT');
  assert.equal(atIntent.actions!.retryPreparation, true, 'nothing was dispatched, so a fresh attempt is safe');
  assert.equal(atIntent.actions!.awaitingReconciliation, false);

  // Once it has been dispatched and its outcome is unknown, retrying is no longer safe.
  await controller.dispatch(blocked.assignment.id);
  const job = f.store.snapshot().jobs!.find(item => item.assignmentId === blocked.assignment.id)!;
  f.store.recordJobTransition({
    jobId: job.id,
    expectedRevision: job.revision,
    to: 'UNKNOWN',
    evidence: 'OFFICE_LOCAL',
    detail: 'unknown',
  });
  const unresolved = requestQueue(f.store.snapshot()).find(item => item.id === f.request.id)!;
  assert.equal(unresolved.actions!.retryPreparation, false, 'work that reached a provider must be reconciled first');
  assert.equal(unresolved.actions!.awaitingReconciliation, true);

  // Cancelling the request closes the offers, and the store agrees.
  const current = f.store.snapshot().requests!.find(item => item.id === f.request.id)!;
  f.store.execute({
    type: 'request.cancel',
    idempotencyKey: key(),
    requestId: f.request.id,
    expectedRevision: current.revision,
  });
  const canceled = requestQueue(f.store.snapshot()).find(item => item.id === f.request.id)!;
  assert.equal(canceled.actions!.prepare, false);
  assert.equal(canceled.actions!.cancel, false);
  assert.throws(
    () => controller.prepare({ requestId: f.request.id, agentId: f.worker.id, snapshotId: f.snapshot.id }),
    /was canceled/,
    'the projection agrees with the guard the main process enforces',
  );
});

test('a round of first reports opens only when every expected report is sealed', async t => {
  const f = await reviewFixture(t);
  const report = (reviewerAgentId: string, body: string) => ({
    id: randomUUID(),
    projectId: f.project.id,
    subjectAssignmentId: f.subject.assignment.id,
    reviewerAgentId,
    phase: 'FIRST' as const,
    contentHash: sha256(body),
    sealedAt: at(11),
    openedAt: null,
  });

  const first = report(f.reviewerA.id, 'The split plan does not purge the label horizon.');
  const sealed = f.store.sealFirstReport(first);
  assert.equal(sealed.sealed!.length, 1);
  assert.equal(sealed.sealed![0].openedAt, null, 'a sealed report is not readable as opened');

  // The author cannot file a first report on their own work, and nobody files twice.
  assert.throws(
    () => f.store.sealFirstReport(report(f.worker.id, 'looks fine to me')),
    /cannot file a first report on its own work/,
  );
  assert.throws(
    () => f.store.sealFirstReport(report(f.reviewerA.id, 'a second opinion of my own')),
    /already sealed a first report/,
  );
  assert.throws(
    () => f.store.sealFirstReport({ ...report(f.reviewerB.id, 'x'), id: first.id }),
    /identities are immutable/,
  );

  // The round will not open while the second reviewer is still forming an opinion.
  assert.throws(
    () =>
      f.store.openSealedRound({
        subjectAssignmentId: f.subject.assignment.id,
        expectedReviewerIds: [f.reviewerA.id, f.reviewerB.id],
      }),
    /1 of 2 first reports have not been sealed/,
  );

  const second = report(f.reviewerB.id, 'The fit scope overruns fold one.');
  f.store.sealFirstReport(second);
  const opened = f.store.openSealedRound({
    subjectAssignmentId: f.subject.assignment.id,
    expectedReviewerIds: [f.reviewerA.id, f.reviewerB.id],
    at: at(12),
  });
  assert.deepEqual(
    opened.sealed!.map(item => item.openedAt),
    [at(12), at(12)],
  );
  // The identities recorded at sealing are the ones that survive, so an edit in between would show.
  assert.deepEqual(opened.sealed!.map(item => item.contentHash).sort(), [first.contentHash, second.contentHash].sort());
});
