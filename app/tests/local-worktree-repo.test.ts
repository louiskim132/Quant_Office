import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeTreeSync } from '../src/main/fsx';
import { createWorktree, ensureRepo, listWorktrees, removeWorktreeRegistration } from '../src/main/local-worktree-repo';

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture(t: test.TestContext) {
 const root = mkdtempSync(path.join(tmpdir(), 'qro-worktree-repo-'));
 t.after(() => removeTreeSync(root));
 // These tests run real git against real repositories; the assumption is asserted, not skipped.
 assert.match(execFileSync('git', ['--version'], { encoding: 'utf8' }), /git version/, 'git must be on PATH for the worktree lane tests');
 const reposRoot = path.join(root, 'repos');
 const projectId = `proj-${randomUUID().slice(0, 8)}`;
 return { root, reposRoot, projectId, repoDir: path.join(reposRoot, projectId) };
}

test('ensureRepo creates a repo with one office-named initial commit and is idempotent', async t => {
 const f = fixture(t);
 const dir = await ensureRepo(f.reposRoot, f.projectId);
 assert.equal(dir, f.repoDir);
 assert.ok(existsSync(path.join(dir, '.git')), 'a real repository was initialized');
 assert.match(git(['log', '--format=%s'], dir), /Quant Research Office/, 'the initial commit names the office');
 // The one commit exists so worktrees have a HEAD to detach from; a second ensure adds nothing.
 await ensureRepo(f.reposRoot, f.projectId);
 assert.equal(git(['rev-list', '--count', 'HEAD'], dir), '1');
});

test('createWorktree materializes a detached worktree registered with the project repo', async t => {
 const f = fixture(t);
 const dir = await createWorktree(f.reposRoot, f.projectId, 'session-alpha');
 assert.equal(dir, path.join(f.repoDir, 'worktrees', 'session-alpha'));
 assert.ok(existsSync(dir));
 assert.ok(existsSync(path.join(dir, '.git')), 'a worktree directory carries its .git gitlink');
 const entries = await listWorktrees(f.repoDir);
 const registered = entries.find(entry => entry.path === dir);
 assert.ok(registered, 'git worktree list registers the new directory');
 assert.equal(registered.detached, true, 'no branch is created for a session worktree');
 assert.equal(registered.branch, null);
 assert.match(git(['worktree', 'list', '--porcelain'], f.repoDir), /session-alpha/, 'git itself agrees');
 // The worktree shares the repo's single commit as its HEAD.
 assert.equal(registered.head, git(['rev-parse', 'HEAD'], f.repoDir));
});

test('removeWorktreeRegistration drops a moved-away worktree without touching its bytes', async t => {
 const f = fixture(t);
 const dir = await createWorktree(f.reposRoot, f.projectId, 'session-beta');
 const moved = path.join(f.root, 'moved-session-beta');
 renameSync(dir, moved);
 assert.ok((await listWorktrees(f.repoDir)).some(entry => entry.path === dir), 'the registration is stale while it still points at the old path');
 await removeWorktreeRegistration(f.repoDir);
 assert.ok(!(await listWorktrees(f.repoDir)).some(entry => entry.path === dir), 'pruning drops the stale registration');
 assert.ok(existsSync(moved), 'the moved directory keeps every byte — only the registration was dropped');
});

test('unsafe worktree names are refused before git ever runs', async t => {
 const f = fixture(t);
 for (const name of ['', '.', '..', '../escape', 'nested/name', 'back\\slash', 'trail ', 'con', 'mid:dle'])
  await assert.rejects(createWorktree(f.reposRoot, f.projectId, name), /not a safe directory name/, JSON.stringify(name));
 assert.equal(existsSync(f.repoDir), false, 'no repository was initialized and no worktree directory exists');
 // The project id becomes a path segment too, so it is held to the same rule.
 await assert.rejects(ensureRepo(f.reposRoot, '../escape'), /not a safe repository directory name/);
});

test('missing and empty repositories report rather than throw', async t => {
 const f = fixture(t);
 assert.deepEqual(await listWorktrees(f.repoDir), [], 'a repo that was never created lists no worktrees');
 await removeWorktreeRegistration(f.repoDir);
 // A fresh repo with no worktrees beyond its own root still parses cleanly.
 await ensureRepo(f.reposRoot, f.projectId);
 const entries = await listWorktrees(f.repoDir);
 assert.equal(entries.length, 1, 'the repo root itself is the only registered worktree');
 assert.equal(entries[0].path, f.repoDir);
});
