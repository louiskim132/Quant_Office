import {
  catBoostPackageSchema,
  costModelSchema,
  periodSchema,
  portfolioContractSchema,
  predictionRowSchema,
  type CatBoostPackage,
  type CostModel,
  type GateEvaluation,
  type Period,
  type PortfolioContract,
  type PredictionRow,
} from '../shared/research-contracts.js';
import type { GateId } from '../shared/research.js';

/**
 * The deterministic gates: given a frozen package and its predictions, what can be said and what
 * cannot.
 *
 * Every function here returns BLOCKED rather than a value when the input needed to decide is absent.
 * That is the whole design. A missing cost parameter treated as zero, an undefined metric reported as
 * 0.0, an unfilled target counted as a flat return — each of those turns "we do not know" into "it
 * worked", and each of them is cheap to write by accident.
 */

const ms = (iso: string) => Date.parse(iso);
const blocked = (
  gate: GateId,
  detail: string,
  measurements: Record<string, number | string | null> = {},
): GateEvaluation => ({ gate, outcome: 'BLOCKED', detail, measurements });
const fail = (
  gate: GateId,
  detail: string,
  measurements: Record<string, number | string | null> = {},
): GateEvaluation => ({ gate, outcome: 'FAIL', detail, measurements });
const pass = (
  gate: GateId,
  detail: string,
  measurements: Record<string, number | string | null> = {},
): GateEvaluation => ({ gate, outcome: 'PASS', detail, measurements });

// ---- timing and leakage -----------------------------------------------------------------------

/**
 * G-TIME: no feature may be knowable only after the row it describes.
 *
 * A positive `availableAfterSeconds` on a feature is a look-ahead by construction, whatever the
 * backtest says afterwards, so this is checked on the manifest rather than inferred from performance.
 */
export function gateTime(pkg: CatBoostPackage): GateEvaluation {
  const features = pkg.dataset.columns.filter(column => column.role === 'FEATURE');
  if (!features.length)
    return blocked('G-TIME', 'The dataset manifest declares no feature columns, so their timing cannot be checked.');
  const ahead = features.filter(column => column.availableAfterSeconds > 0);
  if (ahead.length)
    return fail(
      'G-TIME',
      `${ahead.length} feature${ahead.length === 1 ? '' : 's'} are knowable only after their own timestamp, starting with ${ahead[0].name} at +${ahead[0].availableAfterSeconds}s. That is a look-ahead.`,
      {
        offendingFeatures: ahead.length,
        worstLagSeconds: Math.max(...ahead.map(c => c.availableAfterSeconds)),
        firstOffender: ahead[0].name,
      },
    );
  if (ms(pkg.dataset.lastTimestamp) <= ms(pkg.dataset.firstTimestamp))
    return fail('G-TIME', 'The dataset manifest does not span a positive time range.', {
      spanSeconds: (ms(pkg.dataset.lastTimestamp) - ms(pkg.dataset.firstTimestamp)) / 1000,
    });
  return pass('G-TIME', `All ${features.length} features are knowable at their own timestamp.`, {
    features: features.length,
    timezone: pkg.dataset.timezone,
  });
}

/**
 * G-TARGET: the label must be a future outcome, and must not also be sitting in the feature set.
 *
 * The two failures are opposite and equally fatal: a target with a zero horizon is not a forecast,
 * and a target present among the features is the answer written on the question paper.
 */
