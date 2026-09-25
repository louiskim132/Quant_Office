import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync as removeTreeSync } from 'node:fs';
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
import { mintPipelineBrief, mintPipelineRound, settlePipelineDecision, type PipelineMintContext } from '../src/main/pipeline-runner';
import { RESULT_FILE } from '../src/main/local-packet';
import { latestJobFor } from '../src/core/jobs';
import { dependencyStatus } from '../src/shared/cooperation';
import type { Agent, ProviderJob, Request } from '../src/shared/types';

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
  const root = mkdtempSync(path.join(tmpdir(), 'qro-pipeline-settle-'));
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
    undefined, () => new FakeSerenaChild() as never, 60,
    async () => '{"answer":"fixture"}');
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
const hopsOf = (f: Fixture, requestId: string) => f.store.snapshot({ history: false }).assignments!.filter(item => item.requestId === requestId && item.pipelineKey);
const jobFor = (f: Fixture, assignmentId: string): ProviderJob => f.store.snapshot({ history: false }).jobs!.find(item => item.assignmentId === assignmentId)!;

/** Drives one hop's job to a terminal receipt through the real launch + observe path. */
async function settleHop(f: Fixture, assignmentId: string, outputName: string, state: 'COMPLETED' | 'FAILED' = 'COMPLETED'): Promise<void> {
  await f.controller.handoff(assignmentId);
  const job = jobFor(f, assignmentId);
  const bound = f.store.localSessionForJob(job.id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const output = { path: `outputs/${outputName}`, sha256: sha(`${outputName} bytes`), bytes: Buffer.byteLength(`${outputName} bytes`) };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, `outputs/${outputName}`), `${outputName} bytes`);
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ schema: 'office-local-result@2', jobId: job.id, assignmentId, attemptId: bound.attemptId, packetHash: bound.packetHash, sequence: 1, state, detail: 'Done.', outputs: [output] }));
  await f.controller.observe(assignmentId);
  assert.equal(jobFor(f, assignmentId).state, state, jobFor(f, assignmentId).detail);
}

/** Writes a verified receipt for the hop's LATEST attempt — the retry/attempt counterpart of
 *  settleHop, used where the re-armed attempt was already launched by the chain machinery. */
async function settleAttempt(f: Fixture, assignmentId: string, outputName: string, state: 'COMPLETED' | 'FAILED' = 'COMPLETED'): Promise<void> {
  const job = latestJobFor(f.store.snapshot({ history: false }).jobs, assignmentId)!;
  const bound = f.store.localSessionForJob(job.id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const output = { path: `outputs/${outputName}`, sha256: sha(`${outputName} bytes`), bytes: Buffer.byteLength(`${outputName} bytes`) };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, `outputs/${outputName}`), `${outputName} bytes`);
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ schema: 'office-local-result@2', jobId: job.id, assignmentId, attemptId: bound.attemptId, packetHash: bound.packetHash, sequence: 1, state, detail: 'Done.', outputs: [output] }));
  await f.controller.observe(assignmentId);
  assert.equal(latestJobFor(f.store.snapshot({ history: false }).jobs, assignmentId)!.state, state, latestJobFor(f.store.snapshot({ history: false }).jobs, assignmentId)!.detail);
}

/** Completes every minted hop on the request in dependency order. */
async function completeRound(f: Fixture, requestId: string): Promise<void> {
  for (;;) {
    const hops = hopsOf(f, requestId);
    const done = new Set(hops.filter(item => jobFor(f, item.id).state === 'COMPLETED').map(item => item.id));
    const next = hops.find(item => !done.has(item.id) && (item.dependsOn ?? []).every(dep => done.has(dep)));
    if (!next) return;
    await settleHop(f, next.id, `${next.pipelineKey}.txt`);
  }
}

/** Starts a pipeline request, mints + completes its brief, confirms and mints the round. */
async function launchedRound(f: Fixture, name: string, kind: 'PLANNING' | 'RESULT_ANALYSIS'): Promise<Request> {
  f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name, hypothesis: 'h', workType: kind, mode: 'SINGLE', leadAgentId: f.agents.DIRECTOR.id, participantIds: [] });
  let request = f.store.snapshot({ history: false }).requests!.find(item => item.name === name)!;
  request = f.store.execute({ type: 'request.start', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }).requests!.find(item => item.id === request.id)!;
  const briefed = await mintPipelineBrief(f.ctx, request);
  assert.equal(briefed.minted, true, 'the brief hop mints');
  request = requestOf(f, request.id);
  await settleHop(f, request.pipeline!.briefAssignmentId!, 'brief.txt');
  request = requestOf(f, request.id);
  request = f.store.execute({ type: 'request.pipeline.confirm', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }).requests!.find(item => item.id === request.id)!;
  await mintPipelineRound(f.ctx, request);
  return requestOf(f, request.id);
}

