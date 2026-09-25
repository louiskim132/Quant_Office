import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeTreeSync } from '../src/main/fsx';
import { buildProviderPayload, type SubmitContext } from '../src/main/controller';
import { AGENTS_FILE, CANCEL_FILE, CONTRACT_FILE, INPUTS_DIR, LocalMailboxAdapter, PACKET_FILE, RESULT_FILE, RESULT_OPTIONAL_KEYS, RESULT_REQUIRED_KEYS, RESULT_STATES } from '../src/main/local-session';
import { CLAUDE_FILE, PACKET_HASH_FILE, PACKET_READY_FILE } from '../src/main/local-packet';
import { MEMORY_DIGEST_FILE, cancelRequestV1Schema, localPacketV2Schema, memoryDigestSchema, type LocalSessionRecord } from '../src/shared/local-session';
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
    jobId: randomUUID(),
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

test('the adapter declares the LOCAL_MAILBOX route and carries every local provider', async t => {
  const f = fixture(t);
  assert.equal(f.adapter.route, 'LOCAL_MAILBOX');
  assert.deepEqual([...f.adapter.providers!].sort(), ['claude', 'devin', 'openai'],
    'the packet contract is provider-agnostic — the user runs whichever CLI on the directory');
});

test('a non-devin job writes a packet and round-trips a verified result with office-local evidence', async t => {
  const f = fixture(t);
  const submitted = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, submitted.externalId);
  assert.ok(existsSync(path.join(dir, PACKET_FILE)), 'the packet directory is identical for a non-devin assignment');
  // The job's provider field is a durable record, never a branch the mailbox consults.
  const claudeJob: ProviderJob = { ...f.job(submitted.externalId), provider: 'claude' };
  report(dir, { state: 'COMPLETED', detail: 'Claude session finished the bounded work.', outputs: [{ path: 'out.txt', sha256: sha('result bytes'), bytes: Buffer.byteLength('result bytes') }] }, { 'out.txt': 'result bytes' });
  const observed = await f.adapter.observe(claudeJob);
  assert.equal(observed.state, 'COMPLETED');
  assert.equal(observed.provenance, 'PROVIDER_REPORTED');
  const evidence = f.adapter.observeEvidence(claudeJob, observed);
  assert.ok(evidence.length > 0 && evidence.every(item => item.evidence === 'OBSERVED' && item.route === 'LOCAL_MAILBOX' && item.environment === 'LOCAL_MACHINE' && item.source === 'office-local-mailbox@1'),
    'evidence stays office-observed whichever provider ran the session');
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

test('a second cancel on an already-signalled session stays acknowledged and rewrites the sentinel harmlessly', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  const job = f.job(externalId);
  await f.adapter.cancel(job);
  assert.ok(existsSync(path.join(dir, CANCEL_FILE)));
  const again = await f.adapter.cancel(job);
  assert.equal(again.acknowledged, true);
  assert.match(again.detail, /Local session ended by the office/);
  // The rewrite replaces the sentinel in place: it still parses and still names this job.
  const sentinel = JSON.parse(readFileSync(path.join(dir, CANCEL_FILE), 'utf8'));
  assert.equal(sentinel.jobId, job.id);
  assert.equal(typeof sentinel.requestedAt, 'string');
  const entries = f.adapter.cancelEvidence(job);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operation, 'LOCAL_CANCEL');
});

test('the vacuous acknowledge repeats cleanly and cancelEvidence reports nothing either time', async t => {
  const f = fixture(t);
  // No recorded identity and an unusable one land on the same branch: nothing external exists to
  // signal, so the office's own acknowledgement is all a second ask can ever produce.
  for (const externalId of ['', '../escape', 'a/b']) {
    const job = f.job(externalId);
    for (let i = 0; i < 2; i++) {
      const result = await f.adapter.cancel(job);
      assert.equal(result.acknowledged, true);
      assert.match(result.detail, /No session was ever recorded/);
      assert.deepEqual(f.adapter.cancelEvidence(job), [], 'no session directory means nothing was ended');
    }
  }
});

