import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { OfficeStore } from '../src/core/store';
import { OutputService } from '../src/main/outputs';
import { prepareInputSnapshot, snapshotObjectPath } from '../src/main/locations';
import { removeTreeSync } from '../src/main/fsx';
import { AssignmentController, type ObserveResult, type ProviderAdapter, type SubmitContext, type SubmitResult } from '../src/main/controller';
import { LocalMailboxAdapter } from '../src/main/local-session';
import { LocalCliExecAdapter, type CliSpawn, type CliSpawnOptions } from '../src/main/local-cli-exec';
import { LocalSessionRouter } from '../src/main/local-session-router';
import { INPUTS_DIR, PACKET_FILE, RESULT_FILE } from '../src/main/local-packet';
import { localPacketV2Schema } from '../src/shared/local-session';
import type { Agent, CapabilityOperation, ProviderJob } from '../src/shared/types';

const key = () => randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 19, 10, 0, 0) + minutes * 60000).toISOString();
const clock = () => at(5);
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The local dispatch family the launch gate requires — office-observed, never provider attestation. */
const LOCAL_DISPATCH_OPS: CapabilityOperation[] = [
  'LOCAL_SUBMIT', 'LOCAL_OBSERVE', 'LOCAL_OUTPUT_FETCH', 'LOCAL_CANCEL',
  'MODEL_APPLICATION', 'EFFORT_APPLICATION', 'DELEGATION_CONTROL', 'TOOL_CONFINEMENT',
];
const localObservation = (route: 'LOCAL_MAILBOX' | 'LOCAL_CLI_EXEC', minutes: number) => ({
  provider: 'claude' as const, identity: 'researcher@example.com', credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const, allowance: [], note: '',
  toolVersion: '2.1.236', transport: route, environment: 'LOCAL_MACHINE',
  models: [{ id: 'opus', name: 'Opus' }],
  operations: [
    { operation: 'ACCOUNT_STATUS' as const, level: 'ACCOUNT_VERIFIED' as const, detail: 'Signed in.', evidence: 'OBSERVED' as const, verifiedAt: at(minutes), source: 'fixture' },
    { operation: 'MODEL_CATALOG' as const, level: 'ACCOUNT_VERIFIED' as const, detail: 'Catalog read.', evidence: 'OBSERVED' as const, verifiedAt: at(minutes), source: 'fixture' },
    ...LOCAL_DISPATCH_OPS.map(operation => ({
      operation, level: 'TOOL_SUPPORTED' as const, detail: 'Exercised by the fixture.',
      evidence: 'OBSERVED' as const, verifiedAt: at(minutes), source: 'fixture',
      model: 'opus', route,
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

/** Records every submit it receives; never actually hosts anything. */
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

/** A scripted child process — emits output, records kills, exits on command. Never a real spawn. */
class FakeChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  private readonly listeners = {
    exit: [] as ((code: number | null, signal: NodeJS.Signals | null) => void)[],
    error: [] as ((error: Error) => void)[],
  };
  constructor(readonly pid: number | undefined = 4321) {}
  kill(signal?: NodeJS.Signals | number) { this.kills.push(signal); return true; }
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit' | 'error', listener: unknown) {
    if (event === 'exit') this.listeners.exit.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    else this.listeners.error.push(listener as (error: Error) => void);
    return this;
  }
  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) { for (const listener of this.listeners.exit) listener(code, signal); }
  emitError(error: Error) { for (const listener of this.listeners.error) listener(error); }
}
interface SpawnCall { executable: string; args: string[]; options: CliSpawnOptions; child: FakeChild }

async function fixture(t: any, options: { route?: 'LOCAL_MAILBOX' | 'LOCAL_CLI_EXEC'; readObject?: (hash: string) => Promise<Uint8Array>; events?: string[] } = {}) {
  const route = options.route ?? 'LOCAL_CLI_EXEC';
  const root = mkdtempSync(path.join(tmpdir(), 'qro-local-chain-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => { exec.disposeAll(); try { store.close(); } catch {} removeTreeSync(root); });
  const sessionsRoot = path.join(root, 'local-sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  const project = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  const source = path.join(root, 'source'); mkdirSync(source); writeFileSync(path.join(source, 'input.csv'), 'a,b\n1,2\n');
  store.execute({ type: 'location.save', idempotencyKey: key(), projectId: project.id, expectedRevision: 0, localFolder: source, inputPaths: ['input.csv'], outputFolder: '' });
  const agent: Agent = { id: randomUUID(), name: 'Local worker', provider: 'claude', model: 'opus', team: 'Research', role: 'WORKER', instructions: '', effort: 'default',
    account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'LOCAL',
    ...(route === 'LOCAL_CLI_EXEC' ? { localRoute: 'LOCAL_CLI_EXEC' as const } : {}) };
  store.confirmAgentBinding({ observation: localObservation(route, 0), agent });
  const hostedAgent: Agent = { id: randomUUID(), name: 'Hosted worker', provider: 'openai', model: 'gpt-5', team: 'Research', role: 'WORKER', instructions: '', effort: 'default',
    account: 'hosted@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'HOSTED_SETUP_REQUIRED' };
  store.confirmAgentBinding({ observation: hostedObservation(0), agent: hostedAgent });
  const request = store.execute({ type: 'request.create', idempotencyKey: key(), projectId: project.id, name: 'Local question', hypothesis: 'h', workType: 'QUESTION', mode: 'SINGLE', leadAgentId: agent.id, participantIds: [] }).requests![0];
  const snapshot = await prepareInputSnapshot({ store, objectRoot: root, stagingRoot: path.join(root, 'staging'), projectId: project.id, requestId: request.id, requestRevision: request.revision });
  const calls: SpawnCall[] = [];
  const spawn: CliSpawn = (executable, args, spawnOptions) => {
    const child = new FakeChild();
    calls.push({ executable, args, options: spawnOptions, child });
    return child;
  };
  const exec = new LocalCliExecAdapter(() => sessionsRoot, provider => `${provider}.exe`, clock, undefined, spawn,
    () => ({ TEST_ENV: 'scrubbed' }), undefined, undefined, agentId => store.snapshot().agents.find(a => a.id === agentId)?.provider,
    options.events ? jobId => options.events!.push(jobId) : undefined);
  const flat = new LocalMailboxAdapter(() => sessionsRoot, clock);
  const local = route === 'LOCAL_CLI_EXEC'
    ? new LocalSessionRouter(id => store.localSessionForJob(id), { FLAT_PACKET: exec, PROJECT_WORKTREE: exec }, 'LOCAL_CLI_EXEC')
    : new LocalSessionRouter(id => store.localSessionForJob(id), { FLAT_PACKET: flat, PROJECT_WORKTREE: flat });
  const hosted = new HostedStub();
  const outputs = new OutputService(store, root);
  const controller = new AssignmentController(store, local, clock, () => Promise.resolve([]), undefined, undefined, undefined,
    outputs.storeBytes, undefined,
    ref => ref.route ? (ref.route === route ? local : ref.route === hosted.route ? hosted : undefined)
      : ref.agent?.execution === 'LOCAL' ? local : hosted,
    undefined, options.readObject ?? outputs.readBytes);
  return { root, store, project, agent, hostedAgent, request, snapshot, sessionsRoot, calls, exec, local, hosted, controller, outputs };
}

async function prepared(f: Awaited<ReturnType<typeof fixture>>, opts: { dependsOn?: string[]; agent?: Agent; name?: string } = {}) {
  // Every chain node gets its own request: the store refuses a second open job for the same
  // request and agent, and distinct requests are how real dependencies are declared anyway.
  const agent = opts.agent ?? f.agent;
  const name = opts.name ?? `Question ${key().slice(0, 8)}`;
  const request = f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name, hypothesis: 'h', workType: 'QUESTION', mode: 'SINGLE', leadAgentId: agent.id, participantIds: [] }).requests!.find(item => item.name === name)!;
  const snapshot = await prepareInputSnapshot({ store: f.store, objectRoot: f.root, stagingRoot: path.join(f.root, 'staging'), projectId: f.project.id, requestId: request.id, requestRevision: request.revision });
  const { assignment } = f.controller.prepare({ requestId: request.id, agentId: agent.id, snapshotId: snapshot.id, ...(opts.dependsOn?.length ? { dependsOn: opts.dependsOn } : {}) });
  const job = f.store.snapshot({ history: false }).jobs!.find(item => item.assignmentId === assignment.id)!;
  return { assignment, job };
}

/** Launches a job and returns its bound packet directory. */
async function launched(f: Awaited<ReturnType<typeof fixture>>, assignmentId: string, jobId: string) {
  await f.controller.handoff(assignmentId);
  const bound = f.store.localSessionForJob(jobId)!;
  return { bound, dir: path.join(f.sessionsRoot, bound.storageRelativePath) };
}

/** A well-formed v2 receipt bound to the packet on disk. */
function receipt(job: ProviderJob, bound: { assignmentId: string; attemptId: string; packetHash: string | null }, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema: 'office-local-result@2', jobId: job.id, assignmentId: bound.assignmentId,
    attemptId: bound.attemptId, packetHash: bound.packetHash, sequence: 1,
    state: 'COMPLETED', detail: 'Done.', outputs: [], ...overrides,
  });
}

/**
 * Drives a launched job to a verified COMPLETED with one declared output — the contract requires
 * attributable output for completion, so a predecessor always produces a file. Returns the output
 * inventory entry exactly as the receipt declared it.
 */
async function complete(f: Awaited<ReturnType<typeof fixture>>, node: { assignment: { id: string }; job: ProviderJob }, text = 'predecessor result') {
  const { bound, dir } = await launched(f, node.assignment.id, node.job.id);
  const output = { path: 'outputs/report.txt', sha256: sha(text), bytes: Buffer.byteLength(text) };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'report.txt'), text);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(node.job, bound, { outputs: [output] }));
  await f.controller.observe(node.assignment.id);
  assert.equal(f.store.snapshot({ history: false }).jobs!.find(item => item.id === node.job.id)!.state, 'COMPLETED');
  return { bound, dir, output };
}

