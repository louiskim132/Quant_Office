import type { Assignment } from '../shared/types.js';

/**
 * The confinement lane one local assignment takes.
 *
 * A lane is a confinement claim, not a scheduling preference: `ISOLATED` promises the session
 * cannot reach sibling work, while `ROUTINE_ALLOWED` asserts only the ordinary scoped
 * workspace. The union is deliberately small and named so a later rule — for example an
 * explicit per-request override — can extend it without changing call sites.
 */
export type LocalLane = 'ISOLATED' | 'ROUTINE_ALLOWED';

/**
 * The scalar fields a record must carry to be recognized as an assignment at all. Absent or
 * mistyped members make the record an unknown shape, not a plain request.
 */
const STRING_FIELDS = [
  'id', 'projectId', 'requestId', 'agentId', 'connectionId', 'capabilitySnapshotId',
  'snapshotId', 'route', 'requestedModel', 'resolvedModel', 'requestedEffort', 'appliedEffort',
  'objectiveHash', 'createdAt',
] as const;
const NUMBER_FIELDS = ['requestRevision', 'agentRevision'] as const;

/** Whether a record has the required scalar shape of an Assignment. */
function hasAssignmentShape(assignment: object): boolean {
  const record = assignment as Record<string, unknown>;
  return STRING_FIELDS.every(field => typeof record[field] === 'string')
    && NUMBER_FIELDS.every(field => typeof record[field] === 'number' && Number.isFinite(record[field]))
    && typeof record.delegation === 'boolean';
}

/**
 * Decides which lane one local assignment takes, from the assignment record alone.
 *
 * Any assignment carrying research pipeline context is `ISOLATED` unconditionally: sealed
 * review stages promise independence, and a shared project root would let those sessions read
 * sibling worktrees. Only a plain request assignment — one with no research context at all —
 * may take `ROUTINE_ALLOWED`.
 *
 * The function is pure and total. Anything ambiguous — a missing field, an unknown shape, a
 * record that is not an object — resolves to `ISOLATED`, because doubt about a confinement
 * claim must land on the stronger one.
 */
export function localLaneFor(assignment: Assignment): LocalLane {
  if (assignment === null || typeof assignment !== 'object') return 'ISOLATED';
  if (assignment.research !== undefined) return 'ISOLATED';
  return hasAssignmentShape(assignment) ? 'ROUTINE_ALLOWED' : 'ISOLATED';
}
