import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeTreeSync } from '../src/main/fsx';
import { buildProviderPayload, type SubmitContext } from '../src/main/controller';
import { AGENTS_FILE, CANCEL_FILE, CONTRACT_FILE, INPUTS_DIR, LocalMailboxAdapter, PACKET_FILE, RESULT_FILE, RESULT_OPTIONAL_KEYS, RESULT_REQUIRED_KEYS, RESULT_STATES } from '../src/main/local-session';
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
function report(dir: string, result: { state: string; detail: string; outputs: { path: string; sha256: string; bytes: number }[]; appliedModel?: string; appliedEffort?: string; delegation?: boolean }, files: Record<string, string>) {
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

test('a zero-input submit writes a valid packet directory with the result contract', async t => {
  const f = fixture(t);
  const context: SubmitContext = { ...f.context, snapshot: { ...f.snapshot, files: [], totalBytes: 0 } };
  const result = await f.adapter.submit(context);
  assert.match(result.externalId, /^session-/);
  const dir = path.join(f.sessions, result.externalId);
  const packet = JSON.parse(readFileSync(path.join(dir, PACKET_FILE), 'utf8'));
  assert.equal(packet.assignmentId, f.assignment.id);
  assert.equal(packet.files.length, 0);
  assert.equal(packet.contract, CONTRACT_FILE);
  const contract = readFileSync(path.join(dir, CONTRACT_FILE), 'utf8');
  assert.match(contract, /result\.json/);
  // The discovery file an agent CLI auto-read points the session at the contract and packet.
  const discovery = readFileSync(path.join(dir, AGENTS_FILE), 'utf8');
  assert.match(discovery, /CONTRACT\.md/);
  assert.match(discovery, /packet\.json/);
  assert.match(discovery, /result\.json/);
});

test('the written contract names exactly the keys and states the strict parser accepts', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  const contract = readFileSync(path.join(dir, CONTRACT_FILE), 'utf8');
  // Both lists come from the parser's own exported constants, so a contract that drifts
  // from what readResult enforces fails here.
  for (const key of [...RESULT_REQUIRED_KEYS, ...RESULT_OPTIONAL_KEYS])
    assert.ok(contract.includes(`\`${key}\``), `contract names ${key}`);
  for (const state of RESULT_STATES) assert.ok(contract.includes(state), `contract names state ${state}`);
  assert.match(contract, new RegExp(CANCEL_FILE.replace('.', '\\.')));
  // A receipt built exactly to that contract is accepted.
  report(dir, { state: 'COMPLETED', detail: 'Done.', outputs: [] }, {});
  const result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.provenance, 'PROVIDER_REPORTED');
});

test('an oversized result receipt is refused, not parsed', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ state: 'COMPLETED', detail: 'x'.repeat(4 * 1024 * 1024), outputs: [] }));
  const result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(result.provenance, 'OFFICE_LOCAL');
  assert.match(result.detail, /receipt limit/);
});

test('a retry after a failed submit re-submits cleanly', async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.staging, 'notes.txt'), 'changed after freezing');
  await assert.rejects(f.adapter.submit(f.context), /no longer matches the bytes that were frozen/);
  // No intent was recorded for the failed attempt; restoring the frozen bytes retries cleanly.
  writeFileSync(path.join(f.staging, 'notes.txt'), 'fixture notes');
  const result = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, result.externalId);
  const packet = JSON.parse(readFileSync(path.join(dir, PACKET_FILE), 'utf8'));
  assert.equal(packet.files.length, 2);
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

test('cancel of a job that never recorded a session acknowledges vacuously', async t => {
  const f = fixture(t);
  // A submit that fails before naming a session directory leaves nothing external running; the
  // office is the local transport, so acknowledging states a local fact rather than a receipt.
  const result = await f.adapter.cancel(f.job(''));
  assert.equal(result.acknowledged, true);
  assert.match(result.detail, /No session was ever recorded/);
});

