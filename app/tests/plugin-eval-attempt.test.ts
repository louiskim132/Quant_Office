import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from '../src/main/fsx';
// @ts-expect-error — dependency-free .mjs harness modules live outside the tsconfig include set.
import { assertIsolated, inventoryAttempt, prepareAttempt } from '../benchmarks/plugin-evaluation/harness/attempt.mjs';
// @ts-expect-error — dependency-free .mjs harness modules live outside the tsconfig include set.
import { TIMEBOX_MS, contentHash, validateManifest } from '../benchmarks/plugin-evaluation/harness/records.mjs';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'benchmarks', 'plugin-evaluation');
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const base = {
  arm: 'A0', phase: 'INITIAL',
  config: { provider: 'devin', model: 'swe-2-max', effort: 'default', clientVersion: 'fixture', tools: [] as string[] },
  prompt: 'Fix src/eligibility.mjs per docs/contract-v2.md.',
  now: () => '2026-09-16T10:00:00.000Z',
};

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-plugin-eval-'));
  t.after(() => removeTreeSync(root));
  return { attemptsRoot: path.join(root, 'attempts'), root };
}

test('prepareAttempt freezes a manifest that validates and a copy containing only task members', t => {
  const f = fixture(t);
  const { attemptDir, manifest } = prepareAttempt({ attemptsRoot: f.attemptsRoot, fixtureDir, attemptId: 'attempt-a', ...base });
  assert.deepEqual(validateManifest(manifest), [], 'the manifest must satisfy validateManifest with an empty problem list');
  assert.equal(manifest.schema, 'plugin-eval-attempt@1');
  assert.equal(manifest.timeboxMs, TIMEBOX_MS);
  assert.equal(manifest.setupMs, 0);
  assert.equal(manifest.promptSha256, sha(base.prompt));
  assert.equal(manifest.createdAt, '2026-09-16T10:00:00.000Z');
  // The copy is the task tree itself: verify.mjs resolves <task-copy>/src/eligibility.mjs.
  const inventory = inventoryAttempt(attemptDir).filter((x: { path: string }) => x.path !== 'manifest.json');
  assert.deepEqual(inventory, manifest.files, 'manifest files list exactly the on-disk inventory');
  assert.equal(manifest.taskHash, contentHash(manifest.files));
  const paths = inventory.map((x: { path: string }) => x.path);
  for (const expected of ['TASK.md', 'docs/catalog.md', 'inputs/records.json', 'src/eligibility.mjs', 'src/time.mjs'])
    assert.ok(paths.includes(expected), `expected ${expected} in the attempt copy`);
  // Nothing from the evaluator side can be inside: only task members plus manifest.json.
  assertIsolated(attemptDir);
  assert.equal(manifest.files.find((x: { path: string }) => x.path === 'TASK.md')!.sha256, createHash('sha256').update(readFileSync(path.join(fixtureDir, 'task', 'TASK.md'))).digest('hex'));
});

test('an attempt dir that already exists is refused, never reused or merged', t => {
  const f = fixture(t);
  prepareAttempt({ attemptsRoot: f.attemptsRoot, fixtureDir, attemptId: 'attempt-a', ...base });
  assert.throws(() => prepareAttempt({ attemptsRoot: f.attemptsRoot, fixtureDir, attemptId: 'attempt-a', ...base }), /already exists/);
  const empty = path.join(f.attemptsRoot, 'attempt-b');
  mkdirSync(empty, { recursive: true });
  assert.throws(() => prepareAttempt({ attemptsRoot: f.attemptsRoot, fixtureDir, attemptId: 'attempt-b', ...base }), /already exists/);
});

test('attemptsRoot inside the fixture or the repo checkout is refused', t => {
  const f = fixture(t);
  assert.throws(() => prepareAttempt({ attemptsRoot: path.join(fixtureDir, 'attempts'), fixtureDir, attemptId: 'x', ...base }), /inside the fixture/);
  assert.throws(() => prepareAttempt({ attemptsRoot: fixtureDir, fixtureDir, attemptId: 'x', ...base }), /inside the fixture/);
  const repoRoot = path.resolve(fixtureDir, '..', '..', '..');
  assert.throws(() => prepareAttempt({ attemptsRoot: path.join(repoRoot, 'attempts'), fixtureDir, attemptId: 'x', ...base }), /inside the repo checkout/);
  assert.doesNotThrow(() => prepareAttempt({ attemptsRoot: path.join(f.root, 'attempts'), fixtureDir, attemptId: 'x', ...base }), 'an outside root is accepted');
});

test('attempt ids are single safe names — traversal and separators are refused', t => {
  const f = fixture(t);
  for (const attemptId of ['../escape', 'a/b', 'a\\b', 'C:\\evil', '.hidden', '..', ''])
    assert.throws(() => prepareAttempt({ attemptsRoot: f.attemptsRoot, fixtureDir, attemptId, ...base }), /safe single name/);
  assert.equal(existsSync(path.join(f.attemptsRoot, '..', 'escape')), false);
});

test('evaluator material inside an attempt fails isolation loudly', t => {
  const f = fixture(t);
  const { attemptDir } = prepareAttempt({ attemptsRoot: f.attemptsRoot, fixtureDir, attemptId: 'attempt-a', ...base });
  // The evaluator's own file must never be in the copy.
  copyFileSync(path.join(fixtureDir, 'EVALUATOR.md'), path.join(attemptDir, 'EVALUATOR.md'));
  assert.throws(() => assertIsolated(attemptDir), /not part of the task inventory/);
  assert.throws(() => assertIsolated(attemptDir), /contaminated/);
  const declared = inventoryAttempt(attemptDir).find((x: { path: string }) => x.path === 'manifest.json');
  assert.ok(declared, 'manifest.json is inventoried on disk');
});

test('a removed task member fails isolation — the copy must match what was frozen', t => {
  const f = fixture(t);
  const { attemptDir } = prepareAttempt({ attemptsRoot: f.attemptsRoot, fixtureDir, attemptId: 'attempt-a', ...base });
  removeTreeSync(path.join(attemptDir, 'docs'));
  assert.throws(() => assertIsolated(attemptDir), /missing from the attempt/);
});

test('assertIsolated refuses a dir without a manifest', t => {
  const f = fixture(t);
  const orphan = path.join(f.root, 'orphan');
  mkdirSync(orphan);
  writeFileSync(path.join(orphan, 'TASK.md'), 'foreign content');
  assert.throws(() => assertIsolated(orphan), /no manifest\.json/);
});

test('unsafe manifest content fails isolation instead of authorizing the dir', t => {
  const f = fixture(t);
  const { attemptDir } = prepareAttempt({ attemptsRoot: f.attemptsRoot, fixtureDir, attemptId: 'attempt-a', ...base });
  writeFileSync(path.join(attemptDir, 'manifest.json'), JSON.stringify({ schema: 'plugin-eval-attempt@1', files: [{ path: '../x', sha256: 'a'.repeat(64), bytes: 1 }] }));
  assert.throws(() => assertIsolated(attemptDir), /not a valid attempt manifest/);
});
