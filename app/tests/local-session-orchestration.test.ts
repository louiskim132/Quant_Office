import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { OutputService } from '../src/main/outputs';
import { prepareInputSnapshot } from '../src/main/locations';
import { removeTreeSync } from '../src/main/fsx';
import { AssignmentController, type ObserveResult, type ProviderAdapter, type SubmitContext, type SubmitResult } from '../src/main/controller';
import { LocalMailboxAdapter } from '../src/main/local-session';
import type { Discovery } from '../src/main/local-provider-records';
import { LocalWorktreeMailboxAdapter } from '../src/main/local-worktree-session';
import { LocalSessionRouter } from '../src/main/local-session-router';
import { CANCEL_ACK_FILE, CANCEL_FILE, PACKET_FILE, PACKET_HASH_FILE, PACKET_READY_FILE, RESULT_FILE } from '../src/main/local-packet';
import { localPacketV2Schema } from '../src/shared/local-session';
import { stageContextHash } from '../src/shared/pipeline';
import type { Agent, CapabilityOperation, Provider, ProviderJob } from '../src/shared/types';

const key = () => randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 19, 10, 0, 0) + minutes * 60000).toISOString();
/** A fixed clock inside every freshness window the fixture evidence declares. */
const clock = () => at(5);
const sha = (char = 'a') => char.repeat(64);

/** The local dispatch family the gate requires — office-observed, never provider attestation. */
const LOCAL_DISPATCH_OPS: CapabilityOperation[] = [
  'LOCAL_SUBMIT', 'LOCAL_OBSERVE', 'LOCAL_OUTPUT_FETCH', 'LOCAL_CANCEL',
  'MODEL_APPLICATION', 'EFFORT_APPLICATION', 'DELEGATION_CONTROL', 'TOOL_CONFINEMENT',
];
const localObservation = (minutes: number) => ({
  provider: 'claude' as const, identity: 'researcher@example.com', credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const, allowance: [], note: '',
  toolVersion: '2.1.236', transport: 'LOCAL_MAILBOX' as const, environment: 'LOCAL_MACHINE',
  models: [{ id: 'opus', name: 'Opus' }],
  operations: [
    { operation: 'ACCOUNT_STATUS' as const, level: 'ACCOUNT_VERIFIED' as const, detail: 'Signed in.', evidence: 'OBSERVED' as const, verifiedAt: at(minutes), source: 'fixture' },
    { operation: 'MODEL_CATALOG' as const, level: 'ACCOUNT_VERIFIED' as const, detail: 'Catalog read.', evidence: 'OBSERVED' as const, verifiedAt: at(minutes), source: 'fixture' },
    ...LOCAL_DISPATCH_OPS.map(operation => ({
      operation, level: 'TOOL_SUPPORTED' as const, detail: 'Exercised by the fixture.',
      evidence: 'OBSERVED' as const, verifiedAt: at(minutes), source: 'fixture',
      model: 'opus', route: 'LOCAL_MAILBOX' as const,
      ...(operation === 'EFFORT_APPLICATION' ? { effort: 'default' as const } : {}),
      ...(operation === 'DELEGATION_CONTROL' ? { delegation: false } : {}),
      ...(operation === 'TOOL_CONFINEMENT' ? {
        confinement: {
          tools: 'only the fixture packet tools', filesystem: 'the staged snapshot directory',
          network: 'no outbound network', environment: 'a user-launched session on this machine',
        },
      } : {}),
    })),
  ],
  source: 'transport fixture', observedAt: at(minutes),
});
/** A hosted account needs nothing but a signed-in fresh check for the handoff path. */
const hostedObservation = (minutes: number) => ({
  provider: 'openai' as const, identity: 'hosted@example.com', credentialContext: 'openai-cli',
  state: 'SIGNED_IN' as const, allowance: [], note: '',
  toolVersion: '1.0.0', transport: 'OFFICIAL_CLI_TERMINAL' as const, environment: 'anthropic-managed',
  models: [{ id: 'gpt-5', name: 'GPT-5' }],
  operations: [
    { operation: 'ACCOUNT_STATUS' as const, level: 'ACCOUNT_VERIFIED' as const, detail: 'Signed in.', evidence: 'OBSERVED' as const, verifiedAt: at(minutes), source: 'fixture' },
  ],
  source: 'transport fixture', observedAt: at(minutes),
});

