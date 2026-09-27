import { z } from 'zod';
import { diagnosticReportSchema, type DiagnosticReport } from './research-contracts.js';

/**
 * Diagnostic outputs and the wall between a forecast and a profit.
 *
 * The separation enforced here is not stylistic. An information coefficient and a net return answer
 * different questions, and a report that presents them as one number lets a real but tiny edge and a
 * tradeable strategy share a sentence. So the schemas are separate, the guard below refuses a report
 * that mixes them, and every parameter that decides what counts as adequate comes from the frozen S0
 * specification rather than from whatever the run happened to produce.
 */

const finite = z.number().finite();

/** How a result holds up when the assumptions are moved. Nulls mean not computed, never "fine". */
export const backtestStressSchema = z
  .object({
    schemaVersion: z.literal(1),
    receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
    scenarios: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            /** What was perturbed, and by how much, in the units the frozen specification declared. */
            perturbation: z.string().trim().min(1).max(400),
            magnitude: finite,
            netReturn: finite.nullable(),
            maxDrawdown: finite.min(0).nullable(),
            samples: z.number().int().min(0),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    /** Cost multiples the frozen specification asked to be tested, e.g. 1x, 2x, 5x. */
    costMultiples: z.array(finite.min(0)).min(1).max(20),
    note: z.string().trim().max(4000),
  })
  .strict();
export type BacktestStress = z.infer<typeof backtestStressSchema>;

/**
 * The adequacy thresholds a diagnostic is judged against, taken from the frozen specification.
 *
 * These live in the spec because a minimum sample size chosen after seeing the result is not a
 * minimum sample size. The report cannot supply them and the template cannot default them.
 */
export const diagnosticPolicySchema = z
  .object({
    minimumSamples: z.number().int().min(1),
    minimumSliceSamples: z.number().int().min(1),
    requiredSlices: z.array(z.string().trim().min(1).max(200)).max(200),
    requiredCostMultiples: z.array(finite.min(0)).max(20),
  })
  .strict();
export type DiagnosticPolicy = z.infer<typeof diagnosticPolicySchema>;

export interface DiagnosticVerdict {
  adequate: boolean;
  /** INSUFFICIENT_DATA and UNDEFINED are distinct: too few rows, versus a metric with no value here. */
  problems: { code: 'INSUFFICIENT_DATA' | 'UNDEFINED_METRIC' | 'MISSING_SLICE' | 'MISSING_STRESS'; detail: string }[];
}

/**
 * Judges a diagnostic report against the frozen policy, refusing to read absence as adequacy.
 *
 * A null signal value over four rows is reported as two separate problems — the metric is undefined
 * and the sample is too small — because they call for different responses, and collapsing them into
 * "no signal" is how a study with no power gets recorded as a negative result.
 */
export function judgeDiagnostic(report: unknown, policy: unknown): DiagnosticVerdict {
  const parsed: DiagnosticReport = diagnosticReportSchema.parse(report);
  const rules: DiagnosticPolicy = diagnosticPolicySchema.parse(policy);
  const problems: DiagnosticVerdict['problems'] = [];
  if (parsed.signal.samples < rules.minimumSamples)
    problems.push({
      code: 'INSUFFICIENT_DATA',
      detail: `The signal was measured on ${parsed.signal.samples} resolved rows, below the frozen minimum of ${rules.minimumSamples}.`,
    });
  if (parsed.signal.value === null)
    problems.push({
      code: 'UNDEFINED_METRIC',
      detail: `${parsed.signal.metric} could not be computed on this sample. That is not a value of zero.`,
    });
  for (const required of rules.requiredSlices) {
    const slice = parsed.slices.find(item => item.name === required);
    if (!slice)
      problems.push({
        code: 'MISSING_SLICE',
        detail: `The frozen specification requires the ${required} slice, which this report does not contain.`,
      });
    else if (slice.samples < rules.minimumSliceSamples)
      problems.push({
        code: 'INSUFFICIENT_DATA',
        detail: `The ${required} slice has ${slice.samples} rows, below the frozen minimum of ${rules.minimumSliceSamples}.`,
      });
    else if (slice.value === null)
      problems.push({
        code: 'UNDEFINED_METRIC',
        detail: `The ${required} slice has enough rows but no computed value.`,
      });
  }
  return { adequate: problems.length === 0, problems };
}

/** Checks that the stress report covers every cost multiple the specification asked for. */
export function judgeStress(stress: unknown, policy: unknown): DiagnosticVerdict {
  const parsed: BacktestStress = backtestStressSchema.parse(stress);
  const rules: DiagnosticPolicy = diagnosticPolicySchema.parse(policy);
  const problems: DiagnosticVerdict['problems'] = rules.requiredCostMultiples
    .filter(multiple => !parsed.costMultiples.includes(multiple))
    .map(multiple => ({
      code: 'MISSING_STRESS' as const,
      detail: `The frozen specification requires the result at ${multiple}x costs, which this report does not contain.`,
    }));
  for (const scenario of parsed.scenarios) {
    if (scenario.netReturn === null)
      problems.push({
        code: 'UNDEFINED_METRIC',
        detail: `Scenario ${scenario.name} has no computed net return; it is not a zero-loss scenario.`,
      });
    else if (scenario.samples < rules.minimumSamples)
      problems.push({
        code: 'INSUFFICIENT_DATA',
        detail: `Scenario ${scenario.name} reports a net return from ${scenario.samples} rows, below the frozen minimum of ${rules.minimumSamples}.`,
      });
  }
  return { adequate: problems.length === 0, problems };
}

/**
 * Refuses a report that presents a forecast quality and an economic result as the same claim.
 *
 * The check is on the shape rather than on the wording: a diagnostic report carrying returns, or a
 * stress report carrying an information coefficient, has already merged the two questions, and any
 * summary written from it will merge them too.
 */
export function assertForecastSeparateFromEconomics(report: unknown): void {
  const value = report as Record<string, unknown>;
  const economic = ['netReturn', 'sharpe', 'pnl', 'grossReturn', 'costMultiples', 'maxDrawdown'].filter(
    field => field in value,
  );
  if (economic.length)
    throw new Error(
      `A diagnostic report describes forecast quality only. It carries ${economic.join(', ')}, which belong to the economic evaluation and must be reported separately.`,
    );
}
