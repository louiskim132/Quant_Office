import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  advanceable, assertNoLocalExecution, evaluatePackage, gateCost, gateFit, gateIntegrity, gatePortfolio,
  gateSelect, gateSpec, gateSplit, gateTarget, gateTime, gateTradeTime, periodEconomics,
} from '../src/core/research-gates.js';
import { assertForecastSeparateFromEconomics, judgeDiagnostic, judgeStress } from '../src/shared/research-diagnostics.js';
import type { CatBoostPackage, GateEvaluation, PredictionRow } from '../src/shared/research-contracts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const outcome = (evaluations: GateEvaluation[], gate: string) => evaluations.find(item => item.gate === gate)!;

const HOUR = 3600;
const iso = (day: number, hour = 0) => new Date(Date.UTC(2024, 0, day, hour)).toISOString();

/**
 * A package that passes every deterministic gate, so each test can plant exactly one defect.
 *
 * Building the honest case first is the point: a suite of only broken fixtures proves the gates say
 * no, not that they can ever say yes, and a gate that always fails protects nothing.
 */
function soundPackage(): CatBoostPackage {
  return {
    schemaVersion: 1, runId: randomUUID(), projectId: randomUUID(), registration: 'PROSPECTIVE',
    specId: '00000000-0000-4000-8000-000000000001', specHash: sha256('frozen spec'), registeredAt: iso(2),
    source: { repository: 'research', commit: 'abc123', sourceHash: sha256('source') },
    model: { library: 'catboost', version: '1.2.5', lossFunction: 'RMSE', iterations: 500, configHash: sha256('config'), seed: 7 },
    dataset: {
      schemaVersion: 1, datasetId: randomUUID(), sourceHash: sha256('data'), rows: 10_000, timezone: 'UTC',
      timestampColumn: 'ts', targetColumn: 'forward_return', firstTimestamp: iso(1), lastTimestamp: iso(60),
      columns: [
        { name: 'ts', dtype: 'TIMESTAMP', role: 'TIMESTAMP', availableAfterSeconds: 0, group: 'index' },
        { name: 'symbol', dtype: 'STRING', role: 'ID', availableAfterSeconds: 0, group: 'index' },
        { name: 'momentum_20', dtype: 'FLOAT', role: 'FEATURE', availableAfterSeconds: 0, group: 'price' },
        { name: 'volume_z', dtype: 'FLOAT', role: 'FEATURE', availableAfterSeconds: 0, group: 'volume' },
        { name: 'forward_return', dtype: 'FLOAT', role: 'TARGET', availableAfterSeconds: 24 * HOUR, group: 'target' },
      ],
    },
    split: {
      schemaVersion: 1, scheme: 'PURGED_WALK_FORWARD', labelHorizonSeconds: 24 * HOUR,
      purgeSeconds: 24 * HOUR, embargoSeconds: 12 * HOUR,
      folds: [
        { id: 'fold-1', trainStart: iso(1), trainEnd: iso(20), testStart: iso(22), testEnd: iso(30) },
        { id: 'fold-2', trainStart: iso(1), trainEnd: iso(30), testStart: iso(32), testEnd: iso(40) },
      ],
    },
    fitScopes: [
      { foldId: 'fold-1', fittedFrom: iso(1), fittedTo: iso(20), rowsFitted: 4000, earlyStoppingOn: 'INNER_VALIDATION', selectionOn: 'TRAIN_ONLY' },
      { foldId: 'fold-2', fittedFrom: iso(1), fittedTo: iso(30), rowsFitted: 6000, earlyStoppingOn: 'NONE', selectionOn: 'INNER_VALIDATION' },
    ],
    predictionInventory: [{ path: 'predictions/oof.jsonl', sha256: sha256('oof'), rows: 2 }],
    failedRuns: [{ runId: randomUUID(), reason: 'The first configuration diverged.', failedAt: iso(3) }],
    receipts: [],
  };
}

