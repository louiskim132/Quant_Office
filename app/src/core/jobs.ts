import type { JobEvidence, JobState, ProviderJob } from '../shared/types.js';

/**
 * The provider job state machine.
 *
 * Every transition is explicit. There is no path that reaches a terminal outcome without provider
 * evidence, and nothing leaves a terminal state, so a late message cannot reopen canceled work.
 */
export const JOB_TRANSITIONS: Record<JobState, JobState[]> = {
  INTENT: ['SUBMITTING', 'FAILED', 'CANCEL_ACKNOWLEDGED'],
  SUBMITTING: ['ACCEPTED', 'FAILED', 'UNKNOWN'],
  ACCEPTED: ['RUNNING', 'COMPLETED', 'FAILED', 'UNKNOWN', 'CANCEL_REQUESTED'],
  RUNNING: ['COMPLETED', 'FAILED', 'UNKNOWN', 'CANCEL_REQUESTED'],
  UNKNOWN: ['ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCEL_REQUESTED', 'CANCEL_ACKNOWLEDGED'],
  CANCEL_REQUESTED: ['CANCEL_ACKNOWLEDGED', 'COMPLETED', 'FAILED', 'UNKNOWN'],
  COMPLETED: [],
  FAILED: [],
  CANCEL_ACKNOWLEDGED: [],
};
export const TERMINAL_JOB_STATES: JobState[] = ['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED'];
export const isTerminalJob = (state: JobState): boolean => TERMINAL_JOB_STATES.includes(state);
/** States where the office believes provider-side work may still exist and must be reconciled. */
export const isOpenJob = (state: JobState): boolean => !isTerminalJob(state);

export interface Transition { to: JobState; at: string; evidence: JobEvidence; externalId?: string; externalUrl?: string; detail: string; outputs?: { path: string; sha256: string; bytes: number }[] }

/**
 * Applies one transition, or explains exactly why it is refused.
 * The caller persists the result; nothing here reads or writes state on its own.
 */
export function nextJob(job: ProviderJob, transition: Transition): ProviderJob {
  const allowed = JOB_TRANSITIONS[job.state];
  if (isTerminalJob(job.state)) throw new Error(`This job is already ${job.state.toLowerCase().replaceAll('_', ' ')}; a later message cannot reopen it.`);
  if (!allowed.includes(transition.to) && !(job.state === transition.to && transition.outputs?.length
    && ['ACCEPTED','RUNNING','UNKNOWN','CANCEL_REQUESTED'].includes(job.state))) throw new Error(`A job cannot move from ${job.state} to ${transition.to}.`);
  // Only the provider can report that work was accepted, finished or cancelled.
  if (['ACCEPTED', 'RUNNING', 'COMPLETED'].includes(transition.to) && transition.evidence !== 'PROVIDER_REPORTED')
    throw new Error(`${transition.to} needs a provider observation; ${transition.evidence.toLowerCase().replaceAll('_', ' ')} evidence cannot establish it.`);
  if (transition.to === 'CANCEL_ACKNOWLEDGED' && job.state !== 'INTENT' && transition.evidence !== 'PROVIDER_REPORTED')
    throw new Error('Cancellation of dispatched work needs a provider acknowledgement; a stop message or a closed window is not one.');
  if (transition.to === 'ACCEPTED' && !(transition.externalId || job.externalId))
    throw new Error('An accepted job must carry the identifier the provider returned.');
  if (transition.to === 'COMPLETED' && !(transition.outputs?.length || job.outputs.length))
    throw new Error('Completion needs attributable output from the provider, not only a terminal status.');
  return {
    ...job,
    state: transition.to,
    externalId: transition.externalId ?? job.externalId,
    externalUrl: transition.externalUrl ?? job.externalUrl,
    evidence: transition.evidence,
    detail: transition.detail,
    outputs: transition.outputs?.length ? [...job.outputs, ...transition.outputs] : job.outputs,
    updatedAt: transition.at,
    dispatchedAt: transition.to === 'SUBMITTING' ? transition.at : job.dispatchedAt,
    settledAt: isTerminalJob(transition.to) ? transition.at : job.settledAt,
    revision: job.revision + 1,
  };
}

/**
 * What a restarted office may do with a job it finds open.
 * An unfinished dispatch is never resubmitted automatically, because the provider may already have accepted it.
 */
export function reconciliationPlan(job: ProviderJob): { action: 'NONE' | 'MARK_UNKNOWN' | 'OBSERVE'; reason: string } {
  if (isTerminalJob(job.state)) return { action: 'NONE', reason: 'This job already has a recorded outcome.' };
  if (job.state === 'INTENT') return { action: 'NONE', reason: 'Preparation is durable; the SUBMITTING boundary was never reached. Keep this work prepared without contacting the provider.' };
  if (job.state === 'SUBMITTING') return { action: 'MARK_UNKNOWN', reason: 'The office was interrupted during submission. The provider may already have accepted this work, so it is never resubmitted automatically.' };
  return { action: 'OBSERVE', reason: 'The job is open; ask the provider for its current state before acting.' };
}
