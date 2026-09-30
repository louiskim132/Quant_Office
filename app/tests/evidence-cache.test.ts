import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { strToU8 } from 'fflate';
import { OfficeStore } from '../src/core/store.js';
import { EvidenceService } from '../src/main/evidence.js';
import type { Agent, GateReceipt } from '../src/shared/types.js';

const key = () => randomUUID();
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * Two profiles in two projects, so a cache hit and a permission check can be told apart.
 *
 * The interesting failure is not a stale answer; it is a correct answer delivered to the wrong reader
 * because the cache replied before anyone asked whether they were allowed to see it.
 */
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-evidence-cache-'));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    removeTreeSync(root);
  });

  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  const agent = (name: string): Agent => {
    const value: Agent = {
      id: randomUUID(),
      name,
      provider: 'claude',
      model: 'opus',
      team: 'Research',
      role: 'WORKER',
      instructions: '',
      account: 'researcher@example.com',
      createdAt: new Date().toISOString(),
      connectionVerifiedAt: new Date().toISOString(),
      execution: 'HOSTED_SETUP_REQUIRED',
    };
    store.addAgent(value);
    return value;
  };
  const author = agent('Author'),
    outsider = agent('Outsider');
  const request = store.execute({
    type: 'request.create',
    idempotencyKey: key(),
    projectId: project.id,
    name: 'Audit',
    hypothesis: 'Check',
    workType: 'ANALYSIS',
    mode: 'GROUP',
    leadAgentId: author.id,
    participantIds: [outsider.id],
  }).requests![0];
  store.execute({
    type: 'request.grant',
    idempotencyKey: key(),
    requestId: request.id,
    agentId: author.id,
    capacity: 'WORKER',
    granted: true,
  });

  const write = (body: string) => {
    const data = strToU8(body),
      hash = sha256(data);
    const file = path.join(workspace, 'objects', hash.slice(0, 2), hash);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return { hash, bytes: data.length };
  };
  const artifact = (name: string, body: string) => {
    const object = write(body);
    store.addArtifact({
      id: randomUUID(),
      projectId: project.id,
      experimentId: null,
      name,
      sha256: object.hash,
      size: object.bytes,
      kind: 'RESULT',
      classification: 'USER_ATTESTED',
      status: 'QUARANTINED',
      createdAt: new Date().toISOString(),
      mediaType: 'text/plain',
      note: 'fixture',
    });
    return object;
  };
  return { root, workspace, store, project, author, outsider, request, artifact };
}

test('a repeated query is reused, and the reuse is recorded rather than disguised as a fresh look', async t => {
  const f = fixture(t);
  const object = f.artifact('run.log', 'row 0 fitted\nrow 1 scored\n');
  const evidence = new EvidenceService(f.store, f.workspace);

  const first = await evidence.read({ agentId: f.author.id, objectHash: object.hash });
  const second = await evidence.read({ agentId: f.author.id, objectHash: object.hash });
  assert.deepEqual(second.lines, first.lines);
  assert.notEqual(second.receiptId, first.receiptId, 'a reuse still costs its own receipt');

  const receipts = evidence.allReceipts();
  assert.equal(receipts.find(r => r.id === first.receiptId)!.reusedFromReceiptId, null);
  assert.equal(receipts.find(r => r.id === second.receiptId)!.reusedFromReceiptId, first.receiptId);
  assert.equal(receipts.find(r => r.id === second.receiptId)!.coverage, 'COMPLETE');

  // Receipts live in the workspace's own event log, so what an agent was shown survives a restart:
  // a reopened service replays the recorded envelopes rather than re-deriving them.
  const records = f.store.evidenceRecords().filter(record => record.kind === 'RECEIPT');
  assert.equal(records.length, 2);
  assert.equal(records[1].kind === 'RECEIPT' && records[1].value.reusedFromReceiptId, first.receiptId);
  const reopened = new EvidenceService(f.store, f.workspace);
  assert.equal(reopened.allReceipts().length, 2, 'a restart replays the durable evidence log');
  assert.equal(reopened.allReceipts()[1].reusedFromReceiptId, first.receiptId);
});

test('a changed dependency invalidates the answer instead of reusing an interpretation of bytes that are gone', async t => {
  const f = fixture(t);
  f.artifact('run.log', 'row 0 clean\n');
  const evidence = new EvidenceService(f.store, f.workspace);
  const before = await evidence.query({ agentId: f.author.id, projectId: f.project.id, pattern: 'LOOK_AHEAD' });
  assert.equal(before.matches.length, 0);

  // Same filenames, different bytes. A key built from names or from the question's wording would
  // reuse the clean answer here, which is exactly the reuse this slice forbids.
  f.artifact('run.log', 'row 0 LOOK_AHEAD\n');
  const after = await evidence.query({ agentId: f.author.id, projectId: f.project.id, pattern: 'LOOK_AHEAD' });
  assert.equal(after.matches.length, 1);
  assert.equal(evidence.allReceipts().find(r => r.id === after.receiptId)!.reusedFromReceiptId, null);

  // A repeat with nothing changed is a reuse, which is what makes the next case meaningful.
  const repeat = await evidence.query({ agentId: f.author.id, projectId: f.project.id, pattern: 'LOOK_AHEAD' });
  assert.equal(evidence.allReceipts().find(r => r.id === repeat.receiptId)!.reusedFromReceiptId, after.receiptId);
});

