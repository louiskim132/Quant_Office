import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalHash } from '../src/core/canonical';
import { removeTreeSync } from '../src/main/fsx';
import { buildProviderPayload, type SubmitContext } from '../src/main/controller';
import { FakeLocalFileIO, GuardedLocalFileIO } from '../src/main/local-session-files';
import { AGENTS_FILE, CLAUDE_FILE, CONTRACT_FILE, INPUTS_DIR, PACKET_FILE, PACKET_HASH_FILE, PACKET_READY_FILE, RESULT_FILE, prepareLocalPacket, readLocalResult, readLocalResultV1 } from '../src/main/local-packet';
import { localPacketV2Schema, type LocalSessionRecord } from '../src/shared/local-session';
import type { Assignment, InputSnapshot } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 19, 10, 0, 0) + minutes * 60000).toISOString();
const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);

function record(overrides: Partial<LocalSessionRecord> = {}): LocalSessionRecord {
  return {
    schemaVersion: 1, id: randomUUID(), jobId: randomUUID(), assignmentId: randomUUID(),
    projectId: randomUUID(), attemptId: randomUUID(), revision: 0,
    provider: 'devin', surface: 'DEVIN_CLI', layout: 'FLAT_PACKET', packetVersion: 2,
    packetHash: null, storageRelativePath: 'bound-session', originalCwd: null,
    repoRelativePath: null, seedCommit: null, worktreeOwner: 'NONE',
    providerSessionId: null, providerProjectId: null, bindingEvidence: 'UNBOUND',
    groupingStatus: 'UNKNOWN', requirement: 'SCOPED_DELIVERY', confinementStatus: 'UNVERIFIED',
    confinementEvidenceId: null, lifecycle: 'READY', archiveRelativePath: null,
    lastReceipt: null, cancelRequestId: null, stopStatus: 'NOT_REQUESTED',
    createdAt: at(0), updatedAt: at(0), ...overrides,
  };
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-local-packet-'));
  t.after(() => removeTreeSync(root));
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
  const binding = record({ projectId: snapshot.projectId });
  const assignment: Assignment = {
    id: binding.assignmentId, projectId: snapshot.projectId, requestId: snapshot.requestId!, requestRevision: 1,
    agentId: randomUUID(), agentRevision: 0, connectionId: randomUUID(), capabilitySnapshotId: randomUUID(),
    snapshotId: snapshot.id, route: 'LOCAL_MAILBOX', requestedModel: 'devin-local', resolvedModel: '',
    requestedEffort: 'default', appliedEffort: 'UNVERIFIED', delegation: false, objectiveHash: sha('objective'),
    createdAt: at(0),
  };
  const context: SubmitContext = {
    assignment, snapshot, objective: 'Summarize the fixture input.', requestName: 'Tiny local task',
    payload: buildProviderPayload({ requestName: 'Tiny local task', objective: 'Summarize the fixture input.', acceptanceCriteria: 'A summary file.', instructions: '', model: 'devin-local', effort: 'default', delegation: false }),
    jobId: binding.jobId, localSession: binding,
  };
  const dir = path.join(sessions, binding.storageRelativePath);
  const io = new GuardedLocalFileIO();
  return { root, staging, sessions, snapshot, binding, assignment, context, dir, io };
}

/** A well-formed v2 receipt for this fixture's binding — callers override what they attack. */
function receipt(binding: LocalSessionRecord, packetHash: string, overrides: Record<string, unknown> = {}) {
  return {
    schema: 'office-local-result@2', jobId: binding.jobId, assignmentId: binding.assignmentId,
    attemptId: binding.attemptId, packetHash, sequence: 1, state: 'COMPLETED', detail: 'Done.',
    outputs: [], ...overrides,
  };
}

function prepare(f: ReturnType<typeof fixture>) {
  return prepareLocalPacket({ dir: f.dir, context: f.context, binding: f.binding, io: f.io, now: at(1) });
}

/** Writes a result.json and its declared output bytes into the real packet dir. */
function report(dir: string, result: Record<string, unknown>, files: Record<string, string> = {}) {
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify(result));
}