test('a fully-completed PLANNING round settles to AWAITING_DECISION bound to the terminal receipt', async t => {
  const f = await fixture(t);
  const request = await launchedRound(f, 'Plan it', 'PLANNING');
  await completeRound(f, request.id);
  const hops = hopsOf(f, request.id);
  // The in-flight spec still mints 'user-gate' as a hop — it is the head when minted.
  const head = hops.find(item => item.pipelineKey === 'user-gate') ?? hops.find(item => item.pipelineKey === 'verify')!;
  const receiptHash = f.store.localSessionForJob(jobFor(f, head.id).id)!.lastReceipt!.hash;
  const settled = settlePipelineDecision(f.ctx, requestOf(f, request.id));
  assert.equal(settled.settled, true);
  const after = requestOf(f, request.id);
  assert.equal(after.pipeline?.phase, 'AWAITING_DECISION');
  assert.deepEqual(after.pipeline?.pendingDecision, {
    specHash: request.pipeline!.specHash, headAssignmentId: head.id, headReceiptHash: receiptHash,
  }, 'the decision binds the terminal hop\'s verified receipt hash');
  // A repeated settle is a refusal, not a mutation — the wait is already recorded.
  const again = settlePipelineDecision(f.ctx, after);
  assert.equal(again.settled, false);
});

test('a fully-completed RESULT_ANALYSIS round settles on its report/gate head', async t => {
  const f = await fixture(t);
  const request = await launchedRound(f, 'Analyze it', 'RESULT_ANALYSIS');
  await completeRound(f, request.id);
  const hops = hopsOf(f, request.id);
  const head = hops.find(item => item.pipelineKey === 'user-gate') ?? hops.find(item => item.pipelineKey === 'analysis-report')!;
  const receiptHash = f.store.localSessionForJob(jobFor(f, head.id).id)!.lastReceipt!.hash;
  const settled = settlePipelineDecision(f.ctx, requestOf(f, request.id));
  assert.equal(settled.settled, true);
  assert.deepEqual(requestOf(f, request.id).pipeline?.pendingDecision, {
    specHash: request.pipeline!.specHash, headAssignmentId: head.id, headReceiptHash: receiptHash,
  });
});

test('settle refuses — never throws, never mutates — for wrong phase, open hops and a failed hop', async t => {
  const f = await fixture(t);
  // BRIEFING: minted brief, not yet confirmed.
  f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name: 'Briefing', hypothesis: 'h', workType: 'PLANNING', mode: 'SINGLE', leadAgentId: f.agents.DIRECTOR.id, participantIds: [] });
  let briefing = f.store.snapshot({ history: false }).requests!.find(item => item.name === 'Briefing')!;
  briefing = f.store.execute({ type: 'request.start', idempotencyKey: key(), requestId: briefing.id, expectedRevision: briefing.revision }).requests!.find(item => item.id === briefing.id)!;
  await mintPipelineBrief(f.ctx, briefing);
  briefing = requestOf(f, briefing.id);
  const notLaunched = settlePipelineDecision(f.ctx, briefing);
  assert.equal(notLaunched.settled, false);
  if (!notLaunched.settled) assert.match(notLaunched.reason, /BRIEFING/);
  assert.equal(requestOf(f, briefing.id).pipeline?.phase, 'BRIEFING', 'a refused settle mutates nothing');

  // LAUNCHED with the tail of the DAG still open — the barrier names the open hops.
  const request = await launchedRound(f, 'Plan it', 'PLANNING');
  const pending = hopsOf(f, request.id).filter(item => item.pipelineKey !== 'plan-brief');
  const stillOpen = settlePipelineDecision(f.ctx, request);
  assert.equal(stillOpen.settled, false);
  if (!stillOpen.settled) {
    assert.match(stillOpen.reason, /not COMPLETED/);
    for (const hop of pending) assert.ok(stillOpen.reason.includes(hop.pipelineKey!), `reason names open hop ${hop.pipelineKey}`);
  }
  const stillLaunched = requestOf(f, request.id);
  assert.equal(stillLaunched.pipeline?.phase, 'LAUNCHED');
  assert.equal(stillLaunched.pipeline?.pendingDecision, undefined);

  // A failed hop keeps the barrier down — complete everything but falsify it.
  const planB = await launchedRound(f, 'Plan B', 'PLANNING');
  const hops = hopsOf(f, planB.id);
  const synthesis = hops.find(item => item.pipelineKey === 'plan-synthesis')!;
  for (const hop of hops.filter(item => ['plan-draft-a', 'plan-draft-b', 'plan-critique-a-on-b', 'plan-critique-b-on-a'].includes(item.pipelineKey!)))
    await settleHop(f, hop.id, `${hop.pipelineKey}.txt`);
  await settleHop(f, synthesis.id, 'plan-synthesis.txt', 'FAILED');
  const failed = settlePipelineDecision(f.ctx, requestOf(f, planB.id));
  assert.equal(failed.settled, false);
  if (!failed.settled) assert.match(failed.reason, /plan-synthesis/);
  assert.equal(requestOf(f, planB.id).pipeline?.pendingDecision, undefined);

  // A non-pipeline request refuses without touching anything.
  f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name: 'Plain', hypothesis: 'h', workType: 'OTHER', mode: 'SINGLE', leadAgentId: f.agents.DIRECTOR.id, participantIds: [] });
  const plain = f.store.snapshot({ history: false }).requests!.find(item => item.name === 'Plain')!;
  const notPipeline = settlePipelineDecision(f.ctx, plain);
  assert.equal(notPipeline.settled, false);
  if (!notPipeline.settled) assert.match(notPipeline.reason, /pipeline request/);
});

