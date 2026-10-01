/** Explicit live subscription acceptance. Scratch data only; no cloud/API-key route. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { AssignmentController } from '../src/main/controller';
import { LocalCliExecAdapter, spawnTreeKillable } from '../src/main/local-cli-exec';
import { LocalSessionRouter } from '../src/main/local-session-router';
import { OutputService } from '../src/main/outputs';
import { prepareInputSnapshot, verifySnapshotForTransfer } from '../src/main/locations';
import { Subscriptions } from '../src/main/subscriptions';
import {
  mintPipelineBrief,
  mintPipelineRound,
  pipelineConfirmGate,
  settlePipelineDecision,
} from '../src/main/pipeline-runner';
import type { Agent, Role, Request } from '../src/shared/types';

if (process.env.QRO_LIVE_B5 !== '1')
  throw new Error('Set QRO_LIVE_B5=1 to authorize real local subscription sessions.');
const root = path.resolve(process.argv[2] || `test-output/b5-live-${Date.now()}`);
mkdirSync(root, { recursive: true });
const file = path.join(root, 'workspace.sqlite');
let store = new OfficeStore(file);
const subs = new Subscriptions(path.join(root, 'tools'), async () => {
  throw new Error('No browser/login in acceptance');
});
let outputs = new OutputService(store, root);
const now = () => new Date().toISOString();
const key = () => randomUUID();
const launches: { pid: number | undefined; executable: string; cwd: string }[] = [];
const errors: string[] = [];
let controller: AssignmentController;
let active = true;
const adapter = new LocalCliExecAdapter({
  sessionsRoot: () => path.join(root, 'sessions'),
  executable: p => subs.toolPath(p),
  now,
  timeoutMs: 8 * 60_000,
  providerFor: id => store.snapshot({ history: false }).agents.find(a => a.id === id)?.provider,
  spawnChild: (executable, args, options) => {
    const child = spawnTreeKillable(executable, args, options);
    launches.push({ pid: child.pid, executable, cwd: options.cwd });
    return child;
  },
  onLocalEvent: jobId => {
    if (!active) return;
    void (async () => {
      const job = store.snapshot({ history: false }).jobs?.find(j => j.id === jobId);
      if (!job) return;
      await controller.observe(job.assignmentId);
      await controller.advanceLocalChain(job.assignmentId);
    })().catch(e => errors.push(String(e)));
  },
});
const router = new LocalSessionRouter(
  id => store.localSessionForJob(id),
  { FLAT_PACKET: adapter, PROJECT_WORKTREE: adapter },
  'LOCAL_CLI_EXEC',
);
const makeController = () =>
  new AssignmentController(
    store,
    router,
    now,
    snapshot => verifySnapshotForTransfer(snapshot, 'git', path.join(root, 'snapshots')),
    async p => {
      store.recordAccountObservation((await subs.observe(p)).observation);
    },
    undefined,
    undefined,
    outputs.storeBytes,
    outputs.prepare,
    () => router,
    undefined,
    outputs.readBytes,
  );
controller = makeController();
const current = (id: string) => store.snapshot({ history: false }).requests!.find(r => r.id === id)!;
const ctx = {
  store,
  prepare: (input: Parameters<AssignmentController['prepare']>[0]) => controller.prepare(input),
  snapshotFor: (request: Request) =>
    prepareInputSnapshot({
      store,
      objectRoot: root,
      stagingRoot: path.join(root, 'snapshots'),
      projectId: request.projectId,
      requestId: request.id,
      requestRevision: request.revision,
    }),
};
async function waitFor(assignmentId: string, expected: string, timeout = 8 * 60_000) {
  const end = Date.now() + timeout;
  let prior = '';
  while (Date.now() < end) {
    const job = store
      .snapshot({ history: false })
      .jobs!.filter(j => j.assignmentId === assignmentId)
      .at(-1)!;
    if (job.state !== prior) {
      console.log(now(), assignmentId, job.state);
      prior = job.state;
    }
    if (job.state === expected) return job;
    if (job.state === 'FAILED' && expected !== 'FAILED') throw new Error(job.lastObservation ?? 'Job failed');
    if (errors.length) throw new Error(errors.join('; '));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}
let success = false;
try {
  const observations = { devin: await subs.observe('devin'), openai: await subs.observe('openai') };
  for (const observed of Object.values(observations))
    assert.ok(observed.connection.connected && observed.connection.account);
  const project =
    store.snapshot({ history: false }).projects.find(p => p.name === 'B5 synthetic planning') ??
    store.execute({
      type: 'project.create',
      idempotencyKey: key(),
      name: 'B5 synthetic planning',
      mandate: 'Local subscription office acceptance. No real data or cloud.',
      budgetCents: 0,
    }).projects[0];
  const source = path.join(root, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    path.join(source, 'brief.txt'),
    'Make a tiny JSON script that emits {"rows":100,"provenance":"LOCAL_SIMULATION"}. Do not run research.',
  );
  if (!store.snapshot({ history: false }).locations?.some(l => l.projectId === project.id))
    store.execute({
      type: 'location.save',
      idempotencyKey: key(),
      projectId: project.id,
      expectedRevision: 0,
      localFolder: source,
      inputPaths: ['brief.txt'],
      outputFolder: '',
    });
  const roster: Agent[] = [];
  // Worker 2 is first so QUICK appoints the specifically authorized Codex seat.
  for (const [name, role, provider] of [
    ['Test worker 2', 'WORKER', 'openai'],
    ['Test dir 1', 'DIRECTOR', 'devin'],
    ['Test PM A', 'PM_A', 'devin'],
    ['Test PM B', 'PM_B', 'devin'],
    ['Test PM C', 'PM_C', 'devin'],
    ['Test PM D', 'PM_D', 'devin'],
    ['Test worker 1', 'WORKER', 'devin'],
  ] as const) {
    const { observation, connection } = observations[provider];
    const existing = store.snapshot({ history: false }).agents.find(a => a.name === name);
    if (existing) {
      roster.push(existing);
      continue;
    }
    const agent: Agent = {
      id: key(),
      name,
      role: role as Role,
      provider,
      team: 'Acceptance',
      model: provider === 'devin' ? 'swe-2-max' : 'gpt-6.1-sol',
      effort: provider === 'devin' ? 'default' : 'low',
      account: connection.account!,
      execution: 'LOCAL',
      localRoute: 'LOCAL_CLI_EXEC',
      createdAt: now(),
      connectionVerifiedAt: connection.checkedAt,
      instructions:
        'Synthetic software acceptance. Be brief. No delegation, network, unrelated files or research. Read CONTRACT.md and packet.json. Produce every declared output and a hash/byte-correct terminal result.json. Do not modify inputs. Finish promptly.',
    };
    store.confirmAgentBinding({ observation, agent });
    roster.push(agent);
  }
  const director = roster.find(a => a.role === 'DIRECTOR')!;
  let request =
    store.snapshot({ history: false }).requests?.find(r => r.name === 'B5 QUICK') ??
    store
      .execute({
        type: 'request.create',
        idempotencyKey: key(),
        projectId: project.id,
        name: 'B5 QUICK',
        hypothesis: 'Build the tiny JSON-emitting script described by brief.txt, then verify it without real data.',
        workType: 'PLANNING',
        mode: 'SINGLE',
        leadAgentId: director.id,
        participantIds: [],
      })
      .requests!.find(r => r.name === 'B5 QUICK')!;
  if (request.pipeline?.phase !== 'AWAITING_DECISION') {
    request = store
      .execute({
        type: 'request.start',
        idempotencyKey: key(),
        requestId: request.id,
        expectedRevision: request.revision,
      })
      .requests!.find(r => r.id === request.id)!;
    const brief = await mintPipelineBrief(ctx, request);
    if (!brief.minted) throw new Error(brief.detail);
    await controller.handoff(brief.assignment.id);
    await waitFor(brief.assignment.id, 'COMPLETED');
    request = current(request.id);
    const gate = pipelineConfirmGate(store, request.id, 'QUICK');
    if (!gate.ok) throw new Error(gate.detail);
    request = store
      .execute({
        type: 'request.pipeline.confirm',
        idempotencyKey: key(),
        requestId: request.id,
        expectedRevision: request.revision,
        shape: 'QUICK',
        specHash: gate.specHash,
      })
      .requests!.find(r => r.id === request.id)!;
    await mintPipelineRound(ctx, request);
    await controller.reconcileLocalChain();
    const hops = store
      .snapshot({ history: false })
      .assignments!.filter(a => a.requestId === request.id && a.pipelineKey);
    for (const hop of hops.filter(a => a.id !== brief.assignment.id)) {
      await waitFor(hop.id, 'COMPLETED');
    }
    if (current(request.id).pipeline!.phase === 'LAUNCHED')
      assert.deepEqual(settlePipelineDecision(ctx, current(request.id)), { settled: true });
    assert.equal(launches.length, 4);
  }
  assert.equal(current(request.id).pipeline!.phase, 'AWAITING_DECISION');
  const hops = store.snapshot({ history: false }).assignments!.filter(a => a.requestId === request.id && a.pipelineKey);
  const round = hops.map(a => ({
    name: roster.find(r => r.id === a.agentId)!.name,
    model: roster.find(r => r.id === a.agentId)!.model,
    effort: roster.find(r => r.id === a.agentId)!.effort,
    hop: a.pipelineKey,
    job: store.snapshot({ history: false }).jobs!.find(j => j.assignmentId === a.id)!,
  }));
  writeFileSync(
    path.join(root, 'quick-planning.json'),
    JSON.stringify({ round, launches, phase: current(request.id).pipeline!.phase }, null, 2),
  );
  const worker = roster[0];
  async function single(name: string, model: string, objective: string) {
    const requestName = `${name}-${key().slice(0, 8)}`;
    const agent = { ...worker, id: key(), name, model, instructions: objective };
    const freshObservation = (await subs.observe('openai')).observation;
    store.confirmAgentBinding({ observation: freshObservation, agent });
    const r = store
      .execute({
        type: 'request.create',
        idempotencyKey: key(),
        projectId: project.id,
        name: requestName,
        hypothesis: objective,
        workType: 'QUESTION',
        mode: 'SINGLE',
        leadAgentId: agent.id,
        participantIds: [],
      })
      .requests!.find(r => r.name === requestName)!;
    const snapshot = await ctx.snapshotFor(r);
    const { assignment } = controller.prepare({ requestId: r.id, agentId: agent.id, snapshotId: snapshot.id });
    await controller.handoff(assignment.id);
    return assignment;
  }
  const bad = await single(
    'Test worker 2 bad-model',
    'qro-intentionally-invalid-model',
    'Reply only OK; do not use tools.',
  );
  const failed = await waitFor(bad.id, 'FAILED', 90_000);
  const cancel = await single(
    'Test worker 2 cancel',
    worker.model,
    'Read CONTRACT.md. Start a shell that waits 120 seconds before any output; do not finish earlier. Synthetic cancellation acceptance only.',
  );
  await new Promise(resolve => setTimeout(resolve, 6000));
  const live = adapter
    .presence()
    .find(p => p.jobId === store.snapshot({ history: false }).jobs!.find(j => j.assignmentId === cancel.id)!.id)!;
  assert.ok(live.alive);
  let descendants: number[] = [];
  const treeDeadline = Date.now() + 40_000;
  while (Date.now() < treeDeadline && descendants.length === 0) {
    const processes = JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', windowsHide: true },
      ),
    ) as { ProcessId: number; ParentProcessId: number }[];
    const pids = new Set([live.pid!]);
    let added = true;
    while (added) {
      added = false;
      for (const p of processes)
        if (pids.has(p.ParentProcessId) && !pids.has(p.ProcessId)) {
          pids.add(p.ProcessId);
          added = true;
        }
    }
    descendants = [...pids].filter(p => p !== live.pid);
    if (!descendants.length) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(descendants.length > 0, 'a real tool child exists before cancellation');
  await controller.cancel(cancel.id);
  const cancelled = await waitFor(cancel.id, 'FAILED', 30_000);
  assert.match(cancelled.lastObservation ?? '', /office terminated/);
  for (const pid of [live.pid!, ...descendants]) {
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise(resolve => setTimeout(resolve, 250));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `process ${pid} stopped`);
  }
  active = false;
  adapter.disposeAll();
  const launchCount = launches.length;
  store.close();
  store = new OfficeStore(file);
  outputs = new OutputService(store, root);
  controller = makeController();
  await controller.reconcileLocalChain();
  assert.equal(launches.length, launchCount, 'restart does not redispatch');
  const report = {
    status: 'PASS',
    route: 'LOCAL_CLI_EXEC',
    authMode: 'subscription',
    colabUsed: false,
    versions: Object.fromEntries(Object.entries(observations).map(([p, o]) => [p, o.observation.toolVersion])),
    round,
    badModel: { state: failed.state, detail: failed.lastObservation },
    cancellation: {
      pid: live.pid,
      descendants,
      allStopped: true,
      state: cancelled.state,
      detail: cancelled.lastObservation,
    },
    launchCount,
    restartNoRedispatch: true,
    errors,
  };
  writeFileSync(path.join(root, 'acceptance.json'), JSON.stringify(report, null, 2));
  console.log('PASS B5', root);
  success = true;
} catch (e) {
  console.error(e);
  writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ error: String(e), errors }, null, 2));
  process.exitCode = 1;
} finally {
  if (!success)
    for (const job of store.snapshot({ history: false }).jobs ?? []) {
      if (['INTENT', 'COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED'].includes(job.state)) continue;
      try {
        await controller.cancel(job.assignmentId);
      } catch {
        /* keep failure evidence */
      }
    }
  active = false;
  adapter.disposeAll();
  subs.close();
  store.close();
}
