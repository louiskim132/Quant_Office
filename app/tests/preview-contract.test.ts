import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { AssignmentController, type ProviderAdapter } from '../src/main/controller';
import { removeTreeSync } from '../src/main/fsx';
import { prepareInputSnapshot, snapshotObjectPath } from '../src/main/locations';
import { OutputService } from '../src/main/outputs';
import type { Agent, CapabilityOperation, JobOutput, OfficeAPI, ProviderJob } from '../src/shared/types';

// The office:job-output-preview handler (src/main/main.ts) runs behind ipcMain.handle inside the
// Electron entry — the node:test harness cannot reach the IPC boundary without booting Electron;
// only the .desktop.ts suites do. Per this round's packet, this file pins the two seams the
// handler is built from instead:
//   1. The declared contract on OfficeAPI: the response type must keep `verified: true` — the
//      renderer branches on that literal; dropping or widening it fails `npx tsc --noEmit`.
//   2. The store/object-store boundary the handler reads through: `stored` marks bytes the
//      office fetched, hash-checked and durably holds (controller.ts:1108 is the only writer), a
//      reported output without it has nothing behind it, and OutputService.readBytes performs the
//      same content-addressed re-hash the handler runs before returning preview text.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type PreviewResult = Awaited<ReturnType<OfficeAPI['jobOutputPreview']>>;

const contractPins: [
  Assert<Equal<PreviewResult['verified'], true>>,
  Assert<Equal<Parameters<OfficeAPI['jobOutputPreview']>[0], { jobId: string; path: string }>>,
  Assert<Equal<JobOutput['stored'], true | undefined>>,
] = [true, true, true];