const packetOf = (dir: string) => localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(dir, PACKET_FILE), 'utf8')));
const jobState = (f: Awaited<ReturnType<typeof fixture>>, jobId: string) => f.store.snapshot({ history: false }).jobs!.find(item => item.id === jobId)!.state;

test('a dependent auto-launches when its predecessor completes, inheriting verified outputs', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id] });
  const { bound } = await launched(f, a.assignment.id, a.job.id);
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  // The predecessor reports one real output; the office fetches, verifies and stores it on observe.
  const output = { path: 'outputs/report.txt', sha256: sha('predecessor findings'), bytes: Buffer.byteLength('predecessor findings') };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'report.txt'), 'predecessor findings');
  writeFileSync(path.join(dir, RESULT_FILE), receipt(a.job, bound, { outputs: [output] }));
  await f.controller.observe(a.assignment.id);
  assert.equal(jobState(f, a.job.id), 'COMPLETED');
  assert.equal(f.store.snapshot({ history: false }).jobs!.find(item => item.id === a.job.id)!.outputs[0].stored, true);

  await f.controller.advanceLocalChain(a.assignment.id);
  assert.equal(jobState(f, b.job.id), 'UNKNOWN', 'the dependent was launched, not completed');
  assert.equal(f.calls.length, 2, 'the dependent spawned its own process');
  const bBound = f.store.localSessionForJob(b.job.id)!;
  const bDir = path.join(f.sessionsRoot, bBound.storageRelativePath);
  const inheritedPath = `${INPUTS_DIR}/inherited/${a.job.id}/report.txt`;
  assert.equal(readFileSync(path.join(bDir, inheritedPath), 'utf8'), 'predecessor findings', 'verified predecessor bytes landed in the dependent inputs');
  const packet = packetOf(bDir);
  assert.deepEqual(packet.inherited, [{ path: inheritedPath, sha256: output.sha256, bytes: output.bytes, sourceJobId: a.job.id, objectHash: output.sha256 }],
    'the manifest pins the exact producing job and object identity');
  const events = f.store.snapshot({ history: true }).jobEvents?.filter(item => item.jobId === b.job.id) ?? [];
  assert.ok(events.some(item => item.externalId === `chain-launch:${b.job.id}`), 'the automatic launch is recorded as office testimony');
});

