/**
 * Isolated attempt preparation for the plugin-evaluation harness (EVALUATOR.md, roadmap 3.2).
 *
 * An attempt is a fresh workspace containing ONLY the participant-visible task/ tree. The evaluator
 * (EVALUATOR.md, verify.mjs, harness/, expected answers, other attempts, transcripts, the parent
 * repo) is never inside it, so attemptsRoot must resolve outside both the fixture and the repo
 * checkout — a working directory alone is not isolation. Dependency-free by design: this module
 * must run in the disposable evaluator environment, so it imports only node builtins and the shared
 * record contracts.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, PHASES, TIMEBOX_MS, contentHash, fileHash, validateManifest } from './records.mjs';

const home = path.dirname(fileURLToPath(import.meta.url));
/** harness → plugin-evaluation → benchmarks → app → the checkout root. */
const repoRoot = path.resolve(home, '..', '..', '..', '..');
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;

/** A forward-slash relative name that can never escape or collide with the filesystem it lands on. */
const safeRel = p => p.length > 0 && p.length <= 240 && !/[\\:\x00-\x1f]/.test(p) && !p.startsWith('/')
  && p.split('/').every(s => s !== '..' && s !== '.' && s.length > 0 && !/[ .]$/.test(s)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s));
/** True when child resolves inside (or exactly at) parent — equal means the root itself is the fixture or repo. */
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };

/**
 * Every file under attemptDir as a sorted {path, sha256, bytes} inventory. Links and non-regular
 * files are refused — an attempt carries plain bytes only.
 */
export function inventoryAttempt(attemptDir) {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relName = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${relName} is a link; an attempt carries regular files only.`);
      if (entry.isDirectory()) { walk(full, relName); continue; }
      if (!entry.isFile()) throw new Error(`${relName} is not a regular file; an attempt carries regular files only.`);
      files.push({ path: relName, sha256: fileHash(full), bytes: statSync(full).size });
    }
  };
  walk(attemptDir, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/**
 * Re-scans an attempt dir against its manifest: any file that is not manifest.json or a declared
 * task member means evaluator material landed inside, and a missing member means the copy no longer
 * matches what was frozen. Either way the attempt is invalid.
 */
export function assertIsolated(attemptDir) {
  const manifestPath = path.join(attemptDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${attemptDir} has no manifest.json to check isolation against.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`manifest.json inside ${attemptDir} is not a valid attempt manifest: ${problems[0]}`);
  const declared = new Set(manifest.files.map(f => f.path));
  const found = inventoryAttempt(attemptDir).map(f => f.path).filter(p => p !== 'manifest.json');
  for (const p of found)
    if (!declared.has(p)) throw new Error(`${p} is inside the attempt but not part of the task inventory; the attempt is contaminated and invalid.`);
  for (const p of declared)
    if (!found.includes(p)) throw new Error(`Declared task member ${p} is missing from the attempt.`);
}

/**
 * Copies ONLY fixtureDir/task/ into a fresh <attemptsRoot>/<attemptId>/ and freezes what was set up:
 * manifest.json records the hashed task inventory (taskHash = contentHash of the sorted inventory),
 * the exact prompt bytes (promptSha256), the arm/phase and the chosen config. The attempt directory
 * is created non-recursively — an existing dir is a refusal, never a reuse.
 */
export function prepareAttempt({ attemptsRoot, fixtureDir, attemptId, arm, phase, config, prompt, now = () => new Date().toISOString() }) {
  if (typeof attemptId !== 'string' || !safeName.test(attemptId)) throw new Error('attemptId must be a safe single name.');
  if (!ARMS.includes(arm)) throw new Error(`arm must be one of ${ARMS.join(', ')}.`);
  if (!PHASES.includes(phase)) throw new Error(`phase must be one of ${PHASES.join(', ')}.`);
  if (typeof prompt !== 'string') throw new Error('prompt must be the exact prompt text.');
  if (!config || typeof config !== 'object') throw new Error('config must record provider, model, effort, clientVersion and tools.');
  for (const key of ['provider', 'model', 'effort', 'clientVersion'])
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`config.${key} must be a non-empty string.`);
  if (!Array.isArray(config.tools)) throw new Error('config.tools must be an array, [] for a baseline arm.');

  const root = path.resolve(String(attemptsRoot));
  const fixture = path.resolve(String(fixtureDir));
  const task = path.join(fixture, 'task');
  if (!existsSync(task) || !statSync(task).isDirectory()) throw new Error('The fixture has no task/ directory to copy.');
  if (inside(fixture, root)) throw new Error('attemptsRoot resolves inside the fixture; an attempt would sit beside evaluator material.');
  if (inside(repoRoot, root)) throw new Error('attemptsRoot resolves inside the repo checkout; attempts must live outside it.');
  mkdirSync(root, { recursive: true });
  const dir = path.join(root, attemptId);
  if (existsSync(dir)) throw new Error(`The attempt ${attemptId} already exists; attempts are never reused or merged.`);
  mkdirSync(dir);
  try {
    const copy = (src, rel) => {
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        const relName = rel ? `${rel}/${entry.name}` : entry.name;
        if (!safeRel(relName)) throw new Error(`Task member ${relName} is not a safe relative name; nothing outside the task tree is copied.`);
        const full = path.join(src, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`${relName} is a link; an attempt carries regular files only.`);
        if (entry.isDirectory()) { mkdirSync(path.join(dir, relName)); copy(full, relName); continue; }
        if (!entry.isFile()) throw new Error(`${relName} is not a regular file; an attempt carries regular files only.`);
        copyFileSync(full, path.join(dir, relName));
      }
    };
    copy(task, '');
    const files = inventoryAttempt(dir);
    if (!files.length) throw new Error('task/ produced no files; a manifest requires a non-empty inventory.');
    const manifest = {
      schema: 'plugin-eval-attempt@1', attemptId, arm, phase,
      promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
      taskHash: contentHash(files), files,
      config: { provider: config.provider, model: config.model, effort: config.effort, clientVersion: config.clientVersion, tools: [...config.tools] },
      timeboxMs: TIMEBOX_MS, setupMs: 0, createdAt: now(),
    };
    const problems = validateManifest(manifest);
    if (problems.length) throw new Error(`The attempt manifest is invalid: ${problems.join('; ')}`);
    writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { attemptDir: dir, manifest };
  } catch (error) {
    // A refused preparation removes its partial copy, so the burned id leaves no half-attempt behind.
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
