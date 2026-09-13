import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, init, assign, check, status, validateTask } from './parallel.mjs';

const task = { objective: 'Update a fixture', allowedPaths: ['ui/'], acceptance: ['Fixture behaves as specified.'] };
test('ownership refuses protected paths, traversal and overlapping prefixes', () => {
  for (const p of ['app/src/', 'app/src/shared/types.ts', 'APP/SRC/SHARED/types.ts', 'docs/ROADMAP.md', '../x', 'C:/x', 'ui/*', '.git/config', '.GIT/config']) {
    assert.throws(() => validateTask({ ...task, allowedPaths: [p] }));
  }
  assert.throws(() => validateTask(task, [{ allowedPaths: ['ui/components/'] }]));
  assert.throws(() => validateTask(task, [{ allowedPaths: ['UI/components/'] }]));
  assert.doesNotThrow(() => validateTask(task, [{ allowedPaths: ['ui-other/'] }]));
  assert.throws(() => validateTask({ ...task, acceptance: [] }));
});
test('batch isolation, frozen base, duplicate refusal and final diff scope checks', () => {
  const temp = mkdtempSync(join(tmpdir(), 'qro-parallel-test-'));
  try {
    const repo = join(temp, 'repo'); mkdirSync(repo);
    git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(repo, 'README.md'), 'fixture\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
    const base = git(repo, 'rev-parse', 'HEAD');
    assert.throws(() => init(repo, '../bad', 7, 'main'));
    assert.throws(() => init(repo, 'bad-count', 8, 'main'));
    const root = init(repo, 'test', 7, 'main');
    assert.equal(status(root).length, 8);
    assert.throws(() => init(repo, 'test', 7, 'main'));
    assign(root, 'worker-1', task);
    assert.throws(() => assign(root, 'worker-2', task));
    const w = join(root, 'worker-1'); mkdirSync(join(w, 'ui'));
    writeFileSync(join(w, 'ui', 'a.txt'), 'first\n');
    assert.throws(() => check(root, 'worker-1'));
    git(w, 'add', '.'); git(w, 'commit', '-m', 'worker');
    assert.equal(check(root, 'worker-1').scope, 'PASS');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
    writeFileSync(join(w, 'README.md'), 'outside ownership\n'); git(w, 'add', '.'); git(w, 'commit', '-m', 'outside');
    assert.throws(() => check(root, 'worker-1'), /Out-of-scope/);
    assert.equal(status(root)[2].assigned, false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
