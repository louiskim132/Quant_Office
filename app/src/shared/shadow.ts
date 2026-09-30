import { z } from 'zod';

/**
 * Shadow evaluation: watching a qualified candidate with no capital behind it.
 *
 * The whole value of a shadow period is that it is prospective, so every schema here is built to make
 * a retrospective claim impossible to file by accident. A prediction is stamped before its outcome
 * exists, a simulated fill is labelled as simulated for as long as it lives, and a missing quote is
 * an absence rather than a flat period. The temptation this resists is specific: a shadow record with
 * gaps quietly filled in is indistinguishable from one that worked.
 */

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();
const finite = z.number().finite();

/** One prediction, recorded before the outcome it forecasts could be known. */
export const shadowPredictionSchema = z
  .object({
    id,
    branchId: id,
    specId: id,
    candidateHash: hash,
    symbol: z.string().trim().min(1).max(60),
    /** When the office recorded it, and the period it is about. The first must precede the second. */
    recordedAt: z.string().datetime(),
    forecastFor: z.string().datetime(),
    prediction: finite,
    horizonSeconds: z.number().int().min(1),
  })
  .strict();
export type ShadowPrediction = z.infer<typeof shadowPredictionSchema>;

/** A market quote at a moment. Absent quotes stay absent; there is no carry-forward here. */
export const quoteSchema = z
  .object({
    symbol: z.string().trim().min(1).max(60),
    at: z.string().datetime(),
    bid: finite.min(0),
    ask: finite.min(0),
    source: z.string().trim().min(1).max(200),
  })
  .strict();
export type Quote = z.infer<typeof quoteSchema>;

/**
 * A fill, which is either simulated or actually executed, and never quietly promoted.
 *
 * A simulated fill cannot establish market impact, queue position or partial-fill behaviour, because
 * it was priced against a book that did not move in response to it. That is why the two kinds carry
 * different provenance and why the metrics below refuse to combine them.
 */
export const fillSchema = z
  .object({
    predictionId: id,
    symbol: z.string().trim().min(1).max(60),
    at: z.string().datetime(),
    quantity: finite,
    price: finite.min(0),
    kind: z.enum(['SIMULATED', 'EXECUTED']),
    /** Executed fills need an independent source; a simulated one names the model that produced it. */
    provenance: z.string().trim().min(1).max(400),
  })
  .strict();
export type Fill = z.infer<typeof fillSchema>;
const batchBase = { schemaVersion: z.literal(1), branchId: id, specId: id, candidateHash: hash };
export const shadowBatchSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...batchBase,
      kind: z.literal('PREDICTIONS'),
      predictions: z.array(shadowPredictionSchema).min(1).max(100000),
    })
    .strict(),
  z
    .object({
      ...batchBase,
      kind: z.literal('OBSERVATIONS'),
      quotes: z.array(quoteSchema).max(100000),
      fills: z.array(fillSchema).max(100000),
      outcomes: z.record(id, finite.nullable()),
    })
    .strict(),
  z
    .object({
      ...batchBase,
      kind: z.literal('EXECUTIONS'),
      sourceDocumentHash: hash,
      fills: z.array(fillSchema).min(1).max(100000),
    })
    .strict(),
]);
export type ShadowBatch = z.infer<typeof shadowBatchSchema>;

/**
 * The shadow policy, frozen at S0 rather than chosen when the numbers arrive.
 *
 * `minimumSamples` and `maximumMissingShare` decide whether a shadow period says anything at all, and
 * choosing them after seeing the period is how an inconclusive run becomes a pass.
 */
export const shadowPolicySchema = z
  .object({
    minimumElapsedSeconds: z.number().int().min(1).optional(),
    minimumObservationTimes: z.number().int().min(1).optional(),
    minimumSamples: z.number().int().min(1),
    maximumMissingShare: z.number().min(0).max(1),
    /** Below this the candidate is retired; between the two it is inconclusive, not passing. */
    retireBelowMetric: finite,
    qualifyAtOrAboveMetric: finite,
    /** A drift alarm asks a person to look. A kill threshold stops the shadow outright. */
    driftAlarmMetric: finite,
    killBelowMetric: finite,
    thresholdHash: hash,
  })
  .strict();
export type ShadowPolicy = z.infer<typeof shadowPolicySchema>;

