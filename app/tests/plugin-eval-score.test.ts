import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error harness modules are dependency-free untyped .mjs by design (records.mjs contract)
import { blindPacket, recordScore, runCodeGate, stripPreamble } from '../benchmarks/plugin-evaluation/harness/score.mjs';
// @ts-expect-error same — shared record contract is plain .mjs
import { EVIDENCE_FINDINGS, validateScore } from '../benchmarks/plugin-evaluation/harness/records.mjs';

/**
 * The C10-A blind-scoring seam (roadmap section 3.2): review packets carry no arm or
 * config bytes, the blind->attempt mapping stays evaluator-side, score records always
 * carry all six evidence findings, and code-gate numbers come from the real grader —
 * never guessed. Fixture-only coverage: no plugin is installed, no agent runs.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, '../benchmarks/plugin-evaluation');
const verifyPath = path.join(fixtureDir, 'verify.mjs');
const taskDir = path.join(fixtureDir, 'task');
const NOW = '2026-09-16T12:00:00.000Z';

function tmp(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-score-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function attempt(root: string, attemptId: string, report: string) {
  const dir = path.join(root, 'attempts', attemptId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'REPORT.md'), report);
  return { attemptId, reportPath: path.join(dir, 'REPORT.md'), dir };
}

/** Independent re-derivation of the documented naming contract: seeded shuffle, then hex draws. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function expectedPacket(attemptIds: string[], seed: number) {
  const rng = mulberry32(seed);
  const idx = attemptIds.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const used = new Set<string>();
  return idx.map(i => {
    let hex = '';
    do { hex = Math.floor(rng() * 0x100000000).toString(16).padStart(8, '0'); } while (used.has(hex));
    used.add(hex);
    return { attemptId: attemptIds[i], blindName: `report-${hex}.md` };
  });
}

const BODY = '# Report\nContract v2 governs admission; the v1 rule is superseded.\nAmber inputs need a manifest recheck; Birch is metadata-only.\n';

function presentFindings() {
  return EVIDENCE_FINDINGS.map((id: string) => (
    { id, verdict: 'PRESENT', source: 'catalog.md', heading: 'Beacon source' }));
}

test('blind packet carries no arm/config bytes and reproduces from its seed', t => {
  const root = tmp(t);
  const reports = [
    attempt(root, 'as-run', `Arm: AS\nAttempt: as-run\nProvider: fakeco\nModel: z9-ultra\nTools: serena\n\n${BODY}`),
    attempt(root, 'b0-run', `---\narm: B0\nattempt: b0-run\n---\n${BODY}`),
    attempt(root, 'ag-run', `<!-- arm: AG attempt: ag-run config: graphify -->\n${BODY}`),
  ];
  const reviewDir = path.join(root, 'review');
  const evaluatorDir = path.join(root, 'evaluator');
  const r = blindPacket({
    attemptReports: reports.map(({ attemptId, reportPath }) => ({ attemptId, reportPath })),
    reviewDir, evaluatorDir, seed: 42, now: NOW,
  });

  const expected = expectedPacket(['as-run', 'b0-run', 'ag-run'], 42);
  assert.deepEqual(
    r.entries.map((e: any) => ({ attemptId: e.attemptId, blindName: e.blindName })),
    expected,
    'entries follow the seeded shuffle and names drawn from the same stream',
  );
  const names = readdirSync(reviewDir).sort();
  assert.deepEqual(names, expected.map(e => e.blindName).sort());
  assert.ok(names.every(n => /^report-[0-9a-f]{8}\.md$/.test(n)));

  for (const e of r.entries) {
    const text = readFileSync(e.reviewPath, 'utf8');
    assert.match(text, /# Report/, 'report body survives');
    for (const leak of [e.attemptId, 'fakeco', 'z9-ultra', 'serena', 'graphify', 'Arm:', 'arm:']) {
      assert.ok(!text.includes(leak), `blind copy ${e.blindName} leaks ${leak}`);
    }
  }

  // The mapping lives only on the evaluator side; nothing new lands in the attempt dirs.
  const mapping = JSON.parse(readFileSync(path.join(evaluatorDir, 'blind-map.json'), 'utf8'));
  assert.equal(mapping.schema, 'plugin-eval-blind-map@1');
  assert.equal(mapping.seed, 42);
  assert.deepEqual(
    mapping.entries.map((e: any) => ({ attemptId: e.attemptId, blindName: e.blindName })),
    expected,
  );
  assert.deepEqual(readdirSync(reviewDir).filter(f => f.endsWith('.json')), []);
  for (const a of reports) assert.deepEqual(readdirSync(a.dir), ['REPORT.md']);

  // Same seed reproduces the identical packet; a different seed shuffles differently.
  const root2 = path.join(root, 'again');
  const r2 = blindPacket({
    attemptReports: reports.map(({ attemptId, reportPath }) => ({ attemptId, reportPath })),
    reviewDir: path.join(root2, 'review'), evaluatorDir: path.join(root2, 'evaluator'),
    seed: 42, now: NOW,
  });
  assert.deepEqual(r2.mapping.entries, r.mapping.entries);
  const r3 = blindPacket({
    attemptReports: reports.map(({ attemptId, reportPath }) => ({ attemptId, reportPath })),
    reviewDir: path.join(root, 'r3', 'review'), evaluatorDir: path.join(root, 'r3', 'evaluator'),
    seed: 7, now: NOW,
  });
  assert.notDeepEqual(r3.mapping.entries, r.mapping.entries);
});

test('blindPacket refuses any layout that puts the mapping or packet in reach', t => {
  const root = tmp(t);
  const a = attempt(root, 'as-run', BODY);
  const arg = (reviewDir: string, evaluatorDir: string) => ({
    attemptReports: [{ attemptId: a.attemptId, reportPath: a.reportPath }],
    reviewDir, evaluatorDir, seed: 1, now: NOW,
  });
  assert.throws(() => blindPacket(arg(path.join(root, 'rev'), path.join(root, 'rev', 'eval'))),
    /evaluatorDir must not resolve inside reviewDir/);
  assert.throws(() => blindPacket(arg(path.join(root, 'rev'), path.join(root, 'rev'))),
    /evaluatorDir must not resolve inside reviewDir/);
  assert.throws(() => blindPacket(arg(path.join(root, 'rev'), path.join(a.dir, 'eval'))),
    /evaluatorDir must not resolve inside attempt dir/);
  assert.throws(() => blindPacket(arg(path.join(a.dir, 'rev'), path.join(root, 'eval'))),
    /reviewDir must not resolve inside attempt dir/);
  assert.throws(() => blindPacket(arg(path.dirname(a.dir), path.join(root, 'eval2'))),
    /must not resolve inside reviewDir/);
  // A non-empty review dir is refused — packets never mix.
  const reviewDir = path.join(root, 'occupied');
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(path.join(reviewDir, 'stale.md'), 'x');
  assert.throws(() => blindPacket(arg(reviewDir, path.join(root, 'eval3'))), /reviewDir must be empty/);
});

test('stripPreamble removes only a leading metadata block', () => {
  assert.equal(stripPreamble(`${BODY}`), BODY);
  assert.equal(stripPreamble(`Arm: AS\n\n${BODY}`), BODY);
  assert.equal(stripPreamble(`<!-- arm: AS -->\n${BODY}`), BODY);
  assert.equal(stripPreamble(`---\narm: AS\n---\n${BODY}`), BODY);
  const titled = `Title: admission review\n${BODY}`;
  assert.equal(stripPreamble(titled), titled, 'non-metadata key lines are kept');
});

test('recordScore emits validateScore-clean records covering all six findings', t => {
  const root = tmp(t);
  const a = attempt(root, 'as-run', BODY);
  const b = attempt(root, 'b0-run', BODY);
  const { mapping } = blindPacket({
    attemptReports: [a, b].map(({ attemptId, reportPath }) => ({ attemptId, reportPath })),
    reviewDir: path.join(root, 'review'), evaluatorDir: path.join(root, 'evaluator'),
    seed: 9, now: NOW,
  });
  const blindName = mapping.entries[0].blindName;
  const attemptId = mapping.entries[0].attemptId;

  const record = recordScore({
    mapping, blindName,
    codeGate: { ran: true, exitCode: 0, passed: 16, total: 16 },
    findings: presentFindings().reverse(), // supplied out of order — record carries contract order
    freshness: { newSourceCited: true, birchRecheck: true, unknownPreserved: true },
    defects: [],
  });
  assert.equal(record.schema, 'plugin-eval-score@1');
  assert.equal(record.attemptId, attemptId);
  assert.equal(record.blind, true);
  assert.deepEqual(record.findings.map((f: any) => f.id), EVIDENCE_FINDINGS);
  assert.deepEqual(validateScore(record), []);

  // An omitted finding is recorded MISSING, not dropped or invented.
  const partial = recordScore({
    mapping, blindName,
    findings: presentFindings().slice(1),
    defects: ['report truncated'],
  });
  assert.deepEqual(partial.findings[0], { id: EVIDENCE_FINDINGS[0], verdict: 'MISSING' });
  assert.deepEqual(validateScore(partial), []);

  // Track B scores with no code gate; freshness stays absent unless reviewed.
  const trackB = recordScore({ mapping, blindName, findings: presentFindings() });
  assert.equal(trackB.codeGate, null);
  assert.equal(trackB.freshness, undefined);
  assert.deepEqual(validateScore(trackB), []);

  // A score can never be constructed for an attempt that was never blinded.
  assert.throws(() => recordScore({ mapping, blindName: 'report-deadbeef.md', findings: presentFindings() }),
    /no blinded attempt/);
  assert.throws(() => recordScore({ mapping: { entries: [] }, blindName, findings: presentFindings() }),
    /no blinded attempt/);
  // Schema-dirty records throw instead of emitting: PRESENT without its citation, a
  // verdict outside FINDING_VERDICTS, and a code gate whose counts were never parsed.
  const noCitation = presentFindings();
  delete noCitation[0].source;
  assert.throws(() => recordScore({ mapping, blindName, findings: noCitation }), /not schema-clean/);
  assert.throws(() => recordScore({
    mapping, blindName, findings: [{ id: EVIDENCE_FINDINGS[0], verdict: 'PROBABLY' }],
  }), /not schema-clean/);
  assert.throws(() => recordScore({
    mapping, blindName, findings: presentFindings(),
    codeGate: { ran: true, exitCode: 1, passed: null, total: null },
  }), /not schema-clean/);
  assert.throws(() => recordScore({
    mapping, blindName, findings: [{ id: 'not-a-finding', verdict: 'MISSING' }],
  }), /unknown finding id/);
});

test('runCodeGate reports the real grader: oracle 16/16, starter rejected, garbage recorded not guessed', t => {
  const root = tmp(t);
  const oracleDir = path.join(root, 'oracle');
  const brokenDir = path.join(root, 'broken');
  cpSync(taskDir, oracleDir, { recursive: true });
  cpSync(taskDir, brokenDir, { recursive: true });
  // The known-correct eligibility logic: contract-v2 precedence as encoded by the
  // grader's own self-check oracle (parse -> kind -> status -> lateness).
  writeFileSync(path.join(oracleDir, 'src', 'eligibility.mjs'),
    `import { instant } from './time.mjs';\n` +
    `export function classify(row) {\n` +
    `  const [observed, available, decision] = [row.observedAt, row.availableAt, row.decisionAt].map(instant);\n` +
    `  const reason = [observed, available, decision].includes(null) || observed > available ? 'INVALID_TIME'\n` +
    `    : row.kind !== 'FEATURE' ? 'NOT_FEATURE' : row.status !== 'COMPLETE' ? 'INCOMPLETE'\n` +
    `    : available > decision ? 'LATE' : 'OK';\n` +
    `  return { id: row.id, eligible: reason === 'OK', reason };\n` +
    `}\n`);

  const oracle = runCodeGate(oracleDir, verifyPath);
  assert.deepEqual(oracle, { ran: true, exitCode: 0, passed: 16, total: 16 });
  const broken = runCodeGate(brokenDir, verifyPath);
  assert.equal(broken.ran, true);
  assert.equal(broken.exitCode, 1);
  assert.equal(broken.total, 16);
  assert.ok(broken.passed < 16, 'the deliberately broken starter is rejected');

  // A grader that exits non-zero without JSON is recorded as unknown, never guessed.
  const garbage = path.join(root, 'garbage-verify.mjs');
  writeFileSync(garbage, `console.log('not json'); process.exit(1);\n`);
  const unknown = runCodeGate(brokenDir, garbage);
  assert.deepEqual(unknown, { ran: true, exitCode: 1, passed: null, total: null });
});
