import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { OfficeStore } from '../src/core/store';
import { OutputService } from '../src/main/outputs';
import { prepareInputSnapshot } from '../src/main/locations';
import { removeTreeSync } from '../src/main/fsx';
import {
  AssignmentController,
  type ObserveResult,
  type ProviderAdapter,
  type SubmitContext,
  type SubmitResult,
} from '../src/main/controller';
import { LocalCliExecAdapter, type CliSpawn, type CliSpawnOptions } from '../src/main/local-cli-exec';
import { LocalSessionRouter } from '../src/main/local-session-router';
import { PACKET_FILE, RESULT_FILE } from '../src/main/local-packet';
import { localPacketV2Schema } from '../src/shared/local-session';
import type { Agent, CapabilityOperation, Message, ProviderJob } from '../src/shared/types';
import { researchFixture } from './fixtures/research-workflow';

const key = () => randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 19, 10, 0, 0) + minutes * 60000).toISOString();
const clock = () => at(5);
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** The local dispatch family the launch gate requires — office-observed, never provider attestation. */
const LOCAL_DISPATCH_OPS: CapabilityOperation[] = [
  'LOCAL_SUBMIT',
  'LOCAL_OBSERVE',
  'LOCAL_OUTPUT_FETCH',
  'LOCAL_CANCEL',
  'MODEL_APPLICATION',
  'EFFORT_APPLICATION',
  'DELEGATION_CONTROL',
  'TOOL_CONFINEMENT',
];
const localObservation = (route: 'LOCAL_MAILBOX' | 'LOCAL_CLI_EXEC', minutes: number) => ({
  provider: 'claude' as const,
  identity: 'researcher@example.com',
  credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const,
  allowance: [],
  note: '',
  toolVersion: '2.1.236',
  transport: route,
  environment: 'LOCAL_MACHINE',
  models: [{ id: 'opus', name: 'Opus' }],
  operations: [
    {
      operation: 'ACCOUNT_STATUS' as const,
      level: 'ACCOUNT_VERIFIED' as const,
      detail: 'Signed in.',
      evidence: 'OBSERVED' as const,
      verifiedAt: at(minutes),
      source: 'fixture',
    },
    {
      operation: 'MODEL_CATALOG' as const,
      level: 'ACCOUNT_VERIFIED' as const,
      detail: 'Catalog read.',
      evidence: 'OBSERVED' as const,
      verifiedAt: at(minutes),
      source: 'fixture',
    },
    ...LOCAL_DISPATCH_OPS.map(operation => ({
      operation,
      level: 'TOOL_SUPPORTED' as const,
      detail: 'Exercised by the fixture.',
      evidence: 'OBSERVED' as const,
      verifiedAt: at(minutes),
      source: 'fixture',
      model: 'opus',
      route,
      ...(operation === 'EFFORT_APPLICATION' ? { effort: 'default' as const } : {}),
      ...(operation === 'DELEGATION_CONTROL' ? { delegation: false } : {}),
      ...(operation === 'TOOL_CONFINEMENT'
        ? {
            confinement: {
              tools: 'only the fixture packet tools',
              filesystem: 'the staged snapshot directory',
              network: 'no outbound network',
              environment: 'a user-launched session on this machine',
            },
          }
        : {}),
    })),
  ],
  source: 'transport fixture',
  observedAt: at(minutes),
});
const hostedObservation = (minutes: number) => ({
  provider: 'openai' as const,
  identity: 'hosted@example.com',
  credentialContext: 'openai-cli',
  state: 'SIGNED_IN' as const,
  allowance: [],
  note: '',
  toolVersion: '1.0.0',
  transport: 'OFFICIAL_CLI_TERMINAL' as const,
  environment: 'anthropic-managed',
  models: [{ id: 'gpt-5', name: 'GPT-5' }],
  operations: [
    {
      operation: 'ACCOUNT_STATUS' as const,
      level: 'ACCOUNT_VERIFIED' as const,
      detail: 'Signed in.',
      evidence: 'OBSERVED' as const,
      verifiedAt: at(minutes),
      source: 'fixture',
    },
  ],
  source: 'transport fixture',
  observedAt: at(minutes),
});