export type ShadowOutcome = 'SHADOW_QUALIFIED' | 'INCONCLUSIVE' | 'UNKNOWN' | 'RETIRED' | 'SUSPENDED';
export interface ShadowVerdict {
  outcome: ShadowOutcome;
  metric: number | null;
  samples: number;
  missingShare: number;
  /** Separate from the outcome: an alarm asks for attention, a kill ends the shadow. */
  alarm: boolean;
  killed: boolean;
  detail: string;
  problems: string[];
}

/**
 * Evaluates one shadow period against its frozen policy.
 *
 * Missing data produces UNKNOWN or the policy's stated suspension, never a convenient zero loss, and
 * a future-dated prediction is rejected outright rather than scored: a forecast recorded after the
 * fact is not a forecast, whatever the arithmetic says about it.
 */
export function evaluateShadow(input: {
  predictions: ShadowPrediction[];
  quotes: Quote[];
  fills: Fill[];
  policy: ShadowPolicy;
  /** Realised outcomes keyed by prediction id. A prediction with no outcome is missing, not zero. */
  outcomes: Record<string, number | null>;
  now: string;
}): ShadowVerdict {
  const policy = shadowPolicySchema.parse(input.policy);
  const problems: string[] = [];

  const backdated = input.predictions.filter(item => Date.parse(item.recordedAt) >= Date.parse(item.forecastFor));
  if (backdated.length)
    return {
      outcome: 'SUSPENDED',
      metric: null,
      samples: 0,
      missingShare: 1,
      alarm: false,
      killed: false,
      detail: `${backdated.length} prediction${backdated.length === 1 ? ' was' : 's were'} recorded at or after the moment they forecast, starting with ${backdated[0].id}. That is a description, not a prospective record, and the whole period is refused.`,
      problems: ['BACKDATED_PREDICTION'],
    };

  const unripe = input.predictions.filter(item => Date.parse(item.forecastFor) > Date.parse(input.now));
  const due = input.predictions.filter(item => Date.parse(item.forecastFor) <= Date.parse(input.now));
  const first = input.predictions.reduce((earliest, p) => Math.min(earliest, Date.parse(p.recordedAt)), Infinity);
  if (
    (policy.minimumElapsedSeconds !== undefined &&
      (Date.parse(input.now) - first) / 1000 < policy.minimumElapsedSeconds) ||
    (policy.minimumObservationTimes !== undefined &&
      new Set(due.map(p => p.forecastFor)).size < policy.minimumObservationTimes)
  )
    return {
      outcome: 'INCONCLUSIVE',
      metric: null,
      samples: 0,
      missingShare: 1,
      alarm: false,
      killed: false,
      detail: 'The frozen elapsed-time or distinct observation-time minimum has not been reached.',
      problems: ['INSUFFICIENT_PROSPECTIVE_COVERAGE'],
    };
  const resolved = due.filter(item => typeof input.outcomes[item.id] === 'number');
  const missingShare = due.length ? (due.length - resolved.length) / due.length : 1;

  const quoted = new Set(input.quotes.map(quote => `${quote.symbol}@${quote.at}`));
  const unquoted = due.filter(item => !quoted.has(`${item.symbol}@${item.forecastFor}`));
  if (unquoted.length) problems.push('MISSING_QUOTES');
  if (unquoted.length && due.length) {
    const share = unquoted.length / due.length;
    return {
      outcome: share > policy.maximumMissingShare ? 'SUSPENDED' : 'UNKNOWN',
      metric: null,
      samples: resolved.length,
      missingShare: Math.max(missingShare, share),
      alarm: false,
      killed: false,
      detail:
        'Missing quote observations prevent shadow qualification. No absent quote is treated as a zero cost or a flat outcome.',
      problems,
    };
  }

  if (!due.length)
    return {
      outcome: 'UNKNOWN',
      metric: null,
      samples: 0,
      missingShare: 1,
      alarm: false,
      killed: false,
      detail: `No prediction has reached its horizon yet; ${unripe.length} are still open. Nothing is being reported as a result.`,
      problems,
    };

  if (missingShare > policy.maximumMissingShare)
    return {
      outcome: 'SUSPENDED',
      metric: null,
      samples: resolved.length,
      missingShare,
      alarm: false,
      killed: false,
      detail: `${Math.round(missingShare * 100)}% of due predictions have no realised outcome, above the frozen ${Math.round(policy.maximumMissingShare * 100)}% limit. The shadow is suspended rather than scored on the part that happens to be present.`,
      problems: [...problems, 'MISSING_DATA_SUSPENSION'],
    };

  if (resolved.length < policy.minimumSamples)
    return {
      outcome: 'UNKNOWN',
      metric: null,
      samples: resolved.length,
      missingShare,
      alarm: false,
      killed: false,
      detail: `${resolved.length} resolved outcomes is below the frozen minimum of ${policy.minimumSamples}. This period has no power to say anything, which is not the same as saying nothing happened.`,
      problems: [...problems, 'INSUFFICIENT_SAMPLES'],
    };

  // The metric is the mean signed agreement between prediction and outcome: bounded, hand-checkable,
  // and deliberately not a return. Whether the candidate makes money is an economic question the
  // shadow period does not answer.
  const metric =
    resolved.reduce((sum, item) => sum + Math.sign(item.prediction) * (input.outcomes[item.id] as number), 0) /
    resolved.length;

  const killed = metric < policy.killBelowMetric;
  const alarm = !killed && metric < policy.driftAlarmMetric;
  const outcome: ShadowOutcome =
    killed || metric < policy.retireBelowMetric
      ? 'RETIRED'
      : metric >= policy.qualifyAtOrAboveMetric
        ? 'SHADOW_QUALIFIED'
        : 'INCONCLUSIVE';
  return {
    outcome,
    metric,
    samples: resolved.length,
    missingShare,
    alarm,
    killed,
    problems,
    detail: killed
      ? `The metric ${metric.toFixed(6)} is below the frozen kill threshold ${policy.killBelowMetric}. The shadow stops.`
      : alarm
        ? `The metric ${metric.toFixed(6)} is below the frozen drift alarm ${policy.driftAlarmMetric} but above the kill threshold. This asks a person to look; it does not stop the shadow.`
        : `The metric ${metric.toFixed(6)} over ${resolved.length} resolved outcomes is ${outcome.toLowerCase().replaceAll('_', ' ')} against the frozen thresholds.`,
  };
}