export function gateTarget(pkg: CatBoostPackage): GateEvaluation {
  const target = pkg.dataset.columns.find(column => column.name === pkg.dataset.targetColumn);
  if (!target)
    return blocked(
      'G-TARGET',
      `The manifest names ${pkg.dataset.targetColumn} as its target but does not describe that column.`,
    );
  if (target.role !== 'TARGET')
    return fail('G-TARGET', `${target.name} is used as the target but is declared as ${target.role}.`, {
      declaredRole: target.role,
    });
  const duplicate = pkg.dataset.columns.find(
    column => column.role === 'FEATURE' && column.name === pkg.dataset.targetColumn,
  );
  if (duplicate)
    return fail('G-TARGET', `${target.name} appears among the features as well as the target.`, {
      leakedColumn: target.name,
    });
  if (target.availableAfterSeconds <= 0)
    return fail('G-TARGET', 'The target is knowable at its own timestamp, so nothing is being forecast.', {
      labelHorizonSeconds: target.availableAfterSeconds,
    });
  if (target.availableAfterSeconds !== pkg.split.labelHorizonSeconds)
    return fail(
      'G-TARGET',
      `The target resolves after ${target.availableAfterSeconds}s but the split plan purges for a ${pkg.split.labelHorizonSeconds}s horizon.`,
      { targetHorizonSeconds: target.availableAfterSeconds, splitHorizonSeconds: pkg.split.labelHorizonSeconds },
    );
  return pass(
    'G-TARGET',
    `The target resolves ${target.availableAfterSeconds}s after its row and is absent from the features.`,
    { labelHorizonSeconds: target.availableAfterSeconds },
  );
}

/**
 * G-SPLIT: train must end before test begins, by at least the label horizon plus the embargo.
 *
 * Purging without covering the horizon is the failure that looks correct: the folds do not overlap,
 * and yet the last training labels were still resolving inside the test window.
 */
export function gateSplit(pkg: CatBoostPackage): GateEvaluation {
  const guard = pkg.split.purgeSeconds + pkg.split.embargoSeconds;
  if (guard < pkg.split.labelHorizonSeconds)
    return fail(
      'G-SPLIT',
      `Purge plus embargo is ${guard}s, which does not cover the ${pkg.split.labelHorizonSeconds}s label horizon.`,
      { guardSeconds: guard, labelHorizonSeconds: pkg.split.labelHorizonSeconds },
    );
  for (const fold of pkg.split.folds) {
    if (ms(fold.trainEnd) <= ms(fold.trainStart) || ms(fold.testEnd) <= ms(fold.testStart))
      return fail('G-SPLIT', `Fold ${fold.id} has an empty train or test window.`, { fold: fold.id });
    const gapSeconds = (ms(fold.testStart) - ms(fold.trainEnd)) / 1000;
    if (gapSeconds < guard)
      return fail(
        'G-SPLIT',
        `Fold ${fold.id} leaves ${gapSeconds}s between training and test, less than the ${guard}s guard.`,
        { fold: fold.id, gapSeconds, guardSeconds: guard },
      );
  }
  return pass(
    'G-SPLIT',
    `All ${pkg.split.folds.length} folds keep a ${guard}s guard covering the ${pkg.split.labelHorizonSeconds}s horizon.`,
    { folds: pkg.split.folds.length, guardSeconds: guard },
  );
}

/**
 * G-FIT: every fold was fitted inside its own training window, stopped on nothing it will be scored
 * against, and selected features on nothing wider.
 */
export function gateFit(pkg: CatBoostPackage): GateEvaluation {
  for (const scope of pkg.fitScopes) {
    const fold = pkg.split.folds.find(item => item.id === scope.foldId);
    if (!fold)
      return blocked('G-FIT', `A fit scope names fold ${scope.foldId}, which the split plan does not contain.`, {
        fold: scope.foldId,
      });
    if (scope.earlyStoppingOn === 'OUTER_TEST')
      return fail(
        'G-FIT',
        `Fold ${fold.id} stopped early on its outer test window, so its test score is an in-sample score.`,
        { fold: fold.id, earlyStoppingOn: scope.earlyStoppingOn },
      );
    if (ms(scope.fittedFrom) < ms(fold.trainStart) || ms(scope.fittedTo) > ms(fold.trainEnd))
      return fail(
        'G-FIT',
        `Fold ${fold.id} was fitted on ${scope.fittedFrom} to ${scope.fittedTo}, outside its training window ${fold.trainStart} to ${fold.trainEnd}.`,
        { fold: fold.id, overrunSeconds: Math.max(0, (ms(scope.fittedTo) - ms(fold.trainEnd)) / 1000) },
      );
  }
  const missing = pkg.split.folds.filter(fold => !pkg.fitScopes.some(scope => scope.foldId === fold.id));
  if (missing.length)
    return blocked(
      'G-FIT',
      `${missing.length} fold${missing.length === 1 ? '' : 's'} have no recorded fit scope, starting with ${missing[0].id}.`,
      { unscoped: missing.length },
    );
  return pass(
    'G-FIT',
    `All ${pkg.fitScopes.length} folds were fitted inside their own training windows without outer-test early stopping.`,
    { folds: pkg.fitScopes.length },
  );
}

