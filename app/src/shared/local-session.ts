import { z } from 'zod';

/**
 * Contracts for the local-session lifecycle revision (QO-LOCAL-REV-20260919).
 *
 * The record separates four things the old design conflated: where a packet lives (layout/storage),
 * which provider session ran it (providerSessionId, bound only after inspection), what confinement
 * the assignment requires (requirement), and what confinement was actually verified
 * (confinementStatus). A packet directory name is an office delivery label; it is never a provider
 * session identity and never a confinement claim.
 */

const id = z.string().uuid();
const timestamp = z.string().datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const externalId = z.string().min(1).max(200);
const diagnostic = z.string().max(2000);
const effortEnum = z.enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const providerEnum = z.enum(['devin', 'claude', 'openai']);

export const WORKSPACE_LAYOUTS = ['FLAT_PACKET', 'PROJECT_WORKTREE'] as const;
export type WorkspaceLayout = typeof WORKSPACE_LAYOUTS[number];

export const CLIENT_SURFACES = ['CODEX_CLI', 'CODEX_DESKTOP', 'CLAUDE_CLI', 'CLAUDE_DESKTOP', 'DEVIN_CLI', 'UNKNOWN'] as const;
export type ClientSurface = typeof CLIENT_SURFACES[number];

export const CONFINEMENT_REQUIREMENTS = ['SCOPED_DELIVERY', 'READ_CONFINEMENT_REQUIRED'] as const;
export type ConfinementRequirement = typeof CONFINEMENT_REQUIREMENTS[number];

export const CONFINEMENT_STATUSES = ['UNVERIFIED', 'VERIFIED', 'FAILED', 'STALE'] as const;
export type ConfinementStatus = typeof CONFINEMENT_STATUSES[number];

export const GROUPING_STATUSES = ['UNKNOWN', 'DOCUMENTED', 'OBSERVED', 'UNSUPPORTED'] as const;
export type GroupingStatus = typeof GROUPING_STATUSES[number];

export const BINDING_EVIDENCES = ['UNBOUND', 'USER_REPORTED', 'PROVIDER_OBSERVED'] as const;
export type BindingEvidence = typeof BINDING_EVIDENCES[number];

export const LOCAL_LIFECYCLES = ['PREPARING', 'READY', 'PREPARATION_FAILED', 'ARCHIVING', 'ARCHIVED', 'RESTORED_UNBOUND', 'RECONCILE_REQUIRED'] as const;
export type LocalLifecycle = typeof LOCAL_LIFECYCLES[number];

export const STOP_STATUSES = ['NOT_REQUESTED', 'REQUESTED', 'SESSION_REPORTED_STOPPED', 'PROCESS_EXIT_OBSERVED', 'LEGACY_UNVERIFIED'] as const;
export type StopStatus = typeof STOP_STATUSES[number];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A path relative to an office-managed root. Renderer-supplied absolute paths, traversal, device
 * paths, alternate data streams, and Windows-reserved components are all rejected — the managed
 * root is the only authority on where a packet lives.
 */
export const managedRelativePath = z.string().min(1).max(500).refine(value => {
  if (/^[a-zA-Z]:/.test(value) || value.startsWith('\\\\') || value.startsWith('/')) return false;
  const components = value.split(/[\\/]/);
  return components.every(part =>
    part.length > 0 && part !== '.' && part !== '..' && !part.includes(':') && !WINDOWS_RESERVED.test(part) && !/[ .]$/.test(part));
}, 'Not a managed relative path: drive prefixes, device paths, traversal, ADS, reserved names, and empty or trailing-space components are rejected.');

const lastReceiptSchema = z.object({ sequence: z.number().int().positive(), hash, observedAt: timestamp }).strict();

