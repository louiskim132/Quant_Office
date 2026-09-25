import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync as removeTreeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { OfficeStore } from '../src/core/store';
import { AssignmentController } from '../src/main/controller';
import { LocalCliExecAdapter, type CliSpawn } from '../src/main/local-cli-exec';
import { LocalSessionRouter } from '../src/main/local-session-router';
import { OutputService } from '../src/main/outputs';
import { prepareInputSnapshot } from '../src/main/locations';
import { analysisPlanInheritance, mintPipelineBrief, mintPipelineRound, pipelineConfirmGate, settlePipelineDecision, revisionInheritance, type PipelineMintContext } from '../src/main/pipeline-runner';
import { PACKET_FILE, RESULT_FILE } from '../src/main/local-packet';
import { latestJobFor } from '../src/core/jobs';
import type { Agent, Assignment, ProviderJob, Request } from '../src/shared/types';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const key = () => randomUUID();
const at = (m: number) => new Date(Date.UTC(2026, 8, 19, 10, 0, 0) + m * 60000).toISOString();
const clock = () => at(5);

const LOCAL_DISPATCH_OPS = [
  'LOCAL_SUBMIT', 'LOCAL_OBSERVE', 'LOCAL_OUTPUT_FETCH', 'LOCAL_CANCEL',
  'MODEL_APPLICATION', 'EFFORT_APPLICATION', 'DELEGATION_CONTROL', 'TOOL_CONFINEMENT',
] as const;
const localObservation = (route: 'LOCAL_CLI_EXEC', minutes: number) => ({
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

class FakeChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly listeners = { exit: [] as ((code: number | null, signal: NodeJS.Signals | null) => void)[], error: [] as ((error: Error) => void)[] };
  constructor(readonly pid: number | undefined = 4321) {}
  kill() { return true; }
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit' | 'error', listener: unknown) {
    if (event === 'exit') this.listeners.exit.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    else this.listeners.error.push(listener as (error: Error) => void);
    return this;
  }
  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null) { for (const listener of this.listeners.exit) listener(code, signal); }
}

/** Answers the MCP initialize handshake so declared serena tool surfaces pass the office probe. */
class FakeSerenaChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly kills: unknown[] = [];
  constructor(readonly pid = 7777) {
    this.stdin.on('data', () => {
      this.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"serena","version":"1.7.0"}}}\n');
    });
  }
  kill(signal?: unknown) { this.kills.push(signal); return true; }
  on(event: string, listener: (...args: never[]) => void) { return this; }
}

interface Fixture {
  root: string; store: OfficeStore; project: { id: string };
  agents: Record<string, Agent>;
  ctx: PipelineMintContext; controller: AssignmentController; sessionsRoot: string;
}

async function fixture(t: any): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-pipeline-decision-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  const execAdapter: { current?: LocalCliExecAdapter } = {};
  t.after(() => { execAdapter.current?.disposeAll(); try { store.close(); } catch {} removeTreeSync(root, { recursive: true, force: true }); });
  const sessionsRoot = path.join(root, 'local-sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  const project = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  const agents: Record<string, Agent> = {};
  for (const role of ['DIRECTOR', 'PM_A', 'PM_B', 'PM_C', 'PM_D', 'WORKER'] as const) {
    const agent: Agent = { id: randomUUID(), name: `${role} agent`, provider: 'claude', model: 'opus', team: 'Research', role, instructions: '', effort: 'default',
      account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'LOCAL', localRoute: 'LOCAL_CLI_EXEC' };
    store.confirmAgentBinding({ observation: localObservation('LOCAL_CLI_EXEC', 0), agent });
    agents[role] = agent;
  }
  const spawn: CliSpawn = () => new FakeChild() as never;
  const exec = new LocalCliExecAdapter(() => sessionsRoot, provider => `${provider}.exe`, clock, undefined, spawn,
    () => ({ TEST_ENV: 'scrubbed' }), undefined, undefined, agentId => store.snapshot().agents.find(a => a.id === agentId)?.provider,
    undefined, () => new FakeSerenaChild() as never, 60);
  execAdapter.current = exec;
  const local = new LocalSessionRouter(id => store.localSessionForJob(id), { FLAT_PACKET: exec, PROJECT_WORKTREE: exec }, 'LOCAL_CLI_EXEC');
  const outputs = new OutputService(store, root);
  const controller = new AssignmentController(store, local, clock, () => Promise.resolve([]), undefined, undefined, undefined,
    outputs.storeBytes, undefined,
    ref => ref.route ? (ref.route === 'LOCAL_CLI_EXEC' ? local : undefined)
      : ref.agent?.execution === 'LOCAL' ? local : undefined,
    undefined, outputs.readBytes);
  const ctx: PipelineMintContext = {
    store,
    snapshotFor: req => prepareInputSnapshot({ store, objectRoot: root, stagingRoot: path.join(root, 'staging'), projectId: req.projectId, requestId: req.id, requestRevision: req.revision, objective: req.objective }),
    prepare: input => controller.prepare(input),
  };
  return { root, store, project, agents, ctx, controller, sessionsRoot };
}