test('retire moves the packet directory into the archive and retireEvidence reports the move', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  const dir = path.join(f.sessions, externalId);
  const result = await f.adapter.retire(externalId);
  assert.equal(result.retired, true);
  assert.equal(existsSync(dir), false, 'the live directory is gone');
  const archived = path.join(f.sessions, 'archive', externalId);
  assert.ok(existsSync(path.join(archived, PACKET_FILE)), 'the move carried every byte — nothing was deleted');
  assert.ok(existsSync(path.join(archived, INPUTS_DIR, 'notes.txt')));
  const entries = f.adapter.retireEvidence(externalId);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.operation, 'LOCAL_RETIRE');
  assert.equal(entry.level, 'TOOL_SUPPORTED');
  assert.equal(entry.evidence, 'OBSERVED');
  assert.equal(entry.route, 'LOCAL_MAILBOX');
  assert.equal(entry.environment, 'LOCAL_MACHINE');
  assert.equal(entry.source, 'office-local-mailbox@1');
  assert.equal(entry.verifiedAt, at(1));
  assert.match(entry.detail, /moved the session packet directory/);
});

test('retire reports honestly on missing, invalid and already-retired directories without throwing', async t => {
  const f = fixture(t);
  const missing = await f.adapter.retire('not-created');
  assert.equal(missing.retired, false);
  assert.match(missing.detail, /No session directory/);
  for (const externalId of ['../escape', 'a/b', 'archive']) {
    const invalid = await f.adapter.retire(externalId);
    assert.equal(invalid.retired, false);
  }
  const { externalId } = await f.adapter.submit(f.context);
  await f.adapter.retire(externalId);
  const again = await f.adapter.retire(externalId);
  assert.equal(again.retired, true, 'an already-retired directory reports its state honestly');
  assert.match(again.detail, /already retired/);
});

test('observe on a retired directory reports the missing live dir, naming retirement', async t => {
  const f = fixture(t);
  const { externalId } = await f.adapter.submit(f.context);
  await f.adapter.retire(externalId);
  const result = await f.adapter.observe(f.job(externalId));
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(result.provenance, 'OFFICE_LOCAL');
  assert.match(result.detail, /retired or removed externally/);
});

test('retireEvidence names a still-live directory and records nothing when none exists', async t => {
  const f = fixture(t);
  assert.deepEqual(f.adapter.retireEvidence('not-created'), []);
  assert.deepEqual(f.adapter.retireEvidence('archive'), []);
  const { externalId } = await f.adapter.submit(f.context);
  const entries = f.adapter.retireEvidence(externalId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operation, 'LOCAL_RETIRE');
  assert.match(entries[0].detail, /still live/);
});

test('the confinement record names delivery scope honestly and still describes every axis', async t => {
  const f = fixture(t);
  const submitted = await f.adapter.submit(f.context);
  const entry = f.adapter.submitEvidence(f.context, submitted).find(item => item.operation === 'TOOL_CONFINEMENT')!;
  assert.match(entry.detail, /delivery scope/i);
  const policy = entry.confinement!;
  assert.match(policy.filesystem, /dedicated session directory/);
  assert.match(policy.filesystem, /confines nothing/);
  assert.match(policy.network, /not restricted/);
  assert.match(policy.environment, /user-launched/);
  // confinementDescribed (readiness.ts) is not exported; mirror its check — every axis must say
  // what was and wasn't restricted, which the honest record still satisfies.
  assert.ok([policy.tools, policy.filesystem, policy.network, policy.environment].every(field => field.trim()),
    'every confinement axis is described');
});