export const localSessionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  jobId: id,
  assignmentId: id,
  projectId: id,
  attemptId: id,
  revision: z.number().int().nonnegative(),
  provider: providerEnum,
  surface: z.enum(CLIENT_SURFACES),
  layout: z.enum(WORKSPACE_LAYOUTS),
  packetVersion: z.union([z.literal(1), z.literal(2)]),
  packetHash: hash.nullable(),
  storageRelativePath: managedRelativePath,
  originalCwd: z.string().max(1000).nullable(),
  repoRelativePath: managedRelativePath.nullable(),
  seedCommit: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  worktreeOwner: z.enum(['OFFICE', 'PROVIDER', 'NONE']),
  providerSessionId: externalId.nullable(),
  providerProjectId: externalId.nullable(),
  bindingEvidence: z.enum(BINDING_EVIDENCES),
  groupingStatus: z.enum(GROUPING_STATUSES),
  requirement: z.enum(CONFINEMENT_REQUIREMENTS),
  confinementStatus: z.enum(CONFINEMENT_STATUSES),
  confinementEvidenceId: id.nullable(),
  lifecycle: z.enum(LOCAL_LIFECYCLES),
  archiveRelativePath: managedRelativePath.nullable(),
  lastReceipt: lastReceiptSchema.nullable(),
  cancelRequestId: id.nullable(),
  stopStatus: z.enum(STOP_STATUSES),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((record, ctx) => {
  if (record.layout === 'PROJECT_WORKTREE') {
    if (record.lifecycle !== 'PREPARING' && record.lifecycle !== 'PREPARATION_FAILED' && (record.repoRelativePath === null || record.seedCommit === null))
      ctx.addIssue({ code: 'custom', message: 'A worktree record past preparation must carry its repository path and seed commit.', path: ['repoRelativePath'] });
    if (record.lifecycle !== 'PREPARING' && record.lifecycle !== 'PREPARATION_FAILED' && record.worktreeOwner === 'NONE')
      ctx.addIssue({ code: 'custom', message: 'A worktree record must name its owner once prepared.', path: ['worktreeOwner'] });
  }
  if (record.layout === 'FLAT_PACKET') {
    if (record.repoRelativePath !== null || record.seedCommit !== null || record.worktreeOwner !== 'NONE')
      ctx.addIssue({ code: 'custom', message: 'A flat packet carries no repository path, seed, or worktree owner.', path: ['layout'] });
  }
  if (record.lifecycle === 'ARCHIVED' && record.archiveRelativePath === null)
    ctx.addIssue({ code: 'custom', message: 'An archived record must carry its archive path.', path: ['archiveRelativePath'] });
  if (record.lifecycle === 'READY' && record.packetVersion === 2 && record.packetHash === null)
    ctx.addIssue({ code: 'custom', message: 'A ready v2 record must carry the verified packet hash.', path: ['packetHash'] });
});
export type LocalSessionRecord = z.infer<typeof localSessionRecordSchema>;

/**
 * The lifecycle machine. Job state and lifecycle are independent axes: a job can be COMPLETED while
 * its packet is still READY, and ARCHIVED never implies a provider outcome. Every edge requires a
 * matching journal phase, decided by the caller — this function only rules on legality.
 */
const LIFECYCLE_EDGES: Readonly<Record<LocalLifecycle, readonly LocalLifecycle[]>> = {
  PREPARING: ['READY', 'PREPARATION_FAILED', 'RECONCILE_REQUIRED'],
  PREPARATION_FAILED: ['PREPARING', 'RECONCILE_REQUIRED'],
  READY: ['ARCHIVING', 'RECONCILE_REQUIRED'],
  ARCHIVING: ['ARCHIVED', 'READY', 'RECONCILE_REQUIRED'],
  ARCHIVED: ['RECONCILE_REQUIRED'],
  RESTORED_UNBOUND: ['READY', 'ARCHIVED', 'RECONCILE_REQUIRED'],
  RECONCILE_REQUIRED: ['PREPARING', 'READY', 'ARCHIVED'],
};