function soundPredictions(): PredictionRow[] {
  return [
    { rowId: 'r1', foldId: 'fold-1', timestamp: iso(23), decisionAt: iso(23, 1), tradeAt: iso(23, 2), scope: 'OOF', prediction: 0.4, target: 0.01 },
    { rowId: 'r2', foldId: 'fold-2', timestamp: iso(33), decisionAt: iso(33, 1), tradeAt: iso(33, 2), scope: 'OOF', prediction: -0.2, target: -0.02 },
  ];
}
const SPEC = { id: '00000000-0000-4000-8000-000000000001', hash: sha256('frozen spec'), frozenAt: iso(2) };
const delivered = () => new Map([['predictions/oof.jsonl', { sha256: sha256('oof'), rows: 2 }]]);

test('a sound package passes every deterministic gate, so a failure elsewhere means something', () => {
  const evaluations = evaluatePackage(soundPackage(), { predictions: soundPredictions(), deliveredFiles: delivered(), spec: SPEC,
    periods: [{ period: 'p1', weightsBefore: { AAA: 0 }, weightsAfter: { AAA: 0.5 }, assetReturns: { AAA: 0.02 } }],
    costs: { schemaVersion: 1, commissionBps: 1, halfSpreadBps: 1, slippageBps: 1, borrowBpsPerPeriod: 0, financingBpsPerPeriod: 0 },
    portfolio: { schemaVersion: 1, maxGrossExposure: 1, maxNetExposure: 1, maxPositionWeight: 0.6, maxTurnoverPerPeriod: 1 } });
  const verdict = advanceable(evaluations);
  assert.deepEqual({ failed: verdict.failed, blocked: verdict.blocked }, { failed: [], blocked: [] });
  assert.equal(verdict.canAdvance, true);
});

test('a planted look-ahead feature is caught on the manifest, not inferred from performance', () => {
  const pkg = soundPackage();
  pkg.dataset.columns.find(column => column.name === 'momentum_20')!.availableAfterSeconds = 900;
  const evaluation = gateTime(pkg);
  assert.equal(evaluation.outcome, 'FAIL');
  assert.equal(evaluation.measurements.worstLagSeconds, 900);
  assert.match(evaluation.detail, /look-ahead/);
});

test('target leakage and a target that forecasts nothing are both refused', () => {
  const leaked = soundPackage();
  leaked.dataset.columns.push({ name: 'forward_return', dtype: 'FLOAT', role: 'FEATURE', availableAfterSeconds: 0, group: 'price' });
  assert.equal(gateTarget(leaked).outcome, 'FAIL');
  assert.match(gateTarget(leaked).detail, /appears among the features/);

  const instant = soundPackage();
  instant.dataset.columns.find(column => column.name === 'forward_return')!.availableAfterSeconds = 0;
  assert.match(gateTarget(instant).detail, /nothing is being forecast/);

  // A horizon the split plan does not purge for is a mismatch even when both are individually sane.
  const mismatched = soundPackage();
  mismatched.dataset.columns.find(column => column.name === 'forward_return')!.availableAfterSeconds = 48 * HOUR;
  const evaluation = gateTarget(mismatched);
  assert.equal(evaluation.outcome, 'FAIL');
  assert.deepEqual([evaluation.measurements.targetHorizonSeconds, evaluation.measurements.splitHorizonSeconds], [48 * HOUR, 24 * HOUR]);
});

test('purging that does not cover the label horizon fails even though the folds do not overlap', () => {
  const pkg = soundPackage();
  pkg.split.purgeSeconds = 2 * HOUR; pkg.split.embargoSeconds = 1 * HOUR;
  const evaluation = gateSplit(pkg);
  assert.equal(evaluation.outcome, 'FAIL');
  assert.equal(evaluation.measurements.guardSeconds, 3 * HOUR);
  assert.match(evaluation.detail, /does not cover the 86400s label horizon/);

  // A guard that covers the horizon but is not left between the windows also fails.
  const tight = soundPackage();
  tight.split.folds[0].testStart = iso(20, 1);
  assert.equal(gateSplit(tight).outcome, 'FAIL');
  assert.match(gateSplit(tight).detail, /less than the 129600s guard/);
});