test('a dependent stays INTENT while its predecessor is running, failed, or unverified', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id] });
  // Predecessor launched but not yet reported — the dependent waits.
  const { bound } = await launched(f, a.assignment.id, a.job.id);
  await f.controller.advanceLocalChain(a.assignment.id);
  assert.equal(jobState(f, b.job.id), 'INTENT');
  assert.equal(f.calls.length, 1, 'no second spawn while the predecessor is open');
  // A failed predecessor is an end state the dependent cannot run on.
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(a.job, bound, { state: 'FAILED', detail: 'the session reported failure' }));
  await f.controller.observe(a.assignment.id);
  assert.equal(jobState(f, a.job.id), 'FAILED');
  await f.controller.advanceLocalChain(a.assignment.id);
  assert.equal(jobState(f, b.job.id), 'INTENT', 'a failed predecessor never unlocks the dependent');
  await assert.rejects(() => f.controller.handoff(b.assignment.id), /waits on other work/, 'a manual launch refuses identically');
});

test('a predecessor whose reported output fails verification never unlocks the dependent', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id] });
  const { bound } = await launched(f, a.assignment.id, a.job.id);
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  // The receipt claims bytes the file does not contain — the reader defects the receipt, the
  // job stays honestly UNKNOWN, and nothing downstream may proceed on it.
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'report.txt'), 'actual bytes');
  writeFileSync(path.join(dir, RESULT_FILE), receipt(a.job, bound, { outputs: [{ path: 'outputs/report.txt', sha256: sha('claimed but different'), bytes: Buffer.byteLength('claimed but different') }] }));
  await f.controller.observe(a.assignment.id);
  assert.equal(jobState(f, a.job.id), 'UNKNOWN', 'a defective receipt never reads as completion');
  await f.controller.advanceLocalChain(a.assignment.id);
  assert.equal(jobState(f, b.job.id), 'INTENT');
  assert.equal(f.calls.length, 1, 'an unverified predecessor output never reaches a dependent');
});

