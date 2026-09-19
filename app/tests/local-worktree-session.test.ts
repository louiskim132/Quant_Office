import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeTreeSync } from '../src/main/fsx';
import { buildProviderPayload, type SubmitContext } from '../src/main/controller';
import { AGENTS_FILE, CANCEL_FILE, CONTRACT_FILE, PACKET_FILE, RESULT_FILE } from '../src/main/local-session';
import { LocalWorktreeMailboxAdapter } from '../src/main/local-worktree-session';
import type { Assignment, InputSnapshot, ProviderJob } from '../src/shared/types';

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, 0) + minutes * 60000).toISOString();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function fixture(t: test.TestContext) {
 const root = mkdtempSync(path.join(tmpdir(), 'qro-worktree-session-'));
 t.after(() => removeTreeSync(root));
 // These tests run real git against real repositories; the assumption is asserted, not skipped.
 assert.match(execFileSync('git', ['--version'], { encoding: 'utf8' }), /git version/, 'git must be on PATH for the worktree lane tests');
 // A staged snapshot tree whose declared hashes match the bytes on disk.
 const staging = path.join(root, 'staging');
 mkdirSync(path.join(staging, 'data'), { recursive: true });
 writeFileSync(path.join(staging, 'data', 'input.csv'), 'a,b\n1,2\n');
 writeFileSync(path.join(staging, 'notes.txt'), 'fixture notes');
 const projectId = randomUUID();
 const snapshot: InputSnapshot = {
  id: randomUUID(), projectId, requestId: randomUUID(), locationRevision: 0, requestRevision: 1,
  route: 'SELECTED_FILES_GIT_SNAPSHOT',
  files: [
   { path: 'data/input.csv', bytes: Buffer.byteLength('a,b\n1,2\n'), sha256: sha('a,b\n1,2\n') },
   { path: 'notes.txt', bytes: Buffer.byteLength('fixture notes'), sha256: sha('fixture notes') },
  ],
  totalBytes: Buffer.byteLength('a,b\n1,2\n') + Buffer.byteLength('fixture notes'),
  manifestHash: sha('manifest'), stagingCommit: 'fixture-commit', stagingPath: staging,
  warnings: [], provenance: 'OFFICE_STAGED', createdAt: at(0),
 };
 const reposRoot = path.join(root, 'repos');
 const adapter = new LocalWorktreeMailboxAdapter(() => reposRoot, () => at(1));
 const assignment: Assignment = {
  id: randomUUID(), projectId, requestId: snapshot.requestId!, requestRevision: 1,
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
  id: randomUUID(), assignmentId: assignment.id, projectId, requestId: assignment.requestId,
  provider: 'devin', route: 'LOCAL_MAILBOX', state: 'ACCEPTED', evidence: 'PROVIDER_REPORTED', detail: '',
  externalId, externalUrl: '', outputs: [], revision: 0, createdAt: at(0), updatedAt: at(0), dispatchedAt: at(0), settledAt: '',
 });
 const repoDir = path.join(reposRoot, projectId);
 const sessionDir = (externalId: string) => path.join(repoDir, 'worktrees', externalId);
 return { root, staging, reposRoot, repoDir, projectId, snapshot, adapter, assignment, context, job, sessionDir };
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

test('the adapter stays on LOCAL_MAILBOX and carries every local provider', async t => {
 const f = fixture(t);
 assert.equal(f.adapter.route, 'LOCAL_MAILBOX');
 assert.deepEqual([...f.adapter.providers!].sort(), ['claude', 'devin', 'openai']);
});

test('submit writes the identical packet contract into a real worktree of the project repo', async t => {
 const f = fixture(t);
 const result = await f.adapter.submit(f.context);
 assert.match(result.externalId, /^session-/);
 const dir = f.sessionDir(result.externalId);
 // The session directory is a registered detached worktree, not a plain folder.
 assert.ok(existsSync(path.join(dir, '.git')), 'the packet directory is a git worktree');
 assert.match(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: f.repoDir, encoding: 'utf8' }), new RegExp(result.externalId),
  'git worktree list registers the packet directory');
 for (const file of [PACKET_FILE, CONTRACT_FILE, AGENTS_FILE])
  assert.ok(existsSync(path.join(dir, file)), `${file} is present`);
 const packet = JSON.parse(readFileSync(path.join(dir, PACKET_FILE), 'utf8'));
 assert.equal(packet.schema, 'office-local-session@1');
 assert.equal(packet.assignmentId, f.assignment.id);
 assert.equal(packet.requestName, 'Tiny local task');
 assert.equal(packet.payload, f.context.payload.text);
 assert.equal(packet.contract, CONTRACT_FILE);
 assert.equal(packet.files.length, 2);
 for (const file of packet.files) {
  const bytes = readFileSync(path.join(dir, file.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  assert.equal(bytes.byteLength, file.bytes);
 }
 const contract = readFileSync(path.join(dir, CONTRACT_FILE), 'utf8');
 assert.match(contract, /result\.json/);
 assert.match(readFileSync(path.join(dir, AGENTS_FILE), 'utf8'), /CONTRACT\.md/);
 assert.match(result.detail, /worktree/);
 assert.match(result.detail, /awaits a local session/);
});

