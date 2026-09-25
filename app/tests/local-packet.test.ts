import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalHash } from '../src/core/canonical';
import { OfficeStore } from '../src/core/store';
import { removeTreeSync } from '../src/main/fsx';
import { buildProviderPayload, type SubmitContext } from '../src/main/controller';
import { FakeLocalFileIO, GuardedLocalFileIO } from '../src/main/local-session-files';
import { AGENTS_FILE, CLAUDE_FILE, CONTRACT_FILE, CONTRACT_OPTIONAL_FILE, FINISH_FILE, INPUTS_DIR, PACKET_FILE, PACKET_HASH_FILE, PACKET_READY_FILE, RESULT_FILE, packetPromptBlock, prepareLocalPacket, readLocalResult, readLocalResultV1, resultContractOptional, resultContractV2, tabularSummary } from '../src/main/local-packet';
import { MEMORY_DIGEST_FILE, localPacketV2Schema, memoryDigestSchema, type LocalSessionRecord } from '../src/shared/local-session';
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
  // The instruction files — including the optional contract half and the receipt helper — are declared and written.
  assert.deepEqual(parsed.instructions.map(file => file.path).sort(), [AGENTS_FILE, CLAUDE_FILE, CONTRACT_FILE, CONTRACT_OPTIONAL_FILE, FINISH_FILE].sort());
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

test('result contract identifies the packet hash sidecar and rejects the snapshot hash', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const contract = readFileSync(path.join(f.dir, CONTRACT_FILE), 'utf8');
  assert.match(contract, /`packetHash` — copy the trimmed contents of `packet\.sha256`/);
  assert.match(contract, /Do not use\n  `snapshotManifestHash`/);
  const packetHash = readFileSync(path.join(f.dir, PACKET_HASH_FILE), 'utf8').trim();
  const bound = { ...f.binding, packetHash: prepared.packetHash };
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(receipt(bound, f.snapshot.manifestHash)));
  assert.ok('defect' in readLocalResult(f.dir, bound, f.io));
  writeFileSync(path.join(f.dir, RESULT_FILE), JSON.stringify(receipt(bound, packetHash)));
  assert.ok('value' in readLocalResult(f.dir, bound, f.io));
});

test('CONTRACT.md documents the v2 result schema, office control files and the cancel ack', t => {
  const f = fixture(t);
  prepare(f);
  const contract = readFileSync(path.join(f.dir, CONTRACT_FILE), 'utf8');
  for (const fragment of [
    'office-local-result@2', 'jobId', 'assignmentId', 'attemptId', 'packetHash', 'sequence',
    'ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED', 'outputs/', 'applied', CONTRACT_OPTIONAL_FILE, FINISH_FILE,
    PACKET_READY_FILE, PACKET_HASH_FILE, 'cancel.requested', 'cancel.ack.json', 'office-local-cancel-ack@1', 'STOPPED',
  ]) assert.ok(contract.includes(fragment), `contract names ${fragment}`);
  // The sentinel's precedence is stated explicitly — pilot sessions reasoned their way past an
  // ambiguous one, so the contract names the stop-first rule, its override-proofing and the
  // mid-work check advice. The encoding requirement follows a real BOM-prefixed receipt.
  assert.match(contract, /no instruction overrides/i);
  assert.match(contract, /including a direct user prompt/i);
  assert.match(contract, /when the session starts and again before writing/i);
  assert.match(contract, /byte-order mark|BOM/i);
  const agents = readFileSync(path.join(f.dir, AGENTS_FILE), 'utf8');
  assert.match(agents, /no instruction overrides/i);
});

test('a receipt carrying findings and links parses through readLocalResult', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const bound = { ...f.binding, packetHash: prepared.packetHash };
  const findings = [
    { ref: 'f-obs', kind: 'OBSERVATION', title: 'input has two rows', body: 'the csv carries two data rows',
      evidenceRefs: [{ kind: 'OBJECT', id: sha('artifact-bytes') }] },
    { kind: 'RESULT', title: 'summary finished', body: 'summarized the input', supersedes: randomUUID() },
  ];
  const links = [{ from: 'f-obs', to: randomUUID(), kind: 'SUPPORTS', note: 'grounds the summary' }];
  report(f.dir, receipt(bound, prepared.packetHash, { findings, links }));
  const read = readLocalResult(f.dir, bound, f.io);
  assert.ok('value' in read, 'defect' in read ? read.defect : '');
  assert.deepEqual(read.value.result.findings, findings);
  assert.deepEqual(read.value.result.links, links);
  // A receipt without the sections is unchanged — and still verifies on the next sequence.
  report(f.dir, receipt(bound, prepared.packetHash, { sequence: 2 }));
  const plain = readLocalResult(f.dir, bound, f.io);
  assert.ok('value' in plain, 'defect' in plain ? plain.defect : '');
  assert.equal(plain.value.result.findings, undefined);
  assert.equal(plain.value.result.links, undefined);
});