/** G-SELECT: model or feature selection may only look at training or inner-validation data. */
export function gateSelect(pkg: CatBoostPackage): GateEvaluation {
  const wide = pkg.fitScopes.filter(
    scope => scope.selectionOn === 'OUTER_TEST' || scope.selectionOn === 'FULL_DATASET',
  );
  if (wide.length)
    return fail(
      'G-SELECT',
      `${wide.length} fold${wide.length === 1 ? '' : 's'} selected on ${wide[0].selectionOn}, which the reported score is then measured on.`,
      { folds: wide.length, selectionOn: wide[0].selectionOn },
    );
  return pass('G-SELECT', 'Selection was confined to training and inner-validation data in every fold.', {
    folds: pkg.fitScopes.length,
  });
}

/**
 * G-INTEGRITY: out-of-fold predictions must cover each row exactly once.
 *
 * A duplicated OOF row is not a rounding problem. It reweights the evaluation towards whatever was
 * duplicated, and it is the ordinary consequence of concatenating fold outputs without checking.
 */
export function gateIntegrity(rows: unknown[]): GateEvaluation {
  const parsed: PredictionRow[] = rows.map(row => predictionRowSchema.parse(row));
  const oof = parsed.filter(row => row.scope === 'OOF');
  if (!oof.length)
    return blocked('G-INTEGRITY', 'No out-of-fold predictions were supplied, so their coverage cannot be checked.');
  const seen = new Map<string, number>();
  for (const row of oof) seen.set(row.rowId, (seen.get(row.rowId) ?? 0) + 1);
  const duplicates = [...seen].filter(([, count]) => count > 1);
  if (duplicates.length)
    return fail(
      'G-INTEGRITY',
      `${duplicates.length} row${duplicates.length === 1 ? ' is' : 's are'} predicted out of fold more than once, starting with ${duplicates[0][0]} (${duplicates[0][1]} times).`,
      { duplicateRows: duplicates.length, worstCount: Math.max(...duplicates.map(([, count]) => count)) },
    );
  const unresolved = oof.filter(row => row.target === null);
  if (unresolved.length)
    return blocked(
      'G-INTEGRITY',
      `${unresolved.length} of ${oof.length} out-of-fold rows have no resolved outcome yet. They are not counted as zero.`,
      { unresolved: unresolved.length, rows: oof.length },
    );
  return pass(
    'G-INTEGRITY',
    `All ${oof.length} out-of-fold rows are predicted exactly once and have resolved outcomes.`,
    { rows: oof.length },
  );
}

/** G-TRADETIME: a position may only be taken after the prediction that motivates it could be acted on. */
export function gateTradeTime(rows: unknown[]): GateEvaluation {
  const parsed: PredictionRow[] = rows.map(row => predictionRowSchema.parse(row));
  if (!parsed.length)
    return blocked('G-TRADETIME', 'No predictions were supplied, so their trade timing cannot be checked.');
  const early = parsed.filter(row => ms(row.tradeAt) < ms(row.decisionAt) || ms(row.decisionAt) < ms(row.timestamp));
  if (early.length)
    return fail(
      'G-TRADETIME',
      `${early.length} prediction${early.length === 1 ? ' is' : 's are'} traded before they could be acted on, starting with ${early[0].rowId}.`,
      { offendingRows: early.length, firstOffender: early[0].rowId },
    );
  const lags = parsed.map(row => (ms(row.tradeAt) - ms(row.timestamp)) / 1000);
  return pass('G-TRADETIME', `All ${parsed.length} predictions are traded after their decision time.`, {
    rows: parsed.length,
    minLagSeconds: Math.min(...lags),
  });
}

