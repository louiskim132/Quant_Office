import type { Assignment } from '../shared/types.js';
import { stageContextSchema } from '../shared/pipeline.js';
import type { ConfinementRequirement, WorkspaceLayout } from '../shared/local-session.js';

/**
 * The confinement requirement one local assignment carries — a requirement classifier, not a
 * capability claim (QO-LOCAL-REV-20260919 §13, defect F04). The old localLaneFor returned an
 * `ISOLATED` label that read as an achieved property; this revision separates what the work
 * *needs* from what any layout has *proven*. Nothing here asserts a layout confines anything —
 * `permittedLayouts` only lists which delivery layouts could host the requirement at all, and the
 * record's confinementStatus must separately carry VERIFIED evidence before a sensitive
 * requirement is treated as met.
 */
export type LocalLaneDecision =
  | { allowed: false; reason: string }
  | { allowed: true; requirement: ConfinementRequirement; permittedLayouts: WorkspaceLayout[]; detail: string };

/** The scalar fields a record must carry to be recognized as an assignment at all. */
const STRING_FIELDS = [
  'id', 'projectId', 'requestId', 'agentId', 'connectionId', 'capabilitySnapshotId',
  'snapshotId', 'route', 'requestedModel', 'resolvedModel', 'requestedEffort', 'appliedEffort',
  'objectiveHash', 'createdAt',
] as const;
const NUMBER_FIELDS = ['requestRevision', 'agentRevision'] as const;

function hasAssignmentShape(assignment: object): boolean {
  const record = assignment as Record<string, unknown>;
  return STRING_FIELDS.every(field => typeof record[field] === 'string')
    && NUMBER_FIELDS.every(field => typeof record[field] === 'number' && Number.isFinite(record[field]))
    && typeof record.delegation === 'boolean';
}

/** Stages whose contexts are bound to frozen review rounds — the existing isolation guard. */
const SEALED_STAGES: readonly string[] = ['S2', 'S7'];

/**
 * Decides the confinement requirement for one local assignment, from the record alone.
 *
 * - Malformed or unrecognizable input is refused outright: unknown requirements block admission
 *   rather than silently inheriting a safer-looking label (spec invariant 9).
 * - A research context that fails its own strict schema is malformed — refused, never routed.
 * - Any valid research context requires read confinement: the review's independence claim dies if
 *   the session can read sibling packets. No current layout carries verified confinement evidence,
 *   so `permittedLayouts` is empty and the router must refuse — this is the honest
 *   "no dispatch and no ISOLATED claim" of ADMIT-02. The manual controller-separated pilot is
 *   unaffected: it never routes through the local mailbox at all.
 * - A fully-formed plain request needs only scoped delivery and may use either layout.
 *
 * Pure and total: no clocks, no stores, no throws for malformed input — refusal is a value.
 */
export function localRequirementFor(assignment: Assignment): LocalLaneDecision {
  if (assignment === null || typeof assignment !== 'object')
    return { allowed: false, reason: 'The assignment is not a record; nothing about its requirements can be established.' };
  if (!hasAssignmentShape(assignment))
    return { allowed: false, reason: 'The assignment is missing or mistyped required fields; malformed requirements block admission.' };
  if (assignment.research !== undefined) {
    if (!stageContextSchema.safeParse(assignment.research).success)
      return { allowed: false, reason: 'The assignment carries a malformed research context; it cannot be routed until the context validates.' };
    const sealed = SEALED_STAGES.includes(assignment.research.stage);
    return {
      allowed: true,
      requirement: 'READ_CONFINEMENT_REQUIRED',
      permittedLayouts: [],
      detail: sealed
        ? `Stage ${assignment.research.stage} is a sealed review context: its report is only independent if sibling packets are unreadable. No workspace layout carries verified read confinement today, so local dispatch must refuse.`
        : 'A research-context assignment still claims context independence; no workspace layout carries verified read confinement today, so local dispatch must refuse.',
    };
  }
  return {
    allowed: true,
    requirement: 'SCOPED_DELIVERY',
    permittedLayouts: ['FLAT_PACKET', 'PROJECT_WORKTREE'],
    detail: 'A plain request assignment needs only scoped delivery; confinement status stays UNVERIFIED until evidence exists.',
  };
}