export function transitionLocalLifecycle(from: LocalLifecycle, to: LocalLifecycle): { allowed: boolean; detail: string } {
  if (from === to) return { allowed: true, detail: 'Same-state metadata update; requires expected revision and an idempotency key.' };
  if (LIFECYCLE_EDGES[from].includes(to)) return { allowed: true, detail: `${from} → ${to} is a declared edge; the caller must still prove its required condition.` };
  return { allowed: false, detail: `${from} → ${to} is not a declared lifecycle edge.` };
}

export const LOCAL_JOURNAL_PHASES = ['INTENT', 'EXECUTED', 'VERIFIED', 'REFUSED', 'FAILED', 'RECONCILED'] as const;
export type LocalJournalPhase = typeof LOCAL_JOURNAL_PHASES[number];

export const LOCAL_JOURNAL_KINDS = ['PREPARE', 'PACKET_ARCHIVE', 'PROVIDER_ARCHIVE', 'RESTORE', 'RECONCILE', 'CANCEL_REQUEST'] as const;
export type LocalJournalKind = typeof LOCAL_JOURNAL_KINDS[number];

/** One replayable step of a lifecycle operation — durable intent first, observed outcome second. */
export const localSessionJournalSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  operationId: id,
  localSessionId: id,
  jobId: id,
  kind: z.enum(LOCAL_JOURNAL_KINDS),
  phase: z.enum(LOCAL_JOURNAL_PHASES),
  expectedRevision: z.number().int().nonnegative(),
  source: managedRelativePath.nullable(),
  destination: managedRelativePath.nullable(),
  outcome: z.enum(['NONE', 'SUCCESS', 'REFUSED', 'UNSUPPORTED', 'UNKNOWN']),
  failureDetail: diagnostic.nullable(),
  createdAt: timestamp,
}).strict();
export type LocalSessionJournal = z.infer<typeof localSessionJournalSchema>;

// --- Packet and receipt v2 (QO-LOCAL-REV §6) ---

const packetFileSchema = z.object({ path: z.string().min(1).max(500), sha256: hash, bytes: z.number().int().nonnegative().max(268435456) }).strict();

export const localPacketV2Schema = z.object({
  schema: z.literal('office-local-session@2'),
  jobId: id,
  assignmentId: id,
  attemptId: id,
  projectId: id,
  createdAt: timestamp,
  requestName: z.string().min(1).max(200),
  objective: z.string().max(64000),
  requested: z.object({ model: z.string().min(1).max(200), effort: effortEnum, delegation: z.boolean() }).strict(),
  payload: z.string().max(262144),
  snapshotManifestHash: hash,
  files: z.array(packetFileSchema).max(256),
  /**
   * Verified predecessor outputs a dependent packet carries, staged under
   * `inputs/inherited/<sourceJobId>/`. Each entry pins the producing job and the content-addressed
   * object identity the office re-verified at injection — an output is never inherited by name alone.
   */
  inherited: z.array(packetFileSchema.extend({ sourceJobId: id, objectHash: hash })).max(256).optional(),
  instructions: z.array(packetFileSchema).max(16),
  contract: z.literal('CONTRACT.md'),
}).strict();
export type LocalPacketV2 = z.infer<typeof localPacketV2Schema>;

export const localResultV2Schema = z.object({
  schema: z.literal('office-local-result@2'),
  jobId: id,
  assignmentId: id,
  attemptId: id,
  packetHash: hash,
  sequence: z.number().int().positive(),
  state: z.enum(['ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED']),
  detail: z.string().max(4000),
  outputs: z.array(packetFileSchema).max(256),
  applied: z.object({ model: z.string().min(1).max(200).optional(), effort: effortEnum.optional(), delegation: z.boolean().optional() }).strict().optional(),
}).strict().superRefine((result, ctx) => {
  const seen = new Set<string>();
  for (const output of result.outputs) {
    if (!/^outputs\//.test(output.path)) ctx.addIssue({ code: 'custom', message: 'v2 output paths must live under outputs/.', path: ['outputs'] });
    const key = output.path.toLowerCase();
    if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `Duplicate output path ${output.path} (case-insensitive on Windows).`, path: ['outputs'] });
    seen.add(key);
  }
});
export type LocalResultV2 = z.infer<typeof localResultV2Schema>;