test('early stopping on the outer test window makes a test score an in-sample score', () => {
  const pkg = soundPackage();
  pkg.fitScopes[0].earlyStoppingOn = 'OUTER_TEST';
  const evaluation = gateFit(pkg);
  assert.equal(evaluation.outcome, 'FAIL');
  assert.match(evaluation.detail, /in-sample score/);
});

test('a fit that runs past its own training window, or a fold with no scope at all, is refused', () => {
  const overrun = soundPackage();
  overrun.fitScopes[0].fittedTo = iso(25);
  const failed = gateFit(overrun);
  assert.equal(failed.outcome, 'FAIL');
  assert.equal(failed.measurements.overrunSeconds, 5 * 24 * HOUR);

  const unscoped = soundPackage();
  unscoped.fitScopes = [unscoped.fitScopes[0]];
  const stopped = gateFit(unscoped);
  assert.equal(stopped.outcome, 'BLOCKED', 'a missing fit scope is unknown, not innocent');
  assert.equal(stopped.measurements.unscoped, 1);
});

test('selection on anything the score is measured on is refused', () => {
  for (const selectionOn of ['OUTER_TEST', 'FULL_DATASET'] as const) {
    const pkg = soundPackage();
    pkg.fitScopes[1].selectionOn = selectionOn;
    assert.equal(gateSelect(pkg).outcome, 'FAIL');
  }
  assert.equal(gateSelect(soundPackage()).outcome, 'PASS');
});

test('duplicate out-of-fold rows fail, and unresolved outcomes block instead of counting as zero', () => {
  const duplicated = [...soundPredictions(), { ...soundPredictions()[0] }];
  const evaluation = gateIntegrity(duplicated);
  assert.equal(evaluation.outcome, 'FAIL');
  assert.equal(evaluation.measurements.duplicateRows, 1);
  assert.equal(evaluation.measurements.worstCount, 2);

  const unresolved = soundPredictions();
  unresolved[1].target = null;
  const stopped = gateIntegrity(unresolved);
  assert.equal(stopped.outcome, 'BLOCKED');
  assert.match(stopped.detail, /not counted as zero/);

  assert.equal(gateIntegrity([]).outcome, 'BLOCKED');
});

test('a position cannot be taken before the prediction that motivates it could be acted on', () => {
  const rows = soundPredictions();
  rows[0].tradeAt = iso(23);
  rows[0].decisionAt = iso(23, 1);
  const evaluation = gateTradeTime(rows);
  assert.equal(evaluation.outcome, 'FAIL');
  assert.equal(evaluation.measurements.firstOffender, 'r1');
  assert.equal(gateTradeTime(soundPredictions()).outcome, 'PASS');
});

test('an exploratory result is kept but can never satisfy a preregistration it never had', () => {
  const exploratory = soundPackage();
  exploratory.registration = 'EXPLORATORY';
  const evaluation = gateSpec(exploratory, SPEC);
  assert.equal(evaluation.outcome, 'BLOCKED');
  assert.match(evaluation.detail, /cannot satisfy a preregistration it never had/);

  // A prospective claim whose earliest run predates the freeze is a post-hoc registration.
  const posthoc = soundPackage();
  posthoc.receipts = [{ schemaVersion: 1, templateId: 'diagnostics', templateVersion: '1.0.0', templateHash: sha256('t'),
    dependencies: [], kind: 'DIAGNOSTIC', seed: 1, environment: 'hosted', startedAt: iso(1), finishedAt: iso(1, 2),
    inputHashes: [sha256('in')], outputHashes: [], provenance: 'HOSTED_TEMPLATE_RUN' }];
  const dated = gateSpec(posthoc, SPEC);
  assert.equal(dated.outcome, 'FAIL');
  assert.match(dated.detail, /post-hoc registration/);

  // A specification whose frozen content differs from the claim is not the same specification.
  assert.equal(gateSpec(soundPackage(), { ...SPEC, hash: sha256('edited spec') }).outcome, 'FAIL');
});