// ---- economics --------------------------------------------------------------------------------

export interface PeriodEconomics {
  period: string;
  gross: number;
  turnover: number;
  cost: number;
  net: number;
}

/**
 * The exact arithmetic of one period, written so it can be checked by hand.
 *
 * gross = sum over assets of weight_after * assetReturn.
 * turnover = sum over assets of |weight_after - weight_before|.
 * cost = turnover * (commission + half spread + slippage) / 10_000
 *      + sum of |short weights| * borrow / 10_000 + gross exposure * financing / 10_000.
 * net = gross - cost.
 *
 * An asset with a weight but no return is not worth zero; it means the period cannot be priced, and
 * the caller is told so rather than handed a number.
 */
export function periodEconomics(input: unknown, costs: unknown): PeriodEconomics | { unpriced: string[] } {
  const period: Period = periodSchema.parse(input);
  const model: CostModel = costModelSchema.parse(costs);
  const assets = new Set([...Object.keys(period.weightsBefore), ...Object.keys(period.weightsAfter)]);
  const unpriced = [...assets].filter(
    asset => (period.weightsAfter[asset] ?? 0) !== 0 && !(asset in period.assetReturns),
  );
  if (unpriced.length) return { unpriced: unpriced.sort() };
  let gross = 0,
    turnover = 0,
    shortExposure = 0,
    grossExposure = 0;
  for (const asset of assets) {
    const before = period.weightsBefore[asset] ?? 0,
      after = period.weightsAfter[asset] ?? 0;
    gross += after * (period.assetReturns[asset] ?? 0);
    turnover += Math.abs(after - before);
    if (after < 0) shortExposure += Math.abs(after);
    grossExposure += Math.abs(after);
  }
  const tradingCost = (turnover * (model.commissionBps + model.halfSpreadBps + model.slippageBps)) / 10_000;
  const carryCost =
    (shortExposure * model.borrowBpsPerPeriod) / 10_000 + (grossExposure * model.financingBpsPerPeriod) / 10_000;
  const cost = tradingCost + carryCost;
  return { period: period.period, gross, turnover, cost, net: gross - cost };
}

/** G-COST: every period must be priceable, and the net result is reported as computed, not as hoped. */
export function gateCost(periods: unknown[], costs: unknown): GateEvaluation {
  if (!periods.length) return blocked('G-COST', 'No periods were supplied, so no net result can be computed.');
  const results: PeriodEconomics[] = [];
  for (const period of periods) {
    const outcome = periodEconomics(period, costs);
    if ('unpriced' in outcome)
      return blocked(
        'G-COST',
        `A period cannot be priced: ${outcome.unpriced.length} held asset${outcome.unpriced.length === 1 ? '' : 's'} have no return (${outcome.unpriced.slice(0, 5).join(', ')}). Missing returns are not treated as zero.`,
        { unpricedAssets: outcome.unpriced.length },
      );
    results.push(outcome);
  }
  const gross = results.reduce((sum, item) => sum + item.gross, 0);
  const cost = results.reduce((sum, item) => sum + item.cost, 0);
  const net = gross - cost;
  return {
    gate: 'G-COST',
    outcome: net > 0 ? 'PASS' : 'FAIL',
    detail:
      net > 0
        ? `Net of costs the strategy returns ${net.toFixed(6)} across ${results.length} periods.`
        : `Costs of ${cost.toFixed(6)} exceed or equal the gross ${gross.toFixed(6)} across ${results.length} periods, so there is no net result to carry forward.`,
    measurements: {
      periods: results.length,
      gross,
      cost,
      net,
      turnover: results.reduce((sum, item) => sum + item.turnover, 0),
    },
  };
}

