import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = (name: string) => pathToFileURL(path.join(here, '..', 'benchmarks', 'plugin-evaluation', 'harness', name)).href;
// Dependency-free .mjs harness modules carry no type declarations; their shapes are asserted below.
const { scorecard, verdict } = (await import(harness('scorecard.mjs'))) as any;
const { EVIDENCE_FINDINGS } = (await import(harness('records.mjs'))) as any;

const sha = (c: string) => c.repeat(64);
const manifest = (attemptId: string, arm: string, phase = 'INITIAL', setupMs = 0) => ({
  schema: 'plugin-eval-attempt@1', attemptId, arm, phase,
  promptSha256: sha('a'), taskHash: sha('b'),
  files: [{ path: 'TASK.md', sha256: sha('c'), bytes: 12 }],
  config: { provider: 'p', model: 'm', effort: 'e', clientVersion: '1.0', tools: [] },
  timeboxMs: 600000, setupMs, createdAt: '2026-09-16T00:00:00Z',
});
/** Agent token counters summing exactly to `total`; extra overrides can null a counter (UNKNOWN). */
const usage = (attemptId: string, total: number, extra: Record<string, unknown> = {}) => {
  const input = Math.floor(total / 2), output = Math.floor(total / 3);
  return {
    schema: 'plugin-eval-usage@1', attemptId,
    agent: { input, output, reasoning: total - input - output, cacheRead: 0, cacheWrite: 0 },
    helperModels: [], setupWallMs: 0, taskWallMs: 60000, toolBytes: 0, ...extra,
  };
};
const present = { source: 'catalog.md', heading: 'Sources' };
const score = (attemptId: string, opts: { missingFinding?: number; codeGate?: unknown; freshness?: unknown } = {}) => ({
  schema: 'plugin-eval-score@1', attemptId,
  codeGate: opts.codeGate === undefined ? { ran: true, exitCode: 0, passed: 16, total: 16 } : opts.codeGate,
  findings: EVIDENCE_FINDINGS.map((id: string, i: number) => ({
    id, verdict: i === opts.missingFinding ? 'MISSING' : 'PRESENT', ...present,
  })),
  ...(opts.freshness === undefined ? {} : { freshness: opts.freshness }),
  defects: [], blind: true,
});
/** One bundled ledger entry; pass score:null for an attempt that ran unscored. */
const attempt = (arm: string, n: number, tokens: number, opts: { phase?: string; setupMs?: number; missingFinding?: number; codeGate?: unknown; freshness?: unknown; noScore?: boolean; usageExtra?: Record<string, unknown> } = {}) => {
  const id = `${arm.toLowerCase()}-${opts.phase === 'FRESHNESS' ? 'f' : 'i'}${n}`;
  return {
    manifest: manifest(id, arm, opts.phase ?? 'INITIAL', opts.setupMs ?? 0),
    usage: usage(id, tokens, opts.usageExtra ?? {}),
    score: opts.noScore ? null : score(id, { missingFinding: opts.missingFinding, codeGate: opts.codeGate, freshness: opts.freshness }),
  };
};

test('quality gate precedes efficiency: a token-winning arm that misses a finding is GATE_FAILED', () => {
  const card = scorecard([
    attempt('A0', 1, 1000),
    attempt('AS', 1, 400, { missingFinding: 2 }),
  ]);
  assert.equal(card.arms.A0.gate.status, 'PASSED');
  assert.equal(card.arms.AS.gate.status, 'GATE_FAILED');
  assert.match(card.arms.AS.gate.failures[0].problems[0], /amber-v1-manifest-recheck/);
  assert.equal(verdict(card.arms.A0, card.arms.AS), 'GATE_FAILED');
});

test('track A requires a full code gate even when findings are present', () => {
  const card = scorecard([
    attempt('A0', 1, 1000),
    attempt('AP', 1, 300, { codeGate: { ran: true, exitCode: 1, passed: 15, total: 16 } }),
  ]);
  assert.equal(card.arms.AP.gate.status, 'GATE_FAILED');
  assert.equal(verdict(card.arms.A0, card.arms.AP), 'GATE_FAILED');
});

test('missing counters surface as UNKNOWN, never zero, and make the verdict INCONCLUSIVE', () => {
  const card = scorecard([
    attempt('A0', 1, 1000),
    attempt('AS', 1, 400, { usageExtra: { agent: { input: null, output: 100, reasoning: 50, cacheRead: 0, cacheWrite: 0 } } }),
  ]);
  const eff = card.arms.AS.efficiency;
  assert.equal(eff.total.input, 'UNKNOWN');
  assert.equal(eff.total.totalTokens, 'UNKNOWN');
  assert.equal(eff.perSuccessfulTask.totalTokens, 'UNKNOWN');
  assert.equal(verdict(card.arms.A0, card.arms.AS), 'INCONCLUSIVE');
});

