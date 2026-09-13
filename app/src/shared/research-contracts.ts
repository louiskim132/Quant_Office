import { z } from 'zod';
import { GATES, type GateId, type GateOutcome, type Stage } from './research.js';

/**
 * The exact shapes a research result must arrive in before any gate can say anything about it.
 *
 * Every field here exists because its absence is a way to pass a check by accident. A cost model with
 * an optional commission is a cost model that reports a profitable strategy when the field is left
 * out; a split plan without an embargo is a split plan that leaks the label horizon across the
 * boundary. So the schemas below are strict, and absence is a blocking condition rather than a zero.
 */

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const nonNegative = finite.min(0);
/** Seconds, always. Mixing units across a manifest is the other reliable way to invent a lag. */
const seconds = z.number().int().min(0);

export const COLUMN_ROLES = ['FEATURE', 'TARGET', 'TIMESTAMP', 'ID', 'GROUP', 'WEIGHT'] as const;
export type ColumnRole = typeof COLUMN_ROLES[number];

export const datasetColumnSchema = z.object({
  name: z.string().trim().min(1).max(200), dtype: z.enum(['FLOAT', 'INT', 'BOOL', 'CATEGORICAL', 'TIMESTAMP', 'STRING']),
  role: z.enum(COLUMN_ROLES),
  /**
   * How long after the row's timestamp this column's value is actually knowable, in seconds.
   *
   * Zero means knowable at the timestamp itself. A positive value on a feature is a look-ahead: the
   * model would be using something that had not happened yet. On a target it is the label horizon,
   * which is exactly what the split plan must purge.
   */
  availableAfterSeconds: seconds,
  group: z.string().trim().min(1).max(120),
}).strict();
export type DatasetColumn = z.infer<typeof datasetColumnSchema>;

export const datasetManifestSchema = z.object({
  schemaVersion: z.literal(1), datasetId: z.string().uuid(), sourceHash: hash,
  rows: z.number().int().min(1), timezone: z.string().trim().min(1).max(60),
  timestampColumn: z.string().trim().min(1).max(200), targetColumn: z.string().trim().min(1).max(200),
  /** Inclusive ISO bounds. A manifest that cannot say when its data starts cannot be split safely. */
  firstTimestamp: z.string().datetime(), lastTimestamp: z.string().datetime(),
  columns: z.array(datasetColumnSchema).min(2).max(4000),
}).strict();
export type DatasetManifest = z.infer<typeof datasetManifestSchema>;

export const foldSchema = z.object({
  id: z.string().trim().min(1).max(120),
  trainStart: z.string().datetime(), trainEnd: z.string().datetime(),
  testStart: z.string().datetime(), testEnd: z.string().datetime(),
}).strict();

export const splitPlanSchema = z.object({
  schemaVersion: z.literal(1), scheme: z.enum(['PURGED_WALK_FORWARD', 'PURGED_KFOLD']),
  /** The label horizon the target needs, and the two guards that must cover it. */
  labelHorizonSeconds: seconds, purgeSeconds: seconds, embargoSeconds: seconds,
  folds: z.array(foldSchema).min(1).max(200),
}).strict();
export type SplitPlan = z.infer<typeof splitPlanSchema>;

/**
 * Where a fold's model was fitted, and what it was allowed to stop on.
 *
 * `earlyStoppingOn` is here rather than buried in a config blob because outer-test early stopping is
 * the single most common way a walk-forward result becomes an in-sample result while still looking
 * like a walk-forward result.
 */
export const fitScopeSchema = z.object({
  foldId: z.string().trim().min(1).max(120),
  fittedFrom: z.string().datetime(), fittedTo: z.string().datetime(),
  rowsFitted: z.number().int().min(1),
  earlyStoppingOn: z.enum(['NONE', 'INNER_VALIDATION', 'OUTER_TEST']),
  /** Which windows any feature or hyperparameter selection actually looked at. */
  selectionOn: z.enum(['TRAIN_ONLY', 'INNER_VALIDATION', 'OUTER_TEST', 'FULL_DATASET']),
}).strict();
export type FitScope = z.infer<typeof fitScopeSchema>;

export const predictionRowSchema = z.object({
  rowId: z.string().trim().min(1).max(200), foldId: z.string().trim().min(1).max(120),
  /** When the features were knowable, and when this prediction could first be acted on. */
  timestamp: z.string().datetime(), decisionAt: z.string().datetime(), tradeAt: z.string().datetime(),
  scope: z.enum(['OOF', 'TEST', 'HOLDOUT']),
  prediction: finite,
  /** Null when the outcome is genuinely not yet known; never a filled-in zero. */
  target: finite.nullable(),
}).strict();
export type PredictionRow = z.infer<typeof predictionRowSchema>;

export const costModelSchema = z.object({
  schemaVersion: z.literal(1),
  commissionBps: nonNegative, halfSpreadBps: nonNegative, slippageBps: nonNegative,
  borrowBpsPerPeriod: nonNegative, financingBpsPerPeriod: nonNegative,
}).strict();
export type CostModel = z.infer<typeof costModelSchema>;

export const portfolioContractSchema = z.object({
  schemaVersion: z.literal(1),
  maxGrossExposure: finite.min(0), maxNetExposure: finite.min(0),
  maxPositionWeight: finite.min(0).max(1), maxTurnoverPerPeriod: finite.min(0),
}).strict();
export type PortfolioContract = z.infer<typeof portfolioContractSchema>;

