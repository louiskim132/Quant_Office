import {
  MANDATORY_GATES,
  STAGE_GATES,
  nextActions,
  pipelineStageBlocker,
  stageCompletionBlocker,
  lineageCounters,
  FOLLOW_UP_ALLOWANCE,
  type GateId,
  type ResearchBranch,
  type ResearchRecords,
  type Stage,
} from '../shared/research.js';
// ---- adjudication -------------------------------------------------------------------------------

export type AdjudicationOutcome = 'UPHELD' | 'REVISION_REQUIRED' | 'FOLLOW_UP_GRANTED' | 'LINEAGE_SUSPENDED';

export interface AdjudicationInput {
  records: ResearchRecords;
  branch: ResearchBranch;
  subjectHash: string;
  /** The advocate's and skeptic's recorded verdicts, and whether either found a correctness defect. */
  advocate: { verdict: 'SUPPORTS' | 'OPPOSES'; defectFound: boolean };
  skeptic: { verdict: 'SUPPORTS' | 'OPPOSES'; defectFound: boolean };
  /** True when the director is asking for one more scientific attempt rather than a repair. */
  requestedFollowUp: boolean;
}
export interface Adjudication {
  outcome: AdjudicationOutcome;
  detail: string;
  /** Every hard gate is rechecked here, so an adjudication cannot carry a branch past a failed one. */
  failedMandatoryGates: GateId[];
  followUpAllowanceRemaining: number;
}

/**
 * Settles an S7 disagreement, within limits it cannot argue its way out of.
 *
 * There is deliberately no override outcome. An adjudicator who can promote through a failed
 * mandatory gate makes every gate advisory, and a defect found by either side suspends the lineage
 * rather than being weighed against the strength of the result — a correct-looking result built on a
 * defect is worth less than no result, not more.
 */
export function adjudicate(input: AdjudicationInput): Adjudication {
  const counters = lineageCounters(input.records, input.branch.lineageId);
  const failed = recheckMandatoryGates(input.records, input.branch, input.subjectHash);

  if (input.advocate.defectFound || input.skeptic.defectFound)
    return {
      outcome: 'LINEAGE_SUSPENDED',
      failedMandatoryGates: failed,
      followUpAllowanceRemaining: counters.followUpAllowanceRemaining,
      detail:
        'A correctness defect was found during adjudication. The affected lineage is suspended until the defect is repaired and its gates are earned again; it is not weighed against the strength of the result.',
    };

  if (failed.length)
    return {
      outcome: 'REVISION_REQUIRED',
      failedMandatoryGates: failed,
      followUpAllowanceRemaining: counters.followUpAllowanceRemaining,
      detail: `${failed.join(', ')} ${failed.length === 1 ? 'is' : 'are'} failing for this exact subject. Adjudication cannot waive a mandatory gate; repair the candidate and earn the receipt again.`,
    };

  if (input.advocate.verdict === input.skeptic.verdict)
    return {
      outcome: input.advocate.verdict === 'SUPPORTS' ? 'UPHELD' : 'REVISION_REQUIRED',
      failedMandatoryGates: [],
      followUpAllowanceRemaining: counters.followUpAllowanceRemaining,
      detail:
        input.advocate.verdict === 'SUPPORTS'
          ? 'Both sides argued from the same evidence and both support the result. Every mandatory gate passes for this subject.'
          : 'Both sides oppose the result on the same evidence.',
    };

  if (input.requestedFollowUp) {
    if (counters.followUpAllowanceRemaining <= 0)
      return {
        outcome: 'REVISION_REQUIRED',
        failedMandatoryGates: [],
        followUpAllowanceRemaining: 0,
        detail: `This lineage has already used its ${FOLLOW_UP_ALLOWANCE} scientific follow-up. A further attempt is a new registration, not a continuation of this one.`,
      };
    return {
      outcome: 'FOLLOW_UP_GRANTED',
      failedMandatoryGates: [],
      followUpAllowanceRemaining: counters.followUpAllowanceRemaining - 1,
      detail:
        'The sides disagree on the same evidence. One scientific follow-up is granted against this lineage, and it is the last one.',
    };
  }
  return {
    outcome: 'REVISION_REQUIRED',
    failedMandatoryGates: [],
    followUpAllowanceRemaining: counters.followUpAllowanceRemaining,
    detail:
      'The sides disagree on the same evidence and no follow-up was requested, so the result does not stand as it is.',
  };
}

/**
 * Rechecks every mandatory gate this branch's stages have reached, for this exact subject.
 *
 * Run unconditionally at adjudication because gate receipts and candidates move independently: the
 * receipt that was passing when the reviews were commissioned may not be the current one.
 */
export function recheckMandatoryGates(records: ResearchRecords, branch: ResearchBranch, subjectHash: string): GateId[] {
  const reached = Object.entries(STAGE_GATES)
    .filter(
      ([stage]) =>
        (['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'] as Stage[]).indexOf(stage as Stage) <=
        (['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'] as Stage[]).indexOf(branch.stage),
    )
    .flatMap(([, gates]) => gates as GateId[]);
  const failed: GateId[] = [];
  for (const gate of new Set(reached)) {
    if (!MANDATORY_GATES.includes(gate)) continue;
    const receipt = (records.receipts ?? [])
      .filter(
        item =>
          item.branchId === branch.id &&
          item.gate === gate &&
          item.subjectHash === subjectHash &&
          item.specId === branch.specId,
      )
      .at(-1);
    const spec = (records.specs ?? []).find(item => item.id === branch.specId);
    if (
      !receipt ||
      receipt.outcome === 'FAIL' ||
      receipt.outcome === 'BLOCKED' ||
      (receipt.outcome === 'NOT_APPLICABLE' &&
        (!spec?.frozen ||
          !spec.notApplicable.some(item => item.gate === gate && item.rationale.trim()) ||
          !receipt.rationale.trim()))
    )
      failed.push(gate);
  }
  return failed;
}

/**
 * Whether a director may promote a branch out of its current stage.
 *
 * Kept as its own function so the answer is the same in the interface, in a test and at the point of
 * the write. There is no argument shape that turns a failing gate into a promotion.
 */
export function promotable(
  records: ResearchRecords,
  branch: ResearchBranch,
  subjectHash: string,
  integration?: string | null,
): { allowed: boolean; reasons: string[] } {
  const actions = nextActions(records, branch, subjectHash);
  const failed = recheckMandatoryGates(records, branch, subjectHash);
  const reasons = [...actions.blockers.map(item => item.reason)];
  const completionBlocker = stageCompletionBlocker(records, branch, subjectHash);
  if (completionBlocker) reasons.push(completionBlocker);
  const integrationBlocker = integration === undefined ? pipelineStageBlocker(branch.stage) : integration;
  if (integrationBlocker) reasons.push(integrationBlocker);
  if (failed.length)
    reasons.push(
      `${failed.join(', ')} ${failed.length === 1 ? 'is' : 'are'} failing or missing for this subject and cannot be promoted through.`,
    );
  return { allowed: reasons.length === 0 && actions.canAdvance, reasons: [...new Set(reasons)] };
}