test('hand-computed period economics match the implementation exactly', () => {
  const golden = JSON.parse(readFileSync(path.join(here, '..', 'research-templates', 'golden', 'economics.v1.json'), 'utf8'));
  assert.equal(golden.version, '1.0.0');
  for (const scenario of golden.cases) {
    const computed = periodEconomics(scenario.period, golden.costs);
    if ('unpriced' in scenario.expected) {
      assert.deepEqual(computed, { unpriced: scenario.expected.unpriced }, scenario.name);
      continue;
    }
    assert.ok(!('unpriced' in computed), scenario.name);
    for (const field of ['gross', 'turnover', 'cost', 'net'] as const)
      assert.ok(Math.abs((computed as Record<typeof field, number>)[field] - scenario.expected[field]) < 1e-12,
        `${scenario.name}: ${field} computed ${(computed as Record<typeof field, number>)[field]}, expected ${scenario.expected[field]} (${scenario.working})`);
  }
});

test('an unpriceable period blocks the cost gate rather than reporting the priced part of it', () => {
  const golden = JSON.parse(readFileSync(path.join(here, '..', 'research-templates', 'golden', 'economics.v1.json'), 'utf8'));
  const unpriceable = golden.cases.find((item: { expected: Record<string, unknown> }) => 'unpriced' in item.expected)!;
  const evaluation = gateCost([unpriceable.period], golden.costs);
  assert.equal(evaluation.outcome, 'BLOCKED');
  assert.match(evaluation.detail, /Missing returns are not treated as zero/);

  // Costs that exceed the gross result are a failure, not a rounding note.
  const eaten = golden.cases.find((item: { name: string }) => item.name.includes('eaten'))!;
  const failed = gateCost([eaten.period], golden.costs);
  assert.equal(failed.outcome, 'FAIL');
  assert.ok((failed.measurements.net as number) < 0);
  assert.equal(gateCost([], golden.costs).outcome, 'BLOCKED');
});

test('frozen exposure and turnover limits are checked against what was actually held', () => {
  const contract = { schemaVersion: 1, maxGrossExposure: 2, maxNetExposure: 0.1, maxPositionWeight: 0.6, maxTurnoverPerPeriod: 1 };
  const neutral = { period: 'p', weightsBefore: { A: 0.5, B: -0.5 }, weightsAfter: { A: 0.5, B: -0.5 }, assetReturns: { A: 0.01, B: 0.0 } };
  assert.equal(gatePortfolio([neutral], contract).outcome, 'PASS');

  const concentrated = { ...neutral, weightsAfter: { A: 0.9, B: -0.9 } };
  const breach = gatePortfolio([concentrated], contract);
  assert.equal(breach.outcome, 'FAIL');
  assert.equal(breach.measurements.limit, 'position weight');

  const churned = { period: 'p', weightsBefore: { A: 1 }, weightsAfter: { A: -1 }, assetReturns: { A: 0 } };
  assert.equal(gatePortfolio([churned], { ...contract, maxNetExposure: 2, maxPositionWeight: 1 }).measurements.limit, 'turnover');
});

test('missing evidence blocks the economic gates instead of leaving them silently absent', () => {
  const evaluations = evaluatePackage(soundPackage(), { predictions: soundPredictions(), deliveredFiles: delivered(), spec: SPEC });
  assert.equal(outcome(evaluations, 'G-COST').outcome, 'BLOCKED');
  assert.equal(outcome(evaluations, 'G-PORTFOLIO').outcome, 'BLOCKED');
  const verdict = advanceable(evaluations);
  assert.equal(verdict.canAdvance, false);
  assert.deepEqual(verdict.blocked.sort(), ['G-COST', 'G-PORTFOLIO']);
});