test('a predecessor object that went missing blocks the dependent at preflight, recorded honestly', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id] });
  const { bound } = await launched(f, a.assignment.id, a.job.id);
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const output = { path: 'outputs/report.txt', sha256: sha('stored bytes'), bytes: Buffer.byteLength('stored bytes') };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'report.txt'), 'stored bytes');
  writeFileSync(path.join(dir, RESULT_FILE), receipt(a.job, bound, { outputs: [output] }));
  await f.controller.observe(a.assignment.id);
  assert.equal(jobState(f, a.job.id), 'COMPLETED');
  // The recorded object disappears before the dependent is launched — inheritance must refuse.
  rmSync(snapshotObjectPath(f.root, output.sha256));
  await f.controller.advanceLocalChain(a.assignment.id);
  assert.equal(jobState(f, b.job.id), 'INTENT', 'the dependent did not launch on unreadable input');
  const events = f.store.snapshot({ history: true }).jobEvents?.filter(item => item.jobId === b.job.id) ?? [];
  assert.ok(events.some(item => item.externalId.startsWith('chain-blocked:')), 'the refusal is recorded on the job, not swallowed');
  assert.ok(events.some(item => /automatic chain launch could not run/.test(item.text)));
});

test('every recorded dependency must complete before the dependent launches', async t => {
  const f = await fixture(t);
  const a1 = await prepared(f);
  const a2 = await prepared(f);
  const b = await prepared(f, { dependsOn: [a1.assignment.id, a2.assignment.id] });
  const outputFor = (text: string) => ({ path: 'outputs/out.txt', sha256: sha(text), bytes: Buffer.byteLength(text) });
  const first = await launched(f, a1.assignment.id, a1.job.id);
  mkdirSync(path.join(first.dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(first.dir, 'outputs', 'out.txt'), 'first result');
  writeFileSync(path.join(first.dir, RESULT_FILE), receipt(a1.job, first.bound, { outputs: [outputFor('first result')] }));
  await f.controller.observe(a1.assignment.id);
  await f.controller.advanceLocalChain(a1.assignment.id);
  assert.equal(jobState(f, b.job.id), 'INTENT', 'one of two predecessors is not enough');
  const second = await launched(f, a2.assignment.id, a2.job.id);
  mkdirSync(path.join(second.dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(second.dir, 'outputs', 'out.txt'), 'second result');
  writeFileSync(path.join(second.dir, RESULT_FILE), receipt(a2.job, second.bound, { outputs: [outputFor('second result')] }));
  await f.controller.observe(a2.assignment.id);
  await f.controller.advanceLocalChain(a2.assignment.id);
  assert.equal(jobState(f, b.job.id), 'UNKNOWN', 'the last completed predecessor unlocked the dependent');
  const bBound = f.store.localSessionForJob(b.job.id)!;
  const packet = packetOf(path.join(f.sessionsRoot, bBound.storageRelativePath));
  assert.equal(packet.inherited!.length, 2, 'both predecessors contributed their verified outputs');
  assert.deepEqual(packet.inherited!.map(item => item.sourceJobId).sort(), [a1.job.id, a2.job.id].sort());
});

test('chain advance is idempotent — repeated reconciliation never resubmits a launched dependent', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id] });
  await complete(f, a);
  await f.controller.advanceLocalChain(a.assignment.id);
  await f.controller.advanceLocalChain(a.assignment.id);
  await f.controller.reconcileLocalChain();
  assert.equal(f.calls.length, 2, 'exactly one spawn for the predecessor and one for the dependent');
  assert.equal(jobState(f, b.job.id), 'UNKNOWN');
  const events = f.store.snapshot({ history: true }).jobEvents?.filter(item => item.jobId === b.job.id && item.externalId === `chain-launch:${b.job.id}`) ?? [];
  assert.equal(events.length, 1, 'the launch testimony is recorded once');
});

