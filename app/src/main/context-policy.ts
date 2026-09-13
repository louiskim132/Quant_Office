import { createHash } from 'node:crypto';
import type { AppState, EffectiveEvidence } from '../shared/types.js';
import { type FunctionAssignment, type Stage, type StageFunction } from '../shared/research.js';
export { STAGE_FUNCTIONS } from '../shared/research.js';
export type { FunctionAssignment, StageFunction };

/**
 * What each stage function is allowed to know, and how a review is kept independent in fact rather
 * than by label.
 *
 * Independence is not a property of who was asked. Two reviewers reading the same performance summary
 * are one reviewer; a correctness reviewer who has seen the returns is answering a different question
 * from the one they were given; a first report read before the others are in becomes the others'
 * starting point. Each of those is cheap to arrange by accident, so each is refused here rather than
 * left to the instructions in a prompt.
 */

export interface ResolvedFunction { function: StageFunction; agentId: string; agentRevision: number; blockers: string[] }

/**
 * Resolves the active assignment for each function at one stage, against live profile revisions.
 *
 * A profile that has been edited since it was assigned is reported rather than used: the work would
 * run under different instructions than the ones the assignment was made against, which is the same
 * class of problem as a stale input snapshot.
 */
export function resolveFunctions(state: Pick<AppState, 'agents'>, assignments: FunctionAssignment[], input: { projectId: string; stage: Stage; functions: StageFunction[] }): ResolvedFunction[] {
  return input.functions.map(name => {
    const active = assignments.filter(item => item.projectId === input.projectId && item.stage === input.stage && item.function === name && !item.supersededById)
      .sort((a, b) => a.appendedAt.localeCompare(b.appendedAt));
    const chosen = active.at(-1);
    const blockers: string[] = [];
    if (!chosen) return { function: name, agentId: '', agentRevision: -1, blockers: [`No profile is assigned to the ${name.toLowerCase().replaceAll('_', ' ')} function at ${input.stage}.`] };
    const agent = state.agents.find(item => item.id === chosen.agentId);
    if (!agent) blockers.push(`The profile assigned to ${name} is not in this workspace.`);
    else {
      if (agent.removedAt) blockers.push(`The profile assigned to ${name} has been removed. Restore it or append a new assignment.`);
      if ((agent.revision ?? 0) !== chosen.agentRevision)
        blockers.push(`${agent.name} is at revision ${agent.revision ?? 0}, but the ${name} assignment was made against revision ${chosen.agentRevision}. Append a new assignment rather than running under changed instructions.`);
    }
    return { function: name, agentId: chosen.agentId, agentRevision: chosen.agentRevision, blockers };
  });
}

/**
 * Turns legacy PM roles into explicit function assignments, without touching the profiles themselves.
 *
 * The mapping is recorded as MIGRATED_FROM_ROLE and appended, never applied in place, so a later
 * reader can see that this project's functions were inferred from an older scheme rather than chosen.
 */
export function migrateRolesToFunctions(state: Pick<AppState, 'agents'>, input: { projectId: string; stage: Stage; now: string; existing: FunctionAssignment[]; id: () => string }): FunctionAssignment[] {
  const mapping: [string, StageFunction][] = [['DIRECTOR', 'DIRECTOR'], ['PM_A', 'PRINCIPAL'], ['PM_B', 'CORRECTNESS_REVIEWER'], ['PM_C', 'ADVOCATE'], ['PM_D', 'SKEPTIC']];
  const appended: FunctionAssignment[] = [];
  for (const [role, name] of mapping) {
    if (input.existing.some(item => item.projectId === input.projectId && item.stage === input.stage && item.function === name && !item.supersededById)) continue;
    const agent = state.agents.filter(item => item.role === role && !item.removedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!agent) continue;
    appended.push({ id: input.id(), projectId: input.projectId, stage: input.stage, function: name, agentId: agent.id,
      agentRevision: agent.revision ?? 0, appendedAt: input.now, supersededById: null, origin: 'MIGRATED_FROM_ROLE',
      note: `Inferred from the legacy ${role} role. The profile's provider, model and instructions are unchanged.` });
  }
  return appended;
}

// ---- blinding -----------------------------------------------------------------------------------

/**
 * Fields a correctness review must never receive.
 *
 * S2 asks whether the work is right, and knowing that it made money is the fastest way to stop
 * asking. The list is matched on key names anywhere in the packet, because the leak that matters is
 * usually an incidental field on an object someone included for another reason.
 */
export const PERFORMANCE_FIELDS = ['sharpe', 'netreturn', 'grossreturn', 'pnl', 'ic', 'rankic', 'auc', 'maxdrawdown',
  'turnover', 'hitrate', 'annualreturn', 'informationratio', 'profit'];

export interface BlindedPacket {
  stage: Stage; subjectId: string; reviewerAgentId: string;
  /** Exactly one subject. Two subjects in one packet is how two reviews become one review. */
  objectHashes: string[]; body: unknown;
  performanceWithheld: true; otherSubjectsWithheld: true; interpretationCacheWithheld: true;
}

function leakedFields(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => leakedFields(item, [...path, String(index)]));
  if (value && typeof value === 'object')
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      (PERFORMANCE_FIELDS.includes(key.toLowerCase().replaceAll('_', '')) ? [[...path, key].join('.')] : []).concat(leakedFields(item, [...path, key])));
  return [];
}

/**
 * Builds an S2 packet, refusing rather than stripping when performance has leaked into it.
 *
 * Stripping would be the friendlier behaviour and the wrong one: a packet containing returns was
 * assembled from the wrong source, and quietly redacting it hides that while leaving the next packet
 * built the same way.
 */
