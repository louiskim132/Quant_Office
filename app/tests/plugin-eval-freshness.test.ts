import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The harness is a dependency-free .mjs module (it must run in the disposable evaluator
// environment, so it cannot share the app's TypeScript build). Import it dynamically with a
// string-typed specifier and describe the contract locally — tsc does not load the .mjs.
const freshnessModule: string = new URL('../benchmarks/plugin-evaluation/harness/freshness.mjs', import.meta.url).href;
const harness = await import(freshnessModule) as {
  FRESHNESS_CORRECTION: string;
  scanAttempt: (dir: string) => { path: string; sha256: string; bytes: number }[];
  applyFreshnessAmendment: (attemptDir: string, opts: { before: { path: string; sha256: string; bytes: number }[] }) =>
    { changed: string[]; unchanged: string[]; added: string[]; removed: string[] };
  freshnessChecks: (reportPath: string) => { newSourceCited: boolean; birchRecheck: boolean; unknownPreserved: boolean };
};
const { FRESHNESS_CORRECTION, scanAttempt, applyFreshnessAmendment, freshnessChecks } = harness;

const taskDir = fileURLToPath(new URL('../benchmarks/plugin-evaluation/task', import.meta.url));

function attempt() {
  const dir = mkdtempSync(path.join(tmpdir(), 'qro-plugin-eval-'));
  cpSync(taskDir, dir, { recursive: true });
  return { dir, before: scanAttempt(dir) };
}

test('the correction lands verbatim inside the Beacon source section and keeps the superseded claim', () => {
  const { dir, before } = attempt();
  const diff = applyFreshnessAmendment(dir, { before });
  const catalog = readFileSync(path.join(dir, 'docs', 'catalog.md'), 'utf8');
  assert.ok(catalog.includes(FRESHNESS_CORRECTION), 'the evaluator-prescribed text is inserted verbatim');
  assert.ok(catalog.includes('This fixture records publication at'), 'the superseded equal-timestamp statement is retained');
  const beacon = catalog.indexOf('## Beacon source'), correction = catalog.indexOf(FRESHNESS_CORRECTION);
  assert.ok(beacon >= 0 && correction > beacon, 'the correction is appended to the Beacon source entry');
  assert.deepEqual(diff.changed, ['docs/catalog.md']);
});

test('the amendment changes exactly docs/catalog.md — nothing is added, removed or left drifted', () => {
  const { dir, before } = attempt();
  const diff = applyFreshnessAmendment(dir, { before });
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.unchanged.length, before.length - 1, 'every other copied member is byte-identical');
});

test('a drifted attempt dir throws loudly instead of silently proceeding', () => {
  const { dir, before } = attempt();
  writeFileSync(path.join(dir, 'docs', 'run-ledger.md'), readFileSync(path.join(dir, 'docs', 'run-ledger.md'), 'utf8') + '\nextra line\n');
  assert.throws(() => applyFreshnessAmendment(dir, { before }), /must change exactly docs\/catalog\.md/);
  const clean = attempt();
  writeFileSync(path.join(clean.dir, 'new-file.txt'), 'not part of the task copy');
  assert.throws(() => applyFreshnessAmendment(clean.dir, { before: clean.before }), /must change exactly docs\/catalog\.md/);
});

// Choice: re-applying is a no-op refusal (throws) — the phase runs exactly once per attempt.
test('the same amendment applied twice is refused as a no-op rather than duplicating the correction', () => {
  const { dir, before } = attempt();
  applyFreshnessAmendment(dir, { before });
  const after = readFileSync(path.join(dir, 'docs', 'catalog.md'), 'utf8');
  assert.throws(() => applyFreshnessAmendment(dir, { before }), /already carries the freshness correction/);
  assert.equal(readFileSync(path.join(dir, 'docs', 'catalog.md'), 'utf8'), after, 'the refusal leaves the amended file untouched');
});

test('freshnessChecks returns the three structural signals as booleans on a representative report', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qro-plugin-eval-report-'));
  const report = path.join(dir, 'REPORT.md');
  writeFileSync(report, [
    '# Freshness follow-up',
    'The corrected docs/catalog.md entry (Correction 2026-01-04) states beacon_snapshot is',
    'published 30 minutes after observation. My earlier conclusion changes: Birch B-01 used',
    'the earlier metadata and must be rechecked. Profitability remains unknown.',
  ].join('\n'));
  assert.deepEqual(freshnessChecks(report), { newSourceCited: true, birchRecheck: true, unknownPreserved: true });
  // A report that ignores the recheck surfaces that absence — still just booleans, no verdict.
  writeFileSync(report, 'The catalog.md correction was noted. Profitability outcome is unknown.');
  const partial = freshnessChecks(report);
  assert.equal(partial.newSourceCited, true);
  assert.equal(partial.birchRecheck, false);
  assert.equal(partial.unknownPreserved, true);
  assert.equal(typeof partial.newSourceCited === 'boolean' && typeof partial.birchRecheck === 'boolean' && typeof partial.unknownPreserved === 'boolean', true);
});