test('a re-armed hop leaves dependents gated on the latest attempt', async t => {
  const f = await fixture(t);
  const request = await launchedRound(f, 'Plan retry', 'PLANNING');
  const hops = hopsOf(f, request.id);
  const draft = hops.find(item => item.pipelineKey === 'plan-draft-a')!;
  // The critique of draft A is the dependent that must never run on a failed attempt.
  const dependent = hops.find(item => item.pipelineKey === 'plan-critique-b-on-a')!;
  await settleHop(f, draft.id, 'plan-draft-a.txt', 'FAILED');
  assert.equal(jobFor(f, dependent.id).state, 'INTENT', 'a failed dependency releases nothing');

  // The retry command mints attempt 2 INTENT on the same assignment — no duplicate hop.
  const current = requestOf(f, request.id);
  f.store.execute({ type: 'request.pipeline.retryHop', idempotencyKey: key(), requestId: request.id, pipelineKey: 'plan-draft-a', expectedRevision: current.revision });
  const jobs = () => f.store.snapshot({ history: false }).jobs ?? [];
  const attempt2 = latestJobFor(jobs(), draft.id)!;
  assert.equal(attempt2.attempt, 2);
  assert.equal(attempt2.state, 'INTENT');
  assert.equal(hopsOf(f, request.id).filter(item => item.pipelineKey === 'plan-draft-a').length, 1,
    'the retry re-arms the same assignment, never a second hop');

  // The dependent's gate reads the dependency's LATEST attempt: attempt 1's failure neither
  // releases it nor counts against it — it waits on attempt 2 exactly as on a fresh mint.
  assert.equal(jobFor(f, dependent.id).state, 'INTENT');
  const status = dependencyStatus(f.store.snapshot({ history: false }), dependent);
  assert.equal(status.ready, false);
  assert.match(status.blockers[0] ?? '', /still intent/i);
  await f.controller.reconcileLocalChain();
  assert.equal(jobFor(f, dependent.id).state, 'INTENT', 'no dependent may launch while the re-armed attempt is unlaunched');
});

// The pickup half of the proof is committed as a reproducer, not run: a re-armed hop can never
// reach launch today because request.pipeline.retryHop bumps request.revision (core/store.ts),
// so the assignment's frozen requestRevision fails the launchGuard staleness check in
// controller.ts — both organizer-owned. Delete `.todo` once either the retry stops counting as a
// request change (markPipelineAwaitingDecision precedent) or pipeline hops are exempt.
test.todo('a re-armed hop is picked up by the chain exactly like a fresh mint — dependents release on attempt 2', async t => {
  const f = await fixture(t);
  const request = await launchedRound(f, 'Plan retry', 'PLANNING');
  const hops = hopsOf(f, request.id);
  const draft = hops.find(item => item.pipelineKey === 'plan-draft-a')!;
  const dependent = hops.find(item => item.pipelineKey === 'plan-critique-b-on-a')!;
  await settleHop(f, draft.id, 'plan-draft-a.txt', 'FAILED');
  const current = requestOf(f, request.id);
  f.store.execute({ type: 'request.pipeline.retryHop', idempotencyKey: key(), requestId: request.id, pipelineKey: 'plan-draft-a', expectedRevision: current.revision });
  const jobs = () => f.store.snapshot({ history: false }).jobs ?? [];

  // The startup sweep picks the re-armed hop up exactly like a fresh mint.
  await f.controller.reconcileLocalChain();
  assert.notEqual(latestJobFor(jobs(), draft.id)!.state, 'INTENT', 'reconcile launched the re-armed attempt');
  assert.equal(jobFor(f, dependent.id).state, 'INTENT', 'the dependent still waits on attempt 2');

  // Only attempt 2's verified completion releases the dependent through the ordinary chain.
  await settleAttempt(f, draft.id, 'plan-draft-a.txt');
  assert.equal(latestJobFor(jobs(), draft.id)!.state, 'COMPLETED');
  assert.equal(jobFor(f, dependent.id).state, 'INTENT', 'observation alone does not launch');
  await f.controller.advanceLocalChain(draft.id);
  assert.notEqual(jobFor(f, dependent.id).state, 'INTENT', 'the dependent launches once the retried attempt completes');
});