test('reconcileLocalChain launches a dependent left parked by a completed predecessor', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id] });
  await complete(f, a);
  // The restart path: no advance was called at runtime — the durable records alone drive it.
  await f.controller.reconcileLocalChain();
  assert.equal(jobState(f, b.job.id), 'UNKNOWN');
  assert.equal(f.calls.length, 2);
});

// The sweep is bounded to recorded edges — pipeline hops and declared dependsOn — never to ad-hoc
// prepared work, which stays user-gated even on a live request.
test('reconcile never auto-launches ad-hoc prepared work carrying no dependency edge', async t => {
  const f = await fixture(t);
  const adhoc = await prepared(f);
  assert.equal(adhoc.job.state, 'INTENT');
  await f.controller.reconcileLocalChain();
  assert.equal(jobState(f, adhoc.job.id), 'INTENT', 'prepared ad-hoc work remains user-gated');
  assert.equal(f.calls.length, 0, 'no process was spawned');
  assert.ok(!f.store.localSessionForJob(adhoc.job.id), 'no session binding was written');
});

test('concurrent chain triggers launch once without recording a false blocker', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id] });
  await complete(f, a);
  await Promise.all([
    f.controller.advanceLocalChain(a.assignment.id),
    f.controller.advanceLocalChain(a.assignment.id),
    f.controller.reconcileLocalChain(),
  ]);
  assert.equal(f.calls.length, 2);
  assert.equal(jobState(f, b.job.id), 'UNKNOWN');
  const events = f.store.snapshot({ history: true }).jobEvents?.filter(e => e.jobId === b.job.id) ?? [];
  assert.equal(events.filter(e => e.externalId.startsWith('chain-launch:')).length, 1);
  assert.equal(events.filter(e => e.externalId.startsWith('chain-blocked:')).length, 0);
});

test('a hosted-route dependent is never auto-launched by the local chain', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id], agent: f.hostedAgent, name: 'Hosted dependent' });
  await complete(f, a);
  await f.controller.advanceLocalChain(a.assignment.id);
  assert.equal(jobState(f, b.job.id), 'INTENT', 'hosted work never inherits the automatic local path');
  assert.equal(f.hosted.submitted.length, 0);
});

test('a mailbox dependent gets its packet written automatically with the inherited inputs', async t => {
  const f = await fixture(t, { route: 'LOCAL_MAILBOX' });
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id] });
  const { bound } = await launched(f, a.assignment.id, a.job.id);
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const output = { path: 'outputs/report.txt', sha256: sha('mailbox bytes'), bytes: Buffer.byteLength('mailbox bytes') };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'report.txt'), 'mailbox bytes');
  writeFileSync(path.join(dir, RESULT_FILE), receipt(a.job, bound, { outputs: [output] }));
  await f.controller.observe(a.assignment.id);
  await f.controller.advanceLocalChain(a.assignment.id);
  assert.equal(jobState(f, b.job.id), 'UNKNOWN', 'the packet was delivered; the session itself stays user-launched');
  const bBound = f.store.localSessionForJob(b.job.id)!;
  const packet = packetOf(path.join(f.sessionsRoot, bBound.storageRelativePath));
  assert.equal(packet.inherited![0].path, `${INPUTS_DIR}/inherited/${a.job.id}/report.txt`);
  assert.equal(packet.inherited![0].sourceJobId, a.job.id);
});

test('a spawned child exit and a receipt write each trigger the local event callback, debounced to one', async t => {
  const events: string[] = [];
  const f = await fixture(t, { events });
  const a = await prepared(f);
  await launched(f, a.assignment.id, a.job.id);
  assert.equal(events.length, 0);
  const bound = f.store.localSessionForJob(a.job.id)!;
  // The receipt write and the exit land together — the debounce collapses them into one signal.
  writeFileSync(path.join(f.sessionsRoot, bound.storageRelativePath, RESULT_FILE), receipt(a.job, bound));
  f.calls[0].child.emitExit(0, null);
  await sleep(1200);
  assert.deepEqual(events, [a.job.id], 'exit plus receipt produced exactly one observation trigger');
  // A later receipt alone still signals.
  writeFileSync(path.join(f.sessionsRoot, bound.storageRelativePath, RESULT_FILE), receipt(a.job, bound, { sequence: 2, detail: 'second report' }));
  await sleep(1200);
  assert.deepEqual(events, [a.job.id, a.job.id]);
});