/** Records the submit context it was given so the test can prove what was — or was not — bound. */
class HostedStub implements ProviderAdapter {
  readonly route = 'FAKE_ADAPTER' as const;
  readonly providers = ['openai' as const];
  submitted: SubmitContext[] = [];
  async submit(context: SubmitContext): Promise<SubmitResult> {
    this.submitted.push(context);
    return { externalId: 'hosted-1', externalUrl: '', detail: 'Opened by the hosted stub.' };
  }
  async observe(_job: ProviderJob): Promise<ObserveResult> { return { state: 'RUNNING', detail: 'Working.' }; }
  async cancel(_job: ProviderJob) { return { acknowledged: true, detail: 'Hosted cancel acknowledged.' }; }
}

async function fixture(t: any, opts: { discover?: (dir: string, provider: Provider) => Discovery; lifecycle?: import('../src/main/local-provider-lifecycle').ProviderLifecycle } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-local-orch-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => { try { store.close(); } catch {} removeTreeSync(root); });
  const sessionsRoot = path.join(root, 'local-sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  const project = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  const source = path.join(root, 'source'); mkdirSync(source); writeFileSync(path.join(source, 'input.csv'), 'a,b\n1,2\n');
  store.execute({ type: 'location.save', idempotencyKey: key(), projectId: project.id, expectedRevision: 0, localFolder: source, inputPaths: ['input.csv'], outputFolder: '' });
  const agent: Agent = { id: randomUUID(), name: 'Local worker', provider: 'claude', model: 'opus', team: 'Research', role: 'WORKER', instructions: '', effort: 'default',
    account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'LOCAL' };
  store.confirmAgentBinding({ observation: localObservation(0), agent });
  const request = store.execute({ type: 'request.create', idempotencyKey: key(), projectId: project.id, name: 'Local question', hypothesis: 'h', workType: 'QUESTION', mode: 'SINGLE', leadAgentId: agent.id, participantIds: [] }).requests![0];
  const snapshot = await prepareInputSnapshot({ store, objectRoot: root, stagingRoot: path.join(root, 'staging'), projectId: project.id, requestId: request.id, requestRevision: request.revision });
  const flat = new LocalMailboxAdapter(() => sessionsRoot, clock, undefined, opts.discover);
  const tree = new LocalWorktreeMailboxAdapter(() => path.join(root, 'local-repos'), clock);
  const mailbox = new LocalSessionRouter(id => store.localSessionForJob(id), { FLAT_PACKET: flat, PROJECT_WORKTREE: tree });
  const hosted = new HostedStub();
  const controller = new AssignmentController(store, mailbox, clock, undefined, undefined, undefined, undefined, new OutputService(store, root).storeBytes, undefined,
    ref => ref.route ? (ref.route === 'LOCAL_MAILBOX' ? mailbox : ref.route === hosted.route ? hosted : undefined)
      : ref.agent?.execution === 'LOCAL' ? mailbox : hosted,
    opts.lifecycle);
  return { root, store, project, agent, request, snapshot, sessionsRoot, mailbox, hosted, controller };
}

async function prepared(f: Awaited<ReturnType<typeof fixture>>, research?: Parameters<AssignmentController['prepare']>[0]['research']) {
  const { assignment } = f.controller.prepare({ requestId: f.request.id, agentId: f.agent.id, snapshotId: f.snapshot.id, ...(research ? { research } : {}) });
  const job = f.store.snapshot({ history: false }).jobs!.find(item => item.assignmentId === assignment.id)!;
  return { assignment, job };
}

const receipt = (job: ProviderJob, bound: { assignmentId: string; attemptId: string; packetHash: string | null }, sequence: number, state: 'RUNNING' | 'FAILED', detail: string,
  applied?: { model?: string; effort?: 'default' | 'low' | 'medium' | 'high' | 'max'; delegation?: boolean }) =>
  JSON.stringify({ schema: 'office-local-result@2', jobId: job.id, assignmentId: bound.assignmentId, attemptId: bound.attemptId, packetHash: bound.packetHash, sequence, state, detail, outputs: [], ...(applied ? { applied } : {}) }, null, 2);