test('prepare writes a schema-valid v2 packet, its canonical hash and the ready marker', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const packet = JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8'));
  const parsed = localPacketV2Schema.parse(packet);
  assert.equal(parsed.schema, 'office-local-session@2');
  assert.equal(parsed.jobId, f.binding.jobId);
  assert.equal(parsed.assignmentId, f.binding.assignmentId);
  assert.equal(parsed.attemptId, f.binding.attemptId);
  assert.equal(parsed.projectId, f.binding.projectId);
  assert.equal(parsed.requestName, 'Tiny local task');
  assert.equal(parsed.objective, 'Summarize the fixture input.');
  assert.deepEqual(parsed.requested, { model: 'devin-local', effort: 'default', delegation: false });
  assert.equal(parsed.payload, f.context.payload.text);
  assert.equal(parsed.snapshotManifestHash, f.snapshot.manifestHash);
  assert.equal(parsed.contract, CONTRACT_FILE);
  // Every snapshot file landed under inputs/ as verified bytes with the manifest hash.
  assert.equal(parsed.files.length, 2);
  for (const file of parsed.files) {
    assert.match(file.path, /^inputs\//);
    const onDisk = readFileSync(path.join(f.dir, file.path));
    assert.equal(sha(onDisk), file.sha256);
    assert.equal(onDisk.byteLength, file.bytes);
    assert.equal(readFileSync(path.join(f.staging, file.path.slice('inputs/'.length)), 'utf8'), onDisk.toString('utf8'));
  }
  // The three instruction files are declared and written.
  assert.deepEqual(parsed.instructions.map(file => file.path).sort(), [AGENTS_FILE, CLAUDE_FILE, CONTRACT_FILE].sort());
  for (const file of parsed.instructions) {
    const onDisk = readFileSync(path.join(f.dir, file.path));
    assert.equal(sha(onDisk), file.sha256);
    assert.equal(onDisk.byteLength, file.bytes);
  }
  // packet.sha256 is the canonical hash of the packet object, and the ready marker closes the write.
  assert.equal(prepared.packetHash, canonicalHash(packet));
  assert.equal(readFileSync(path.join(f.dir, PACKET_HASH_FILE), 'utf8').trim(), prepared.packetHash);
  const ready = JSON.parse(readFileSync(path.join(f.dir, PACKET_READY_FILE), 'utf8'));
  assert.deepEqual(ready, { attemptId: f.binding.attemptId, packetHash: prepared.packetHash });
});

test('CLAUDE.md is a regular file starting with the @AGENTS.md include line', t => {
  const f = fixture(t);
  prepare(f);
  const target = path.join(f.dir, CLAUDE_FILE);
  const stats = lstatSync(target);
  assert.ok(stats.isFile() && !stats.isSymbolicLink(), 'CLAUDE.md is a real file, not a link');
  const text = readFileSync(target, 'utf8');
  assert.equal(text.split('\n')[0], '@AGENTS.md');
  assert.match(text, /CONTRACT\.md/);
  const agents = readFileSync(path.join(f.dir, AGENTS_FILE), 'utf8');
  assert.match(agents, /CONTRACT\.md/);
  assert.match(agents, /packet\.json/);
});

test('CONTRACT.md documents the v2 result schema, office control files and the cancel ack', t => {
  const f = fixture(t);
  prepare(f);
  const contract = readFileSync(path.join(f.dir, CONTRACT_FILE), 'utf8');
  for (const fragment of [
    'office-local-result@2', 'jobId', 'assignmentId', 'attemptId', 'packetHash', 'sequence',
    'ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED', 'outputs/', 'applied',
    PACKET_READY_FILE, PACKET_HASH_FILE, 'cancel.requested', 'cancel.ack.json', 'office-local-cancel-ack@1', 'STOPPED',
  ]) assert.ok(contract.includes(fragment), `contract names ${fragment}`);
});

test('a staged input that drifted from its frozen manifest fails preparation loudly', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.staging, 'notes.txt'), 'changed after freezing');
  assert.throws(() => prepare(f), /no longer matches the bytes that were frozen/);
  // The failure is loud and partial bytes were never trusted: no ready marker exists.
  assert.equal(existsSync(path.join(f.dir, PACKET_READY_FILE)), false);
});

test('preparation refuses a destination that already carries a receipt, sentinel or ready marker', t => {
  for (const poison of [RESULT_FILE, 'cancel.requested', 'cancel.ack.json', PACKET_READY_FILE]) {
    const f = fixture(t);
    mkdirSync(f.dir, { recursive: true });
    writeFileSync(path.join(f.dir, poison), '{}');
    assert.throws(() => prepare(f), new RegExp(`already contains.*${poison.replace('.', '\\.')}`), poison);
  }
});

test('readLocalResult accepts a correct receipt and returns the verified output bytes', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const bound = { ...f.binding, packetHash: prepared.packetHash };
  const output = { path: 'outputs/summary.txt', sha256: sha('done bytes'), bytes: Buffer.byteLength('done bytes') };
  report(f.dir, receipt(bound, prepared.packetHash, { outputs: [output] }), { 'outputs/summary.txt': 'done bytes' });
  const read = readLocalResult(f.dir, bound, f.io);
  assert.ok('value' in read, 'defect' in read ? read.defect : '');
  assert.equal(read.value.result.state, 'COMPLETED');
  assert.equal(read.value.result.sequence, 1);
  assert.deepEqual(read.value.result.outputs, [output]);
  assert.equal(Buffer.from(read.value.outputs[0].data).toString(), 'done bytes');
  const receiptBytes = readFileSync(path.join(f.dir, RESULT_FILE));
  assert.equal(read.value.receiptHash, sha(receiptBytes));
});

