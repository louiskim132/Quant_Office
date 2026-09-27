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
import {
  mintPipelineBrief,
  mintPipelineRefine,
  mintPipelineRound,
  type PipelineMintContext,
} from '../src/main/pipeline-runner';
import { RESULT_FILE } from '../src/main/local-packet';
import type { Agent, ProviderJob, Request } from '../src/shared/types';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const key = () => randomUUID();
const at = (m: number) => new Date(Date.UTC(2026, 8, 19, 10, 0, 0) + m * 60000).toISOString();
const clock = () => at(5);

const LOCAL_DISPATCH_OPS = [
  'LOCAL_SUBMIT',
  'LOCAL_OBSERVE',
  'LOCAL_OUTPUT_FETCH',
  'LOCAL_CANCEL',
  'MODEL_APPLICATION',
  'EFFORT_APPLICATION',
  'DELEGATION_CONTROL',
  'TOOL_CONFINEMENT',
] as const;
const localObservation = (route: 'LOCAL_CLI_EXEC', minutes: number) => ({
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

class FakeChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly listeners = {
    exit: [] as ((code: number | null, signal: NodeJS.Signals | null) => void)[],
    error: [] as ((error: Error) => void)[],
  };
  constructor(readonly pid: number | undefined = 4321) {}
  kill() {
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
}

/** Answers the MCP initialize handshake so declared serena tool surfaces pass the office probe. */
class FakeSerenaChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly kills: unknown[] = [];
  constructor(readonly pid = 7777) {
    this.stdin.on('data', () => {
      this.stdout.write(
        '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"serena","version":"1.7.0"}}}\n',
      );
    });
  }
  kill(signal?: unknown) {
    this.kills.push(signal);
    return true;
  }
  on(event: string, listener: (...args: never[]) => void) {
    return this;
  }
}

interface Fixture {
  root: string;
  store: OfficeStore;
  project: { id: string };
  agents: Record<string, Agent>;
  ctx: PipelineMintContext;
  controller: AssignmentController;
  sessionsRoot: string;
}

async function fixture(t: any): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-pipeline-scope-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  const execAdapter: { current?: LocalCliExecAdapter } = {};
  t.after(() => {
    execAdapter.current?.disposeAll();
    try {
      store.close();
    } catch {}
    removeTreeSync(root, { recursive: true, force: true });
  });
  const sessionsRoot = path.join(root, 'local-sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  const agents: Record<string, Agent> = {};
  for (const role of ['DIRECTOR', 'PM_A', 'PM_B', 'PM_C', 'PM_D', 'WORKER'] as const) {
    const agent: Agent = {
      id: randomUUID(),
      name: `${role} agent`,
      provider: 'claude',
      model: 'opus',
      team: 'Research',
      role,
      instructions: '',
      effort: 'default',
      account: 'researcher@example.com',
      createdAt: at(0),
      connectionVerifiedAt: at(0),
      execution: 'LOCAL',
      localRoute: 'LOCAL_CLI_EXEC',
    };
    store.confirmAgentBinding({ observation: localObservation('LOCAL_CLI_EXEC', 0), agent });
    agents[role] = agent;
  }
  const spawn: CliSpawn = () => new FakeChild() as never;
  const exec = new LocalCliExecAdapter(
    () => sessionsRoot,
    provider => `${provider}.exe`,
    clock,
    undefined,
    spawn,
    () => ({ TEST_ENV: 'scrubbed' }),
    undefined,
    undefined,
    agentId => store.snapshot().agents.find(a => a.id === agentId)?.provider,
    undefined,
    () => new FakeSerenaChild() as never,
    60,
  );
  execAdapter.current = exec;
  const local = new LocalSessionRouter(
    id => store.localSessionForJob(id),
    { FLAT_PACKET: exec, PROJECT_WORKTREE: exec },
    'LOCAL_CLI_EXEC',
  );
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
          : undefined
        : ref.agent?.execution === 'LOCAL'
          ? local
          : undefined,
    undefined,
    outputs.readBytes,
  );
  const ctx: PipelineMintContext = {
    store,
    snapshotFor: req =>
      prepareInputSnapshot({
        store,
        objectRoot: root,
        stagingRoot: path.join(root, 'staging'),
        projectId: req.projectId,
        requestId: req.id,
        requestRevision: req.revision,
        objective: req.objective,
      }),
    prepare: input => controller.prepare(input),
  };
  return { root, store, project, agents, ctx, controller, sessionsRoot };
}

const requestOf = (f: Fixture, requestId: string): Request =>
  f.store.snapshot({ history: false }).requests!.find(item => item.id === requestId)!;
const hopsOf = (f: Fixture, requestId: string) =>
  f.store.snapshot({ history: false }).assignments!.filter(item => item.requestId === requestId && item.pipelineKey);
const jobFor = (f: Fixture, assignmentId: string): ProviderJob =>
  f.store.snapshot({ history: false }).jobs!.find(item => item.assignmentId === assignmentId)!;