/** G-PORTFOLIO: the frozen exposure and turnover limits, checked against what was actually held. */
export function gatePortfolio(periods: unknown[], contract: unknown): GateEvaluation {
  const limits: PortfolioContract = portfolioContractSchema.parse(contract);
  if (!periods.length) return blocked('G-PORTFOLIO', 'No periods were supplied, so exposure cannot be checked.');
  for (const raw of periods) {
    const period: Period = periodSchema.parse(raw);
    const weights = Object.values(period.weightsAfter);
    const gross = weights.reduce((sum, weight) => sum + Math.abs(weight), 0);
    const net = weights.reduce((sum, weight) => sum + weight, 0);
    const largest = weights.reduce((worst, weight) => Math.max(worst, Math.abs(weight)), 0);
    const turnover = [...new Set([...Object.keys(period.weightsBefore), ...Object.keys(period.weightsAfter)])].reduce(
      (sum, asset) => sum + Math.abs((period.weightsAfter[asset] ?? 0) - (period.weightsBefore[asset] ?? 0)),
      0,
    );
    const breach =
      gross > limits.maxGrossExposure
        ? (['gross exposure', gross, limits.maxGrossExposure] as const)
        : Math.abs(net) > limits.maxNetExposure
          ? (['net exposure', Math.abs(net), limits.maxNetExposure] as const)
          : largest > limits.maxPositionWeight
            ? (['position weight', largest, limits.maxPositionWeight] as const)
            : turnover > limits.maxTurnoverPerPeriod
              ? (['turnover', turnover, limits.maxTurnoverPerPeriod] as const)
              : null;
    if (breach)
      return fail(
        'G-PORTFOLIO',
        `Period ${period.period} breaches the frozen ${breach[0]} limit: ${breach[1].toFixed(6)} against ${breach[2]}.`,
        { period: period.period, limit: breach[0], observed: breach[1], permitted: breach[2] },
      );
  }
  return pass('G-PORTFOLIO', `All ${periods.length} periods stay inside the frozen exposure and turnover limits.`, {
    periods: periods.length,
  });
}

// ---- artifacts, specification and registration ---------------------------------------------------

/** G-ARTIFACT: every declared prediction file must be present with the exact bytes it claims. */
export function gateArtifact(
  pkg: CatBoostPackage,
  present: Map<string, { sha256: string; rows: number }>,
): GateEvaluation {
  for (const declared of pkg.predictionInventory) {
    const found = present.get(declared.path);
    if (!found)
      return blocked('G-ARTIFACT', `The package declares ${declared.path} but it was not delivered.`, {
        missing: declared.path,
      });
    if (found.sha256 !== declared.sha256)
      return fail('G-ARTIFACT', `${declared.path} does not match its declared identity.`, {
        path: declared.path,
        declared: declared.sha256,
        found: found.sha256,
      });
    if (found.rows !== declared.rows)
      return fail(
        'G-ARTIFACT',
        `${declared.path} holds ${found.rows} rows where the package declares ${declared.rows}.`,
        { path: declared.path, declaredRows: declared.rows, foundRows: found.rows },
      );
  }
  return pass(
    'G-ARTIFACT',
    `All ${pkg.predictionInventory.length} declared prediction files match their recorded identities.`,
    { files: pkg.predictionInventory.length },
  );
}

/**
 * G-SPEC: a prospective claim needs a registration that existed before the run.
 *
 * An exploratory result is not rejected here; it is classified. What it cannot do is arrive after the
 * fact carrying a specification identifier and be treated as though it had been preregistered.
 */
