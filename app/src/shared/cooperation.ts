import type { AppState, Assignment, ProviderCapabilitySnapshot, ReviewDecision } from './types.js';
import { latestJobFor } from '../core/jobs.js';

type Records = Pick<
  AppState,
  'agents' | 'teams' | 'memberships' | 'assignments' | 'jobs' | 'messages' | 'decisions' | 'requests'
>;
const SETTLED = ['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED'];

/** Whether an assignment's declared dependencies have actually finished, with reasons when they have not. */
export function dependencyStatus(state: Records, assignment: Assignment): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  for (const dependency of assignment.dependsOn ?? []) {
    const other = (state.assignments ?? []).find(item => item.id === dependency);
    if (!other) {
      blockers.push('A dependency of this work is not recorded in this workspace.');
      continue;
    }
    const job = latestJobFor(state.jobs, other.id);
    if (!job) {
      blockers.push('A dependency has no provider job yet.');
      continue;
    }
    if (job.state === 'COMPLETED') continue;
    blockers.push(
      SETTLED.includes(job.state)
        ? `A dependency ended as ${job.state.toLowerCase().replaceAll('_', ' ')}, so this work cannot proceed on its result.`
        : `A dependency is still ${job.state.toLowerCase().replaceAll('_', ' ')}.`,
    );
  }
  return { ready: blockers.length === 0, blockers };
}

/**
 * Whether a review may be recorded as verified independent.
 *
 * The strong label is a claim about observed context isolation on the exact route the review ran on.
 * A separate session is necessary and not sufficient: without evidence that the session could not
 * see the author's context, 'verified' is a description of the intent rather than of what happened.
 * The weaker label stays available and is not a lesser kind of honesty.
 */
export function independenceClaimBlocker(input: {
  capabilities: ProviderCapabilitySnapshot[];
  reviewer: Pick<Assignment, 'route' | 'capabilitySnapshotId'>;
  claim: ReviewDecision['independence'];
}): string | null {
  if (input.claim !== 'VERIFIED_INDEPENDENT') return null;
  const snapshot = input.capabilities.find(item => item.id === input.reviewer.capabilitySnapshotId);
  const confined = snapshot?.operations.some(
    item =>
      item.operation === 'TOOL_CONFINEMENT' && item.evidence === 'OBSERVED' && item.route === input.reviewer.route,
  );
  return confined
    ? null
    : 'This review has no observed context-isolation evidence for the route it ran on, so it cannot be recorded as verified independent.';
}