/** Creates, starts and brief-mints one PLANNING pipeline request. */
async function startedPipeline(f: Fixture, name: string): Promise<Request> {
  f.store.execute({
    type: 'request.create',
    idempotencyKey: key(),
    projectId: f.project.id,
    name,
    hypothesis: 'Plan the thing.',
    workType: 'PLANNING',
    mode: 'SINGLE',
    leadAgentId: f.agents.DIRECTOR.id,
    participantIds: [],
  });
  let request = f.store.snapshot({ history: false }).requests!.find(item => item.name === name)!;
  request = f.store
    .execute({
      type: 'request.start',
      idempotencyKey: key(),
      requestId: request.id,
      expectedRevision: request.revision,
    })
    .requests!.find(item => item.id === request.id)!;
  const briefed = await mintPipelineBrief(f.ctx, request);
  assert.equal(briefed.minted, true, 'the brief hop mints');
  return requestOf(f, request.id);
}

/** Completes one hop's job through the real launch + receipt path. */
async function completeHop(f: Fixture, assignmentId: string, outputName: string): Promise<void> {
  await f.controller.handoff(assignmentId);
  const job = jobFor(f, assignmentId);
  const bound = f.store.localSessionForJob(job.id)!;
  const dir = path.join(f.sessionsRoot, bound.storageRelativePath);
  const output = {
    path: `outputs/${outputName}`,
    sha256: sha(`${outputName} bytes`),
    bytes: Buffer.byteLength(`${outputName} bytes`),
  };
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(dir, `outputs/${outputName}`), `${outputName} bytes`);
  writeFileSync(
    path.join(dir, RESULT_FILE),
    JSON.stringify({
      schema: 'office-local-result@2',
      jobId: job.id,
      assignmentId,
      attemptId: bound.attemptId,
      packetHash: bound.packetHash,
      sequence: 1,
      state: 'COMPLETED',
      detail: 'Done.',
      outputs: [output],
    }),
  );
  await f.controller.observe(assignmentId);
  assert.equal(jobFor(f, assignmentId).state, 'COMPLETED', jobFor(f, assignmentId).detail);
}

test('two simultaneous pipeline requests mint isolated hop sets — same keys, own ids', async t => {
  const f = await fixture(t);
  const a = await startedPipeline(f, 'Round A');
  const b = await startedPipeline(f, 'Round B');
  // Each request's bound brief is its own minted assignment, not the other's.
  assert.notEqual(a.pipeline!.briefAssignmentId, b.pipeline!.briefAssignmentId);
  const aBrief = hopsOf(f, a.id).find(item => item.id === a.pipeline!.briefAssignmentId)!;
  const bBrief = hopsOf(f, b.id).find(item => item.id === b.pipeline!.briefAssignmentId)!;
  assert.equal(aBrief.pipelineKey, 'plan-brief');
  assert.equal(bBrief.pipelineKey, 'plan-brief');
  // A second mint of B still re-binds B's own brief, never A's.
  const rebrief = await mintPipelineBrief(f.ctx, requestOf(f, b.id));
  assert.equal(rebrief.minted, true);
  if (rebrief.minted) assert.equal(rebrief.assignment.id, b.pipeline!.briefAssignmentId);
  // A refine on B chains off B's brief, not A's.
  const refined = await mintPipelineRefine(f.ctx, requestOf(f, b.id), 'Tighten the scope to ingestion.');
  assert.equal(refined.minted, true);
  if (refined.minted) {
    assert.equal(refined.assignment.requestId, b.id);
    assert.equal(refined.assignment.pipelineKey, 'brief-refine-1');
    assert.deepEqual(refined.assignment.dependsOn, [b.pipeline!.briefAssignmentId]);
  }
  // Complete both briefs in dependency order — B's bound brief is the refine hop, which
  // waits on its own plan-brief; A's bound brief is still plan-brief.
  await completeHop(f, a.pipeline!.briefAssignmentId!, 'a-brief.txt');
  await completeHop(f, hopsOf(f, b.id).find(item => item.pipelineKey === 'plan-brief')!.id, 'b-brief.txt');
  await completeHop(f, requestOf(f, b.id).pipeline!.briefAssignmentId!, 'b-refine.txt');
  for (const req of [a, b]) {
    const current = requestOf(f, req.id);
    f.store.execute({
      type: 'request.pipeline.confirm',
      idempotencyKey: key(),
      requestId: current.id,
      expectedRevision: current.revision,
    });
    const minted = await mintPipelineRound(f.ctx, requestOf(f, current.id));
    assert.ok(minted.minted > 0);
  }
  const aHops = hopsOf(f, a.id);
  const bHops = hopsOf(f, b.id);
  const aKeys = aHops.map(item => item.pipelineKey).sort();
  // B carries its extra 'brief-refine-1' hop; otherwise both mint the identical deterministic key set.
  const bKeys = bHops
    .map(item => item.pipelineKey)
    .filter(item => item !== 'brief-refine-1')
    .sort();
  assert.deepEqual(aKeys, bKeys, 'both requests mint the identical deterministic key set');
  assert.ok(bHops.some(item => item.pipelineKey === 'brief-refine-1'));
  const aIds = new Set(aHops.map(item => item.id));
  const bIds = new Set(bHops.map(item => item.id));
  for (const hop of bHops)
    for (const dep of hop.dependsOn ?? [])
      assert.ok(bIds.has(dep), `${hop.pipelineKey} depends on B's own hop, not A's — got ${dep}`);
  for (const hop of aHops)
    for (const dep of hop.dependsOn ?? [])
      assert.ok(aIds.has(dep), `${hop.pipelineKey} depends on A's own hop, not B's — got ${dep}`);
  assert.equal(aHops.filter(item => bIds.has(item.id)).length, 0, 'no shared assignment ids between the two rounds');
});