/** Records every submit it receives; never actually hosts anything. */
class HostedStub implements ProviderAdapter {
  readonly route = 'FAKE_ADAPTER' as const;
  readonly providers = ['openai' as const];
  async submit(_context: SubmitContext): Promise<SubmitResult> {
    return { externalId: 'hosted-1', externalUrl: '', detail: 'Opened by the hosted stub.' };
  }
  async observe(_job: ProviderJob): Promise<ObserveResult> {
    return { state: 'RUNNING', detail: 'Working.' };
  }
  async cancel(_job: ProviderJob) {
    return { acknowledged: true, detail: 'Hosted cancel acknowledged.' };
  }
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
  kill(signal?: NodeJS.Signals | number) {
    this.kills.push(signal);
    return true;
  }
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit' | 'error', listener: unknown) {
    if (event === 'exit')
      this.listeners.exit.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    else this.listeners.error.push(listener as (error: Error) => void);
    return this;
  }
  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    for (const listener of this.listeners.exit) listener(code, signal);
  }
  emitError(error: Error) {
    for (const listener of this.listeners.error) listener(error);
  }
}
interface SpawnCall {
  executable: string;
  args: string[];
  options: CliSpawnOptions;
  child: FakeChild;
}

async function fixture(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-chain-messages-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  const sessionsRoot = path.join(root, 'local-sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  const source = path.join(root, 'source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'input.csv'), 'a,b\n1,2\n');
  store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: project.id,
    expectedRevision: 0,
    localFolder: source,
    inputPaths: ['input.csv'],
    outputFolder: '',
  });
  const localAgent = (name: string): Agent => ({
    id: randomUUID(),
    name,
    provider: 'claude',
    model: 'opus',
    team: 'Research',
    role: 'WORKER',
    instructions: '',
    effort: 'default',
    account: 'researcher@example.com',
    createdAt: at(0),
    connectionVerifiedAt: at(0),
    execution: 'LOCAL',
    localRoute: 'LOCAL_CLI_EXEC' as const,
  });
  const agent = localAgent('Local worker');
  store.confirmAgentBinding({ observation: localObservation('LOCAL_CLI_EXEC', 0), agent });
  const agent2 = localAgent('Second local worker');
  store.confirmAgentBinding({ observation: localObservation('LOCAL_CLI_EXEC', 0), agent: agent2 });
  const hostedAgent: Agent = {
    id: randomUUID(),
    name: 'Hosted worker',
    provider: 'openai',
    model: 'gpt-5',
    team: 'Research',
    role: 'WORKER',
    instructions: '',
    effort: 'default',
    account: 'hosted@example.com',
    createdAt: at(0),
    connectionVerifiedAt: at(0),
    execution: 'HOSTED_SETUP_REQUIRED',
  };
  store.confirmAgentBinding({ observation: hostedObservation(0), agent: hostedAgent });
  const calls: SpawnCall[] = [];
  const spawn: CliSpawn = (executable, args, spawnOptions) => {
    const child = new FakeChild();
    calls.push({ executable, args, options: spawnOptions, child });
    return child;
  };
  const exec = new LocalCliExecAdapter({
    sessionsRoot: () => sessionsRoot,
    executable: provider => `${provider}.exe`,
    now: clock,
    spawnChild: spawn,
    environment: () => ({ TEST_ENV: 'scrubbed' }),
    providerFor: agentId => store.snapshot().agents.find(a => a.id === agentId)?.provider,
    claudeSpawnGapMs: 0,
  });
  const local = new LocalSessionRouter(
    id => store.localSessionForJob(id),
    { FLAT_PACKET: exec, PROJECT_WORKTREE: exec },
    'LOCAL_CLI_EXEC',
  );
  const hosted = new HostedStub();
  const outputs = new OutputService(store, root);
  const controller = new AssignmentController(
    store,
    local,
    clock,
    () => Promise.resolve([]),
    undefined,
    undefined,
    undefined,
    outputs.storeBytes,
    undefined,
    ref =>
      ref.route
        ? ref.route === 'LOCAL_CLI_EXEC'
          ? local
          : ref.route === hosted.route
            ? hosted
            : undefined
        : ref.agent?.execution === 'LOCAL'
          ? local
          : hosted,
    undefined,
    outputs.readBytes,
  );
  t.after(() => {
    exec.disposeAll();
    try {
      store.close();
    } catch {}
    removeTreeSync(root);
  });
  return {
    root,
    store,
    project,
    agent,
    agent2,
    hostedAgent,
    sessionsRoot,
    calls,
    exec,
    local,
    hosted,
    controller,
    outputs,
  };
}