function boundFixture(t: test.TestContext, storageRelativePath = 'bound-session') {
  const f = fixture(t);
  mkdirSync(f.sessions, { recursive: true });
  const binding: LocalSessionRecord = {
    schemaVersion: 1, id: randomUUID(), jobId: f.context.jobId, assignmentId: f.assignment.id,
    projectId: f.assignment.projectId, attemptId: randomUUID(), revision: 0,
    provider: 'devin', surface: 'DEVIN_CLI', layout: 'FLAT_PACKET', packetVersion: 2,
    packetHash: null, storageRelativePath, originalCwd: null,
    repoRelativePath: null, seedCommit: null, worktreeOwner: 'NONE',
    providerSessionId: null, providerProjectId: null, bindingEvidence: 'UNBOUND',
    groupingStatus: 'UNKNOWN', requirement: 'SCOPED_DELIVERY', confinementStatus: 'UNVERIFIED',
    confinementEvidenceId: null, lifecycle: 'READY', archiveRelativePath: null,
    lastReceipt: null, cancelRequestId: null, stopStatus: 'NOT_REQUESTED',
    createdAt: at(0), updatedAt: at(0),
  };
  const context: SubmitContext = { ...f.context, localSession: binding };
  const dir = path.resolve(f.sessions, storageRelativePath);
  return { ...f, binding, context, dir };
}

/** A well-formed v2 receipt for a bound fixture — callers override what they attack. */
function v2Receipt(binding: LocalSessionRecord, overrides: Record<string, unknown> = {}) {
  return {
    schema: 'office-local-result@2', jobId: binding.jobId, assignmentId: binding.assignmentId,
    attemptId: binding.attemptId, packetHash: binding.packetHash, sequence: 1,
    state: 'COMPLETED', detail: 'Done.', outputs: [], ...overrides,
  };
}

test('the adapter declares packet contract version 2 for bound submissions', async t => {
  const f = fixture(t);
  assert.equal(f.adapter.packetVersion, 2);
});

test('a bound submit writes a v2 packet under the binding storage path and reports its hash', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  assert.equal(result.externalId, 'bound-session');
  assert.ok(result.localPacket, 'a bound submit reports the verified packet hash');
  const packet = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8')));
  assert.equal(packet.schema, 'office-local-session@2');
  assert.equal(packet.jobId, f.binding.jobId);
  assert.equal(packet.assignmentId, f.binding.assignmentId);
  assert.equal(packet.attemptId, f.binding.attemptId);
  assert.equal(packet.requestName, 'Tiny local task');
  assert.deepEqual(packet.requested, { model: 'devin-local', effort: 'default', delegation: false });
  assert.equal(packet.snapshotManifestHash, f.snapshot.manifestHash);
  assert.ok(packet.files.every(file => file.path.startsWith(`${INPUTS_DIR}/`)));
  // The reported hash is exactly the written packet.sha256, and the ready marker binds the attempt.
  assert.equal(readFileSync(path.join(f.dir, PACKET_HASH_FILE), 'utf8').trim(), result.localPacket.packetHash);
  const ready = JSON.parse(readFileSync(path.join(f.dir, PACKET_READY_FILE), 'utf8'));
  assert.deepEqual(ready, { attemptId: f.binding.attemptId, packetHash: result.localPacket.packetHash });
  assert.ok(existsSync(path.join(f.dir, CLAUDE_FILE)));
  assert.match(result.detail, /awaits a local session/);
});

