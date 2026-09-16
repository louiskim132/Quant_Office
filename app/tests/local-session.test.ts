import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeTreeSync } from '../src/main/fsx';
import { buildProviderPayload, type SubmitContext } from '../src/main/controller';
import { CANCEL_FILE, INPUTS_DIR, LocalMailboxAdapter, PACKET_FILE, RESULT_FILE } from '../src/main/local-session';
import type { Assignment, InputSnapshot, ProviderJob } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, 0) + minutes * 60000).toISOString();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-local-session-'));
  t.after(() => removeTreeSync(root));
  // A staged snapshot tree whose declared hashes match the bytes on disk.
  const staging = path.join(root, 'staging');
  mkdirSync(path.join(staging, 'data'), { recursive: true });
  writeFileSync(path.join(staging, 'data', 'input.csv'), 'a,b\n1,2\n');
  writeFileSync(path.join(staging, 'notes.txt'), 'fixture notes');
  const snapshot: InputSnapshot = {
    id: randomUUID(), projectId: randomUUID(), requestId: randomUUID(), locationRevision: 0, requestRevision: 1,
    route: 'SELECTED_FILES_GIT_SNAPSHOT',
    files: [
      { path: 'data/input.csv', bytes: Buffer.byteLength('a,b\n1,2\n'), sha256: sha('a,b\n1,2\n') },
      { path: 'notes.txt', bytes: Buffer.byteLength('fixture notes'), sha256: sha('fixture notes') },
    ],
    totalBytes: Buffer.byteLength('a,b\n1,2\n') + Buffer.byteLength('fixture notes'),
    manifestHash: sha('manifest'), stagingCommit: 'fixture-commit', stagingPath: staging,
    warnings: [], provenance: 'OFFICE_STAGED', createdAt: at(0),
  };
  const sessions = path.join(root, 'sessions');
  const adapter = new LocalMailboxAdapter(() => sessions, () => at(1));
  const assignment: Assignment = {
    id: randomUUID(), projectId: snapshot.projectId, requestId: snapshot.requestId!, requestRevision: 1,
    agentId: randomUUID(), agentRevision: 0, connectionId: randomUUID(), capabilitySnapshotId: randomUUID(),
    snapshotId: snapshot.id, route: 'LOCAL_MAILBOX', requestedModel: 'devin-local', resolvedModel: '',
    requestedEffort: 'default', appliedEffort: 'UNVERIFIED', delegation: false, objectiveHash: sha('objective'),
    createdAt: at(0),
  };
  const context: SubmitContext = {
    assignment, snapshot, objective: 'Summarize the fixture input.', requestName: 'Tiny local task',
    payload: buildProviderPayload({ requestName: 'Tiny local task', objective: 'Summarize the fixture input.', acceptanceCriteria: 'A summary file.', instructions: '', model: 'devin-local', effort: 'default', delegation: false }),
  };
  const job = (externalId: string): ProviderJob => ({
    id: randomUUID(), assignmentId: assignment.id, projectId: assignment.projectId, requestId: assignment.requestId,
    provider: 'devin', route: 'LOCAL_MAILBOX', state: 'ACCEPTED', evidence: 'PROVIDER_REPORTED', detail: '',
    externalId, externalUrl: '', outputs: [], revision: 0, createdAt: at(0), updatedAt: at(0), dispatchedAt: at(0), settledAt: '',
  });
  return { root, staging, sessions, snapshot, adapter, assignment, context, job };
}

/** Simulates the user-launched session: write the declared output bytes, then the result receipt. */
function report(dir: string, result: { state: string; detail: string; outputs: { path: string; sha256: string; bytes: number }[] }, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify(result));
}

test('the adapter declares the LOCAL_MAILBOX route and carries devin work', async t => {
  const f = fixture(t);
  assert.equal(f.adapter.route, 'LOCAL_MAILBOX');
  assert.ok(f.adapter.providers!.includes('devin'));
});

