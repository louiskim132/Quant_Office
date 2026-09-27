import type {
  Agent,
  AppState,
  Assignment,
  ProviderCapabilitySnapshot,
  ProviderJob,
  ReviewDecision,
  Role,
  RoleSlot,
} from './types.js';
import { latestJobFor } from '../core/jobs.js';

type Records = Pick<
  AppState,
  'agents' | 'teams' | 'memberships' | 'assignments' | 'jobs' | 'messages' | 'decisions' | 'requests'
>;

export interface ResolvedSlot {
  role: Role;
  requested: number;
  agentIds: string[];
  shortfall: number;
}
export interface SlotResolution {
  teamId: string;
  slots: ResolvedSlot[];
  agentIds: string[];
  blockers: string[];
}

/**
 * Turns requested role slots into actual agents.
 *
 * Membership decides routing, never the team's display name, and a role may be held by several
 * members. An unfillable slot is reported as a shortfall rather than quietly filled by someone else.
 */
export function resolveRoleSlots(
  state: Records,
  input: { teamId: string; slots: RoleSlot[]; excludeAgentIds?: string[] },
): SlotResolution {
  const team = (state.teams ?? []).find(item => item.id === input.teamId);
  const blockers: string[] = [];
  if (!team)
    return {
      teamId: input.teamId,
      slots: [],
      agentIds: [],
      blockers: ['That team no longer exists in this workspace.'],
    };
  if (team.archived) blockers.push(`Team ${team.name} is archived.`);
  const excluded = new Set(input.excludeAgentIds ?? []);
  const taken = new Set<string>();
  const slots: ResolvedSlot[] = [];
  for (const slot of input.slots) {
    const candidates = (state.memberships ?? [])
      .filter(membership => membership.teamId === team.id && membership.role === slot.role && !membership.removedAt)
      .map(membership => (state.agents ?? []).find(agent => agent.id === membership.agentId))
      .filter((agent): agent is Agent =>
        Boolean(agent && !agent.removedAt && !excluded.has(agent.id) && !taken.has(agent.id)),
      )
      // Stable order: the same team and slots resolve to the same agents every time.
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const chosen = candidates.slice(0, slot.count);
    for (const agent of chosen) taken.add(agent.id);
    const shortfall = slot.count - chosen.length;
    if (shortfall > 0)
      blockers.push(
        `${team.name} has ${chosen.length} available ${slot.role} member${chosen.length === 1 ? '' : 's'} for ${slot.count} requested.`,
      );
    slots.push({ role: slot.role, requested: slot.count, agentIds: chosen.map(agent => agent.id), shortfall });
  }
  return { teamId: team.id, slots, agentIds: [...taken], blockers };
}

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

export interface ReviewStatus {
  decisions: (ReviewDecision & { stale: boolean; staleReason: string })[];
  independentReviewers: number;
  approved: boolean;
  blockers: string[];
}

/**
 * Review standing for one request.
 *
 * A decision stops counting when anything it was bound to moves: the request revision, or the exact
 * provider outputs it cited. Amending the work invalidates its approvals rather than inheriting them.
 */
export function reviewStatus(
  state: Records,
  requestId: string,
  options: { requiredReviewers?: number; subjectAssignmentId?: string; bundleHash?: string } = {},
): ReviewStatus {
  const request = (state.requests ?? []).find(item => item.id === requestId);
  const required = options.requiredReviewers ?? 2;
  const decisions = (state.decisions ?? [])
    .filter(
      item =>
        item.requestId === requestId &&
        (!options.subjectAssignmentId || item.subjectAssignmentId === options.subjectAssignmentId) &&
        (!options.bundleHash || item.bundleHash === options.bundleHash),
    )
    .map(decision => {
      const job: ProviderJob | undefined = latestJobFor(state.jobs, decision.subjectAssignmentId);
      const outputs = new Set((job?.outputs ?? []).map(output => output.sha256));
      const missing = decision.outputHashes.filter(value => !outputs.has(value));
      const reviewer = latestJobFor(state.jobs, decision.reviewerAssignmentId);
      const staleReason = !request
        ? 'The request no longer exists.'
        : request.revision !== decision.requestRevision
          ? `The request moved to revision ${request.revision} after this review of revision ${decision.requestRevision}.`
          : missing.length
            ? 'The provider outputs this review cited are no longer the ones on record.'
            : !reviewer ||
                reviewer.state !== 'COMPLETED' ||
                reviewer.evidence !== 'PROVIDER_REPORTED' ||
                !reviewer.externalId ||
                reviewer.externalId === job?.externalId ||
                !reviewer.outputs.length ||
                reviewer.outputs.some(output => !output.stored)
              ? 'The reviewer has no separate completed provider outcome with a stored report.'
              : '';
      return { ...decision, stale: Boolean(staleReason), staleReason };
    });
  const current = decisions.filter(decision => !decision.stale);
  // Even within one request, different subjects, bundles or artifact sets cannot pool approvals.
  const scopes = new Set(
    current.map(d =>
      JSON.stringify([d.subjectAssignmentId, d.inputSnapshotId, d.bundleHash, [...new Set(d.outputHashes)].sort()]),
    ),
  );
  const scoped = scopes.size === 1 ? current : [];
  const latest = new Map<string, (typeof scoped)[number]>();
  for (const decision of scoped) {
    const old = latest.get(decision.reviewerAgentId);
    if (!old || decision.phase === 'REBUTTAL') latest.set(decision.reviewerAgentId, decision);
  }
  const live = [...latest.values()];
  const reviewers = new Set(live.map(decision => decision.reviewerAgentId));
  const blockers: string[] = [];
  if (scopes.size > 1)
    blockers.push(
      'Select one exact subject, bundle and artifact set; approvals from different scopes cannot be pooled.',
    );
  for (const decision of decisions.filter(item => item.stale)) blockers.push(decision.staleReason);
  if (reviewers.size < required)
    blockers.push(
      `${reviewers.size} independent reviewer${reviewers.size === 1 ? '' : 's'} of ${required} required have recorded a current decision.`,
    );
  const rejected = live.filter(decision => decision.verdict !== 'APPROVED');
  for (const decision of rejected)
    blockers.push(`${decision.verdict.toLowerCase().replaceAll('_', ' ')} is recorded against the current version.`);
  return {
    decisions,
    independentReviewers: reviewers.size,
    approved: reviewers.size >= required && rejected.length === 0,
    blockers,
  };
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
