import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export function git(cwd, ...args) {
  return execFileSync('git', ['-c', `safe.directory=${resolve(cwd).replaceAll('\\', '/')}`, ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const slug = value => {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(value ?? '')) throw Error('Use a lowercase slug, up to 48 characters.');
  return value;
};
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const clean = cwd => {
  if (git(cwd, 'status', '--porcelain')) throw Error(`Commit or preserve unfinished changes first: ${cwd}`);
};
const protectedPaths = ['AGENTS.md', 'CLAUDE.md', 'docs/ROADMAP.md', '.github/', 'tools/',
  'app/package.json', 'app/pnpm-lock.yaml', 'app/pnpm-workspace.yaml', 'app/.npmrc',
  'app/src/shared/', 'app/src/core/store.ts', 'app/src/main/main.ts', 'app/src/main/preload.ts'];
export function overlaps(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const contains = (x, y) => x.endsWith('/') ? y.startsWith(x) : y === x;
  return contains(a, b) || contains(b, a);
}
function pathRule(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') ||
      /[:*?\[\]\x00-\x1f]/.test(value) || value.split('/').some(x => x === '..' || x === '.') ||
      value.includes('//') || value.toLowerCase().startsWith('.git/') || value.toLowerCase() === '.git') {
    throw Error(`Invalid repo-relative file or directory prefix: ${value}`);
  }
  return value;
}
export function validateTask(task, assignments = []) {
  if (!task || typeof task.objective !== 'string' || !task.objective.trim() ||
      !Array.isArray(task.acceptance) || !task.acceptance.length ||
      task.acceptance.some(x => typeof x !== 'string' || !x.trim()) ||
      !Array.isArray(task.allowedPaths) || !task.allowedPaths.length) {
    throw Error('Task needs objective, nonempty acceptance[], and allowedPaths[].');
  }
  for (const entry of task.allowedPaths) {
    const p = pathRule(entry);
    if (protectedPaths.some(q => overlaps(p, q))) throw Error(`Organizer-owned path: ${p}`);
    for (const other of assignments) {
      if (other.allowedPaths.some(q => overlaps(p, q))) throw Error(`Overlapping worker ownership: ${p}`);
    }
  }
  return task;
}
export function init(repo, batch, count = 7, base = 'origin/main') {
  slug(batch);
  if (!Number.isInteger(count) || count < 1 || count > 7) throw Error('Worker count must be 1–7.');
  repo = git(repo, 'rev-parse', '--show-toplevel');
  clean(repo);
  const sha = git(repo, 'rev-parse', '--verify', `${base}^{commit}`);
  const root = resolve(dirname(repo), `${basename(repo)}-sessions`, batch);
  if (existsSync(root)) throw Error(`Batch already exists; use status: ${root}`);
  const lanes = ['organizer', ...Array.from({ length: count }, (_, i) => `worker-${i + 1}`)];
  const entries = lanes.map(id => ({ id, branch: `parallel/${batch}/${id}`, path: join(root, id) }));
  const branches = git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
  if (entries.some(x => branches.includes(x.branch))) throw Error('Batch branch already exists. Choose a new batch name.');
  mkdirSync(root, { recursive: true });
  // Save intent before worktree creation. On partial failure, preserve everything for inspection.
  write(join(root, 'batch.json'), { version: 1, repo, batch, base: sha, entries });
  mkdirSync(join(root, 'assignments'));
  for (const entry of entries) git(repo, 'worktree', 'add', '-b', entry.branch, entry.path, sha);
  writeFileSync(join(root, 'ORGANIZER.md'), `You are the sole organizer for batch ${batch}.\nRepository: louiskim132/Quant_Office\nCheckout: ${entries[0].path}\nBranch: ${entries[0].branch}\nFrozen base: ${sha}\n\nRead AGENTS.md and docs/ROADMAP.md sections 1, 1.5 and 11. All ${count} workers are UNASSIGNED and no model sessions have been launched. Turn the user's requested changes into concrete acceptance packets and disjoint file ownership before calling assign. Keep shared interface changes in the organizer; land those prerequisites before dependent workers start. Publish the organizer branch before worker draft PRs target it. Verify exact worker SHAs with check, independently review behavior, integrate sequentially, and run the combined unit/typecheck/build checks. Return one integration PR to main for human review.\n`, { flag: 'wx' });
  return root;
}
function load(root) {
  root = resolve(root);
  const manifest = read(join(root, 'batch.json'));
  if (manifest.version !== 1) throw Error('Unsupported batch version.');
  return { root, ...manifest };
}
function worker(manifest, id) {
  const entry = manifest.entries.find(x => x.id === id && x.id !== 'organizer');
  if (!entry) throw Error('Unknown worker.');
  return entry;
}
export function assign(root, id, task) {
  const m = load(root), entry = worker(m, id);
  const others = m.entries.filter(x => x.id !== 'organizer').flatMap(x => {
    const file = join(m.root, 'assignments', `${x.id}.json`);
    return existsSync(file) ? [read(file)] : [];
  });
  validateTask(task, others);
  write(join(m.root, 'assignments', `${id}.json`), task);
  const packet = `Repository: louiskim132/Quant_Office\nWorker: ${id}\nBranch: ${entry.branch}\nFrozen base commit: ${m.base}\nLocal checkout: ${entry.path}\n\nRead AGENTS.md and docs/ROADMAP.md sections 1, 1.5 and 11.\nFor a hosted session, fetch the repository and create this exact branch from the frozen base (or check out the existing branch); verify the base is an ancestor. Do not use the local Windows path on a hosted machine.\n\nObjective: ${task.objective}\nAllowed paths (directory prefixes end with /):\n${task.allowedPaths.map(x => '- ' + x).join('\n')}\nAcceptance:\n${task.acceptance.map(x => '- ' + x).join('\n')}\n\nOwn this checkout exclusively. If you need another path or changed shared interfaces, report the dependency to the organizer before editing it. Commit only your task. Return the commit SHA, changed paths, actual test results, remaining blockers and proposed roadmap entry. Open a draft PR targeting the organizer branch ${m.entries[0].branch}; never merge it or update main. Do not edit the roadmap directly.\n`;
  writeFileSync(join(m.root, 'assignments', `${id}.md`), packet, { flag: 'wx' });
  return packet;
}
export function check(root, id, ref) {
  const m = load(root), entry = worker(m, id);
  const task = read(join(m.root, 'assignments', `${id}.json`));
  validateTask(task);
  const sha = git(m.repo, 'rev-parse', '--verify', `${ref ?? entry.branch}^{commit}`);
  git(m.repo, 'merge-base', '--is-ancestor', m.base, sha);
  if (!ref) {
    clean(entry.path);
    if (git(entry.path, 'branch', '--show-current') !== entry.branch) throw Error('Worker checkout changed branch.');
  }
  const paths = git(m.repo, 'diff', '--no-renames', '--name-only', '-z', m.base, sha).split('\0').filter(Boolean);
  if (!paths.length) throw Error('Worker has no changes.');
  for (const p of paths) {
    if (!task.allowedPaths.some(q => q.endsWith('/') ? p.startsWith(q) : p === q)) throw Error(`Out-of-scope change: ${p}`);
  }
  git(m.repo, 'diff', '--check', m.base, sha);
  return { worker: id, sha, base: m.base, paths, scope: 'PASS', implementationReview: 'REQUIRED', tests: 'NOT_RUN_BY_SCOPE_CHECK' };
}
export function status(root) {
  const m = load(root);
  return m.entries.map(entry => ({ ...entry, assigned: entry.id === 'organizer' || existsSync(join(m.root, 'assignments', `${entry.id}.json`)),
    exists: existsSync(entry.path), status: existsSync(entry.path) ? git(entry.path, 'status', '--short', '--branch') : 'NOT_CREATED' }));
}
function main(args) {
  const [command, ...rest] = args;
  if (command === 'init') return init(process.cwd(), rest[0], rest[1] === undefined ? 7 : Number(rest[1]), rest[2] ?? 'origin/main');
  if (command === 'assign') return assign(rest[0], rest[1], read(rest[2]));
  if (command === 'check') return check(rest[0], rest[1], rest[2]);
  if (command === 'status') return status(rest[0]);
  if (command === 'help') return 'init <batch> [1-7 workers] [base-ref]\nassign <batch-dir> <worker-N> <task.json>\ncheck <batch-dir> <worker-N> [fetched-ref-or-SHA]\nstatus <batch-dir>\nNo agent calls, pushes, merges, installs or cleanup are performed.';
  throw Error('Unknown command. Run: node tools/parallel.mjs help');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = main(process.argv.slice(2)); console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
