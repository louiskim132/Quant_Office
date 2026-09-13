import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, validateTask } from './parallel.mjs';

const json = file => JSON.parse(readFileSync(file, 'utf8'));
const bytes = data => JSON.stringify(data, null, 2) + '\n';
const digest = data => createHash('sha256').update(data).digest('hex');
const samePath = (a, b) => realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
const now = () => new Date().toISOString();
const must = (condition, message) => { if (!condition) throw Error(message); };
const text = (s, label) => must(typeof s === 'string' && s.trim() && !s.includes('REPLACE_ME'), `${label} must be specific, nonempty text.`);
function texts(values, label) { must(Array.isArray(values) && values.length > 0, `${label} must be a nonempty array.`); values.forEach(s => text(s, label)); }
function clean(path) { must(!git(path, 'status', '--porcelain'), `Uncommitted work in ${path}; preserve it before continuing.`); }
function fresh(file, value) { writeFileSync(file, bytes(value), { flag: 'wx' }); }
function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fresh(temp, value); renameSync(temp, file);
}
function lock(file, fn) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { writeFileSync(file, bytes({ pid: process.pid, at: now() }), { flag: 'wx' }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      must(Date.now() < deadline, `STATE_LOCKED: ${file}. Retry later; never delete a lock while another operation may be active.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return fn(); } finally { unlinkSync(file); }
}
function manifest(root) {
  root = resolve(root);
  const m = json(join(root, 'batch.json'));
  must(m.version === 1 && Array.isArray(m.entries), 'Invalid batch manifest.');
  must(m.entries.length === 8 && m.entries[0].id === 'organizer', 'Desktop setup requires one organizer and exactly seven workers.');
  for (let i = 1; i <= 7; i++) must(m.entries[i].id === `worker-${i}`, 'Unexpected session numbering.');
  return { ...m, root };
}
function binding(cwd, role) {
  const repo = git(cwd, 'rev-parse', '--show-toplevel');
  must(existsSync(join(repo, '.session.json')), 'NOT_CONFIGURED: open the assigned session folder and read SESSION.md.');
  const b = json(join(repo, '.session.json')), m = manifest(b.batchRoot);
  const entry = m.entries.find(x => x.id === b.id);
  must(b.version === 1 && entry && samePath(repo, entry.path), 'Session identity/path mismatch. Stop and reopen the assigned folder.');
  const common = path => realpathSync(resolve(path, git(path, 'rev-parse', '--git-common-dir')));
  must(samePath(common(repo), common(m.repo)), 'Session is not attached to the expected Git repository.');
  if (role === 'organizer') must(entry.id === 'organizer', 'Only Session 8 may perform this operation.');
  if (role === 'worker') must(entry.id !== 'organizer', 'Only Sessions 1–7 may perform this operation.');
  if (entry.id === 'organizer') must(git(repo, 'branch', '--show-current') === entry.branch, 'Organizer branch changed unexpectedly.');
  return { ...m, entry, repo };
}
function current(m) {
  const file = join(m.root, 'current.json');
  if (!existsSync(file)) return null;
  const c = json(file);
  must(/^[a-z][a-z0-9-]{0,47}$/.test(c.id), 'Invalid round identity.');
  const dir = join(m.root, 'rounds', c.id), raw = readFileSync(join(dir, 'round.json'), 'utf8');
  must(digest(raw) === c.hash, 'Published packet changed. Stop; organizer must recover the immutable round.');
  return { ...c, dir, packet: JSON.parse(raw) };
}
function taskFor(c, id) { return c.packet.workers.find(t => t.id === id); }
function result(c, id) { const p = join(c.dir, 'results', `${id}.json`); return existsSync(p) ? json(p) : null; }
function decision(c, id) { const p = join(c.dir, 'decisions', `${id}.json`); return existsSync(p) ? json(p) : null; }
function workerState(c, id) {
  if (taskFor(c, id).mode === 'IDLE') return 'IDLE';
  return decision(c, id)?.state ?? result(c, id)?.state ?? (existsSync(join(c.dir, 'started', `${id}.json`)) ? 'RUNNING' : 'ASSIGNED');
}
const terminal = state => ['IDLE', 'INTEGRATED', 'REJECTED'].includes(state);
function liveWorker(m, c) {
  must(c && c.phase === 'READY', 'NOT_READY: no open published round. Do not edit code.');
  const task = taskFor(c, m.entry.id);
  must(task, 'Worker has no slot.');
  must(git(m.repo, 'branch', '--show-current') === task.branch, 'Wrong worker branch; do not switch it yourself.');
  git(m.repo, 'merge-base', '--is-ancestor', c.packet.base, 'HEAD');
  return task;
}
function checks(report) {
  text(report.summary, 'summary');
  must(Array.isArray(report.checks) && report.checks.length > 0, 'List actual executed checks.');
  for (const item of report.checks) {
    text(item.command, 'check command'); text(item.result, 'check result');
    must(item.exitCode === 0, 'A failed or unexecuted check cannot support acceptance. Use block/reject instead.');
  }
}
function scoped(m, c, task, sha) {
  git(m.repo, 'merge-base', '--is-ancestor', c.packet.base, sha);
  const paths = git(m.repo, 'diff', '--no-renames', '--name-only', '-z', c.packet.base, sha).split('\0').filter(Boolean);
  must(paths.length > 0, 'No committed task changes.');
  for (const p of paths) must(task.allowedPaths.some(q => q.endsWith('/') ? p.startsWith(q) : p === q), `Out-of-scope change: ${p}`);
  git(m.repo, 'diff', '--check', c.packet.base, sha);
  return paths;
}
export function setup(root) {
  const m = manifest(root);
  for (const e of m.entries) {
    mkdirSync(join(m.root, 'drafts', e.id), { recursive: true });
    clean(e.path);
    must(git(e.path, 'branch', '--show-current') === e.branch, `Unexpected branch: ${e.id}`);
    for (const f of ['.session.json', 'SESSION.md']) git(e.path, 'check-ignore', f);
    const p = join(e.path, '.session.json');
    if (existsSync(p)) must(bytes(json(p)) === bytes({ version: 1, batchRoot: m.root, id: e.id }), `Existing binding differs: ${e.path}`);
  }
  for (const e of m.entries) {
    const p = join(e.path, '.session.json');
    if (!existsSync(p)) fresh(p, { version: 1, batchRoot: m.root, id: e.id });
    const number = e.id === 'organizer' ? 8 : Number(e.id.split('-')[1]);
    const instruction = `# Session ${number}: ${e.id}\n\nYour only writable code checkout is: ${e.path}\nShared handoff directory: ${m.root}\nIdentity is in .session.json. Never change your identity or another checkout.\n\nRead docs/DESKTOP-SESSIONS.md and the ${number === 8 ? 'orchestrator' : 'worker'} recipe before acting.\n${number === 8 ? 'You plan user requests and review worker submissions. Use node tools/desktop.mjs template, publish, review, accept, reject and close as documented. Only claim WORK READY after publish succeeds. On user message review, run the review command and process the submitted exact commits.' : 'On the user message start, run node tools/desktop.mjs start from this checkout and follow only its current numbered assignment. NOT_READY, IDLE, CLOSED and already-submitted states mean no new editing. Resume RUNNING only in this same session; never start a second writer. Use finish or block to leave your report for Session 8.'}\n\nIf node is not found, use PowerShell: & 'C:/Program Files/nodejs/node.exe' tools/desktop.mjs <command>\nNever infer work from an old conversation or a task in the product roadmap.\n`;
    if (!existsSync(join(e.path, 'SESSION.md'))) writeFileSync(join(e.path, 'SESSION.md'), instruction, { flag: 'wx' });
  }
  const start = `# Desktop session setup (one time)\n\nOpen eight local sessions, each in its own folder below. Paste into EACH session once:\n\n> Read SESSION.md in this folder. Verify my role and shared handoff directory using node tools/desktop.mjs status. Read docs/DESKTOP-SESSIONS.md. Confirm the session number and wait for my request. Do not edit product code or publish a round yet.\n\n${m.entries.map(e => `- Session ${e.id === 'organizer' ? 8 : e.id.split('-')[1]}: ${e.path}`).join('\n')}\n\nThen send your feature request to Session 8. After it says WORK READY, type start in Sessions 1–7. When they finish, type review in Session 8. Repeat for each announced round. Session 8 maintains the canonical roadmap.\n\nThe app must expose these LOCAL folders and the shared handoff folder. An isolated hosted filesystem cannot use this local mailbox without an explicitly implemented sync route. No provider sessions or model choices are created by this setup.\n`;
  if (!existsSync(join(m.root, 'START-HERE.md'))) writeFileSync(join(m.root, 'START-HERE.md'), start, { flag: 'wx' });
  return { state: 'CONFIGURED', sessions: 8, startHere: join(m.root, 'START-HERE.md'), current: current(m)?.id ?? null };
}
export function template(cwd, file) {
  const m = binding(cwd, 'organizer');
  fresh(resolve(file), { id: 'round-001', request: 'REPLACE_ME with the actual user request', workers: m.entries.slice(1).map((e, i) =>
    i ? { id: e.id, mode: 'IDLE', objective: 'No independent task in this round.' } : {
      id: e.id, mode: 'CODE', objective: 'REPLACE_ME with one concrete outcome', allowedPaths: [],
      readPaths: ['docs/ROADMAP.md'], steps: ['REPLACE_ME with exact implementation steps'],
      acceptance: ['REPLACE_ME with observable success criteria'], checks: ['REPLACE_ME with exact commands from the stated directory']
    }) });
  return resolve(file);
}
export function publish(cwd, plan) {
  const m = binding(cwd, 'organizer');
  return lock(join(m.root, 'control.lock'), () => {
    must(/^[a-z][a-z0-9-]{0,47}$/.test(plan.id ?? ''), 'Use a unique lowercase round slug.'); text(plan.request, 'request');
    const previous = current(m);
    must(!previous || previous.phase === 'CLOSED', 'Close the previous round before publishing another.');
    must(Array.isArray(plan.workers) && plan.workers.length === 7, 'Supply all seven slots, using IDLE for unused workers.');
    const tasks = [], seen = new Set();
    for (const t of plan.workers) {
      must(m.entries.slice(1).some(e => e.id === t.id) && !seen.has(t.id), 'Each worker must appear exactly once.'); seen.add(t.id);
      text(t.objective, 'objective'); must(['CODE', 'IDLE'].includes(t.mode), 'mode must be CODE or IDLE.');
      if (t.mode === 'CODE') {
        validateTask(t, tasks); texts(t.steps, 'steps'); texts(t.readPaths, 'readPaths'); texts(t.checks, 'checks');
        for (const p of t.readPaths) must(!/[:\\]/.test(p) && !p.startsWith('/') && !p.split('/').includes('..') && existsSync(join(m.repo, p)), `Read path must exist in this checkout: ${p}`);
        texts(t.acceptance, 'acceptance'); tasks.push(t);
      } else must(!t.allowedPaths?.length, 'IDLE workers cannot own paths.');
    }
    must(tasks.length > 0, 'A round must contain actual work; do not publish an all-idle round.');
    clean(m.repo);
    const base = git(m.repo, 'rev-parse', 'HEAD'), dir = join(m.root, 'rounds', plan.id);
    must(!existsSync(dir), 'Round exists. Never overwrite old assignments or results.');
    const workers = plan.workers.map(t => ({ ...t, branch: `parallel/${m.batch}/${plan.id}/${t.id}` }));
    const existing = git(m.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
    for (const e of m.entries.slice(1)) {
      clean(e.path);
      const expected = previous ? taskFor(previous, e.id).branch : e.branch;
      must(git(e.path, 'branch', '--show-current') === expected, `Unexpected branch in ${e.id}.`);
      must(!existing.includes(workers.find(t => t.id === e.id).branch), 'Round branch already exists.');
    }
    mkdirSync(dir, { recursive: true });
    for (const sub of ['started', 'results', 'decisions', 'reviews']) mkdirSync(join(dir, sub));
    const packet = { version: 1, id: plan.id, request: plan.request, base, publishedAt: now(), workers };
    const raw = bytes(packet); writeFileSync(join(dir, 'round.json'), raw, { flag: 'wx' });
    const pointer = { id: plan.id, hash: digest(raw), phase: 'PREPARING' };
    atomic(join(m.root, 'current.json'), pointer);
    for (const e of m.entries.slice(1)) git(e.path, 'switch', '-c', workers.find(t => t.id === e.id).branch, base);
    atomic(join(m.root, 'current.json'), { ...pointer, phase: 'READY' });
    return { state: 'WORK_READY', round: plan.id, base, coding: workers.filter(t => t.mode === 'CODE').map(t => t.id), idle: workers.filter(t => t.mode === 'IDLE').map(t => t.id) };
  });
}
export function start(cwd) {
  const m = binding(cwd, 'worker');
  return lock(join(m.root, 'control.lock'), () => {
    const c = current(m);
    if (!c || c.phase !== 'READY') return { state: c?.phase ?? 'NOT_READY', instruction: 'Do not edit. Wait for Session 8 to announce WORK READY.' };
    const task = liveWorker(m, c), state = workerState(c, m.entry.id);
    if (state !== 'ASSIGNED' && state !== 'RUNNING') return { state, round: c.id, instruction: 'No new editing. This slot is idle, blocked or already submitted. Wait for a new round.' };
    if (state === 'ASSIGNED') {
      clean(m.repo); must(git(m.repo, 'rev-parse', 'HEAD') === c.packet.base, 'Worker has unexpected commits before start.');
      fresh(join(c.dir, 'started', `${m.entry.id}.json`), { worker: m.entry.id, round: c.id, at: now() });
    }
    return { state: 'RUNNING', resume: state === 'RUNNING', round: c.id, base: c.packet.base, task,
      instruction: 'Follow this task only. One session owns this worker folder. Resume only in the same session; never start a second writer. Commit scoped changes, then run finish with your actual result, or block with the concrete blocker.' };
  });
}
export function finish(cwd, report) {
  const m = binding(cwd, 'worker');
  return lock(join(m.root, 'control.lock'), () => {
    const c = current(m), task = liveWorker(m, c);
    must(report.round === c.id, 'Stale result: report.round must match the current round.');
    must(workerState(c, m.entry.id) === 'RUNNING', 'Worker is not running or has already submitted.');
    checks(report); text(report.roadmapEntry, 'proposed roadmap entry');
    must(Array.isArray(report.acceptance) && report.acceptance.length === task.acceptance.length, 'Report every acceptance criterion.');
    report.acceptance.forEach((a, i) => { must(a.criterion === task.acceptance[i] && a.passed === true, 'Acceptance criterion missing or failed.'); text(a.evidence, 'acceptance evidence'); });
    const commands = new Set(report.checks.map(c => c.command));
    task.checks.forEach(c => must(commands.has(c), `Required check missing: ${c}`));
    clean(m.repo); const sha = git(m.repo, 'rev-parse', 'HEAD'), paths = scoped(m, c, task, sha);
    const out = { ...report, state: 'READY_FOR_REVIEW', round: c.id, worker: m.entry.id, sha, base: c.packet.base, paths, at: now(), provenance: 'WORKER_REPORTED_CHECKS_REQUIRE_INDEPENDENT_REVIEW' };
    fresh(join(c.dir, 'results', `${m.entry.id}.json`), out); return out;
  });
}
export function block(cwd, reason) {
  text(reason, 'block reason'); const m = binding(cwd, 'worker');
  return lock(join(m.root, 'control.lock'), () => {
    const c = current(m); liveWorker(m, c);
    must(['ASSIGNED', 'RUNNING'].includes(workerState(c, m.entry.id)), 'Cannot replace an existing result or decision.');
    const out = { state: 'BLOCKED', round: c.id, worker: m.entry.id, reason, at: now(), sha: git(m.repo, 'rev-parse', 'HEAD'), gitStatus: git(m.repo, 'status', '--short') };
    fresh(join(c.dir, 'results', `${m.entry.id}.json`), out); return out;
  });
}
export function review(cwd) {
  const m = binding(cwd, 'organizer'), c = current(m);
  if (!c) return { state: 'NOT_READY', instruction: 'Prepare a plan and publish it.' };
  return { round: c.id, phase: c.phase, request: c.packet.request, base: c.packet.base,
    workers: m.entries.slice(1).map(e => {
      const r = result(c, e.id), d = decision(c, e.id);
      let scope = 'NOT_SUBMITTED';
      if (r?.state === 'READY_FOR_REVIEW') {
        try { scoped(m, c, taskFor(c, e.id), r.sha); clean(e.path); must(git(e.path, 'rev-parse', 'HEAD') === r.sha, 'Worker moved after submission.'); scope = 'PASS'; }
        catch (error) { scope = error.message; }
      }
      return { id: e.id, state: workerState(c, e.id), scope, task: taskFor(c, e.id), result: r, decision: d };
    }) };
}
export function accept(cwd, id, sha, assessment) {
  const m = binding(cwd, 'organizer');
  return lock(join(m.root, 'control.lock'), () => {
    const c = current(m); must(c?.phase === 'READY', 'Round is not open.');
    const entry = m.entries.find(e => e.id === id && id !== 'organizer'); must(entry, 'Unknown worker.');
    must(['READY_FOR_REVIEW', 'MERGE_CONFLICT'].includes(workerState(c, id)), 'No reviewable submission.');
    const r = result(c, id); must(r.sha === sha, 'Approval must name the exact submitted SHA.');
    must(assessment.round === c.id && assessment.workerSha === sha, 'Stale review identity.');
    checks(assessment); texts(assessment.compatibility, 'compatibility findings');
    clean(entry.path); must(git(entry.path, 'rev-parse', 'HEAD') === sha, 'Worker moved after submission.');
    must(git(entry.path, 'branch', '--show-current') === taskFor(c, id).branch, 'Worker branch changed.');
    scoped(m, c, taskFor(c, id), sha); clean(m.repo);
    const before = git(m.repo, 'rev-parse', 'HEAD');
    must(assessment.againstHead === before, 'Organizer changed since review. Recheck compatibility against its current HEAD.');
    const path = join(c.dir, 'decisions', `${id}.json`);
    fresh(join(c.dir, 'reviews', `${id}-${randomUUID()}.json`), { sha, before, at: now(), assessment });
    try { git(m.repo, 'merge', '--no-ff', '--no-edit', sha); }
    catch (error) {
      atomic(path, { state: 'MERGE_CONFLICT', worker: id, sha, before, at: now(), assessment });
      throw Error('Merge stopped. Resolve and test the organizer checkout, commit the resolution, then accept the SAME SHA with fresh findings. Do not edit workers or replace whole folders.');
    }
    const out = { state: 'INTEGRATED', worker: id, sha, before, integratedHead: git(m.repo, 'rev-parse', 'HEAD'), at: now(), assessment, combinedVerification: 'REQUIRED_BEFORE_CLOSE' };
    atomic(path, out); return out;
  });
}
export function reject(cwd, id, reason) {
  text(reason, 'rejection reason'); const m = binding(cwd, 'organizer');
  return lock(join(m.root, 'control.lock'), () => {
    const c = current(m); must(c?.phase === 'READY', 'Round is not open.');
    must(c.packet.workers.some(t => t.id === id), 'Unknown worker.');
    must(['READY_FOR_REVIEW', 'BLOCKED'].includes(workerState(c, id)), 'Only completed or blocked submissions can be rejected.');
    const out = { state: 'REJECTED', worker: id, reason, sha: result(c, id)?.sha, at: now() };
    fresh(join(c.dir, 'decisions', `${id}.json`), out); return out;
  });
}
export function close(cwd, report) {
  const m = binding(cwd, 'organizer');
  return lock(join(m.root, 'control.lock'), () => {
    const c = current(m); must(c?.phase === 'READY', 'Round is not open.');
    must(c.packet.workers.every(t => terminal(workerState(c, t.id))), 'Every worker must be integrated, rejected or idle before closing.');
    checks(report); text(report.roadmapEntry, 'roadmap entry/commit reference'); clean(m.repo);
    const sha = git(m.repo, 'rev-parse', 'HEAD');
    must(report.round === c.id && report.head === sha, 'Combined verification must name the current round and organizer HEAD.');
    for (const kind of ['unit', 'typecheck', 'build']) must(report.checks.some(x => x.kind === kind), `Combined ${kind} check is required.`);
    for (const t of c.packet.workers) {
      const d = decision(c, t.id); if (d?.state === 'INTEGRATED') git(m.repo, 'merge-base', '--is-ancestor', d.sha, sha);
    }
    const closeFile = join(c.dir, 'close.json');
    if (existsSync(closeFile)) must(json(closeFile).sha === sha, 'Previous close attempt names a different HEAD. Inspect before recovery.');
    else fresh(closeFile, { ...report, sha, at: now(), provenance: 'ORGANIZER_REPORTED_COMBINED_VERIFICATION' });
    atomic(join(m.root, 'current.json'), { id: c.id, hash: c.hash, phase: 'CLOSED' });
    return { state: 'CLOSED', round: c.id, sha, instruction: 'Preserve branches/reports. Open or update the integration PR to main for human review, or prepare the next round from this accepted organizer HEAD.' };
  });
}
export function status(cwd) {
  const m = binding(cwd), c = current(m);
  return { session: m.entry.id === 'organizer' ? 8 : Number(m.entry.id.split('-')[1]), role: m.entry.id,
    checkout: m.repo, sharedFolder: m.root, draftFolder: join(m.root, 'drafts', m.entry.id), round: c?.id ?? null, phase: c?.phase ?? 'NOT_READY',
    state: c && m.entry.id !== 'organizer' ? workerState(c, m.entry.id) : c?.phase ?? 'NOT_READY' };
}
function main(args) {
  const [command, ...a] = args, cwd = process.cwd();
  if (command === 'setup') return setup(a[0]);
  if (command === 'status') return status(cwd);
  if (command === 'template') return template(cwd, a[0]);
  if (command === 'publish') return publish(cwd, json(resolve(a[0])));
  if (command === 'start') return start(cwd);
  if (command === 'finish') return finish(cwd, json(resolve(a[0])));
  if (command === 'block') return block(cwd, a.join(' '));
  if (command === 'review') return review(cwd);
  if (command === 'accept') return accept(cwd, a[0], a[1], json(resolve(a[2])));
  if (command === 'reject') return reject(cwd, a[0], a.slice(1).join(' '));
  if (command === 'close') return close(cwd, json(resolve(a[0])));
  throw Error('Read docs/DESKTOP-SESSIONS.md for commands.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