test('a bound submit mounts the memory digest only for the authorized synthesis seats', async t => {
  const f = boundFixture(t);
  const digest = {
    findings: [{ id: randomUUID(), kind: 'RESULT' as const, title: 'alpha holds', body: 'seen twice', evidenceRefs: [], superseded: false, createdAt: at(0) }],
    links: [],
  };
  // An authorized seat: the controller supplies the projection and the packet mounts it.
  const synthesis: SubmitContext = {
    ...f.context,
    assignment: { ...f.assignment, pipelineKey: 'plan-synthesis' },
    memoryDigest: digest,
  };
  const mounted = await f.adapter.submit(synthesis);
  const dir = path.join(f.sessions, mounted.externalId);
  const onDisk = memoryDigestSchema.parse(JSON.parse(readFileSync(path.join(dir, MEMORY_DIGEST_FILE), 'utf8')));
  assert.equal(onDisk.schema, 'office-memory-digest@1');
  assert.deepEqual(onDisk.findings, digest.findings);
  const packet = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(dir, PACKET_FILE), 'utf8')));
  assert.equal(packet.memoryDigest?.path, MEMORY_DIGEST_FILE);
  assert.equal(packet.memoryDigest?.findings, 1);
  assert.equal(packet.memoryDigest?.sha256, sha(readFileSync(path.join(dir, MEMORY_DIGEST_FILE), 'utf8')));
  // A non-synthesis seat: even with the projection supplied, no file and no declaration.
  const f2 = boundFixture(t, 'bound-session-2');
  const review: SubmitContext = {
    ...f2.context,
    assignment: { ...f2.assignment, pipelineKey: 'research-review' },
    memoryDigest: digest,
  };
  const plain = await f2.adapter.submit(review);
  const dir2 = path.join(f2.sessions, plain.externalId);
  assert.equal(existsSync(path.join(dir2, MEMORY_DIGEST_FILE)), false, 'an unauthorized seat never receives the digest file');
  const packet2 = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(dir2, PACKET_FILE), 'utf8')));
  assert.equal(packet2.memoryDigest, undefined, 'an unauthorized seat never carries the declaration');
});

test('a nested binding storage path lands exactly where the record names it', async t => {
  const f = boundFixture(t, 'nested/bound-session');
  const result = await f.adapter.submit(f.context);
  assert.equal(result.externalId, 'bound-session', 'the recorded identity is the directory basename');
  assert.ok(existsSync(path.join(f.dir, PACKET_FILE)), 'the packet lives under sessions/nested/bound-session');
  assert.equal(existsSync(path.join(f.sessions, 'bound-session')), false, 'no flat directory was created beside it');
});

test('observe on a v2 binding validates the receipt through the v2 reader', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  const output = { path: 'outputs/summary.txt', sha256: sha('done bytes'), bytes: Buffer.byteLength('done bytes') };
  mkdirSync(path.join(f.dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(f.dir, 'outputs', 'summary.txt'), 'done bytes');
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(v2Receipt(bound, {
    outputs: [output], applied: { model: 'devin-local-9', effort: 'high', delegation: false },
  })));
  const observed = await f.adapter.observe(f.job(result.externalId), bound);
  assert.equal(observed.state, 'COMPLETED');
  assert.equal(observed.provenance, 'PROVIDER_REPORTED');
  assert.deepEqual(observed.outputs, [output]);
  assert.deepEqual((observed as { applied?: unknown }).applied, { model: 'devin-local-9', effort: 'high', delegation: false });
});

test('a v1-shaped receipt on a v2 binding is UNKNOWN, never a fallback', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify({ state: 'COMPLETED', detail: 'v1 shape', outputs: [] }));
  const observed = await f.adapter.observe(f.job(result.externalId), bound);
  assert.equal(observed.state, 'UNKNOWN');
  assert.equal(observed.provenance, 'OFFICE_LOCAL');
  assert.match(observed.detail, /office-local-result@2/);
});

test('a receipt bound to another attempt is refused even with matching output hashes', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  const output = { path: 'outputs/summary.txt', sha256: sha('done bytes'), bytes: Buffer.byteLength('done bytes') };
  mkdirSync(path.join(f.dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(f.dir, 'outputs', 'summary.txt'), 'done bytes');
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(v2Receipt(bound, { attemptId: randomUUID(), outputs: [output] })));
  const observed = await f.adapter.observe(f.job(result.externalId), bound);
  assert.equal(observed.state, 'UNKNOWN');
  assert.match(observed.detail, /attemptId/);
});

test('a receipt that does not advance past the recorded last receipt is refused', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash, lastReceipt: { sequence: 1, hash: sha('first'), observedAt: at(0) } };
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(v2Receipt(bound, { sequence: 1 })));
  const observed = await f.adapter.observe(f.job(result.externalId), bound);
  assert.equal(observed.state, 'UNKNOWN');
  assert.match(observed.detail, /sequence/);
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(v2Receipt(bound, { sequence: 2 })));
  const advanced = await f.adapter.observe(f.job(result.externalId), bound);
  assert.equal(advanced.state, 'COMPLETED');
});