test('a session self-report of applied model, effort and delegation surfaces through applied', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  const output = { path: 'out/summary.json', sha256: sha('{"summary":"done"}'), bytes: Buffer.byteLength('{"summary":"done"}') };
  report(dir, { state: 'COMPLETED', detail: 'The local session finished.', outputs: [output], appliedModel: 'devin-local-7', appliedEffort: 'high', delegation: false }, { 'out/summary.json': '{"summary":"done"}' });
  const result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'COMPLETED');
  assert.equal(result.provenance, 'PROVIDER_REPORTED');
  const applied = (result as { applied?: { model?: string; effort?: string; delegation?: boolean } }).applied;
  assert.deepEqual(applied, { model: 'devin-local-7', effort: 'high', delegation: false });
});

test('a partial self-report surfaces only what the receipt declared', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  report(dir, { state: 'COMPLETED', detail: 'Done.', outputs: [], delegation: true }, {});
  const result = await f.adapter.observe(f.job(externalId));
  assert.deepEqual((result as { applied?: unknown }).applied, { delegation: true });
  report(dir, { state: 'COMPLETED', detail: 'Done.', outputs: [] }, {});
  const silent = await f.adapter.observe(f.job(externalId));
  assert.equal((silent as { applied?: unknown }).applied, undefined, 'no self-report means no applied record at all');
});

test('a receipt carrying any key outside the contract is still a defect', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ state: 'COMPLETED', detail: 'Claimed.', outputs: [], appliedModel: 'devin-local-7', sneaky: true }));
  const result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(result.provenance, 'OFFICE_LOCAL');
  assert.match(result.detail, /exactly state, detail and outputs/);
});

test('a malformed self-report is a defect, not a value to carry', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  const resultPath = path.join(dir, RESULT_FILE);
  writeFileSync(resultPath, JSON.stringify({ state: 'COMPLETED', detail: 'x', outputs: [], appliedEffort: 'ludicrous' }));
  let result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.match(result.detail, /appliedEffort .*not one of/);
  writeFileSync(resultPath, JSON.stringify({ state: 'COMPLETED', detail: 'x', outputs: [], appliedModel: 42 }));
  result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.match(result.detail, /appliedModel must be a string/);
  writeFileSync(resultPath, JSON.stringify({ state: 'COMPLETED', detail: 'x', outputs: [], delegation: 'no' }));
  result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.match(result.detail, /delegation must be a boolean/);
});

test('submitEvidence records office-observed packet delivery, scoped confinement and no delegation channel', async t => {
  const f = fixture(t);
  const submitted = await f.adapter.submit(f.context);
  const entries = f.adapter.submitEvidence(f.context, submitted);
  assert.deepEqual(entries.map(entry => entry.operation), ['LOCAL_SUBMIT', 'TOOL_CONFINEMENT', 'DELEGATION_CONTROL']);
  for (const entry of entries) {
    assert.equal(entry.level, 'TOOL_SUPPORTED');
    assert.equal(entry.evidence, 'OBSERVED');
    assert.equal(entry.route, 'LOCAL_MAILBOX');
    assert.equal(entry.environment, 'LOCAL_MACHINE');
    assert.equal(entry.source, 'office-local-mailbox@1');
    assert.equal(entry.verifiedAt, at(1));
  }
  assert.match(entries[0].detail, /Office-observed, not provider attestation/);
  const confinement = entries[1].confinement!;
  assert.match(confinement.filesystem, /dedicated session directory/);
  assert.match(confinement.network, /not restricted/);
  assert.equal(entries[2].delegation, false);
  // The packet declares what was requested; nothing about what was applied is claimed at submit.
  assert.ok(entries.every(entry => entry.operation !== 'MODEL_APPLICATION' && entry.operation !== 'EFFORT_APPLICATION'));
  assert.ok(entries.every(entry => entry.model === undefined && entry.effort === undefined));
});

