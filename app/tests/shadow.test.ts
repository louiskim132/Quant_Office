import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  evaluateShadow,
  impactClaimBlocker,
  thresholdInvalidation,
  type Fill,
  type Quote,
  type ShadowPolicy,
  type ShadowPrediction,
} from '../src/shared/shadow.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const at = (day: number, hour = 0) => new Date(Date.UTC(2024, 5, day, hour)).toISOString();
const BRANCH = randomUUID(),
  SPEC = randomUUID(),
  CANDIDATE = sha256('candidate');

const policy = (overrides: Partial<ShadowPolicy> = {}): ShadowPolicy => ({
  minimumSamples: 20,
  maximumMissingShare: 0.2,
  retireBelowMetric: -0.01,
  qualifyAtOrAboveMetric: 0.01,
  driftAlarmMetric: 0.0,
  killBelowMetric: -0.05,
  thresholdHash: sha256('thresholds v1'),
  ...overrides,
});

/** `count` predictions recorded a day before the moment each forecasts. */
function predictions(count: number, sign = 1): ShadowPrediction[] {
  return Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    branchId: BRANCH,
    specId: SPEC,
    candidateHash: CANDIDATE,
    symbol: 'AAA',
    recordedAt: at(1),
    forecastFor: at(2, index),
    prediction: sign * (0.1 + index / 1000),
    horizonSeconds: 86_400,
  }));
}
const quotesFor = (items: ShadowPrediction[]): Quote[] =>
  items.map(item => ({ symbol: item.symbol, at: item.forecastFor, bid: 99.9, ask: 100.1, source: 'fixture feed' }));
const outcomesFor = (items: ShadowPrediction[], value: number) =>
  Object.fromEntries(items.map(item => [item.id, value])) as Record<string, number | null>;

test('a prediction recorded at or after the moment it forecasts refuses the whole period', () => {
  const items = predictions(25);
  items[7] = { ...items[7], recordedAt: at(3), forecastFor: at(2) };
  const verdict = evaluateShadow({
    predictions: items,
    quotes: quotesFor(items),
    fills: [],
    policy: policy(),
    outcomes: outcomesFor(items, 0.02),
    now: at(3),
  });
  assert.equal(verdict.outcome, 'SUSPENDED');
  assert.deepEqual(verdict.problems, ['BACKDATED_PREDICTION']);
  assert.match(verdict.detail, /a description, not a prospective record/);
  assert.equal(verdict.metric, null);

  // A prediction recorded at exactly the moment it forecasts is no better than one recorded after.
  const boundary = predictions(25);
  boundary[0] = { ...boundary[0], recordedAt: boundary[0].forecastFor };
  assert.equal(
    evaluateShadow({
      predictions: boundary,
      quotes: quotesFor(boundary),
      fills: [],
      policy: policy(),
      outcomes: outcomesFor(boundary, 0.02),
      now: at(3),
    }).outcome,
    'SUSPENDED',
  );
});

test('predictions that have not reached their horizon are open, not a result', () => {
  const items = predictions(25);
  const verdict = evaluateShadow({
    predictions: items,
    quotes: quotesFor(items),
    fills: [],
    policy: policy(),
    outcomes: {},
    now: at(1, 23),
  });
  assert.equal(verdict.outcome, 'UNKNOWN');
  assert.equal(verdict.samples, 0);
  assert.match(verdict.detail, /still open. Nothing is being reported as a result/);
});

test('too much missing data suspends the period instead of scoring the part that arrived', () => {
  const items = predictions(25);
  const partial = outcomesFor(items.slice(0, 10), 0.02);
  const verdict = evaluateShadow({
    predictions: items,
    quotes: quotesFor(items),
    fills: [],
    policy: policy(),
    outcomes: partial,
    now: at(3),
  });
  assert.equal(verdict.outcome, 'SUSPENDED');
  assert.ok(verdict.problems.includes('MISSING_DATA_SUSPENSION'));
  assert.equal(verdict.metric, null, 'a suspended period reports no metric at all');
  assert.match(verdict.detail, /rather than scored on the part that happens to be present/);
});