async function prepared(
  f: Awaited<ReturnType<typeof fixture>>,
  opts: { dependsOn?: string[]; agent?: Agent; name?: string } = {},
) {
  const agent = opts.agent ?? f.agent;
  const name = opts.name ?? `Question ${key().slice(0, 8)}`;
  const request = f.store
    .execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: f.project.id,
      name,
      hypothesis: 'h',
      workType: 'QUESTION',
      mode: 'SINGLE',
      leadAgentId: agent.id,
      participantIds: [],
    })
    .requests!.find(item => item.name === name)!;
  const snapshot = await prepareInputSnapshot({
    store: f.store,
    objectRoot: f.root,
    stagingRoot: path.join(f.root, 'staging'),
    projectId: f.project.id,
    requestId: request.id,
    requestRevision: request.revision,
  });
  const { assignment } = f.controller.prepare({
    requestId: request.id,
    agentId: agent.id,
    snapshotId: snapshot.id,
    ...(opts.dependsOn?.length ? { dependsOn: opts.dependsOn } : {}),
  });
  const job = f.store.snapshot({ history: false }).jobs!.find(item => item.assignmentId === assignment.id)!;
  return { assignment, job, request, snapshot };
}

/** Launches a job and returns its bound packet directory. */
async function launched(f: Awaited<ReturnType<typeof fixture>>, assignmentId: string, jobId: string) {
  await f.controller.handoff(assignmentId);
  const bound = f.store.localSessionForJob(jobId)!;
  return { bound, dir: path.join(f.sessionsRoot, bound.storageRelativePath) };
}

/** A well-formed v2 receipt bound to the packet on disk. */
function receipt(
  job: ProviderJob,
  bound: { assignmentId: string; attemptId: string; packetHash: string | null },
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    schema: 'office-local-result@2',
    jobId: job.id,
    assignmentId: bound.assignmentId,
    attemptId: bound.attemptId,
    packetHash: bound.packetHash,
    sequence: 1,
    state: 'COMPLETED',
    detail: 'Done.',
    outputs: [],
    ...overrides,
  });
}

/** Drives a launched job to verified COMPLETED with one declared, fetched and stored output. */
async function complete(
  f: Awaited<ReturnType<typeof fixture>>,
  node: { assignment: { id: string }; job: ProviderJob },
  text = 'predecessor result',
) {
  const { bound, dir } = await launched(f, node.assignment.id, node.job.id);
  const output = { path: 'outputs/report.txt', sha256: sha(text), bytes: Buffer.byteLength(text) };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'report.txt'), text);
  writeFileSync(path.join(dir, RESULT_FILE), receipt(node.job, bound, { outputs: [output] }));
  await f.controller.observe(node.assignment.id);
  assert.equal(f.store.snapshot({ history: false }).jobs!.find(item => item.id === node.job.id)!.state, 'COMPLETED');
  return { bound, dir, output };
}

const jobState = (f: Awaited<ReturnType<typeof fixture>>, jobId: string) =>
  f.store.snapshot({ history: false }).jobs!.find(item => item.id === jobId)!.state;
const messages = (f: Awaited<ReturnType<typeof fixture>>) => f.store.snapshot({ history: false }).messages ?? [];
const packetOf = (dir: string) =>
  localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(dir, PACKET_FILE), 'utf8')));