const requestOf = (f: Fixture, requestId: string): Request => f.store.snapshot({ history: false }).requests!.find(item => item.id === requestId)!;
const jobFor = (f: Fixture, assignmentId: string): ProviderJob => f.store.snapshot({ history: false }).jobs!.find(item => item.assignmentId === assignmentId)!;

/** Completes one hop's job through the real launch + receipt path. */
async function completeHop(f: Fixture, assignmentId: string, outputName: string): Promise<string> {
  await f.controller.handoff(assignmentId);
  const job = jobFor(f, assignmentId);
  const bound = f.store.localSessionForJob(job.id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const output = { path: `outputs/${outputName}`, sha256: sha(`${outputName} bytes`), bytes: Buffer.byteLength(`${outputName} bytes`) };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, `outputs/${outputName}`), `${outputName} bytes`);
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ schema: 'office-local-result@2', jobId: job.id, assignmentId, attemptId: bound.attemptId, packetHash: bound.packetHash, sequence: 1, state: 'COMPLETED', detail: 'Done.', outputs: [output] }));
  await f.controller.observe(assignmentId);
  assert.equal(jobFor(f, assignmentId).state, 'COMPLETED', jobFor(f, assignmentId).detail);
  return f.store.localSessionForJob(job.id)!.lastReceipt!.hash;
}

const byName = (f: Fixture, name: string): Request => f.store.snapshot({ history: false }).requests!.find(item => item.name === name)!;

/** Completes every pipelined hop on the request in dependency order (Kahn on the DAG edges).
 *  Dependency ids resolve globally — a revision brief's cross-request edges are satisfied by
 *  the source round's recorded completions, not by anything in this request's own mint. */
async function completeRound(f: Fixture, requestId: string): Promise<void> {
  for (;;) {
    const snapshot = f.store.snapshot({ history: false });
    const hops = snapshot.assignments!.filter(item => item.requestId === requestId && item.pipelineKey);
    const done = new Set(hops.filter(item => jobFor(f, item.id).state === 'COMPLETED').map(item => item.id));
    const next = hops.find(item => !done.has(item.id) && (item.dependsOn ?? []).every(dep => latestJobFor(snapshot.jobs, dep)?.state === 'COMPLETED'));
    if (!next) return;
    await completeHop(f, next.id, `${next.pipelineKey}.txt`);
  }
}

/** Drives a planning request to LAUNCHED with every spec hop minted. */
async function launchedRound(f: Fixture, name = 'Plan it'): Promise<{ request: Request; specHash: string }> {
  f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name, hypothesis: 'Plan the thing.', workType: 'PLANNING', mode: 'SINGLE', leadAgentId: f.agents.DIRECTOR.id, participantIds: [] });
  let request = byName(f, name);
  request = f.store.execute({ type: 'request.start', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }).requests!.find(item => item.id === request.id)!;
  await mintPipelineBrief(f.ctx, request);
  request = requestOf(f, request.id);
  await completeHop(f, request.pipeline!.briefAssignmentId!, 'brief.txt');
  request = requestOf(f, request.id);
  request = f.store.execute({ type: 'request.pipeline.confirm', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }).requests!.find(item => item.id === request.id)!;
  await mintPipelineRound(f.ctx, request);
  request = requestOf(f, request.id);
  return { request, specHash: request.pipeline!.specHash! };
}