test('dispatch prepares a PREPARING binding, submits against it and readies it with the packet hash', async t => {
  const f = await fixture(t);
  const { assignment, job } = await prepared(f);
  assert.equal(f.store.localSessionForJob(job.id), null, 'no binding exists before dispatch');
  const state = await f.controller.dispatch(assignment.id);
  const bound = f.store.localSessionForJob(job.id);
  assert.ok(bound, 'dispatch must create the delivery binding before submitting');
  assert.equal(bound.lifecycle, 'READY');
  assert.equal(bound.layout, 'FLAT_PACKET', 'scoped delivery selects the flat lane only — never a silent worktree');
  assert.equal(bound.packetVersion, 2);
  assert.match(bound.packetHash ?? '', /^[a-f0-9]{64}$/);
  assert.match(bound.storageRelativePath, /^session-[0-9A-Za-z]+-[0-9a-f-]{36}$/);
  assert.equal(bound.jobId, job.id);
  assert.equal(bound.assignmentId, assignment.id);
  assert.equal(bound.requirement, 'SCOPED_DELIVERY');
  assert.equal(bound.confinementStatus, 'UNVERIFIED');
  assert.equal(bound.stopStatus, 'NOT_REQUESTED');
  // The binding's storage path is the packet directory the adapter actually wrote.
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const packet = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(dir, PACKET_FILE), 'utf8')));
  assert.equal(packet.attemptId, bound.attemptId, 'the packet is bound to this exact attempt');
  assert.equal(packet.jobId, job.id);
  assert.equal(readFileSync(path.join(dir, PACKET_HASH_FILE), 'utf8').trim(), bound.packetHash, 'the recorded hash is the verified packet hash');
  assert.ok(existsSync(path.join(dir, PACKET_READY_FILE)), 'the ready marker was written last');
  // The job records the office's delivery honestly: UNKNOWN awaiting a session, named by the packet dir.
  const dispatched = state.jobs!.find(item => item.id === job.id)!;
  assert.equal(dispatched.state, 'UNKNOWN');
  assert.equal(dispatched.externalId, path.basename(bound.storageRelativePath));
  assert.deepEqual(f.store.localJournalFor(bound.id).map(entry => `${entry.kind}/${entry.phase}/${entry.outcome}`),
    ['PREPARE/INTENT/NONE', 'PREPARE/VERIFIED/SUCCESS'], 'durable intent first, verified outcome second');
});

test('a research-context dispatch is refused before any binding or submit', async t => {
  const f = await fixture(t);
  // Seed a real S0 research chain — branch, frozen spec, variant, request link and the PRINCIPAL
  // appointment — so the assignment is exactly what a prepared stage task would be. The launch
  // guards all pass; the lane classifier is the refusal under test: a research context requires
  // read confinement and no layout carries it.
  const SECTIONS = { estimand: 'e', splitPlan: 's', searchPlan: 'se', costContract: 'c', portfolioContract: 'p', metricsAndGates: 'm', holdoutPolicy: 'h' };
  f.store.execute({ type: 'research.draftSpec', idempotencyKey: key(), projectId: f.project.id, name: 'Lineage A', sections: SECTIONS, thresholds: [], notApplicable: [], maxSelectionTrials: 4 });
  let branch = f.store.snapshot().branches![0];
  f.store.execute({ type: 'research.freezeSpec', idempotencyKey: key(), specId: branch.specId!, expectedRevision: 0,
    prediction: { outcomeName: 'sharpe', sign: 'POSITIVE', expectedLow: 0, expectedHigh: 2, probability: 0.6, falsifiers: ['f'], existingKnowledge: 'none', retrospective: false } });
  const subjectHash = sha('b');
  f.store.execute({ type: 'research.registerVariant', idempotencyKey: key(), branchId: branch.id, kind: 'VARIANT', variantHash: subjectHash, description: 'first candidate' });
  branch = f.store.snapshot().branches![0];
  const agentNow = f.store.snapshot({ history: false }).agents!.find(item => item.id === f.agent.id)!;
  f.store.appendFunctionAssignment({ id: key(), projectId: f.project.id, stage: 'S0', function: 'PRINCIPAL', agentId: f.agent.id,
    agentRevision: agentNow.revision ?? 0, appendedAt: at(3), supersededById: null, origin: 'EXPLICIT', note: 'fixture' });
  f.store.recordPipeline({ id: key(), projectId: f.project.id, branchId: branch.id, createdAt: at(4),
    kind: 'LINK', requestId: f.request.id, subjectHash, requestRevision: f.request.revision, branchRevision: branch.revision });
  const objectHashes = [...f.snapshot.files.map(file => file.sha256), ...(f.snapshot.generated ?? []).map(file => file.sha256)].sort();
  const research = {
    branchId: branch.id, branchRevision: branch.revision, specId: branch.specId!, subjectHash,
    stage: 'S0' as const, function: 'PRINCIPAL' as const, outputSchema: 'research-stage-report@1' as const,
    objectHashes, requestRevision: f.request.revision,
    contextHash: stageContextHash({ branchId: branch.id, specId: branch.specId!, subjectHash, stage: 'S0', function: 'PRINCIPAL',
      agentId: f.agent.id, agentRevision: agentNow.revision ?? 0, outputSchema: 'research-stage-report@1',
      inputs: { branchRevision: branch.revision, requestRevision: f.request.revision, objectHashes } }),
  };
  const { assignment, job } = await prepared(f, research);
  await assert.rejects(() => f.controller.dispatch(assignment.id), /read confinement|must refuse|permitted layout/i);
  assert.equal(f.store.localSessionForJob(job.id), null, 'a refused classification never creates a binding');
  assert.equal(readdirSync(f.sessionsRoot).length, 0, 'no packet directory was written');
});

