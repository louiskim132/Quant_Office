/** Explicitly invoked live subscription test; excluded from *.test.ts. Synthetic office work only. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OfficeStore } from '../src/core/store';
import { AssignmentController } from '../src/main/controller';
import { LocalCliExecAdapter } from '../src/main/local-cli-exec';
import { LocalSessionRouter } from '../src/main/local-session-router';
import { OutputService } from '../src/main/outputs';
import { prepareInputSnapshot, verifySnapshotForTransfer } from '../src/main/locations';
import { Subscriptions } from '../src/main/subscriptions';
import { readLocalResult } from '../src/main/local-packet';
import { GuardedLocalFileIO } from '../src/main/local-session-files';
import type { Agent, Role } from '../src/shared/types';

if (process.env.QRO_LIVE_THREE_AGENT !== '1')
  throw new Error('Set QRO_LIVE_THREE_AGENT=1 to authorize three real Claude CLI sessions.');
const root = path.resolve('test-output', `three-agent-live-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(root, { recursive: true });
const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
const subscriptions = new Subscriptions(path.join(root, 'tools'), async () => {
  throw new Error('No login/browser permitted in this test');
});
const outputs = new OutputService(store, root);
const sessionsRoot = path.join(root, 'sessions');
const stagingRoot = path.join(root, 'snapshots');
const now = () => new Date().toISOString();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const key = () => randomUUID();
const errors: string[] = [];
const callbacks: Promise<void>[] = [];
const launches: { executable: string; cwd: string; pid: number | undefined }[] = [];
const exited = new Map<string, number>();
let controller: AssignmentController;
const exec = new LocalCliExecAdapter({
  sessionsRoot: () => sessionsRoot,
  executable: p => subscriptions.toolPath(p),
  now,
  spawnChild: (executable, args, options) => {
    const child = spawn(executable, args, options);
    launches.push({ executable, cwd: options.cwd, pid: child.pid });
    child.on('exit', () => exited.set(options.cwd, Date.now()));
    return child;
  },
  timeoutMs: 8 * 60_000,
  providerFor: id => store.snapshot({ history: false }).agents.find(a => a.id === id)?.provider,
  onLocalEvent: jobId => {
    const task = (async () => {
      const job = store.snapshot({ history: false }).jobs?.find(j => j.id === jobId);
      if (!job) return;
      await controller.observe(job.assignmentId);
      await controller.advanceLocalChain(job.assignmentId);
    })().catch(e => {
      errors.push(String(e));
      console.error('EVENT_ERROR', String(e));
    });
    callbacks.push(task);
  },
});
const route = new LocalSessionRouter(
  id => store.localSessionForJob(id),
  { FLAT_PACKET: exec, PROJECT_WORKTREE: exec },
  'LOCAL_CLI_EXEC',
);
controller = new AssignmentController(
  store,
  route,
  now,
  snapshot => verifySnapshotForTransfer(snapshot, 'git', stagingRoot),
  async provider => {
    store.recordAccountObservation((await subscriptions.observe(provider)).observation);
  },
  undefined,
  undefined,
  outputs.storeBytes,
  outputs.prepare,
  () => route,
  undefined,
  outputs.readBytes,
);
const nodes: { role: Role; agent: Agent; assignmentId: string; jobId: string }[] = [];
let passed = false;
try {
  console.log('ARTIFACT_ROOT', root);
  const { observation, connection } = await subscriptions.observe('claude');
  assert.ok(connection.connected && connection.account, 'Official CLI must report signed-in account');
  console.log('AUTH', JSON.stringify({ connected: connection.connected, version: observation.toolVersion }));
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Synthetic three-agent relay',
    mandate: 'Office orchestration acceptance only; no research execution.',
    budgetCents: 0,
  }).projects[0];
  const source = path.join(root, 'source');
  mkdirSync(source);
  const nonce = randomUUID();
  writeFileSync(
    path.join(source, 'brief.json'),
    JSON.stringify({ nonce, task: 'Relay a synthetic office plan through Director, PM, Worker.' }),
  );
  store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: project.id,
    expectedRevision: 0,
    localFolder: source,
    inputPaths: ['brief.json'],
    outputFolder: '',
  });
  for (const role of ['DIRECTOR', 'PM_A', 'WORKER'] as const) {
    const prior = nodes.at(-1);
    const instructions = `Synthetic software acceptance, no research, no delegation, no network or unrelated files. Work only in this packet directory. Read CONTRACT.md and packet.json. Produce exactly outputs/report.json and a valid terminal result.json receipt, using UTF-8 without BOM and measured SHA256/byte length. Report JSON must contain role=${role}, nonce from brief.json, trail as an array of role strings, and predecessorSha256. ${prior ? `Read the inherited predecessor report.json; verify its role is ${prior.role}. Copy its nonce and trail, append ${role}, and set predecessorSha256 to the actual SHA256 of those inherited report bytes. Describe briefly how its plan informs your ${role === 'PM_A' ? 'worker task plan' : 'delivery report'}.` : 'Use trail [DIRECTOR], predecessorSha256 null, and include a short plan for the PM to turn into a worker task.'} Do not modify inputs. Do not claim independent isolation. Finish promptly.`;
    const agent: Agent = {
      id: key(),
      name: `Acceptance ${role}`,
      provider: 'claude',
      model: 'opus',
      team: 'Acceptance',
      role,
      instructions,
      effort: 'default',
      account: connection.account,
      createdAt: now(),
      connectionVerifiedAt: connection.checkedAt,
      execution: 'LOCAL',
      localRoute: 'LOCAL_CLI_EXEC',
    };
    store.confirmAgentBinding({ observation, agent });
    const request = store
      .execute({
        type: 'request.create',
        idempotencyKey: key(),
        projectId: project.id,
        name: role,
        hypothesis: instructions,
        workType: 'QUESTION',
        mode: 'SINGLE',
        leadAgentId: agent.id,
        participantIds: [],
      })
      .requests!.find(r => r.name === role)!;
    const snapshot = await prepareInputSnapshot({
      store,
      objectRoot: root,
      stagingRoot,
      projectId: project.id,
      requestId: request.id,
      requestRevision: request.revision,
    });
    const { assignment } = controller.prepare({
      requestId: request.id,
      agentId: agent.id,
      snapshotId: snapshot.id,
      ...(prior ? { dependsOn: [prior.assignmentId] } : {}),
    });
    const job = store.snapshot({ history: false }).jobs!.find(j => j.assignmentId === assignment.id)!;
    nodes.push({ role, agent, assignmentId: assignment.id, jobId: job.id });
  }
  // Only the director receives a manual start. All downstream observation/launches are event-driven.
  await controller.handoff(nodes[0].assignmentId);
  const deadline = Date.now() + 15 * 60_000;
  let previous = '';
  while (Date.now() < deadline) {
    const jobs = nodes.map(n => store.snapshot({ history: false }).jobs!.find(j => j.id === n.jobId)!);
    const state = jobs.map((j, i) => `${nodes[i].role}:${j.state}`).join(' ');
    if (state !== previous) {
      console.log(now(), state);
      previous = state;
    }
    if (jobs.every(j => j.state === 'COMPLETED')) break;
    if (jobs.some(j => j.state === 'FAILED') || errors.length)
      throw new Error(`Chain failed: ${state}; ${errors.join('; ')}`);
    // Diagnose an exited session's rejected receipt without manually advancing the chain.
    for (const job of jobs.filter(j => j.state === 'UNKNOWN')) {
      const binding = store.localSessionForJob(job.id);
      if (!binding) continue;
      const dir = path.join(sessionsRoot, binding.storageRelativePath);
      if (exited.has(dir) && Date.now() - exited.get(dir)! > 5000) {
        const read = readLocalResult(dir, binding, new GuardedLocalFileIO());
        if ('defect' in read) throw new Error(`Exited session ${job.id}: ${read.defect}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000)); // read-only status; no observe/advance polling
  }
  await Promise.all(callbacks);
  assert.deepEqual(errors, [], 'No event callback failures');
  assert.equal(launches.length, 3, 'Exactly three real process launches');
  assert.equal(new Set(launches.map(l => l.pid)).size, 3);
  assert.ok(launches.every(l => Number.isInteger(l.pid)));
  const chainEvents = store.snapshot({ history: true }).jobEvents ?? [];
  assert.deepEqual(
    chainEvents
      .filter(e => e.externalId.startsWith('chain-launch:'))
      .map(e => e.jobId)
      .sort(),
    nodes
      .slice(1)
      .map(n => n.jobId)
      .sort(),
  );
  assert.equal(chainEvents.filter(e => e.externalId.startsWith('chain-blocked:')).length, 0);
  let predecessorHash: string | null = null;
  const reports = [];
  for (const [index, node] of nodes.entries()) {
    const job = store.snapshot({ history: false }).jobs!.find(j => j.id === node.jobId)!;
    assert.equal(job.state, 'COMPLETED');
    const output = job.outputs.find(o => o.path === 'outputs/report.json');
    assert.ok(output?.stored, 'Every output must be durably stored');
    const bytes = await outputs.readBytes(output.sha256);
    assert.equal(hash(bytes), output.sha256);
    const report = JSON.parse(Buffer.from(bytes).toString('utf8'));
    assert.equal(report.role, node.role);
    assert.equal(report.nonce, nonce);
    assert.deepEqual(
      report.trail,
      nodes.slice(0, index + 1).map(n => n.role),
    );
    assert.equal(report.predecessorSha256, predecessorHash);
    const binding = store.localSessionForJob(job.id)!;
    const packet = JSON.parse(
      readFileSync(path.join(sessionsRoot, binding.storageRelativePath, 'packet.json'), 'utf8'),
    );
    if (index) {
      const inherited = readFileSync(
        path.join(
          sessionsRoot,
          binding.storageRelativePath,
          'inputs',
          'inherited',
          nodes[index - 1].jobId,
          'report.json',
        ),
      );
      assert.equal(hash(inherited), predecessorHash);
      assert.deepEqual(packet.inherited, [
        {
          path: `inputs/inherited/${nodes[index - 1].jobId}/report.json`,
          sha256: predecessorHash,
          bytes: inherited.byteLength,
          sourceJobId: nodes[index - 1].jobId,
          objectHash: predecessorHash,
        },
      ]);
    }
    reports.push({ role: node.role, jobId: job.id, assignmentId: node.assignmentId, binding, output, report });
    predecessorHash = output.sha256;
  }
  // Replay must not create a fourth session or dispatch a completed assignment again.
  const before = JSON.stringify(nodes.map(n => store.localSessionForJob(n.jobId)));
  await controller.reconcileLocalChain();
  assert.equal(JSON.stringify(nodes.map(n => store.localSessionForJob(n.jobId))), before);
  assert.equal(launches.length, 3, 'Replay must not spawn another process');
  assert.deepEqual(errors, []);
  writeFileSync(
    path.join(root, 'acceptance.json'),
    JSON.stringify(
      {
        status: 'PASS',
        route: 'LOCAL_CLI_EXEC',
        provider: 'claude',
        manualStarts: 1,
        automaticDependents: 2,
        launches,
        reports,
        errors,
      },
      null,
      2,
    ),
  );
  passed = true;
  console.log('PASS three real agents, two automatic verified artifact relays, replay non-duplication');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ error: String(error), errors }, null, 2));
} finally {
  if (!passed)
    for (const node of nodes) {
      const job = store.snapshot({ history: false }).jobs!.find(j => j.id === node.jobId);
      if (job && !['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED', 'INTENT'].includes(job.state)) {
        try {
          await controller.cancel(node.assignmentId);
        } catch (e) {
          console.error('CLEANUP', String(e));
        }
      }
    }
  await Promise.all(callbacks);
  writeFileSync(path.join(root, 'state.json'), JSON.stringify(store.snapshot(), null, 2));
  exec.disposeAll();
  subscriptions.close();
  store.close();
}