test('markPipelineAwaitingDecision binds the decision to the terminal hop’s verified receipt', async t => {
  const f = await fixture(t);
  const { request, specHash } = await launchedRound(f);
  const gate = f.store.snapshot({ history: false }).assignments!.find(item => item.requestId === request.id && item.pipelineKey === 'verify')!;
  // A still-INTENT terminal hop cannot open the decision wait.
  assert.throws(() => f.store.markPipelineAwaitingDecision({ requestId: request.id, specHash, headAssignmentId: gate.id, headReceiptHash: sha('x') }), /has not verified COMPLETED/);
  await completeRound(f, request.id);
  const receiptHash = f.store.localSessionForJob(jobFor(f, gate.id).id)!.lastReceipt!.hash;
  f.store.markPipelineAwaitingDecision({ requestId: request.id, specHash, headAssignmentId: gate.id, headReceiptHash: receiptHash });
  const after = requestOf(f, request.id);
  assert.equal(after.pipeline?.phase, 'AWAITING_DECISION');
  assert.deepEqual(after.pipeline?.pendingDecision, { specHash, headAssignmentId: gate.id, headReceiptHash: receiptHash });
  // The wait is office bookkeeping — the request revision does not move.
  assert.equal(after.revision, request.revision);
  // An identical settle is a no-op; a different terminal identity is refused.
  f.store.markPipelineAwaitingDecision({ requestId: request.id, specHash, headAssignmentId: gate.id, headReceiptHash: receiptHash });
  assert.throws(() => f.store.markPipelineAwaitingDecision({ requestId: request.id, specHash, headAssignmentId: gate.id, headReceiptHash: sha('other') }), /launches|LAUNCHED/);
});

test('decide refuses stale hashes, records APPROVE bound to the viewed report, and replays idempotently', async t => {
  const f = await fixture(t);
  const { request, specHash } = await launchedRound(f);
  const gate = f.store.snapshot({ history: false }).assignments!.find(item => item.requestId === request.id && item.pipelineKey === 'verify')!;
  await completeRound(f, request.id);
  const receiptHash = f.store.localSessionForJob(jobFor(f, gate.id).id)!.lastReceipt!.hash;
  f.store.markPipelineAwaitingDecision({ requestId: request.id, specHash, headAssignmentId: gate.id, headReceiptHash: receiptHash });
  let current = requestOf(f, request.id);
  // The stale gate: a decision naming different bytes approves nothing.
  assert.throws(() => f.store.execute({ type: 'request.pipeline.decide', idempotencyKey: key(), requestId: request.id, expectedRevision: current.revision, decision: 'APPROVE', expectedSpecHash: specHash, expectedReceiptHash: sha('stale') }), /stale/);
  current = requestOf(f, request.id);
  f.store.execute({ type: 'request.pipeline.decide', idempotencyKey: key(), requestId: request.id, expectedRevision: current.revision, decision: 'APPROVE', expectedSpecHash: specHash, expectedReceiptHash: receiptHash });
  current = requestOf(f, request.id);
  assert.equal(current.pipeline?.phase, 'DECIDED');
  assert.equal(current.pipeline?.decision?.decision, 'APPROVE');
  assert.equal(current.pipeline?.decision?.headReceiptHash, receiptHash);
  // Idempotent replay of the recorded decision writes nothing new.
  f.store.execute({ type: 'request.pipeline.decide', idempotencyKey: key(), requestId: request.id, expectedRevision: current.revision, decision: 'APPROVE', expectedSpecHash: specHash, expectedReceiptHash: receiptHash });
  assert.equal(requestOf(f, request.id).pipeline?.phase, 'DECIDED');
  // A different decision after DECIDED is a refusal — the record is append-only.
  assert.throws(() => f.store.execute({ type: 'request.pipeline.decide', idempotencyKey: key(), requestId: request.id, expectedRevision: current.revision, decision: 'REJECT', expectedSpecHash: specHash, expectedReceiptHash: receiptHash }), /already recorded/);
});

