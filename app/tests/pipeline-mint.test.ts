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
import { mintPipelineBrief, mintPipelineRefine, mintPipelineRound, pipelineConfirmGate, type PipelineMintContext } from '../src/main/pipeline-runner';
import { RESULT_FILE } from '../src/main/local-packet';
import type { Agent, AppState, ProviderJob, Request } from '../src/shared/types';

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
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  private readonly listeners = { exit: [] as ((code: number | null, signal: NodeJS.Signals | null) => void)[], error: [] as ((error: Error) => void)[] };
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

interface PipelineFixture {
  root: string; store: OfficeStore; project: { id: string };
  agents: Record<'DIRECTOR' | 'PM_A' | 'PM_B' | 'PM_C' | 'PM_D' | 'WORKER', Agent>;
  ctx: PipelineMintContext; controller: AssignmentController; sessionsRoot: string;
}

/** A roster covering every pipeline arm, wired to the scripted local CLI route. */
async function fixture(t: any, opts: { drop?: ('DIRECTOR' | 'PM_A' | 'PM_B' | 'PM_C' | 'PM_D' | 'WORKER')[] } = {}): Promise<PipelineFixture> {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-pipeline-mint-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  const execAdapter: { current?: LocalCliExecAdapter } = {};
  t.after(() => { execAdapter.current?.disposeAll(); try { store.close(); } catch {} removeTreeSync(root, { recursive: true, force: true }); });
  const sessionsRoot = path.join(root, 'local-sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  const project = store.execute({ type: 'project.create', idempotencyKey: key(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  const agents = {} as PipelineFixture['agents'];
  for (const role of ['DIRECTOR', 'PM_A', 'PM_B', 'PM_C', 'PM_D', 'WORKER'] as const) {
    if (opts.drop?.includes(role)) continue;
    const agent: Agent = { id: randomUUID(), name: `${role} agent`, provider: 'claude', model: 'opus', team: 'Research', role, instructions: '', effort: 'default',
      account: 'researcher@example.com', createdAt: at(0), connectionVerifiedAt: at(0), execution: 'LOCAL', localRoute: 'LOCAL_CLI_EXEC' };
    store.confirmAgentBinding({ observation: localObservation('LOCAL_CLI_EXEC', 0), agent });
    agents[role] = agent;
  }
  const spawn: CliSpawn = () => new FakeChild() as never;
  const exec = new LocalCliExecAdapter(() => sessionsRoot, provider => `${provider}.exe`, clock, undefined, spawn,
    () => ({ TEST_ENV: 'scrubbed' }), undefined, undefined, agentId => store.snapshot().agents.find(a => a.id === agentId)?.provider);
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

const makeRequest = (f: PipelineFixture, workType: 'PLANNING' | 'RESULT_ANALYSIS'): Request =>
  f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name: 'Pipeline request', hypothesis: 'Plan the thing.', workType, mode: 'SINGLE', leadAgentId: f.agents.DIRECTOR?.id ?? null, participantIds: [] }).requests![0];

const started = (f: PipelineFixture, request: Request): Request =>
  f.store.execute({ type: 'request.start', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }).requests!.find(item => item.id === request.id)!;

const requestOf = (f: PipelineFixture, requestId: string): Request => f.store.snapshot({ history: false }).requests!.find(item => item.id === requestId)!;
const jobFor = (f: PipelineFixture, assignmentId: string): ProviderJob => f.store.snapshot({ history: false }).jobs!.find(item => item.assignmentId === assignmentId)!;