test('CONTRACT-OPTIONAL.md documents findings/links with their kinds, bounds and the ref rule', t => {
  const f = fixture(t);
  prepare(f);
  const contract = readFileSync(path.join(f.dir, CONTRACT_OPTIONAL_FILE), 'utf8');
  assert.equal(contract, resultContractOptional());
  const core = readFileSync(path.join(f.dir, CONTRACT_FILE), 'utf8');
  assert.doesNotMatch(core, /OBSERVATION, HYPOTHESIS/, 'the optional sections no longer ride the core contract every session reads');
  for (const fragment of [
    '`findings`', '`links`', 'OBSERVATION', 'HYPOTHESIS', 'RESULT', 'DEFECT', 'DECISION', 'NOTE',
    'SUPPORTS', 'CONTRADICTS', 'RELATES', 'DUPLICATES', 'REFINES',
    'session-local', 'evidenceRefs', 'supersedes', '64', '100',
    'malformed entries', 'OBJECT', 'ASSIGNMENT', 'JOB', 'REQUEST',
  ]) assert.ok(contract.includes(fragment), `contract names ${fragment}`);
  // A `ref` is session-local and never a durable finding id — the rule is stated, not implied.
  assert.match(contract, /never a durable finding id/);
  // The evidence-surface variant names memorySearch and its per-hop authorization.
  const surfaced = resultContractV2({ evidenceSurface: true });
  assert.match(surfaced, /queryEvidence\|readEvidence\|stagePacket\|memorySearch/);
  assert.match(surfaced, /memory ledger/);
  assert.match(surfaced, /authorizes it per hop/);
  // The unmounted contract names the optional sections but drops the surface paragraph.
  assert.match(core, /`findings`/);
  assert.doesNotMatch(core, /memorySearch/);
});