test('a verified v2 receipt persists lastReceipt and a replayed sequence defects on the next observe', async t => {
  const f = await fixture(t);
  const { assignment, job } = await prepared(f);
  await f.controller.dispatch(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(job, bound, 1, 'RUNNING', 'the session is working'));
  await f.controller.observe(assignment.id);
  const observed = f.store.localSessionForJob(job.id)!;
  assert.equal(observed.lastReceipt?.sequence, 1);
  assert.equal(observed.lastReceipt?.hash, createHash('sha256').update(readFileSync(path.join(dir, RESULT_FILE))).digest('hex'),
    'lastReceipt pins the exact receipt bytes the office read');
  assert.equal(f.store.snapshot({ history: false }).jobs![0].state, 'RUNNING');
  // A receipt that does not advance is a defect, never a refresh: the binding still names receipt 1.
  writeFileSync(path.join(dir, RESULT_FILE), receipt(job, bound, 1, 'RUNNING', 'a replayed receipt'));
  await f.controller.observe(assignment.id);
  const after = f.store.localSessionForJob(job.id)!;
  assert.equal(after.lastReceipt?.sequence, 1, 'the replayed receipt was refused, not persisted');
  assert.notEqual(after.lastReceipt?.hash, createHash('sha256').update(readFileSync(path.join(dir, RESULT_FILE))).digest('hex'));
  assert.equal(f.store.snapshot({ history: false }).jobs![0].state, 'RUNNING', 'a defect observation moves nothing');
});