/** One period of an executed or simulated book: weights before, weights after, and the period return. */
export const periodSchema = z.object({
  period: z.string().trim().min(1).max(120),
  weightsBefore: z.record(z.string().min(1).max(200), finite),
  weightsAfter: z.record(z.string().min(1).max(200), finite),
  /** Gross asset returns for the period, keyed the same way. A missing key blocks; it is not zero. */
  assetReturns: z.record(z.string().min(1).max(200), finite),
}).strict();
export type Period = z.infer<typeof periodSchema>;

/**
 * A receipt from one authored template execution.
 *
 * The office never runs these templates: it authors, exports and hosts them, and reads back what a
 * run says it did. So a receipt names the exact template and dependency versions it claims, and the
 * parser below only ever checks those claims against the frozen record — it does not execute them.
 */
export const templateReceiptSchema = z.object({
  schemaVersion: z.literal(1), templateId: z.enum(['data', 'diagnostics', 'portfolio', 'cost']),
  templateVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/), templateHash: hash,
  dependencies: z.array(z.object({ name: z.string().trim().min(1).max(120), version: z.string().trim().min(1).max(60) }).strict()).max(200),
  kind: z.enum(['FIT', 'PREDICT', 'DIAGNOSTIC']), seed: z.number().int(),
  environment: z.string().trim().min(1).max(200), startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  inputHashes: z.array(hash).min(1).max(200), outputHashes: z.array(hash).max(200),
  /** Where the run happened. A receipt cannot claim a hosted run the office did not arrange. */
  provenance: z.enum(['HOSTED_TEMPLATE_RUN', 'USER_SUPPLIED']),
}).strict();
export type TemplateReceipt = z.infer<typeof templateReceiptSchema>;

/** Diagnostic outputs, kept separate from anything economic so a forecast never reads as a profit. */
export const diagnosticReportSchema = z.object({
  schemaVersion: z.literal(1), receiptHash: hash,
  signal: z.object({ metric: z.enum(['IC', 'RANK_IC', 'AUC', 'R2']), value: finite.nullable(), samples: z.number().int().min(0),
    standardError: nonNegative.nullable() }).strict(),
  slices: z.array(z.object({ name: z.string().trim().min(1).max(200), samples: z.number().int().min(0), value: finite.nullable() }).strict()).max(500),
  featureGroupStability: z.array(z.object({ group: z.string().trim().min(1).max(120), foldShare: z.array(finite).max(200) }).strict()).max(200),
  /** Nulls are how "we could not compute this" is said. Zero would be a claim. */
  note: z.string().trim().max(4000),
}).strict();
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;

/**
 * An imported CatBoost run, either registered before the fact or submitted after it.
 *
 * The distinction is the whole point. EXPLORATORY results are useful and are kept; what they can
 * never do is stand in for a preregistration that did not exist, so the importer records the class
 * and the gate layer refuses to advance S0 or S8 on one.
 */
export const catBoostPackageSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().uuid(), projectId: z.string().uuid(),
  registration: z.enum(['PROSPECTIVE', 'EXPLORATORY']),
  /** Present only on a prospective run: the frozen spec it was registered against, before results. */
  specId: z.string().uuid().nullable(), specHash: hash.nullable(), registeredAt: z.string().datetime().nullable(),
  source: z.object({ repository: z.string().trim().max(400), commit: z.string().trim().max(200), sourceHash: hash }).strict(),
  model: z.object({ library: z.literal('catboost'), version: z.string().trim().min(1).max(60), lossFunction: z.string().trim().min(1).max(120),
    iterations: z.number().int().min(1), configHash: hash, seed: z.number().int() }).strict(),
  dataset: datasetManifestSchema, split: splitPlanSchema,
  fitScopes: z.array(fitScopeSchema).min(1).max(200),
  predictionInventory: z.array(z.object({ path: z.string().trim().min(1).max(240), sha256: hash, rows: z.number().int().min(0) }).strict()).min(1).max(200),
  /** Every attempt, including the ones that failed. A ledger with only successes is a selected ledger. */
  failedRuns: z.array(z.object({ runId: z.string().uuid(), reason: z.string().trim().min(1).max(1000), failedAt: z.string().datetime() }).strict()).max(500),
  receipts: z.array(templateReceiptSchema).max(200),
}).strict();
export type CatBoostPackage = z.infer<typeof catBoostPackageSchema>;

/** One gate's deterministic verdict, with the exact numbers it was reached from. */
export interface GateEvaluation {
  gate: GateId; outcome: GateOutcome; detail: string;
  /** Machine-readable evidence for the receipt, so a later reader is not re-deriving it from prose. */
  measurements: Record<string, number | string | null>;
}

export const GATE_STAGE: Record<GateId, Stage> = {
  'G-SPEC': 'S0', 'G-CORRECT': 'S2', 'G-TIME': 'S3', 'G-SPLIT': 'S3', 'G-FIT': 'S3', 'G-TARGET': 'S3',
  'G-SELECT': 'S4', 'G-TRADETIME': 'S5', 'G-ARTIFACT': 'S3', 'G-COST': 'S6', 'G-PORTFOLIO': 'S6',
  'G-ECON': 'S6', 'G-INTEGRITY': 'S3', 'G-SHADOW': 'S9',
};
export const CONTRACT_GATES: readonly GateId[] = GATES;
