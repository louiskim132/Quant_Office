/** Explicit live local subscription acceptance. No cloud session and no API key. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { AssignmentController } from '../src/main/controller';
import { LocalAcpAdapter } from '../src/main/local-acp';
import { LocalSessionRouter } from '../src/main/local-session-router';
import { OutputService } from '../src/main/outputs';
import { prepareInputSnapshot, verifySnapshotForTransfer } from '../src/main/locations';
import { Subscriptions } from '../src/main/subscriptions';
import { spawnTreeKillable } from '../src/main/local-cli-exec';
import { AcpClient } from '../src/main/acp-client';
import { subscriptionEnvironment } from '../src/main/subscriptions';
import type { Agent, Role } from '../src/shared/types';

if (process.env.QRO_LIVE_ACP !== '1')
  throw new Error('Set QRO_LIVE_ACP=1 for explicitly authorized local subscription acceptance.');
const root = path.resolve(process.argv[2]);
mkdirSync(root, { recursive: true });
const file = path.join(root, 'workspace.sqlite');
let store = new OfficeStore(file);
const subs = new Subscriptions(path.join(root, 'tools'), async () => {
  throw new Error('Official sign-in must already exist.');
});
let outputs = new OutputService(store, root);
const key = () => randomUUID(),
  now = () => new Date().toISOString();
const launches: { pid?: number; cwd: string; args: string[] }[] = [];
const exits: Promise<void>[] = [];
const adapter = new LocalAcpAdapter({
  sessionsRoot: () => path.join(root, 'sessions'),
  executable: p => subs.toolPath(p),
  environment: () => subscriptionEnvironment(),
  providerFor: id => store.snapshot({ history: false }).agents.find(a => a.id === id)?.provider,
  spawnChild: (executable, args, options) => {
    const child = spawnTreeKillable(executable, args, options);
    exits.push(new Promise(resolve => child.on('exit', () => resolve())));
    let retained = 0;
    child.stdout?.on('data', chunk => {
      const bytes = Buffer.from(chunk);
      if (retained + bytes.length <= 1024 * 1024) {
        appendFileSync(path.join(root, 'raw-stdout.jsonl'), bytes);
        retained += bytes.length;
      }
    });
    launches.push({ pid: child.pid, cwd: options.cwd, args });
    return child;
  },
});
const router = new LocalSessionRouter(
  id => store.localSessionForJob(id),
  { FLAT_PACKET: adapter, PROJECT_WORKTREE: adapter },
  'LOCAL_ACP',
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
let controller = makeController();
try {
  const observed = await subs.observe('devin');
  assert.ok(observed.connection.connected && observed.connection.account);
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'ACP synthetic software acceptance',
    mandate: 'No research.',
    budgetCents: 0,
  }).projects[0];
  const source = path.join(root, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    path.join(source, 'brief.txt'),
    'Return a small JSON answer with rows=100 and provenance=LOCAL_SIMULATION. This is an invented software fixture.',
  );
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
  for (const [name, role] of [
    ['Test dir 1', 'DIRECTOR'],
    ['Test PM A', 'PM_A'],
    ['Test PM B', 'PM_B'],
    ['Test PM C', 'PM_C'],
    ['Test PM D', 'PM_D'],
    ['Test worker 1', 'WORKER'],
  ] as const) {
    const agent: Agent = {
      id: key(),
      name,
      role: role as Role,
      provider: 'devin',
      team: 'Acceptance',
      model: 'swe-2-max',
      effort: 'default',
      account: observed.connection.account!,
      execution: 'LOCAL',
      localRoute: 'LOCAL_ACP',
      createdAt: now(),
      connectionVerifiedAt: observed.connection.checkedAt,
      instructions:
        'Synthetic software acceptance. Be brief. Read packet.json and CONTRACT.md. Read brief.txt, produce every declared output, and finish via finish.py with correct hash and byte count. No delegation, external networking, unrelated files or research.',
    };
    store.confirmAgentBinding({ observation: observed.observation, agent });
    roster.push(agent);
  }
  const agent = roster.at(-1)!;
  const request = store
    .execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: project.id,
      name: 'ACP bound output',
      hypothesis: 'Read the fixture brief and return its small JSON answer with a valid bound receipt.',
      workType: 'QUESTION',
      mode: 'SINGLE',
      leadAgentId: agent.id,
      participantIds: [],
    })
    .requests!.at(-1)!;
  const snapshot = await prepareInputSnapshot({
    store,
    objectRoot: root,
    stagingRoot: path.join(root, 'snapshots'),
    projectId: project.id,
    requestId: request.id,
    requestRevision: request.revision,
  });
  const { assignment } = controller.prepare({ requestId: request.id, agentId: agent.id, snapshotId: snapshot.id });
  await controller.handoff(assignment.id);
  const end = Date.now() + 8 * 60_000;
  let job = store.snapshot({ history: false }).jobs!.at(-1)!;
  while (Date.now() < end) {
    await controller.observe(assignment.id);
    job = store.snapshot({ history: false }).jobs!.at(-1)!;
    if (job.state === 'COMPLETED') break;
    if (job.state === 'FAILED') throw new Error(job.lastObservation ?? 'Provider failed');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(job.state, 'COMPLETED');
  const binding = store.localSessionForJob(job.id)!;
  assert.equal(binding.groupingStatus, 'OBSERVED');
  assert.ok(binding.providerSessionId);
  assert.ok(store.jobEventPage(job.id).entries.some(event => event.kind === 'TOOL'));
  await Promise.race([
    exits.at(-1),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The receipt completed, but the ACP process did not exit within 30s.')),
        30_000,
      );
      timer.unref();
    }),
  ]);
  const state = JSON.parse(
    readFileSync(path.join(root, 'sessions', binding.storageRelativePath, 'office-acp-session.json'), 'utf8'),
  );
  // Cancel another turn on the same provider identity, then load it without re-prompting.
  const client = new AcpClient(
    spawnTreeKillable,
    subs.toolPath('devin'),
    ['acp', '--model', 'swe-2-max'],
    {
      cwd: path.join(root, 'sessions', binding.storageRelativePath),
      env: subscriptionEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
    () => {},
  );
  let cancelled: unknown;
  try {
    await client.initialize();
    await client.load(binding.providerSessionId!);
    const prompt = client.prompt(
      'Synthetic cancellation check only: wait for cancellation. Do not touch any files or run any tool.',
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    client.cancel();
    cancelled = await prompt;
    assert.equal((cancelled as any).stopReason, 'cancelled');
  } finally {
    client.stop();
  }
  const launchCount = launches.length;
  adapter.disposeAll();
  store.close();
  store = new OfficeStore(file);
  outputs = new OutputService(store, root);
  controller = makeController();
  await controller.reconcileLocalChain();
  assert.equal(launches.length, launchCount);
  writeFileSync(
    path.join(root, 'acceptance.json'),
    JSON.stringify(
      {
        status: 'PASS',
        route: 'LOCAL_ACP',
        authMode: 'subscription',
        provenance: 'OFFICE_LOCAL',
        toolVersion: observed.observation.toolVersion,
        roster: roster.map(({ name, model, effort }) => ({ name, model, effort, used: name === agent.name })),
        job,
        binding,
        state,
        cancellation: cancelled,
        launches,
        restartNoRedispatch: true,
      },
      null,
      2,
    ),
  );
  console.log('PASS ACP', root);
} catch (error) {
  writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ error: String(error), launches }, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const job of store.snapshot({ history: false }).jobs ?? [])
    if (!['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED'].includes(job.state)) {
      try {
        await controller.cancel(job.assignmentId);
      } catch {}
    }
  adapter.disposeAll();
  subs.close();
  store.close();
}