test('a completed predecessor produces exactly one HANDOFF with a delivery receipt naming the verified inheritance', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id], agent: f.agent2 });
  const { output } = await complete(f, a, 'predecessor findings');
  assert.equal(messages(f).length, 0, 'a manual launch records no chain message');

  await f.controller.advanceLocalChain(a.assignment.id);
  assert.equal(jobState(f, b.job.id), 'UNKNOWN', 'the dependent launched and awaits its session');

  const hops = messages(f).filter(item => item.kind === 'HANDOFF');
  assert.equal(hops.length, 1, 'exactly one handoff message exists for the hop');
  const hop = hops[0];
  assert.equal(hop.assignmentId, b.assignment.id, 'the message belongs to the dependent, not the predecessor');
  assert.equal(hop.requestId, b.request.id);
  assert.equal(hop.projectId, f.project.id);
  assert.equal(hop.fromAgentId, a.assignment.agentId, 'the predecessor agent sends');
  assert.equal(hop.toAgentId, b.assignment.agentId, 'the dependent agent receives');
  assert.equal(hop.scopeSnapshotId, b.snapshot.id, 'the shared context is the dependent’s input snapshot');
  assert.deepEqual(hop.scopeOutputHashes, [output!.sha256], 'the scope names the verified inherited object');
  assert.equal(hop.evidence, 'OFFICE_LOCAL', 'the office recorded its own delivery, not provider testimony');
  assert.notEqual(hop.deliveredAt, '', 'a delivery receipt was recorded');
  assert.match(hop.receipt, new RegExp(output!.sha256), 'the receipt names the re-verified object hash');
  const bBound = f.store.localSessionForJob(b.job.id)!;
  assert.match(hop.receipt, new RegExp(bBound.packetHash!), 'the receipt names the delivered packet hash');
  // A recorded message is speech, not work: the dependent job is still waiting on its session.
  assert.equal(jobState(f, b.job.id), 'UNKNOWN', 'a handoff message cannot complete the job');

  // Idempotent: a repeated settle signal and a reconcile pass record nothing twice.
  await f.controller.advanceLocalChain(a.assignment.id);
  await f.controller.reconcileLocalChain();
  assert.equal(messages(f).filter(item => item.kind === 'HANDOFF').length, 1);
});

test('a dependent with no inherited outputs still receives a HANDOFF citing packet delivery', async t => {
  const f = await fixture(t);
  const a = await prepared(f);
  const b = await prepared(f, { dependsOn: [a.assignment.id], agent: f.agent2 });
  // A completion the office recorded but never took byte custody of: the reported output has no
  // `stored` flag, so nothing is inherited into the dependent packet. The observed path always
  // stores what it verifies, so this state is seeded at the transition the way a custody gap would
  // leave it — the contract under test is what the handoff may still cite.
  await launched(f, a.assignment.id, a.job.id);
  const aJob = f.store.snapshot({ history: false }).jobs!.find(item => item.id === a.job.id)!;
  f.store.recordJobTransition({
    jobId: a.job.id,
    expectedRevision: aJob.revision,
    to: 'COMPLETED',
    evidence: 'PROVIDER_REPORTED',
    detail: 'The provider reported completion.',
    outputs: [{ path: 'outputs/report.txt', sha256: sha('uncustodied'), bytes: 11 }],
    at: at(6),
  });
  assert.equal(jobState(f, a.job.id), 'COMPLETED');
  assert.equal(
    f.store.snapshot({ history: false }).jobs!.find(item => item.id === a.job.id)!.outputs[0].stored,
    undefined,
    'the reported output never entered office custody',
  );

  await f.controller.advanceLocalChain(a.assignment.id);
  assert.equal(jobState(f, b.job.id), 'UNKNOWN');

  const hops = messages(f).filter(item => item.kind === 'HANDOFF');
  assert.equal(hops.length, 1);
  const hop = hops[0];
  const bBound = f.store.localSessionForJob(b.job.id)!;
  assert.ok(bBound.packetHash, 'a ready binding carries the verified packet hash');
  assert.deepEqual(
    hop.scopeOutputHashes,
    [bBound.packetHash],
    'with no inherited objects the packet identity is the cited delivery',
  );
  assert.match(hop.receipt, new RegExp(bBound.packetHash!), 'the receipt names the packet hash the office verified');
  assert.match(
    hop.receipt,
    /no predecessor output was inherited/,
    'the receipt says plainly that nothing was inherited',
  );
  const packet = packetOf(path.join(f.sessionsRoot, bBound.storageRelativePath));
  assert.deepEqual(packet.inherited ?? [], [], 'the packet itself carries no inherited manifest entries');
});