test('a changed gate or review state invalidates an interpretation formed before it', async t => {
  const f = fixture(t);
  const object = f.artifact('run.log', 'row 0 LOOK_AHEAD\n');
  // Gate receipts have no renderer-facing writer by design, so the state they live in is supplied
  // directly here. What is under test is that the answer's identity depends on them at all.
  const injected: GateReceipt[] = [];
  // A receipt only enters an answer's identity through a branch that exists in the object's project,
  // so the injected gate needs a real branch row behind it — an orphaned receipt proves nothing.
  const injectedBranch = {
    id: randomUUID(),
    projectId: f.project.id,
    name: 'Injected',
    parentBranchId: null,
    lineageId: randomUUID(),
    stage: 'S2' as const,
    outcome: 'IN_PROGRESS' as const,
    specId: null,
    predictionId: null,
    revision: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const store = new Proxy(f.store, {
    get: (target, property, receiver) =>
      property === 'snapshot'
        ? () => ({ ...target.snapshot(), branches: [injectedBranch], receipts: [...injected] })
        : Reflect.get(target, property, receiver),
  }) as OfficeStore;
  const evidence = new EvidenceService(store, f.workspace);

  const first = await evidence.query({ agentId: f.author.id, projectId: f.project.id, pattern: 'LOOK_AHEAD' });
  assert.equal(first.matches.length, 1);
  const reused = await evidence.query({ agentId: f.author.id, projectId: f.project.id, pattern: 'LOOK_AHEAD' });
  assert.equal(evidence.allReceipts().find(r => r.id === reused.receiptId)!.reusedFromReceiptId, first.receiptId);

  injected.push({
    id: randomUUID(),
    branchId: injectedBranch.id,
    stage: 'S2',
    gate: 'G-CORRECT',
    outcome: 'FAIL',
    subjectHash: sha256(object.hash),
    specId: randomUUID(),
    detail: 'Look-ahead reference on row 0.',
    rationale: 'The log records a look-ahead reference.',
    evidenceRef: object.hash,
    createdAt: new Date().toISOString(),
  });
  const afterGate = await evidence.query({ agentId: f.author.id, projectId: f.project.id, pattern: 'LOOK_AHEAD' });
  assert.equal(
    evidence.allReceipts().find(r => r.id === afterGate.receiptId)!.reusedFromReceiptId,
    null,
    'a changed gate state must not reuse an interpretation formed before it',
  );
});

test('a cache hit never answers before the grant is checked', async t => {
  const f = fixture(t);
  const object = f.artifact('run.log', 'row 0 confidential\n');
  const evidence = new EvidenceService(f.store, f.workspace);

  // The author warms the cache for this exact object and range.
  const warmed = await evidence.read({ agentId: f.author.id, objectHash: object.hash });
  assert.deepEqual(warmed.lines, ['row 0 confidential']);

  // The ungranted profile asks for the identical thing. The stored answer must not be what decides.
  await assert.rejects(
    evidence.read({ agentId: f.outsider.id, objectHash: object.hash }),
    /not available to this agent/,
  );
  await assert.rejects(
    evidence.describe({ agentId: f.outsider.id, objectHash: object.hash }),
    /not available to this agent/,
  );
  await assert.rejects(
    evidence.query({ agentId: f.outsider.id, projectId: f.project.id, pattern: 'confidential' }),
    /No stored object in this project is available to this agent/,
  );
  assert.equal(
    evidence.receiptsFor(f.outsider.id).length,
    0,
    'a refused request leaves no receipt claiming it was served',
  );

  // Revoking the author's own grant closes the warmed entry to them too.
  f.store.execute({
    type: 'request.grant',
    idempotencyKey: key(),
    requestId: f.request.id,
    agentId: f.author.id,
    capacity: 'WORKER',
    granted: false,
  });
  await assert.rejects(evidence.read({ agentId: f.author.id, objectHash: object.hash }), /not available to this agent/);
});

test('an answer cannot be keyed to no stored object at all', async t => {
  const f = fixture(t);
  const evidence = new EvidenceService(f.store, f.workspace);
  // With nothing stored there is no dependency to key on, and the layer refuses rather than caching
  // an answer whose only identity would be the question that produced it.
  await assert.rejects(
    evidence.query({ agentId: f.author.id, projectId: f.project.id, pattern: 'anything' }),
    /No stored object in this project is available to this agent/,
  );
  assert.equal(evidence.allReceipts().length, 0);
});