test('readLocalResult refuses a missing or mismatched ready marker before trusting anything', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const bound = { ...f.binding, packetHash: prepared.packetHash };
  report(f.dir, receipt(bound, prepared.packetHash));
  rmSync(path.join(f.dir, PACKET_READY_FILE));
  let read = readLocalResult(f.dir, bound, f.io);
  assert.ok('defect' in read && /ready marker|packet\.ready\.json/i.test(read.defect), 'defect' in read ? read.defect : 'expected a defect');
  writeFileSync(path.join(f.dir, PACKET_READY_FILE), JSON.stringify({ attemptId: randomUUID(), packetHash: prepared.packetHash }));
  read = readLocalResult(f.dir, bound, f.io);
  assert.ok('defect' in read && /ready marker/i.test(read.defect));
});

test('readLocalResult refuses a receipt bound to another job, assignment, attempt or packet', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const bound = { ...f.binding, packetHash: prepared.packetHash };
  for (const [key, value] of [['jobId', randomUUID()], ['assignmentId', randomUUID()], ['attemptId', randomUUID()], ['packetHash', sha('other')]] as const) {
    report(f.dir, receipt(bound, prepared.packetHash, { [key]: value }));
    const read = readLocalResult(f.dir, bound, f.io);
    assert.ok('defect' in read, `${key} mismatch must be a defect`);
    assert.match(read.defect, new RegExp(key));
  }
});

test('a cross-attempt receipt is refused even when its declared output hashes match', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const bound = { ...f.binding, packetHash: prepared.packetHash };
  const output = { path: 'outputs/summary.txt', sha256: sha('done bytes'), bytes: Buffer.byteLength('done bytes') };
  // A receipt naming a different attempt — same outputs/, same bytes, same hashes.
  report(f.dir, receipt(bound, prepared.packetHash, { attemptId: randomUUID(), outputs: [output] }), { 'outputs/summary.txt': 'done bytes' });
  const read = readLocalResult(f.dir, bound, f.io);
  assert.ok('defect' in read && /attemptId/.test(read.defect), 'defect' in read ? read.defect : 'expected a defect');
});

test('a receipt that does not advance the sequence is refused with the prior receipt named', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const prior = { sequence: 3, hash: sha('prior receipt'), observedAt: at(0) };
  const bound = { ...f.binding, packetHash: prepared.packetHash, lastReceipt: prior };
  report(f.dir, receipt(bound, prepared.packetHash, { sequence: 2 }));
  let read = readLocalResult(f.dir, bound, f.io);
  assert.ok('defect' in read && /sequence/.test(read.defect) && read.defect.includes(prior.hash), 'defect' in read ? read.defect : 'expected a defect');
  report(f.dir, receipt(bound, prepared.packetHash, { sequence: 3 }));
  read = readLocalResult(f.dir, bound, f.io);
  assert.ok('defect' in read && /sequence/.test(read.defect));
  report(f.dir, receipt(bound, prepared.packetHash, { sequence: 4 }));
  read = readLocalResult(f.dir, bound, f.io);
  assert.ok('value' in read, 'defect' in read ? read.defect : 'sequence 4 must be accepted');
});

test('outputs outside outputs/, a byte mismatch and a sha mismatch are all refused', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const bound = { ...f.binding, packetHash: prepared.packetHash };
  // Declared outside outputs/ — the schema itself refuses it.
  report(f.dir, receipt(bound, prepared.packetHash, { outputs: [{ path: 'out.txt', sha256: sha('x'), bytes: 1 }] }), { 'out.txt': 'x' });
  assert.ok('defect' in readLocalResult(f.dir, bound, f.io));
  // Declared under outputs/ but missing on disk.
  report(f.dir, receipt(bound, prepared.packetHash, { outputs: [{ path: 'outputs/ghost.txt', sha256: sha('x'), bytes: 1 }] }));
  assert.ok('defect' in readLocalResult(f.dir, bound, f.io));
  // Declared bytes differ from the file.
  report(f.dir, receipt(bound, prepared.packetHash, { outputs: [{ path: 'outputs/real.txt', sha256: sha('actual'), bytes: 999 }] }), { 'outputs/real.txt': 'actual' });
  const read = readLocalResult(f.dir, bound, f.io);
  assert.ok('defect' in read && /bytes/.test(read.defect), 'defect' in read ? read.defect : 'expected a defect');
  // Declared sha differs.
  report(f.dir, receipt(bound, prepared.packetHash, { outputs: [{ path: 'outputs/real.txt', sha256: sha('forged'), bytes: 6 }] }), { 'outputs/real.txt': 'actual' });
  const forged = readLocalResult(f.dir, bound, f.io);
  assert.ok('defect' in forged && /sha256|hashes to/.test(forged.defect));
});