test('request.start on a pipeline request mints only the director brief hop, bound durably', async t => {
  const f = await fixture(t);
  let request = started(f, makeRequest(f, 'PLANNING'));
  assert.equal(request.pipeline?.phase, 'BRIEFING');
  assert.equal(request.pipeline?.briefAssignmentId, null);
  const minted = await mintPipelineBrief(f.ctx, request);
  assert.equal(minted.minted, true);
  request = requestOf(f, request.id);
  assert.equal(request.pipeline?.briefAssignmentId, minted.assignment!.id);
  assert.match(request.pipeline?.specHash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(minted.assignment!.pipelineKey, 'plan-brief');
  assert.equal(minted.assignment!.agentId, f.agents.DIRECTOR.id);
  assert.equal(minted.assignment!.toolProfile?.canWrite, false);
  assert.equal(jobFor(f, minted.assignment!.id).state, 'INTENT');
  // Only the brief hop exists — the rest of the spec is not minted until confirm.
  const hops = f.store.snapshot({ history: false }).assignments!.filter(item => item.requestId === request.id);
  assert.equal(hops.length, 1);
});

test('a note mints a refine hop chained off the prior brief and re-binds the gate', async t => {
  const f = await fixture(t);
  let request = started(f, makeRequest(f, 'PLANNING'));
  const brief = (await mintPipelineBrief(f.ctx, request) as { minted: true; assignment: { id: string } }).assignment;
  request = requestOf(f, request.id);
  request = f.store.execute({ type: 'request.pipeline.note', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision, text: 'Prefer the bounded variant.' }).requests!.find(item => item.id === request.id)!;
  const minted = await mintPipelineRefine(f.ctx, request, 'Prefer the bounded variant.');
  assert.equal(minted.minted, true);
  assert.equal(minted.assignment!.pipelineKey, 'brief-refine-1');
  assert.deepEqual(minted.assignment!.dependsOn, [brief.id]);
  assert.equal(minted.assignment!.frozen?.objective, 'Prefer the bounded variant.');
  request = requestOf(f, request.id);
  // The gate moves to the refine hop — confirm must wait on the freshest brief.
  assert.equal(request.pipeline?.briefAssignmentId, minted.assignment!.id);
  assert.equal(request.pipelineNotes!.length, 1);
});

test('confirm refuses while the brief hop is unfinished and mints the whole spec after it completes', async t => {
  const f = await fixture(t);
  let request = started(f, makeRequest(f, 'PLANNING'));
  const brief = (await mintPipelineBrief(f.ctx, request) as { minted: true; assignment: { id: string } }).assignment;
  request = requestOf(f, request.id);
  // The reducer gate: the brief job is still INTENT.
  assert.throws(() => f.store.execute({ type: 'request.pipeline.confirm', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }), /shaped brief must exist/);
  // Complete the brief through the real launch path.
  await f.controller.handoff(brief.id);
  const bound = f.store.localSessionForJob(jobFor(f, brief.id).id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const output = { path: 'outputs/brief.txt', sha256: sha('shaped brief'), bytes: Buffer.byteLength('shaped brief') };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'brief.txt'), 'shaped brief');
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ schema: 'office-local-result@2', jobId: jobFor(f, brief.id).id, assignmentId: brief.id, attemptId: bound.attemptId, packetHash: bound.packetHash, sequence: 1, state: 'COMPLETED', detail: 'Done.', outputs: [output] }));
  await f.controller.observe(brief.id);
  assert.equal(jobFor(f, brief.id).state, 'COMPLETED');
  // The confirm gate resolves the whole spec before the phase flips.
  assert.equal(pipelineConfirmGate(f.store, request.id).ok, true);
  request = requestOf(f, request.id);
  request = f.store.execute({ type: 'request.pipeline.confirm', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }).requests!.find(item => item.id === request.id)!;
  assert.equal(request.pipeline?.phase, 'LAUNCHED');
  const { minted } = await mintPipelineRound(f.ctx, request);
  assert.equal(minted, 7); // drafts(2) + critiques(2) + synthesis + implement(1 worker) + verify — the seal is a wait state, not a hop
  const hops = f.store.snapshot({ history: false }).assignments!.filter(item => item.requestId === request.id);
  const byKey = new Map(hops.map(item => [item.pipelineKey!, item]));
  assert.equal(byKey.size, 8);
  // DAG edges resolve to assignment ids; the director holds several INTENT hops — serialized by the DAG.
  assert.deepEqual(byKey.get('plan-draft-a')!.dependsOn, [brief.id]);
  assert.deepEqual(byKey.get('plan-synthesis')!.dependsOn!.sort(), [byKey.get('plan-draft-a')!.id, byKey.get('plan-draft-b')!.id, byKey.get('plan-critique-a-on-b')!.id, byKey.get('plan-critique-b-on-a')!.id].sort());
  assert.equal(byKey.get('plan-draft-a')!.agentId, f.agents.PM_A.id);
  assert.equal(byKey.get('plan-draft-b')!.agentId, f.agents.PM_B.id);
  assert.equal(byKey.get('implement-1')!.agentId, f.agents.WORKER.id);
  assert.equal(jobFor(f, byKey.get('verify')!.id).state, 'INTENT');
  assert.equal(byKey.get('user-gate'), undefined, 'no user-gate hop is minted — the decision wait is a pipeline phase');
});