test('a packet with no predecessors declares no inherited manifest', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const { bound } = await launched(f, a.assignment.id, a.job.id);
  const packet = packetOf(path.join(f.sessionsRoot, bound.storageRelativePath));
  assert.equal(packet.inherited, undefined, 'the manifest is absent, not empty — a dependent packet is optically distinct');
});

test('watcher and timers are released once a job reaches a verified terminal state', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const { bound, dir } = await launched(f, a.assignment.id, a.job.id);
  const registry = (f.exec as unknown as { registry: Map<string, { watcher: unknown }> }).registry;
  assert.equal(registry.has(a.job.id), true, 'a live spawn keeps its triggers');
  assert.ok(registry.get(a.job.id)?.watcher, 'the packet directory is watched while the job is open');
  const output = { path: 'outputs/report.txt', sha256: sha('done'), bytes: Buffer.byteLength('done') };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'report.txt'), 'done');
  writeFileSync(path.join(dir, RESULT_FILE), receipt(a.job, bound, { outputs: [output] }));
  await f.controller.observe(a.assignment.id);
  assert.equal(jobState(f, a.job.id), 'COMPLETED');
  assert.equal(registry.has(a.job.id), false, 'a verified completion releases the spawn record, watcher and timers');
});

test('visible stdout triggers an office update before any receipt or child exit', async t => {
  const events: string[] = [];
  const f = await fixture(t, { events });
  const a = await prepared(f);
  await launched(f, a.assignment.id, a.job.id);
  f.calls[0].child.stdout.write('Reviewing the director handoff.\n' + Array.from({ length: 204 }, (_, i) => `Visible step ${i}\n`).join(''));
  await sleep(1200);
  assert.deepEqual(events, [a.job.id]);
  await f.controller.observe(a.assignment.id);
  assert.equal(jobState(f, a.job.id), 'UNKNOWN', 'visible speech cannot establish completion');
  assert.ok(f.store.snapshot({ history: true }).jobEvents?.some(e => e.jobId === a.job.id && e.text === 'Reviewing the director handoff.'));
  assert.equal(f.store.snapshot({ history: true }).jobEvents?.filter(e => e.jobId === a.job.id && e.externalId.startsWith('spawn:')).length, 205, 'the whole bounded burst reaches the record even if output stops');
});

test('a verified COMPLETED receipt with no output lands as a visible FAILED, not a lost receipt', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const { bound, dir } = await launched(f, a.assignment.id, a.job.id);
  // A decision hop that carried its answer only in detail: the store refuses completion without
  // attributable output, and the receipt is already bound as lastReceipt by then.
  writeFileSync(path.join(dir, RESULT_FILE), receipt(a.job, bound, { detail: 'plan carried in detail only' }));
  await f.controller.observe(a.assignment.id);
  const job = f.store.snapshot({ history: false }).jobs!.find(item => item.id === a.job.id)!;
  assert.equal(job.state, 'FAILED', 'the refused completion is terminal and visible');
  assert.match(job.detail, /refused completion: Completion needs attributable output/);
  assert.match(job.detail, /plan carried in detail only/, 'the session detail is kept for the user');
  await f.controller.observe(a.assignment.id);
  assert.equal(jobState(f, a.job.id), 'FAILED', 're-observation leaves the recorded outcome in place');
});

test('a receipt detail longer than the job record holds is kept as a bounded prefix', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const { bound, dir } = await launched(f, a.assignment.id, a.job.id);
  const text = 'report';
  const output = { path: 'outputs/report.txt', sha256: sha(text), bytes: Buffer.byteLength(text) };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'report.txt'), text);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(a.job, bound, { detail: 'd'.repeat(3500), outputs: [output] }));
  await f.controller.observe(a.assignment.id);
  const job = f.store.snapshot({ history: false }).jobs!.find(item => item.id === a.job.id)!;
  assert.equal(job.state, 'COMPLETED', 'a 3500-character detail (within the receipt contract) still completes');
  assert.ok(job.detail.length <= 2000 && job.detail.endsWith('…'));
});