test('a v2 applied self-report binds to its receipt, and a return to an earlier value still lands (A→B→A)', async t => {
  const f = await fixture(t);
  const { assignment, job } = await prepared(f);
  await f.controller.dispatch(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  for (const [sequence, effort] of [[1, 'low'], [2, 'high'], [3, 'low']] as const) {
    writeFileSync(path.join(dir, RESULT_FILE), receipt(job, bound, sequence, 'RUNNING', `receipt ${sequence}`, { model: 'opus', effort }));
    await f.controller.observe(assignment.id);
  }
  const applied = f.store.appliedReports(job.id);
  assert.equal(applied.length, 3, 'each receipt is its own verified claim — a repeated value on a new receipt is not a duplicate');
  assert.equal(applied[0].applied?.effort, 'low');
  assert.equal(applied[1].applied?.effort, 'high');
  assert.equal(applied[2].applied?.effort, 'low', 'the third report lands even though its content equals the first');
  assert.equal(applied[2].applied?.attemptId, bound.attemptId, 'the structured payload binds to the exact attempt');
  assert.equal(applied[2].applied?.receiptSequence, 3);
  assert.equal(applied[2].applied?.receiptHash, createHash('sha256').update(readFileSync(path.join(dir, RESULT_FILE))).digest('hex'),
    'the payload names the exact receipt bytes it rode in on');
});

test('the local-session summary surfaces binding, requested scope, applied report and honest blockers', async t => {
  const f = await fixture(t);
  const { assignment, job } = await prepared(f);
  assert.equal(f.store.localSessionSummary(job.id, record => record.storageRelativePath), null, 'no summary exists before a binding does');
  await f.controller.dispatch(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(job, bound, 1, 'RUNNING', 'working', { model: 'opus', effort: 'high' }));
  await f.controller.observe(assignment.id);
  const summary = f.store.localSessionSummary(job.id, record => `root/${record.storageRelativePath}`)!;
  assert.equal(summary.jobId, job.id);
  assert.equal(summary.localSessionId, bound.id);
  assert.equal(summary.lifecycle, 'READY');
  assert.equal(summary.layout, 'FLAT_PACKET');
  assert.equal(summary.stopStatus, 'NOT_REQUESTED');
  assert.equal(summary.cwdDisplay, `root/${bound.storageRelativePath}`, 'the display path resolves through the injected root');
  assert.equal(summary.requested.model, 'opus');
  assert.equal(summary.requested.effort, 'default');
  assert.equal(summary.applied?.receiptSequence, 1);
  assert.equal(summary.applied?.model, 'opus');
  assert.deepEqual(summary.archive, { packet: 'LIVE', provider: 'NOT_REQUESTED' });
  assert.deepEqual(summary.blockers, []);
  // A delivered cancel request is outstanding, not a stopped session — the summary says so.
  await f.controller.cancel(assignment.id);
  const requested = f.store.localSessionSummary(job.id, record => record.storageRelativePath)!;
  assert.equal(requested.stopStatus, 'REQUESTED');
  assert.ok(requested.blockers.some(blocker => /cancellation request/i.test(blocker)));
});

test('a resolved provider record upgrades grouping to OBSERVED — absence stays UNKNOWN and downgrades nothing', async t => {
  let found = false;
  const discovery = { records: [{ provider: 'claude' as const, kind: 'claude-project' as const, id: 'C--packet-dir', detail: 'provider record', location: 'records-root' }], notes: [] };
  const f = await fixture(t, { discover: () => (found ? discovery : { records: [], notes: [] }) });
  const { assignment, job } = await prepared(f);
  await f.controller.dispatch(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  assert.equal(bound.groupingStatus, 'UNKNOWN');
  // A resolved record is real evidence even before any receipt exists — the job is UNKNOWN
  // awaiting the session, but the office observed the provider-side grouping.
  await f.controller.observe(assignment.id);
  assert.equal(f.store.localSessionForJob(job.id)!.groupingStatus, 'UNKNOWN', 'no record found — nothing inferred');
  found = true;
  await f.controller.observe(assignment.id);
  const observed = f.store.localSessionForJob(job.id)!;
  assert.equal(observed.groupingStatus, 'OBSERVED', 'the resolved record upgrades the claim on the binding');
  assert.equal(observed.providerProjectId, 'C--packet-dir', 'the provider\'s own record identity is the label');
  const summary = f.store.localSessionSummary(job.id, record => record.storageRelativePath)!;
  assert.deepEqual(summary.grouping, { status: 'OBSERVED', label: 'C--packet-dir' });
  // A later observe finding nothing downgrades nothing — OBSERVED stays.
  found = false;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(job, bound, 1, 'RUNNING', 'working'));
  await f.controller.observe(assignment.id);
  assert.equal(f.store.localSessionForJob(job.id)!.groupingStatus, 'OBSERVED');
});

test('cancel persists the request id and REQUESTED; the session acknowledgement persists SESSION_REPORTED_STOPPED', async t => {
  const f = await fixture(t);
  const { assignment, job } = await prepared(f);
  await f.controller.dispatch(assignment.id);
  await f.controller.cancel(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  assert.match(bound.cancelRequestId ?? '', /^[0-9a-f-]{36}$/, 'the delivered request id is persisted on the binding');
  assert.equal(bound.stopStatus, 'REQUESTED');
  const journal = f.store.localJournalFor(bound.id);
  assert.equal(`${journal.at(-1)!.kind}/${journal.at(-1)!.phase}/${journal.at(-1)!.outcome}`, 'CANCEL_REQUEST/EXECUTED/SUCCESS');
  // The office delivered a request — nothing has stopped, so the job stays open for the session's ack.
  assert.equal(f.store.snapshot({ history: false }).jobs![0].state, 'CANCEL_REQUESTED');
  assert.ok(existsSync(path.join(f.sessionsRoot, bound.storageRelativePath, CANCEL_FILE)), 'the request file exists in the packet directory');
  // The session answers: a final receipt plus an acknowledgement bound to the exact request.
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(job, bound, 1, 'FAILED', 'stopped at the office request'));
  writeFileSync(path.join(dir, CANCEL_ACK_FILE), JSON.stringify({
    schema: 'office-local-cancel-ack@1', requestId: bound.cancelRequestId, jobId: job.id,
    assignmentId: assignment.id, attemptId: bound.attemptId, packetHash: bound.packetHash,
    outcome: 'STOPPED', detail: 'stopped cleanly',
  }));
  await f.controller.observe(assignment.id);
  const after = f.store.localSessionForJob(job.id)!;
  assert.equal(after.stopStatus, 'SESSION_REPORTED_STOPPED', 'the session self-report lands on the binding');
  assert.equal(after.lastReceipt?.sequence, 1, 'the final receipt identity is recorded too');
  assert.equal(f.store.snapshot({ history: false }).jobs![0].state, 'FAILED');
});

test('a throwing submit marks PREPARATION_FAILED and re-dispatch re-attempts a fresh attempt in a fresh directory', async t => {
  const f = await fixture(t);
  const { assignment, job } = await prepared(f);
  // Sabotage the sessions root — a file where the directory must be makes the guarded write fail.
  rmSync(f.sessionsRoot, { recursive: true });
  writeFileSync(f.sessionsRoot, 'not a directory');
  await f.controller.dispatch(assignment.id);
  const failed = f.store.localSessionForJob(job.id)!;
  assert.equal(failed.lifecycle, 'PREPARATION_FAILED');
  assert.deepEqual(f.store.localJournalFor(failed.id).map(entry => `${entry.kind}/${entry.phase}`), ['PREPARE/INTENT', 'PREPARE/FAILED']);
  assert.ok(!existsSync(path.join(f.root, 'local-sessions', failed.storageRelativePath)), 'the failed attempt wrote nothing');
  // Re-dispatch re-attempts through the declared PREPARATION_FAILED → PREPARING edge: the same
  // record, a fresh attempt id, a fresh directory. The job axis cannot re-enter SUBMITTING from
  // UNKNOWN — the reducer refuses that move — so the fresh PREPARING waits for reconciliation.
  rmSync(f.sessionsRoot); mkdirSync(f.sessionsRoot, { recursive: true });
  await assert.rejects(() => f.controller.dispatch(assignment.id));
  const again = f.store.localSessionForJob(job.id)!;
  assert.equal(again.id, failed.id, 'the same binding record is re-attempted, never silently rebound');
  assert.equal(again.lifecycle, 'PREPARING');
  assert.notEqual(again.attemptId, failed.attemptId);
  assert.notEqual(again.storageRelativePath, failed.storageRelativePath);
  assert.equal(again.packetHash, null);
  assert.equal(f.store.localJournalFor(failed.id).filter(entry => entry.phase === 'INTENT').length, 2, 'each attempt journals its own intent');
});

test('handoff on a local route gets the same binding treatment', async t => {
  const f = await fixture(t);
  const { assignment, job } = await prepared(f);
  await f.controller.handoff(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  assert.ok(bound, 'handoff must create the delivery binding before submitting');
  assert.equal(bound.lifecycle, 'READY');
  assert.equal(bound.layout, 'FLAT_PACKET');
  assert.match(bound.packetHash ?? '', /^[a-f0-9]{64}$/);
  assert.ok(existsSync(path.join(f.sessionsRoot, bound.storageRelativePath, PACKET_FILE)));
  assert.deepEqual(f.store.localJournalFor(bound.id).map(entry => `${entry.kind}/${entry.phase}/${entry.outcome}`),
    ['PREPARE/INTENT/NONE', 'PREPARE/VERIFIED/SUCCESS']);
});

test('a hosted route never receives a binding', async t => {
  const f = await fixture(t);
  const hostedAgent: Agent = { id: randomUUID(), name: 'Hosted worker', provider: 'openai', model: 'gpt-5', team: 'Research', role: 'WORKER', instructions: '', effort: 'default',
    account: 'hosted@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'HOSTED_SETUP_REQUIRED' };
  f.store.confirmAgentBinding({ observation: hostedObservation(0), agent: hostedAgent });
  const hostedRequest = f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name: 'Hosted question', hypothesis: 'h', workType: 'QUESTION', mode: 'SINGLE', leadAgentId: hostedAgent.id, participantIds: [] }).requests!.find(item => item.leadAgentId === hostedAgent.id)!;
  const hostedSnapshot = await prepareInputSnapshot({ store: f.store, objectRoot: f.root, stagingRoot: path.join(f.root, 'staging'), projectId: f.project.id, requestId: hostedRequest.id, requestRevision: hostedRequest.revision });
  const { assignment, job } = await (() => {
    const preparedHosted = f.controller.prepare({ requestId: hostedRequest.id, agentId: hostedAgent.id, snapshotId: hostedSnapshot.id });
    return { assignment: preparedHosted.assignment, job: f.store.snapshot({ history: false }).jobs!.find(item => item.assignmentId === preparedHosted.assignment.id)! };
  })();
  await f.controller.handoff(assignment.id);
  assert.equal(f.hosted.submitted.length, 1);
  assert.equal(f.hosted.submitted[0].localSession, undefined, 'hosted submissions never carry a local binding');
  assert.equal(f.store.localSessionForJob(job.id), null);
});

test('a pre-binding legacy job still observes through the explicit legacy rule', async t => {
  const f = await fixture(t);
  const { assignment } = await prepared(f);
  let job = f.store.snapshot({ history: false }).jobs![0];
  // Mint the packet exactly as the pre-binding adapter did — a bare session name under the root —
  // and record the job the way a legacy dispatch left it: UNKNOWN carrying only the dir name.
  const dir = path.join(f.sessionsRoot, 'session-legacy');
  mkdirSync(dir);
  writeFileSync(path.join(dir, PACKET_FILE), JSON.stringify({ schema: 'office-local-session@1', assignmentId: assignment.id }));
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ state: 'RUNNING', detail: 'legacy session working', outputs: [] }));
  let state = f.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'SUBMITTING', evidence: 'OFFICE_LOCAL', detail: 'legacy dispatch', at: at(6) });
  job = state.jobs![0];
  state = f.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'UNKNOWN', evidence: 'OFFICE_LOCAL', detail: 'legacy submitted', externalId: 'session-legacy', at: at(6) });
  job = state.jobs![0];
  assert.equal(f.store.localSessionForJob(job.id), null, 'a pre-binding job carries no record');
  const observed = await f.controller.observe(assignment.id);
  const after = observed.jobs![0];
  assert.equal(after.state, 'RUNNING');
  assert.match(after.detail, /legacy binding/, 'the explicit legacy rule is named, never a silent fallback');
});

