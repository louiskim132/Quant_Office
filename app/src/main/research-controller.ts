import { MANDATORY_GATES, STAGE_GATES, nextActions, pipelineStageBlocker, stageCompletionBlocker, lineageCounters, FOLLOW_UP_ALLOWANCE, type GateId, type ResearchBranch, type ResearchRecords, type Stage } from '../shared/research.js';
import { stageContextHash } from '../shared/pipeline.js';
import type { AppState, WorkMode } from '../shared/types.js';
import { resolveFunctions, type FunctionAssignment, type ResolvedFunction, type StageFunction } from './context-policy.js';

/**
 * What the office should ask for next, and what it must refuse to conclude.
 *
 * The scheduler deliberately creates one step at a time. Planning the whole pipeline in advance reads
 * as efficiency and behaves as a commitment: the S6 assignment written while S3 was still running was
 * written against assumptions S3 had not yet tested, and it will run anyway.
 */

/**
 * Which functions each stage actually needs. A stage that needs nobody creates no assignment.
 * Under the corrected contract (section 1.6) S3 is the user-run export/wait/import stage and
 * S5/S6/S8/S9/S10 are the office's bound-evidence validations — none of them schedules an agent.
 */
export const STAGE_FUNCTIONS_REQUIRED: Record<Stage, StageFunction[]> = {
  S0: ['PRINCIPAL'], S1: ['PRINCIPAL'], S2: ['CORRECTNESS_REVIEWER'], S3: [], S4: ['PRINCIPAL'],
  S5: [], S6: [], S7: ['ADVOCATE', 'SKEPTIC'], S8: [], S9: [], S10: [],
};

export interface StageTask {
  branchId: string; stage: Stage; function: StageFunction; agentId: string; agentRevision: number;
  /** The exact context and output shape this task is frozen against, hashed for the receipt. */
  contextHash: string; outputSchema: string;
  dependsOn: string[];
}
export interface SchedulerResult { tasks: StageTask[]; blockers: string[]; stage: Stage }

/**
 * The next eligible assignments for one branch, and nothing beyond them.
 *
 * `mode` is honoured literally. A SINGLE request is a closed roster by the user's decision, so a
 * stage that would need a reviewer does not quietly recruit one: it reports that the stage cannot run
 * in this mode, and the user widens the scope deliberately or does not.
 */
export function scheduleStage(input: {
  state: Pick<AppState, 'agents'>; records: ResearchRecords; assignments: FunctionAssignment[];
  branch: ResearchBranch; subjectHash: string; mode: WorkMode; outputSchema: string;
  /** Worker tasks S1 may legitimately fan out to, each depending on the principal's task. */
  workerTaskIds?: string[];
}): SchedulerResult {
  const actions = nextActions(input.records, input.branch, input.subjectHash);
  const required = STAGE_FUNCTIONS_REQUIRED[input.branch.stage];
  const blockers: string[] = [];

  if (input.mode === 'SINGLE' && required.some(name => name !== 'PRINCIPAL'))
    return { tasks: [], stage: input.branch.stage,
      blockers: [`${input.branch.stage} needs an independent ${required.filter(n => n !== 'PRINCIPAL').join(' and ').toLowerCase().replaceAll('_', ' ')}, which a single-agent request has no roster for. Change the request's mode if the scope really is wider.`] };

  const resolved: ResolvedFunction[] = resolveFunctions(input.state, input.assignments, { projectId: input.branch.projectId, stage: input.branch.stage, functions: required });
  for (const item of resolved) blockers.push(...item.blockers);
  if (blockers.length) return { tasks: [], blockers, stage: input.branch.stage };

  const tasks = resolved.map(item => {
    // The context identity covers the branch, its exact subject, the stage, the function and the
    // profile revision. Any of those moving means this is a different task, not a resumed one.
    const contextHash = stageContextHash({
      branchId: input.branch.id, specId: input.branch.specId ?? '', subjectHash: input.subjectHash,
      stage: input.branch.stage, function: item.function, agentId: item.agentId, agentRevision: item.agentRevision,
      outputSchema: input.outputSchema,
    });
    return { branchId: input.branch.id, stage: input.branch.stage, function: item.function, agentId: item.agentId,
      agentRevision: item.agentRevision, contextHash, outputSchema: input.outputSchema,
      dependsOn: input.branch.stage === 'S1' ? [...(input.workerTaskIds ?? [])] : [] };
  });

  // Reported, not obeyed: the stage's own gates are still outstanding, and the caller needs to know
  // that scheduling work is not the same as being allowed to leave the stage afterwards.
  if (!actions.canAdvance) blockers.push(...actions.blockers.map(item => item.reason));
  const integrationBlocker = pipelineStageBlocker(input.branch.stage);
  if (integrationBlocker) blockers.push(integrationBlocker);
  return { tasks, blockers, stage: input.branch.stage };
}

export {adjudicate,recheckMandatoryGates,promotable} from '../core/adjudication';
export type {Adjudication,AdjudicationInput,AdjudicationOutcome} from '../core/adjudication';