test('too few resolved outcomes is unknown, which is not the same as no effect', () => {
  const items = predictions(10);
  const verdict = evaluateShadow({
    predictions: items,
    quotes: quotesFor(items),
    fills: [],
    policy: policy(),
    outcomes: outcomesFor(items, 0.02),
    now: at(3),
  });
  assert.equal(verdict.outcome, 'UNKNOWN');
  assert.equal(verdict.metric, null);
  assert.match(verdict.detail, /no power to say anything, which is not the same as saying nothing happened/);
});

test('missing quotes are reported even when the outcomes are complete', () => {
  const items = predictions(25);
  const verdict = evaluateShadow({
    predictions: items,
    quotes: quotesFor(items).slice(0, 20),
    fills: [],
    policy: policy(),
    outcomes: outcomesFor(items, 0.02),
    now: at(3),
  });
  assert.ok(verdict.problems.includes('MISSING_QUOTES'));
  assert.equal(verdict.outcome, 'UNKNOWN', 'missing quote coverage cannot qualify a shadow period');
});

test('a drift alarm asks for attention; a kill threshold stops the shadow', () => {
  const items = predictions(25);
  const drifting = evaluateShadow({
    predictions: items,
    quotes: quotesFor(items),
    fills: [],
    policy: policy(),
    outcomes: outcomesFor(items, -0.005),
    now: at(3),
  });
  assert.equal(drifting.alarm, true);
  assert.equal(drifting.killed, false);
  assert.match(drifting.detail, /asks a person to look; it does not stop the shadow/);

  const killed = evaluateShadow({
    predictions: items,
    quotes: quotesFor(items),
    fills: [],
    policy: policy(),
    outcomes: outcomesFor(items, -0.2),
    now: at(3),
  });
  assert.equal(killed.killed, true);
  assert.equal(killed.alarm, false, 'a kill is not also an alarm; they are different instructions');
  assert.equal(killed.outcome, 'RETIRED');

  const qualified = evaluateShadow({
    predictions: items,
    quotes: quotesFor(items),
    fills: [],
    policy: policy(),
    outcomes: outcomesFor(items, 0.05),
    now: at(3),
  });
  assert.deepEqual([qualified.outcome, qualified.alarm, qualified.killed], ['SHADOW_QUALIFIED', false, false]);

  // Between retirement and qualification is inconclusive, which is its own answer.
  const between = evaluateShadow({
    predictions: items,
    quotes: quotesFor(items),
    fills: [],
    policy: policy(),
    outcomes: outcomesFor(items, 0.005),
    now: at(3),
  });
  assert.equal(between.outcome, 'INCONCLUSIVE');
});

test('a simulated fill cannot establish market impact', () => {
  const fills: Fill[] = [
    {
      predictionId: randomUUID(),
      symbol: 'AAA',
      at: at(2),
      quantity: 100,
      price: 100,
      kind: 'SIMULATED',
      provenance: 'mid-price model',
    },
    {
      predictionId: randomUUID(),
      symbol: 'AAA',
      at: at(2),
      quantity: 100,
      price: 100.05,
      kind: 'EXECUTED',
      provenance: 'broker statement 2024-06-02',
    },
  ];
  assert.match(impactClaimBlocker(fills) ?? '', /priced against a book that did not move in response to it/);
  assert.equal(impactClaimBlocker(fills.filter(fill => fill.kind === 'EXECUTED')), null);
  assert.equal(impactClaimBlocker([]), null);
});

test('changing a threshold invalidates a verdict rather than rescoring it', () => {
  assert.equal(thresholdInvalidation(sha256('thresholds v1'), sha256('thresholds v1')), null);
  assert.match(
    thresholdInvalidation(sha256('thresholds v1'), sha256('thresholds v2')) ?? '',
    /no longer stands. Re-run the evaluation under the current frozen thresholds/,
  );
});

test('nothing here reaches a network or an order interface', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/shared/shadow.ts', import.meta.url), 'utf8'),
  );
  for (const forbidden of ['fetch(', 'http', 'net.', 'WebSocket', 'placeOrder', 'submitOrder'])
    assert.equal(source.includes(forbidden), false, `shadow.ts must not reference ${forbidden}`);
});