test('completing the terminal hop through the chain-observe path seals the round automatically', async t => {
  const f = await fixture(t);
  const { request } = await launchedRound(f);
  const gate = f.store.snapshot({ history: false }).assignments!.find(item => item.requestId === request.id && item.pipelineKey === 'verify')!;
  await completeRound(f, request.id);
  // The observe alone records the receipt; the chain advance is what seals the round.
  const receiptHash = f.store.localSessionForJob(jobFor(f, gate.id).id)!.lastReceipt!.hash;
  assert.equal(requestOf(f, request.id).pipeline?.phase, 'LAUNCHED');
  await f.controller.advanceLocalChain(gate.id);
  const after = requestOf(f, request.id);
  assert.equal(after.pipeline?.phase, 'AWAITING_DECISION');
  assert.equal(after.pipeline?.pendingDecision?.headAssignmentId, gate.id);
  assert.equal(after.pipeline?.pendingDecision?.headReceiptHash, receiptHash);
});

test('decide and the decision wait refuse outside their honest phases', async t => {
  const f = await fixture(t);
  const nonPipeline = f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name: 'Plain', hypothesis: 'Do a thing.', workType: 'OTHER', mode: 'SINGLE', leadAgentId: f.agents.DIRECTOR.id, participantIds: [] }).requests![0];
  assert.throws(() => f.store.execute({ type: 'request.pipeline.decide', idempotencyKey: key(), requestId: nonPipeline.id, expectedRevision: nonPipeline.revision, decision: 'APPROVE', expectedSpecHash: sha('x'), expectedReceiptHash: sha('y') }), /pipeline/);
  const { request, specHash } = await launchedRound(f);
  // LAUNCHED but never settled — no pending decision exists to approve against.
  assert.throws(() => f.store.execute({ type: 'request.pipeline.decide', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision, decision: 'APPROVE', expectedSpecHash: specHash, expectedReceiptHash: sha('y') }), /not awaiting a decision/);
  // BRIEFING cannot mark awaiting, and the settle refuses a foreign-request assignment.
  f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name: 'P2', hypothesis: 'Plan two.', workType: 'PLANNING', mode: 'SINGLE', leadAgentId: f.agents.DIRECTOR.id, participantIds: [] });
  const briefing = byName(f, 'P2');
  const foreign = f.store.snapshot({ history: false }).assignments!.find(item => item.requestId === request.id && item.pipelineKey === 'verify')!;
  assert.throws(() => f.store.markPipelineAwaitingDecision({ requestId: briefing.id, specHash, headAssignmentId: foreign.id, headReceiptHash: sha('z') }), /after the round launches/);
});

/** Records a pipeline decision bound to the pendingDecision the settle already opened. */
function decide(f: Fixture, requestId: string, decision: 'APPROVE' | 'REVISE' | 'REJECT', note?: string): void {
  const current = requestOf(f, requestId);
  const pending = current.pipeline!.pendingDecision!;
  f.store.execute({
    type: 'request.pipeline.decide', idempotencyKey: key(), requestId, expectedRevision: current.revision,
    decision, ...(note !== undefined ? { note } : {}), expectedSpecHash: pending.specHash, expectedReceiptHash: pending.headReceiptHash,
  });
}

/** Drives a minted revision request through start + brief mint — the office's own next step. */
async function startRevision(f: Fixture, revision: Request): Promise<Request> {
  const started = f.store.execute({ type: 'request.start', idempotencyKey: key(), requestId: revision.id, expectedRevision: revision.revision })
    .requests!.find(item => item.id === revision.id)!;
  const minted = await mintPipelineBrief(f.ctx, started);
  assert.equal(minted.minted, true);
  return requestOf(f, revision.id);
}