test('no message on a refused hop: failed predecessor, hosted dependent, and same-agent chains', async t => {
  const f = await fixture(t);
  // A hosted dependent never auto-launches, so it can never record a hop.
  const a = await prepared(f);
  const hostedDependent = await prepared(f, { dependsOn: [a.assignment.id], agent: f.hostedAgent });
  const { bound, dir } = await launched(f, a.assignment.id, a.job.id);
  writeFileSync(
    path.join(dir, RESULT_FILE),
    receipt(a.job, bound, { state: 'FAILED', detail: 'the session reported failure' }),
  );
  await f.controller.observe(a.assignment.id);
  assert.equal(jobState(f, a.job.id), 'FAILED');
  await f.controller.advanceLocalChain(a.assignment.id);
  assert.equal(messages(f).length, 0, 'a failed predecessor launches nothing and records nothing');
  assert.equal(jobState(f, hostedDependent.job.id), 'INTENT');

  // A same-agent hop still launches — the message contract just cannot carry a self-addressed
  // record, so the reason lands on the job instead of pretending a cross-agent delivery.
  const c = await prepared(f);
  const d = await prepared(f, { dependsOn: [c.assignment.id], agent: f.agent });
  await complete(f, c);
  await f.controller.advanceLocalChain(c.assignment.id);
  assert.equal(jobState(f, d.job.id), 'UNKNOWN', 'the same-agent dependent still launched');
  assert.equal(messages(f).length, 0, 'no self-addressed message exists');
  const events = f.store.snapshot({ history: true }).jobEvents?.filter(item => item.jobId === d.job.id) ?? [];
  assert.ok(
    events.some(item => item.externalId === `chain-handoff-note:${d.job.id}`),
    'the skipped record is explained on the job',
  );
  assert.ok(events.some(item => /same agent/.test(item.text)));
});

test('the sealed ISOLATION guard still refuses messages before every first report is collected', async t => {
  const f = await researchFixture(t);
  await f.through('S2');
  const branch = f.branch();
  await f.service().run({ type: 'prepare', branchId: branch.id, expectedRevision: branch.revision });
  const round = f.store.snapshot({ history: false }).pipeline!.find(item => item.kind === 'REVIEW_ROUND')!;
  if (round.kind !== 'REVIEW_ROUND' || round.proof.claim.kind !== 'ISOLATION')
    throw new Error('expected an open isolation round');
  const reviewer = round.proof.claim.contexts[0].agentId;
  const message: Message = {
    id: randomUUID(),
    projectId: f.project.id,
    requestId: f.request.id,
    assignmentId: null,
    fromAgentId: reviewer,
    toAgentId: f.principal.id,
    kind: 'QUESTION',
    body: 'An early read attempt.',
    scopeSnapshotId: null,
    scopeOutputHashes: [],
    sentAt: f.now(),
    deliveredAt: '',
    receipt: '',
    evidence: 'OFFICE_LOCAL',
  };
  assert.throws(
    () => f.store.recordMessage(message),
    /remain sealed/,
    'a participant in an open isolation round cannot message',
  );
  // An unrelated agent can still speak — the seal binds only the isolated contexts.
  const outside: Message = { ...message, id: randomUUID(), fromAgentId: f.principal.id, toAgentId: f.third.id };
  assert.equal(f.store.recordMessage(outside).messages!.length, 1);
});