const key = () => randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 19, 10, 0, 0) + minutes * 60000).toISOString();
const clock = () => at(5);
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** The local dispatch family the prepare-time readiness gate reads — office-observed, never
 *  provider attestation, mirroring the local-chain fixture's account contract. */
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
const localObservation = (minutes: number) => ({
  provider: 'claude' as const,
  identity: 'researcher@example.com',
  credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const,
  allowance: [],
  note: '',
  toolVersion: '2.1.236',
  transport: 'LOCAL_CLI_EXEC' as const,
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
      route: 'LOCAL_CLI_EXEC' as const,
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

/** An adapter that records the route but never dispatches — preparation is the whole fixture. */
class NoDispatchAdapter implements ProviderAdapter {
  readonly route = 'LOCAL_CLI_EXEC' as const;
  readonly providers = ['claude' as const];
  async submit(): Promise<never> {
    throw new Error('This fixture never dispatches.');
  }
  async observe(): Promise<never> {
    throw new Error('This fixture never observes.');
  }
  async cancel() {
    return { acknowledged: false, detail: 'This fixture never cancels.' };
  }
}

async function fixture(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-preview-contract-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => {
    try {
      store.close();
    } catch {}
    removeTreeSync(root);
  });
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
  const agent: Agent = {
    id: randomUUID(),
    name: 'Local worker',
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
    localRoute: 'LOCAL_CLI_EXEC',
  };
  store.confirmAgentBinding({ observation: localObservation(0), agent });
  const outputs = new OutputService(store, root);
  const controller = new AssignmentController(store, new NoDispatchAdapter(), clock);
  return { root, store, project, agent, outputs, controller };
}

/** Prepares a real assignment + INTENT job through the store's own validation path. */
async function preparedJob(f: Awaited<ReturnType<typeof fixture>>) {
  const name = `Report ${key().slice(0, 8)}`;
  const request = f.store
    .execute({
      type: 'request.create',
      idempotencyKey: key(),
      projectId: f.project.id,
      name,
      hypothesis: 'h',
      workType: 'ANALYSIS',
      mode: 'SINGLE',
      leadAgentId: f.agent.id,
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
  const { assignment } = f.controller.prepare({ requestId: request.id, agentId: f.agent.id, snapshotId: snapshot.id });
  const job = f.store.snapshot({ history: false }).jobs!.find(item => item.assignmentId === assignment.id)!;
  return { request, assignment, job };
}

test('the declared preview contract keeps the literal verified flag', () => {
  assert.deepEqual(contractPins, [true, true, true]);
  const result: PreviewResult = {
    path: 'report.md',
    sha256: sha('report'),
    bytes: 6,
    text: 'report',
    truncated: false,
    verified: true,
  };
  assert.equal(
    result.verified,
    true,
    'verified means the office re-hashed the stored object — never that its contents are correct',
  );
});

test('a reported-but-unstored output records honestly and has no previewable bytes', async t => {
  const f = await fixture(t);
  const { job } = await preparedJob(f);
  // The legal transition path a hosted report would take: the declared output metadata lands on
  // the record WITHOUT `stored`, which is set only where the office fetched and hash-checked the
  // bytes itself. The handler's stored-only refusal reads exactly this flag.
  f.store.recordJobTransition({
    jobId: job.id,
    expectedRevision: job.revision,
    to: 'SUBMITTING',
    evidence: 'OFFICE_LOCAL',
    detail: 'Submitting.',
  });
  f.store.recordJobTransition({
    jobId: job.id,
    expectedRevision: 1,
    to: 'ACCEPTED',
    evidence: 'PROVIDER_REPORTED',
    detail: 'Accepted.',
    externalId: 'ext-1',
  });
  const claimed = {
    path: 'outputs/report.md',
    sha256: sha('provider claimed these bytes'),
    bytes: Buffer.byteLength('provider claimed these bytes'),
  };
  f.store.recordJobTransition({
    jobId: job.id,
    expectedRevision: 2,
    to: 'COMPLETED',
    evidence: 'PROVIDER_REPORTED',
    detail: 'Done.',
    outputs: [claimed],
  });
  const settled = f.store.snapshot({ history: false }).jobs!.find(item => item.id === job.id)!;
  assert.equal(settled.state, 'COMPLETED');
  assert.deepEqual(
    settled.outputs.map(item => item.path),
    ['outputs/report.md'],
  );
  assert.equal(
    settled.outputs[0].stored,
    undefined,
    'a reported output carries no stored flag — the office never verified its bytes',
  );
  await assert.rejects(
    () => f.outputs.readBytes(claimed.sha256),
    { code: 'ENOENT' },
    'the object store holds nothing for it — nothing to preview',
  );
});

test('stored object bytes read back only after rehashing to their recorded identity', async t => {
  const { root, outputs } = await fixture(t);
  const bytes = Buffer.from('verified report bytes');
  const target = snapshotObjectPath(root, sha(bytes));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  const read = await outputs.readBytes(sha(bytes));
  assert.deepEqual(Buffer.from(read), bytes, 'the office serves exactly the bytes it stored');
});

test('a corrupted stored object fails integrity verification — the preview hash check', async t => {
  const { root, outputs } = await fixture(t);
  const target = snapshotObjectPath(root, sha('reported bytes'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, 'tampered bytes');
  await assert.rejects(
    () => outputs.readBytes(sha('reported bytes')),
    /integrity verification/,
    'bytes that no longer match their recorded identity are never served',
  );
});

test('a reported object absent from the store refuses loudly', async t => {
  const { outputs } = await fixture(t);
  await assert.rejects(() => outputs.readBytes(sha('never stored')), { code: 'ENOENT' });
});

test('storeBytes refuses bytes that do not match the recorded output identity', async t => {
  const { outputs } = await fixture(t);
  // The identity check fires before the assignment lookup, so a bare job record suffices.
  const job = { id: randomUUID(), assignmentId: randomUUID() } as ProviderJob;
  const bytes = Buffer.from('different bytes');
  await assert.rejects(
    () =>
      outputs.storeBytes(sha('claimed'), bytes, job, {
        path: 'outputs/report.md',
        sha256: sha('claimed'),
        bytes: bytes.byteLength,
      }),
    /byte identity is invalid/,
    'bytes that do not hash to the recorded sha256 never enter the object store',
  );
  await assert.rejects(
    () =>
      outputs.storeBytes(sha('a different name'), bytes, job, {
        path: 'outputs/report.md',
        sha256: sha(bytes),
        bytes: bytes.byteLength,
      }),
    /byte identity is invalid/,
    'the caller cannot rename bytes under a different object identity',
  );
});

test('object addressing refuses anything that is not a sha256 hex digest', () => {
  assert.throws(() => snapshotObjectPath('C:\\tmp\\x', '../etc/passwd'), /SHA-256/);
  assert.throws(() => snapshotObjectPath('C:\\tmp\\x', 'nothex'.repeat(8)), /SHA-256/);
});