test('submit writes a hash-manifested packet under the sessions root', async t => {
  const f = fixture(t);
  const result = await f.adapter.submit(f.context);
  assert.match(result.externalId, /^session-/);
  const dir = path.join(f.sessions, result.externalId);
  const packet = JSON.parse(readFileSync(path.join(dir, PACKET_FILE), 'utf8'));
  assert.equal(packet.assignmentId, f.assignment.id);
  assert.equal(packet.requestName, 'Tiny local task');
  assert.equal(packet.objective, 'Summarize the fixture input.');
  assert.equal(packet.model, 'devin-local');
  assert.equal(packet.effort, 'default');
  assert.equal(packet.payload, f.context.payload.text);
  // Every declared input landed under inputs/ with a manifest hash that matches the bytes written.
  assert.equal(packet.files.length, 2);
  for (const file of packet.files) {
    const bytes = readFileSync(path.join(dir, file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(bytes.byteLength, file.bytes);
    assert.equal(readFileSync(path.join(f.staging, file.path.slice(INPUTS_DIR.length + 1)), 'utf8'), bytes.toString('utf8'));
  }
  assert.match(result.detail, /awaits a local session/);
});

test('submit fails loudly when a staged input no longer matches its frozen hash', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.staging, 'notes.txt'), 'changed after freezing');
  await assert.rejects(f.adapter.submit(f.context), /no longer matches the bytes that were frozen/);
});

test('observe without a result reports UNKNOWN with OFFICE_LOCAL provenance', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(result.provenance, 'OFFICE_LOCAL');
  assert.equal(result.outputs, undefined, 'silence reports no outputs');
});

test('observe reports UNKNOWN for a missing or invalid session directory', async t => {
  const f = fixture(t);
  for (const externalId of ['', 'not-created', '../escape', 'a/b']) {
    const result = await f.adapter.observe(f.job(externalId));
    assert.equal(result.state, 'UNKNOWN');
    assert.equal(result.provenance, 'OFFICE_LOCAL');
  }
});

test('a well-formed result with matching artifact bytes surfaces the declared outputs', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  const output = { path: 'out/summary.json', sha256: sha('{"summary":"done"}'), bytes: Buffer.byteLength('{"summary":"done"}') };
  report(dir, { state: 'COMPLETED', detail: 'The local session finished.', outputs: [output] }, { 'out/summary.json': '{"summary":"done"}' });
  const result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.detail, 'The local session finished.');
  assert.deepEqual(result.outputs, [output]);
});

test('a tampered declared artifact never becomes a reported output', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  const forged = { path: 'out/summary.json', sha256: sha('{"summary":"done"}'), bytes: Buffer.byteLength('{"summary":"altered"}') };
  report(dir, { state: 'COMPLETED', detail: 'Claimed.', outputs: [forged] }, { 'out/summary.json': '{"summary":"altered"}' });
  const result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(result.provenance, 'OFFICE_LOCAL');
  assert.equal(result.outputs, undefined);
  assert.match(result.detail, /hashes to/);
});

test('a declared output missing from the session directory is a defect, not a completion', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  report(dir, { state: 'COMPLETED', detail: 'Claimed.', outputs: [{ path: 'out/ghost.json', sha256: sha('x'), bytes: 1 }] }, {});
  const result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(result.provenance, 'OFFICE_LOCAL');
  assert.match(result.detail, /does not contain that file/);
});

test('malformed and mis-shaped results report UNKNOWN naming the defect', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  writeFileSync(path.join(dir, RESULT_FILE), 'not json {');
  let result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.match(result.detail, /not valid JSON/);
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ state: 'COMPLETED', detail: 'No inventory.', outputs: [{ path: 'x', sha256: sha('x'), bytes: 1 }], extra: true }));
  result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.match(result.detail, /exactly state, detail and outputs/);
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ state: 'SUCCEEDED', detail: 'Invented state.', outputs: [] }));
  result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.match(result.detail, /not one of/);
});

test('an unsafe declared output path is refused before it is ever read', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ state: 'COMPLETED', detail: 'Traversal.', outputs: [{ path: '../packet.json', sha256: sha('x'), bytes: 1 }] }));
  const result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(result.provenance, 'OFFICE_LOCAL');
  assert.match(result.detail, /unsafe/);
});

test('cancel writes the sentinel and honestly acknowledges a local end', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  const result = await f.adapter.cancel(f.job(externalId));
  assert.equal(result.acknowledged, true);
  assert.match(result.detail, /Local session ended by the office/);
  assert.match(result.detail, /not a provider acknowledgement/);
  const sentinel = JSON.parse(readFileSync(path.join(dir, CANCEL_FILE), 'utf8'));
  assert.equal(typeof sentinel.requestedAt, 'string');
});

test('cancel without a session directory cannot acknowledge anything', async t => {
  const f = fixture(t);
  const result = await f.adapter.cancel(f.job('not-created'));
  assert.equal(result.acknowledged, false);
  assert.equal(existsSync(path.join(f.sessions, 'not-created', CANCEL_FILE)), false);
});