test('retireLocal archives the packet under archive/, journals both phases, and honestly reports no provider request', async t => {
  const f = await fixture(t);
  const { assignment, job } = await prepared(f);
  await f.controller.dispatch(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  // A terminal job is the eligibility gate — drive it there with a FAILED receipt.
  writeFileSync(path.join(dir, RESULT_FILE), receipt(job, bound, 1, 'FAILED', 'the session reported failure'));
  await f.controller.observe(assignment.id);
  assert.equal(f.store.snapshot({ history: false }).jobs![0].state, 'FAILED');
  const result = await f.controller.retireLocal(assignment.id);
  assert.equal(result.archive.packetOutcome, 'ARCHIVED');
  assert.equal(result.archive.providerOutcome, 'NOT_REQUESTED', 'no provider record was ever observed — nothing was requested');
  assert.match(result.archive.detail, /No provider-side record identity/);
  const retired = f.store.localSessionForJob(job.id)!;
  assert.equal(retired.lifecycle, 'ARCHIVED');
  assert.equal(retired.archiveRelativePath, `archive/${bound.storageRelativePath}`);
  assert.ok(!existsSync(dir), 'the live packet dir moved');
  assert.ok(existsSync(path.join(f.sessionsRoot, 'archive', bound.storageRelativePath)), 'the bytes are retained under archive/');
  assert.deepEqual(f.store.localJournalFor(bound.id).filter(e => e.kind === 'PACKET_ARCHIVE').map(e => `${e.phase}/${e.outcome}`),
    ['INTENT/NONE', 'EXECUTED/SUCCESS'], 'durable intent first, executed outcome second');
  // The summary reads the archived record — packet archived, provider untouched.
  const summary = f.store.localSessionSummary(job.id, record => record.storageRelativePath)!;
  assert.deepEqual(summary.archive, { packet: 'ARCHIVED', provider: 'NOT_REQUESTED' });
});

test('retireLocal runs provider archive only through the injected lifecycle, keeping the outcomes separate', async t => {
  const calls: { provider: string; providerSessionId: string }[] = [];
  const discovery = { records: [{ provider: 'claude' as const, kind: 'claude-project' as const, id: 'C--packet-dir', detail: 'provider record', location: 'records-root' }], notes: [] };
  const f = await fixture(t, {
    discover: () => discovery,
    lifecycle: {
      async inspect() { return { status: 'UNSUPPORTED' as const, detail: 'claude history is preserved' }; },
      async archive(binding: { provider: string; providerSessionId: string }, _op: string) {
        calls.push(binding);
        return { status: 'UNSUPPORTED' as const, detail: 'claude has no archive verb — history preserved' };
      },
    },
  });
  const { assignment, job } = await prepared(f);
  await f.controller.dispatch(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  // Grouping discovery on observe pins the provider's record identity onto the binding.
  await f.controller.observe(assignment.id);
  assert.equal(f.store.localSessionForJob(job.id)!.providerSessionId, 'C--packet-dir');
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(job, bound, 1, 'FAILED', 'done'));
  await f.controller.observe(assignment.id);
  const result = await f.controller.retireLocal(assignment.id);
  assert.equal(result.archive.packetOutcome, 'ARCHIVED');
  assert.equal(result.archive.providerOutcome, 'UNSUPPORTED', 'provider archive ran but the provider has no verb');
  assert.deepEqual(calls, [{ provider: 'claude', providerSessionId: 'C--packet-dir' }], 'the exact observed record identity was the archive target');
  assert.deepEqual(f.store.localJournalFor(bound.id).filter(e => e.kind === 'PROVIDER_ARCHIVE').map(e => `${e.phase}/${e.outcome}`),
    ['EXECUTED/UNSUPPORTED'], 'the provider outcome is journaled independently of the packet');
  const summary = f.store.localSessionSummary(job.id, record => record.storageRelativePath)!;
  assert.deepEqual(summary.archive, { packet: 'ARCHIVED', provider: 'UNSUPPORTED' });
});

test('retireLocal journals BUSY and UNKNOWN provider outcomes without conflating them with the packet', async t => {
  const f = await fixture(t, {
    discover: () => ({ records: [{ provider: 'claude' as const, kind: 'claude-project' as const, id: 'C--dir', detail: 'r', location: 'l' }], notes: [] }),
    lifecycle: {
      async inspect() { return { status: 'BUSY' as const, detail: 'in use' }; },
      async archive() { return { status: 'BUSY' as const, detail: 'the provider reports the record busy' }; },
    },
  });
  const { assignment, job } = await prepared(f);
  await f.controller.dispatch(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  await f.controller.observe(assignment.id);
  writeFileSync(path.join(f.sessionsRoot, bound.storageRelativePath, RESULT_FILE), receipt(job, bound, 1, 'FAILED', 'done'));
  await f.controller.observe(assignment.id);
  const result = await f.controller.retireLocal(assignment.id);
  assert.equal(result.archive.packetOutcome, 'ARCHIVED');
  assert.equal(result.archive.providerOutcome, 'BUSY', 'busy is reported as busy — never as archived');
  const providerRow = f.store.localJournalFor(bound.id).find(e => e.kind === 'PROVIDER_ARCHIVE')!;
  assert.equal(providerRow.outcome, 'REFUSED');
  assert.match(providerRow.failureDetail ?? '', /busy/i);
});

test('retireLocal refuses non-terminal jobs, missing packets and unbound work before touching anything', async t => {
  const f = await fixture(t);
  const { assignment, job } = await prepared(f);
  // No binding at all.
  await assert.rejects(() => f.controller.retireLocal(assignment.id), /no local-session binding/);
  await f.controller.dispatch(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  // A live job never retires — a packet under an active session must not move.
  await assert.rejects(() => f.controller.retireLocal(assignment.id), /only finished work retires/);
  assert.deepEqual(f.store.localJournalFor(bound.id).filter(e => e.kind === 'PACKET_ARCHIVE'), [], 'a refused gate writes no archive journal');
  assert.equal(f.store.localSessionForJob(job.id)!.lifecycle, 'READY');
  // Missing packet directory: terminal job, but the dir is gone — honest REFUSED, back to READY.
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(job, bound, 1, 'FAILED', 'done'));
  await f.controller.observe(assignment.id);
  assert.equal(f.store.snapshot({ history: false }).jobs![0].state, 'FAILED');
  rmSync(dir, { recursive: true, force: true });
  const result = await f.controller.retireLocal(assignment.id);
  assert.equal(result.archive.packetOutcome, 'REFUSED');
  assert.equal(f.store.localSessionForJob(job.id)!.lifecycle, 'READY', 'a refused move restores READY — it never claims ARCHIVED');
  assert.deepEqual(f.store.localJournalFor(bound.id).filter(e => e.kind === 'PACKET_ARCHIVE').map(e => `${e.phase}/${e.outcome}`),
    ['INTENT/NONE', 'EXECUTED/REFUSED']);
});

test('the launch plan surfaces the packet location, hash and manual steps — and goes UNSUPPORTED once archived', async t => {
  const f = await fixture(t);
  const { assignment, job } = await prepared(f);
  assert.equal(f.store.localLaunchPlan(job.id, record => record.storageRelativePath), null, 'no plan before a binding');
  await f.controller.dispatch(assignment.id);
  const bound = f.store.localSessionForJob(job.id)!;
  const plan = f.store.localLaunchPlan(job.id, record => `root/${record.storageRelativePath}`)!;
  assert.equal(plan.jobId, job.id);
  assert.equal(plan.revision, bound.revision);
  assert.equal(plan.packetHash, bound.packetHash);
  assert.equal(plan.availability, 'MANUAL_HANDOFF');
  assert.match(plan.cwdDisplay, /^root\//);
  assert.ok(plan.instructions.length >= 3);
  assert.match(plan.instructions[0], /open a terminal/i);
  assert.match(plan.instructions[1], /claude/, 'the provider CLI is named');
  // Archived packets report UNSUPPORTED, not a runnable handoff.
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(job, bound, 1, 'FAILED', 'done'));
  await f.controller.observe(assignment.id);
  await f.controller.retireLocal(assignment.id);
  const retiredPlan = f.store.localLaunchPlan(job.id, record => `root/${record.archiveRelativePath ?? record.storageRelativePath}`)!;
  assert.equal(retiredPlan.availability, 'UNSUPPORTED');
  assert.match(retiredPlan.detail, /archived/i);
});
