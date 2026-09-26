import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { git, init } from './parallel.mjs';
import { setup, publish, start, finish, block, review, accept, reject, reopen, close, status } from './desktop.mjs';

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'qro-desktop-test-')), repo = join(temp, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'README.md'), 'fixture\n'); writeFileSync(join(repo, '.gitignore'), '/.session.json\n/SESSION.md\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
  const root = init(repo, 'desktop', 7, 'main'); setup(root);
  return { temp, repo, root, organizer: join(root, 'organizer'), w: n => join(root, `worker-${n}`) };
}
function plan(id = 'round-001', count = 2) {
  return { id, request: 'Synthetic desktop coordination regression.', workers: Array.from({ length: 7 }, (_, i) => i < count ? {
    id: `worker-${i + 1}`, mode: 'CODE', objective: `Create fixture ${i + 1}`, allowedPaths: [`ui/${i + 1}.js`],
    readPaths: ['README.md'], steps: ['Write a valid fixture module.'], acceptance: ['Module syntax is valid.'], checks: [`node --check ui/${i + 1}.js`]
  } : { id: `worker-${i + 1}`, mode: 'IDLE', objective: 'No independent fixture task.' }) };
}
function commitFile(cwd, file, content) {
  mkdirSync(join(cwd, 'ui'), { recursive: true }); writeFileSync(join(cwd, file), content);
  git(cwd, 'add', '--', file); git(cwd, 'commit', '-m', 'fixture edit'); return git(cwd, 'rev-parse', 'HEAD');
}
function report(cwd, n, round = 'round-001') {
  execFileSync(process.execPath, ['--check', `ui/${n}.js`], { cwd });
  return { round, summary: 'Synthetic fixture module added.', checks: [{ command: `node --check ui/${n}.js`, exitCode: 0, result: 'Node syntax check passed.' }],
    acceptance: [{ criterion: 'Module syntax is valid.', passed: true, evidence: 'Executed Node syntax check.' }], roadmapEntry: 'Synthetic test report; not application verification.' };
}
test('seven concurrent starts, immutable submissions, exact review, integration and next round', async () => {
  const f = fixture();
  try {
    assert.equal(setup(f.root).sessions, 8);
    assert.equal(start(f.w(1)).state, 'NOT_READY');
    assert.throws(() => publish(f.w(1), plan()), /Only Session 8/);
    assert.throws(() => publish(f.organizer, plan('idle', 0)), /actual work/);
    const overlap = plan(); overlap.workers[1].allowedPaths = ['ui/1.js'];
    assert.throws(() => publish(f.organizer, overlap), /Overlapping/);
    const incomplete = plan(); incomplete.workers.pop(); assert.throws(() => publish(f.organizer, incomplete), /seven/);
    const protectedTask = plan(); protectedTask.workers[0].allowedPaths = ['tools/']; assert.throws(() => publish(f.organizer, protectedTask), /Organizer-owned/);
    writeFileSync(join(f.w(1), 'dirty.txt'), 'preserve'); assert.throws(() => publish(f.organizer, plan()), /Uncommitted/);
    // This is a disposable test-only file, never user work.
    rmSync(join(f.w(1), 'dirty.txt'));
    const ready = publish(f.organizer, plan()); assert.equal(ready.state, 'WORK_READY');
    const cli = resolve(import.meta.dirname, 'desktop.mjs');
    const starts = await Promise.all(Array.from({ length: 7 }, (_, i) => promisify(execFile)(process.execPath, [cli, 'start'], { cwd: f.w(i + 1) })));
    assert.deepEqual(starts.map(s => JSON.parse(s.stdout).state), ['RUNNING', 'RUNNING', 'IDLE', 'IDLE', 'IDLE', 'IDLE', 'IDLE']);
    assert.equal(start(f.w(1)).resume, true);
    assert.throws(() => publish(f.organizer, plan('round-002')), /Close the previous/);
    assert.throws(() => close(f.organizer, {}), /Every worker/);
    const sha1 = commitFile(f.w(1), 'ui/1.js', 'module.exports = 1;\n');
    const r1 = report(f.w(1), 1);
    assert.throws(() => finish(f.w(1), { ...r1, round: 'stale-round' }), /Stale result/);
    assert.throws(() => finish(f.w(1), { ...r1, checks: [{ command: 'different check', result: 'PASS', exitCode: 0 }] }), /Required check missing/);
    finish(f.w(1), r1); assert.equal(start(f.w(1)).state, 'READY_FOR_REVIEW');
    assert.throws(() => finish(f.w(1), r1), /already submitted/);
    const sha2 = commitFile(f.w(2), 'ui/2.js', 'module.exports = 2;\n'); finish(f.w(2), report(f.w(2), 2));
    const before = git(f.organizer, 'rev-parse', 'HEAD');
    const a1 = { round: ready.round, workerSha: sha1, againstHead: before, summary: 'Reviewed actual synthetic diff.', checks: r1.checks, compatibility: ['Module is independent of fixture baseline.'] };
    assert.throws(() => accept(f.organizer, 'worker-1', sha2, a1), /exact submitted SHA/);
    assert.throws(() => accept(f.organizer, 'worker-1', sha1, { ...a1, againstHead: 'stale' }), /changed since review/);
    assert.equal(accept(f.organizer, 'worker-1', sha1, a1).state, 'INTEGRATED');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), before, 'stable main never moved');
    commitFile(f.w(2), 'ui/2.js', 'module.exports = 3;\n');
    assert.match(review(f.organizer).workers[1].scope, /moved after submission/);
    assert.throws(() => accept(f.organizer, 'worker-2', sha2, { ...a1, workerSha: sha2, againstHead: git(f.organizer, 'rev-parse', 'HEAD') }), /moved after submission/);
    reject(f.organizer, 'worker-2', 'Commit changed after submission; repair in a new round.');
    const head = git(f.organizer, 'rev-parse', 'HEAD');
    const combined = { round: ready.round, head, summary: 'Synthetic combined fixture checked.', roadmapEntry: 'Synthetic regression only.',
      checks: ['unit', 'typecheck', 'build'].map(kind => ({ kind, command: 'node --check ui/1.js', exitCode: 0, result: 'Synthetic syntax fixture; no product validation claimed.' })) };
    execFileSync(process.execPath, ['--check', 'ui/1.js'], { cwd: f.organizer });
    assert.throws(() => close(f.organizer, { ...combined, head: before }), /current round and organizer HEAD/);
    const closed = close(f.organizer, combined); assert.match(closed.instruction, /Merge only through that PR/); assert.match(closed.instruction, /Never push directly to main/); assert.equal(start(f.w(1)).state, 'CLOSED');
    const next = publish(f.organizer, plan('round-002', 1)); assert.equal(next.base, head);
    assert.equal(git(f.w(2), 'show', `${sha2}:ui/2.js`), 'module.exports = 2;', 'rejected work remains recoverable in Git');
    assert.equal(start(f.w(1)).round, 'round-002');
    assert.throws(() => finish(f.w(1), r1), /Stale result/);
    block(f.w(1), 'Synthetic dependency blocker.'); assert.equal(start(f.w(1)).state, 'BLOCKED');
    assert.equal(status(f.w(7)).session, 7);
    const roundFile = join(f.root, 'rounds', 'round-002', 'round.json'); writeFileSync(roundFile, readFileSync(roundFile, 'utf8') + ' ');
    assert.throws(() => start(f.w(1)), /Published packet changed/);
  } finally { rmSync(f.temp, { recursive: true, force: true }); }
});
test('partial publication waits; failed checks and out-of-scope work cannot be submitted', () => {
  const f = fixture();
  try {
    publish(f.organizer, plan('round-001', 1));
    const pointer = join(f.root, 'current.json'), original = JSON.parse(readFileSync(pointer));
    writeFileSync(pointer, JSON.stringify({ ...original, phase: 'PREPARING' })); assert.equal(start(f.w(1)).state, 'PREPARING');
    writeFileSync(pointer, JSON.stringify(original)); start(f.w(1));
    commitFile(f.w(1), 'ui/1.js', 'module.exports = 1;\n'); const r = report(f.w(1), 1);
    assert.throws(() => finish(f.w(1), { ...r, checks: [{ ...r.checks[0], exitCode: 1 }] }), /failed/);
    commitFile(f.w(1), 'README.md', 'out of scope\n'); assert.throws(() => finish(f.w(1), r), /Out-of-scope/);
    assert.equal(review(f.organizer).workers[0].state, 'RUNNING');
    block(f.w(1), 'Needs organizer scope correction.'); reject(f.organizer, 'worker-1', 'Preserve changes and scope a new task.');
    assert.equal(review(f.organizer).workers[0].state, 'REJECTED');
  } finally { rmSync(f.temp, { recursive: true, force: true }); }
});
test('reopen re-arms a rejected worker for a fix and resubmission, archiving the rejection', () => {
  const f = fixture();
  try {
    publish(f.organizer, plan('round-001', 1));
    assert.throws(() => reopen(f.organizer, 'worker-1', 'not yet submitted'), /Only a REJECTED/);
    start(f.w(1)); commitFile(f.w(1), 'ui/1.js', 'module.exports = 1;\n');
    assert.throws(() => finish(f.w(1), { ...report(f.w(1), 1), checks: [{ ...report(f.w(1), 1).checks[0], exitCode: 1 }] }), /failed/);
    finish(f.w(1), report(f.w(1), 1));
    const rejectedSha = git(f.w(1), 'rev-parse', 'HEAD');
    reject(f.organizer, 'worker-1', 'Fix the thing.');
    assert.equal(review(f.organizer).workers[0].state, 'REJECTED');
    assert.throws(() => finish(f.w(1), report(f.w(1), 1)), /already submitted|Cannot replace/);
    const opened = reopen(f.organizer, 'worker-1', 'Accepted after fix expected.');
    assert.equal(opened.state, 'RUNNING');
    const archived = join(f.root, 'rounds', 'round-001', 'decisions', `worker-1-rejected-${rejectedSha.slice(0, 7)}.json`);
    assert.equal(readFileSync(archived, 'utf8').includes('REJECTED'), true, 'rejection evidence preserved');
    assert.equal(review(f.organizer).workers[0].state, 'RUNNING');
    commitFile(f.w(1), 'ui/1.js', 'module.exports = 2;\n');
    finish(f.w(1), report(f.w(1), 1));
    assert.equal(review(f.organizer).workers[0].state, 'READY_FOR_REVIEW');
    assert.throws(() => reopen(f.organizer, 'worker-1', 'again'), /Only a REJECTED/);
  } finally { rmSync(f.temp, { recursive: true, force: true }); }
});