export function gateSpec(
  pkg: CatBoostPackage,
  spec: { id: string; hash: string; frozenAt: string } | null,
): GateEvaluation {
  if (pkg.registration === 'EXPLORATORY')
    return blocked(
      'G-SPEC',
      'This result is exploratory. It is kept and searchable, but it cannot satisfy a preregistration it never had.',
      { registration: pkg.registration },
    );
  if (!pkg.specId || !pkg.specHash || !pkg.registeredAt)
    return fail(
      'G-SPEC',
      'A prospective result must name the frozen specification, its hash and when it was registered.',
      { registration: pkg.registration },
    );
  if (!spec)
    return blocked('G-SPEC', `The package names specification ${pkg.specId}, which this workspace does not hold.`, {
      specId: pkg.specId,
    });
  if (spec.id !== pkg.specId || spec.hash !== pkg.specHash)
    return fail('G-SPEC', 'The package names a specification whose frozen content differs from the one it claims.', {
      declared: pkg.specHash,
      frozen: spec.hash,
    });
  const firstRun = pkg.receipts.map(receipt => ms(receipt.startedAt)).sort((a, b) => a - b)[0];
  if (firstRun !== undefined && firstRun < ms(spec.frozenAt))
    return fail(
      'G-SPEC',
      'The earliest recorded run started before the specification was frozen, so this is a post-hoc registration.',
      { firstRunAt: new Date(firstRun).toISOString(), frozenAt: spec.frozenAt },
    );
  if (ms(pkg.registeredAt) < ms(spec.frozenAt))
    return fail('G-SPEC', 'The package claims a registration earlier than the specification freeze it points at.', {
      registeredAt: pkg.registeredAt,
      frozenAt: spec.frozenAt,
    });
  return pass('G-SPEC', 'The run is registered against a specification frozen before it started.', {
    specId: spec.id,
    frozenAt: spec.frozenAt,
  });
}

/**
 * Every deterministic gate this package can be judged on right now.
 *
 * Ordering matters only for reading: each gate is independent, and a BLOCKED verdict never becomes a
 * PASS because a later gate succeeded.
 */
export function evaluatePackage(
  input: unknown,
  context: {
    predictions: unknown[];
    periods?: unknown[];
    costs?: unknown;
    portfolio?: unknown;
    deliveredFiles?: Map<string, { sha256: string; rows: number }>;
    spec?: { id: string; hash: string; frozenAt: string } | null;
  },
): GateEvaluation[] {
  const pkg = catBoostPackageSchema.parse(input);
  const evaluations = [
    gateSpec(pkg, context.spec ?? null),
    gateTime(pkg),
    gateTarget(pkg),
    gateSplit(pkg),
    gateFit(pkg),
    gateSelect(pkg),
    gateIntegrity(context.predictions),
    gateTradeTime(context.predictions),
    gateArtifact(pkg, context.deliveredFiles ?? new Map()),
  ];
  if (context.periods && context.costs) evaluations.push(gateCost(context.periods, context.costs));
  else
    evaluations.push(
      blocked('G-COST', 'No period returns or cost model were supplied, so nothing net can be reported.'),
    );
  if (context.periods && context.portfolio) evaluations.push(gatePortfolio(context.periods, context.portfolio));
  else
    evaluations.push(
      blocked('G-PORTFOLIO', 'No period weights or portfolio contract were supplied, so exposure cannot be checked.'),
    );
  return evaluations;
}

/**
 * Whether these gate verdicts permit a stage to advance.
 *
 * BLOCKED and FAIL both stop the stage, and they are reported separately because they call for
 * different work: one needs evidence, the other needs a different result.
 */
export function advanceable(evaluations: GateEvaluation[]): {
  canAdvance: boolean;
  failed: GateId[];
  blocked: GateId[];
} {
  const failed = evaluations.filter(item => item.outcome === 'FAIL').map(item => item.gate);
  const stopped = evaluations.filter(item => item.outcome === 'BLOCKED').map(item => item.gate);
  return { canAdvance: !failed.length && !stopped.length, failed, blocked: stopped };
}