test('a declared prediction file that was not delivered blocks the artifact gate', () => {
  const evaluations = evaluatePackage(soundPackage(), { predictions: soundPredictions(), spec: SPEC, deliveredFiles: new Map() });
  assert.equal(outcome(evaluations, 'G-ARTIFACT').outcome, 'BLOCKED');

  const wrong = evaluatePackage(soundPackage(), { predictions: soundPredictions(), spec: SPEC,
    deliveredFiles: new Map([['predictions/oof.jsonl', { sha256: sha256('something else'), rows: 2 }]]) });
  assert.equal(outcome(wrong, 'G-ARTIFACT').outcome, 'FAIL');
});

test('there is no local research fallback, by name', () => {
  assert.throws(() => assertNoLocalExecution({ templateId: 'diagnostics', route: 'LOCAL_FALLBACK' }),
    /never runs research locally, and there is no local fallback/);
  assert.doesNotThrow(() => assertNoLocalExecution({ templateId: 'diagnostics', route: 'HOSTED_TEMPLATE_RUN' }));
});

test('a diagnostic with too few rows or an undefined metric is inadequate, not a negative result', () => {
  const policy = { minimumSamples: 30, minimumSliceSamples: 10, requiredSlices: ['high volatility'], requiredCostMultiples: [1, 2, 5] };
  const thin = judgeDiagnostic({ schemaVersion: 1, receiptHash: sha256('r'),
    signal: { metric: 'RANK_IC', value: null, samples: 4, standardError: null },
    slices: [{ name: 'high volatility', samples: 3, value: null }], featureGroupStability: [], note: '' }, policy);
  assert.equal(thin.adequate, false);
  assert.deepEqual(thin.problems.map(item => item.code).sort(), ['INSUFFICIENT_DATA', 'INSUFFICIENT_DATA', 'UNDEFINED_METRIC']);

  const missing = judgeDiagnostic({ schemaVersion: 1, receiptHash: sha256('r'),
    signal: { metric: 'RANK_IC', value: 0.03, samples: 900, standardError: 0.033 }, slices: [], featureGroupStability: [], note: '' }, policy);
  assert.deepEqual(missing.problems.map(item => item.code), ['MISSING_SLICE']);

  const sound = judgeDiagnostic({ schemaVersion: 1, receiptHash: sha256('r'),
    signal: { metric: 'RANK_IC', value: 0.03, samples: 900, standardError: 0.033 },
    slices: [{ name: 'high volatility', samples: 220, value: 0.02 }],
    featureGroupStability: [{ group: 'price', foldShare: [0.4, 0.42] }], note: '' }, policy);
  assert.deepEqual(sound, { adequate: true, problems: [] });
});

test('stress scenarios must cover the frozen cost multiples, and a missing result is not zero loss', () => {
  const policy = { minimumSamples: 30, minimumSliceSamples: 10, requiredSlices: [], requiredCostMultiples: [1, 2, 5] };
  const verdict = judgeStress({ schemaVersion: 1, receiptHash: sha256('r'), costMultiples: [1, 2],
    scenarios: [{ name: 'double spread', perturbation: 'half spread bps', magnitude: 2, netReturn: null, maxDrawdown: null, samples: 400 }], note: '' }, policy);
  assert.equal(verdict.adequate, false);
  assert.deepEqual(verdict.problems.map(item => item.code).sort(), ['MISSING_STRESS', 'UNDEFINED_METRIC']);
  assert.match(verdict.problems.find(item => item.code === 'UNDEFINED_METRIC')!.detail, /not a zero-loss scenario/);
});

test('a forecast report that carries economic results is refused before it can be summarised', () => {
  assert.throws(() => assertForecastSeparateFromEconomics({ signal: {}, netReturn: 0.02, sharpe: 1.4 }),
    /belong to the economic evaluation and must be reported separately/);
  assert.doesNotThrow(() => assertForecastSeparateFromEconomics({ signal: {}, slices: [], featureGroupStability: [] }));
});