test('observe, cancel and fetch behave identically to the base adapter on a reported result', async t => {
 const f = fixture(t);
 const { externalId } = await f.adapter.submit(f.context);
 const dir = f.sessionDir(externalId);
 const job = f.job(externalId);
 let observed = await f.adapter.observe(job);
 assert.equal(observed.state, 'UNKNOWN');
 assert.equal(observed.provenance, 'OFFICE_LOCAL');
 const output = { path: 'out/summary.json', sha256: sha('{"summary":"done"}'), bytes: Buffer.byteLength('{"summary":"done"}') };
 report(dir, { state: 'COMPLETED', detail: 'The worktree session finished.', outputs: [output] }, { 'out/summary.json': '{"summary":"done"}' });
 observed = await f.adapter.observe(job);
 assert.equal(observed.state, 'COMPLETED');
 assert.equal(observed.provenance, 'PROVIDER_REPORTED');
 assert.deepEqual(observed.outputs, [output]);
 assert.equal(Buffer.from(await f.adapter.fetch(job, output)).toString('utf8'), '{"summary":"done"}');
 const cancelled = await f.adapter.cancel(job);
 assert.equal(cancelled.acknowledged, true);
 assert.match(cancelled.detail, /Local session ended by the office/);
 assert.match(cancelled.detail, /not a provider acknowledgement/);
 const sentinel = JSON.parse(readFileSync(path.join(dir, CANCEL_FILE), 'utf8'));
 assert.equal(sentinel.jobId, job.id);
 assert.equal((await f.adapter.cancelEvidence(job)).length, 1);
 assert.equal(f.adapter.cancelEvidence(job)[0].operation, 'LOCAL_CANCEL');
});

test('submit evidence declares the shared-root worktree scope honestly', async t => {
 const f = fixture(t);
 const submitted = await f.adapter.submit(f.context);
 const entries = f.adapter.submitEvidence(f.context, submitted);
 assert.deepEqual(entries.map(entry => entry.operation), ['LOCAL_SUBMIT', 'TOOL_CONFINEMENT', 'DELEGATION_CONTROL']);
 // Every scope field stays the base adapter's; only the confinement declaration changes lanes.
 for (const entry of entries) {
  assert.equal(entry.level, 'TOOL_SUPPORTED');
  assert.equal(entry.evidence, 'OBSERVED');
  assert.equal(entry.route, 'LOCAL_MAILBOX');
  assert.equal(entry.environment, 'LOCAL_MACHINE');
  assert.equal(entry.source, 'office-local-mailbox@1');
 }
 const confinement = entries[1].confinement!;
 assert.match(confinement.filesystem, /shared project-root worktree/);
 assert.match(confinement.filesystem, /sibling session worktrees of this office project are readable/);
 assert.match(confinement.filesystem, /routine-work lane, sealed reviews use the isolated lane/);
 assert.match(entries[1].detail, /shared session repo/);
 assert.equal(entries[2].delegation, false);
});

test('a recorded externalId can never point outside the worktrees root', async t => {
 const f = fixture(t);
 for (const externalId of ['', '../escape', 'a/b', 'never-created']) {
  const observed = await f.adapter.observe(f.job(externalId));
  assert.equal(observed.state, 'UNKNOWN');
  assert.equal(observed.provenance, 'OFFICE_LOCAL');
 }
 // The vacuous cancel paths behave exactly as the base adapter's.
 const unrecorded = await f.adapter.cancel(f.job(''));
 assert.equal(unrecorded.acknowledged, true);
 assert.match(unrecorded.detail, /No session was ever recorded/);
 const escaped = await f.adapter.cancel(f.job('../escape'));
 assert.equal(escaped.acknowledged, true);
 assert.match(escaped.detail, /No session was ever recorded/);
});

test('sessions are partitioned per office project repo — another project never sees this session dir', async t => {
 const f = fixture(t);
 const { externalId } = await f.adapter.submit(f.context);
 const foreign: ProviderJob = { ...f.job(externalId), projectId: randomUUID() };
 const observed = await f.adapter.observe(foreign);
 assert.equal(observed.state, 'UNKNOWN');
 assert.equal(observed.provenance, 'OFFICE_LOCAL');
 const cancelled = await f.adapter.cancel(foreign);
 assert.equal(cancelled.acknowledged, false, 'a session dir under a different project root is gone from that root');
});

test('a staged input that drifted fails the submit loudly, worktree or not', async t => {
 const f = fixture(t);
 writeFileSync(path.join(f.staging, 'notes.txt'), 'changed after freezing');
 await assert.rejects(f.adapter.submit(f.context), /no longer matches the bytes that were frozen/);
});
