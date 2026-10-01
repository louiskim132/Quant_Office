/** Continue acceptance from an already completed scratch job; never dispatch another office job. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { Subscriptions, subscriptionEnvironment } from '../src/main/subscriptions';
import { AcpClient } from '../src/main/acp-client';
import { spawnTreeKillable } from '../src/main/local-cli-exec';
import { GuardedLocalFileIO } from '../src/main/local-session-files';
import { AssignmentController } from '../src/main/controller';
import { LocalAcpAdapter } from '../src/main/local-acp';
import { LocalSessionRouter } from '../src/main/local-session-router';
if (process.env.QRO_LIVE_ACP !== '1') throw new Error('QRO_LIVE_ACP=1 is required.');
const root = path.resolve(process.argv[2]),
  db = path.join(root, 'workspace.sqlite');
const store = new OfficeStore(db),
  subs = new Subscriptions(path.join(root, 'tools'), async () => {
    throw new Error('No browser');
  });
let client: AcpClient | undefined;
try {
  const snapshot = store.snapshot({ history: false }),
    job = snapshot.jobs!.at(-1)!;
  assert.equal(job.state, 'COMPLETED');
  const binding = store.localSessionForJob(job.id)!;
  assert.equal(binding.groupingStatus, 'OBSERVED');
  assert.ok(binding.providerSessionId);
  const cwd = path.join(root, 'sessions', binding.storageRelativePath);
  const receipt = JSON.parse(readFileSync(path.join(cwd, 'result.json'), 'utf8'));
  for (const output of receipt.outputs) {
    const read = new GuardedLocalFileIO().read(cwd, output.path, 1024 * 1024);
    assert.equal(read.sha256, output.sha256);
    assert.equal(read.byteLength, output.bytes);
  }
  assert.ok(store.jobEventPage(job.id).entries.some(event => event.kind === 'TOOL'));
  const observed = await subs.observe('devin');
  const frozen = snapshot.assignments!.find(a => a.id === job.assignmentId)!.frozen!;
  assert.equal(observed.observation.identity, frozen.accountIdentity);
  let ownerExit: Promise<void> | undefined;
  client = new AcpClient(
    (executable, args, options) => {
      const child = spawnTreeKillable(executable, args, options);
      ownerExit = new Promise(resolve => child.on('exit', () => resolve()));
      return child;
    },
    subs.toolPath('devin'),
    ['acp', '--model', 'swe-2-max'],
    { cwd, env: subscriptionEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    () => {},
  );
  await client.initialize();
  await client.load(binding.providerSessionId!);
  const prompt = client.prompt(
    'Synthetic cancellation check. Wait for cancellation. Do not touch files, delegate or use any tool.',
  );
  const cancelTimer = setTimeout(() => client!.cancel(), 250);
  const hardTimer = setTimeout(() => client!.stop(), 30_000);
  let cancellation;
  try {
    cancellation = await prompt;
  } finally {
    clearTimeout(cancelTimer);
    clearTimeout(hardTimer);
  }
  assert.equal(cancellation.stopReason, 'cancelled');
  client.stop();
  await ownerExit;
  let launches = 0;
  const adapter = new LocalAcpAdapter({
    sessionsRoot: () => path.join(root, 'sessions'),
    spawnChild: () => {
      launches++;
      throw new Error('Restart must not dispatch');
    },
  });
  const route = new LocalSessionRouter(
    id => store.localSessionForJob(id),
    { FLAT_PACKET: adapter, PROJECT_WORKTREE: adapter },
    'LOCAL_ACP',
  );
  const controller = new AssignmentController(
    store,
    route,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => route,
  );
  await controller.reconcileLocalChain();
  assert.equal(launches, 0);
  writeFileSync(
    path.join(root, 'acceptance-reconciled.json'),
    JSON.stringify(
      {
        status: 'PASS',
        route: 'LOCAL_ACP',
        scope: 'SELF_ACCOUNT_SUBSCRIPTION',
        job,
        binding,
        receipt,
        cancellation,
        outputHashesVerified: true,
        toolEventsVerified: true,
        sessionLoadVerified: true,
        restartNoRedispatch: true,
        initialHarnessFailure: 'Immediate session/load raced the prior ACP process exit; no job was resubmitted.',
        realQroAgentAcceptance: 'NOT_RUN',
      },
      null,
      2,
    ),
  );
  console.log('PASS reconciled ACP acceptance');
} finally {
  client?.stop();
  subs.close();
  store.close();
}
