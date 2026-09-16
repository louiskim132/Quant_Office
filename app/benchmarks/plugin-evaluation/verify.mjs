import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const home = path.dirname(fileURLToPath(import.meta.url));
const examples = JSON.parse(await readFile(path.join(home, 'task/inputs/records.json'), 'utf8'));
const reasons = ['OK', 'LATE', 'NOT_FEATURE', 'INVALID_TIME', 'INVALID_TIME', 'INCOMPLETE', 'OK', 'INVALID_TIME'];
const cases = examples.map((row, i) => ({ row, reason: reasons[i] }));
const extra = [
  [{ availableAt: '2026-01-01T10:00:00Z' }, 'OK'],
  [{ availableAt: '2026-01-01T10:00:00.001Z' }, 'LATE'],
  [{ availableAt: '2026-01-01T09:05:00' }, 'INVALID_TIME'],
  [{ kind: 'TARGET', availableAt: null }, 'INVALID_TIME'],
  [{ kind: 'TARGET', status: 'FAILED' }, 'NOT_FEATURE'],
  [{ status: 'FAILED', availableAt: '2026-01-01T11:00:00Z' }, 'INCOMPLETE'],
  [{ kind: 'UNKNOWN' }, 'NOT_FEATURE'],
  [{ status: 'UNKNOWN' }, 'INCOMPLETE'],
];
extra.forEach(([patch, reason], i) => cases.push({ row: { ...examples[0], ...patch, id: `boundary-${i}` }, reason }));

function grade(classify) {
  const failures = [];
  for (const { row, reason } of cases) {
    const input = structuredClone(row);
    try {
      const actual = classify(input);
      assert.deepEqual(actual, { id: row.id, eligible: reason === 'OK', reason });
      assert.deepEqual(input, row, 'Input changed');
    } catch (error) { failures.push({ id: row.id, error: error.message }); }
  }
  return { passed: cases.length - failures.length, total: cases.length, failures };
}

if (process.argv[2] === '--self-check') {
  const { instant } = await import('./task/src/time.mjs');
  const oracle = row => {
    const [observed, available, decision] = [row.observedAt, row.availableAt, row.decisionAt].map(instant);
    const reason = [observed, available, decision].includes(null) || observed > available ? 'INVALID_TIME'
      : row.kind !== 'FEATURE' ? 'NOT_FEATURE' : row.status !== 'COMPLETE' ? 'INCOMPLETE'
      : available > decision ? 'LATE' : 'OK';
    return { id: row.id, eligible: reason === 'OK', reason };
  };
  assert.equal(grade(oracle).passed, cases.length);
  const { classify } = await import('./task/src/eligibility.mjs');
  const starter = grade(classify);
  assert.ok(starter.failures.length >= 5);
  console.log(JSON.stringify({ status: 'FIXTURE_CHECK_ONLY', oracle: `${cases.length}/${cases.length}`, starterPassed: starter.passed, starterRejected: true, pluginRuns: 0 }));
} else {
  if (!process.argv[2]) throw new Error('Pass an absolute task-copy directory or --self-check.');
  if (!path.isAbsolute(process.argv[2])) throw new Error('Task-copy path must be absolute.');
  const { classify } = await import(pathToFileURL(path.join(process.argv[2], 'src/eligibility.mjs')).href);
  const result = grade(classify);
  console.log(JSON.stringify({ ...result, evidenceReview: 'PENDING_MANUAL_REVIEW', pluginSavings: 'UNKNOWN' }, null, 2));
  process.exitCode = result.failures.length ? 1 : 0;
}
