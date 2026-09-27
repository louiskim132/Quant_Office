import { z } from 'zod';

/**
 * Final-holdout custody: what a sealed dataset is, who may spend it, and how that spending is
 * remembered even when everything else is rolled back.
 *
 * The purpose of a holdout is to be looked at once. Everything expensive about the design follows
 * from that: a reservation is written before the data moves rather than after, exposure is journalled
 * outside the restorable state so an old backup cannot un-spend it, and a crash is treated as
 * possible exposure rather than as nothing having happened. A flag on a row would satisfy none of
 * this, which is why sealed bytes live outside the workspace the agents and the backup can see.
 */

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid();

/**
 * What this build can actually do about custody, observed rather than assumed.
 *
 * Until both are true the office does not claim a holdout is sealed. Saying so on the strength of a
 * configuration value would make every S8 result a claim about software that was never checked.
 */
export interface CustodyCapability {
  verification?: 'LOCAL_FIXTURE' | 'HOSTED';
  /** Sealed bytes are stored outside the agent-visible workspace, backup and search index. */
  sealedStorageSupported: boolean;
  /** The evaluator runs without access to the workspace, its index or its interpretation cache. */
  isolatedEvaluatorSupported: boolean;
  detail: string;
}
export function custodyBlocker(capability: CustodyCapability): string | null {
  if (!capability.sealedStorageSupported)
    return `Sealed holdout storage is not available in this build (${capability.detail}). S8 stays blocked; there is no local file or token that substitutes for custody.`;
  if (!capability.isolatedEvaluatorSupported)
    return `An isolated evaluator is not available in this build (${capability.detail}). S8 stays blocked rather than evaluating the holdout in a context that can also read the workspace.`;
  return null;
}

export const holdoutSchema = z
  .object({
    id,
    projectId: id,
    name: z.string().trim().min(1).max(200),
    /** The identity of the sealed bytes. Never a path the renderer or an agent could resolve. */
    sealedHash: hash,
    sealedBytes: z.number().int().min(1),
    /** Calendar quarters in one declared zone, so "this quarter" means the same thing every time. */
    periodPolicy: z.literal('CALENDAR_QUARTER'),
    timezoneOffsetMinutes: z.number().int().min(-840).max(840),
    allowancePerPeriod: z.number().int().min(1).max(16),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Holdout = z.infer<typeof holdoutSchema>;

/**
 * One claim on a holdout's allowance, written before anything is exported.
 *
 * RESERVED already costs the allowance. That is deliberate: if the reservation only counted once a
 * report came back, a crash between export and report would return the allowance while the data had
 * already been seen.
 */
export const reservationSchema = z
  .object({
    id,
    holdoutId: id,
    projectId: id,
    lineageId: id,
    branchId: id,
    /** Exactly what would be evaluated. A changed candidate is a different reservation, not a retry. */
    candidateHash: hash,
    refitHash: hash,
    period: z.string().regex(/^[0-9]{4}Q[1-4]$/),
    queryHash: hash.optional(),
    state: z.enum(['RESERVED', 'EXPORTED', 'EXPOSED', 'RELEASED', 'UNKNOWN']),
    reservedAt: z.string().datetime(),
    settledAt: z.string().datetime().nullable(),
    /** The report this reservation was settled by, so re-fetching the same one is not a new look. */
    reportHash: hash.nullable(),
    detail: z.string().trim().max(2000),
  })
  .strict();
export type HoldoutReservation = z.infer<typeof reservationSchema>;

/**
 * One line of the exposure journal: hash-chained, append-only and kept outside restorable state.
 *
 * The chain is what makes a truncated or rewritten journal detectable. Its location outside the
 * database is what makes restoring yesterday's backup unable to forget that the holdout was seen
 * this morning.
 */
export const journalEntrySchema = z
  .object({
    sequence: z.number().int().min(1),
    holdoutId: id,
    reservationId: id,
    lineageId: id,
    period: z.string().regex(/^[0-9]{4}Q[1-4]$/),
    kind: z.enum(['RESERVED', 'EXPORTED', 'EXPOSED', 'RELEASED', 'UNKNOWN_AFTER_RESTORE']),
    candidateHash: hash,
    at: z.string().datetime(),
    detail: z.string().trim().max(2000),
    refitHash: hash.optional(),
    queryHash: hash.optional(),
    previousHash: hash,
    hash,
  })
  .strict();
export type ExposureJournalEntry = z.infer<typeof journalEntrySchema>;
export const ZERO_HASH = '0'.repeat(64);

/**
 * The calendar quarter a moment falls in, in the holdout's own declared zone.
 *
 * A holdout's allowance renews on a boundary, so the boundary has to be a fact rather than a local
 * accident. An evaluation at 23:30 on 31 March in one zone is the next quarter in another, and
 * whichever answer is right, it must not depend on where the machine happens to be.
 */
export function quarterOf(iso: string, timezoneOffsetMinutes: number): string {
  const shifted = new Date(Date.parse(iso) + timezoneOffsetMinutes * 60_000);
  return `${shifted.getUTCFullYear()}Q${Math.floor(shifted.getUTCMonth() / 3) + 1}`;
}

/** Gate outcomes that must all be settled before a holdout may be unsealed at all. */
export const UNSEAL_REQUIRED_GATES = [
  'G-CORRECT',
  'G-TIME',
  'G-SPLIT',
  'G-FIT',
  'G-TARGET',
  'G-SELECT',
  'G-TRADETIME',
  'G-COST',
  'G-PORTFOLIO',
  'G-ECON',
] as const;

/**
 * Whether the S2, S6 and S7 record permits looking at the holdout.
 *
 * The holdout is the last thing spent, so anything unresolved earlier is a reason not to spend it.
 * A single failed or missing gate is enough: a final evaluation of a candidate that has not passed
 * correctness answers a question nobody asked.
 */
export function unsealBlockers(input: {
  gates: { gate: string; outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'BLOCKED' }[];
  adjudication: 'UPHELD' | 'REVISION_REQUIRED' | 'FOLLOW_UP_GRANTED' | 'LINEAGE_SUSPENDED' | null;
}): string[] {
  const blockers: string[] = [];
  for (const gate of UNSEAL_REQUIRED_GATES) {
    const found = input.gates.filter(item => item.gate === gate).at(-1);
    if (!found) blockers.push(`${gate} has no recorded outcome for this candidate.`);
    else if (found.outcome === 'FAIL') blockers.push(`${gate} failed for this candidate.`);
    else if (found.outcome === 'BLOCKED') blockers.push(`${gate} is blocked for want of evidence.`);
  }
  if (input.adjudication === null) blockers.push('S7 adjudication has not been recorded for this candidate.');
  else if (input.adjudication !== 'UPHELD')
    blockers.push(`S7 adjudication was ${input.adjudication.toLowerCase().replaceAll('_', ' ')}, not upheld.`);
  return blockers;
}

/** What an isolated evaluator is handed, and nothing else. */
export interface EvaluatorInput {
  sealedHash: string;
  sealedBytes: Uint8Array;
  candidateHash: string;
  predictions: { rowId: string; prediction: number }[];
}
export interface EvaluatorResult {
  reportHash: string;
  metric: string;
  value: number | null;
  samples: number;
  detail: string;
}
export interface IsolatedEvaluator {
  readonly isolated: true;
  evaluate(input: EvaluatorInput): Promise<EvaluatorResult>;
}