test('fetch on a v2 binding returns the verified bytes and refuses drift', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  mkdirSync(path.join(f.dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(f.dir, 'outputs', 'summary.txt'), 'done bytes');
  const job = f.job(result.externalId);
  const output = { path: 'outputs/summary.txt', sha256: sha('done bytes'), bytes: Buffer.byteLength('done bytes') };
  assert.equal(Buffer.from(await f.adapter.fetch!(job, output, bound)).toString(), 'done bytes');
  await assert.rejects(f.adapter.fetch!(job, { ...output, bytes: 999 }, bound), /bytes/);
  await assert.rejects(f.adapter.fetch!(job, { ...output, sha256: sha('forged') }, bound), /hashes to/);
});

test('a bound cancel writes a schema-valid cooperative request and returns its requestId', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  const job = f.job(result.externalId);
  const cancelled = await f.adapter.cancel(job, bound);
  assert.equal(cancelled.acknowledged, true);
  assert.ok(cancelled.requestId, 'the office names the request it wrote');
  // The on-disk request body satisfies the contract and binds exactly this attempt.
  const request = JSON.parse(readFileSync(path.join(f.dir, 'cancel.requested'), 'utf8'));
  const parsed = cancelRequestV1Schema.parse(request);
  assert.equal(parsed.schema, 'office-local-cancel-request@1');
  assert.equal(parsed.requestId, cancelled.requestId);
  assert.equal(parsed.jobId, bound.jobId);
  assert.equal(parsed.assignmentId, bound.assignmentId);
  assert.equal(parsed.attemptId, bound.attemptId);
  assert.equal(parsed.packetHash, bound.packetHash);
  // Honesty: a delivered request is not a stopped session and not a provider acknowledgement.
  assert.match(cancelled.detail, /delivered|request/);
  assert.match(cancelled.detail, /nothing has stopped/i);
  assert.match(cancelled.detail, /not a provider acknowledgement/);
});

test('a second bound cancel is idempotent and names the recorded requestId', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  const job = f.job(result.externalId);
  const first = await f.adapter.cancel(job, bound);
  const second = await f.adapter.cancel(job, bound);
  assert.equal(second.acknowledged, true);
  assert.equal(second.requestId, first.requestId, 'the already-delivered request is named, not rewritten');
  assert.match(second.detail, /already/i);
  // The file still carries the first request — nothing was overwritten.
  const request = cancelRequestV1Schema.parse(JSON.parse(readFileSync(path.join(f.dir, 'cancel.requested'), 'utf8')));
  assert.equal(request.requestId, first.requestId);
});

test('a bound cancel refuses when the binding carries no packet hash', async t => {
  const f = boundFixture(t);
  await f.adapter.submit(f.context);
  const job = f.job('bound-session');
  const cancelled = await f.adapter.cancel(job, f.binding);
  assert.equal(cancelled.acknowledged, false);
  assert.equal(cancelled.requestId, undefined);
  assert.match(cancelled.detail, /packet hash/i);
  assert.equal(existsSync(path.join(f.dir, 'cancel.requested')), false, 'nothing was written');
});

test('a malformed or differently-bound existing request file is refused, never overwritten', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  const job = f.job(result.externalId);
  writeFileSync(path.join(f.dir, 'cancel.requested'), 'not json {');
  let cancelled = await f.adapter.cancel(job, bound);
  assert.equal(cancelled.acknowledged, false);
  assert.match(cancelled.detail, /malformed|not valid JSON|cannot be trusted/i);
  assert.equal(readFileSync(path.join(f.dir, 'cancel.requested'), 'utf8'), 'not json {', 'the malformed file was left untouched');
  // A schema-valid request bound to a different attempt is a defect, not an idempotent hit.
  writeFileSync(path.join(f.dir, 'cancel.requested'), JSON.stringify({
    schema: 'office-local-cancel-request@1', requestId: randomUUID(), jobId: bound.jobId,
    assignmentId: bound.assignmentId, attemptId: randomUUID(), packetHash: bound.packetHash,
    requestedAt: at(0),
  }));
  cancelled = await f.adapter.cancel(job, bound);
  assert.equal(cancelled.acknowledged, false);
  assert.match(cancelled.detail, /attemptId/);
});