test('a REVISE decision mints exactly one revision whose brief inherits the settled round tail', async t => {
  const f = await fixture(t);
  const { request } = await launchedRound(f);
  await completeRound(f, request.id);
  const hops = f.store.snapshot({ history: false }).assignments!.filter(item => item.requestId === request.id && item.pipelineKey);
  const terminal = hops.find(item => item.pipelineKey === 'verify')!;
  const synthesis = hops.find(item => item.pipelineKey === 'plan-synthesis')!;
  const terminalJob = jobFor(f, terminal.id);
  const synthesisJob = jobFor(f, synthesis.id);
  assert.equal(settlePipelineDecision(f.ctx, requestOf(f, request.id)).settled, true);
  decide(f, request.id, 'REVISE', 'Tighten the scope around what verify proved.');
  const revisions = f.store.snapshot({ history: false }).requests!.filter(item => item.revisionOf?.requestId === request.id);
  assert.equal(revisions.length, 1, 'REVISE mints exactly one linked revision request');
  const revision = revisions[0];
  assert.equal(revision.revisionOf?.round, 1);
  assert.equal(revision.name, 'Plan it — revision 1');
  const fresh = await startRevision(f, revision);
  const brief = f.store.snapshot({ history: false }).assignments!.find(item => item.id === fresh.pipeline!.briefAssignmentId)!;
  assert.equal(brief.requestId, revision.id);
  assert.deepEqual([...(brief.dependsOn ?? [])].sort(), [terminal.id, synthesis.id].sort(),
    'the revision brief chains off the source round\'s settled terminal and synthesis hops');
  assert.match(brief.frozen!.objective, /Prior-round inputs: 'verify', 'plan-synthesis' settled\./);
  assert.match(brief.frozen!.objective, /## Revision note from the office\nTighten the scope around what verify proved\./,
    'the recorded decision note rides the brief verbatim');
  // The packet declares the inherited manifest — the source hops' verified outputs arrive
  // under inputs/inherited/<source job>/, named by the producing job and re-verified bytes.
  await f.controller.handoff(brief.id);
  const bound = f.store.localSessionForJob(jobFor(f, brief.id).id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const packet = JSON.parse(readFileSync(path.join(dir, PACKET_FILE), 'utf8'));
  const inherited: { path: string; sha256: string; sourceJobId: string; objectHash: string; sourceKey?: string }[] = packet.inherited;
  assert.deepEqual(inherited.map(item => item.sourceKey).filter((key, index, all) => all.indexOf(key) === index).sort(), ['prior-plan-synthesis', 'prior-verify'],
    'a prior round\'s hops are staged under prior-<hop-key>');
  assert.deepEqual(inherited.map(item => item.sourceJobId).sort(), [terminalJob.id, synthesisJob.id].sort());
  const outputs = [...terminalJob.outputs, ...synthesisJob.outputs];
  for (const item of inherited) {
    const source = outputs.find(output => output.sha256 === item.objectHash)!;
    assert.ok(source, 'every inherited entry names a verified source output by hash');
    assert.equal(item.sha256, source.sha256);
    assert.ok(item.path.startsWith(`inputs/inherited/${item.sourceKey}/`));
    assert.equal(readFileSync(path.join(dir, item.path), 'utf8'), `${path.basename(source.path)} bytes`,
      'the staged inherited bytes are the verified predecessor bytes');
  }
});

test('a revision of a revision increments round and names the immediate source round\'s hops', async t => {
  const f = await fixture(t);
  const { request } = await launchedRound(f);
  await completeRound(f, request.id);
  assert.equal(settlePipelineDecision(f.ctx, requestOf(f, request.id)).settled, true);
  decide(f, request.id, 'REVISE', 'First revision.');
  const first = f.store.snapshot({ history: false }).requests!.find(item => item.revisionOf?.requestId === request.id)!;
  // Drive the first revision's own round all the way through — its brief already chained off
  // the round-0 tail, so its own hops are ordinary same-request edges from here.
  const firstStarted = await startRevision(f, first);
  await completeHop(f, firstStarted.pipeline!.briefAssignmentId!, 'rev1-brief.txt');
  let current = requestOf(f, first.id);
  current = f.store.execute({ type: 'request.pipeline.confirm', idempotencyKey: key(), requestId: first.id, expectedRevision: current.revision })
    .requests!.find(item => item.id === first.id)!;
  await mintPipelineRound(f.ctx, current);
  await completeRound(f, first.id);
  assert.equal(settlePipelineDecision(f.ctx, requestOf(f, first.id)).settled, true);
  decide(f, first.id, 'REVISE', 'Second revision.');
  const second = f.store.snapshot({ history: false }).requests!.find(item => item.revisionOf?.requestId === first.id)!;
  assert.equal(second.revisionOf?.round, 2);
  assert.equal(second.name, 'Plan it — revision 2');
  const firstHops = f.store.snapshot({ history: false }).assignments!.filter(item => item.requestId === first.id && item.pipelineKey);
  const secondStarted = await startRevision(f, second);
  const brief = f.store.snapshot({ history: false }).assignments!.find(item => item.id === secondStarted.pipeline!.briefAssignmentId)!;
  assert.deepEqual([...(brief.dependsOn ?? [])].sort(),
    [firstHops.find(item => item.pipelineKey === 'verify')!.id, firstHops.find(item => item.pipelineKey === 'plan-synthesis')!.id].sort(),
    'the second revision chains off the immediate source round, not round 0');
  assert.match(brief.frozen!.objective, /## Revision note from the office\nSecond revision\./);
});

test('revisionInheritance names only settled, receipt-verified source hops — every drop carries its reason', () => {
  const hop = (id: string, requestId: string, pipelineKey: string) => ({ id, requestId, pipelineKey }) as Assignment;
  const job = (id: string, assignmentId: string, state: ProviderJob['state'], attempt = 1) =>
    ({ id, assignmentId, state, attempt, createdAt: at(attempt) }) as ProviderJob;
  const source = { id: 'src', pipeline: { kind: 'PLANNING' } } as unknown as Request;
  const revision = { id: 'rev', revisionOf: { requestId: 'src', decisionAt: at(9), round: 1 } } as Request;

  // Terminal settled+verified, synthesis failed — only the settled edge survives.
  let state = {
    requests: [source],
    assignments: [hop('a-verify', 'src', 'verify'), hop('a-synth', 'src', 'plan-synthesis')],
    jobs: [job('j-verify', 'a-verify', 'COMPLETED'), job('j-synth', 'a-synth', 'FAILED')],
  } as unknown as Parameters<typeof revisionInheritance>[0];
  let inherited = revisionInheritance(state, revision, () => true);
  assert.deepEqual(inherited.dependsOn, ['a-verify']);
  assert.deepEqual(inherited.settled, ['verify']);
  assert.equal(inherited.dropped.length, 1);
  assert.match(inherited.dropped[0], /'plan-synthesis' hop is not settled COMPLETED/);

  // COMPLETED without a verified receipt on record does not qualify either.
  state = {
    requests: [source],
    assignments: [hop('a-verify', 'src', 'verify'), hop('a-synth', 'src', 'plan-synthesis')],
    jobs: [job('j-verify', 'a-verify', 'COMPLETED'), job('j-synth', 'a-synth', 'COMPLETED')],
  } as unknown as Parameters<typeof revisionInheritance>[0];
  inherited = revisionInheritance(state, revision, jobId => jobId === 'j-verify');
  assert.deepEqual(inherited.dependsOn, ['a-verify']);
  assert.match(inherited.dropped[0], /'plan-synthesis' hop has no verified receipt/);

  // No source request at all — nothing qualifies, and the reason says so plainly.
  state = { requests: [], assignments: [], jobs: [] } as unknown as Parameters<typeof revisionInheritance>[0];
  inherited = revisionInheritance(state, revision, () => true);
  assert.deepEqual(inherited.dependsOn, []);
  assert.equal(inherited.settled.length, 0);
  assert.match(inherited.dropped[0], /not recorded/);

  // RESULT_ANALYSIS sources settle on their own terminal/finalize keys.
  const analysis = { id: 'src', pipeline: { kind: 'RESULT_ANALYSIS' } } as unknown as Request;
  state = {
    requests: [analysis],
    assignments: [hop('a-report', 'src', 'analysis-report'), hop('a-finalize', 'src', 'analysis-finalize')],
    jobs: [job('j-report', 'a-report', 'COMPLETED'), job('j-finalize', 'a-finalize', 'COMPLETED')],
  } as unknown as Parameters<typeof revisionInheritance>[0];
  inherited = revisionInheritance(state, revision, () => true);
  assert.deepEqual(inherited.dependsOn, ['a-report', 'a-finalize']);
});

test('APPROVE and REJECT decisions mint no revision request', async t => {
  const f = await fixture(t);
  for (const [name, decision] of [['Approve it', 'APPROVE'], ['Reject it', 'REJECT']] as const) {
    const { request } = await launchedRound(f, name);
    await completeRound(f, request.id);
    assert.equal(settlePipelineDecision(f.ctx, requestOf(f, request.id)).settled, true);
    decide(f, request.id, decision);
  }
  assert.equal(f.store.snapshot({ history: false }).requests!.filter(item => item.revisionOf).length, 0,
    'only REVISE mints a linked revision');
});

test('analysisPlanInheritance chains an analysis brief to the planning round that pre-registered its plan', () => {
  const hop = (id: string, requestId: string, pipelineKey: string) => ({ id, requestId, pipelineKey }) as Assignment;
  const job = (id: string, assignmentId: string, state: ProviderJob['state']) => ({ id, assignmentId, state, attempt: 1, createdAt: at(1) }) as ProviderJob;
  const plan = { id: 'plan', name: 'Write ema5 code', pipeline: { kind: 'PLANNING' } } as unknown as Request;
  const analysis = { id: 'ana', analysisOf: { requestId: 'plan' }, pipeline: { kind: 'RESULT_ANALYSIS' } } as unknown as Request;
  type State = Parameters<typeof analysisPlanInheritance>[0];

  let state = { requests: [plan], assignments: [hop('a-synth', 'plan', 'plan-synthesis')], jobs: [job('j-synth', 'a-synth', 'COMPLETED')] } as unknown as State;
  let inherited = analysisPlanInheritance(state, analysis, () => true);
  assert.deepEqual(inherited.dependsOn, ['a-synth']);
  assert.equal(inherited.line, "Pre-registered analysis plan: inputs/inherited/prior-plan-synthesis/analysis-plan.md, fixed when 'Write ema5 code' was planned.");

  inherited = analysisPlanInheritance(state, analysis, () => false);
  assert.deepEqual(inherited.dependsOn, [], 'no verified receipt, no edge');
  assert.match(inherited.line, /has no verified COMPLETED receipt/);

  state = { requests: [plan], assignments: [hop('a-synth', 'plan', 'plan-synthesis')], jobs: [job('j-synth', 'a-synth', 'FAILED')] } as unknown as State;
  assert.deepEqual(analysisPlanInheritance(state, analysis, () => true).dependsOn, []);

  state = { requests: [], assignments: [], jobs: [] } as unknown as State;
  assert.match(analysisPlanInheritance(state, analysis, () => true).line, /not recorded in this workspace/);
});

test('a QUICK round records its shape and spec hash at confirm; an implementation-only revision reuses the plan and prior deliverables', async t => {
  const f = await fixture(t);
  f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name: 'Quick one', hypothesis: 'Plan the thing.', workType: 'PLANNING', mode: 'SINGLE', leadAgentId: f.agents.DIRECTOR.id, participantIds: [] });
  let request = byName(f, 'Quick one');
  request = f.store.execute({ type: 'request.start', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }).requests!.find(item => item.id === request.id)!;
  await mintPipelineBrief(f.ctx, request);
  request = requestOf(f, request.id);
  await completeHop(f, request.pipeline!.briefAssignmentId!, 'brief.txt');
  request = requestOf(f, request.id);
  const gate = pipelineConfirmGate(f.store, request.id, 'QUICK');
  assert.ok(gate.ok);
  if (!gate.ok) return;
  assert.notEqual(gate.specHash, request.pipeline!.specHash, 'the quick spec is a different spec than the full one the brief was bound under');
  request = f.store.execute({ type: 'request.pipeline.confirm', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision, shape: 'QUICK', specHash: gate.specHash }).requests!.find(item => item.id === request.id)!;
  assert.equal(request.pipeline!.shape, 'QUICK');
  assert.equal(request.pipeline!.specHash, gate.specHash);
  await mintPipelineRound(f.ctx, request);
  const hops = () => f.store.snapshot({ history: false }).assignments!.filter(item => item.requestId === request.id && item.pipelineKey);
  assert.deepEqual(hops().map(item => item.pipelineKey).sort(), ['implement-1', 'plan-brief', 'plan-draft-a', 'verify']);
  await completeRound(f, request.id);
  assert.equal(settlePipelineDecision(f.ctx, requestOf(f, request.id)).settled, true, 'a quick round settles on its verify hop against the recorded spec hash');

  const current = requestOf(f, request.id);
  const pending = current.pipeline!.pendingDecision!;
  assert.throws(() => f.store.execute({ type: 'request.pipeline.decide', idempotencyKey: key(), requestId: request.id, expectedRevision: current.revision, decision: 'APPROVE', restartAt: 'IMPLEMENTATION', expectedSpecHash: pending.specHash, expectedReceiptHash: pending.headReceiptHash }), /Only a planning revision can restart/);
  f.store.execute({ type: 'request.pipeline.decide', idempotencyKey: key(), requestId: request.id, expectedRevision: current.revision, decision: 'REVISE', note: 'Rename the output column.', restartAt: 'IMPLEMENTATION', expectedSpecHash: pending.specHash, expectedReceiptHash: pending.headReceiptHash });
  const revision = f.store.snapshot({ history: false }).requests!.find(item => item.revisionOf?.requestId === request.id)!;
  assert.equal(revision.revisionOf!.restartAt, 'IMPLEMENTATION');
  const fresh = await startRevision(f, revision);
  const brief = f.store.snapshot({ history: false }).assignments!.find(item => item.id === fresh.pipeline!.briefAssignmentId)!;
  const sourceHop = (k: string) => hops().find(item => item.pipelineKey === k)!.id;
  assert.deepEqual([...(brief.dependsOn ?? [])].sort(), [sourceHop('verify'), sourceHop('plan-draft-a')].sort(), 'a quick source round settles its plan on the single draft');
  assert.match(brief.frozen!.objective, /keeps the approved plan and restarts at implementation/);
  await completeHop(f, brief.id, 'plan.md');
  let revised = requestOf(f, revision.id);
  const revisedGate = pipelineConfirmGate(f.store, revised.id);
  assert.ok(revisedGate.ok);
  revised = f.store.execute({ type: 'request.pipeline.confirm', idempotencyKey: key(), requestId: revised.id, expectedRevision: revised.revision, ...(revisedGate.ok ? { specHash: revisedGate.specHash } : {}) }).requests!.find(item => item.id === revised.id)!;
  await mintPipelineRound(f.ctx, revised);
  const revisedHops = f.store.snapshot({ history: false }).assignments!.filter(item => item.requestId === revised.id && item.pipelineKey);
  assert.deepEqual(revisedHops.map(item => item.pipelineKey).sort(), ['implement-1', 'plan-brief', 'verify']);
  const implement = revisedHops.find(item => item.pipelineKey === 'implement-1')!;
  assert.deepEqual([...(implement.dependsOn ?? [])].sort(), [brief.id, sourceHop('implement-1')].sort(), 'the worker inherits the amended plan and the previous deliverables');
});
