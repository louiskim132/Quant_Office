import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { safeEntry } from './artifacts.js';

/**
 * One git repository per office project, holding every local-session worktree for that project
 * under a caller-injected root. This is the mechanism behind "one provider project, session per
 * worktree": each session packet directory is a detached worktree of its project's repo, so
 * sibling sessions share the project root's history without sharing one mutable directory.
 *
 * Every git invocation goes through execFile with an argument array — never a shell — under the
 * same hardened configuration the snapshot staging path applies: hooks, templates, filters,
 * credential helpers and any network protocol are switched off, GIT_* environment is dropped,
 * and system/global config is unread. Nothing here ever deletes bytes: pruning drops stale
 * registrations only, and the directories themselves are the caller's problem.
 */

/** Session worktrees of one project repo all live under this single directory. */
export const WORKTREES_DIR = 'worktrees';
/** The initial commit exists because worktrees need at least one commit to detach from. */
const INITIAL_COMMIT = 'Quant Research Office session-worktree root';
/** Configuration forced on every invocation, mirroring the staging path's safety posture. */
const GIT_SAFETY = [
  '-c',
  'core.hooksPath=',
  '-c',
  'init.templateDir=',
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.symlinks=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'core.attributesFile=',
  '-c',
  'core.excludesFile=',
  '-c',
  'core.sshCommand=',
  '-c',
  'credential.helper=',
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.clean=',
  '-c',
  'filter.lfs.process=',
  '-c',
  'gc.auto=0',
];
/** The initial commit's identity is declared here, never borrowed from machine config. */
const COMMIT_IDENTITY = ['-c', 'user.email=office@localhost', '-c', 'user.name=Quant Research Office'];

/** A repo or worktree name is one safe directory name — never a path, never traversal. */
function safeSegment(name: string): boolean {
  return safeEntry(name) && !name.includes('/');
}

function repoDir(reposRoot: string, projectId: string): string {
  if (!safeSegment(projectId))
    throw new Error(`The office project id ${JSON.stringify(projectId)} is not a safe repository directory name.`);
  return path.join(reposRoot, projectId);
}

/** The directory every session worktree of one office project is registered under. */
export function worktreesRoot(reposRoot: string, projectId: string): string {
  return path.join(repoDir(reposRoot, projectId), WORKTREES_DIR);
}

/** git runs with the machine's GIT_* variables removed and all user configuration switched off. */
function gitEnvironment(cwd: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  );
  return {
    ...inherited,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    HOME: cwd,
    USERPROFILE: cwd,
    XDG_CONFIG_HOME: cwd,
  };
}

function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve =>
    execFile(
      'git',
      [...GIT_SAFETY, ...args],
      { cwd, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024, env: gitEnvironment(cwd) },
      (error, stdout, stderr) =>
        resolve({ ok: !error, out: String(stdout || stderr || (error?.message ?? '')).trim() }),
    ),
  );
}

/** A git invocation that must succeed; the thrown error names the exact command that failed. */
async function gitOrThrow(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.out || 'unknown git failure'}`);
  return result.out;
}

/** The office's project repos are sha1 — a seed is always a full 40-hex commit id. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The repository's current HEAD as a validated commit id, for callers that must name a seed
 * (the legacy unbound path, future binding creation). A repo with no HEAD fails the same way any
 * git invocation here does; a HEAD that is not a 40-hex sha1 is reported rather than trusted —
 * a sha256 repo or a corrupt answer is a defect, never a seed.
 */
export async function resolveHeadCommit(repoDir: string): Promise<string> {
  const head = await gitOrThrow(['rev-parse', '--verify', 'HEAD'], repoDir);
  if (!COMMIT_SHA.test(head))
    throw new Error(`git rev-parse --verify HEAD answered ${JSON.stringify(head)} — not a full sha1 commit id.`);
  return head;
}

/**
 * The project repo exists and carries at least one commit after this call. Idempotent: an
 * existing repo is left exactly as found, and a repo whose initial commit is somehow absent
 * gets topped up rather than reported broken.
 */
export async function ensureRepo(reposRoot: string, projectId: string): Promise<string> {
  const dir = repoDir(reposRoot, projectId);
  if (!existsSync(path.join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    await gitOrThrow(['init'], dir);
  }
  const head = await git(['rev-parse', '--verify', 'HEAD'], dir);
  if (!head.ok) await gitOrThrow([...COMMIT_IDENTITY, 'commit', '--allow-empty', '-m', INITIAL_COMMIT], dir);
  return dir;
}

/**
 * Adds one detached worktree of the project repo at `<reposRoot>/<projectId>/worktrees/<name>`
 * and returns its path. Detached HEAD on purpose: session worktrees are packet directories,
 * not lines of development, so no branch is ever created for them. The seed commit is always
 * named explicitly — a worktree that followed bare HEAD would silently drift (defect F08).
 */
export async function createWorktree(
  reposRoot: string,
  projectId: string,
  name: string,
  commit: string,
): Promise<string> {
  // A name is refused before git ever runs: an unsafe segment could land outside the worktrees root.
  if (!safeSegment(name))
    throw new Error(`The session worktree name ${JSON.stringify(name)} is not a safe directory name.`);
  // The seed commit is explicit and required (defect F08): a worktree created from bare HEAD
  // silently follows whatever HEAD happens to be, so the caller names the recorded seed and this
  // validates its shape before git ever runs. Refs, abbreviations and non-sha1 strings are refused.
  if (!COMMIT_SHA.test(commit))
    throw new Error(
      `The session worktree seed ${JSON.stringify(commit)} is not a full sha1 commit id — worktrees are pinned to explicit commits, never resolved here.`,
    );
  const dir = await ensureRepo(reposRoot, projectId);
  const worktree = path.join(dir, WORKTREES_DIR, name);
  await gitOrThrow(['worktree', 'add', '--detach', worktree, commit], dir);
  return worktree;
}