// --- Cooperative cancellation (QO-LOCAL-REV §8) ---

export const cancelRequestV1Schema = z.object({
  schema: z.literal('office-local-cancel-request@1'),
  requestId: id, jobId: id, assignmentId: id, attemptId: id, packetHash: hash, requestedAt: timestamp,
}).strict();
export type CancelRequestV1 = z.infer<typeof cancelRequestV1Schema>;

export const cancelAckV1Schema = z.object({
  schema: z.literal('office-local-cancel-ack@1'),
  requestId: id, jobId: id, assignmentId: id, attemptId: id, packetHash: hash,
  outcome: z.literal('STOPPED'), detail: z.string().max(2000),
}).strict();
export type CancelAckV1 = z.infer<typeof cancelAckV1Schema>;

// --- Applied self-report payload on JobEvent (QO-LOCAL-REV §12) ---

export const appliedReportPayloadSchema = z.object({
  schema: z.literal('office-applied-report@1'),
  attemptId: id,
  receiptSequence: z.number().int().positive(),
  receiptHash: hash,
  model: z.string().min(1).max(200).optional(),
  effort: effortEnum.optional(),
  delegation: z.boolean().optional(),
}).strict();
export type AppliedReportPayload = z.infer<typeof appliedReportPayloadSchema>;

// --- Bounded UI response contracts (QO-LOCAL-REV §12) ---

export const localSessionSummarySchema = z.object({
  jobId: id,
  localSessionId: id,
  revision: z.number().int().nonnegative(),
  layout: z.enum(WORKSPACE_LAYOUTS),
  surface: z.enum(CLIENT_SURFACES),
  lifecycle: z.enum(LOCAL_LIFECYCLES),
  stopStatus: z.enum(STOP_STATUSES),
  cwdDisplay: z.string().max(1000),
  grouping: z.object({ status: z.enum(GROUPING_STATUSES), label: z.string().max(200).nullable() }).strict(),
  confinement: z.object({ required: z.enum(CONFINEMENT_REQUIREMENTS), status: z.enum(CONFINEMENT_STATUSES), detail: diagnostic }).strict(),
  requested: z.object({ model: z.string().max(200), effort: effortEnum, delegation: z.boolean() }).strict(),
  applied: appliedReportPayloadSchema.nullable(),
  archive: z.object({
    packet: z.enum(['LIVE', 'ARCHIVED', 'UNKNOWN']),
    provider: z.enum(['NOT_REQUESTED', 'ARCHIVED', 'UNSUPPORTED', 'BUSY', 'UNKNOWN']),
  }).strict(),
  blockers: z.array(z.string().max(500)).max(32),
}).strict();
export type LocalSessionSummary = z.infer<typeof localSessionSummarySchema>;

export const localLaunchPlanSchema = z.object({
  jobId: id,
  revision: z.number().int().nonnegative(),
  surface: z.enum(CLIENT_SURFACES),
  cwdDisplay: z.string().max(1000),
  packetHash: hash,
  instructions: z.array(z.string().max(2000)).max(32),
  availability: z.enum(['MANUAL_HANDOFF', 'UNSUPPORTED']),
  detail: diagnostic,
}).strict();
export type LocalLaunchPlan = z.infer<typeof localLaunchPlanSchema>;

export const localArchiveResultSchema = z.object({
  operationId: id,
  summary: localSessionSummarySchema,
  packetOutcome: z.enum(['ARCHIVED', 'ALREADY_ARCHIVED', 'REFUSED', 'UNKNOWN']),
  providerOutcome: z.enum(['NOT_REQUESTED', 'ARCHIVED', 'ALREADY_ARCHIVED', 'UNSUPPORTED', 'BUSY', 'UNKNOWN']),
  detail: diagnostic,
}).strict();
export type LocalArchiveResult = z.infer<typeof localArchiveResultSchema>;