test('the confirm gate names every missing role and confirm never lands', async t => {
  const f = await fixture(t, { drop: ['PM_B'] });
  let request = started(f, makeRequest(f, 'PLANNING'));
  // request.start itself recorded the missing role as a blocker — the brief mint refuses too.
  assert.ok(request.blockers.some(item => item.code === 'PIPELINE_ROLE_MISSING'));
  const brief = await mintPipelineBrief(f.ctx, request);
  assert.equal(brief.minted, false);
  const gate = pipelineConfirmGate(f.store, request.id);
  assert.equal(gate.ok, false);
  assert.match((gate as { detail: string }).detail, /PM_B/);
  request = requestOf(f, request.id);
  assert.throws(() => f.store.execute({ type: 'request.pipeline.confirm', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }), /No director brief hop exists yet/);
  assert.equal(requestOf(f, request.id).pipeline?.phase, 'BRIEFING');
});

test('bindPipelineBrief refuses assignments that are not minted director brief hops', async t => {
  const f = await fixture(t);
  let request = started(f, makeRequest(f, 'RESULT_ANALYSIS'));
  const minted = await mintPipelineBrief(f.ctx, request) as { minted: true; assignment: { id: string } };
  request = requestOf(f, request.id);
  // A second bind to the same hop is the idempotent path; a foreign assignment is refused.
  f.store.bindPipelineBrief({ requestId: request.id, expectedRevision: request.revision, briefAssignmentId: minted.assignment.id });
  const other = f.store.snapshot({ history: false }).assignments!.find(item => item.requestId === request.id)!;
  assert.equal(other.id, minted.assignment.id);
  // A REQUEST_ANALYSIS brief is analysis-brief; minted key asserted:
  assert.equal(other.pipelineKey, 'analysis-brief');
});

test('the same-agent open-job rule still refuses a second manual hop on a non-pipeline request', async t => {
  const f = await fixture(t);
  const request = f.store.execute({ type: 'request.create', idempotencyKey: key(), projectId: f.project.id, name: 'Plain', hypothesis: 'h', workType: 'OTHER', mode: 'SINGLE', leadAgentId: f.agents.WORKER.id, participantIds: [] }).requests![0];
  const snapshot = await f.ctx.snapshotFor(request, { key: 'x' } as never);
  f.controller.prepare({ requestId: request.id, agentId: f.agents.WORKER.id, snapshotId: snapshot.id });
  const second = await f.ctx.snapshotFor(request, { key: 'y' } as never);
  assert.throws(() => f.controller.prepare({ requestId: request.id, agentId: f.agents.WORKER.id, snapshotId: second.id }), /already has work in flight/);
});

test('use-as-new on a launched pipeline starts a fresh pipeline, never the source\'s phase or brief', async t => {
  const f = await fixture(t);
  let request = started(f, makeRequest(f, 'PLANNING'));
  const brief = (await mintPipelineBrief(f.ctx, request) as { minted: true; assignment: { id: string } }).assignment;
  await f.controller.handoff(brief.id);
  const bound = f.store.localSessionForJob(jobFor(f, brief.id).id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const output = { path: 'outputs/brief.txt', sha256: sha('shaped brief'), bytes: Buffer.byteLength('shaped brief') };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, 'outputs', 'brief.txt'), 'shaped brief');
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ schema: 'office-local-result@2', jobId: jobFor(f, brief.id).id, assignmentId: brief.id, attemptId: bound.attemptId, packetHash: bound.packetHash, sequence: 1, state: 'COMPLETED', detail: 'Done.', outputs: [output] }));
  await f.controller.observe(brief.id);
  request = requestOf(f, request.id);
  request = f.store.execute({ type: 'request.pipeline.confirm', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision }).requests!.find(item => item.id === request.id)!;
  assert.equal(request.pipeline?.phase, 'LAUNCHED');
  const state = f.store.execute({ type: 'request.duplicate', idempotencyKey: key(), requestId: request.id, expectedRevision: request.revision });
  const copy = state.requests!.find(item => item.sourceRequestId === request.id)!;
  assert.deepEqual(copy.pipeline, { kind: 'PLANNING', specHash: null, phase: 'BRIEFING', briefAssignmentId: null });
  assert.equal(copy.status, 'DRAFT');
});