test('an arm with zero successful tasks has no finite efficiency score', () => {
  const card = scorecard([
    attempt('AG', 1, 700, { missingFinding: 0 }),
    attempt('AG', 2, 800, { noScore: true }),
  ]);
  assert.equal(card.arms.AG.gate.status, 'GATE_FAILED');
  assert.equal(card.arms.AG.efficiency, 'NO_FINITE_SCORE');
});

test('failed-attempt usage is charged to the arm total per successful task', () => {
  const card = scorecard([
    attempt('A0', 1, 1000),
    attempt('A0', 2, 400, { missingFinding: 5 }),
    attempt('AS', 1, 300),
  ]);
  const eff = card.arms.A0.efficiency;
  assert.equal(eff.successfulTasks, 1);
  assert.equal(eff.total.totalTokens, 1400);
  assert.equal(eff.perSuccessfulTask.totalTokens, 1400);
});

test('cold runs with first-use setup are reported separately from reuse runs', () => {
  const card = scorecard([
    attempt('AS', 1, 700, { setupMs: 9000, usageExtra: { setupWallMs: 9000 } }),
    attempt('AS', 2, 400),
    attempt('AS', 3, 420),
    attempt('A0', 1, 1000),
  ]);
  const eff = card.arms.AS.efficiency;
  assert.equal(eff.cold.attempts, 1);
  assert.equal(eff.cold.total.totalTokens, 700);
  assert.equal(eff.reuse.attempts, 2);
  assert.equal(eff.reuse.total.totalTokens, 820);
  assert.equal(eff.total.totalTokens, 1520);
});

test('savings within observed variation are INCONCLUSIVE, not a benefit', () => {
  const card = scorecard([
    attempt('A0', 1, 1000), attempt('A0', 2, 1200),
    attempt('AS', 1, 1000), attempt('AS', 2, 1100),
  ]);
  assert.equal(card.arms.AS.efficiency.perSuccessfulTask.totalTokens, 1050);
  assert.equal(verdict(card.arms.A0, card.arms.AS), 'INCONCLUSIVE');
});

test('a real reduction outside observed variation on a gate-passing arm is PROMISING', () => {
  const card = scorecard([
    attempt('A0', 1, 1000), attempt('A0', 2, 1200),
    attempt('AS', 1, 400), attempt('AS', 2, 500),
  ]);
  assert.equal(verdict(card.arms.A0, card.arms.AS), 'PROMISING');
});

test('equal or higher usage with quality held is NO_BENEFIT', () => {
  const card = scorecard([
    attempt('A0', 1, 1000), attempt('A0', 2, 1200),
    attempt('AS', 1, 1100), attempt('AS', 2, 1300),
  ]);
  assert.equal(verdict(card.arms.A0, card.arms.AS), 'NO_BENEFIT');
});

test('a freshness attempt must cite the new source, recheck Birch and preserve the unknown', () => {
  const fresh = { newSourceCited: true, birchRecheck: true, unknownPreserved: true };
  const card = scorecard([
    attempt('A0', 1, 1000),
    attempt('AS', 1, 500),
    attempt('AS', 1, 200, { phase: 'FRESHNESS', freshness: { ...fresh, birchRecheck: false } }),
  ]);
  assert.equal(card.arms.AS.gate.status, 'PASSED'); // initial success still gates the arm
  assert.equal(card.arms.AS.gate.failedAttempts, 1);
  assert.match(card.arms.AS.gate.failures[0].problems[0], /freshness/);
  const ok = scorecard([attempt('AS', 1, 200, { phase: 'FRESHNESS', freshness: fresh })]);
  assert.equal(ok.arms.AS.gate.status, 'PASSED');
});

test('track B arms gate on the six findings without a code gate', () => {
  const card = scorecard([
    { manifest: manifest('b0-i1', 'B0'), usage: usage('b0-i1', 900), score: { ...score('b0-i1'), codeGate: null } },
    { manifest: manifest('bg-i1', 'BG'), usage: usage('bg-i1', 300), score: { ...score('bg-i1'), codeGate: null } },
  ]);
  assert.equal(card.arms.B0.gate.status, 'PASSED');
  assert.equal(card.arms.BG.gate.status, 'PASSED');
  assert.equal(verdict(card.arms.B0, card.arms.BG), 'PROMISING');
});

test('a cross-track comparison is never a promotion signal', () => {
  const card = scorecard([
    attempt('A0', 1, 1000),
    { manifest: manifest('bg-i1', 'BG'), usage: usage('bg-i1', 100), score: { ...score('bg-i1'), codeGate: null } },
  ]);
  assert.equal(verdict(card.arms.A0, card.arms.BG), 'INCONCLUSIVE');
});

test('bare manifest/usage/score records are merged by attemptId', () => {
  const m = manifest('a0-i1', 'A0'), u = usage('a0-i1', 800), s = score('a0-i1');
  const card = scorecard([m, u, s]);
  assert.equal(card.arms.A0.gate.status, 'PASSED');
  assert.equal(card.arms.A0.efficiency.total.totalTokens, 800);
});