/**
 * A reproducible research package: what was done, under what approval, and what it does not mean.
 *
 * `approvalMeaning` is mandatory and its content is checked, because the single most costly mistake
 * this file can permit is a planning archive that reads like a deployment authorisation.
 */
export const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    branchId: id,
    lineageId: id,
    specId: id,
    specHash: hash,
    candidateHash: hash,
    environment: z.string().trim().min(1).max(400),
    codeRefs: z
      .array(
        z
          .object({
            repository: z.string().trim().max(400),
            commit: z.string().trim().min(1).max(200),
            sourceHash: hash,
          })
          .strict(),
      )
      .min(1)
      .max(50),
    dataRefs: z
      .array(z.object({ datasetId: id, sourceHash: hash, description: z.string().trim().max(400) }).strict())
      .min(1)
      .max(200),
    gateReceiptHashes: z.array(hash).min(1).max(200),
    reviewDecisionHashes: z.array(hash).max(200),
    costModelHash: hash,
    portfolioContractHash: hash,
    /** Everything the package does not establish, in the package. Not in a covering note. */
    limitations: z.array(z.string().trim().min(1).max(1000)).min(1).max(100),
    approvedScope: z.string().trim().min(1).max(2000),
    approvalMeaning: z.string().trim().min(1).max(2000),
    exportedAt: z.string().datetime(),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

const DEPLOYMENT_CLAIMS = [
  'approved for trading',
  'cleared for deployment',
  'authorised to trade',
  'authorized to trade',
  'ready for capital',
  'production trading',
];

/**
 * Refuses a manifest whose approval language claims more than the office can grant.
 *
 * Passing tests authorise software behaviour, not capital. A package that says otherwise would be
 * the artefact somebody points at later, so the sentence is checked here rather than trusted.
 */
export function assertHonestApproval(manifest: ReleaseManifest): void {
  const claim = manifest.approvalMeaning.toLowerCase();
  const overreach = DEPLOYMENT_CLAIMS.filter(phrase => claim.includes(phrase));
  if (overreach.length)
    throw new Error(
      `This package's approval statement claims ${overreach.join(', ')}. The office records research standing; it does not authorise capital, and a package must not read as though it does.`,
    );
  if (!/not|no /.test(claim))
    throw new Error(
      'An approval statement must say what the approval does not mean. A package that only says what was approved will be read as authorisation.',
    );
}