test('finish.py writes a receipt the office reader verifies, advancing the sequence on a rewrite', async t => {
  const { spawnSync } = await import('node:child_process');
  const python = ['python', 'python3', 'py'].find(bin => spawnSync(bin, ['--version']).status === 0);
  if (!python) { t.skip('no Python on this machine'); return; }
  const f = fixture(t);
  const prepared = prepare(f);
  const bound = { ...f.binding, packetHash: prepared.packetHash };
  mkdirSync(path.join(f.dir, 'outputs', 'sub'), { recursive: true });
  writeFileSync(path.join(f.dir, 'outputs', 'report.md'), '# Report\n');
  writeFileSync(path.join(f.dir, 'outputs', 'sub', 'data.csv'), 'a\n1\n');
  const run = (...args: string[]) => spawnSync(python, [FINISH_FILE, ...args], { cwd: f.dir, encoding: 'utf8' });
  const first = run('COMPLETED', 'Summarized the input.');
  assert.equal(first.status, 0, first.stderr);
  const read = readLocalResult(f.dir, bound, f.io);
  assert.ok('value' in read, 'defect' in read ? read.defect : '');
  assert.deepEqual(read.value.result.outputs.map(item => item.path), ['outputs/report.md', 'outputs/sub/data.csv']);
  assert.equal(read.value.result.state, 'COMPLETED');
  assert.notEqual(readFileSync(path.join(f.dir, RESULT_FILE))[0], 0xef, 'no byte-order mark');
  const withReceipt = { ...bound, lastReceipt: { sequence: 1, hash: read.value.receiptHash, observedAt: at(2) } };
  writeFileSync(path.join(f.dir, 'extra.json'), JSON.stringify({ findings: [{ kind: 'NOTE', title: 'n', body: 'b' }] }));
  const second = run('COMPLETED', 'Revised.', '--extra', 'extra.json');
  assert.equal(second.status, 0, second.stderr);
  const reread = readLocalResult(f.dir, withReceipt, f.io);
  assert.ok('value' in reread, 'defect' in reread ? reread.defect : '');
  assert.equal(reread.value.result.sequence, 2);
  assert.equal(reread.value.result.findings?.[0].title, 'n');
  assert.notEqual(run('BOGUS', 'x').status, 0, 'an unknown state is refused');
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

/** A real store carrying a small memory ledger — the same data the caller passes as memoryDigest. */
function digestLedger(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-digest-ledger-'));
  const store = new OfficeStore(path.join(root, 'workspace.sqlite'));
  t.after(() => { try { store.close(); } catch {} removeTreeSync(root); });
  const project = store.execute({ type: 'project.create', idempotencyKey: randomUUID(), name: 'Alpha', mandate: 'm', budgetCents: 0 }).projects[0];
  const request = store.execute({ type: 'request.create', idempotencyKey: randomUUID(), projectId: project.id, name: 'R', hypothesis: 'h', workType: 'OTHER', mode: 'SINGLE', leadAgentId: null, participantIds: [] }).requests![0];
  return { store, project, request };
}

test('an authorized synthesis seat mounts the bounded memory digest and declares it on the packet', t => {
  const ledger = digestLedger(t);
  // One superseded finding, its live correction and a proposed link — the digest marks corrections.
  const prior = ledger.store.recordMemoryFinding({ projectId: ledger.project.id, requestId: ledger.request.id, assignmentId: null, kind: 'HYPOTHESIS', title: 'early guess', body: 'before the run', evidenceRefs: [], createdBy: { surface: 'USER' } }).finding;
  const correction = ledger.store.recordMemoryFinding({ projectId: ledger.project.id, requestId: ledger.request.id, assignmentId: null, kind: 'OBSERVATION', title: 'settled read', body: 'after the run', evidenceRefs: [{ kind: 'REQUEST', id: ledger.request.id }], createdBy: { surface: 'AGENT_SESSION', agentId: randomUUID(), receiptHash: sha('receipt') }, supersedesFindingId: prior.id }).finding;
  ledger.store.proposeMemoryRelationship({ projectId: ledger.project.id, fromFindingId: correction.id, toFindingId: prior.id, kind: 'REFINES', createdBy: { surface: 'OFFICE' } });
  const digest = ledger.store.memoryDigest(ledger.project.id);
  let priorBytes: Buffer | undefined;
  for (const seat of ['plan-synthesis', 'analysis-finalize']) {
    const f = fixture(t);
    f.assignment.pipelineKey = seat;
    // The digest names this packet's project — bind every id to the ledger's project.
    f.assignment.projectId = ledger.project.id; f.binding.projectId = ledger.project.id; f.snapshot.projectId = ledger.project.id;
    const prepared = prepareLocalPacket({ dir: f.dir, context: f.context, binding: f.binding, io: f.io, now: at(1), memoryDigest: digest });
    const onDisk = readFileSync(path.join(f.dir, MEMORY_DIGEST_FILE));
    const parsed = memoryDigestSchema.parse(JSON.parse(onDisk.toString('utf8')));
    assert.equal(parsed.schema, 'office-memory-digest@1');
    assert.equal(parsed.generatedAt, at(1));
    assert.deepEqual({ findings: parsed.findings, links: parsed.links }, digest, 'the file carries the store projection verbatim');
    assert.equal(parsed.findings.find(item => item.id === prior.id)!.superseded, true, 'superseded findings are marked, not hidden');
    // The written bytes are the schema-canonical serialization — key order is the schema's,
    // so the same ledger state hashes identically regardless of the rows' literal layout.
    assert.equal(onDisk.toString('utf8'), `${JSON.stringify(memoryDigestSchema.parse({ schema: 'office-memory-digest@1', generatedAt: at(1), ...digest }), null, 2)}\n`);
    const packet = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8')));
    assert.deepEqual(packet.memoryDigest, { path: MEMORY_DIGEST_FILE, findings: 2, relationships: 1, sha256: sha(onDisk) });
    assert.equal(prepared.packetHash, canonicalHash(JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8'))), 'the declaration rides inside the hashed packet; the digest bytes do not');
    const contract = readFileSync(path.join(f.dir, CONTRACT_FILE), 'utf8');
    assert.match(contract, /memory-digest\.json` is a bounded, point-in-time projection/);
    assert.match(contract, /self-report context for synthesis, not verified fact/);
    assert.match(contract, /cite\s+evidenceRefs when your findings draw on it/);
    if (priorBytes) assert.deepEqual(onDisk, priorBytes, 'the digest is deterministic for the same ledger state');
    priorBytes = onDisk;
  }
});

test('no other seat and no plain assignment carries the digest file or the declaration', t => {
  const ledger = digestLedger(t);
  const digest = ledger.store.memoryDigest(ledger.project.id);
  for (const [label, pipelineKey] of [['a non-synthesis pipeline hop', 'plan-draft-a'], ['a plain assignment', undefined]] as const) {
    const f = fixture(t);
    if (pipelineKey) f.assignment.pipelineKey = pipelineKey;
    prepareLocalPacket({ dir: f.dir, context: f.context, binding: f.binding, io: f.io, now: at(1), memoryDigest: digest });
    assert.equal(existsSync(path.join(f.dir, MEMORY_DIGEST_FILE)), false, `${label} must not write the digest file`);
    const packet = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8')));
    assert.equal(packet.memoryDigest, undefined, `${label} must not declare a digest`);
    assert.doesNotMatch(readFileSync(path.join(f.dir, CONTRACT_FILE), 'utf8'), /memory-digest/, `${label} must not mention the digest`);
  }
});

test('an empty ledger still produces a well-formed 0/0 digest for an authorized seat', t => {
  const ledger = digestLedger(t);
  const f = fixture(t);
  f.assignment.pipelineKey = 'analysis-finalize';
  f.assignment.projectId = ledger.project.id; f.binding.projectId = ledger.project.id; f.snapshot.projectId = ledger.project.id;
  prepareLocalPacket({ dir: f.dir, context: f.context, binding: f.binding, io: f.io, now: at(1), memoryDigest: ledger.store.memoryDigest(ledger.project.id) });
  const parsed = memoryDigestSchema.parse(JSON.parse(readFileSync(path.join(f.dir, MEMORY_DIGEST_FILE), 'utf8')));
  assert.deepEqual(parsed.findings, []);
  assert.deepEqual(parsed.links, []);
  const packet = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8')));
  assert.equal(packet.memoryDigest!.findings, 0);
  assert.equal(packet.memoryDigest!.relationships, 0);
});

test('a BLIND packet withholds matching paths hash-only; bytes are never staged', t => {
  const f = fixture(t);
  f.assignment.inputScope = 'BLIND';
  f.context.withheldPaths = ['data']; // a project-relative prefix withholds everything under it
  const prepared = prepare(f);
  const packet = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8')));
  // data/input.csv is declared under withheld with the manifest's own identity — never staged.
  assert.deepEqual(packet.withheld, [{ path: 'data/input.csv', sha256: sha('a,b\n1,2\n'), bytes: Buffer.byteLength('a,b\n1,2\n') }]);
  assert.deepEqual(packet.files.map(file => file.path), ['inputs/notes.txt'], 'only the non-withheld file is declared as staged input');
  assert.equal(existsSync(path.join(f.dir, INPUTS_DIR, 'data', 'input.csv')), false, 'withheld bytes never enter the packet');
  assert.equal(existsSync(path.join(f.dir, INPUTS_DIR, 'notes.txt')), true);
  // Blinding narrows the packet, not the manifest: the frozen snapshot identity is untouched.
  assert.equal(packet.snapshotManifestHash, f.snapshot.manifestHash);
  assert.equal(prepared.packetHash, canonicalHash(JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8'))));
  // The contract forbids computing or requesting outcome metrics — only where files are withheld.
  const contract = readFileSync(path.join(f.dir, CONTRACT_FILE), 'utf8');
  assert.match(contract, /Outcome files listed under `withheld` are intentionally unavailable/);
  assert.match(contract, /Do not compute,\s+estimate or request outcome metrics/);
  assert.match(contract, /Fix thresholds and decision rules only/);
});

test('an exact withheld path blinds that file alone; a trailing-slash prefix is equivalent', t => {
  const exact = fixture(t);
  exact.assignment.inputScope = 'BLIND';
  exact.context.withheldPaths = ['notes.txt'];
  prepare(exact);
  const exactPacket = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(exact.dir, PACKET_FILE), 'utf8')));
  assert.deepEqual(exactPacket.withheld, [{ path: 'notes.txt', sha256: sha('fixture notes'), bytes: Buffer.byteLength('fixture notes') }]);
  assert.deepEqual(exactPacket.files.map(file => file.path), ['inputs/data/input.csv']);
  assert.equal(existsSync(path.join(exact.dir, INPUTS_DIR, 'notes.txt')), false);
  const slashed = fixture(t);
  slashed.assignment.inputScope = 'BLIND';
  slashed.context.withheldPaths = ['data/']; // a stored prefix with a trailing slash withholds identically
  prepare(slashed);
  const slashedPacket = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(slashed.dir, PACKET_FILE), 'utf8')));
  assert.deepEqual(slashedPacket.withheld, [{ path: 'data/input.csv', sha256: sha('a,b\n1,2\n'), bytes: Buffer.byteLength('a,b\n1,2\n') }]);
});

test('FULL scope and an absent scope stage the withheld paths as ordinary inputs', t => {
  for (const [label, scope] of [['FULL', 'FULL'], ['unspecified', undefined]] as const) {
    const f = fixture(t);
    if (scope) f.assignment.inputScope = scope;
    f.context.withheldPaths = ['data'];
    prepare(f);
    const packet = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8')));
    assert.equal(packet.withheld, undefined, `${label} declares nothing`);
    assert.equal(packet.files.length, 2, `${label} stages every snapshot file`);
    assert.equal(existsSync(path.join(f.dir, INPUTS_DIR, 'data', 'input.csv')), true);
    assert.doesNotMatch(readFileSync(path.join(f.dir, CONTRACT_FILE), 'utf8'), /withheld/, `${label} keeps the contract unchanged`);
  }
});

test('a BLIND hop on a project with no withheld paths stages everything and declares nothing', t => {
  const f = fixture(t);
  f.assignment.inputScope = 'BLIND';
  prepare(f);
  const packet = localPacketV2Schema.parse(JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8')));
  assert.equal(packet.withheld, undefined);
  assert.equal(packet.files.length, 2);
  assert.doesNotMatch(readFileSync(path.join(f.dir, CONTRACT_FILE), 'utf8'), /withheld/);
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

test('inherited outputs stage under their hop key; a key two jobs claim falls back to the job id', t => {
  const f = fixture(t);
  const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
  const item = (name: string, sourceJobId: string, sourceKey?: string) => {
    const data = bytes(`${name} from ${sourceJobId}`);
    return { name, bytes: data, sourceJobId, objectHash: sha(data), ...(sourceKey ? { sourceKey } : {}) };
  };
  f.context.inherited = [item('outputs/plan.md', first, 'plan-draft-a'), item('outputs/notes.md', first, 'plan-draft-a'), item('outputs/plan.md', second, 'plan-draft-a'), item('outputs/brief.md', third)];
  const prepared = prepare(f);
  const paths = prepared.packet.inherited!.map(entry => entry.path);
  assert.deepEqual(paths, [
    'inputs/inherited/plan-draft-a/plan.md', 'inputs/inherited/plan-draft-a/notes.md',
    `inputs/inherited/${second}/plan.md`, `inputs/inherited/${third}/brief.md`,
  ]);
  assert.equal(prepared.packet.inherited![0].sourceKey, 'plan-draft-a', 'the manifest records the hop key beside the job id');
  assert.equal(readFileSync(path.join(f.dir, paths[0]), 'utf8'), `outputs/plan.md from ${first}`);
});

test('the prompt block carries the receipt identity, input shapes and a wide-column warning without touching the packet hash', t => {
  const f = fixture(t);
  const prepared = prepare(f);
  const block = packetPromptBlock(prepared);
  assert.match(block, /^## Packet essentials \(office-generated\)/);
  assert.ok(block.includes(`"packetHash":"${prepared.packetHash}"`), 'the packet hash — not in packet.json — rides the prompt');
  assert.ok(block.includes(`"jobId":"${f.binding.jobId}"`) && block.includes(`"attemptId":"${f.binding.attemptId}"`));
  assert.match(block, /- inputs\/data\/input\.csv \(8 bytes\) — 1 data row \(line count\); columns: a, b/);
  assert.match(block, /- inputs\/notes\.txt \(13 bytes\)$/m);
  assert.doesNotMatch(block, /Deliverable: the revised/);
  assert.match(packetPromptBlock(prepared, 'brief-refine-2'), /Deliverable: the revised `outputs\/brief\.md`/);
  assert.equal(canonicalHash(JSON.parse(readFileSync(path.join(f.dir, PACKET_FILE), 'utf8'))), prepared.packetHash, 'the summaries are prompt context, never packet identity');
  const wide = tabularSummary('inputs/bars.csv', bytes(`time,close,footprint\n2026-05-05,1.4,"{""1.4"": ${'1'.repeat(200)}}"\n2026-05-06,1.5,"{}"\n`));
  assert.match(wide!, /^2 data rows \(line count\); columns: time, close, footprint; wide columns — select columns instead of printing whole rows: footprint \(~2\d\d chars\)$/);
  assert.equal(tabularSummary('inputs/readme.md', bytes('a,b\n')), null, 'only .csv/.tsv inputs are summarized');
});