test('observeEvidence records the verified read and only the self-reports the receipt declared', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  const output = { path: 'out/summary.json', sha256: sha('{"summary":"done"}'), bytes: Buffer.byteLength('{"summary":"done"}') };
  report(dir, { state: 'COMPLETED', detail: 'Done.', outputs: [output], appliedModel: 'devin-local-7', appliedEffort: 'high', delegation: false }, { 'out/summary.json': '{"summary":"done"}' });
  const job = f.job(externalId);
  const entries = f.adapter.observeEvidence(job, await f.adapter.observe(job));
  assert.deepEqual(entries.map(entry => entry.operation), ['LOCAL_OBSERVE', 'LOCAL_OUTPUT_FETCH', 'MODEL_APPLICATION', 'EFFORT_APPLICATION', 'DELEGATION_CONTROL']);
  for (const entry of entries) {
    assert.equal(entry.level, 'TOOL_SUPPORTED');
    assert.equal(entry.evidence, 'OBSERVED');
    assert.equal(entry.route, 'LOCAL_MAILBOX');
    assert.equal(entry.environment, 'LOCAL_MACHINE');
    assert.equal(entry.source, 'office-local-mailbox@1');
    assert.equal(entry.verifiedAt, at(1));
  }
  assert.match(entries[0].detail, /session's own result\.json/);
  assert.match(entries[1].detail, /1 declared output file/);
  const model = entries.find(entry => entry.operation === 'MODEL_APPLICATION')!;
  assert.equal(model.model, 'devin-local-7');
  assert.match(model.detail, /self-report/);
  assert.match(model.detail, /not provider attestation/);
  const effort = entries.find(entry => entry.operation === 'EFFORT_APPLICATION')!;
  assert.equal(effort.effort, 'high');
  assert.match(effort.detail, /self-report/);
  assert.equal(entries.find(entry => entry.operation === 'DELEGATION_CONTROL')!.delegation, false);
});

test('observeEvidence without declared self-reports carries no model, effort or delegation record', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  report(dir, { state: 'RUNNING', detail: 'Working.', outputs: [] }, {});
  const job = f.job(externalId);
  const entries = f.adapter.observeEvidence(job, await f.adapter.observe(job));
  assert.deepEqual(entries.map(entry => entry.operation), ['LOCAL_OBSERVE']);
});

test('observeEvidence produces nothing for an unverified or silent session', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const job = f.job(externalId);
  const silent = await f.adapter.observe(job);
  assert.equal(silent.state, 'UNKNOWN');
  assert.deepEqual(f.adapter.observeEvidence(job, silent), []);
  // A receipt the office could not trust is not a session observation either.
  const dir = path.join(f.sessions, externalId);
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify({ state: 'COMPLETED', detail: 'x', outputs: [{ path: 'ghost', sha256: sha('y'), bytes: 1 }] }));
  const untrusted = await f.adapter.observe(job);
  assert.equal(untrusted.state, 'UNKNOWN');
  assert.deepEqual(f.adapter.observeEvidence(job, untrusted), []);
});

test('cancelEvidence records an office-observed local end, never a provider acknowledgement', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const job = f.job(externalId);
  assert.deepEqual(f.adapter.cancelEvidence(job), [], 'no sentinel on disk means nothing was ended');
  await f.adapter.cancel(job);
  const entries = f.adapter.cancelEvidence(job);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.operation, 'LOCAL_CANCEL');
  assert.equal(entry.level, 'TOOL_SUPPORTED');
  assert.equal(entry.evidence, 'OBSERVED');
  assert.equal(entry.route, 'LOCAL_MAILBOX');
  assert.equal(entry.environment, 'LOCAL_MACHINE');
  assert.equal(entry.source, 'office-local-mailbox@1');
  assert.equal(entry.verifiedAt, at(1));
  assert.match(entry.detail, /real cancellation/);
  assert.match(entry.detail, /not a provider acknowledgement/);
});