test('observe surfaces a valid cancel acknowledgement bound to the recorded request', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  const job = f.job(result.externalId);
  const cancelled = await f.adapter.cancel(job, bound);
  const requested = { ...bound, cancelRequestId: cancelled.requestId! };
  const output = { path: 'outputs/summary.txt', sha256: sha('done bytes'), bytes: Buffer.byteLength('done bytes') };
  mkdirSync(path.join(f.dir, 'outputs'), { recursive: true });
  writeFileSync(path.join(f.dir, 'outputs', 'summary.txt'), 'done bytes');
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(v2Receipt(requested, { outputs: [output] })));
  writeFileSync(path.join(f.dir, 'cancel.ack.json'), JSON.stringify({
    schema: 'office-local-cancel-ack@1', requestId: cancelled.requestId, jobId: bound.jobId,
    assignmentId: bound.assignmentId, attemptId: bound.attemptId, packetHash: bound.packetHash,
    outcome: 'STOPPED', detail: 'Stopped after the request.',
  }));
  const observed = await f.adapter.observe(job, requested);
  assert.equal(observed.state, 'COMPLETED');
  assert.equal(observed.provenance, 'PROVIDER_REPORTED');
  assert.deepEqual(observed.outputs, [output]);
  assert.deepEqual(observed.cancelAck, { requestId: cancelled.requestId, outcome: 'STOPPED', detail: 'Stopped after the request.' });
});

test('observe on a v2 binding defects an ack for a request the office never recorded', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  const job = f.job(result.externalId);
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(v2Receipt(bound)));
  writeFileSync(path.join(f.dir, 'cancel.ack.json'), JSON.stringify({
    schema: 'office-local-cancel-ack@1', requestId: randomUUID(), jobId: bound.jobId,
    assignmentId: bound.assignmentId, attemptId: bound.attemptId, packetHash: bound.packetHash,
    outcome: 'STOPPED', detail: 'Claimed stop.',
  }));
  const observed = await f.adapter.observe(job, bound);
  assert.equal(observed.state, 'UNKNOWN');
  assert.equal(observed.provenance, 'OFFICE_LOCAL');
  assert.match(observed.detail, /cancel\.ack\.json/);
  assert.match(observed.detail, /never recorded|no cancel request/i);
});

test('observe defects a malformed or misbound ack even beside a valid receipt', async t => {
  const f = boundFixture(t);
  const result = await f.adapter.submit(f.context);
  const bound = { ...f.binding, packetHash: result.localPacket!.packetHash };
  const job = f.job(result.externalId);
  const cancelled = await f.adapter.cancel(job, bound);
  const requested = { ...bound, cancelRequestId: cancelled.requestId! };
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(v2Receipt(requested)));
  writeFileSync(path.join(f.dir, 'cancel.ack.json'), 'garbage {');
  let observed = await f.adapter.observe(job, requested);
  assert.equal(observed.state, 'UNKNOWN');
  assert.match(observed.detail, /cancel\.ack\.json/);
  // A schema-valid ack naming a different request is still a defect — the receipt stays untrusted.
  writeFileSync(path.join(f.dir, 'cancel.ack.json'), JSON.stringify({
    schema: 'office-local-cancel-ack@1', requestId: randomUUID(), jobId: requested.jobId,
    assignmentId: requested.assignmentId, attemptId: requested.attemptId, packetHash: requested.packetHash,
    outcome: 'STOPPED', detail: 'Wrong request.',
  }));
  observed = await f.adapter.observe(job, requested);
  assert.equal(observed.state, 'UNKNOWN');
  assert.match(observed.detail, /requestId/);
});