export function buildBlindedPacket(input: { stage: Stage; subjectId: string; reviewerAgentId: string; objectHashes: string[]; body: unknown; subjectIds?: string[] }): BlindedPacket {
  const leaks = leakedFields(input.body);
  if (leaks.length)
    throw new Error(`A correctness packet carries performance information (${leaks.slice(0, 5).join(', ')}). Build it from the frozen specification and the run's own artifacts, not from an evaluation summary.`);
  if (input.subjectIds && input.subjectIds.filter(id => id !== input.subjectId).length)
    throw new Error('A blinded review packet covers exactly one subject. Reviews of different subjects cannot be combined.');
  if (!input.objectHashes.length) throw new Error('A review packet must name the objects it is a review of.');
  return { stage: input.stage, subjectId: input.subjectId, reviewerAgentId: input.reviewerAgentId, objectHashes: [...input.objectHashes].sort(),
    body: input.body, performanceWithheld: true, otherSubjectsWithheld: true, interpretationCacheWithheld: true };
}

/**
 * Builds the S7 advocate and skeptic packets from one evidence set.
 *
 * Advocacy and skepticism are only informative when they disagree about the same material. Handing
 * each side its own evidence produces two confident reports about two different studies.
 */
export function buildAdversarialPackets(input: { subjectId: string; objectHashes: string[]; advocateAgentId: string; skepticAgentId: string; body: unknown }): { advocate: BlindedPacket; skeptic: BlindedPacket; evidenceHash: string } {
  if (input.advocateAgentId === input.skepticAgentId) throw new Error('The advocate and the skeptic cannot be the same profile.');
  const hashes = [...input.objectHashes].sort();
  if (!hashes.length) throw new Error('An adversarial packet must name the objects both sides argue from.');
  const evidenceHash = createHash('sha256').update(JSON.stringify({ subjectId: input.subjectId, hashes, body:input.body })).digest('hex');
  const base = { stage: 'S7' as Stage, subjectId: input.subjectId, objectHashes: hashes, body: input.body,
    performanceWithheld: true as const, otherSubjectsWithheld: true as const, interpretationCacheWithheld: true as const };
  // S7 argues about economics, so performance is legitimately in scope here; what is enforced is that
  // both sides get the identical set, which is why the evidence hash is returned for the receipt.
  return { advocate: { ...base, reviewerAgentId: input.advocateAgentId }, skeptic: { ...base, reviewerAgentId: input.skepticAgentId }, evidenceHash };
}

// ---- sealed reports -----------------------------------------------------------------------------

export interface SealedReport {
  reviewerAgentId: string; subjectId: string; phase: 'FIRST'; sealedAt: string;
  /** The report's identity, recorded now. The text is not readable until every first report is in. */
  contentHash: string;
}
export interface SealedRound { subjectId: string; expectedReviewerIds: string[]; reports: (SealedReport & { body: string })[] }

export function sealReport(input: { reviewerAgentId: string; subjectId: string; body: string; sealedAt: string }): SealedReport & { body: string } {
  return { reviewerAgentId: input.reviewerAgentId, subjectId: input.subjectId, phase: 'FIRST', sealedAt: input.sealedAt,
    contentHash: createHash('sha256').update(input.body).digest('hex'), body: input.body };
}

/**
 * Opens a round of first reports only once every expected reviewer has filed one.
 *
 * A first report read early is not evidence of anything except what the first reviewer thought, and
 * the remaining reviewers will now agree with it more often than they otherwise would.
 */
export function openSealedRound(round: SealedRound): (SealedReport & { body: string })[] {
  const filed = new Set(round.reports.map(report => report.reviewerAgentId));
  const outstanding = round.expectedReviewerIds.filter(id => !filed.has(id));
  if (outstanding.length)
    throw new Error(`${outstanding.length} of ${round.expectedReviewerIds.length} first reports have not been filed. Sealed reports open only when the round is complete.`);
  return round.reports;
}

// ---- isolation ----------------------------------------------------------------------------------

export type IndependenceLabel = 'VERIFIED_INDEPENDENT' | 'SEPARATE_SESSION_UNVERIFIED' | 'NOT_INDEPENDENT';

/**
 * How independent a review may honestly be called, given what was actually observed.
 *
 * The strong label requires observed confinement evidence for the route the review ran on. A flag in
 * a fixture, or a route the account has never been seen to isolate, buys the weaker label — which is
 * still useful, and is not the same claim.
 */
export function independenceLabel(input: {
  subjectExternalId: string; reviewerExternalId: string; subjectAgentId: string; reviewerAgentId: string;
  evidence: EffectiveEvidence[]; route: string;
}): { label: IndependenceLabel; detail: string } {
  if (input.reviewerAgentId === input.subjectAgentId)
    return { label: 'NOT_INDEPENDENT', detail: 'The reviewer and the author are the same profile.' };
  if (!input.reviewerExternalId || input.reviewerExternalId === input.subjectExternalId)
    return { label: 'NOT_INDEPENDENT', detail: 'The review shares the subject’s provider session, so it shares its context.' };
  const confinement = input.evidence.find(item => item.operation === 'TOOL_CONFINEMENT' && item.route === input.route
    && item.evidence === 'OBSERVED' && !item.expired && !item.impossible);
  if (!confinement)
    return { label: 'SEPARATE_SESSION_UNVERIFIED', detail: `The review ran in a separate session, but no observed context-isolation evidence exists for the ${input.route} route. It cannot be labelled verified independent.` };
  return { label: 'VERIFIED_INDEPENDENT', detail: `Separate session with observed confinement on ${input.route}, verified ${confinement.verifiedAt}.` };
}