test('a v1-shaped receipt on a v2 binding is a defect, never a fallback', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const bound = { ...f.binding, packetHash: prepared.packetHash };
  report(f.dir, { state: 'COMPLETED', detail: 'v1 shape', outputs: [] });
  const read = readLocalResult(f.dir, bound, f.io);
  assert.ok('defect' in read, 'a v1 receipt must not validate against the v2 schema');
});

test('an absent receipt is an honest defect, not a result', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const bound = { ...f.binding, packetHash: prepared.packetHash };
  const read = readLocalResult(f.dir, bound, f.io);
  assert.ok('defect' in read && /result\.json/.test(read.defect));
});

test('the same contract holds end-to-end through FakeLocalFileIO', t => {
  const io = new FakeLocalFileIO();
  // The fake boundary holds every packet byte in memory; dir/staging only need to exist as real
  // directories for the office-side allocation and mkdir calls, so they live under tmp like the rest.
  const root = mkdtempSync(path.join(tmpdir(), 'qro-local-fake-'));
  t.after(() => removeTreeSync(root));
  const staging = path.join(root, 'staging');
  const dir = path.join(root, 'sessions', 'bound-session');
  const binding = record();
  for (const file of [
    { path: 'data/input.csv', text: 'a,b\n1,2\n' },
    { path: 'notes.txt', text: 'fixture notes' },
  ]) io.writeNew(staging, file.path, bytes(file.text));
  const snapshot: InputSnapshot = {
    id: randomUUID(), projectId: binding.projectId, requestId: randomUUID(), locationRevision: 0, requestRevision: 1,
    route: 'SELECTED_FILES_GIT_SNAPSHOT',
    files: [
      { path: 'data/input.csv', bytes: Buffer.byteLength('a,b\n1,2\n'), sha256: sha('a,b\n1,2\n') },
      { path: 'notes.txt', bytes: Buffer.byteLength('fixture notes'), sha256: sha('fixture notes') },
    ],
    totalBytes: 0, manifestHash: sha('manifest'), stagingCommit: 'x', stagingPath: staging,
    warnings: [], provenance: 'OFFICE_STAGED', createdAt: at(0),
  };
  const assignment = { id: binding.assignmentId } as Assignment;
  const context: SubmitContext = {
    assignment, snapshot, objective: 'o', requestName: 'r',
    payload: buildProviderPayload({ requestName: 'r', objective: 'o', acceptanceCriteria: '', instructions: '', model: 'm', effort: 'low', delegation: true }),
    jobId: binding.jobId, localSession: binding,
  };
  const prepared = prepareLocalPacket({ dir, context, binding, io, now: at(1) });
  const packet = JSON.parse(Buffer.from(io.read(dir, PACKET_FILE, 1 << 20).bytes).toString());
  localPacketV2Schema.parse(packet);
  assert.equal(canonicalHash(packet), prepared.packetHash);
  const bound = { ...binding, packetHash: prepared.packetHash };
  io.writeNew(dir, 'outputs/summary.txt', bytes('fake out'));
  const output = { path: 'outputs/summary.txt', sha256: sha('fake out'), bytes: Buffer.byteLength('fake out') };
  io.writeNew(dir, RESULT_FILE, bytes(JSON.stringify(receipt(bound, prepared.packetHash, { outputs: [output] }))));
  const read = readLocalResult(dir, bound, io);
  assert.ok('value' in read, 'defect' in read ? read.defect : '');
  assert.equal(Buffer.from(read.value.outputs[0].data).toString(), 'fake out');
  assert.ok(io.calls.some(call => call.method === 'inspectRoot'), 'the root was inspected through the io boundary');
});

test('readLocalResultV1 accepts a well-formed v1 receipt and defects a malformed one', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-local-v1-'));
  t.after(() => removeTreeSync(root));
  const resultPath = path.join(root, RESULT_FILE);
  writeFileSync(resultPath, JSON.stringify({ state: 'COMPLETED', detail: 'v1 done', outputs: [] }));
  const read = readLocalResultV1(resultPath);
  assert.ok('value' in read);
  assert.equal(read.value.state, 'COMPLETED');
  writeFileSync(resultPath, JSON.stringify({ state: 'COMPLETED', detail: 'x', outputs: [], smuggled: true }));
  assert.ok('defect' in readLocalResultV1(resultPath));
});
