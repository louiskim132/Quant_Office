import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';

/** stat that returns undefined for missing/unreadable paths instead of throwing raw ENOENT. */
function safeStat(p: string) { try { return statSync(p); } catch { return undefined; } }

/**
 * The project dialog's folder field and the location record describe one scope. Writing through
 * here keeps the record — the field snapshots actually read — in step with the display copy on the
 * project, in the same transaction. The revision bumps only when the folder value really changes,
 * so a mandate-only edit never invalidates a prepared snapshot.
 */
function upsertLocationScope(state: Projection, changes: Change[], project: Project, root: string, now: string): boolean {
  const existing = (state.locations ?? []).find(l => l.projectId === project.id);
  if ((existing?.localFolder ?? '') === root) return false;
  const location: ProjectLocation = {
    id: existing?.id ?? randomUUID(), projectId: project.id, localFolder: root, inputPaths: existing?.inputPaths ?? [],
    outputFolder: existing?.outputFolder ?? '',
    sourceRepository: root && existsSync(resolve(root, '.git')) ? resolve(root, '.git') : '',
    snapshotRoute: 'PROJECT_FOLDER_SNAPSHOT',
    providerTarget: existing?.providerTarget ?? { provider: 'claude', host: 'ANTHROPIC_MANAGED', selection: 'PROVIDER_DEFAULT', environmentId: '', resolved: false },
    legacyNote: existing?.legacyNote ?? project.cloudWorkspace ?? '',
    revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now,
  };
  changes.push({ collection: 'locations', value: location });
  return true;
}
import { resolve, isAbsolute } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { z } from 'zod';
import { independenceClaimBlocker } from '../shared/cooperation.js';
import { requestJobs, UNRESOLVED } from '../shared/queue.js';
import type { AccountConnection, ProviderCapabilitySnapshot, ProjectLocation, InputSnapshot, Assignment, ProviderJob, JobEvent, JobEvidence, JobState, Team, TeamMembership, Message, ReviewDecision, RequestGrant, ProbeAttempt, ResearchBranch, FrozenResearchSpec, PredictionRecord, TrialLedgerEntry, StageAttempt, GateReceipt, FunctionAssignment, SealedReviewReport, Agent, AgentLog, WorkLog, Effort, AppState, Artifact, Command, Experiment, LineageEvent, Project, ResearchContract, ResearchTask, Request, Settings, MemoryFinding, MemoryRelationship, MemoryGraph, FindingEvidenceRef, FindingKind, RelationshipStatus } from '../shared/types.js';
import { canonical, canonicalHash, sha256 } from './canonical.js';
import { officeChatPage, type OfficeChatQuery } from '../shared/office-chat.js';
import { parseStrictJson } from './strict-json.js';
import {ResearchAdmission} from './research-admission';
import {adjudicate,recheckMandatoryGates} from './adjudication';
import type {ResearchTrustPin,SignedResearchClaim} from '../shared/research-admission';
import type {HoldoutReservation,EvaluatorResult} from '../shared/holdout';
import {shadowBatchSchema} from '../shared/shadow';
import {replayShadow} from './shadow-ledger';
import { nextJob } from './jobs.js';
import { appliedReportPayloadSchema, localLaunchPlanSchema, localSessionJournalSchema, localSessionRecordSchema, localSessionSummarySchema, transitionLocalLifecycle, type LocalLaunchPlan, type LocalSessionJournal, type LocalSessionRecord, type LocalSessionSummary } from '../shared/local-session.js';
import { toolProfileSchema } from '../shared/tool-profile.js';
import { MAX_BUDGET_CENTS } from './guards.js';
import {pipelineRecordSchema,stageContextHash,stageContextSchema,stageReportSchema,type PipelineRecord} from '../shared/pipeline';
import {evidenceRecordSchema,type EvidenceRecord} from '../shared/evidence';
import {nextActions,STAGES,STAGE_GATES} from '../shared/research';
import {runPackageHash,runPackageId,STAGE_DELIVERY,type RunPackageManifest,type RunReturnManifest} from '../shared/run-package';

export { canonical, canonicalHash, sha256 } from './canonical.js';
const ZERO_HASH = '0'.repeat(64);
const cents = z.number().int().min(0).max(MAX_BUDGET_CENTS);
const id = z.string().uuid();
const timestamp = z.string().datetime();
const text = (maximum: number) => z.string().max(maximum);
const title = z.string().trim().min(1).max(160);
const role = z.enum(['DIRECTOR', 'PM_A', 'PM_B', 'PM_C', 'PM_D', 'WORKER']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const contractSchema = z.object({ objective: text(12000), dataPolicy: text(12000), modelFamilies: text(12000), evaluation: text(12000), economics: text(12000), protectedRegions: text(12000), requiredChecks: text(12000), limitations: text(12000) }).strict();
const settingsSchema = z.object({ theme: z.enum(['dark', 'light']), reducedMotion: z.boolean(), globalBudgetCents: cents }).strict();
const stageEnum=z.enum(['S0','S1','S2','S3','S4','S5','S6','S7','S8','S9','S10']);
const gateEnum=z.enum(['G-SPEC','G-CORRECT','G-TIME','G-SPLIT','G-FIT','G-TARGET','G-SELECT','G-TRADETIME','G-ARTIFACT','G-COST','G-PORTFOLIO','G-ECON','G-INTEGRITY','G-SHADOW']);
const outcomeEnum=z.enum(['IN_PROGRESS','VALID_NEGATIVE','INCONCLUSIVE','RETIRED','SHADOW_QUALIFIED','SUSPENDED']);
const common = { idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/) };
const findingKindSchema=z.enum(['OBSERVATION','HYPOTHESIS','RESULT','DEFECT','DECISION','NOTE']);
const relationshipKindSchema=z.enum(['SUPPORTS','CONTRADICTS','RELATES','DUPLICATES','REFINES']);
const findingRefSchema=z.object({kind:z.enum(['OBJECT','ASSIGNMENT','JOB','REQUEST']),id:z.string().min(1).max(200)}).strict();
export const commandSchema = z.discriminatedUnion('type', [
  z.object({...common,type:z.literal('request.create'),projectId:id,name:title,hypothesis:z.string().trim().min(1).max(12000),workType:z.enum(['QUESTION','ANALYSIS','IMPLEMENTATION','CODE_REVIEW','EXPERIMENT','PLANNING','RESULT_ANALYSIS','OTHER']).optional(),mode:z.enum(['SINGLE','GROUP','TEAM']).optional(),leadAgentId:id.nullable().optional(),participantIds:z.array(id).optional(),acceptanceCriteria:text(12000).optional()}).strict(),
  z.object({...common,type:z.literal('request.update'),requestId:id,expectedRevision:z.number().int().nonnegative(),objective:z.string().trim().min(1).max(12000),leadAgentId:id.nullable(),participantIds:z.array(id),acceptanceCriteria:text(12000)}).strict(),
  ...(['request.start','request.cancel','request.duplicate','request.pipeline.confirm'] as const).map(type=>z.object({...common,type:z.literal(type),requestId:id,expectedRevision:z.number().int().nonnegative()}).strict()),
  z.object({...common,type:z.literal('request.pipeline.note'),requestId:id,expectedRevision:z.number().int().nonnegative(),text:z.string().trim().min(1).max(4000)}).strict(),
  z.object({...common,type:z.literal('request.pipeline.decide'),requestId:id,expectedRevision:z.number().int().nonnegative(),decision:z.enum(['APPROVE','REVISE','REJECT']),note:z.string().trim().max(4000).optional(),expectedSpecHash:hash,expectedReceiptHash:hash}).strict(),
  z.object({...common,type:z.literal('memory.finding.note'),projectId:id,requestId:id.nullable().optional(),kind:findingKindSchema,title:title,body:text(4000),evidenceRefs:z.array(findingRefSchema).max(32).optional(),supersedesFindingId:id.optional()}).strict(),
  z.object({...common,type:z.literal('memory.relationship.settle'),relationshipId:id,status:z.enum(['CONFIRMED','REFUTED'])}).strict(),
  z.object({...common,type:z.literal('agent.remove'),agentId:id,removed:z.boolean()}).strict(),
  z.object({...common,type:z.literal('agent.delete'),agentId:id}).strict(),
  z.object({...common,type:z.literal('agent.update'),agentId:id,expectedRevision:z.number().int().nonnegative().optional(),name:title,team:title,role,instructions:text(12000)}).strict(),
  z.object({ ...common, type: z.literal('project.create'), name: title, mandate: text(30000), localFolder:text(32000).optional(),cloudWorkspace:text(1000).optional(), budgetCents: cents }).strict(),
  z.object({ ...common, type: z.literal('project.update'), projectId: id, name: title, mandate: text(30000), localFolder:text(32000).optional(),cloudWorkspace:text(1000).optional(), budgetCents: cents }).strict(),
  z.object({ ...common, type: z.literal('project.archive'), projectId: id, archived: z.boolean() }).strict(),
  z.object({ ...common, type: z.literal('team.create'), name: title, projectId: id.nullable() }).strict(),
  z.object({ ...common, type: z.literal('team.rename'), teamId: id, expectedRevision: z.number().int().nonnegative(), name: title }).strict(),
  z.object({ ...common, type: z.literal('team.member'), teamId: id, agentId: id, role, member: z.boolean() }).strict(),
  z.object({ ...common, type: z.literal('research.draftSpec'), projectId: id, branchId: id.optional(), expectedRevision:z.number().int().nonnegative().optional(), name: title,
    sections: z.object({estimand:text(12000),splitPlan:text(12000),searchPlan:text(12000),costContract:text(12000),
      portfolioContract:text(12000),metricsAndGates:text(12000),holdoutPolicy:text(12000)}).strict(),
    thresholds: z.array(z.object({gate:gateEnum,rule:text(2000)}).strict()).max(64),
    notApplicable: z.array(z.object({gate:gateEnum,rationale:text(2000)}).strict()).max(32),
    gateEvidence: z.array(z.object({gate:gateEnum,tier:z.literal('SIGNED_HARNESS')}).strict()).max(32).optional(),
    maxSelectionTrials: z.number().int().min(0).max(100000) }).strict(),
  z.object({ ...common, type: z.literal('research.freezeSpec'), specId: id, expectedRevision: z.number().int().nonnegative(),
    prediction: z.object({outcomeName:title,sign:z.enum(['POSITIVE','NEGATIVE','NONE']),expectedLow:z.number(),expectedHigh:z.number(),
      probability:z.number().min(0).max(1),falsifiers:z.array(text(2000)).max(32),existingKnowledge:text(12000),retrospective:z.boolean()}).strict() }).strict(),
  z.object({ ...common, type: z.literal('research.registerVariant'), branchId: id, kind: z.enum(['VARIANT','METADATA_RETRY','FOLLOW_UP']),
    variantHash: hash, description: text(4000) }).strict(),
  z.object({ ...common, type: z.literal('research.createStageAttempt'), branchId: id, stage: stageEnum,
    assignmentId: id.nullable(), trialId: id.nullable(), summary: text(4000) }).strict(),
  z.object({ ...common, type: z.literal('research.amendBranch'), branchId: id, expectedRevision: z.number().int().nonnegative(),
    name: title, reason: text(2000) }).strict(),
  z.object({ ...common, type: z.literal('research.settleBranch'), branchId: id, expectedRevision: z.number().int().nonnegative(),
    outcome: outcomeEnum, reason: text(2000) }).strict(),
  z.object({ ...common, type: z.literal('request.grant'), requestId: id, agentId: id, capacity: z.enum(['REVIEW','WORKER','DIRECTOR','DELEGATE']), granted: z.boolean() }).strict(),
  z.object({ ...common, type: z.literal('request.slots'), requestId: id, expectedRevision: z.number().int().nonnegative(), teamId: id.nullable(), slots: z.array(z.object({role,count:z.number().int().min(1).max(64)}).strict()).max(16) }).strict(),
  z.object({ ...common, type: z.literal('location.save'), projectId: id, expectedRevision: z.number().int().nonnegative(), localFolder: text(32000), inputPaths: z.array(z.string().min(1).max(1000)).max(2000).optional(), outputFolder: text(32000) }).strict(),
  z.object({ ...common, type: z.literal('experiment.create'), projectId: id, name: title, hypothesis: text(12000) }).strict(),
  z.object({ ...common, type: z.literal('contract.save'), experimentId: id, expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), contract: contractSchema }).strict(),
  z.object({ ...common, type: z.literal('contract.submit'), experimentId: id, expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1) }).strict(),
  z.object({ ...common, type: z.literal('task.create'), projectId: id, experimentId: id.nullable(), prompt: z.string().trim().min(1).max(30000), recipient: role }).strict(),
  z.object({ ...common, type: z.literal('task.cancel'), taskId: id }).strict(),
  z.object({ ...common, type: z.literal('task.delete'), taskId: id, expectedRevision: z.number().int().nonnegative().optional() }).strict(),
  z.object({ ...common, type: z.literal('project.delete'), projectId: id }).strict(),
  z.object({ ...common, type: z.literal('settings.update'), settings: settingsSchema }).strict(),
]);
const projectSchema = z.object({ id, name: title, mandate: text(30000), localFolder:text(32000).optional(),cloudWorkspace:text(1000).optional(), budgetCents: cents, archived: z.boolean(), removedAt: timestamp.optional(), createdAt: timestamp, updatedAt: timestamp }).strict();
const experimentSchema = z.object({ id, projectId: id, name: title, hypothesis: text(30000), stage: z.enum(['DRAFT', 'CONTRACT_REVIEW', 'CANCELED']), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), contract: contractSchema, createdAt: timestamp, updatedAt: timestamp }).strict();
const taskSchema = z.object({ id, projectId: id, experimentId: id.nullable(), prompt: text(30000), recipient: role, status: z.enum(['BLOCKED', 'CANCELED', 'SUPERSEDED']), blocker: text(1000).nullable(), removedAt: timestamp.optional(), createdAt: timestamp, updatedAt: timestamp }).strict();
const artifactSchema = z.object({ id, projectId: id, experimentId: id.nullable(), name: z.string().min(1).max(255).refine(value => !/[\\/\x00-\x1f]/.test(value), 'Artifact name must be a basename'), sha256: hash, size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), kind: z.enum(['REFERENCE','RESULT']), classification: z.enum(['UNCLASSIFIED','USER_ATTESTED']), status: z.enum(['STORED','QUARANTINED']), createdAt: timestamp, mediaType: text(160), note: text(4000) }).strict();
export const effortSchema=z.enum(['default','none','minimal','low','medium','high','xhigh','max','ultra']);
export const agentDraftSchema = z.object({ name: title, provider: z.enum(['openai','claude','devin']), model: z.string().trim().min(1).max(160), team: title, role, instructions: text(12000), effort: effortSchema.optional(), execution: z.enum(['HOSTED_SETUP_REQUIRED','LOCAL']).optional(), toolProfile: z.enum(['STANDARD','CODE_NAV']).optional(), localRoute: z.enum(['LOCAL_MAILBOX','LOCAL_CLI_EXEC']).optional() }).strict();
// `account` stays the historical setup identity. `connectionId` is a durable binding fact and is never writable through a profile edit.
const agentSchema = agentDraftSchema.extend({revision:z.number().int().nonnegative().optional(),removedAt:timestamp.optional(),deletedAt:timestamp.optional(),id, account: title, setupAccount: title.optional(), createdAt: timestamp, connectionVerifiedAt: timestamp, connectionId:id.optional(), bindingVerifiedAt:timestamp.optional(), execution: z.enum(['HOSTED_SETUP_REQUIRED','LOCAL']).default('HOSTED_SETUP_REQUIRED')}).strict();
const logSchema=z.object({id,conversationId:z.string().min(1).max(200),from:z.string().min(1).max(100),to:z.string().min(1).max(100),kind:z.enum(['MESSAGE','TOOL','STATUS']),text:text(64000),timestamp,sourceHash:hash,externalId:z.string().min(1).max(200),provenance:z.literal('USER_IMPORTED')}).strict();
const requestSchema=z.object({migratedFromTaskId:id.optional(),teamId:id.optional(),roleSlots:z.array(z.object({role,count:z.number().int().min(1).max(64)}).strict()).max(16).optional(),id,projectId:id,experimentId:id.nullable(),name:title,objective:text(12000),workType:z.enum(['QUESTION','ANALYSIS','IMPLEMENTATION','CODE_REVIEW','EXPERIMENT','PLANNING','RESULT_ANALYSIS','OTHER']),mode:z.enum(['SINGLE','GROUP','TEAM']),leadAgentId:id.nullable(),participantIds:z.array(id),acceptanceCriteria:text(12000),revision:z.number().int().nonnegative(),status:z.enum(['DRAFT','READY','CANCELED']),removedAt:timestamp.optional(),blockers:z.array(z.object({code:text(100),message:text(1000),action:text(200)}).strict()),delegation:z.boolean(),createdAt:timestamp,updatedAt:timestamp,sourceRequestId:id.optional(),
  pipeline:z.object({kind:z.enum(['PLANNING','RESULT_ANALYSIS']),specHash:hash.nullable(),phase:z.enum(['BRIEFING','LAUNCHED','AWAITING_DECISION','DECIDED']),briefAssignmentId:id.nullable(),
    pendingDecision:z.object({specHash:hash,headAssignmentId:id,headReceiptHash:hash}).strict().optional(),
    decision:z.object({decision:z.enum(['APPROVE','REVISE','REJECT']),note:text(4000).nullable(),specHash:hash,headReceiptHash:hash,decidedAt:timestamp}).strict().optional()}).strict().optional(),
  pipelineNotes:z.array(z.object({id,text:text(4000),createdAt:timestamp}).strict()).max(64).optional()}).strict();
const memoryAuthorSchema=z.object({surface:z.enum(['AGENT_SESSION','OFFICE','USER']),agentId:id.optional(),receiptHash:hash.optional()}).strict();
const providerEnum=z.enum(['openai','claude','devin']);
/** Defence in depth: durable records must never carry provider secrets, even in free-text fields. */
const secretFree=(maximum:number)=>text(maximum).refine(value=>!/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9._-]{16,})/.test(value),'Durable records must not contain credentials');
const findingSchema=z.object({id,projectId:id,requestId:id.nullable(),assignmentId:id.nullable(),kind:findingKindSchema,title:title,body:secretFree(4000),evidenceRefs:z.array(findingRefSchema).max(32),createdBy:memoryAuthorSchema,createdAt:timestamp,supersededById:id.nullable().optional()}).strict();
const relationshipSchema=z.object({id,projectId:id,fromFindingId:id,toFindingId:id,kind:relationshipKindSchema,note:secretFree(1000).nullable(),status:z.enum(['PROPOSED','CONFIRMED','REFUTED']),createdBy:memoryAuthorSchema,createdAt:timestamp,decidedAt:timestamp.optional()}).strict();
const usageWindowSchema=z.object({label:secretFree(200),remainingPercent:z.number().min(0).max(100),resetsAt:z.number().int().nonnegative()}).strict();
const connectionSchema=z.object({id,provider:providerEnum,identity:secretFree(320),credentialContext:secretFree(200),state:z.enum(['SIGNED_IN','SIGNED_OUT','UNKNOWN']),allowance:z.array(usageWindowSchema).max(32),note:secretFree(2000),revision:z.number().int().nonnegative(),firstSeenAt:timestamp,lastCheckedAt:timestamp,sequence:z.number().int().positive().optional()}).strict();
const capabilityModelSchema=z.object({id:secretFree(160),name:secretFree(200),efforts:z.array(effortSchema).max(16).optional(),defaultEffort:effortSchema.optional(),effortDescriptions:z.array(z.object({effort:effortSchema,description:secretFree(2000)}).strict()).max(16).optional(),family:secretFree(160).optional(),effort:effortSchema.optional(),source:secretFree(2000).optional()}).strict();
// 'CLOUD_CANCEL' is retained only so older recorded events still replay; new evidence uses the request/acknowledgement pair.
const routeEnum=z.enum(['FAKE_ADAPTER','OFFICIAL_TERMINAL_HANDOFF','OFFICIAL_CLI_PTY','LOCAL_MAILBOX','LOCAL_CLI_EXEC','LOCAL_ACP']);
const operationEnum=z.enum(['ACCOUNT_STATUS','MODEL_CATALOG','ALLOWANCE_READ','CLOUD_SUBMIT','CLOUD_OBSERVE','CLOUD_FOLLOW_UP','CLOUD_OUTPUT_FETCH','CLOUD_CANCEL_REQUEST','CLOUD_CANCEL_ACK','MODEL_APPLICATION','EFFORT_APPLICATION','ENVIRONMENT_IDENTITY','DELEGATION_CONTROL','TOOL_CONFINEMENT','CLOUD_CANCEL','LOCAL_SUBMIT','LOCAL_OBSERVE','LOCAL_OUTPUT_FETCH','LOCAL_CANCEL','LOCAL_RETIRE']);
const evidenceSchema=z.object({operation:operationEnum,level:z.enum(['DOCUMENTED','TOOL_SUPPORTED','ACCOUNT_VERIFIED','UNAVAILABLE','UNKNOWN']),detail:secretFree(1000),evidence:z.enum(['OBSERVED','DOCUMENTED']).optional(),verifiedAt:timestamp.optional(),model:secretFree(160).optional(),environment:secretFree(200).optional(),effort:effortSchema.optional(),delegation:z.boolean().optional(),route:routeEnum.optional(),confinement:z.object({tools:secretFree(400),filesystem:secretFree(400),network:secretFree(400),environment:secretFree(400)}).strict().optional(),source:secretFree(1000).optional()}).strict()
  // Only an operation that was actually exercised may claim account verification.
  .refine(value=>value.level!=='ACCOUNT_VERIFIED'||value.evidence==='OBSERVED','Account-verified evidence must come from an observed operation');
const capabilitySchema=z.object({id,provider:providerEnum,connectionId:id,identity:secretFree(320),toolVersion:secretFree(120),transport:z.enum(['NONE','OFFICIAL_CLI_PIPE','OFFICIAL_CLI_TERMINAL','LOCAL_MAILBOX','LOCAL_CLI_EXEC','LOCAL_ACP']),environment:secretFree(200),models:z.array(capabilityModelSchema).max(512),operations:z.array(evidenceSchema).max(64),source:secretFree(1000),contentHash:hash,observedAt:timestamp}).strict();
export const observationSchema=connectionSchema.omit({id:true,revision:true,firstSeenAt:true,lastCheckedAt:true})
  .merge(capabilitySchema.pick({toolVersion:true,transport:true,environment:true,models:true,operations:true,source:true}))
  .extend({observedAt:timestamp}).strict();
/**
 * Office-observed evidence about a local transport, bound to the durable connection it was taken
 * under. The caller names the connection, the route and the scope the batch ran under; the provider,
 * identity, tool version and catalog are always taken from the recorded account, never from input.
 */
const transportEvidenceSchema=z.object({connectionId:id,route:routeEnum,environment:secretFree(200),model:secretFree(160).optional(),effort:effortSchema.optional(),delegation:z.boolean().optional(),operations:z.array(evidenceSchema).min(1).max(64),source:secretFree(1000),observedAt:timestamp}).strict();
const relativePath=z.string().min(1).max(1000)
  .refine(value=>!/^([a-zA-Z]:|[\\/])/.test(value),'Selected files are recorded relative to the project folder')
  .refine(value=>!value.split(/[\\/]/).some(part=>part==='..'||part==='.'||part===''),'Selected file paths cannot traverse directories')
  .refine(value=>!/[\x00-\x1f]/.test(value),'Selected file paths cannot contain control characters');
const locationSchema=z.object({id,projectId:id,localFolder:text(32000),inputPaths:z.array(relativePath).max(2000),outputFolder:text(32000),
  sourceRepository:text(32000),snapshotRoute:z.enum(['SELECTED_FILES_GIT_SNAPSHOT','PROJECT_FOLDER_SNAPSHOT']),
  providerTarget:z.object({provider:providerEnum,host:z.enum(['ANTHROPIC_MANAGED','LOCAL_MACHINE']),selection:z.literal('PROVIDER_DEFAULT'),environmentId:secretFree(200),resolved:z.boolean()}).strict(),
  legacyNote:text(1000),revision:z.number().int().nonnegative(),createdAt:timestamp,updatedAt:timestamp}).strict();
const snapshotSchema=z.object({objectsStored:z.literal(true).optional(),id,projectId:id,requestId:id.nullable(),locationRevision:z.number().int().nonnegative(),requestRevision:z.number().int().nonnegative().nullable(),
  route:z.enum(['SELECTED_FILES_GIT_SNAPSHOT','PROJECT_FOLDER_SNAPSHOT','GENERATED_REQUEST_ONLY']),
  files:z.array(z.object({path:relativePath,bytes:z.number().int().min(0),sha256:hash}).strict()).max(2000),
  generated:z.array(z.object({path:relativePath,bytes:z.number().int().min(0),sha256:hash}).strict()).max(64).optional(),
  totalBytes:z.number().int().min(0).max(64*1024*1024),manifestHash:hash,stagingCommit:z.string().regex(/^([a-f0-9]{40})?$/),stagingPath:text(32000),
  warnings:z.array(text(1000)).max(64),provenance:z.literal('OFFICE_STAGED'),createdAt:timestamp}).strict();
const jobStateEnum=z.enum(['INTENT','SUBMITTING','ACCEPTED','RUNNING','COMPLETED','FAILED','UNKNOWN','CANCEL_REQUESTED','CANCEL_ACKNOWLEDGED']);
const evidenceKindEnum=z.enum(['OFFICE_LOCAL','PROVIDER_REPORTED','USER_REPORTED']);
const assignmentSchema=z.object({research:stageContextSchema.optional(),dependsOn:z.array(id).max(64).optional(),toolProfile:toolProfileSchema.optional(),pipelineKey:z.string().trim().min(1).max(80).optional(),id,projectId:id,requestId:id,requestRevision:z.number().int().nonnegative(),agentId:id,agentRevision:z.number().int().nonnegative(),
  connectionId:id,capabilitySnapshotId:id,capabilitySnapshotIds:z.array(id).max(64).optional(),snapshotId:id,route:routeEnum,requestedModel:secretFree(160),resolvedModel:secretFree(160),
  requestedEffort:effortSchema,appliedEffort:z.union([effortSchema,z.literal('UNVERIFIED')]),delegation:z.boolean(),objectiveHash:hash,
  frozen:z.object({requestName:title,objective:text(12000),acceptanceCriteria:text(12000),instructions:text(12000),
    model:secretFree(160),effort:effortSchema,delegation:z.boolean(),
    accountIdentity:secretFree(320),credentialContext:secretFree(200),outputFolder:text(32000).optional()}).strict().optional(),
  createdAt:timestamp}).strict();
const jobOutputSchema=z.object({path:text(1000),sha256:hash,bytes:z.number().int().min(0),stored:z.literal(true).optional()}).strict();
const jobSchema=z.object({id,assignmentId:id,projectId:id,requestId:id,provider:providerEnum,route:routeEnum,state:jobStateEnum,evidence:evidenceKindEnum,
  detail:secretFree(2000),externalId:secretFree(200),externalUrl:secretFree(2000),outputs:z.array(jobOutputSchema).max(256),
  revision:z.number().int().nonnegative(),createdAt:timestamp,updatedAt:timestamp,dispatchedAt:z.union([timestamp,z.literal('')]),settledAt:z.union([timestamp,z.literal('')])}).strict();
const jobEventSchema=z.object({id,jobId:id,externalId:z.string().min(1).max(200),cursor:z.string().max(200),kind:z.enum(['STATUS','MESSAGE','TOOL','OUTPUT']),
  text:secretFree(64000),occurredAt:timestamp,receivedAt:timestamp,evidence:evidenceKindEnum,applied:appliedReportPayloadSchema.optional()}).strict();
const roleSlotSchema=z.object({role,count:z.number().int().min(1).max(64)}).strict();
const teamSchema=z.object({id,projectId:id.nullable(),name:title,revision:z.number().int().nonnegative(),archived:z.boolean(),createdAt:timestamp,updatedAt:timestamp}).strict();
const membershipSchema=z.object({id,teamId:id,agentId:id,role,createdAt:timestamp,removedAt:timestamp.optional()}).strict();
const probeSchema=z.object({id,provider:providerEnum,connectionId:id,identity:secretFree(320),credentialContext:secretFree(200),
  toolVersion:secretFree(100),environment:secretFree(200),route:routeEnum,model:secretFree(160),
  state:z.enum(['INTENT','ACCEPTED','UNKNOWN','REFUSED','RECONCILED']),externalId:secretFree(200),externalUrl:secretFree(2000),
  detail:secretFree(1000),failureCode:secretFree(100),stagingPath:text(32000),snapshotId:id,
  startedAt:timestamp,settledAt:z.string().max(40)}).strict();
const branchSchema=z.object({id,projectId:id,name:title,parentBranchId:id.nullable(),lineageId:id,stage:stageEnum,outcome:outcomeEnum,
  specId:id.nullable(),predictionId:id.nullable(),revision:z.number().int().nonnegative(),createdAt:timestamp,updatedAt:timestamp,
  retiredAt:timestamp.optional(),retiredReason:text(2000).optional()}).strict();
const specSchema=z.object({id,branchId:id,
  sections:z.object({estimand:text(12000),splitPlan:text(12000),searchPlan:text(12000),costContract:text(12000),
    portfolioContract:text(12000),metricsAndGates:text(12000),holdoutPolicy:text(12000)}).strict(),
  thresholds:z.array(z.object({gate:gateEnum,rule:text(2000)}).strict()).max(64),
  notApplicable:z.array(z.object({gate:gateEnum,rationale:text(2000)}).strict()).max(32),
  gateEvidence:z.array(z.object({gate:gateEnum,tier:z.literal('SIGNED_HARNESS')}).strict()).max(32).optional(),
  maxSelectionTrials:z.number().int().min(0).max(100000),
  frozen:z.boolean(),contentHash:hash,createdAt:timestamp,frozenAt:z.string().max(40)}).strict();
const predictionSchema=z.object({id,branchId:id,specId:id,outcomeName:title,sign:z.enum(['POSITIVE','NEGATIVE','NONE']),
  expectedLow:z.number(),expectedHigh:z.number(),probability:z.number().min(0).max(1),
  falsifiers:z.array(text(2000)).max(32),existingKnowledge:text(12000),retrospective:z.boolean(),createdAt:timestamp}).strict();
const trialSchema=z.object({id,lineageId:id,branchId:id,kind:z.enum(['VARIANT','METADATA_RETRY','FOLLOW_UP']),
  variantHash:hash,description:text(4000),outcome:z.enum(['PENDING','COMPLETED','FAILED','CANCELED','PRUNED']),
  createdAt:timestamp,settledAt:z.string().max(40)}).strict();
const attemptSchema=z.object({id,branchId:id,stage:stageEnum,assignmentId:id.nullable(),trialId:id.nullable(),
  state:z.enum(['OPEN','COMPLETED','ABANDONED']),summary:text(4000),createdAt:timestamp,settledAt:z.string().max(40)}).strict();
/**
 * A profile bound to a named scientific function at one stage.
 *
 * Appended, never edited: a function is a responsibility, and rewriting who held it would change
 * what a past review meant. Re-assigning appends a new row and marks the previous one superseded.
 */
const functionAssignmentSchema=z.object({id,projectId:id,stage:stageEnum,
  function:z.enum(['PRINCIPAL','CORRECTNESS_REVIEWER','ADVOCATE','SKEPTIC','CUSTODIAN','DIRECTOR']),
  agentId:id,agentRevision:z.number().int().nonnegative(),appendedAt:timestamp,supersededById:id.nullable(),
  origin:z.enum(['EXPLICIT','MIGRATED_FROM_ROLE']),note:text(2000)}).strict();
const receiptSchema=z.object({id,branchId:id,stage:stageEnum,gate:gateEnum,
  outcome:z.enum(['PASS','FAIL','NOT_APPLICABLE','BLOCKED']),subjectHash:hash,specId:id,
  detail:text(4000),rationale:text(4000),evidenceRef:text(2000),
  provenance:z.enum(['OFFICE','REVIEWER_ASSERTED','USER_RUN','SIGNED_HARNESS']).optional(),createdAt:timestamp}).strict();
const grantSchema=z.object({id,requestId:id,projectId:id,agentId:id,capacity:z.enum(['REVIEW','WORKER','DIRECTOR','DELEGATE']),grantedAt:timestamp,revokedAt:timestamp.optional()}).strict();
const messageSchema=z.object({id,projectId:id,requestId:id,assignmentId:id.nullable(),fromAgentId:id,toAgentId:id,
  kind:z.enum(['HANDOFF','QUESTION','ANSWER','REVIEW_REQUEST','REVIEW_RESULT']),body:secretFree(64000),
  scopeSnapshotId:id.nullable(),scopeOutputHashes:z.array(hash).max(256),sentAt:timestamp,
  deliveredAt:z.union([timestamp,z.literal('')]),receipt:secretFree(1000),evidence:evidenceKindEnum}).strict();
const decisionSchema=z.object({id,projectId:id,requestId:id,requestRevision:z.number().int().nonnegative(),
  subjectAssignmentId:id,subjectAgentId:id,reviewerAssignmentId:id,reviewerAgentId:id,inputSnapshotId:id,
  outputHashes:z.array(hash).max(256),bundleHash:hash,phase:z.enum(['FIRST','REBUTTAL']),
  verdict:z.enum(['APPROVED','REJECTED','CHANGES_REQUESTED']),rationale:secretFree(12000),
  /** How independent this review may honestly be called. Absent on decisions recorded before C4. */
  independence:z.enum(['VERIFIED_INDEPENDENT','SEPARATE_SESSION_UNVERIFIED']).optional(),
  independenceDetail:text(1000).optional(),createdAt:timestamp}).strict();
/**
 * One first report, recorded by identity before anyone may read it.
 *
 * A first report read early stops being an independent opinion and becomes the other reviewers'
 * starting point, so the round opens only when every expected report is in. Sealing records the
 * content hash at the time of sealing, which is what makes an edit between sealing and opening
 * visible rather than merely unlikely.
 */
const sealedReportSchema=z.object({id,projectId:id,subjectAssignmentId:id.nullable(),reviewerAgentId:id,
  phase:z.literal('FIRST'),contentHash:hash,sealedAt:timestamp,openedAt:timestamp.nullable()}).strict();
const changeSchema = z.discriminatedUnion('collection', [
  z.object({collection:z.literal('pipeline'),value:pipelineRecordSchema}).strict(),
  z.object({collection:z.literal('evidence'),value:evidenceRecordSchema}).strict(),
  z.object({collection:z.literal('teams'),value:teamSchema}).strict(),
  z.object({collection:z.literal('memberships'),value:membershipSchema}).strict(),
  z.object({collection:z.literal('grants'),value:grantSchema}).strict(),
  z.object({collection:z.literal('probes'),value:probeSchema}).strict(),
  z.object({collection:z.literal('branches'),value:branchSchema}).strict(),
  z.object({collection:z.literal('specs'),value:specSchema}).strict(),
  z.object({collection:z.literal('predictions'),value:predictionSchema}).strict(),
  z.object({collection:z.literal('trials'),value:trialSchema}).strict(),
  z.object({collection:z.literal('attempts'),value:attemptSchema}).strict(),
  z.object({collection:z.literal('receipts'),value:receiptSchema}).strict(),
  z.object({collection:z.literal('functions'),value:functionAssignmentSchema}).strict(),
  z.object({collection:z.literal('sealed'),value:sealedReportSchema}).strict(),
  z.object({collection:z.literal('messages'),value:messageSchema}).strict(),
  z.object({collection:z.literal('decisions'),value:decisionSchema}).strict(),
  z.object({collection:z.literal('assignments'),value:assignmentSchema}).strict(),
  z.object({collection:z.literal('jobs'),value:jobSchema}).strict(),
  z.object({collection:z.literal('jobEvents'),value:jobEventSchema}).strict(),
  z.object({collection:z.literal('localSessions'),value:localSessionRecordSchema}).strict(),
  z.object({collection:z.literal('localOps'),value:localSessionJournalSchema}).strict(),
  z.object({collection:z.literal('locations'),value:locationSchema}).strict(),
  z.object({collection:z.literal('snapshots'),value:snapshotSchema}).strict(),
  z.object({collection:z.literal('requests'),value:requestSchema}).strict(),
  z.object({collection:z.literal('connections'),value:connectionSchema}).strict(),
  z.object({collection:z.literal('capabilities'),value:capabilitySchema}).strict(),
  z.object({ collection: z.literal('workLogs'), value: logSchema }).strict(),
  z.object({ collection: z.literal('agents'), value: agentSchema }).strict(),
  z.object({ collection: z.literal('projects'), value: projectSchema }).strict(),
  z.object({ collection: z.literal('experiments'), value: experimentSchema }).strict(),
  z.object({ collection: z.literal('tasks'), value: taskSchema }).strict(),
  z.object({ collection: z.literal('artifacts'), value: artifactSchema }).strict(),
  z.object({ collection: z.literal('findings'), value: findingSchema }).strict(),
  z.object({ collection: z.literal('relationships'), value: relationshipSchema }).strict(),
  z.object({ collection: z.literal('settings'), value: settingsSchema }).strict(),
]);
type Change = z.infer<typeof changeSchema>;
const eventSchema = z.object({ sequence: z.number().int().positive(), id, kind: text(100), projectId: id.nullable(), experimentId: id.nullable(), actor: z.literal('USER'), reason: text(4000), createdAt: timestamp, previousHash: hash, hash, payload: z.object({ command: commandSchema.nullable(), changes: z.array(changeSchema) }).strict() }).strict();
type StoredEvent = z.infer<typeof eventSchema>;
type Projection = Pick<AppState, 'projects' | 'experiments' | 'tasks' | 'artifacts' | 'settings'> & { pipeline?: PipelineRecord[]; evidence?: EvidenceRecord[]; requests?: Request[]; teams?: Team[]; memberships?: TeamMembership[]; messages?: Message[]; decisions?: ReviewDecision[]; grants?: RequestGrant[]; probes?: ProbeAttempt[]; branches?: ResearchBranch[]; specs?: FrozenResearchSpec[]; predictions?: PredictionRecord[]; trials?: TrialLedgerEntry[]; attempts?: StageAttempt[]; receipts?: GateReceipt[]; functions?: FunctionAssignment[]; sealed?: SealedReviewReport[]; locations?: ProjectLocation[]; snapshots?: InputSnapshot[]; assignments?: Assignment[]; jobs?: ProviderJob[]; jobEvents?: JobEvent[]; localSessions?: LocalSessionRecord[]; localOps?: LocalSessionJournal[]; connections?: AccountConnection[]; capabilities?: ProviderCapabilitySnapshot[]; agents?: Agent[]; workLogs?: WorkLog[]; findings?: MemoryFinding[]; relationships?: MemoryRelationship[] };
function blank(): Projection { return { projects: [], experiments: [], tasks: [], artifacts: [], settings: { theme: 'dark', reducedMotion: false, globalBudgetCents: 0 } }; }
function emptyContract(): ResearchContract { return { objective: '', dataPolicy: '', modelFamilies: '', evaluation: '', economics: '', protectedRegions: '', requiredChecks: '', limitations: '' }; }
function applyChanges(current: Projection, changes: Change[]): Projection {
  const next = structuredClone(current);
  const indexes=new Map<string,Map<string,number>>();
  for (const change of changes) {
    if (change.collection === 'settings') next.settings = { ...change.value };
    else {
      if (change.collection === 'requests' && !next.requests) next.requests = [];
      if (change.collection === 'pipeline' && !next.pipeline) next.pipeline = [];
      if (change.collection === 'evidence' && !next.evidence) next.evidence = [];
      if (change.collection === 'locations' && !next.locations) next.locations = [];
      if (change.collection === 'assignments' && !next.assignments) next.assignments = [];
      if (change.collection === 'teams' && !next.teams) next.teams = [];
      if (change.collection === 'memberships' && !next.memberships) next.memberships = [];
      if (change.collection === 'grants' && !next.grants) next.grants = [];
      if (change.collection === 'probes' && !next.probes) next.probes = [];
      if (change.collection === 'branches' && !next.branches) next.branches = [];
      if (change.collection === 'specs' && !next.specs) next.specs = [];
      if (change.collection === 'predictions' && !next.predictions) next.predictions = [];
      if (change.collection === 'trials' && !next.trials) next.trials = [];
      if (change.collection === 'attempts' && !next.attempts) next.attempts = [];
      if (change.collection === 'receipts' && !next.receipts) next.receipts = [];
      if (change.collection === 'functions' && !next.functions) next.functions = [];
      if (change.collection === 'sealed' && !next.sealed) next.sealed = [];
      if (change.collection === 'messages' && !next.messages) next.messages = [];
      if (change.collection === 'decisions' && !next.decisions) next.decisions = [];
      if (change.collection === 'jobs' && !next.jobs) next.jobs = [];
      if (change.collection === 'jobEvents' && !next.jobEvents) next.jobEvents = [];
      if (change.collection === 'localSessions' && !next.localSessions) next.localSessions = [];
      if (change.collection === 'localOps' && !next.localOps) next.localOps = [];
      if (change.collection === 'snapshots' && !next.snapshots) next.snapshots = [];
      if (change.collection === 'connections' && !next.connections) next.connections = [];
      if (change.collection === 'capabilities' && !next.capabilities) next.capabilities = [];
      if (change.collection === 'workLogs' && !next.workLogs) next.workLogs = [];
      if (change.collection === 'findings' && !next.findings) next.findings = [];
      if (change.collection === 'relationships' && !next.relationships) next.relationships = [];
      if (change.collection === 'agents' && !next.agents) next.agents = [];
      const items = next[change.collection] as Array<Project | Experiment | ResearchTask | Artifact | Agent | WorkLog | Request | AccountConnection | ProviderCapabilitySnapshot | ProjectLocation | InputSnapshot | Assignment | ProviderJob | JobEvent | LocalSessionRecord | LocalSessionJournal | Team | TeamMembership | Message | ReviewDecision | RequestGrant | ProbeAttempt | ResearchBranch | FrozenResearchSpec | PredictionRecord | TrialLedgerEntry | StageAttempt | GateReceipt | FunctionAssignment | SealedReviewReport | PipelineRecord | EvidenceRecord | MemoryFinding | MemoryRelationship>;
      let lookup=indexes.get(change.collection);if(!lookup){lookup=new Map(items.map((item,i)=>[item.id,i]));indexes.set(change.collection,lookup);}
      const index = lookup.get(change.value.id) ?? -1;
      if (['pipeline','evidence','artifacts','workLogs','capabilities','snapshots','assignments','jobEvents','localOps','decisions','predictions','trials','receipts'].includes(change.collection) && index >= 0) {
        const old=items[index];let lifecycle=false;
        if(change.collection==='pipeline'){
          const before=old as PipelineRecord,after=change.value;
          if(before.kind==='HARNESS_INTENT'&&after.kind==='HARNESS_INTENT')lifecycle=before.status==='OPEN'&&after.status==='COMPLETED'&&canonical({...before,status:after.status})===canonical(after);
          if(before.kind==='REVIEW_REPORT'&&after.kind==='REVIEW_REPORT')lifecycle=!before.opened&&after.opened&&canonical({...before,opened:true})===canonical(after);
          if(before.kind==='RUN_PACKAGE'&&after.kind==='RUN_PACKAGE')lifecycle=before.state==='AWAITING_RETURN'&&after.state==='RETURNED'&&!!after.returnManifestHash
            &&canonical({...before,state:'RETURNED',returnManifestHash:after.returnManifestHash})===canonical(after);
        }
        if(change.collection==='trials'){
          const before=old as TrialLedgerEntry,after=change.value;
          lifecycle=before.outcome==='PENDING'&&after.outcome!=='PENDING'&&!!after.settledAt&&canonical({...before,outcome:after.outcome,settledAt:after.settledAt})===canonical(after);
        }
        if(!lifecycle)throw new Error('Artifact identities are immutable');
      }
      if (index === -1) {lookup.set(change.value.id,items.length);items.push(structuredClone(change.value));} else items[index] = structuredClone(change.value);
    }
  }
  for (const item of [...next.experiments, ...next.tasks, ...next.artifacts, ...(next.requests??[]), ...(next.locations??[]), ...(next.snapshots??[]), ...(next.assignments??[]), ...(next.jobs??[]), ...(next.findings??[]), ...(next.relationships??[])]) {
    if (!next.projects.some(project => project.id === item.projectId)) throw new Error('Broken project ownership in projection');
    if ('experimentId' in item && item.experimentId !== null && !next.experiments.some(experiment => experiment.id === item.experimentId && experiment.projectId === item.projectId)) throw new Error('Broken experiment ownership in projection');
  }
  const participants=new Set(['USER','TOOL','SYSTEM',...(next.agents??[]).map(a=>a.id)]);
  for(const entry of next.workLogs??[])for(const participant of [entry.from,entry.to])if(!participants.has(participant))throw new Error('Unknown log participant');
  return next;
}
function publicEvent(event: StoredEvent): LineageEvent { const { payload: _payload, ...publicFields } = event; return publicFields; }

/** Every cited ref must resolve to a record the office already holds in the same project — memory anchors to stored evidence, never to outside claims. */
function assertFindingRefs(state: Projection, projectId: string, refs: FindingEvidenceRef[]): void {
  for (const ref of refs) {
    if (ref.kind === 'OBJECT') {
      if (!state.artifacts.some(item => item.projectId === projectId && item.sha256 === ref.id))
        throw new Error(`A finding cites object ${ref.id.slice(0, 12)}… which this project does not hold — evidence must already be office-stored.`);
    } else if (ref.kind === 'ASSIGNMENT') {
      if (!state.assignments?.some(item => item.id === ref.id && item.projectId === projectId))
        throw new Error('A finding cites an assignment that does not exist in this project.');
    } else if (ref.kind === 'JOB') {
      const job = state.jobs?.find(item => item.id === ref.id);
      const assignment = job && state.assignments?.find(item => item.id === job.assignmentId);
      if (!job || assignment?.projectId !== projectId)
        throw new Error('A finding cites a job that does not exist in this project.');
    } else if (!state.requests?.some(item => item.id === ref.id && item.projectId === projectId))
      throw new Error('A finding cites a request that does not exist in this project.');
  }
}

/**
 * Appends a finding and, when it supersedes an earlier one, marks the old record — append-only:
 * the superseded record stays, stamped with its replacement's id.
 */
function appendFinding(state: Projection, finding: MemoryFinding, supersedesFindingId?: string): Change[] {
  const changes: Change[] = [];
  if (supersedesFindingId) {
    const prior = state.findings?.find(item => item.id === supersedesFindingId && item.projectId === finding.projectId);
    if (!prior) throw new Error('The superseded finding does not exist in this project.');
    if (prior.supersededById) throw new Error('That finding is already superseded — chain corrections forward, never sideways.');
    changes.push({ collection: 'findings', value: { ...prior, supersededById: finding.id } });
  }
  changes.push({ collection: 'findings', value: finding });
  return changes;
}

/** Deterministic local bookkeeping only. There are deliberately no network or code-execution methods. */
export class OfficeStore {
  private readonly db: DatabaseSync;
  private closed = false;
  private researchIndexReady=false;
  private readonly researchAdmission:ResearchAdmission;
  private readonly includeHistoryInResults:boolean;

  constructor(private readonly databasePath: string, options: {repairLegacy?:boolean;researchTrust?:readonly ResearchTrustPin[];includeHistoryInResults?:boolean} = {}) {
    this.includeHistoryInResults=options.includeHistoryInResults??true;
    this.researchAdmission=new ResearchAdmission(options.researchTrust);
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error(`Unsupported database schema version ${version}; use a compatible application`);
      if (version === 0) {
        const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (existing.length) throw new Error('Unversioned existing database cannot be migrated safely');
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE events(sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, record TEXT NOT NULL);
          CREATE TABLE projection(singleton INTEGER PRIMARY KEY CHECK(singleton=1), state TEXT NOT NULL);
          CREATE TABLE commands(idempotency_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, event_sequence INTEGER NOT NULL REFERENCES events(sequence));
          CREATE TABLE outbox(event_sequence INTEGER PRIMARY KEY REFERENCES events(sequence), state TEXT NOT NULL CHECK(state IN ('PENDING','ACKNOWLEDGED')));
          CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are immutable'); END;
          CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Events are immutable'); END;
          PRAGMA user_version=1;`);
        this.db.prepare('INSERT INTO projection(singleton,state) VALUES(1,?)').run(canonical(blank()));
        this.db.exec('COMMIT');
      }
      // Derived read indexes. They hold no new facts, so they can be rebuilt from the event log at any time.
      if (version < 2) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS event_index(sequence INTEGER PRIMARY KEY REFERENCES events(sequence), kind TEXT NOT NULL, project_id TEXT, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS log_index(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL, timestamp TEXT NOT NULL, sequence INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS job_event_index(id TEXT PRIMARY KEY, job_id TEXT NOT NULL, occurred_at TEXT NOT NULL, sequence INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS event_index_project ON event_index(project_id, sequence);
          CREATE INDEX IF NOT EXISTS log_index_agent ON log_index(agent_id, timestamp, id);
          CREATE INDEX IF NOT EXISTS log_index_conversation ON log_index(conversation_id, timestamp, id);
          CREATE INDEX IF NOT EXISTS job_event_index_job ON job_event_index(job_id, occurred_at, id);
          PRAGMA user_version=2;`);
        for (const row of this.db.prepare('SELECT sequence,record FROM events ORDER BY sequence').all()) {
          this.indexEvent(JSON.parse(String(row.record)) as StoredEvent);
        }
        this.db.exec('COMMIT');
      }
      this.verifyIntegrity();
      if(version<3){
        this.db.exec('BEGIN IMMEDIATE; CREATE TABLE research_read_index(collection TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,branch_id TEXT,request_id TEXT,from_id TEXT,to_id TEXT,sequence INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(collection,id)); CREATE INDEX research_read_scope ON research_read_index(collection,project_id,branch_id,sequence,id); CREATE INDEX research_message_scope ON research_read_index(collection,request_id,sequence,id); PRAGMA user_version=3;');
        this.researchIndexReady=true;
        for(const row of this.db.prepare('SELECT record FROM events ORDER BY sequence').iterate()){
          const event=JSON.parse(String(row.record)) as StoredEvent;
          for(const change of event.payload.changes)this.indexResearch(change,event.sequence,event.projectId);
        }
        this.db.exec('COMMIT');
      }
      this.researchIndexReady=true;
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const oldState=this.readProjection();
      const canceled=oldState.experiments.filter(e=>e.stage!=='CANCELED'&&oldState.tasks.some(t=>t.experimentId===e.id&&t.status==='CANCELED'&&t.blocker==='Project archived')&&!oldState.tasks.some(t=>t.experimentId===e.id&&!['CANCELED','SUPERSEDED'].includes(t.status)));
      if(canceled.length&&options.repairLegacy!==false){
        if(databasePath!==':memory:')this.db.prepare('VACUUM INTO ?').run(databasePath+'.before-archive-repair-'+randomUUID()+'.sqlite');
        this.transaction(()=>this.append(oldState,canceled.map(e=>({collection:'experiments' as const,value:{...e,stage:'CANCELED' as const,revision:e.revision+1,updatedAt:new Date().toISOString()}})),{kind:'MIGRATION_ARCHIVE_LIFECYCLE',projectId:null,experimentId:null,reason:'Closed legacy research canceled by project archive; original event hashes retained.'},null));
        this.verifyIntegrity();
      }
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }

  private assertOpen(): void { if (this.closed) throw new Error('Workspace is closed'); }
  /** Maintains the derived read indexes for one event. Never a source of truth. */
  private indexEvent(event: StoredEvent): void {
    this.db.prepare('INSERT OR REPLACE INTO event_index(sequence,kind,project_id,created_at) VALUES(?,?,?,?)').run(event.sequence, event.kind, event.projectId, event.createdAt);
    for (const change of event.payload.changes) {
      if(this.researchIndexReady)this.indexResearch(change,event.sequence,event.projectId);
      if (change.collection === 'workLogs') {
        const log = change.value as z.infer<typeof logSchema>;
        for (const participant of [log.from, log.to]) {
          if (!/^[0-9a-f-]{36}$/i.test(participant)) continue;
          this.db.prepare('INSERT OR REPLACE INTO log_index(id,conversation_id,agent_id,timestamp,sequence) VALUES(?,?,?,?,?)')
            .run(`${log.id}:${participant}`, log.conversationId, participant, log.timestamp, event.sequence);
        }
      }
      if (change.collection === 'jobEvents') {
        const jobEvent = change.value as z.infer<typeof jobEventSchema>;
        this.db.prepare('INSERT OR REPLACE INTO job_event_index(id,job_id,occurred_at,sequence) VALUES(?,?,?,?)')
          .run(jobEvent.id, jobEvent.jobId, jobEvent.occurredAt, event.sequence);
      }
    }
  }
  private readProjection(): Projection {
    const row = this.db.prepare('SELECT state FROM projection WHERE singleton=1').get() as { state: string } | undefined;
    if (!row) throw new Error('Missing workspace projection');
    const parsed = JSON.parse(row.state) as Projection;
    if (canonical(parsed) !== row.state) throw new Error('Workspace projection is not canonical JSON');
    return parsed;
  }
  private allEvents(): StoredEvent[] {
    return this.db.prepare('SELECT sequence,id,record FROM events ORDER BY sequence').all().map(row => {
      const parsed = eventSchema.parse(JSON.parse(String(row.record)));
      if (canonical(parsed) !== row.record) throw new Error('Event record is not canonical JSON');
      if (parsed.sequence !== Number(row.sequence) || parsed.id !== row.id) throw new Error('Event identity integrity failure');
      return parsed;
    });
  }
  private verifyIntegrity(): void {
    const check = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (check.integrity_check !== 'ok' || this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite integrity failure');
    const triggers = this.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('events_no_update','events_no_delete')").all();
    if (triggers.length !== 2) throw new Error('Append-only event protection integrity failure');
    const events = this.allEvents();
    let previous = ZERO_HASH;
    let rebuilt = blank();
    const receiptIds = new Set<string>();
    for (const [index, event] of events.entries()) {
      const { hash: eventHash, ...body } = event;
      if (event.sequence !== index + 1 || event.previousHash !== previous || eventHash !== canonicalHash(body)) throw new Error(`Event hash chain integrity failure at sequence ${index + 1}`);
      rebuilt = applyChanges(rebuilt, event.payload.changes);
      previous = eventHash;
      if (event.payload.command) {
        const key = event.payload.command.idempotencyKey;
        if (receiptIds.has(key)) throw new Error('Duplicate idempotency key in event history');
        receiptIds.add(key);
        const receipt = this.db.prepare('SELECT payload_hash,event_sequence FROM commands WHERE idempotency_key=?').get(key);
        if (!receipt || receipt.payload_hash !== canonicalHash(event.payload.command) || Number(receipt.event_sequence) !== event.sequence) throw new Error('Command receipt integrity failure');
      }
      if (!this.db.prepare('SELECT event_sequence FROM outbox WHERE event_sequence=?').get(event.sequence)) throw new Error('Snapshot outbox integrity failure');
    }
    if (Number(this.db.prepare('SELECT COUNT(*) AS count FROM commands').get()!.count) !== receiptIds.size) throw new Error('Unexpected command receipts');
    if (canonical(rebuilt) !== canonical(this.readProjection())) throw new Error('Workspace projection integrity failure');
  }

  snapshot(options:{history?:boolean}={}): AppState {
    this.assertOpen();
    const {workLogs:_logs,evidence:_evidence,...projection}=this.readProjection();
    return { schemaVersion: 1, ...projection, reviews: [], events:options.history===false?[]:this.allEvents().map(publicEvent), agents:projection.agents??[], spend: { actualCents: 0, reservedCents: 0 } };
  }
  lineageTip():{hash:string|null;count:number}{
    const row=this.db.prepare('SELECT record FROM events ORDER BY sequence DESC LIMIT 1').get() as {record:string}|undefined;
    const count=Number((this.db.prepare('SELECT COUNT(*) AS count FROM event_index').get() as {count:number}).count);
    return {hash:row?eventSchema.parse(JSON.parse(row.record)).hash:null,count};
  }
  officeChatPage(query: OfficeChatQuery = {}) {
    return officeChatPage(this.snapshot({ history: false }), query);
  }
  static publicState(state:AppState):AppState {
    return {...state,events:[],messages:[],jobEvents:[],localSessions:[],localOps:[],trials:[],pipeline:[],
      // Gate status and stage navigation are queried for the selected research branch.
      receipts:[],sealed:[]};
  }
  private indexResearch(change:Change,sequence:number,projectId:string|null):void{
    if(!['pipeline','trials','messages'].includes(change.collection))return;
    const value=change.value as PipelineRecord|TrialLedgerEntry|Message;
    this.db.prepare('INSERT INTO research_read_index(collection,id,project_id,branch_id,request_id,from_id,to_id,sequence,record) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET record=excluded.record')
      .run(change.collection,value.id,'projectId' in value?value.projectId:projectId??this.readProjection().branches?.find(b=>b.id===value.branchId)?.projectId??'','branchId' in value?value.branchId:null,'requestId' in value?value.requestId:null,'fromAgentId' in value?value.fromAgentId:null,'toAgentId' in value?value.toAgentId:null,sequence,canonical(value));
  }
  private indexedPage<T>(scope:string,where:string,args:(string|number)[],cursor:string|undefined,requestedLimit:number|undefined):{entries:T[];nextCursor:string|null;total:number}{
    const limit=Math.min(Math.max(requestedLimit??50,1),200),parts=cursor?.split('|');
    if(parts&&(parts.length!==4||parts[0]!==scope||!/^\d+$/.test(parts[1])||!/^\d+$/.test(parts[2])||!/^[0-9a-f-]{36}$/i.test(parts[3])))throw new Error('Cursor is malformed or belongs to another scope.');
    const ceiling=parts?Number(parts[1]):Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM events').get()!.n),before=parts?Number(parts[2]):ceiling+1,beforeId=parts?.[3]??'';
    if(!Number.isSafeInteger(ceiling)||!Number.isSafeInteger(before))throw new Error('Invalid cursor sequence.');
    const total=Number(this.db.prepare('SELECT COUNT(*) AS n FROM research_read_index WHERE '+where+' AND sequence<=?').get(...args,ceiling)!.n);
    const rows=this.db.prepare('SELECT id,sequence,record FROM research_read_index WHERE '+where+' AND sequence<=? AND (sequence<? OR (sequence=? AND id<?)) ORDER BY sequence DESC,id DESC LIMIT ?').all(...args,ceiling,before,before,beforeId,limit+1);
    const visible=rows.slice(0,limit),last=visible.at(-1);
    return {entries:visible.map(r=>JSON.parse(String(r.record)) as T),total,nextCursor:rows.length>limit&&last?[scope,ceiling,last.sequence,last.id].join('|'):null};
  }
  messagePage(options:{agentId?:string;requestId?:string;cursor?:string;limit?:number}={}):{entries:Message[];nextCursor:string|null;total:number}{
    const scope=canonicalHash({agentId:options.agentId??null,requestId:options.requestId??null}),clauses=["collection='messages'"],args:string[]=[];
    if(options.agentId){clauses.push('(from_id=? OR to_id=?)');args.push(options.agentId,options.agentId);}
    if(options.requestId){clauses.push('request_id=?');args.push(options.requestId);}
    return this.indexedPage<Message>(scope,clauses.join(' AND '),args,options.cursor,options.limit);
  }
  researchPage(options:{projectId:string;branchId?:string;kind:'pipeline'|'trials';cursor?:string;limit?:number;query?:string}){
    const scope=canonicalHash({projectId:options.projectId,branchId:options.branchId??null,kind:options.kind,query:options.query??''}),clauses=['collection=?','project_id=?'],args:string[]=[options.kind,options.projectId];
    if(options.branchId){clauses.push('branch_id=?');args.push(options.branchId);}
    if(options.query){clauses.push('instr(lower(record),lower(?))>0');args.push(options.query);}
    return this.indexedPage<PipelineRecord|TrialLedgerEntry>(scope,clauses.join(' AND '),args,options.cursor,options.limit);
  }
  assertStagePreparation(branchId:string,expectedRevision:number):void{
    const state=this.readProjection(),branch=state.branches?.find(b=>b.id===branchId);
    if(!branch||branch.revision!==expectedRevision||branch.outcome!=='IN_PROGRESS')throw new Error('Stage preparation is stale or settled.');
    this.activeProject(state,branch.projectId);
    const index=STAGES.indexOf(branch.stage);
    if(index<2)return;
    const link=state.pipeline?.filter(r=>r.kind==='LINK'&&r.branchId===branch.id).at(-1);
    if(!link||link.kind!=='LINK')throw new Error('Exact candidate link is missing.');
    this.assertGateEvidence(state,{...branch,stage:STAGES[index-1]},link.subjectHash);
    for(const stage of STAGES.slice(1,index))if(!state.pipeline?.some(r=>r.kind==='STAGE_COMPLETION'&&r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash&&r.stage===stage))throw new Error('Historical stage '+stage+' lacks admitted completion. Amend the branch before continuing.');
  }
  /**
   * Per the corrected contract (section 1.6) no stage is universally blocked: the manual user-run
   * path is built in. Capability limits surface at the exact admission point that needs them — a
   * spec-declared signed gate without a trust anchor, an isolation route check, a custody path with
   * no evaluator — rather than as one blanket block.
   */
  researchStageBlocker(_stage:typeof STAGES[number]):string|null {
    return null;
  }
  verifyResearchClaim(input:unknown){return this.researchAdmission.verify(input);}
  private assertResearchClaimScope(state:Projection,claim:SignedResearchClaim['claim']):void {
    const branch=state.branches?.find(b=>b.id===claim.branchId),spec=state.specs?.find(s=>s.id===claim.specId);
    const link=state.pipeline?.filter(r=>r.kind==='LINK'&&r.branchId===claim.branchId).at(-1);
    const request=state.requests?.find(r=>r.id===claim.requestId);
    if(!branch||branch.projectId!==claim.projectId||branch.revision!==claim.branchRevision||branch.specId!==claim.specId||branch.stage!==claim.stage
      ||branch.outcome!=='IN_PROGRESS'||!spec?.frozen||spec.contentHash!==claim.specHash||!link||link.kind!=='LINK'
      ||link.subjectHash!==claim.subjectHash||link.requestId!==claim.requestId||link.requestRevision!==claim.requestRevision
      ||!request||request.revision!==claim.requestRevision||request.status==='CANCELED')throw new Error('Independent receipt scope is stale or belongs to different research.');
    this.activeProject(state,claim.projectId);
  }
  /**
   * A review round's context contract, whichever tier produced it.
   *
   * SIGNED rounds carry an independently signed ISOLATION claim; SEPARATED rounds carry the same
   * bindings recorded by the office (the controller-enforced pilot tier). Every consumer — launch,
   * report admission, rebuttal, adjudication — resolves through this one shape so the checks the
   * two tiers share (context membership, object inventory, scope, expiry) run identically.
   */
  private reviewRound(state:Projection,roundId:string){
    const signed=state.pipeline?.find(r=>r.id===roundId&&r.kind==='REVIEW_ROUND');
    if(signed&&signed.kind==='REVIEW_ROUND'){
      const verified=this.researchAdmission.verify(signed.proof),claim=verified.signed.claim;
      if(claim.kind!=='ISOLATION')throw new Error('Review round proof is not an isolation claim.');
      this.assertResearchClaimScope(state,claim);
      return {source:'SIGNED' as const,roundId:claim.roundId,stage:claim.stage,contexts:claim.contexts,objectHashes:claim.objectHashes,
        subjectAssignmentId:claim.subjectAssignmentId as string|null,correctnessBlinded:claim.correctnessBlinded,expiresAt:claim.expiresAt,
        route:claim.route,verification:verified.environment as 'LOCAL_FIXTURE'|'HOSTED',subjectHash:claim.subjectHash,specId:claim.specId,branchRevision:claim.branchRevision};
    }
    const separated=state.pipeline?.find(r=>r.id===roundId&&r.kind==='SEPARATED_REVIEW');
    if(!separated||separated.kind!=='SEPARATED_REVIEW')return null;
    const branch=state.branches?.find(b=>b.id===separated.branchId),spec=state.specs?.find(s=>s.id===separated.specId);
    const link=state.pipeline?.filter(r=>r.kind==='LINK'&&r.branchId===separated.branchId).at(-1);
    const request=state.requests?.find(r=>r.id===separated.requestId);
    if(!branch||branch.projectId!==separated.projectId||branch.revision!==separated.branchRevision||branch.specId!==separated.specId||branch.stage!==separated.stage
      ||branch.outcome!=='IN_PROGRESS'||!spec?.frozen||spec.contentHash!==separated.specHash||!link||link.kind!=='LINK'
      ||link.subjectHash!==separated.subjectHash||link.requestId!==separated.requestId||link.requestRevision!==separated.requestRevision
      ||!request||request.revision!==separated.requestRevision||request.status==='CANCELED')throw new Error('Separated review round scope is stale or belongs to different research.');
    return {source:'SEPARATED' as const,roundId:separated.id,stage:separated.stage,contexts:separated.contexts,objectHashes:separated.objectHashes,
      subjectAssignmentId:separated.subjectAssignmentId,correctnessBlinded:separated.correctnessBlinded,expiresAt:separated.expiresAt,
      route:null as string|null,verification:'SEPARATED' as const,subjectHash:separated.subjectHash,specId:separated.specId,branchRevision:separated.branchRevision};
  }
  private isolatedResearchContext(state:Projection,assignment:Assignment){
    const research=assignment.research;
    if(!research||!['S2','S7'].includes(research.stage))return null;
    const round=this.reviewRound(state,research.reviewRoundId??'');
    if(!round)throw new Error('Review assignment requires a frozen review round.');
    if(Date.parse(round.expiresAt)<=Date.now()||!round.contexts.some(c=>c.agentId===assignment.agentId&&c.snapshotId===assignment.snapshotId&&c.contextId===research.isolatedContextId)
      ||canonical([...round.objectHashes].sort())!==canonical([...research.objectHashes].sort()))throw new Error('Review context or disclosure inventory differs from its frozen round record.');
    return round;
  }
  assertIsolatedLaunch(assignmentId:string,route:string):void {
    const state=this.readProjection(),assignment=state.assignments?.find(a=>a.id===assignmentId);
    if(!assignment)throw new Error('Assignment not found.');
    const round=this.isolatedResearchContext(state,assignment);
    // A signed isolation claim names the route that may carry it; a separated round's context is a
    // document the user carries, so no provider route constraint applies to it.
    if(round&&round.source==='SIGNED'&&round.route!==route)throw new Error('The provider route cannot deliver this isolated context.');
  }
  /**
   * Every reached stage's gates must hold a passing receipt for this exact subject. A gate the
   * frozen spec declares `SIGNED_HARNESS` additionally requires the independently signed receipt —
   * the stronger evidence tier is per-gate declared, not universal (section 1.6).
   */
  private assertGateEvidence(state:Projection,branch:ResearchBranch,subjectHash:string):void {
    const spec=state.specs?.find(s=>s.id===branch.specId);
    const signed=new Set((spec?.gateEvidence??[]).filter(g=>g.tier==='SIGNED_HARNESS').map(g=>g.gate));
    for(const gate of new Set(STAGES.slice(0,STAGES.indexOf(branch.stage)+1).flatMap(s=>STAGE_GATES[s]))){
      if(gate==='G-SPEC')continue;
      const receipt=(state.receipts??[]).filter(r=>r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===subjectHash&&r.gate===gate).at(-1);
      if(!receipt||!['PASS','NOT_APPLICABLE'].includes(receipt.outcome))throw new Error(gate+' has no passing admitted evidence.');
      if(!signed.has(gate))continue;
      const proof=(state.pipeline??[]).find(r=>r.kind==='HARNESS_RECEIPT'&&r.proof.claim.kind==='HARNESS'&&r.proof.claim.branchId===branch.id
        &&r.proof.claim.specId===branch.specId&&r.proof.claim.subjectHash===subjectHash&&r.proof.claim.reportHash===receipt.evidenceRef
        &&r.proof.claim.gates.some(g=>g.gate===gate&&g.outcome===receipt.outcome&&g.detail===receipt.detail&&g.rationale===receipt.rationale));
      if(!proof||proof.kind!=='HARNESS_RECEIPT')throw new Error(gate+' is declared signed-harness evidence by the frozen specification and has no independently admitted harness receipt.');
      this.researchAdmission.verify(proof.proof);
    }
  }
  adjudicateResearch(input:{branchId:string;expectedRevision:number;followUp:boolean}):AppState {
    return this.transaction(()=>{
      const state=this.readProjection(),branch=state.branches?.find(b=>b.id===input.branchId);
      if(!branch||branch.revision!==input.expectedRevision||branch.stage!=='S7')throw new Error('Adjudication belongs to S7 and requires its current branch revision.');
      this.activeProject(state,branch.projectId);
      const roundRecord=(state.pipeline??[]).find(r=>(r.kind==='REVIEW_ROUND'&&r.proof.claim.branchId===branch.id&&r.proof.claim.branchRevision===branch.revision)
        ||(r.kind==='SEPARATED_REVIEW'&&r.branchId===branch.id&&r.branchRevision===branch.revision));
      if(!roundRecord)throw new Error('No exact S7 review round exists.');
      const claim=this.reviewRound(state,roundRecord.id);
      if(!claim)throw new Error('No exact S7 review round exists.');
      const prior=state.pipeline?.find(r=>r.kind==='ADJUDICATION'&&r.roundId===roundRecord.id);
      if(prior)return;
      const reports=(state.pipeline??[]).filter((r):r is Extract<PipelineRecord,{kind:'REVIEW_REPORT'}>=>r.kind==='REVIEW_REPORT'&&r.roundId===roundRecord.id&&r.opened);
      const get=(role:string)=>reports.find(r=>state.assignments?.find(a=>a.id===r.assignmentId)?.research?.function===role);
      const advocate=get('ADVOCATE'),skeptic=get('SKEPTIC');
      if(!advocate||!skeptic||reports.length!==2)throw new Error('Both immutable first reports from this exact round are required.');
      const outcome=adjudicate({records:state,branch,subjectHash:claim.subjectHash,advocate,skeptic,requestedFollowUp:input.followUp});
      if(outcome.outcome==='UPHELD'||outcome.outcome==='FOLLOW_UP_GRANTED')this.assertGateEvidence(state,branch,claim.subjectHash);
      const decision=outcome.outcome==='UPHELD'?'PROMOTE':outcome.outcome==='FOLLOW_UP_GRANTED'?'DECISIVE_TEST'
        :advocate.verdict==='OPPOSES'&&skeptic.verdict==='OPPOSES'?'RETIRE':'INCONCLUSIVE';
      const now=new Date().toISOString(),changes:Change[]=[{collection:'pipeline',value:{id:randomUUID(),kind:'ADJUDICATION',roundId:roundRecord.id,decision,projectId:branch.projectId,branchId:branch.id,
        createdAt:now,subjectHash:claim.subjectHash,specId:claim.specId,outcome:outcome.outcome,reportIds:[advocate.id,skeptic.id],detail:outcome.detail}}];
      if(outcome.outcome==='LINEAGE_SUSPENDED'){
        for(const affected of state.branches??[])if(affected.lineageId===branch.lineageId&&affected.outcome!=='RETIRED')changes.push({collection:'branches',value:{...affected,outcome:'SUSPENDED',revision:affected.revision+1,updatedAt:now}});
      }else if(outcome.outcome==='FOLLOW_UP_GRANTED'){
        if((state.trials??[]).some(t=>t.lineageId===branch.lineageId&&t.kind==='FOLLOW_UP'))throw new Error('The lineage already consumed its scientific follow-up.');
        changes.push({collection:'branches',value:{...branch,outcome:'INCONCLUSIVE',revision:branch.revision+1,updatedAt:now}});
      }else if(decision!=='PROMOTE')changes.push({collection:'branches',value:{...branch,outcome:decision==='RETIRE'?'RETIRED':'INCONCLUSIVE',revision:branch.revision+1,updatedAt:now,
        ...(decision==='RETIRE'?{retiredAt:now,retiredReason:outcome.detail}:{})}});
      for(const trial of state.trials??[])if(trial.branchId===branch.id&&trial.variantHash===claim.subjectHash&&trial.outcome==='PENDING')
        changes.push({collection:'trials',value:{...trial,outcome:outcome.outcome==='LINEAGE_SUSPENDED'?'FAILED':'COMPLETED',settledAt:now}});
      this.append(state,changes,{kind:'RESEARCH_ADJUDICATED',projectId:branch.projectId,experimentId:null,reason:outcome.detail},null);
    });
  }
  beginRebuttal(assignmentId:string):{operationId:string;existing:boolean;firstReportHashes:string[]}{
    let result={operationId:'',existing:false,firstReportHashes:[] as string[]};
    this.transaction(()=>{
      const state=this.readProjection(),assignment=state.assignments?.find(a=>a.id===assignmentId);
      if(!assignment?.research?.reviewRoundId||assignment.research.stage!=='S7')throw new Error('Rebuttal belongs to an exact S7 reviewer context.');
      this.isolatedResearchContext(state,assignment);
      const reports=(state.pipeline??[]).filter((r):r is Extract<PipelineRecord,{kind:'REVIEW_REPORT'}>=>r.kind==='REVIEW_REPORT'&&r.roundId===assignment.research!.reviewRoundId);
      if(reports.length!==2||reports.some(r=>!r.opened))throw new Error('Both first reports must be immutable before rebuttal disclosure.');
      if(state.pipeline?.some(r=>r.kind==='ADJUDICATION'&&r.roundId===assignment.research!.reviewRoundId))throw new Error('The round is already adjudicated.');
      const hashes=reports.map(r=>r.reportHash).sort(),prior=state.pipeline?.find(r=>r.kind==='REBUTTAL_INTENT'&&r.assignmentId===assignmentId);
      if(prior){result={operationId:prior.id,existing:true,firstReportHashes:hashes};return;}
      const record=pipelineRecordSchema.parse({id:randomUUID(),kind:'REBUTTAL_INTENT',projectId:assignment.projectId,branchId:assignment.research.branchId,createdAt:new Date().toISOString(),roundId:assignment.research.reviewRoundId,assignmentId,firstReportHashes:hashes});
      this.append(state,[{collection:'pipeline',value:record}],{kind:'REBUTTAL_INTENT',projectId:assignment.projectId,experimentId:null,reason:'Authorized one bounded post-disclosure response in the original isolated reviewer context.'},null);
      result={operationId:record.id,existing:false,firstReportHashes:hashes};
    });
    return result;
  }
  /**
   * A signed REBUTTAL claim binds operation, reports and context with independent attestation. The
   * separated pilot tier carries no signature: the same bindings are enforced against the office's
   * frozen intent and round record, and the record stores `proof:null` so the evidence label stays
   * honest.
   */
  recordResearchRebuttal(input:{assignmentId:string;reportHash:string;bytes:Uint8Array;proof:SignedResearchClaim|null}):void {
    this.transaction(()=>{
      const state=this.readProjection(),assignment=state.assignments?.find(a=>a.id===input.assignmentId);
      if(!assignment?.research?.reviewRoundId||assignment.research.stage!=='S7')throw new Error('Rebuttal belongs to an exact S7 reviewer context.');
      const round=this.isolatedResearchContext(state,assignment);
      const prior=state.pipeline?.find(r=>r.kind==='REBUTTAL'&&r.assignmentId===assignment.id);
      if(prior){if(prior.kind!=='REBUTTAL'||prior.reportHash!==input.reportHash)throw new Error('Conflicting rebuttal.');return;}
      const body=z.object({phase:z.literal('REBUTTAL'),contextHash:hash,detail:text(4000)}).strict().parse(parseStrictJson(Buffer.from(input.bytes).toString('utf8')));
      if(body.contextHash!==assignment.research.contextHash)throw new Error('Rebuttal context mismatch.');
      if(sha256(input.bytes)!==input.reportHash)throw new Error('Rebuttal bytes do not match their declared hash.');
      if(input.proof){
        const verified=this.researchAdmission.verify(input.proof),claim=verified.signed.claim;
        this.assertResearchClaimScope(state,claim);
        const intent=state.pipeline?.find(r=>r.kind==='REBUTTAL_INTENT'&&r.id===('operationId' in claim?claim.operationId:''));
        const job=state.jobs?.find(j=>j.assignmentId===assignment.id);
        if(claim.kind!=='REBUTTAL'||!intent||intent.kind!=='REBUTTAL_INTENT'||intent.assignmentId!==assignment.id||claim.assignmentId!==assignment.id
          ||claim.roundId!==assignment.research.reviewRoundId||claim.contextId!==assignment.research.isolatedContextId||verified.route!==job?.route
          ||canonical(claim.firstReportHashes)!==canonical(intent.firstReportHashes)||claim.reportHash!==input.reportHash)throw new Error('Rebuttal must bind the exact post-disclosure operation, first reports and isolated context.');
        if(state.pipeline?.some(r=>r.kind==='ADJUDICATION'&&r.roundId===claim.roundId))throw new Error('The round is already adjudicated.');
        this.append(state,[{collection:'pipeline',value:{id:randomUUID(),kind:'REBUTTAL',roundId:assignment.research.reviewRoundId,assignmentId:assignment.id,reportHash:input.reportHash,reportBytes:input.bytes.byteLength,proof:verified.signed,detail:body.detail,
          projectId:assignment.projectId,branchId:assignment.research.branchId,createdAt:new Date().toISOString()}}],{kind:'RESEARCH_REBUTTAL',projectId:assignment.projectId,experimentId:null,reason:'Recorded one independently attested bounded response after both first reports became immutable.'},null);
        return;
      }
      if(round?.source!=='SEPARATED')throw new Error('An unsigned rebuttal is admissible only for a separated (office-bound) review round.');
      const intent=state.pipeline?.find(r=>r.kind==='REBUTTAL_INTENT'&&r.assignmentId===assignment.id&&r.roundId===assignment.research!.reviewRoundId);
      if(!intent||intent.kind!=='REBUTTAL_INTENT')throw new Error('Rebuttal must follow the authorized post-disclosure intent.');
      if(state.pipeline?.some(r=>r.kind==='ADJUDICATION'&&r.roundId===assignment.research!.reviewRoundId))throw new Error('The round is already adjudicated.');
      this.append(state,[{collection:'pipeline',value:{id:randomUUID(),kind:'REBUTTAL',roundId:assignment.research!.reviewRoundId,assignmentId:assignment.id,reportHash:input.reportHash,reportBytes:input.bytes.byteLength,proof:null,detail:body.detail,
        projectId:assignment.projectId,branchId:assignment.research!.branchId,createdAt:new Date().toISOString()}}],{kind:'RESEARCH_REBUTTAL',projectId:assignment.projectId,experimentId:null,reason:'Recorded one bounded response after both first reports became immutable (office-bound, unsigned).'},null);
    });
  }
  assertHoldoutPrerequisites(branchId:string,expectedRevision:number,refitHash:string):void {
    const state=this.readProjection(),branch=state.branches?.find(b=>b.id===branchId);
    if(!branch||branch.revision!==expectedRevision||branch.stage!=='S8'||branch.outcome!=='IN_PROGRESS')throw new Error('Holdout evaluation requires the current active S8 branch.');
    this.activeProject(state,branch.projectId);
    const link=state.pipeline?.filter(r=>r.kind==='LINK'&&r.branchId===branchId).at(-1);
    if(!link||link.kind!=='LINK')throw new Error('Holdout has no exact linked candidate.');
    const request=state.requests?.find(r=>r.id===link.requestId);
    if(!request||request.revision!==link.requestRevision||request.status==='CANCELED')throw new Error('Linked request changed before custody admission.');
    const prior={...branch,stage:'S7' as const};
    this.assertGateEvidence(state,prior,link.subjectHash);
    if(recheckMandatoryGates(state,prior,link.subjectHash).length)throw new Error('Mandatory prerequisites block holdout exposure.');
    if(!state.pipeline?.some(r=>r.kind==='ADJUDICATION'&&r.branchId===branchId&&r.specId===branch.specId&&r.subjectHash===link.subjectHash&&r.decision==='PROMOTE'))throw new Error('The exact candidate has no admitted S7 promotion.');
    const signedRefit=state.pipeline?.some(r=>r.kind==='HARNESS_RECEIPT'&&r.proof.claim.kind==='HARNESS'&&r.proof.claim.branchId===branch.id
      &&r.proof.claim.specId===branch.specId&&r.proof.claim.subjectHash===link.subjectHash&&r.proof.claim.outputHashes.includes(refitHash));
    const returnedRefit=state.pipeline?.some(r=>r.kind==='RUN_RETURN'&&r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash&&r.outputHashes.includes(refitHash));
    if(!signedRefit&&!returnedRefit)throw new Error('Refit identity is not an admitted artifact of this candidate (signed harness receipt or bound user-run return).');
  }
  recordHoldoutResult(input:{branchId:string;expectedRevision:number;reservation:HoldoutReservation;queryHash:string;object:{sha256:string;bytes:number};result:EvaluatorResult;verification:'LOCAL_FIXTURE'|'HOSTED'|'USER_IMPORTED'}):void {
    this.transaction(()=>{
      const state=this.readProjection(),branch=state.branches?.find(b=>b.id===input.branchId);
      if(!branch||branch.revision!==input.expectedRevision)throw new Error('Branch changed during custody evaluation; exposure remains spent.');
      this.assertHoldoutPrerequisites(branch.id,branch.revision,input.reservation.refitHash);
      const reserved=(state.pipeline??[]).filter(r=>r.kind==='RESERVATION'&&r.reservation.id===input.reservation.id).at(-1);
      if(!reserved||reserved.kind!=='RESERVATION'||!(input.verification==='USER_IMPORTED'?['EXPORTED']:['RESERVED','UNKNOWN']).includes(reserved.reservation.state)
        ||reserved.reservation.queryHash!==input.queryHash||input.reservation.queryHash!==input.queryHash
        ||input.reservation.state!=='EXPOSED'||input.reservation.reportHash!==input.result.reportHash
        ||canonical({...reserved.reservation,state:input.reservation.state,settledAt:input.reservation.settledAt,reportHash:input.reservation.reportHash,detail:input.reservation.detail})!==canonical(input.reservation))throw new Error('Custody report does not settle this exact reservation.');
      const now=new Date().toISOString(),{reportHash:_external,...result}=input.result;
      const values:PipelineRecord[]=[{id:randomUUID(),kind:'RESERVATION',branchId:branch.id,projectId:branch.projectId,createdAt:now,reservation:input.reservation},
        {id:randomUUID(),kind:'HOLDOUT_RESULT',branchId:branch.id,projectId:branch.projectId,createdAt:now,reservationId:input.reservation.id,specId:branch.specId!,subjectHash:input.reservation.candidateHash,
          queryHash:input.queryHash,reportHash:input.object.sha256,reportBytes:input.object.bytes,result,verification:input.verification}];
      this.append(state,values.map(value=>({collection:'pipeline' as const,value:pipelineRecordSchema.parse(value)})),{kind:'HOLDOUT_RESULT',projectId:branch.projectId,experimentId:null,reason:'Persisted the completed custody result without restoring the spent exposure.'},null);
    });
  }
  recordShadow(input:{branchId:string;expectedRevision:number;artifactId?:string;documents:{sourceHash:string;bytes:Uint8Array;receivedAt:string}[];now:string}):void {
    this.transaction(()=>{
      const state=this.readProjection(),branch=state.branches?.find(b=>b.id===input.branchId);
      if(!branch||branch.revision!==input.expectedRevision||!['S9','S10'].includes(branch.stage)||branch.outcome!=='IN_PROGRESS')throw new Error('Shadow ingestion requires the current active S9/S10 branch.');
      this.activeProject(state,branch.projectId);
      const policy=state.pipeline?.filter(r=>r.kind==='SHADOW_POLICY'&&r.specId===branch.specId).at(-1);
      const link=state.pipeline?.filter(r=>r.kind==='LINK'&&r.branchId===branch.id).at(-1);
      if(!policy||policy.kind!=='SHADOW_POLICY'||!link||link.kind!=='LINK')throw new Error('Shadow policy and exact candidate must be frozen.');
      const request=state.requests?.find(r=>r.id===link.requestId);
      if(!request||request.revision!==link.requestRevision||request.status==='CANCELED')throw new Error('Linked request changed before shadow ingestion.');
      const existing=(state.pipeline??[]).filter((r):r is Extract<PipelineRecord,{kind:'SHADOW_BATCH'}>=>r.kind==='SHADOW_BATCH'&&r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash);
      const artifact=input.artifactId?state.artifacts.find(a=>a.id===input.artifactId&&a.projectId===branch.projectId):null;
      if(input.artifactId&&!artifact)throw new Error('Shadow artifact does not belong to this branch project.');
      if(artifact&&existing.some(r=>r.sourceHash===artifact.sha256))return;
      if(existing.length>=256)throw new Error('Shadow batch inventory limit reached.');
      const expected=[...existing.map(r=>({sourceHash:r.sourceHash,receivedAt:r.createdAt})),...(artifact?[{sourceHash:artifact.sha256,receivedAt:input.now}]:[])];
      if(canonical(expected)!==canonical(input.documents.map(({sourceHash,receivedAt})=>({sourceHash,receivedAt}))))throw new Error('Shadow inventory changed during retrieval.');
      const bodies=input.documents.map(document=>{
        if(sha256(document.bytes)!==document.sourceHash)throw new Error('Shadow source object hash mismatch.');
        const body=shadowBatchSchema.parse(parseStrictJson(Buffer.from(document.bytes).toString('utf8')));
        if(body.branchId!==branch.id||body.specId!==branch.specId||body.candidateHash!==link.subjectHash)throw new Error('Shadow batch scope differs from the exact frozen candidate.');
        if(body.kind==='EXECUTIONS'&&!state.artifacts.some(a=>a.projectId===branch.projectId&&a.sha256===body.sourceDocumentHash&&a.sha256!==document.sourceHash))throw new Error('Actual execution imports require a separate source document in this project.');
        return {body,receivedAt:document.receivedAt};
      });
      const result=replayShadow(bodies,policy.policy,input.now),changes:Change[]=[];
      if(artifact){
        const body=bodies.at(-1)!.body;
        changes.push({collection:'pipeline',value:{id:randomUUID(),kind:'SHADOW_BATCH',projectId:branch.projectId,branchId:branch.id,createdAt:input.now,specId:branch.specId!,subjectHash:link.subjectHash,
          artifactId:artifact.id,sourceHash:artifact.sha256,batchType:body.kind,rows:body.kind==='PREDICTIONS'?body.predictions.length:body.fills.length+(body.kind==='OBSERVATIONS'?body.quotes.length:0),thresholdHash:policy.policy.thresholdHash,verification:'USER_IMPORTED'}});
      }
      const verdict=result.verdict;
      const record=pipelineRecordSchema.parse({id:randomUUID(),kind:'MONITOR_VERDICT',projectId:branch.projectId,branchId:branch.id,createdAt:input.now,specId:branch.specId,
        subjectHash:link.subjectHash,thresholdHash:policy.policy.thresholdHash,sourceHashes:expected.map(d=>d.sourceHash),...verdict,verification:'USER_IMPORTED'});
      const previous=state.pipeline?.filter(r=>r.kind==='MONITOR_VERDICT'&&r.branchId===branch.id).at(-1);
      if(!artifact&&previous?.kind==='MONITOR_VERDICT'&&canonical({...previous,id:record.id,createdAt:record.createdAt})===canonical(record))return;
      changes.push({collection:'pipeline',value:record});
      if(verdict.outcome==='SUSPENDED'||verdict.outcome==='RETIRED')changes.push({collection:'branches',value:{...branch,outcome:verdict.outcome,revision:branch.revision+1,updatedAt:input.now,
        ...(verdict.outcome==='RETIRED'?{retiredAt:input.now,retiredReason:verdict.detail}:{})}});
      this.append(state,changes,{kind:'SHADOW_MONITORING',projectId:branch.projectId,experimentId:null,reason:verdict.detail},null);
    });
  }
  /**
   * The durable evidence ledger: query receipts, raw outputs and briefs.
   *
   * These live in the event log rather than a side file so a backup carries exactly what an agent
   * was shown, and a restart replays the same answers. They are kept out of the renderer snapshot:
   * a receipt is audit material for the office, not state a sandboxed window needs to render.
   */
  evidenceRecords():EvidenceRecord[] {
    this.assertOpen();
    return this.readProjection().evidence ?? [];
  }
  recordEvidence(input:EvidenceRecord):void {
    const record=evidenceRecordSchema.parse(input);
    this.transaction(()=>{
      const state=this.readProjection();
      if(!state.projects.some(p=>p.id===record.projectId))throw new Error('Evidence record names a project this workspace does not have.');
      if(state.evidence?.some(e=>e.id===record.id))throw new Error('Evidence record identities are immutable');
      this.append(state,[{collection:'evidence',value:record}],{kind:'EVIDENCE_'+record.kind,projectId:record.projectId,experimentId:null,reason:'Recorded '+record.kind.toLowerCase()+' evidence for the exact stored objects.'},null);
    });
  }
  /** Main-only durable research records. Imported claims never become gate receipts here. */
  recordPipeline(input:PipelineRecord):void {
    const record=pipelineRecordSchema.parse(input);
    if(record.kind==='STAGE_COMPLETION')throw new Error('Stage completion requires atomic report admission.');
    if(record.kind==='REVIEW_INTENT')throw new Error('Review intents require atomic service admission.');
    if(['REBUTTAL_INTENT','HARNESS_INTENT','HARNESS_RECEIPT','REVIEW_REPORT','ADJUDICATION','REBUTTAL','HOLDOUT_RESULT','SHADOW_BATCH','MONITOR_VERDICT','FORECAST_OUTCOME','RUN_PACKAGE','RUN_RETURN','SEPARATED_REVIEW'].includes(record.kind))throw new Error('This research record requires atomic service admission.');
    this.transaction(()=>{
      const state=this.readProjection();
      this.activeProject(state,record.projectId);
      const branch=state.branches?.find(b=>b.id===record.branchId&&b.projectId===record.projectId);
      if(!branch)throw new Error('Research record belongs to an unknown project branch.');
      if(record.kind==='REVIEW_ROUND'){
        const verified=this.researchAdmission.verify(record.proof),claim=verified.signed.claim;
        if(claim.kind!=='ISOLATION'||verified.environment!==record.verification)throw new Error('A review round requires independently signed isolation evidence.');
        this.assertResearchClaimScope(state,claim);
        if(!state.pipeline?.some(r=>r.kind==='REVIEW_INTENT'&&r.id===claim.operationId&&r.branchId===branch.id&&r.branchRevision===branch.revision))throw new Error('Review isolation requires its durable preparation intent.');
        if(claim.roundId!==record.id||!['S2','S7'].includes(branch.stage)||Date.parse(claim.expiresAt)<=Date.now())throw new Error('Review isolation scope or expiry is invalid.');
        const request=state.requests!.find(r=>r.id===claim.requestId)!;
        if(request.mode==='SINGLE')throw new Error('A single-agent request cannot open independent reviews.');
        // The subject is the prior stage's completion: an agent assignment (S2 reviews S1) or an
        // office-completed stage (S7 reviews S6), in which case the claim names no assignment.
        const subjectStage=branch.stage==='S2'?'S1':'S6';
        const subjectCompletion=(state.pipeline??[]).find(r=>r.kind==='STAGE_COMPLETION'&&r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===claim.subjectHash&&r.stage===subjectStage);
        if(!subjectCompletion||subjectCompletion.kind!=='STAGE_COMPLETION')throw new Error('Review subject must be a completed exact-subject stage.');
        const subject=claim.subjectAssignmentId===null?null
          :state.assignments?.find(a=>a.id===claim.subjectAssignmentId&&a.research?.branchId===branch.id&&a.research.specId===branch.specId&&a.research.subjectHash===claim.subjectHash)??null;
        if(claim.subjectAssignmentId!==null&&(!subject||subjectCompletion.assignmentId!==subject.id))throw new Error('Review subject must be a completed exact-subject run.');
        const contexts=claim.contexts;
        if(contexts.length!==(branch.stage==='S7'?2:1)||new Set(contexts.map(c=>c.agentId)).size!==contexts.length
          ||new Set(contexts.map(c=>c.contextId)).size!==contexts.length||contexts.some(c=>c.agentId===subject?.agentId))throw new Error('Reviewers must be distinct from each other and the author.');
        if(branch.stage==='S2'&&!claim.correctnessBlinded)throw new Error('S2 requires a blinded context.');
        if(state.pipeline?.some(r=>r.kind==='REVIEW_ROUND'&&r.branchId===branch.id&&r.proof.claim.branchRevision===branch.revision)||state.pipeline?.some(r=>r.kind==='SEPARATED_REVIEW'&&r.branchId===branch.id&&r.branchRevision===branch.revision))throw new Error('A review round is already frozen for this branch revision.');
        for(const context of contexts){
          if((state.pipeline??[]).some(r=>r.kind==='REVIEW_ROUND'&&r.proof.claim.kind==='ISOLATION'&&r.proof.claim.contexts.some(c=>c.contextId===context.contextId)))throw new Error('An isolated reviewer context cannot be reused.');
          const snapshot=state.snapshots?.find(s=>s.id===context.snapshotId&&s.requestId===request.id&&s.requestRevision===request.revision);
          if(!snapshot||canonical([...snapshot.files,...snapshot.generated??[]].map(f=>f.sha256).sort())!==canonical([...claim.objectHashes].sort()))throw new Error('Isolation receipt must bind exactly the delivered snapshot objects.');
        }
      }
      const old=state.pipeline?.find(r=>r.id===record.id);
      if(old){if(canonical(old)!==canonical(record))throw new Error('Research record identity conflict.');return;}
      if(record.kind==='LINK'){
        const request=state.requests?.find(r=>r.id===record.requestId&&r.projectId===record.projectId);
        if(!request||request.status==='CANCELED'||request.revision!==record.requestRevision)throw new Error('Request link is stale or belongs to another project.');
        if(branch.revision!==record.branchRevision)throw new Error('Branch changed before linking.');
        if((state.assignments??[]).some(a=>a.research?.branchId===branch.id&&(state.jobs??[]).some(j=>j.assignmentId===a.id&&!['COMPLETED','FAILED','CANCEL_ACKNOWLEDGED'].includes(j.state))))throw new Error('Settle prepared research work before relinking.');
        if(branch.stage!=='S0')throw new Error('Amend the branch before changing a candidate or request after S0.');
        // The subject is a ledger trial, not an opaque hash: linking an identity nobody registered
        // would let receipts accumulate for a candidate the lineage never admitted it tried.
        if(!(state.trials??[]).some(t=>t.branchId===branch.id&&t.variantHash===record.subjectHash))throw new Error('Link a registered trial identity, not an unrecorded subject.');
      }
      if(record.kind==='IMPORT'&&!state.artifacts.some(a=>a.id===record.artifactId&&a.projectId===record.projectId&&a.status==='QUARANTINED'))throw new Error('Import must reference quarantined bytes in this project.');
      if(record.kind==='SHADOW_POLICY'){
        const spec=state.specs?.find(s=>s.id===record.specId&&s.branchId===branch.id);
        if(!spec||spec.frozen)throw new Error('Set shadow thresholds before freezing the specification.');
        const {thresholdHash,...policy}=record.policy;
        if(policy.killBelowMetric>policy.retireBelowMetric||policy.retireBelowMetric>policy.qualifyAtOrAboveMetric)throw new Error('Shadow kill, retirement and qualification thresholds must be ordered.');
        if(canonicalHash(policy)!==thresholdHash)throw new Error('Shadow threshold identity mismatch.');
      }
      if(record.kind==='HOLDOUT'&&record.holdout.projectId!==record.projectId)throw new Error('Holdout project mismatch.');
      if(record.kind==='RESERVATION'&&(record.reservation.projectId!==record.projectId||record.reservation.branchId!==branch.id||record.reservation.lineageId!==branch.lineageId))throw new Error('Holdout reservation scope mismatch.');
      const changes:Change[]=[{collection:'pipeline',value:record}];
      if(record.kind==='REVIEW_ROUND'&&record.proof.claim.kind==='ISOLATION')for(const context of record.proof.claim.contexts){
        if(!state.grants?.some(g=>g.agentId===context.agentId&&g.requestId===record.proof.claim.requestId&&!g.revokedAt))
          changes.push({collection:'grants',value:{id:randomUUID(),projectId:record.projectId,requestId:record.proof.claim.requestId,agentId:context.agentId,capacity:'REVIEW',grantedAt:record.createdAt}});
      }
      this.append(state,changes,{kind:'RESEARCH_'+record.kind,projectId:record.projectId,experimentId:null,reason:'Recorded '+record.kind.toLowerCase()+' for the exact research branch.'},null);
    });
  }
  /** Only trusted main services call this after verifying harness/reviewer output bytes. */
  recordResearchGates(input:{branchId:string;expectedRevision:number;assignmentId?:string;receipts:GateReceipt[];completion?:{reportHash:string;bytes:Uint8Array;harness?:SignedResearchClaim}}):void {
    this.transaction(()=>{
      const state=this.readProjection(),branch=state.branches?.find(b=>b.id===input.branchId);
      if(!branch||branch.revision!==input.expectedRevision)throw new Error('Branch changed before gate recording.');
      this.activeProject(state,branch.projectId);
      const spec=state.specs?.find(s=>s.id===branch.specId);
      if(!spec?.frozen)throw new Error('Gate receipts require a frozen specification.');
      const signedDeclared=new Set((spec.gateEvidence??[]).filter(g=>g.tier==='SIGNED_HARNESS').map(g=>g.gate));
      const link=(state.pipeline??[]).filter(r=>r.kind==='LINK'&&r.branchId===branch.id).at(-1);
      if(!link||link.kind!=='LINK')throw new Error('Link the branch to an exact candidate first.');
      const request=state.requests?.find(r=>r.id===link.requestId);
      if(!request||request.status==='CANCELED'||request.revision!==link.requestRevision)throw new Error('Linked request changed before gate collection.');
      if(branch.outcome!=='IN_PROGRESS')throw new Error('Settled branches cannot collect gate evidence.');
      const blocker=this.researchStageBlocker(branch.stage);
      if(blocker)throw new Error(blocker);
      const assignment=state.assignments?.find(a=>a.id===input.assignmentId);
      const job=state.jobs?.find(j=>j.assignmentId===assignment?.id);
      if(input.assignmentId){
        const research=assignment?.research;
        if(!assignment||!research||research.branchId!==branch.id||research.branchRevision!==branch.revision||research.specId!==branch.specId
          ||research.stage!==branch.stage||research.subjectHash!==link.subjectHash||assignment.requestId!==link.requestId
          ||assignment.requestRevision!==link.requestRevision||job?.state!=='COMPLETED'||job.evidence!=='PROVIDER_REPORTED'
          ||stageContextHash({...research,agentId:assignment.agentId,agentRevision:assignment.agentRevision,inputs:research})!==research.contextHash)
          throw new Error('Gate source is not a completed exact-subject research assignment.');
      }
      const values=input.receipts.map(r=>receiptSchema.parse(r));
      const completionChanges:Change[]=[];
      let verifiedHarness=false;
      if(input.completion){
        if(sha256(input.completion.bytes)!==input.completion.reportHash)throw new Error('Stage report hash mismatch.');
        const report=stageReportSchema.parse(parseStrictJson(Buffer.from(input.completion.bytes).toString('utf8'))),research=assignment?.research;
        if(!assignment||!research||!job||report.contextHash!==research.contextHash||report.branchId!==branch.id
          ||report.specId!==branch.specId||report.subjectHash!==link.subjectHash||report.stage!==branch.stage
          ||!job.outputs.some(o=>o.stored&&o.sha256===input.completion!.reportHash&&o.bytes===input.completion!.bytes.byteLength))
          throw new Error('Stage completion requires the exact stored report and completed assignment.');
        if(input.completion.harness){
          const verified=this.researchAdmission.verify(input.completion.harness),claim=verified.signed.claim;
          this.assertResearchClaimScope(state,claim);
          if(claim.kind!=='HARNESS'||claim.assignmentId!==assignment.id||claim.jobId!==job.id||claim.externalRunId!==job.externalId
            ||claim.contextHash!==research.contextHash||claim.reportHash!==input.completion.reportHash
            ||canonical([...claim.inputHashes].sort())!==canonical([...research.objectHashes].sort())
            ||canonical([...claim.outputHashes].sort())!==canonical(job.outputs.filter(o=>o.stored).map(o=>o.sha256).sort()))throw new Error('Harness receipt is not for this exact run, report and artifact inventory.');
          if(verified.route!==job.route)throw new Error('Harness trust does not cover this job route.');
          const intent=state.pipeline?.find(r=>r.kind==='HARNESS_INTENT'&&r.id===claim.operationId&&r.assignmentId===assignment.id&&r.reportHash===claim.reportHash);
          if(!intent||intent.kind!=='HARNESS_INTENT')throw new Error('Harness execution lacks its durable exact-report intent.');
          completionChanges.push({collection:'pipeline',value:{...intent,status:'COMPLETED'}});
          if(canonical(claim.gates)!==canonical(values.map(({gate,outcome,detail,rationale})=>({gate,outcome,detail,rationale}))))throw new Error('Gate receipts differ from independently verified harness results.');
          if(STAGE_GATES[branch.stage].some(g=>!claim.gates.some(r=>r.gate===g)))throw new Error('Independent harness receipt lacks a required stage gate.');
          if(branch.stage==='S8'&&!state.pipeline?.some(r=>r.kind==='HOLDOUT_RESULT'&&r.branchId===branch.id&&r.specId===branch.specId
            &&r.subjectHash===link.subjectHash&&r.reportHash===claim.custodyReportHash&&r.verification===verified.environment))throw new Error('S8 harness receipt must bind the completed isolated custody report.');
          if(branch.stage==='S9'||branch.stage==='S10'){
            const batches=(state.pipeline??[]).filter(r=>r.kind==='SHADOW_BATCH'&&r.branchId===branch.id&&r.specId===branch.specId);
            const policy=state.pipeline?.filter(r=>r.kind==='SHADOW_POLICY'&&r.specId===branch.specId).at(-1);
            if(!policy||policy.kind!=='SHADOW_POLICY'||claim.thresholdHash!==policy.policy.thresholdHash
              ||claim.shadowEvidenceHash!==canonicalHash(batches.map(r=>r.kind==='SHADOW_BATCH'?[r.sourceHash,r.createdAt]:[])))throw new Error('Shadow harness receipt must bind the exact prospective batch history and frozen policy.');
            const verdict=state.pipeline?.filter(r=>r.kind==='MONITOR_VERDICT'&&r.branchId===branch.id&&r.specId===branch.specId).at(-1);
            if(claim.gates.some(g=>g.gate==='G-SHADOW'&&g.outcome==='PASS')&&(policy.policy.minimumElapsedSeconds===undefined||policy.policy.minimumObservationTimes===undefined))throw new Error('G-SHADOW requires prospective elapsed-time and observation-time coverage thresholds. Amend legacy policies before qualification.');
            if(claim.gates.some(g=>g.gate==='G-SHADOW'&&g.outcome==='PASS')&&(!verdict||verdict.kind!=='MONITOR_VERDICT'||verdict.outcome!=='SHADOW_QUALIFIED'
              ||canonical(verdict.sourceHashes)!==canonical(batches.map(r=>r.kind==='SHADOW_BATCH'?r.sourceHash:''))))throw new Error('Missing, stale or unqualified shadow observations cannot pass G-SHADOW.');
          }
          verifiedHarness=true;
          completionChanges.push({collection:'pipeline',value:{id:randomUUID(),kind:'HARNESS_RECEIPT',projectId:branch.projectId,branchId:branch.id,createdAt:new Date().toISOString(),proof:verified.signed,verification:verified.environment}});
        }
        if(STAGE_GATES[branch.stage].some(g=>signedDeclared.has(g))&&!verifiedHarness)throw new Error('This stage has gates the frozen specification declares signed-harness evidence; completion requires an independent harness receipt.');
        const previous=(state.pipeline??[]).find(r=>r.kind==='STAGE_COMPLETION'&&r.assignmentId===assignment.id);
        if(previous){
          if(previous.kind!=='STAGE_COMPLETION'||previous.reportHash!==input.completion.reportHash)throw new Error('Conflicting stage completion report.');
          return;
        }
        const attempt=(state.attempts??[]).find(a=>a.assignmentId===assignment.id&&a.state==='OPEN');
        if(!attempt)throw new Error('Stage completion requires a durable open attempt.');
        // Unsigned reports keep their verbatim outcomes; provenance labels, not rewrites, carry the tier.
        if(!verifiedHarness&&(values.length!==report.gates.length||report.gates.some(g=>!values.some(r=>r.gate===g.gate
          &&r.outcome===g.outcome&&r.evidenceRef===input.completion!.reportHash)))
          )
          throw new Error('Stage gate claims do not match the stored report.');
        const now=new Date().toISOString();
        if(report.realisedPrediction){
          const prediction=state.predictions?.find(p=>p.id===report.realisedPrediction!.predictionId&&p.branchId===branch.id&&p.specId===branch.specId&&p.outcomeName===report.realisedPrediction!.outcomeName);
          if(!verifiedHarness||!prediction)throw new Error('A realised forecast outcome requires independent evidence for the exact registered metric.');
          if(state.pipeline?.some(r=>r.kind==='FORECAST_OUTCOME'&&r.predictionId===prediction.id))throw new Error('A registered forecast has already been scored; historical outcomes are immutable.');
          completionChanges.push({collection:'pipeline',value:{id:randomUUID(),kind:'FORECAST_OUTCOME',projectId:branch.projectId,branchId:branch.id,createdAt:now,
            predictionId:prediction.id,specId:prediction.specId,subjectHash:link.subjectHash,reportHash:input.completion.reportHash,value:report.realisedPrediction.value}});
        }
        completionChanges.push({collection:'attempts',value:{...attempt,state:'COMPLETED',summary:report.detail.slice(0,4000),settledAt:now}},
          {collection:'pipeline',value:pipelineRecordSchema.parse({id:randomUUID(),kind:'STAGE_COMPLETION',projectId:branch.projectId,
            branchId:branch.id,createdAt:now,assignmentId:assignment.id,jobId:job.id,attemptId:attempt.id,specId:research.specId,
            subjectHash:research.subjectHash,contextHash:research.contextHash,reportHash:input.completion.reportHash,stage:research.stage,
            branchRevision:research.branchRevision,requestRevision:research.requestRevision})});
        if(research.stage==='S2'||research.stage==='S7'){
          const isolation=this.isolatedResearchContext(state,assignment)!;
          if(isolation.source==='SIGNED'&&job.externalId!==research.isolatedContextId)throw new Error('The completed review did not run in the independently isolated context.');
          if(report.verdict===undefined||report.defectFound===undefined)throw new Error('A review report must carry a verdict and defect finding.');
          const reports=(state.pipeline??[]).filter((r):r is Extract<PipelineRecord,{kind:'REVIEW_REPORT'}>=>r.kind==='REVIEW_REPORT'&&r.roundId===isolation.roundId);
          if(reports.some(r=>r.assignmentId===assignment.id||state.assignments?.find(a=>a.id===r.assignmentId)?.agentId===assignment.agentId))throw new Error('This reviewer has already committed its first report.');
          const review:Extract<PipelineRecord,{kind:'REVIEW_REPORT'}>={id:randomUUID(),kind:'REVIEW_REPORT',roundId:isolation.roundId,projectId:branch.projectId,branchId:branch.id,createdAt:now,
            assignmentId:assignment.id,subjectHash:research.subjectHash,specId:research.specId,reportHash:input.completion.reportHash,expectedReviewerIds:isolation.contexts.map(c=>c.agentId),stage:research.stage,
            verdict:report.verdict,defectFound:report.defectFound,detail:report.detail,opened:false,
            independence:isolation.source==='SEPARATED'?'SEPARATE_SESSION_UNVERIFIED':isolation.verification==='HOSTED'?'VERIFIED_INDEPENDENT':'VERIFIED_LOCAL'};
          const sealed:SealedReviewReport={id:randomUUID(),projectId:branch.projectId,subjectAssignmentId:isolation.subjectAssignmentId,reviewerAgentId:assignment.agentId,phase:'FIRST',contentHash:input.completion.reportHash,sealedAt:now,openedAt:null};
          const all=[...reports,review];
          const complete=isolation.contexts.every(c=>all.some(r=>state.assignments?.find(a=>a.id===r.assignmentId)?.agentId===c.agentId));
          completionChanges.push({collection:'pipeline',value:{...review,opened:complete}},{collection:'sealed',value:{...sealed,openedAt:complete?now:null}});
          if(complete){
            for(const r of reports)completionChanges.push({collection:'pipeline',value:{...r,opened:true}});
            for(const r of state.sealed??[])if(r.subjectAssignmentId===isolation.subjectAssignmentId&&isolation.contexts.some(c=>c.agentId===r.reviewerAgentId)&&r.openedAt===null)completionChanges.push({collection:'sealed',value:{...r,openedAt:now}});
          }
        }
      }
      if(new Set(values.map(r=>r.gate)).size!==values.length)throw new Error('Duplicate gates in one report.');
      for(const r of values){
        if(r.branchId!==branch.id||r.specId!==branch.specId||r.stage!==branch.stage||r.subjectHash!==link.subjectHash||!r.evidenceRef.trim())throw new Error('Gate receipt scope or evidence mismatch.');
        if(!STAGE_GATES[branch.stage].includes(r.gate))throw new Error(`${r.gate} does not belong to ${branch.stage}.`);
        if(input.assignmentId){
          if((r.outcome==='PASS'||r.outcome==='NOT_APPLICABLE')&&!verifiedHarness&&signedDeclared.has(r.gate))throw new Error('Provider claims cannot approve a gate the frozen specification declares signed-harness evidence.');
          if(r.outcome==='NOT_APPLICABLE'&&(!r.rationale.trim()||!spec.notApplicable.some(n=>n.gate===r.gate&&n.rationale.trim())))throw new Error('Gate inapplicability must be prospectively frozen.');
          if(!job?.outputs.some(output=>output.stored&&output.sha256===r.evidenceRef))throw new Error('Gate evidence must name stored bytes from this assignment.');
        }else{
          if(!(r.gate==='G-SPEC'&&branch.stage==='S0'))throw new Error('A completed assignment is required for this gate.');
          if(r.evidenceRef!==spec.contentHash)throw new Error('Office specification evidence must identify the frozen specification.');
          if(r.outcome==='NOT_APPLICABLE'||(r.outcome==='PASS'&&(!nextActions({...state,receipts:[...(state.receipts??[]),r]},branch,link.subjectHash).canAdvance
            ||!state.predictions?.some(p=>p.id===branch.predictionId&&p.specId===spec.id&&!p.retrospective))))throw new Error('Office specification gate requires a complete prospective registration.');
        }
      }
      if(!values.length&&!completionChanges.length)return;
      const previous=(state.receipts??[]).filter(r=>r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash);
      const fresh=values.filter(r=>!previous.some(p=>p.evidenceRef===r.evidenceRef&&p.stage===r.stage&&p.gate===r.gate&&p.outcome===r.outcome&&p.detail===r.detail&&p.rationale===r.rationale));
      if(!fresh.length&&!completionChanges.length)return;
      const provenance:GateReceipt['provenance']=verifiedHarness?'SIGNED_HARNESS':input.assignmentId?'REVIEWER_ASSERTED':'OFFICE';
      this.append(state,[...fresh.map(value=>({collection:'receipts' as const,value:{...value,provenance}})),...completionChanges],{kind:'RESEARCH_GATES_RECORDED',projectId:branch.projectId,experimentId:null,reason:'Atomically admitted exact stage evidence; provenance labels carry the evidence tier.'},null);
    });
  }
  advanceResearch(branchId:string,expectedRevision:number):AppState {
    return this.transaction(()=>{
      const state=this.readProjection(),branch=state.branches?.find(b=>b.id===branchId);
      if(!branch||branch.revision!==expectedRevision)throw new Error('Branch changed before advancement.');
      this.activeProject(state,branch.projectId);
      if(branch.outcome!=='IN_PROGRESS')throw new Error('Settled branches do not advance.');
      const blocker=this.researchStageBlocker(branch.stage);
      if(blocker)throw new Error(blocker);
      const link=(state.pipeline??[]).filter(r=>r.kind==='LINK'&&r.branchId===branch.id).at(-1);
      if(!link||link.kind!=='LINK')throw new Error('Link an exact candidate before advancing.');
      const request=state.requests?.find(r=>r.id===link.requestId);
      if(!request||request.status==='CANCELED'||request.revision!==link.requestRevision)throw new Error('Linked request changed; amend or relink before advancing.');
      const spec=state.specs?.find(s=>s.id===branch.specId);
      const specGate=(state.receipts??[]).filter(r=>r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash&&r.gate==='G-SPEC').at(-1);
      if(branch.stage!=='S0'&&!(state.pipeline??[]).some(r=>r.kind==='STAGE_COMPLETION'&&r.branchId===branch.id
        &&r.branchRevision===branch.revision&&r.specId===branch.specId&&r.subjectHash===link.subjectHash
        &&r.requestRevision===request.revision&&r.stage===branch.stage))throw new Error('Collect a completed exact-context stage report before advancement.');
      if(specGate?.outcome==='PASS'&&(specGate.evidenceRef!==spec?.contentHash||!state.predictions?.some(p=>p.id===branch.predictionId&&p.specId===branch.specId&&!p.retrospective)))
        throw new Error('G-SPEC lacks office-verified prospective specification evidence; historical provider claims cannot authorize advancement.');
      for(const stage of STAGES.slice(0,STAGES.indexOf(branch.stage)+1)){
        const check=nextActions(state,{...branch,stage},link.subjectHash);
        if(!check.canAdvance&&stage!=='S10')throw new Error(check.blockers.map(b=>b.reason).join(' '));
      }
      const next=nextActions(state,branch,link.subjectHash).nextStage;
      if(!next)throw new Error('The final stage has no successor.');
      if(STAGES.indexOf(branch.stage)>=2)this.assertGateEvidence(state,branch,link.subjectHash);
      if(branch.stage==='S2'||branch.stage==='S7'){
        const roundRecord=state.pipeline?.find(r=>(r.kind==='REVIEW_ROUND'&&r.proof.claim.branchId===branch.id&&r.proof.claim.branchRevision===branch.revision)
          ||(r.kind==='SEPARATED_REVIEW'&&r.branchId===branch.id&&r.branchRevision===branch.revision));
        if(!roundRecord)throw new Error('This stage has no frozen review round.');
        const round=this.reviewRound(state,roundRecord.id);
        if(!round)throw new Error('This stage has no frozen review round.');
        const reports=(state.pipeline??[]).filter(r=>r.kind==='REVIEW_REPORT'&&r.roundId===roundRecord.id&&r.opened);
        if(reports.length!==round.contexts.length)throw new Error('Every completed first review in the frozen round must be sealed before advancement.');
      }
      if(branch.stage==='S7'&&!(state.pipeline??[]).some(r=>r.kind==='ADJUDICATION'&&r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash&&r.outcome==='UPHELD'))throw new Error('S7 requires recorded adjudication for this subject.');
      if(branch.stage==='S8'&&!(state.pipeline??[]).some(r=>r.kind==='RESERVATION'&&r.branchId===branch.id&&r.reservation.candidateHash===link.subjectHash&&r.reservation.state==='EXPOSED'&&r.reservation.reportHash))throw new Error('S8 requires a completed isolated custody receipt.');
      const now=new Date().toISOString();
      this.append(state,[{collection:'branches',value:{...branch,stage:next,revision:branch.revision+1,updatedAt:now}}],{kind:'RESEARCH_STAGE_ADVANCED',projectId:branch.projectId,experimentId:null,reason:`Advanced ${branch.stage} to ${next} after rechecking every reached gate.`},null);
    });
  }

  private activeProject(state: Projection, projectId: string): Project {
    const project = state.projects.find(item => item.id === projectId);
    if (!project) throw new Error('Project not found');
    if (project.archived) throw new Error('Archived project is read-only; restore it first');
    return project;
  }
  private scopedExperiment(state: Projection, projectId: string, experimentId: string | null): Experiment | undefined {
    this.activeProject(state, projectId);
    if (experimentId === null) return undefined;
    const experiment = state.experiments.find(item => item.id === experimentId);
    if (!experiment || experiment.projectId !== projectId) throw new Error('Experiment does not belong to this project');
    return experiment;
  }
  private append(state: Projection, changes: Change[], metadata: { kind: string; projectId: string | null; experimentId: string | null; reason: string }, command: Command | null): void {
    const last = this.db.prepare('SELECT sequence,record FROM events ORDER BY sequence DESC LIMIT 1').get();
    const previous = last ? JSON.parse(String(last.record)) as StoredEvent : null;
    const body = { sequence: previous ? previous.sequence + 1 : 1, id: randomUUID(), ...metadata, actor: 'USER' as const, createdAt: new Date().toISOString(), previousHash: previous?.hash ?? ZERO_HASH, payload: { command, changes } };
    const event = eventSchema.parse({ ...body, hash: canonicalHash(body) });
    const next = applyChanges(state, event.payload.changes);
    this.db.prepare('INSERT INTO events(sequence,id,record) VALUES(?,?,?)').run(event.sequence, event.id, canonical(event));
    this.db.prepare('UPDATE projection SET state=? WHERE singleton=1').run(canonical(next));
    this.db.prepare("INSERT INTO outbox(event_sequence,state) VALUES(?,'PENDING')").run(event.sequence);
    this.indexEvent(event);
    if (command) this.db.prepare('INSERT INTO commands(idempotency_key,payload_hash,event_sequence) VALUES(?,?,?)').run(command.idempotencyKey, canonicalHash(command), event.sequence);
  }
  beginReview(branchId:string,expectedRevision:number,scheduleHash:string):{operationId:string;existing:boolean}{
    let result={operationId:'',existing:false};
    this.transaction(()=>{
      const state=this.readProjection(),branch=state.branches?.find(b=>b.id===branchId);
      if(!branch||branch.revision!==expectedRevision||!['S2','S7'].includes(branch.stage)||branch.outcome!=='IN_PROGRESS')throw new Error('Review preparation requires the current review stage.');
      this.activeProject(state,branch.projectId);
      const prior=state.pipeline?.find(r=>r.kind==='REVIEW_INTENT'&&r.branchId===branch.id&&r.branchRevision===branch.revision);
      if(prior&&prior.kind==='REVIEW_INTENT'){
        if(prior.scheduleHash!==scheduleHash)throw new Error('Reviewer appointments changed after isolated preparation began. Amend the branch.');
        result={operationId:prior.id,existing:true};return;
      }
      const record=pipelineRecordSchema.parse({id:randomUUID(),kind:'REVIEW_INTENT',projectId:branch.projectId,branchId:branch.id,createdAt:new Date().toISOString(),branchRevision:branch.revision,scheduleHash});
      this.append(state,[{collection:'pipeline',value:record}],{kind:'REVIEW_INTENT',projectId:branch.projectId,experimentId:null,reason:'Reserved immutable isolated reviewer preparation before external context creation.'},null);
      result={operationId:record.id,existing:false};
    });
    return result;
  }

  /**
   * The controller-separated review tier (section 1.6). The office freezes the same bindings a signed
   * isolation claim would carry — the reviewer set, their snapshot objects, the disclosure inventory,
   * the expiry — as a durable record instead of an independent signature. `scheduleHash` binds the
   * round to its preparation intent exactly as a signed claim binds its operationId. Reports admitted
   * against this round are labelled SEPARATE_SESSION_UNVERIFIED and never promoted.
   */
  beginSeparatedReview(input:{branchId:string;expectedRevision:number;scheduleHash:string;contexts:{agentId:string;contextId:string;snapshotId:string}[];objectHashes:string[];evidenceHash:string;expiresAt:string;correctnessBlinded:boolean}):{roundId:string;existing:boolean}{
    let result={roundId:'',existing:false};
    this.transaction(()=>{
      const state=this.readProjection(),branch=state.branches?.find(b=>b.id===input.branchId);
      if(!branch||branch.revision!==input.expectedRevision||!['S2','S7'].includes(branch.stage)||branch.outcome!=='IN_PROGRESS')throw new Error('Separated review requires the current review stage.');
      this.activeProject(state,branch.projectId);
      const spec=state.specs?.find(s=>s.id===branch.specId);
      if(!spec?.frozen)throw new Error('Review requires a frozen specification.');
      const link=state.pipeline?.filter(r=>r.kind==='LINK'&&r.branchId===branch.id).at(-1);
      if(!link||link.kind!=='LINK')throw new Error('Exact candidate link is missing.');
      const request=state.requests?.find(r=>r.id===link.requestId);
      if(!request||request.revision!==link.requestRevision||request.status==='CANCELED')throw new Error('Linked request changed before review preparation.');
      if(request.mode==='SINGLE')throw new Error('A single-agent request cannot open independent reviews.');
      const intent=state.pipeline?.find(r=>r.kind==='REVIEW_INTENT'&&r.branchId===branch.id&&r.branchRevision===branch.revision);
      if(!intent||intent.kind!=='REVIEW_INTENT'||intent.scheduleHash!==input.scheduleHash)throw new Error('Separated review must follow the durable preparation intent for this exact schedule.');
      const subjectStage=branch.stage==='S2'?'S1':'S6';
      const subject=(state.pipeline??[]).find(r=>r.kind==='STAGE_COMPLETION'&&r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash&&r.stage===subjectStage);
      if(!subject||subject.kind!=='STAGE_COMPLETION')throw new Error('Review subject must be a completed exact-subject stage.');
      const subjectAgent=subject.assignmentId?state.assignments?.find(a=>a.id===subject.assignmentId)?.agentId:null;
      const contexts=input.contexts;
      if(contexts.length!==(branch.stage==='S7'?2:1)||new Set(contexts.map(c=>c.agentId)).size!==contexts.length
        ||new Set(contexts.map(c=>c.contextId)).size!==contexts.length||contexts.some(c=>c.agentId===subjectAgent))throw new Error('Reviewers must be distinct from each other and the author.');
      if(branch.stage==='S2'&&!input.correctnessBlinded)throw new Error('S2 requires a blinded context.');
      if(Date.parse(input.expiresAt)<=Date.now())throw new Error('Review round expiry must be in the future.');
      const existingRound=(state.pipeline??[]).find(r=>(r.kind==='REVIEW_ROUND'&&r.proof.claim.branchId===branch.id&&r.proof.claim.branchRevision===branch.revision)
        ||(r.kind==='SEPARATED_REVIEW'&&r.branchId===branch.id&&r.branchRevision===branch.revision));
      if(existingRound){
        if(existingRound.kind==='SEPARATED_REVIEW'&&existingRound.evidenceHash===input.evidenceHash&&canonical(existingRound.contexts)===canonical(contexts)){result={roundId:existingRound.id,existing:true};return;}
        throw new Error('A review round is already frozen for this branch revision.');
      }
      for(const context of contexts){
        if((state.pipeline??[]).some(r=>(r.kind==='REVIEW_ROUND'&&r.proof.claim.kind==='ISOLATION'&&r.proof.claim.contexts.some(c=>c.contextId===context.contextId))
          ||(r.kind==='SEPARATED_REVIEW'&&r.contexts.some(c=>c.contextId===context.contextId))))throw new Error('An isolated reviewer context cannot be reused.');
        const snapshot=state.snapshots?.find(s=>s.id===context.snapshotId&&s.requestId===request.id&&s.requestRevision===request.revision);
        if(!snapshot||canonical([...snapshot.files,...snapshot.generated??[]].map(f=>f.sha256).sort())!==canonical([...input.objectHashes].sort()))throw new Error('Separated round must bind exactly the delivered snapshot objects.');
      }
      const record=pipelineRecordSchema.parse({id:randomUUID(),kind:'SEPARATED_REVIEW',projectId:branch.projectId,branchId:branch.id,createdAt:new Date().toISOString(),
        stage:branch.stage,specId:branch.specId,specHash:spec.contentHash,subjectHash:link.subjectHash,branchRevision:branch.revision,
        requestId:request.id,requestRevision:request.revision,scheduleHash:input.scheduleHash,subjectAssignmentId:subject.assignmentId,
        evidenceHash:input.evidenceHash,objectHashes:[...input.objectHashes].sort(),contexts,correctnessBlinded:input.correctnessBlinded,expiresAt:input.expiresAt});
      const changes:Change[]=[{collection:'pipeline',value:record}];
      for(const context of contexts){
        if(!state.grants?.some(g=>g.agentId===context.agentId&&g.requestId===request.id&&!g.revokedAt))
          changes.push({collection:'grants',value:{id:randomUUID(),projectId:branch.projectId,requestId:request.id,agentId:context.agentId,capacity:'REVIEW',grantedAt:record.createdAt}});
      }
      this.append(state,changes,{kind:'RESEARCH_SEPARATED_REVIEW',projectId:branch.projectId,experimentId:null,reason:'Froze a controller-separated review round; reports admit as separated-session evidence, not independent attestation.'},null);
      result={roundId:record.id,existing:false};
    });
    return result;
  }

  /**
   * S3 export: records the frozen run package and opens the durable user-wait attempt. The record is
   * the wait state — it survives restart and restore with no execution job anywhere. One package per
   * branch revision; re-exporting identical content is idempotent, a different package is rejected.
   */
  recordRunPackage(input:{branchId:string;expectedRevision:number;manifest:RunPackageManifest;objectHash:string}):{packageId:string;existing:boolean}{
    let result={packageId:'',existing:false};
    this.transaction(()=>{
      this.assertStagePreparation(input.branchId,input.expectedRevision);
      const state=this.readProjection(),branch=state.branches?.find(b=>b.id===input.branchId)!;
      if(branch.stage!=='S3')throw new Error('Run-package export belongs to S3.');
      const spec=state.specs?.find(s=>s.id===branch.specId);
      if(!spec?.frozen)throw new Error('Run-package export requires a frozen specification.');
      const link=state.pipeline?.filter(r=>r.kind==='LINK'&&r.branchId===branch.id).at(-1);
      if(!link||link.kind!=='LINK')throw new Error('Exact candidate link is missing.');
      const request=state.requests?.find(r=>r.id===link.requestId);
      if(!request||request.revision!==link.requestRevision||request.status==='CANCELED')throw new Error('Linked request changed before package export.');
      const m=input.manifest;
      if(m.branchId!==branch.id||m.branchRevision!==branch.revision||m.projectId!==branch.projectId||m.specId!==branch.specId
        ||m.specHash!==spec.contentHash||m.subjectHash!==link.subjectHash||m.requestId!==request.id||m.requestRevision!==request.revision)
        throw new Error('Run package names different research than the current branch.');
      if(runPackageHash({schemaVersion:1,kind:'RUN_PACKAGE',projectId:m.projectId,branchId:m.branchId,branchRevision:m.branchRevision,specId:m.specId,
        specHash:m.specHash,subjectHash:m.subjectHash,requestId:m.requestId,requestRevision:m.requestRevision,entries:m.entries,environment:m.environment,
        expectedReturn:m.expectedReturn,instructions:m.instructions})!==m.packageHash||runPackageId(m.packageHash)!==m.packageId)
        throw new Error('Run-package identity does not recompute.');
      for(const gate of ['G-PORTFOLIO','G-COST','G-ECON'] as const)
        if(!m.expectedReturn.requiredGates.includes(gate))throw new Error('The run package must require the user-run evidence for '+gate+'.');
      const prior=(state.pipeline??[]).filter(r=>r.kind==='RUN_PACKAGE'&&r.branchId===branch.id&&r.branchRevision===branch.revision).at(-1);
      if(prior&&prior.kind==='RUN_PACKAGE'){
        if(prior.packageId!==m.packageId)throw new Error('A different run package is already frozen for this branch revision. Amend the branch to change it.');
        result={packageId:prior.packageId,existing:true};return;
      }
      const trial=(state.trials??[]).find(t=>t.branchId===branch.id&&t.variantHash===link.subjectHash);
      const now=new Date().toISOString();
      const record=pipelineRecordSchema.parse({id:randomUUID(),kind:'RUN_PACKAGE',projectId:branch.projectId,branchId:branch.id,createdAt:now,
        packageId:m.packageId,packageHash:m.packageHash,specId:m.specId,specHash:m.specHash,subjectHash:m.subjectHash,
        branchRevision:m.branchRevision,requestRevision:m.requestRevision,expectedFiles:m.expectedReturn.files,requiredGates:m.expectedReturn.requiredGates,
        objectHash:input.objectHash,state:'AWAITING_RETURN',exportedAt:m.exportedAt,detail:m.instructions.slice(0,4000)});
      this.append(state,[{collection:'pipeline',value:record},
        {collection:'attempts',value:{id:randomUUID(),branchId:branch.id,stage:'S3',assignmentId:null,trialId:trial?.id??null,state:'OPEN',summary:'Awaiting the user-run return for package '+m.packageId+'.',createdAt:now,settledAt:''}}],
        {kind:'RESEARCH_RUN_PACKAGE',projectId:branch.projectId,experimentId:null,reason:'Exported the frozen user-run package; the branch now waits for the manual return with no execution job anywhere.'},null);
      result={packageId:m.packageId,existing:false};
    });
    return result;
  }

  /**
   * S3 import: binds returned bytes to the frozen package. Wrong package, changed lineage, a
   * conflicting duplicate or an incomplete required-gate answer set are rejected. An eligible return
   * is admitted as USER_IMPORTED; its gate rows become USER_RUN receipts and the office writes its
   * own G-ARTIFACT receipt for the transfer binding. Nothing is promoted to provider or harness
   * evidence. A failed-execution return is recorded without completing the stage — the branch waits
   * for direction rather than advancing on absent evidence.
   */
  admitRunReturn(input:{branchId:string;expectedRevision:number;artifactId:string;manifest:RunReturnManifest;manifestHash:string;outputHashes:string[]}):void{
    this.transaction(()=>{
      const state=this.readProjection(),branch=state.branches?.find(b=>b.id===input.branchId);
      if(!branch||branch.revision!==input.expectedRevision||branch.stage!=='S3'||branch.outcome!=='IN_PROGRESS')throw new Error('Run-return import requires the current S3 branch.');
      this.activeProject(state,branch.projectId);
      const spec=state.specs?.find(s=>s.id===branch.specId);
      if(!spec?.frozen)throw new Error('Return admission requires a frozen specification.');
      const link=state.pipeline?.filter(r=>r.kind==='LINK'&&r.branchId===branch.id).at(-1);
      if(!link||link.kind!=='LINK')throw new Error('Exact candidate link is missing.');
      const request=state.requests?.find(r=>r.id===link.requestId);
      if(!request||request.revision!==link.requestRevision||request.status==='CANCELED')throw new Error('Linked request changed before return admission.');
      const pkg=(state.pipeline??[]).filter(r=>r.kind==='RUN_PACKAGE'&&r.branchId===branch.id&&r.branchRevision===branch.revision).at(-1);
      if(!pkg||pkg.kind!=='RUN_PACKAGE'||pkg.state==='SUPERSEDED')throw new Error('No awaiting run package exists for this branch revision.');
      const m=input.manifest;
      if(m.packageId!==pkg.packageId||m.packageHash!==pkg.packageHash||m.branchId!==branch.id||m.specId!==branch.specId
        ||m.specHash!==pkg.specHash||m.subjectHash!==link.subjectHash)throw new Error('Returned bundle names a different package, subject or specification.');
      if(!state.artifacts.some(a=>a.id===input.artifactId&&a.projectId===branch.projectId))throw new Error('Returned bundle must be imported bytes in this project.');
      const priorReturn=(state.pipeline??[]).find(r=>r.kind==='RUN_RETURN'&&r.packageId===pkg.packageId);
      if(priorReturn&&priorReturn.kind==='RUN_RETURN'){
        if(priorReturn.manifestHash!==input.manifestHash)throw new Error('A different return is already admitted for this package; conflicting returns are rejected, never merged.');
        return;
      }
      // The inventory is closed: every returned file must have been declared by the package, a
      // completed return must carry all of them, and no path may repeat.
      const declared=new Set(pkg.expectedFiles);
      if(m.artifacts.some(a=>!declared.has(a.path)))throw new Error('The return carries files the package did not declare.');
      if(new Set(m.artifacts.map(a=>a.path)).size!==m.artifacts.length)throw new Error('Duplicate artifact paths in the return manifest.');
      if(input.outputHashes.some(h=>!m.artifacts.some(a=>a.sha256===h)))throw new Error('Returned objects do not match the manifest inventory.');
      if(m.status!=='EXECUTION_FAILED'){
        for(const file of declared)if(!m.artifacts.some(a=>a.path===file))throw new Error('The return is incomplete: missing expected file '+file+'.');
        for(const gate of pkg.requiredGates)if(!m.gates.some(g=>g.gate===gate))throw new Error('The return is incomplete: it does not report the required gate '+gate+'.');
      }
      const now=new Date().toISOString(),changes:Change[]=[
        {collection:'pipeline',value:pipelineRecordSchema.parse({id:randomUUID(),kind:'RUN_RETURN',projectId:branch.projectId,branchId:branch.id,createdAt:now,
          packageId:pkg.packageId,packageHash:pkg.packageHash,specId:branch.specId,subjectHash:link.subjectHash,artifactId:input.artifactId,manifestHash:input.manifestHash,
          outputHashes:input.outputHashes,status:m.status,verification:'USER_IMPORTED',summary:m.detail.slice(0,4000)})},
        {collection:'pipeline',value:{...pkg,state:'RETURNED' as const,returnManifestHash:input.manifestHash}}];
      for(const row of m.gates){
        if(!STAGE_GATES[row.stage]?.includes(row.gate))throw new Error('Returned gate '+row.gate+' does not belong to '+row.stage+'.');
        if(!['S5','S6'].includes(row.stage))continue;
        if(row.outcome==='NOT_APPLICABLE'&&(!row.rationale.trim()||!spec.notApplicable.some(n=>n.gate===row.gate&&n.rationale.trim())))throw new Error('Returned inapplicability must be prospectively frozen in the specification.');
        changes.push({collection:'receipts',value:receiptSchema.parse({id:randomUUID(),branchId:branch.id,stage:row.stage,gate:row.gate,outcome:row.outcome,
          subjectHash:link.subjectHash,specId:branch.specId,detail:row.detail.trim()||'Reported by the bound user-run return.',rationale:row.rationale.trim()||'User-run report.',
          evidenceRef:input.manifestHash,provenance:'USER_RUN',createdAt:now})});
      }
      changes.push({collection:'receipts',value:receiptSchema.parse({id:randomUUID(),branchId:branch.id,stage:'S3',gate:'G-ARTIFACT',outcome:'PASS',
        subjectHash:link.subjectHash,specId:branch.specId,detail:'Package-bound return admitted; manifest identity and artifact hashes verified against the frozen export.',
        rationale:'Transfer integrity check by the office.',evidenceRef:input.manifestHash,provenance:'OFFICE',createdAt:now})});
      if(m.status==='EXECUTION_FAILED'){
        this.append(state,changes,{kind:'RESEARCH_RUN_RETURN',projectId:branch.projectId,experimentId:null,reason:'Admitted a bound user-run return reporting failed execution; the branch awaits direction, not advancement.'},null);
        return;
      }
      const attempt=(state.attempts??[]).find(a=>a.branchId===branch.id&&a.stage==='S3'&&a.state==='OPEN'&&a.assignmentId===null);
      if(!attempt)throw new Error('The durable wait attempt for the package is missing.');
      changes.push({collection:'attempts',value:{...attempt,state:'COMPLETED',summary:'Bound return admitted for package '+pkg.packageId+'.',settledAt:now}},
        {collection:'pipeline',value:pipelineRecordSchema.parse({id:randomUUID(),kind:'STAGE_COMPLETION',projectId:branch.projectId,branchId:branch.id,createdAt:now,
          assignmentId:null,jobId:null,attemptId:attempt.id,specId:branch.specId,subjectHash:link.subjectHash,contextHash:pkg.packageHash,reportHash:input.manifestHash,
          stage:'S3',branchRevision:branch.revision,requestRevision:link.requestRevision,provenance:'USER_IMPORTED'})});
      this.append(state,changes,{kind:'RESEARCH_RUN_RETURN',projectId:branch.projectId,experimentId:null,reason:'Admitted a bound user-run return; user-run provenance retained on every record.'},null);
    });
  }

  /**
   * Manual collection of a stage report the user carried back instead of a provider-observed job.
   * Every binding provider collection enforces is enforced here — context hash, branch/spec/subject
   * scope, open attempt — with USER_IMPORTED provenance on the completion. S2/S7 reports must belong
   * to a separated round; a signed round still collects only through its provider-observed contexts.
   */
  admitImportedStageReport(input:{assignmentId:string;reportHash:string;bytes:Uint8Array}):void{
    this.transaction(()=>{
      const state=this.readProjection(),assignment=state.assignments?.find(a=>a.id===input.assignmentId);
      const research=assignment?.research;
      const branch=state.branches?.find(b=>b.id===research?.branchId);
      if(!assignment||!research||!branch||branch.revision!==research.branchRevision||branch.stage!==research.stage||branch.outcome!=='IN_PROGRESS')
        throw new Error('Report import requires a current exact-stage assignment.');
      this.activeProject(state,branch.projectId);
      this.assertStagePreparation(branch.id,branch.revision);
      const spec=state.specs?.find(s=>s.id===branch.specId);
      if(!spec?.frozen)throw new Error('Report admission requires a frozen specification.');
      const signedDeclared=new Set((spec.gateEvidence??[]).filter(g=>g.tier==='SIGNED_HARNESS').map(g=>g.gate));
      const link=state.pipeline?.filter(r=>r.kind==='LINK'&&r.branchId===branch.id).at(-1);
      if(!link||link.kind!=='LINK'||link.subjectHash!==research.subjectHash)throw new Error('Exact candidate link is missing.');
      const request=state.requests?.find(r=>r.id===link.requestId);
      if(!request||request.revision!==link.requestRevision||request.status==='CANCELED'||assignment.requestId!==request.id||assignment.requestRevision!==request.revision)
        throw new Error('Linked request changed before report admission.');
      if(stageContextHash({...research,agentId:assignment.agentId,agentRevision:assignment.agentRevision,inputs:research})!==research.contextHash)
        throw new Error('Assignment context no longer recomputes.');
      if(sha256(input.bytes)!==input.reportHash)throw new Error('Stage report hash mismatch.');
      const report=stageReportSchema.parse(parseStrictJson(Buffer.from(input.bytes).toString('utf8')));
      if(report.contextHash!==research.contextHash||report.branchId!==branch.id||report.specId!==branch.specId||report.subjectHash!==research.subjectHash||report.stage!==branch.stage)
        throw new Error('Imported report names different research than the assignment context.');
      const previous=(state.pipeline??[]).find(r=>r.kind==='STAGE_COMPLETION'&&r.assignmentId===assignment.id);
      if(previous){if(previous.kind!=='STAGE_COMPLETION'||previous.reportHash!==input.reportHash)throw new Error('Conflicting stage completion report.');return;}
      const attempt=(state.attempts??[]).find(a=>a.assignmentId===assignment.id&&a.state==='OPEN');
      if(!attempt)throw new Error('Stage completion requires a durable open attempt.');
      const now=new Date().toISOString(),changes:Change[]=[];
      if(new Set(report.gates.map(g=>g.gate)).size!==report.gates.length)throw new Error('Duplicate gates in one report.');
      for(const g of report.gates){
        if(!STAGE_GATES[branch.stage].includes(g.gate))throw new Error(`${g.gate} does not belong to ${branch.stage}.`);
        if((g.outcome==='PASS'||g.outcome==='NOT_APPLICABLE')&&signedDeclared.has(g.gate))throw new Error('Imported reports cannot approve a gate the frozen specification declares signed-harness evidence.');
        if(g.outcome==='NOT_APPLICABLE'&&(!g.rationale.trim()||!spec.notApplicable.some(n=>n.gate===g.gate&&n.rationale.trim())))throw new Error('Gate inapplicability must be prospectively frozen.');
        changes.push({collection:'receipts',value:receiptSchema.parse({id:randomUUID(),branchId:branch.id,stage:branch.stage,gate:g.gate,outcome:g.outcome,
          subjectHash:research.subjectHash,specId:branch.specId,detail:g.detail.trim()||'Imported stage report.',rationale:g.rationale.trim()||'See report.',
          evidenceRef:input.reportHash,provenance:'REVIEWER_ASSERTED',createdAt:now})});
      }
      if(report.realisedPrediction){
        const prediction=state.predictions?.find(p=>p.id===report.realisedPrediction!.predictionId&&p.branchId===branch.id&&p.specId===branch.specId&&p.outcomeName===report.realisedPrediction!.outcomeName);
        if(!prediction)throw new Error('A realised forecast outcome requires the exact registered metric.');
        if(state.pipeline?.some(r=>r.kind==='FORECAST_OUTCOME'&&r.predictionId===prediction.id))throw new Error('A registered forecast has already been scored; historical outcomes are immutable.');
        changes.push({collection:'pipeline',value:{id:randomUUID(),kind:'FORECAST_OUTCOME',projectId:branch.projectId,branchId:branch.id,createdAt:now,
          predictionId:prediction.id,specId:prediction.specId,subjectHash:link.subjectHash,reportHash:input.reportHash,value:report.realisedPrediction.value}});
      }
      changes.push({collection:'attempts',value:{...attempt,state:'COMPLETED',summary:report.detail.slice(0,4000),settledAt:now}},
        {collection:'pipeline',value:pipelineRecordSchema.parse({id:randomUUID(),kind:'STAGE_COMPLETION',projectId:branch.projectId,
          branchId:branch.id,createdAt:now,assignmentId:assignment.id,jobId:null,attemptId:attempt.id,specId:research.specId,
          subjectHash:research.subjectHash,contextHash:research.contextHash,reportHash:input.reportHash,stage:research.stage,
          branchRevision:research.branchRevision,requestRevision:research.requestRevision,provenance:'USER_IMPORTED'})});
      if(research.stage==='S2'||research.stage==='S7'){
        const round=this.isolatedResearchContext(state,assignment);
        if(!round||round.source!=='SEPARATED')throw new Error('A signed review round collects reports only through its provider-observed contexts; import is the separated tier.');
        if(report.verdict===undefined||report.defectFound===undefined)throw new Error('A review report must carry a verdict and defect finding.');
        const reports=(state.pipeline??[]).filter((r):r is Extract<PipelineRecord,{kind:'REVIEW_REPORT'}>=>r.kind==='REVIEW_REPORT'&&r.roundId===round.roundId);
        if(reports.some(r=>r.assignmentId===assignment.id||state.assignments?.find(a=>a.id===r.assignmentId)?.agentId===assignment.agentId))throw new Error('This reviewer has already committed its first report.');
        const review:Extract<PipelineRecord,{kind:'REVIEW_REPORT'}>={id:randomUUID(),kind:'REVIEW_REPORT',roundId:round.roundId,projectId:branch.projectId,branchId:branch.id,createdAt:now,
          assignmentId:assignment.id,subjectHash:research.subjectHash,specId:research.specId,reportHash:input.reportHash,expectedReviewerIds:round.contexts.map(c=>c.agentId),stage:research.stage,
          verdict:report.verdict,defectFound:report.defectFound,detail:report.detail,opened:false,independence:'SEPARATE_SESSION_UNVERIFIED'};
        const sealed:SealedReviewReport={id:randomUUID(),projectId:branch.projectId,subjectAssignmentId:round.subjectAssignmentId,reviewerAgentId:assignment.agentId,phase:'FIRST',contentHash:input.reportHash,sealedAt:now,openedAt:null};
        const all=[...reports,review];
        const complete=round.contexts.every(c=>all.some(r=>state.assignments?.find(a=>a.id===r.assignmentId)?.agentId===c.agentId));
        changes.push({collection:'pipeline',value:{...review,opened:complete}},{collection:'sealed',value:{...sealed,openedAt:complete?now:null}});
        if(complete){
          for(const r of reports)changes.push({collection:'pipeline',value:{...r,opened:true}});
          for(const r of state.sealed??[])if(r.subjectAssignmentId===round.subjectAssignmentId&&round.contexts.some(c=>c.agentId===r.reviewerAgentId)&&r.openedAt===null)changes.push({collection:'sealed',value:{...r,openedAt:now}});
        }
      }
      this.append(state,changes,{kind:'RESEARCH_REPORT_IMPORTED',projectId:branch.projectId,experimentId:null,reason:'Admitted a user-carried stage report bound to the exact assignment context; provenance stays USER_IMPORTED.'},null);
    });
  }

  /**
   * Office stages (S5, S6, S8, S9, S10): no agent runs them and no provider reports them — the office
   * validates the bound evidence already admitted and completes the stage under OFFICE_VALIDATED
   * provenance. S5/S6 confirm the user-run return's gate receipts pass; S8 the completed custody
   * exposure; S9/S10 the admitted shadow verdicts. A stage whose evidence reports failure simply does
   * not complete — the branch awaits direction.
   */
  validateOfficeStage(input:{branchId:string;expectedRevision:number}):void{
    this.transaction(()=>{
      const state=this.readProjection(),branch=state.branches?.find(b=>b.id===input.branchId);
      if(!branch||branch.revision!==input.expectedRevision||branch.outcome!=='IN_PROGRESS')throw new Error('Stage validation is stale or settled.');
      this.activeProject(state,branch.projectId);
      if(STAGE_DELIVERY[branch.stage]!=='OFFICE')throw new Error(branch.stage+' is not an office-validated stage.');
      this.assertStagePreparation(branch.id,branch.revision);
      const link=state.pipeline?.filter(r=>r.kind==='LINK'&&r.branchId===branch.id).at(-1);
      if(!link||link.kind!=='LINK')throw new Error('Exact candidate link is missing.');
      const request=state.requests?.find(r=>r.id===link.requestId);
      if(!request||request.revision!==link.requestRevision||request.status==='CANCELED')throw new Error('Linked request changed before stage validation.');
      if((state.pipeline??[]).some(r=>r.kind==='STAGE_COMPLETION'&&r.branchId===branch.id&&r.branchRevision===branch.revision&&r.stage===branch.stage&&r.subjectHash===link.subjectHash))return;
      const now=new Date().toISOString(),changes:Change[]=[];
      let reportHash='',contextHash='';
      const officeReceipt=(gate:GateReceipt['gate'],outcome:GateReceipt['outcome'],detail:string,rationale:string,evidenceRef:string)=>{
        const latest=(state.receipts??[]).filter(r=>r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash&&r.gate===gate).at(-1);
        if(latest&&latest.outcome===outcome&&latest.evidenceRef===evidenceRef)return;
        changes.push({collection:'receipts',value:receiptSchema.parse({id:randomUUID(),branchId:branch.id,stage:branch.stage,gate,outcome,
          subjectHash:link.subjectHash,specId:branch.specId,detail,rationale,evidenceRef,provenance:'OFFICE',createdAt:now})});
      };
      if(branch.stage==='S5'||branch.stage==='S6'){
        const ret=(state.pipeline??[]).filter(r=>r.kind==='RUN_RETURN'&&r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash).at(-1);
        if(!ret||ret.kind!=='RUN_RETURN'||ret.status!=='COMPLETED')throw new Error('No completed user-run return exists for this subject.');
        for(const gate of STAGE_GATES[branch.stage]){
          const receipt=(state.receipts??[]).filter(r=>r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash&&r.gate===gate).at(-1);
          if(!receipt||!['PASS','NOT_APPLICABLE'].includes(receipt.outcome))throw new Error(gate+' has no passing admitted evidence from the bound return.');
        }
        reportHash=ret.manifestHash;contextHash=ret.packageHash;
      }else if(branch.stage==='S8'){
        const reservation=(state.pipeline??[]).filter(r=>r.kind==='RESERVATION'&&r.branchId===branch.id&&r.reservation.candidateHash===link.subjectHash).at(-1);
        const result=(state.pipeline??[]).filter(r=>r.kind==='HOLDOUT_RESULT'&&r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash).at(-1);
        if(!reservation||reservation.kind!=='RESERVATION'||reservation.reservation.state!=='EXPOSED'||!reservation.reservation.reportHash||!result||result.kind!=='HOLDOUT_RESULT')
          throw new Error('S8 requires a completed custody exposure with an admitted result.');
        officeReceipt('G-INTEGRITY','PASS','Custody exposure completed under the export/import chain; result bound to the reservation.','Office validation of the manual custody path.',result.reportHash);
        reportHash=result.reportHash;contextHash=reservation.reservation.reportHash;
      }else{
        const verdict=(state.pipeline??[]).filter(r=>r.kind==='MONITOR_VERDICT'&&r.branchId===branch.id&&r.specId===branch.specId&&r.subjectHash===link.subjectHash).at(-1);
        if(!verdict||verdict.kind!=='MONITOR_VERDICT')throw new Error(branch.stage+' requires an admitted monitor verdict.');
        const qualified=verdict.outcome==='SHADOW_QUALIFIED';
        if(branch.stage==='S9'){
          officeReceipt('G-SHADOW',qualified?'PASS':'FAIL','Office replay of the prospective shadow batches under the frozen policy: '+verdict.outcome+'.','Office validation of shadow evidence.',canonicalHash(verdict));
          if(!qualified){this.append(state,changes,{kind:'RESEARCH_OFFICE_STAGE',projectId:branch.projectId,experimentId:null,reason:'Recorded the office shadow-gate outcome; the stage does not complete on unqualified evidence.'},null);return;}
        }
        reportHash=canonicalHash(verdict);contextHash=canonicalHash(verdict);
      }
      const trial=(state.trials??[]).find(t=>t.branchId===branch.id&&t.variantHash===link.subjectHash);
      const attemptId=randomUUID();
      changes.push({collection:'attempts',value:{id:attemptId,branchId:branch.id,stage:branch.stage,assignmentId:null,trialId:trial?.id??null,state:'COMPLETED',
        summary:'Office validation of bound '+branch.stage+' evidence.',createdAt:now,settledAt:now}},
        {collection:'pipeline',value:pipelineRecordSchema.parse({id:randomUUID(),kind:'STAGE_COMPLETION',projectId:branch.projectId,branchId:branch.id,createdAt:now,
          assignmentId:null,jobId:null,attemptId,specId:branch.specId,subjectHash:link.subjectHash,contextHash,reportHash,stage:branch.stage,
          branchRevision:branch.revision,requestRevision:link.requestRevision,provenance:'OFFICE_VALIDATED'})});
      this.append(state,changes,{kind:'RESEARCH_OFFICE_STAGE',projectId:branch.projectId,experimentId:null,reason:'Completed '+branch.stage+' by validating the bound admitted evidence; office-validated provenance, not agent or harness evidence.'},null);
    });
  }

  beginHarness(assignmentId:string,reportHash:string):{operationId:string;existing:boolean}{
    let result={operationId:'',existing:false};
    this.transaction(()=>{
      const state=this.readProjection(),assignment=state.assignments?.find(a=>a.id===assignmentId),context=assignment?.research;
      const branch=state.branches?.find(b=>b.id===context?.branchId),job=state.jobs?.find(j=>j.assignmentId===assignmentId);
      if(!assignment||!context||!branch||branch.revision!==context.branchRevision||branch.stage!==context.stage||branch.outcome!=='IN_PROGRESS'
        ||job?.state!=='COMPLETED'||job.evidence!=='PROVIDER_REPORTED'||!job.outputs.some(o=>o.stored&&o.sha256===reportHash))throw new Error('Harness intent requires a current completed exact-report assignment.');
      this.activeProject(state,branch.projectId);
      const prior=state.pipeline?.find(r=>r.kind==='HARNESS_INTENT'&&r.assignmentId===assignmentId);
      if(prior&&prior.kind==='HARNESS_INTENT'){
        if(prior.reportHash!==reportHash)throw new Error('A different report already owns this harness operation.');
        result={operationId:prior.id,existing:true};return;
      }
      const record=pipelineRecordSchema.parse({id:randomUUID(),kind:'HARNESS_INTENT',projectId:branch.projectId,branchId:branch.id,createdAt:new Date().toISOString(),assignmentId,reportHash,status:'OPEN'});
      this.append(state,[{collection:'pipeline',value:record}],{kind:'HARNESS_INTENT',projectId:branch.projectId,experimentId:null,reason:'Reserved one independent evaluation before invoking the transport. Unresolved execution is reconciled, never resubmitted.'},null);
      result={operationId:record.id,existing:false};
    });
    return result;
  }

  private transaction(operation: () => void): AppState {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try { operation(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.snapshot({history:this.includeHistoryInResults});
  }

  execute(input: unknown): AppState {
    const command = commandSchema.parse(input) as Command;
    return this.transaction(() => {
      const replay = this.db.prepare('SELECT payload_hash FROM commands WHERE idempotency_key=?').get(command.idempotencyKey);
      if (replay) {
        if (replay.payload_hash !== canonicalHash(command)) throw new Error('Idempotency key was already used for a different command');
        return;
      }
      const state = this.readProjection();
      const now = new Date().toISOString();
      const changes: Change[] = [];
      let projectId: string | null = null;
      let experimentId: string | null = null;
      let reason = '';
      const blockedTask = (prompt: string, recipient: ResearchTask['recipient']): z.infer<typeof taskSchema> => ({ id: randomUUID(), projectId: projectId!, experimentId, prompt, recipient, status: 'BLOCKED', blocker: state.agents?.some(a=>!a.removedAt) ? 'Provider-hosted execution is not configured' : 'No agents configured', createdAt: now, updatedAt: now });
      switch (command.type) {
        case 'project.create': {
          if(command.localFolder&&(!isAbsolute(command.localFolder)||!safeStat(command.localFolder)?.isDirectory()))throw new Error('Choose an existing project folder');
          const project: Project = { ...(command.localFolder?{localFolder:realpathSync(command.localFolder)}:{}),...(command.cloudWorkspace?{cloudWorkspace:command.cloudWorkspace}:{}), id: randomUUID(), name: command.name, mandate: command.mandate, budgetCents: command.budgetCents, archived: false, createdAt: now, updatedAt: now };
          projectId = project.id; changes.push({ collection: 'projects', value: project });
          // The dialog's folder field and the location record are one scope: create the record in
          // the same transaction so a snapshot prepared later actually reads it.
          if(command.localFolder)upsertLocationScope(state,changes,project,realpathSync(command.localFolder),now);
          reason = `Created project: ${project.name}`; break;
        }
        case 'project.update': {
          if(command.localFolder&&(!isAbsolute(command.localFolder)||!safeStat(command.localFolder)?.isDirectory()))throw new Error('Choose an existing project folder');
          const project = this.activeProject(state, command.projectId); projectId = project.id;
          const folderMoved=command.localFolder!==undefined&&upsertLocationScope(state,changes,project,command.localFolder.trim()?realpathSync(command.localFolder.trim()):'',now);
          changes.push({ collection: 'projects', value: { ...project,...(command.localFolder!==undefined?{localFolder:command.localFolder?realpathSync(command.localFolder):''}:{}),...(command.cloudWorkspace!==undefined?{cloudWorkspace:command.cloudWorkspace}:{}), name: command.name, mandate: command.mandate, budgetCents: command.budgetCents, updatedAt: now } }); reason = `Updated project mandate and spending ceiling${folderMoved?' · project folder updated':''}`; break;
        }
        case 'project.archive': {
          const project = state.projects.find(item => item.id === command.projectId);
          if (!project) throw new Error('Project not found');
          projectId = project.id;
          // Un-archiving a removed project is the recovery path: the removal clears and the
          // project lands in the archived list — a second restore activates it — so a mistaken
          // remove is recoverable while pickers stay clean. removedAt is destructured out, not
          // written as undefined, which canonical serialization rejects.
          if (project.removedAt && !command.archived) {
            const { removedAt: _removed, ...restored } = project;
            changes.push({ collection: 'projects', value: { ...restored, archived: true, updatedAt: now } });
            reason = `Restored removed project "${project.name}" to the archived list`; break;
          }
          changes.push({ collection: 'projects', value: { ...project, archived: command.archived, updatedAt: now } });
          if(command.archived&&state.requests?.some(r=>r.projectId===project.id&&r.status!=='CANCELED'))throw new Error('Cancel outstanding requests before archiving this project.');
          if (command.archived && state.tasks.some(item => item.projectId === project.id && !['CANCELED','ACCEPTED','SUPERSEDED'].includes(item.status))) throw new Error('Cancel outstanding requests before archiving this project. Restore never resumes work.');
          reason = command.archived ? 'Archived project; outcomes retained' : 'Restored project'; break;
        }
        case 'project.delete': {
          // Removal only hides the project from pickers and lists. Its requests, experiments,
          // lineage events, location record and stored bytes are all retained — like task.delete,
          // this never rewrites history. Archiving already guarantees every request and task under
          // the project is terminal, so the remaining guard is unresolved provider work: an UNKNOWN
          // outcome still in flight must stay reachable through its request until reconciled.
          const project = state.projects.find(item => item.id === command.projectId);
          if (!project) throw new Error('Project not found');
          projectId = project.id;
          if (project.removedAt) throw new Error('This project is already removed from the list');
          if (!project.archived) throw new Error('Archive the project before removing it from the list');
          for (const request of (state.requests ?? []).filter(item => item.projectId === project.id && !item.removedAt))
            if (requestJobs(state, request.id).some(job => job.unresolved))
              throw new Error('A provider job outcome is still unresolved; reconcile it before removing this project');
          changes.push({ collection: 'projects', value: { ...project, removedAt: now, updatedAt: now } });
          reason = `Removed archived project "${project.name}" from lists; records and history retained`; break;
        }
        case 'agent.update':
        case 'agent.remove':
        case 'agent.delete': {
          const agent=state.agents?.find(a=>a.id===command.agentId);if(!agent)throw new Error('Agent not found');
          if(command.type==='agent.update'){if(agent.removedAt)throw new Error('Restore this agent before editing');if(command.expectedRevision!==(agent.revision??0))throw new Error('Stale profile revision; reload before saving');changes.push({collection:'agents',value:{...agent,revision:(agent.revision??0)+1,name:command.name,team:command.team,role:command.role,instructions:command.instructions}});reason=`Updated ${command.name} profile`;}
          else if(command.type==='agent.delete'){
            // Same removal lifecycle as projects: archiving already guarantees the profile is
            // read-only, and removal only hides it — the record, memberships, assignments and
            // lineage all stay. An unresolved provider outcome under this agent's assignments
            // must remain reachable until reconciled.
            if(agent.deletedAt)throw new Error('This agent is already removed from the list');
            if(!agent.removedAt)throw new Error('Archive the agent before removing it from the list');
            const assigned=new Set((state.assignments??[]).filter(item=>item.agentId===agent.id).map(item=>item.id));
            if((state.jobs??[]).some(job=>assigned.has(job.assignmentId)&&UNRESOLVED.includes(job.state)))throw new Error('A provider job outcome is still unresolved; reconcile it before removing this agent');
            changes.push({collection:'agents',value:{...agent,deletedAt:now}});reason=`Removed archived agent "${agent.name}" from lists; records and history retained`;
          }
          else {
            const {removedAt,deletedAt,...active}=agent;
            if(command.removed&&agent.deletedAt)throw new Error('Restore this agent before changing it');
            // Restoring a removed agent clears only the removal so it lands in the archived
            // list; a second restore reactivates it, mirroring project.archive.
            changes.push({collection:'agents',value:command.removed?{...agent,revision:(agent.revision??0)+1,removedAt:now}:agent.deletedAt?{...active,removedAt:agent.removedAt,revision:(agent.revision??0)+1}:{...active,revision:(agent.revision??0)+1}});
            reason=`${command.removed?'Archived':'Restored'} ${agent.name}; history retained`;
          }
          break;
        }
        case 'request.pipeline.note':
        case 'request.pipeline.confirm': {
          const request=state.requests?.find(r=>r.id===command.requestId);if(!request)throw new Error('Request not found');
          this.activeProject(state,request.projectId);projectId=request.projectId;experimentId=request.experimentId;
          if(request.revision!==command.expectedRevision)throw new Error('Stale request revision; reload before continuing');
          if(request.status==='CANCELED')throw new Error('Canceled requests are read-only.');
          if(!request.pipeline)throw new Error('Only planning or result-analysis requests carry a pipeline.');
          if(command.type==='request.pipeline.note'){
            if(request.status!=='READY'||request.pipeline.phase!=='BRIEFING')throw new Error('Director notes land only while the request is briefing.');
            changes.push({collection:'requests',value:{...request,pipelineNotes:[...(request.pipelineNotes??[]),{id:randomUUID(),text:command.text,createdAt:now}],revision:request.revision+1,updatedAt:now}});
            reason='Director note recorded; the office queues a brief refinement hop';break;
          }
          if(request.status!=='READY')throw new Error('This pipeline is not running.');
          if(request.pipeline.phase==='BRIEFING'){
            if(!request.pipeline.briefAssignmentId)throw new Error('No director brief hop exists yet — start the request first.');
            const briefJob=state.jobs?.find(item=>item.assignmentId===request.pipeline!.briefAssignmentId);
            if(!briefJob||briefJob.state!=='COMPLETED')throw new Error('The director brief has not completed — the shaped brief must exist before the pipeline launches.');
            reason='Pipeline confirmed; the office mints the remaining hops';
          }else reason='Pipeline re-confirmed; the office retries any unminted hops';
          // Re-confirm on a launched pipeline is the mint-retry path: the record is unchanged,
          // the revision bump gives the renderer a fresh expectedRevision, and the office's
          // post-command mint skips already-minted hops by pipelineKey.
          changes.push({collection:'requests',value:{...request,pipeline:{...request.pipeline,phase:'LAUNCHED'},revision:request.revision+1,updatedAt:now}});
          break;
        }
        case 'request.pipeline.decide': {
          const request=state.requests?.find(r=>r.id===command.requestId);if(!request)throw new Error('Request not found');
          this.activeProject(state,request.projectId);projectId=request.projectId;experimentId=request.experimentId;
          if(request.revision!==command.expectedRevision)throw new Error('Stale request revision; reload before continuing');
          if(request.status==='CANCELED')throw new Error('Canceled requests are read-only.');
          const pipeline=request.pipeline;if(!pipeline)throw new Error('Only planning or result-analysis requests carry a pipeline.');
          const pending=pipeline.pendingDecision;
          const note=command.note?.trim()||null;
          // Idempotent replay: the identical recorded decision acknowledges again without
          // writing a second record. A different decision after DECIDED is a refusal.
          if(pipeline.phase==='DECIDED'&&pipeline.decision){
            const prior=pipeline.decision;
            if(prior.decision===command.decision&&prior.note===note&&prior.specHash===command.expectedSpecHash&&prior.headReceiptHash===command.expectedReceiptHash)break;
            throw new Error(`A ${prior.decision.toLowerCase()} decision is already recorded against this round — the record is append-only.`);
          }
          if(pipeline.phase!=='AWAITING_DECISION'||!pending)throw new Error('This pipeline is not awaiting a decision — the terminal hop must verify first.');
          // Staleness gate: the decision must name the exact spec and verified report receipt
          // the UI displayed. Anything else approved nothing.
          if(command.expectedSpecHash!==pending.specHash||command.expectedReceiptHash!==pending.headReceiptHash)
            throw new Error('The decision is stale — the displayed report or round changed since it was viewed. Reload and review the current artifacts.');
          changes.push({collection:'requests',value:{...request,pipeline:{...pipeline,phase:'DECIDED' as const,decision:{decision:command.decision,note,specHash:pending.specHash,headReceiptHash:pending.headReceiptHash,decidedAt:now}},revision:request.revision+1,updatedAt:now}});
          reason=`Round decision recorded: ${command.decision.toLowerCase()}, bound to the verified report receipt`;
          break;
        }
        case 'memory.finding.note': {
          const project=this.activeProject(state,command.projectId);projectId=project.id;experimentId=null;
          if(command.requestId){const request=state.requests?.find(r=>r.id===command.requestId);if(!request||request.projectId!==project.id)throw new Error('The note names a request outside this project.');}
          const refs=command.evidenceRefs??[];assertFindingRefs(state,project.id,refs);
          const finding:MemoryFinding={id:randomUUID(),projectId:project.id,requestId:command.requestId??null,assignmentId:null,
            kind:command.kind,title:command.title.trim(),body:command.body.trim(),evidenceRefs:refs,
            createdBy:{surface:'USER'},createdAt:now};
          changes.push(...appendFinding(state,finding,command.supersedesFindingId));
          reason='Recorded a memory finding.';
          break;
        }
        case 'memory.relationship.settle': {
          const relationship=state.relationships?.find(item=>item.id===command.relationshipId);
          if(!relationship)throw new Error('Relationship not found.');
          this.activeProject(state,relationship.projectId);projectId=relationship.projectId;experimentId=null;
          if(relationship.status!=='PROPOSED')throw new Error(`That link is already ${relationship.status.toLowerCase()} — the record is append-only.`);
          changes.push({collection:'relationships',value:{...relationship,status:command.status,decidedAt:now}});
          reason=`A proposed ${relationship.kind.toLowerCase()} link was ${command.status.toLowerCase()} by the user.`;
          break;
        }
        case 'request.update':
        case 'request.start':
        case 'request.cancel':
        case 'request.duplicate': {
          const request=state.requests?.find(r=>r.id===command.requestId);if(!request)throw new Error('Request not found');
          this.activeProject(state,request.projectId);projectId=request.projectId;experimentId=request.experimentId;
          if(request.revision!==command.expectedRevision)throw new Error('Stale request revision; reload before continuing');
          if(command.type==='request.duplicate'){
            const copy:Request={...request,id:randomUUID(),sourceRequestId:request.id,status:'DRAFT',blockers:[],revision:0,createdAt:now,updatedAt:now,experimentId:null};
            if(request.experimentId){const original=state.experiments.find(e=>e.id===request.experimentId)!;experimentId=randomUUID();copy.experimentId=experimentId;changes.push({collection:'experiments',value:{...original,id:experimentId,stage:'DRAFT',revision:0,createdAt:now,updatedAt:now}});}
            changes.push({collection:'requests',value:copy});reason='Copied objective into a new draft request';break;
          }
          if(request.status==='CANCELED')throw new Error('Canceled requests are read-only. Use as new request instead.');
          if(command.type==='request.update'){
            if(request.mode==='SINGLE'&&command.participantIds.some(id=>id!==command.leadAgentId))throw new Error('Single-agent requests cannot include collaborators');
            for(const id of [command.leadAgentId,...command.participantIds].filter(Boolean))if(!state.agents?.some(a=>a.id===id&&!a.removedAt))throw new Error('Choose an active agent');
            changes.push({collection:'requests',value:{...request,objective:command.objective,leadAgentId:command.leadAgentId,participantIds:[...new Set(command.participantIds)],acceptanceCriteria:command.acceptanceCriteria,status:'DRAFT',blockers:[],revision:request.revision+1,updatedAt:now}});
            if(experimentId){const exp=state.experiments.find(e=>e.id===experimentId)!;if(!['DRAFT','CONTRACT_REVIEW'].includes(exp.stage))throw new Error('Frozen contracts require a scientific amendment');changes.push({collection:'experiments',value:{...exp,stage:'DRAFT',contract:{...exp.contract,objective:command.objective},revision:exp.revision+1,updatedAt:now}});for(const task of state.tasks.filter(t=>t.experimentId===experimentId&&t.status==='BLOCKED'))changes.push({collection:'tasks',value:{...task,status:'SUPERSEDED',blocker:'Request revision superseded',updatedAt:now}});}
            reason='Saved a request revision; pending reviews superseded';break;
          }
          const blockers:Request['blockers']=[];
          if(command.type==='request.start'&&request.pipeline){
            // Pipeline arms resolve by role across the roster; the picked lead is the director
            // seat, and coverage of the arm roles — not a participant list — is the gate.
            if(!request.leadAgentId)blockers.push({code:'LEAD_REQUIRED',message:'Choose the director agent when creating the request.',action:'Edit the request'});
            else{const a=state.agents?.find(item=>item.id===request.leadAgentId);if(!a||a.removedAt)blockers.push({code:'AGENT_UNAVAILABLE',message:'The chosen director agent is archived or unavailable.',action:'Restore the agent or pick another director'});}
            for(const role of (request.pipeline.kind==='PLANNING'?['PM_A','PM_B','PM_C','WORKER']:['PM_C','PM_D','WORKER']))
              if(!state.agents?.some(item=>!item.removedAt&&item.role===role))blockers.push({code:'PIPELINE_ROLE_MISSING',message:`The ${request.pipeline.kind==='PLANNING'?'planning':'result analysis'} pipeline needs a live ${role} agent on the roster.`,action:'Add or restore an agent with that role'});
          }else if(command.type==='request.start'){
            const selected=[...new Set([request.leadAgentId,...request.participantIds].filter((id):id is string=>!!id))];
            if(!request.leadAgentId)blockers.push({code:'LEAD_REQUIRED',message:'Choose a responsible agent when creating the request.',action:'Edit request participants'});
            for(const id of selected){const a=state.agents?.find(a=>a.id===id);if(!a||a.removedAt)blockers.push({code:'AGENT_UNAVAILABLE',message:'A selected agent is archived or unavailable.',action:'Restore the agent or edit participants'});}
            if(request.mode==='TEAM')for(const role of ['DIRECTOR','PM_A','WORKER'])if(!selected.some(id=>state.agents?.some(a=>a.id===id&&!a.removedAt&&a.role===role)))blockers.push({code:'ROLE_REQUIRED',message:'Full research team requires a selected '+role+'.',action:'Edit request participants'});
            // The cloud-transport warning belongs only to work that could reach a hosted route.
            // An all-local selection is gated by local evidence instead; naming a cloud gap there
            // tells the user to fix a route they never asked for.
            const needsHosted=selected.some(id=>{const a=state.agents?.find(a=>a.id===id);return a&&!a.removedAt&&a.execution!=='LOCAL';});
            if(needsHosted)blockers.push({code:'CLOUD_TRANSPORT_UNVERIFIED',message:'No subscription cloud transport has verified submission, settings, events and cancellation capabilities.',action:'Configure and verify a provider cloud workspace'});
          }
          changes.push({collection:'requests',value:{...request,status:command.type==='request.cancel'?'CANCELED':'READY',blockers,revision:request.revision+1,updatedAt:now}});
          if(command.type==='request.cancel'&&experimentId){const exp=state.experiments.find(e=>e.id===experimentId)!;changes.push({collection:'experiments',value:{...exp,stage:'CANCELED',revision:exp.revision+1,updatedAt:now}});for(const task of state.tasks.filter(t=>t.experimentId===experimentId&&!['CANCELED','SUPERSEDED','ACCEPTED'].includes(t.status)))changes.push({collection:'tasks',value:{...task,status:'CANCELED',blocker:null,updatedAt:now}});}
          reason=command.type==='request.cancel'?'Canceled undispatched request':'Validated request; cloud start remains blocked';break;
        }
        case 'team.create': {
          if(command.projectId)this.activeProject(state,command.projectId);
          projectId=command.projectId;
          const team:Team={id:randomUUID(),projectId:command.projectId,name:command.name,revision:1,archived:false,createdAt:now,updatedAt:now};
          changes.push({collection:'teams',value:team});
          reason=`Created team ${team.name}. The name is a label; membership decides who work reaches.`;break;
        }
        case 'team.rename': {
          const team=state.teams?.find(item=>item.id===command.teamId);
          if(!team)throw new Error('Team not found');
          if(team.revision!==command.expectedRevision)throw new Error('Team changed in another view. Reload before saving.');
          projectId=team.projectId;
          changes.push({collection:'teams',value:{...team,name:command.name,revision:team.revision+1,updatedAt:now}});
          // Renaming cannot move work: memberships carry stable agent IDs.
          reason=`Renamed team ${team.name} to ${command.name}; memberships and routing are unchanged.`;break;
        }
        case 'team.member': {
          const team=state.teams?.find(item=>item.id===command.teamId);
          if(!team)throw new Error('Team not found');
          const agent=state.agents?.find(item=>item.id===command.agentId);
          if(!agent)throw new Error('Agent not found');
          projectId=team.projectId;
          const existing=(state.memberships??[]).find(item=>item.teamId===team.id&&item.agentId===agent.id&&item.role===command.role&&!item.removedAt);
          if(command.member){
            if(existing)return;
            if(agent.removedAt)throw new Error('Restore this agent before adding it to a team');
            changes.push({collection:'memberships',value:{id:randomUUID(),teamId:team.id,agentId:agent.id,role:command.role,createdAt:now}});
            reason=`Added ${agent.name} to ${team.name} as ${command.role}. Several members may hold the same role.`;
          } else {
            if(!existing)return;
            changes.push({collection:'memberships',value:{...existing,removedAt:now}});
            reason=`Removed ${agent.name} from ${team.name}; past work keeps its recorded membership.`;
          }
          break;
        }
        case 'request.slots': {
          const request=state.requests?.find(item=>item.id===command.requestId);
          if(!request)throw new Error('Request not found');
          if(request.status==='CANCELED')throw new Error('This request is canceled');
          if(request.revision!==command.expectedRevision)throw new Error('Request changed in another view. Reload before saving.');
          if(command.teamId&&!state.teams?.some(item=>item.id===command.teamId))throw new Error('Team not found');
          this.activeProject(state,request.projectId);
          projectId=request.projectId;
          const {teamId:_previousTeam,roleSlots:_previousSlots,...rest}=request;
          changes.push({collection:'requests',value:{...rest,...(command.teamId?{teamId:command.teamId}:{}),...(command.slots.length?{roleSlots:command.slots}:{}),
            revision:request.revision+1,updatedAt:now}});
          reason=command.teamId
            ?`Requested ${command.slots.map(slot=>`${slot.count} ${slot.role}`).join(', ')||'no role slots'} from a team. Slots resolve to actual agents at dispatch.`
            :'Cleared the team request; this work is not routed to a team.';
          break;
        }
        case 'research.draftSpec': {
          this.activeProject(state,command.projectId);
          projectId=command.projectId;
          // A draft may be replaced freely; a frozen one may not, which is checked below.
          const branch=command.branchId?state.branches?.find(item=>item.id===command.branchId):undefined;
          if(command.branchId&&!branch)throw new Error('Research branch not found');
          if(branch){
            if(branch.projectId!==command.projectId||branch.revision!==command.expectedRevision)throw new Error('Draft changed or belongs to another project. Reload before saving.');
            const existing=state.specs?.find(item=>item.id===branch.specId);
            if(existing?.frozen)throw new Error('This branch has a frozen specification. Amend the branch to change it.');
          }
          const branchId=branch?.id??randomUUID();
          const specId=randomUUID();
          const spec={id:specId,branchId,sections:command.sections,thresholds:command.thresholds,
            notApplicable:command.notApplicable,maxSelectionTrials:command.maxSelectionTrials,
            ...(command.gateEvidence?{gateEvidence:command.gateEvidence}:{}) ,
            frozen:false,contentHash:canonicalHash({sections:command.sections,thresholds:command.thresholds,
              notApplicable:command.notApplicable,maxSelectionTrials:command.maxSelectionTrials,gateEvidence:command.gateEvidence??[]}),
            createdAt:now,frozenAt:''};
          changes.push({collection:'specs',value:spec});
          changes.push({collection:'branches',value:branch
            ?{...branch,specId,revision:branch.revision+1,updatedAt:now}
            :{id:branchId,projectId:command.projectId,name:command.name,parentBranchId:null,lineageId:branchId,
              stage:'S0' as const,outcome:'IN_PROGRESS' as const,specId,predictionId:null,revision:0,createdAt:now,updatedAt:now}});
          reason=`Drafted a research specification for ${command.name}. A draft freezes nothing and authorizes no evaluation.`;
          break;
        }
        case 'research.freezeSpec': {
          const spec=state.specs?.find(item=>item.id===command.specId);
          if(!spec)throw new Error('Specification not found');
          if(spec.frozen)throw new Error('This specification is already frozen. Amend the branch to change it.');
          const branch=state.branches?.find(item=>item.id===spec.branchId);
          if(!branch)throw new Error('Research branch not found');
          if(branch.revision!==command.expectedRevision)throw new Error('The branch changed in another view. Reload before freezing.');
          // Every mandatory section must be present. A specification with a blank section is not a
          // preregistration, and freezing one would make G-SPEC meaningless.
          for(const section of ['estimand','splitPlan','searchPlan','costContract','portfolioContract','metricsAndGates','holdoutPolicy'] as const)
            if(!spec.sections[section].trim())throw new Error(`The specification cannot be frozen: its ${section} section is empty.`);
          this.activeProject(state,branch.projectId);
          projectId=branch.projectId;
          const predictionId=randomUUID();
          changes.push({collection:'specs',value:{...spec,frozen:true,frozenAt:now}});
          changes.push({collection:'predictions',value:{id:predictionId,branchId:branch.id,specId:spec.id,...command.prediction,createdAt:now}});
          changes.push({collection:'branches',value:{...branch,predictionId,revision:branch.revision+1,updatedAt:now}});
          reason=command.prediction.retrospective
            ?`Froze the specification for ${branch.name} with a prediction recorded as retrospective. A retrospective prediction is a description, not a forecast.`
            :`Froze the specification for ${branch.name} and registered its prediction before evaluation.`;
          break;
        }
        case 'research.registerVariant': {
          const branch=state.branches?.find(item=>item.id===command.branchId);
          if(!branch)throw new Error('Research branch not found');
          const spec=state.specs?.find(item=>item.id===branch.specId);
          if(!spec?.frozen)throw new Error('Freeze the specification before registering a trial.');
          this.activeProject(state,branch.projectId);
          projectId=branch.projectId;
          if(command.kind==='FOLLOW_UP'){
            // One follow-up per lineage, counted across every descendant however it was renamed.
            const used=(state.trials??[]).filter(item=>item.lineageId===branch.lineageId&&item.kind==='FOLLOW_UP').length;
            if(used>=1)throw new Error('This lineage has already used its one scientific follow-up. Mark the result inconclusive or retire it.');
          }
          changes.push({collection:'trials',value:{id:randomUUID(),lineageId:branch.lineageId,branchId:branch.id,
            kind:command.kind,variantHash:command.variantHash,description:command.description,outcome:'PENDING' as const,
            createdAt:now,settledAt:''}});
          reason=command.kind==='METADATA_RETRY'
            ?`Recorded a metadata-only retry on ${branch.name}. It is kept in the ledger but is not a new scientific trial.`
            :`Registered a ${command.kind.toLowerCase().replace('_',' ')} on ${branch.name}. Every attempt is counted, including ones that fail.`;
          break;
        }
        case 'research.createStageAttempt': {
          const branch=state.branches?.find(item=>item.id===command.branchId);
          if(!branch)throw new Error('Research branch not found');
          const spec=state.specs?.find(item=>item.id===branch.specId);
          if(!spec?.frozen)throw new Error('Freeze the specification before starting stage work.');
          if(command.stage!==branch.stage)throw new Error(`This branch is at ${branch.stage}; work cannot be opened at ${command.stage}.`);
          if(command.assignmentId&&!state.assignments?.some(item=>item.id===command.assignmentId))throw new Error('Assignment not found');
          if(command.trialId&&!state.trials?.some(item=>item.id===command.trialId))throw new Error('Trial not found');
          if(command.assignmentId)throw new Error('Assignment attempts are created atomically by stage preparation.');
          if(command.trialId&&!state.trials?.some(item=>item.id===command.trialId&&item.branchId===branch.id))throw new Error('Trial belongs to another branch.');
          this.activeProject(state,branch.projectId);
          projectId=branch.projectId;
          changes.push({collection:'attempts',value:{id:randomUUID(),branchId:branch.id,stage:command.stage,
            assignmentId:command.assignmentId,trialId:command.trialId,state:'OPEN' as const,summary:command.summary,
            createdAt:now,settledAt:''}});
          reason=`Opened ${command.stage} work on ${branch.name}.`;
          break;
        }
        case 'research.amendBranch': {
          const branch=state.branches?.find(item=>item.id===command.branchId);
          if(!branch)throw new Error('Research branch not found');
          if(branch.revision!==command.expectedRevision)throw new Error('The branch changed in another view. Reload before amending.');
          this.activeProject(state,branch.projectId);
          projectId=branch.projectId;
          // An amendment never edits what was preregistered. It creates a linked child sharing the
          // lineage, so the original stays legible and the family's counters do not reset.
          const childId=randomUUID();
          changes.push({collection:'branches',value:{id:childId,projectId:branch.projectId,name:command.name,
            parentBranchId:branch.id,lineageId:branch.lineageId,stage:'S0' as const,outcome:'IN_PROGRESS' as const,
            specId:null,predictionId:null,revision:0,createdAt:now,updatedAt:now}});
          reason=`Amended ${branch.name} into a linked branch: ${command.reason}. The original record is unchanged and the lineage keeps its trial history.`;
          break;
        }
        case 'research.settleBranch': {
          const branch=state.branches?.find(item=>item.id===command.branchId);
          if(!branch)throw new Error('Research branch not found');
          if(branch.revision!==command.expectedRevision)throw new Error('The branch changed in another view. Reload before settling it.');
          this.activeProject(state,branch.projectId);
          projectId=branch.projectId;
          const retiring=command.outcome==='RETIRED'||command.outcome==='SUSPENDED';
          changes.push({collection:'branches',value:{...branch,outcome:command.outcome,revision:branch.revision+1,updatedAt:now,
            ...(retiring?{retiredAt:now,retiredReason:command.reason}:{})}});
          reason=command.outcome==='VALID_NEGATIVE'
            ?`${branch.name} recorded a valid negative result: ${command.reason}. A negative result is preserved, not discarded.`
            :`${branch.name} was recorded as ${command.outcome.toLowerCase().replace('_',' ')}: ${command.reason}.`;
          break;
        }
        case 'request.grant': {
          const request=state.requests?.find(item=>item.id===command.requestId);
          if(!request)throw new Error('Request not found');
          if(request.status==='CANCELED')throw new Error('This request is canceled');
          const agent=state.agents?.find(item=>item.id===command.agentId);
          if(!agent)throw new Error('Agent not found');
          if(agent.removedAt)throw new Error('Restore this profile before granting it work.');
          // A single-agent request has a closed roster by definition. Widening it is a change of
          // scope the user makes deliberately by changing the request, not a permission to hand out.
          if(request.mode==='SINGLE')throw new Error('A single-agent request cannot grant work to another profile. Change its mode if the scope really is wider.');
          this.activeProject(state,request.projectId);
          projectId=request.projectId;
          const existing=state.grants?.find(item=>item.requestId===request.id&&item.agentId===agent.id&&item.capacity===command.capacity&&!item.revokedAt);
          if(command.granted){
            if(existing)break;
            changes.push({collection:'grants',value:{id:randomUUID(),requestId:request.id,projectId:request.projectId,agentId:agent.id,capacity:command.capacity,grantedAt:now}});
            reason=`${agent.name} was granted ${command.capacity.toLowerCase()} on ${request.name}. A grant authorizes participation; it does not verify hosted execution.`;
          } else {
            if(!existing)break;
            changes.push({collection:'grants',value:{...existing,revokedAt:now}});
            reason=`${agent.name}'s ${command.capacity.toLowerCase()} grant on ${request.name} was revoked. Work already frozen keeps its own record.`;
          }
          break;
        }
        case 'location.save': {
          const project=this.activeProject(state,command.projectId);projectId=project.id;
          const existing=(state.locations??[]).find(l=>l.projectId===project.id);
          if((existing?.revision??0)!==command.expectedRevision)throw new Error('Project location changed in another view. Reload before saving.');
          const folder=command.localFolder.trim();
          const folderStats=folder&&isAbsolute(folder)?safeStat(folder):undefined;
          if(folder&&!folderStats?.isDirectory())throw new Error('Choose an existing project folder on this device.');
          const output=command.outputFolder.trim();
          const outputStats=output&&isAbsolute(output)?safeStat(output):undefined;
          if(output&&!outputStats?.isDirectory())throw new Error('Choose an existing output folder, or leave it empty to use the managed output directory.');
          const root=folder?realpathSync(folder):'';
          // The project folder itself is the input scope: every regular file inside it is walked,
          // hashed and inventoried when a request snapshot is prepared. Per-file selection is gone;
          // the field stays on the record so history written under the old model still reads.
          const location:ProjectLocation={
            id:existing?.id??randomUUID(),projectId:project.id,localFolder:root,inputPaths:[],
            outputFolder:output?realpathSync(output):'',
            // The source repository is recorded for provenance only. Its history is never uploaded.
            sourceRepository:root&&existsSync(resolve(root,'.git'))?resolve(root,'.git'):'',
            snapshotRoute:'PROJECT_FOLDER_SNAPSHOT',
            providerTarget:{provider:'claude',host:'ANTHROPIC_MANAGED',selection:'PROVIDER_DEFAULT',environmentId:'',resolved:false},
            // Any old free-text cloud workspace value stays an inert note; it is never parsed or trusted.
            legacyNote:existing?.legacyNote??project.cloudWorkspace??'',
            revision:(existing?.revision??0)+1,createdAt:existing?.createdAt??now,updatedAt:now,
          };
          changes.push({collection:'locations',value:location});
          reason=`Project location saved: ${root||'no local folder'} — its contents become each request snapshot (credentials, tool configuration and dependency folders are skipped), output ${location.outputFolder||'managed app directory'}. Nothing was transferred.`;
          break;
        }
        case 'request.create':
        case 'experiment.create': {
          this.activeProject(state, command.projectId); projectId = command.projectId;
          if(command.type==='request.create'&&command.workType){
            const mode=command.mode??'SINGLE',leadAgentId=command.leadAgentId??null,participantIds=[...new Set(command.participantIds??[])];
            if(mode==='SINGLE'&&participantIds.some(id=>id!==leadAgentId))throw new Error('Single-agent requests cannot include collaborators');
            for(const id of [leadAgentId,...participantIds].filter(Boolean))if(!state.agents?.some(a=>a.id===id&&!a.removedAt))throw new Error('Choose an active agent');
            experimentId=command.workType==='EXPERIMENT'?randomUUID():null;
            const pipelineKind=command.workType==='PLANNING'||command.workType==='RESULT_ANALYSIS'?command.workType:null;
            const request:Request={id:randomUUID(),projectId,experimentId,name:command.name,objective:command.hypothesis,workType:command.workType,mode,leadAgentId,participantIds,acceptanceCriteria:command.acceptanceCriteria??'',revision:0,status:'DRAFT',blockers:[],delegation:mode!=='SINGLE',createdAt:now,updatedAt:now,
              ...(pipelineKind?{pipeline:{kind:pipelineKind,specHash:null,phase:'BRIEFING' as const,briefAssignmentId:null}}:{})};
            changes.push({collection:'requests',value:request});
            if(experimentId)changes.push({collection:'experiments',value:{id:experimentId,projectId,name:command.name,hypothesis:command.hypothesis,stage:'DRAFT',revision:0,contract:{...emptyContract(),objective:command.hypothesis},createdAt:now,updatedAt:now}});
            reason='Saved draft request; no work queued';break;
          }
          experimentId = randomUUID();
          changes.push({ collection: 'experiments', value: { id: experimentId, projectId, name: command.name, hypothesis: command.hypothesis, stage: 'DRAFT', revision: 0, contract: { ...emptyContract(), objective: command.hypothesis }, createdAt: now, updatedAt: now } }); reason = `Created experiment: ${command.name}`; if(command.type==='request.create'){changes.push({collection:'tasks',value:blockedTask(command.hypothesis,'DIRECTOR')});reason=`Created research request: ${command.name}`;} break;
        }
        case 'contract.save':
        case 'contract.submit': {
          const experiment = state.experiments.find(item => item.id === command.experimentId);
          if (!experiment) throw new Error('Experiment not found');
          this.activeProject(state, experiment.projectId); projectId = experiment.projectId; experimentId = experiment.id;
          if (experiment.revision !== command.expectedRevision) throw new Error('Stale contract revision; reload the experiment before saving');
          if(experiment.stage==='CANCELED')throw new Error('Canceled research is read-only. Create a new request to begin another investigation.');
          if(state.requests?.some(r=>r.experimentId===experiment.id&&r.status==='CANCELED'))throw new Error('The request behind this contract is canceled; contract review is closed. Create a new request to begin another investigation.');
          if (!['DRAFT', 'CONTRACT_REVIEW'].includes(experiment.stage)) throw new Error('Frozen contracts require a scientific amendment');
          if (command.type === 'contract.submit' && experiment.stage === 'CONTRACT_REVIEW') throw new Error('Contract is already awaiting review');
          if (command.type === 'contract.submit' && !experiment.contract.objective.trim()) throw new Error('A research objective is required for contract review');
          for (const task of state.tasks.filter(item => item.experimentId === experiment.id && item.status === 'BLOCKED' && item.prompt.startsWith('[Contract review revision '))) changes.push({ collection: 'tasks', value: { ...task, status: 'SUPERSEDED', blocker: 'Contract revision superseded', updatedAt: now } });
          const revision = experiment.revision + 1;
          changes.push({ collection: 'experiments', value: { ...experiment, stage: command.type === 'contract.save' ? 'DRAFT' : 'CONTRACT_REVIEW', revision, contract: command.type === 'contract.save' ? command.contract : experiment.contract, updatedAt: now } });
          if (command.type === 'contract.submit') changes.push({ collection: 'tasks', value: blockedTask(`[Contract review revision ${revision}] Review the research contract for ${experiment.name}.`, 'DIRECTOR') });
          reason = command.type === 'contract.save' ? `Saved contract revision ${revision}` : `Requested contract review at revision ${revision}; no agents configured`; break;
        }
        case 'task.create': {
          const target=this.scopedExperiment(state, command.projectId, command.experimentId);if(target?.stage==='CANCELED')throw new Error('Canceled research is read-only'); projectId = command.projectId; experimentId = command.experimentId;
          changes.push({ collection: 'tasks', value: blockedTask(command.prompt, command.recipient) }); reason = 'Recorded research request; no agents configured'; break;
        }
        case 'task.cancel': {
          const task = state.tasks.find(item => item.id === command.taskId);
          if (!task) throw new Error('Task not found');
          this.activeProject(state, task.projectId); projectId = task.projectId; experimentId = task.experimentId;
          // A live parent request owns the cascade; cancel it instead. A canceled or removed
          // parent can no longer propagate, so its leftover review children get canceled here.
          if(state.requests?.some(r=>r.experimentId&&r.experimentId===task.experimentId&&r.status!=='CANCELED'))throw new Error('Cancel the parent request using its request ID');
          if (['CANCELED','ACCEPTED','SUPERSEDED'].includes(task.status)) throw new Error('Terminal task cannot be canceled');
          for(const linked of state.tasks.filter(t=>t.id===task.id||(experimentId&&t.experimentId===experimentId&&t.status!=='CANCELED'&&t.status!=='ACCEPTED'&&t.status!=='SUPERSEDED')))changes.push({collection:'tasks',value:{...linked,status:'CANCELED',blocker:null,updatedAt:now}});
          if(experimentId){const experiment=state.experiments.find(e=>e.id===experimentId)!;changes.push({collection:'experiments',value:{...experiment,stage:'CANCELED',revision:experiment.revision+1,updatedAt:now}});} reason = 'Canceled research request'; break;
        }
        case 'task.delete': {
          // Removal only hides a terminal row in the work queue. The request/task records and every
          // lineage event are retained, so history and evidence are never rewritten.
          const request=state.requests?.find(item=>item.id===command.taskId);
          if(request){
            projectId=request.projectId;experimentId=request.experimentId;
            this.activeProject(state,request.projectId);
            if(request.removedAt)throw new Error('This request is already removed from the list');
            if(request.status!=='CANCELED')throw new Error('Only a completed or canceled request can be removed from the list');
            if(command.expectedRevision!==undefined&&command.expectedRevision!==request.revision)throw new Error('This request changed while it was being reviewed. Reload before removing it.');
            if(requestJobs(state,request.id).some(job=>job.unresolved))throw new Error('A provider job outcome is still unresolved; reconcile it before removing this request');
            changes.push({collection:'requests',value:{...request,revision:request.revision+1,removedAt:now,updatedAt:now}});
            reason=`Removed canceled request "${request.name}" from the work queue; record and history retained`;break;
          }
          const task=state.tasks.find(item=>item.id===command.taskId);
          if(!task)throw new Error('Request not found');
          this.activeProject(state,task.projectId);projectId=task.projectId;experimentId=task.experimentId;
          if(task.removedAt)throw new Error('This request is already removed from the list');
          if(experimentId&&state.requests?.some(r=>r.experimentId===experimentId&&!r.removedAt))throw new Error('Remove the parent request using its request ID');
          const experiment=experimentId?state.experiments.find(e=>e.id===experimentId):undefined;
          const status=experiment?.stage==='CANCELED'?'CANCELED':task.status;
          if(status!=='ACCEPTED'&&status!=='CANCELED')throw new Error('Only a completed or canceled request can be removed from the list');
          for(const linked of state.tasks.filter(item=>item.id===task.id||(experimentId&&item.experimentId===experimentId)))changes.push({collection:'tasks',value:{...linked,status:linked.status as z.infer<typeof taskSchema>['status'],removedAt:now,updatedAt:now}});
          reason='Removed completed/canceled request from the work queue; record and history retained';break;
        }
        case 'settings.update': {
          changes.push({ collection: 'settings', value: command.settings }); reason = 'Updated desktop preferences and global spending ceiling'; break;
        }
      }
      this.append(state, changes, { kind: command.type.toUpperCase().replaceAll('.', '_'), projectId, experimentId, reason }, command);
    });
  }

  /**
   * Appends one function assignment, superseding whatever held that function before it.
   *
   * Append-only on purpose. A function is a scientific responsibility, so replacing who holds it is a
   * recorded decision with a time, not an edit that quietly changes what an earlier review meant. The
   * profile itself is never touched: its provider, model and instructions stay exactly as they were.
   */
  appendFunctionAssignment(input: FunctionAssignment): AppState {
    const assignment = functionAssignmentSchema.parse(input);
    return this.transaction(() => {
      const state = this.readProjection();
      const project = state.projects.find(item => item.id === assignment.projectId);
      if (!project) throw new Error('Project not found');
      if (project.archived) throw new Error('Archived project is read-only; restore it first');
      const agent = state.agents?.find(item => item.id === assignment.agentId);
      if (!agent) throw new Error('Agent not found');
      if (agent.removedAt) throw new Error('Restore this profile before assigning it a research function.');
      if ((agent.revision ?? 0) !== assignment.agentRevision)
        throw new Error('This profile changed while the assignment was being made. Read it again and assign the current revision.');
      if (state.functions?.some(item => item.id === assignment.id)) throw new Error('Function assignment identities are immutable');
      const previous = (state.functions ?? []).filter(item => item.projectId === assignment.projectId
        && item.stage === assignment.stage && item.function === assignment.function && !item.supersededById);
      const changes: Change[] = previous.map(item => ({ collection: 'functions' as const, value: { ...item, supersededById: assignment.id } }));
      changes.push({ collection: 'functions', value: assignment });
      this.append(state, changes, { kind: 'RESEARCH_FUNCTION_ASSIGNED', projectId: assignment.projectId, experimentId: null,
        reason: `${agent.name} holds the ${assignment.function.toLowerCase().replaceAll('_', ' ')} function at ${assignment.stage}, at profile revision ${assignment.agentRevision}. ${previous.length ? `${previous.length} earlier assignment${previous.length === 1 ? ' is' : 's are'} superseded and kept.` : 'No earlier assignment is replaced.'} The profile itself is unchanged.` }, null);
    });
  }
  addArtifact(input: Artifact): AppState {
    const artifact = artifactSchema.parse(input);
    return this.transaction(() => {
      const state = this.readProjection();
      this.scopedExperiment(state, artifact.projectId, artifact.experimentId);
      const existing = state.artifacts.find(item => item.id === artifact.id);
      if (existing) {
        if (canonical(existing) !== canonical(artifact)) throw new Error('Artifact ID already identifies different immutable metadata');
        return;
      }
      this.append(state, [{ collection: 'artifacts', value: artifact }], { kind: 'ARTIFACT_IMPORTED', projectId: artifact.projectId, experimentId: artifact.experimentId, reason: `Imported ${artifact.name} as ${artifact.kind.toLowerCase()}; external origin, no scientific verification` }, null);
    });
  }
  addAgent(input: Agent): AppState {
    const agent = agentSchema.parse(input);
    return this.transaction(() => {
      const state = this.readProjection();
      const existing = state.agents?.find(a => a.id === agent.id);
      if (existing) { if (canonical(existing) !== canonical(agent)) throw new Error('Agent identity conflict'); return; }
      const changes:Change[]=[{collection:'agents',value:agent}];
      for(const task of state.tasks)if(task.status==='BLOCKED'&&task.blocker==='No agents configured')changes.push({collection:'tasks',value:{...task,status:'BLOCKED',blocker:'Provider-hosted execution is not configured',updatedAt:new Date().toISOString()}});
      this.append(state, changes, {kind:'AGENT_ADDED',projectId:null,experimentId:null,reason:`Added ${agent.name} to ${agent.team}; subscription identity verified, hosted execution still required`}, null);
    });
  }
  setAgentEffort(agentId:string, effort:Effort, expectedEffort:Effort):AppState {
    id.parse(agentId);effortSchema.parse(effort);effortSchema.parse(expectedEffort);
    return this.transaction(()=>{const state=this.readProjection(),agent=state.agents?.find(a=>a.id===agentId);if(!agent)throw new Error('Agent not found');
      if(agent.removedAt)throw new Error('Restore this agent before editing');
      if((agent.effort??'default')===effort)return;
      if((agent.effort??'default')!==expectedEffort)throw new Error('Effort changed in another view. Refresh before saving.');
      this.append(state,[{collection:'agents',value:{...agent,revision:(agent.revision??0)+1,effort}}],{kind:'AGENT_EFFORT_CHANGED',projectId:null,experimentId:null,reason:`${agent.name}: effort ${agent.effort??'default'} → ${effort}. Saved for the next provider request; no running request was changed.`},null);
    });
  }
  setAgentModel(agentId:string, model:string, expectedModel:string):AppState {
    id.parse(agentId);const clean=z.string().trim().min(1).max(160).parse(model),expected=z.string().trim().min(1).max(160).parse(expectedModel);
    return this.transaction(()=>{const state=this.readProjection(),agent=state.agents?.find(a=>a.id===agentId);if(!agent)throw new Error('Agent not found');
      if(agent.removedAt)throw new Error('Restore this agent before editing');
      if(agent.model===clean)return;
      if(agent.model!==expected)throw new Error('Model changed in another view. Refresh before saving.');
      this.append(state,[{collection:'agents',value:{...agent,revision:(agent.revision??0)+1,model:clean}}],{kind:'AGENT_MODEL_CHANGED',projectId:null,experimentId:null,reason:`${agent.name}: model ${agent.model} → ${clean}. Model-scoped provider evidence does not transfer; dispatch readiness re-derives under the new model.`},null);
    });
  }
  /**
   * Records one official account/capability observation made by the main process.
   * The renderer cannot reach this: provider evidence is never accepted from the sandboxed window.
   * Connections are mutable identity records; capability snapshots are immutable evidence.
   */
  /**
   * Turns one validated observation into durable changes.
   * `redundant` marks an unchanged poll of the already-active account, which callers that only refresh may skip.
   */
  private observationRecord(state:Projection,observation:z.infer<typeof observationSchema>):{changes:Change[];connection:AccountConnection;capabilityChanged:boolean;redundant:boolean}{
    const known=state.connections??[];
    const ordered=[...known].sort((a,b)=>(a.sequence??0)-(b.sequence??0));
    const active=[...ordered].reverse().find(c=>c.provider===observation.provider);
    // A result that finished after a newer check for the same provider describes a superseded context.
    if(active&&Date.parse(observation.observedAt)<Date.parse(active.lastCheckedAt))throw new Error('Discarded a superseded account check; a newer check for this provider has already been recorded.');
    const existing=known.find(c=>c.provider===observation.provider&&c.identity===observation.identity);
    const connection:AccountConnection={
      id:existing?.id??randomUUID(),provider:observation.provider,identity:observation.identity,credentialContext:observation.credentialContext,
      state:observation.state,allowance:observation.allowance,note:observation.note,
      revision:existing?.revision??0,firstSeenAt:existing?.firstSeenAt??observation.observedAt,lastCheckedAt:observation.observedAt,
      sequence:(ordered.at(-1)?.sequence??0)+1,
    };
    const material=(value:AccountConnection)=>canonical({...value,revision:0,sequence:0,lastCheckedAt:'',firstSeenAt:''});
    const connectionChanged=!existing||material(existing)!==material(connection);
    if(connectionChanged)connection.revision=(existing?.revision??0)+1;
    const {provider,identity,toolVersion,transport,environment,models,operations,source}=observation;
    const contentHash=canonicalHash({provider,identity,toolVersion,transport,environment,models,operations,source});
    const latest=(state.capabilities??[]).filter(c=>c.connectionId===connection.id).at(-1);
    const capabilityChanged=latest?.contentHash!==contentHash;
    // A context switch is never redundant, even when that account's own record is unchanged.
    const redundant=active?.id===connection.id&&!connectionChanged&&!capabilityChanged&&Date.parse(observation.observedAt)-Date.parse(existing!.lastCheckedAt)<5*60*1000;
    const changes:Change[]=[{collection:'connections',value:connectionSchema.parse(connection)}];
    if(capabilityChanged)changes.push({collection:'capabilities',value:capabilitySchema.parse({
      id:randomUUID(),provider,connectionId:connection.id,identity,toolVersion,transport,environment,models,operations,source,contentHash,observedAt:observation.observedAt,
    } satisfies ProviderCapabilitySnapshot)});
    return {changes,connection,capabilityChanged,redundant};
  }
  /**
   * Records one official account/capability observation made by the main process.
   * The renderer cannot reach this: provider evidence is never accepted from the sandboxed window.
   */
  /**
   * Records the intent to create a verification session, before the provider is contacted.
   *
   * Main-process only: a renderer can ask for a probe, but it can never assert that one happened.
   * An unresolved attempt refuses another, which is what stops a crash or a timeout turning into a
   * second session spent on the user's subscription.
   */
  recordProbeIntent(input:unknown):{state:AppState;attempt:ProbeAttempt} {
    const attempt=probeSchema.parse(input);
    if(attempt.state!=='INTENT')throw new Error('A probe is recorded as an intent before anything else.');
    const state=this.transaction(()=>{
      const current=this.readProjection();
      const unresolved=(current.probes??[]).find(item=>item.provider===attempt.provider&&(item.state==='INTENT'||item.state==='UNKNOWN'));
      if(unresolved)throw new Error(`An earlier verification attempt (${unresolved.id}) has not been resolved. Reconcile it with the provider before starting another.`);
      this.append(current,[{collection:'probes',value:attempt}],
        {kind:'PROBE_INTENT_RECORDED',projectId:null,experimentId:null,
         reason:`Intent to create one verification session for ${attempt.identity} through ${attempt.route}. Nothing has been submitted yet.`},null);
    });
    return {state,attempt};
  }

  /**
   * Records what became of a probe. The attempt row is immutable history, so the outcome is a new
   * row carrying the same identity, and the staging path is retained while the outcome is unknown.
   */
  recordProbeOutcome(input:unknown):AppState {
    const outcome=probeSchema.parse(input);
    if(outcome.state==='INTENT')throw new Error('A probe outcome must settle the attempt.');
    return this.transaction(()=>{
      const current=this.readProjection();
      const existing=(current.probes??[]).find(item=>item.id===outcome.id);
      if(!existing)throw new Error('That verification attempt was never recorded as an intent.');
      if(existing.state!=='INTENT'&&existing.state!=='UNKNOWN')throw new Error('That verification attempt already has a settled outcome.');
      this.append(current,[{collection:'probes',value:outcome}],
        {kind:'PROBE_OUTCOME_RECORDED',projectId:null,experimentId:null,
         reason:outcome.state==='ACCEPTED'
          ?`Verification session ${outcome.externalId} was created for ${outcome.identity}. Submission is exercised; nothing else is.`
          :outcome.state==='UNKNOWN'
           ?`Verification attempt ${outcome.id} is unresolved (${outcome.failureCode}). Whether a session exists is unknown; its fixture is retained for reconciliation.`
           :`Verification attempt ${outcome.id} was refused before submission (${outcome.failureCode}).`},null);
    });
  }

  /**
   * Closes an unresolved verification attempt after a person checked it with the provider.
   *
   * This is user testimony about an external system, so it settles the office's own bookkeeping and
   * nothing else. It records no capability evidence, promotes no operation and never asserts that
   * the route works: its only effect is that the attempt stops blocking another one.
   */
  recordProbeReconciliation(input:{attemptId:string;found:boolean;detail:string;at:string}):AppState {
    const attemptId=id.parse(input.attemptId);
    const detail=secretFree(1000).parse(input.detail);
    const at=timestamp.parse(input.at);
    return this.transaction(()=>{
      const current=this.readProjection();
      const existing=(current.probes??[]).find(item=>item.id===attemptId);
      if(!existing)throw new Error('That verification attempt was never recorded.');
      if(existing.state!=='INTENT'&&existing.state!=='UNKNOWN')throw new Error('That verification attempt is already resolved.');
      this.append(current,[{collection:'probes',value:{...existing,state:'RECONCILED' as const,
        detail:`Reconciled by the user: ${detail}`,settledAt:at}}],
        {kind:'PROBE_RECONCILED',projectId:null,experimentId:null,
         reason:`Verification attempt ${attemptId} was reconciled by the user, who reported that a session ${input.found?'does':'does not'} exist. This is user testimony and verifies no capability.`},null);
    });
  }

  recordAccountObservation(input:unknown):AppState {
    const observation=observationSchema.parse(input);
    return this.transaction(()=>{
      const state=this.readProjection();
      const record=this.observationRecord(state,observation);
      // Refreshing the already-active account must not grow the immutable history on every poll.
      if(record.redundant)return;
      this.append(state,record.changes,{kind:record.capabilityChanged?'PROVIDER_CAPABILITY_OBSERVED':'ACCOUNT_CONNECTION_OBSERVED',projectId:null,experimentId:null,
        reason:`${observation.provider} account ${observation.state.toLowerCase().replace('_',' ')}${observation.identity?` as ${observation.identity}`:''}; ${record.capabilityChanged?'new capability snapshot recorded':'capabilities unchanged'}. Sign-in alone does not make work runnable.`},null);
    });
  }
  /**
   * Records transport-operation evidence the office itself observed on a local route.
   *
   * This is the local-session evidence bootstrap: the office writes the packet or spawns the child
   * itself, so what it records is its own observation — never a provider attestation. Provider,
   * identity, tool version and catalog come from the durable connection and its newest snapshot,
   * never from the caller. The merged operation list becomes one more immutable capability
   * snapshot; the connection record itself is untouched, and a re-recording of identical evidence
   * appends only the history event.
   */
  recordTransportEvidence(input:unknown):AppState {
    const record=transportEvidenceSchema.parse(input);
    // Hosted-route evidence is recorded through provider observation; this path is local only.
    if(!record.route.startsWith('LOCAL_'))throw new Error('Hosted-route evidence is recorded through provider observation, not this path.');
    // An office observation can attest that the office exercised a transport, never that the
    // provider's account verified it. Attestation levels belong to provider observation.
    for(const entry of record.operations)if(entry.level==='ACCOUNT_VERIFIED')throw new Error('ACCOUNT_VERIFIED cannot be recorded through the office-observed transport path.');
    return this.transaction(()=>{
      const state=this.readProjection();
      const connection=(state.connections??[]).find(item=>item.id===record.connectionId);
      if(!connection)throw new Error('That connection was never recorded; observe the provider account first.');
      const latest=(state.capabilities??[]).filter(item=>item.connectionId===connection.id).at(-1);
      if(!latest)throw new Error('Transport evidence requires a prior account observation for this connection.');
      // Every entry's route is the one the office actually exercised; caller-supplied route labels
      // could otherwise claim a transport this path never touched. Model, effort and delegation
      // fall back to the batch scope, the conditions the batch was genuinely taken under. A field
      // left undeclared stays absent — an explicit undefined would not survive canonical hashing.
      const incoming=record.operations.map(entry=>{
        const stamped:z.infer<typeof evidenceSchema>={...entry,route:record.route};
        if(stamped.model===undefined&&record.model!==undefined)stamped.model=record.model;
        if(stamped.effort===undefined&&record.effort!==undefined)stamped.effort=record.effort;
        if(stamped.delegation===undefined&&record.delegation!==undefined)stamped.delegation=record.delegation;
        return evidenceSchema.parse(stamped);
      });
      // Same scope key supersedes; a field an entry does not declare is a distinct scope, never a wildcard.
      const scopeKey=(entry:z.infer<typeof evidenceSchema>)=>JSON.stringify([entry.operation,entry.route,entry.model,entry.environment,entry.effort,entry.delegation]);
      const superseded=new Set(incoming.map(scopeKey));
      const merged=[...latest.operations.filter(entry=>!superseded.has(scopeKey(entry))),...incoming];
      if(merged.length>64)throw new Error('Merging this evidence would exceed the 64-operation snapshot limit.');
      // Local routes are themselves transport kinds; any other route runs in the official terminal.
      const transport:ProviderCapabilitySnapshot['transport']=record.route.startsWith('LOCAL_')?capabilitySchema.shape.transport.parse(record.route):'OFFICIAL_CLI_TERMINAL';
      const {provider,identity}=connection;
      const {toolVersion,models}=latest;
      const environment=record.environment,source=record.source,operations=merged;
      const contentHash=canonicalHash({provider,identity,toolVersion,transport,environment,models,operations,source});
      // Snapshots are immutable; identical evidence earns a history entry, not a duplicate row.
      const capabilityChanged=latest.contentHash!==contentHash;
      const changes:Change[]=capabilityChanged?[{collection:'capabilities',value:capabilitySchema.parse({
        id:randomUUID(),provider,connectionId:connection.id,identity,toolVersion,transport,environment,models,operations,source,contentHash,observedAt:record.observedAt,
      } satisfies ProviderCapabilitySnapshot)}]:[];
      this.append(state,changes,{kind:'TRANSPORT_EVIDENCE_RECORDED',projectId:null,experimentId:null,
        reason:`Office-observed transport evidence for ${provider} via ${record.route.toLowerCase().replaceAll('_',' ')}: ${incoming.map(entry=>entry.operation.toLowerCase().replaceAll('_',' ')).join(', ')}; ${capabilityChanged?'new capability snapshot recorded':'capabilities unchanged'}. Office observation is not provider attestation.`},null);
    });
  }
  /**
   * Creates one agent and its connection binding in the same transaction as the observation that justifies it.
   * If the evidence cannot be persisted, no agent exists and the caller may retry.
   */
  confirmAgentBinding(input:{observation:unknown;agent:Agent}):AppState {
    const observation=observationSchema.parse(input.observation);
    const agent=agentSchema.parse(input.agent);
    if(agent.provider!==observation.provider)throw new Error('The observation does not belong to this agent provider');
    if(observation.state!=='SIGNED_IN')throw new Error('Sign in to the subscription account before confirming this agent');
    if(!observation.identity)throw new Error('The official tool reported a signed-in session but did not identify the account; a profile cannot be bound to an unidentified session. Sign in so the tool reports the account.');
    if(agent.account!==observation.identity)throw new Error('The signed-in account changed. Connect again before confirming.');
    return this.transaction(()=>{
      const state=this.readProjection();
      if(state.agents?.some(a=>a.id===agent.id))throw new Error('Agent identity conflict');
      const record=this.observationRecord(state,observation);
      const bound:Agent={...agent,connectionId:record.connection.id,bindingVerifiedAt:observation.observedAt,connectionVerifiedAt:observation.observedAt};
      const changes:Change[]=[...record.changes,{collection:'agents',value:agentSchema.parse(bound)}];
      for(const task of state.tasks)if(task.status==='BLOCKED'&&task.blocker==='No agents configured')changes.push({collection:'tasks',value:{...task,status:'BLOCKED',blocker:'Provider-hosted execution is not configured',updatedAt:new Date().toISOString()}});
      this.append(state,changes,{kind:'AGENT_ADDED',projectId:null,experimentId:null,
        reason:`Added ${agent.name} to ${agent.team}; bound to the ${observation.provider} account ${observation.identity} verified at ${observation.observedAt}. Hosted execution still requires verified transport.`},null);
    });
  }
  /**
   * Verifies or deliberately changes the connection an existing profile is bound to.
   * VERIFY requires the profile's historical setup identity; CHANGE is an explicit user decision and
   * records both identities. Neither can be triggered by a background refresh.
   */
  bindAgentConnection(input:{agentId:string;expectedRevision:number;intent:'VERIFY'|'CHANGE';observation:unknown}):AppState {
    id.parse(input.agentId);
    z.number().int().nonnegative().parse(input.expectedRevision);
    const intent=z.enum(['VERIFY','CHANGE']).parse(input.intent);
    const observation=observationSchema.parse(input.observation);
    return this.transaction(()=>{
      const state=this.readProjection();
      const agent=state.agents?.find(a=>a.id===input.agentId);
      if(!agent)throw new Error('Agent not found');
      if(agent.removedAt)throw new Error('Restore this agent before changing its connection');
      if((agent.revision??0)!==input.expectedRevision)throw new Error('Profile changed in another view. Reload before saving.');
      if(agent.provider!==observation.provider)throw new Error('This observation belongs to a different provider');
      if(observation.state!=='SIGNED_IN')throw new Error('The official tool does not report a signed-in subscription for this provider');
      if(!observation.identity)throw new Error('The official tool reported a signed-in session but did not identify the account; a profile cannot be verified or rebound against an unidentified session. Check the account again after the tool reports it.');
      if(intent==='VERIFY'&&observation.identity!==agent.account)throw new Error(`This profile was created for ${agent.account}, but ${observation.identity} is signed in. Use Change connection to move it deliberately.`);
      if(intent==='CHANGE'&&observation.identity===agent.account&&agent.connectionId)throw new Error('This profile is already bound to the signed-in account');
      const record=this.observationRecord(state,observation);
      // A deliberate rebinding moves the current account and preserves the original setup identity.
      // For a profile saved before that distinction existed, the account it is leaving is the best
      // recoverable evidence of where it started, and is recorded as such rather than being lost.
      const bound:Agent={...agent,revision:(agent.revision??0)+1,connectionId:record.connection.id,bindingVerifiedAt:observation.observedAt,
        ...(intent==='CHANGE'?{account:observation.identity,setupAccount:agent.setupAccount??agent.account}:{})};
      this.append(state,[...record.changes,{collection:'agents',value:agentSchema.parse(bound)}],
        {kind:intent==='VERIFY'?'AGENT_CONNECTION_VERIFIED':'AGENT_CONNECTION_CHANGED',projectId:null,experimentId:null,
         reason:intent==='VERIFY'
          ?`${agent.name}: connection verified against its setup account ${agent.setupAccount??agent.account} at ${observation.observedAt}. Account binding does not verify hosted execution.`
          :`${agent.name}: connection changed from ${agent.account} to ${observation.identity} by explicit user action. Its setup identity ${agent.setupAccount??agent.account} is retained. Existing assignments keep their original binding.`},null);
    });
  }
  /** The current saved location for a project, or undefined when the user has not configured one. */
  location(projectId:string):ProjectLocation|undefined {
    id.parse(projectId);this.assertOpen();
    return this.readProjection().locations?.find(l=>l.projectId===projectId);
  }
  /**
   * Records one immutable input snapshot. The staging copy is made by the main process before this call,
   * so the hashes here describe bytes that were actually staged, not a source folder that may change later.
   */
  recordInputSnapshot(input:InputSnapshot):AppState {
    const snapshot=snapshotSchema.parse(input);
    // The exact request, its revision and the location revision are re-checked here, inside the
    // transaction. Checking them before the asynchronous staging work is not enough: the request or
    // the selection can change while Git runs, and membership of the same project is far too weak.
    if(snapshot.requestId!==null){
      const current=this.readProjection();
      const request=current.requests?.find(item=>item.id===snapshot.requestId);
      if(!request)throw new Error('That input snapshot names a request this workspace does not have.');
      if(request.projectId!==snapshot.projectId)throw new Error('That input snapshot names a request in a different project.');
      if(snapshot.requestRevision!==null&&snapshot.requestRevision!==request.revision)
        throw new Error('The request changed while its inputs were being prepared. Prepare them again.');
      const location=current.locations?.find(item=>item.projectId===snapshot.projectId);
      if((location?.revision??0)!==snapshot.locationRevision)
        throw new Error('The project inputs changed while they were being prepared. Prepare them again.');
    }
    // The exact request, its revision and the location revision are re-checked here, inside the
    // transaction. Checking them before the asynchronous staging work is not enough: the request can
    // change while Git runs, and membership of the same project is far too weak a test.
    if(snapshot.requestId!==null){
      const state=this.readProjection();
      const request=state.requests?.find(item=>item.id===snapshot.requestId);
      if(!request)throw new Error('That input snapshot names a request this workspace does not have.');
      if(request.projectId!==snapshot.projectId)throw new Error('That input snapshot names a request in a different project.');
      if(snapshot.requestRevision!==null&&snapshot.requestRevision!==request.revision)
        throw new Error('The request changed while its inputs were being prepared. Prepare them again.');
      const location=state.locations?.find(item=>item.projectId===snapshot.projectId);
      if((location?.revision??0)!==snapshot.locationRevision)
        throw new Error('The project inputs changed while they were being prepared. Prepare them again.');
    }
    return this.transaction(()=>{
      const state=this.readProjection();
      const project=state.projects.find(p=>p.id===snapshot.projectId);
      if(!project)throw new Error('Project not found');
      if(project.archived)throw new Error('Archived project is read-only; restore it first');
      const location=state.locations?.find(l=>l.projectId===snapshot.projectId);
      if(snapshot.route!=='GENERATED_REQUEST_ONLY'&&location?.revision!==snapshot.locationRevision)throw new Error('The project location changed while preparing this snapshot. Prepare it again.');
      if(snapshot.requestId&&!state.requests?.some(r=>r.id===snapshot.requestId&&r.projectId===snapshot.projectId))throw new Error('Snapshot request does not belong to this project');
      if(state.snapshots?.some(s=>s.id===snapshot.id))throw new Error('Snapshot identities are immutable');
      this.append(state,[{collection:'snapshots',value:snapshot}],{kind:'INPUT_SNAPSHOT_PREPARED',projectId:snapshot.projectId,experimentId:null,
        reason:`Prepared ${snapshot.files.length} file${snapshot.files.length===1?'':'s'} (${snapshot.totalBytes} bytes) as an immutable snapshot. Preparation transfers nothing.`},null);
    });
  }
  /**
   * Freezes one attempt and records the intent to submit, before any provider call is made.
   * If the office dies immediately after this, reconciliation sees the intent and never resubmits blindly.
   */
  createAssignment(input:{assignment:Assignment;job:Omit<ProviderJob,'revision'|'createdAt'|'updatedAt'|'dispatchedAt'|'settledAt'|'outputs'|'state'|'evidence'|'detail'|'externalId'|'externalUrl'>}):AppState {
    const assignment=assignmentSchema.parse(input.assignment);
    return this.transaction(()=>{
      const state=this.readProjection();
      const request=state.requests?.find(r=>r.id===assignment.requestId);
      if(!request)throw new Error('Request not found');
      if(request.projectId!==assignment.projectId)throw new Error('Assignment request does not belong to this project');
      if(request.status==='CANCELED')throw new Error('This request was canceled; start it again as a new draft.');
      if(request.revision!==assignment.requestRevision)throw new Error('The request changed while preparing this work. Reload and start again.');
      const agent=state.agents?.find(a=>a.id===assignment.agentId);
      if(!agent)throw new Error('Agent not found');
      if(agent.removedAt)throw new Error('This profile is archived; restore it or choose another agent.');
      if((agent.revision??0)!==assignment.agentRevision)throw new Error('The profile changed while preparing this work. Reload and start again.');
      if(agent.connectionId!==assignment.connectionId)throw new Error('This profile is not bound to the account this assignment was prepared for.');
      if(!state.capabilities?.some(c=>c.id===assignment.capabilitySnapshotId))throw new Error('The capability snapshot for this assignment is not recorded');
      const inputs=state.snapshots?.find(item=>item.id===assignment.snapshotId&&item.projectId===assignment.projectId);
      if(!inputs)throw new Error('The input snapshot for this assignment is not recorded');
      // Same project is not the same request. A snapshot frozen for other work, or for an older
      // revision of this one, describes inputs nobody approved for this assignment.
      if(inputs.requestId===null)throw new Error('That input snapshot was not prepared for any request. Prepare this request specifically.');
      if(inputs.requestId!==assignment.requestId)throw new Error('That input snapshot was prepared for a different request.');
      if(inputs.requestRevision!==assignment.requestRevision)throw new Error('That input snapshot was prepared for a different revision of this request.');
      if(assignment.research){
        const research=assignment.research;
        // Research work is bound to the recorded link, not to whatever the caller claims: the branch,
        // the request, the subject and both revisions must all be the ones the LINK froze.
        const branch=state.branches?.find(b=>b.id===research.branchId&&b.projectId===assignment.projectId);
        if(!branch)throw new Error('Research work names a branch outside this project.');
        if(branch.outcome!=='IN_PROGRESS'||!state.specs?.some(s=>s.id===branch.specId&&s.frozen))throw new Error('Research work requires an active branch and frozen specification.');
        const blocker=this.researchStageBlocker(branch.stage);
        if(blocker)throw new Error(blocker);
        const link=(state.pipeline??[]).filter(r=>r.kind==='LINK'&&r.branchId===branch.id).at(-1);
        if(!link||link.kind!=='LINK')throw new Error('Research work requires a recorded branch-to-request link.');
        if(link.requestId!==assignment.requestId||link.subjectHash!==research.subjectHash)
          throw new Error('Research work must use the exact linked request and subject.');
        if(link.requestRevision!==assignment.requestRevision||research.requestRevision!==assignment.requestRevision)
          throw new Error('Research work must be frozen at the linked request revision.');
        if(branch.revision!==research.branchRevision||branch.stage!==research.stage||branch.specId!==research.specId)
          throw new Error('The branch moved since this research context was computed.');
        // The named function is a recorded appointment, not a label the caller supplies: the agent
        // must hold it, at the exact profile revision the appointment was made against.
        const appointment=(state.functions??[]).filter(item=>item.projectId===assignment.projectId&&item.stage===research.stage&&item.function===research.function&&!item.supersededById).at(-1);
        if(!appointment||appointment.agentId!==assignment.agentId||appointment.agentRevision!==assignment.agentRevision)
          throw new Error('This profile does not hold the named stage function at this revision.');
        if(stageContextHash({...research,agentId:assignment.agentId,agentRevision:assignment.agentRevision,inputs:research})!==research.contextHash)
          throw new Error('The research context identity does not match its contents.');
        // The evidence scope is exactly the prepared input inventory: no more, no less.
        const expected=[...inputs.files.map(file=>file.sha256),...(inputs.generated??[]).map(file=>file.sha256)].sort();
        if(JSON.stringify(expected)!==JSON.stringify([...research.objectHashes].sort()))
          throw new Error('The research context must name exactly the prepared input objects.');
        this.isolatedResearchContext(state,assignment);
        if(research.reviewRoundId&&state.assignments?.some(a=>a.research?.reviewRoundId===research.reviewRoundId&&a.agentId===assignment.agentId))throw new Error('This isolated reviewer context already has its immutable assignment.');
        if(request.mode==='SINGLE'&&research.function!=='PRINCIPAL')throw new Error('A single-agent request cannot recruit a stage reviewer.');
      }
      if(state.assignments?.some(a=>a.id===assignment.id))throw new Error('Assignment identities are immutable');
      // One open job per agent on a request: cooperation may run several agents, but never the same
      // agent twice in parallel on the same work. Pipeline hops are exempt — the office mints the
      // whole spec at once (the director holds several INTENT hops), and the dependsOn DAG, not job
      // state, serializes their launches. Only the office mint can set pipelineKey, so this cannot
      // be widened from the renderer.
      if(!assignment.pipelineKey){
        const open=(state.assignments??[]).filter(item=>item.requestId===assignment.requestId&&item.agentId===assignment.agentId)
          .filter(item=>(state.jobs??[]).some(job=>job.assignmentId===item.id&&!['COMPLETED','FAILED','CANCEL_ACKNOWLEDGED'].includes(job.state)));
        if(open.length)throw new Error('This agent already has work in flight for this request. Reconcile or cancel it first.');
      }
      const now=new Date().toISOString();
      const job=jobSchema.parse({...input.job,state:'INTENT',evidence:'OFFICE_LOCAL',detail:'Submission intent recorded before contacting the provider.',
        externalId:'',externalUrl:'',outputs:[],revision:0,createdAt:now,updatedAt:now,dispatchedAt:'',settledAt:''});
      if(job.assignmentId!==assignment.id||job.requestId!==assignment.requestId||job.projectId!==assignment.projectId)throw new Error('Job does not match its assignment');
      const changes:Change[]=[{collection:'assignments',value:assignment},{collection:'jobs',value:job}];
      if(assignment.research)changes.push({collection:'attempts',value:{id:randomUUID(),branchId:assignment.research.branchId,
        stage:assignment.research.stage,assignmentId:assignment.id,trialId:(state.trials??[]).find(t=>t.branchId===assignment.research!.branchId&&t.variantHash===assignment.research!.subjectHash)?.id??null,
        state:'OPEN',summary:'Prepared exact-context stage assignment.',createdAt:now,settledAt:''}});
      this.append(state,changes,
        {kind:'ASSIGNMENT_CREATED',projectId:assignment.projectId,experimentId:null,
         reason:`Froze request revision ${assignment.requestRevision}, profile revision ${assignment.agentRevision}, input snapshot and capability evidence. Nothing has been submitted yet.`},null);
    });
  }
  /**
   * Records the office-minted director brief hop on a pipeline request — the spec hash and the
   * assignment the briefing phase gates on. Office-only: this is a store method, not a command,
   * so the renderer can never reach it. The named assignment must be a real minted brief hop on
   * this request held by the chosen director seat — the record cannot point at invented work.
   */
  bindPipelineBrief(input:{requestId:string;expectedRevision:number;briefAssignmentId:string;specHash?:string}):AppState {
    id.parse(input.requestId);id.parse(input.briefAssignmentId);
    if(input.specHash!==undefined)hash.parse(input.specHash);
    return this.transaction(()=>{
      const state=this.readProjection();
      const request=state.requests?.find(r=>r.id===input.requestId);
      if(!request)throw new Error('Request not found');
      if(request.revision!==input.expectedRevision)throw new Error('Stale request revision; reload before continuing');
      if(!request.pipeline)throw new Error('Only planning or result-analysis requests carry a pipeline.');
      if(request.status!=='READY'||request.pipeline.phase!=='BRIEFING')
        throw new Error('The brief hop binds only while the request is briefing.');
      const assignment=state.assignments?.find(a=>a.id===input.briefAssignmentId);
      if(!assignment||assignment.requestId!==request.id)throw new Error('The brief hop must be a minted assignment on this request.');
      if(assignment.agentId!==request.leadAgentId)throw new Error('The director brief belongs to the chosen director seat.');
      if(!assignment.pipelineKey||!/^(plan-brief|analysis-brief|brief-refine-\d+)$/.test(assignment.pipelineKey))
        throw new Error('Only a minted director brief hop binds as the pipeline brief.');
      const now=new Date().toISOString();
      // No revision bump: this is office bookkeeping — a pointer to the hop the office itself
      // minted — not a change to the request's frozen content. Bumping would stale the minted
      // hop's requestRevision pin against the very record that binds it.
      this.append(state,[{collection:'requests',value:{...request,pipeline:{...request.pipeline,briefAssignmentId:input.briefAssignmentId,...(input.specHash?{specHash:input.specHash}:{})},updatedAt:now}}],
        {kind:'PIPELINE_BRIEF_BOUND',projectId:request.projectId,experimentId:null,
         reason:`Bound the minted ${assignment.pipelineKey} hop to the briefing phase.`},null);
    });
  }
  /**
   * Marks a launched pipeline awaiting the user's decision once its terminal hop verifies.
   * Office-only bookkeeping, like bindPipelineBrief: called from the chain-observe path when
   * the terminal assignment's job records a verified COMPLETED receipt. The pending record
   * binds the later user decision to the exact spec hash and verified receipt hash displayed —
   * no hop output can mint user approval. Idempotent on an identical pending record; a
   * different terminal identity on an already-waiting or decided pipeline is refused.
   */
  markPipelineAwaitingDecision(input:{requestId:string;specHash:string;headAssignmentId:string;headReceiptHash:string}):AppState {
    id.parse(input.requestId);id.parse(input.headAssignmentId);
    hash.parse(input.specHash);hash.parse(input.headReceiptHash);
    return this.transaction(()=>{
      const state=this.readProjection();
      const request=state.requests?.find(r=>r.id===input.requestId);
      if(!request)throw new Error('Request not found');
      const pipeline=request.pipeline;if(!pipeline)throw new Error('Only planning or result-analysis requests carry a pipeline.');
      if(pipeline.phase==='AWAITING_DECISION'&&pipeline.pendingDecision
        &&pipeline.pendingDecision.specHash===input.specHash
        &&pipeline.pendingDecision.headAssignmentId===input.headAssignmentId
        &&pipeline.pendingDecision.headReceiptHash===input.headReceiptHash)return state;
      if(pipeline.phase!=='LAUNCHED')throw new Error('The decision wait begins only after the round launches.');
      if(pipeline.specHash!==input.specHash)throw new Error('The named spec is not the spec this pipeline launched.');
      const assignment=state.assignments?.find(a=>a.id===input.headAssignmentId);
      if(!assignment||assignment.requestId!==request.id||!assignment.pipelineKey)
        throw new Error('The decision binds only to a minted pipeline hop on this request.');
      const job=state.jobs?.find(item=>item.assignmentId===assignment.id);
      if(!job||job.state!=='COMPLETED')throw new Error('The terminal hop has not verified COMPLETED — nothing is ready to decide.');
      const now=new Date().toISOString();
      this.append(state,[{collection:'requests',value:{...request,pipeline:{...pipeline,phase:'AWAITING_DECISION' as const,pendingDecision:{specHash:input.specHash,headAssignmentId:input.headAssignmentId,headReceiptHash:input.headReceiptHash}},updatedAt:now}}],
        {kind:'PIPELINE_AWAITING_DECISION',projectId:request.projectId,experimentId:null,
         reason:`Terminal hop verified; the round awaits the user's decision on receipt ${input.headReceiptHash.slice(0,12)}.`},null);
    });
  }
  /**
   * Records a memory finding — office bookkeeping for every surface (a user note's reducer,
   * a session's verified-receipt report, an office observation). The ledger is append-only:
   * supersession marks the old record, never rewrites it. Identical re-ingest (same project,
   * title, surface and receipt hash) returns the existing record — receipt replays cannot
   * duplicate a finding.
   */
  recordMemoryFinding(input:{projectId:string;requestId:string|null;assignmentId:string|null;kind:FindingKind;title:string;body:string;evidenceRefs:FindingEvidenceRef[];createdBy:MemoryFinding['createdBy'];supersedesFindingId?:string}):{finding:MemoryFinding;created:boolean} {
    id.parse(input.projectId);findingKindSchema.parse(input.kind);
    let result:{finding:MemoryFinding;created:boolean}|undefined;
    this.transaction(()=>{
      const state=this.readProjection();
      this.activeProject(state,input.projectId);
      if(input.requestId){const request=state.requests?.find(r=>r.id===input.requestId);if(!request||request.projectId!==input.projectId)throw new Error('The finding names a request outside this project.');}
      if(input.assignmentId){const assignment=state.assignments?.find(a=>a.id===input.assignmentId);if(!assignment||assignment.projectId!==input.projectId)throw new Error('The finding names an assignment outside this project.');}
      assertFindingRefs(state,input.projectId,input.evidenceRefs);
      const duplicate=state.findings?.find(item=>item.projectId===input.projectId&&item.title===input.title
        &&item.createdBy.surface===input.createdBy.surface
        &&(item.createdBy.receiptHash??null)===(input.createdBy.receiptHash??null));
      if(duplicate){result={finding:duplicate,created:false};return;}
      const finding:MemoryFinding={id:randomUUID(),projectId:input.projectId,requestId:input.requestId,assignmentId:input.assignmentId,
        kind:input.kind,title:input.title.trim(),body:input.body.trim(),evidenceRefs:input.evidenceRefs,
        createdBy:input.createdBy,createdAt:new Date().toISOString()};
      this.append(state,appendFinding(state,finding,input.supersedesFindingId),
        {kind:'MEMORY_FINDING',projectId:input.projectId,experimentId:null,
         reason:`Recorded a ${input.createdBy.surface.toLowerCase().replaceAll('_',' ')} finding: ${finding.title.slice(0,80)}`},null);
      result={finding,created:true};
    });
    return result!;
  }
  /**
   * Records a PROPOSED relationship between two findings in the same project. Endpoint
   * validation is mechanical — both findings must exist in the project, be distinct, and
   * a live link of the same kind between the same pair may not duplicate. PROPOSED links are
   * visible but unconfirmed until settled.
   */
  proposeMemoryRelationship(input:{projectId:string;fromFindingId:string;toFindingId:string;kind:MemoryRelationship['kind'];note?:string;createdBy:MemoryRelationship['createdBy']}):{relationship:MemoryRelationship;created:boolean} {
    id.parse(input.projectId);relationshipKindSchema.parse(input.kind);
    let result:{relationship:MemoryRelationship;created:boolean}|undefined;
    this.transaction(()=>{
      const state=this.readProjection();
      this.activeProject(state,input.projectId);
      if(input.fromFindingId===input.toFindingId)throw new Error('A finding cannot relate to itself.');
      const from=state.findings?.find(item=>item.id===input.fromFindingId&&item.projectId===input.projectId);
      const to=state.findings?.find(item=>item.id===input.toFindingId&&item.projectId===input.projectId);
      if(!from||!to)throw new Error('A relationship can only link findings that exist in this project.');
      const duplicate=state.relationships?.find(item=>item.projectId===input.projectId
        &&item.fromFindingId===input.fromFindingId&&item.toFindingId===input.toFindingId
        &&item.kind===input.kind&&item.status!=='REFUTED');
      if(duplicate){result={relationship:duplicate,created:false};return;}
      const relationship:MemoryRelationship={id:randomUUID(),projectId:input.projectId,fromFindingId:from.id,toFindingId:to.id,
        kind:input.kind,note:input.note?.trim()||null,status:'PROPOSED',createdBy:input.createdBy,createdAt:new Date().toISOString()};
      this.append(state,[{collection:'relationships',value:relationship}],
        {kind:'MEMORY_RELATIONSHIP',projectId:input.projectId,experimentId:null,
         reason:`Proposed a ${input.kind.toLowerCase()} link between findings (${input.createdBy.surface.toLowerCase().replaceAll('_',' ')}).`},null);
      result={relationship,created:true};
    });
    return result!;
  }
  /** Settles a proposed link CONFIRMED or REFUTED — a decided link is append-only too. */
  settleMemoryRelationship(input:{relationshipId:string;status:Exclude<RelationshipStatus,'PROPOSED'>;decidedBy?:MemoryRelationship['createdBy']}):AppState {
    id.parse(input.relationshipId);
    if((input.status as string)==='PROPOSED')throw new Error('A relationship can only be settled confirmed or refuted.');
    return this.transaction(()=>{
      const state=this.readProjection();
      const relationship=state.relationships?.find(item=>item.id===input.relationshipId);
      if(!relationship)throw new Error('Relationship not found.');
      if(relationship.status!=='PROPOSED')throw new Error(`That link is already ${relationship.status.toLowerCase()} — the record is append-only.`);
      this.append(state,[{collection:'relationships',value:{...relationship,status:input.status,decidedAt:new Date().toISOString()}}],
        {kind:'MEMORY_RELATIONSHIP_SETTLED',projectId:relationship.projectId,experimentId:null,
         reason:`A proposed ${relationship.kind.toLowerCase()} link was ${input.status.toLowerCase()}.`},null);
    });
  }
  /**
   * Bounded full-text search over a project's findings. Office-authorized retrieval only —
   * callers reach this through authorizeMemorySearch or the user-facing UI, never through a
   * silent context injection. Non-superseded findings rank above superseded ones; results
   * cap at `limit` (default 10, hard ceiling 25).
   */
  searchMemoryFindings(projectId:string,query:string,limit=10):MemoryFinding[] {
    id.parse(projectId);
    const capped=Math.max(1,Math.min(25,Math.floor(limit)));
    const terms=[...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>=2))];
    if(!terms.length)return[];
    const state=this.readProjection();
    const scored=(state.findings??[]).filter(item=>item.projectId===projectId).map(item=>{
      const hay=`${item.title}\n${item.body}`.toLowerCase();
      const score=terms.reduce((acc,term)=>acc+(hay.includes(term)?(item.title.toLowerCase().includes(term)?2:1):0),0);
      return{item,score};
    }).filter(entry=>entry.score>0)
      .sort((a,b)=>b.score-a.score||Number(!!a.item.supersededById)-Number(!!b.item.supersededById)||b.item.createdAt.localeCompare(a.item.createdAt));
    return scored.slice(0,capped).map(entry=>entry.item);
  }
  /** The bounded graph read model — every finding node and relationship edge in the project. */
  memoryGraph(projectId:string):MemoryGraph {
    id.parse(projectId);
    const state=this.readProjection();
    const nodes=(state.findings??[]).filter(item=>item.projectId===projectId)
      .map(item=>({findingId:item.id,kind:item.kind,title:item.title,superseded:!!item.supersededById}));
    const edges=(state.relationships??[]).filter(item=>item.projectId===projectId)
      .map(item=>({relationshipId:item.id,from:item.fromFindingId,to:item.toFindingId,kind:item.kind,status:item.status}));
    return{projectId,nodes,edges};
  }
  /**
   * Whether the given assignment's caller may run memory.search — retrieval is director-only
   * and only at the synthesis/finalize hop of a pipeline round. Every other seat, every other
   * phase and every non-pipeline assignment is refused: memory never silently enters an
   * independent research-review arm's context.
   */
  authorizeMemorySearch(assignmentId:string):{ok:true}|{ok:false;reason:string} {
    const state=this.readProjection();
    const assignment=state.assignments?.find(item=>item.id===assignmentId);
    if(!assignment)return{ok:false,reason:'The caller names no known assignment.'};
    const key=assignment.pipelineKey;
    if(!key)return{ok:false,reason:'Memory retrieval is reserved for pipeline synthesis hops — a manual assignment carries no search authorization.'};
    const authorized=key==='plan-synthesis'||key==='analysis-finalize';
    return authorized
      ?{ok:true}
      :{ok:false,reason:`The '${key}' hop is not the director's synthesis seat — memory retrieval is bounded to plan-synthesis and analysis-finalize.`};
  }
  /** Applies one job transition through the shared reducer. The renderer can never call this. */
  recordJobTransition(input:{jobId:string;expectedRevision:number;to:JobState;evidence:JobEvidence;detail:string;externalId?:string;externalUrl?:string;outputs?:{path:string;sha256:string;bytes:number}[];at?:string}):AppState {
    id.parse(input.jobId);
    return this.transaction(()=>{
      const state=this.readProjection();
      const job=state.jobs?.find(item=>item.id===input.jobId);
      if(!job)throw new Error('Job not found');
      if(job.revision!==input.expectedRevision)throw new Error('This job changed since it was read. Reconcile before acting again.');
      const at=input.at??new Date().toISOString();
      const next=jobSchema.parse(nextJob(job,{to:input.to,at,evidence:input.evidence,detail:input.detail,externalId:input.externalId,externalUrl:input.externalUrl,outputs:input.outputs}));
      const changes:Change[]=[{collection:'jobs',value:next}];
      if(['FAILED','CANCEL_ACKNOWLEDGED'].includes(next.state))for(const attempt of state.attempts??[]){
        if(attempt.assignmentId===job.assignmentId&&attempt.state==='OPEN')changes.push({collection:'attempts',value:{...attempt,state:'ABANDONED',summary:input.detail.slice(0,4000),settledAt:at}});
      }
      const request=state.requests?.find(r=>r.id===job.requestId);
      // Canceling the request cancels dispatch intent, but only the provider can settle dispatched work.
      if(request&&request.mode==='SINGLE'&&next.state==='CANCEL_ACKNOWLEDGED'&&request.status!=='CANCELED'){
        changes.push({collection:'requests',value:{...request,status:'CANCELED',revision:request.revision+1,updatedAt:at}});
        // The job-side cancellation must run the same cascade request.cancel runs. Without it the
        // experiment stays under review and keeps accepting contract revisions and spawning review
        // tasks that no command can terminalize once the request row is removed.
        const experiment=request.experimentId?state.experiments.find(e=>e.id===request.experimentId):undefined;
        if(experiment&&experiment.stage!=='CANCELED')changes.push({collection:'experiments',value:{...experiment,stage:'CANCELED',revision:experiment.revision+1,updatedAt:at}});
        if(request.experimentId)for(const task of state.tasks.filter(t=>t.experimentId===request.experimentId&&!['CANCELED','SUPERSEDED','ACCEPTED'].includes(t.status)))changes.push({collection:'tasks',value:{...task,status:'CANCELED',blocker:null,updatedAt:at}});
      }
      this.append(state,changes,{kind:'PROVIDER_JOB_'+next.state,projectId:job.projectId,experimentId:null,
        reason:`${job.state} → ${next.state} (${input.evidence.toLowerCase().replaceAll('_',' ')}): ${input.detail}`},null);
    });
  }
  /**
   * Appends visible provider events, deduplicated by external ID so a reconnect cannot double-record.
   * Events are accepted for settled jobs as history, but they never change a recorded outcome.
   */
  recordJobEvents(jobId:string,events:Omit<JobEvent,'id'|'jobId'>[]):number {
    id.parse(jobId);let added=0;
    this.transaction(()=>{
      const state=this.readProjection();
      const job=state.jobs?.find(item=>item.id===jobId);
      if(!job)throw new Error('Job not found');
      const known=new Set((state.jobEvents??[]).filter(event=>event.jobId===jobId).map(event=>event.externalId));
      const changes:Change[]=[];
      for(const event of events){
        if(known.has(event.externalId))continue;
        known.add(event.externalId);
        changes.push({collection:'jobEvents',value:jobEventSchema.parse({...event,id:randomUUID(),jobId})});
        added++;
      }
      if(added)this.append(state,changes,{kind:'PROVIDER_JOB_EVENTS',projectId:job.projectId,experimentId:null,
        reason:`Recorded ${added} visible provider event${added===1?'':'s'} for this job. Hidden reasoning is never imported.`},null);
    });
    return added;
  }
  /**
   * Creates the one delivery binding a job may hold (QO-LOCAL-REV §5.1). The record starts at
   * revision 0; a second binding for the same job is refused outright rather than merged.
   */
  createLocalSession(record: Omit<LocalSessionRecord,'id'|'revision'|'createdAt'|'updatedAt'> & { id?: string }): LocalSessionRecord {
    let created: LocalSessionRecord | null = null;
    this.transaction(() => {
      const state = this.readProjection();
      const job = state.jobs?.find(item => item.id === record.jobId);
      if (!job) throw new Error('Job not found');
      if ((state.localSessions ?? []).some(item => item.jobId === record.jobId))
        throw new Error('This job already has a local-session binding; reconcile it instead of creating a second.');
      const at = new Date().toISOString();
      created = localSessionRecordSchema.parse({ ...record, id: record.id ?? randomUUID(), revision: 0, createdAt: at, updatedAt: at });
      this.append(state, [{ collection: 'localSessions', value: created }], { kind: 'LOCAL_SESSION_BOUND', projectId: record.projectId, experimentId: null,
        reason: `Bound local session ${record.layout.toLowerCase().replaceAll('_', ' ')} for job ${record.jobId.slice(0, 8)}.` }, null);
    });
    return created!;
  }
  /**
   * Compare-and-swap on a local-session record. The caller computes the complete next record; the
   * store refuses stale revisions and illegal lifecycle edges — the transition table is the law.
   */
  updateLocalSession(input: { localSessionId: string; expectedRevision: number; next: Omit<LocalSessionRecord,'revision'|'updatedAt'> }): LocalSessionRecord {
    let updated: LocalSessionRecord | null = null;
    this.transaction(() => {
      const state = this.readProjection();
      const current = (state.localSessions ?? []).find(item => item.id === input.localSessionId);
      if (!current) throw new Error('Local session record not found');
      if (current.revision !== input.expectedRevision) throw new Error('This local-session record changed since it was read. Reconcile before acting again.');
      const at = new Date().toISOString();
      const next = localSessionRecordSchema.parse({ ...input.next, revision: current.revision + 1, updatedAt: at });
      if (next.id !== current.id || next.jobId !== current.jobId) throw new Error('Local-session identity is immutable; create a new record instead of rebinding.');
      const edge = transitionLocalLifecycle(current.lifecycle, next.lifecycle);
      if (!edge.allowed) throw new Error(edge.detail);
      updated = next;
      this.append(state, [{ collection: 'localSessions', value: next }], { kind: 'LOCAL_SESSION_' + next.lifecycle, projectId: next.projectId, experimentId: null,
        reason: `Local session ${current.lifecycle} → ${next.lifecycle}.` }, null);
    });
    return updated!;
  }
  /** The job's delivery binding, or null for legacy/unbound jobs. Read-only. */
  localSessionForJob(jobId: string): LocalSessionRecord | null {
    id.parse(jobId);
    return (this.readProjection().localSessions ?? []).find(item => item.jobId === jobId) ?? null;
  }
  /** Bounded page of local-session records for one project — the query surface for summaries. */
  localSessionPage(input: { projectId: string; limit?: number; offset?: number }): LocalSessionRecord[] {
    id.parse(input.projectId);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200), offset = Math.max(input.offset ?? 0, 0);
    return (this.readProjection().localSessions ?? []).filter(item => item.projectId === input.projectId).slice(offset, offset + limit);
  }
  /**
   * Appends lifecycle journal steps. Journals are append-only evidence: durable intent first,
   * observed outcome second. A journal row is never rewritten — reconciliation adds a new phase.
   */
  appendLocalJournal(input: Omit<LocalSessionJournal,'id'|'createdAt'|'schemaVersion'> & { operationId?: string }): LocalSessionJournal {
    let written: LocalSessionJournal | null = null;
    this.transaction(() => {
      const state = this.readProjection();
      const record = (state.localSessions ?? []).find(item => item.id === input.localSessionId);
      if (!record) throw new Error('Local session record not found');
      written = localSessionJournalSchema.parse({ ...input, schemaVersion: 1, id: randomUUID(), operationId: input.operationId ?? randomUUID(), createdAt: new Date().toISOString() });
      this.append(state, [{ collection: 'localOps', value: written }], { kind: 'LOCAL_OP_' + input.kind + '_' + input.phase, projectId: record.projectId, experimentId: null,
        reason: `Local-session journal ${input.kind.toLowerCase().replaceAll('_', ' ')} ${input.phase.toLowerCase()}: ${input.outcome.toLowerCase()}.` }, null);
    });
    return written!;
  }
  /** The ordered journal for one local session — reconciliation reads this, not filesystem guesses. */
  localJournalFor(localSessionId: string): LocalSessionJournal[] {
    id.parse(localSessionId);
    return (this.readProjection().localOps ?? []).filter(item => item.localSessionId === localSessionId);
  }
  /**
   * Chronological applied self-report events for one job, oldest-first and bounded. This is the
   * structured query the renderer reads: publicState strips jobEvents entirely, so parsing event
   * text from a pushed snapshot was always dead code. The controller also uses it for ordering
   * dedup — a repeated identical report is a re-polled file, while a return to an earlier value
   * (A→B→A) is a new claim and must land.
   */
  appliedReports(jobId: string, limit = 50): JobEvent[] {
    id.parse(jobId); this.assertOpen();
    const events = (this.readProjection().jobEvents ?? []).filter(event => event.jobId === jobId && event.externalId.startsWith('applied:'));
    return events.slice(-Math.min(Math.max(limit, 1), 500));
  }
  /**
   * The bounded local-session summary the UI renders. The record carries machine fields; this
   * assembles the display shape — requested values from the frozen assignment, the newest
   * structured applied report when one exists (v1 receipts carry none), provider-archive status
   * from the journal, and the honest blockers. `resolveDir` is injected by main because the
   * store never knows where the mailbox and worktree roots live.
   */
  localSessionSummary(jobId: string, resolveDir: (record: LocalSessionRecord) => string): LocalSessionSummary | null {
    id.parse(jobId); this.assertOpen();
    const state = this.readProjection();
    const binding = (state.localSessions ?? []).find(record => record.jobId === jobId);
    if (!binding) return null;
    const assignment = (state.assignments ?? []).find(item => item.id === binding.assignmentId);
    const applied = (state.jobEvents ?? []).filter(event => event.jobId === jobId && event.applied).at(-1)?.applied ?? null;
    const providerOp = this.localJournalFor(binding.id).filter(entry => entry.kind === 'PROVIDER_ARCHIVE').at(-1);
    const blockers: string[] = [];
    if (binding.lifecycle === 'RECONCILE_REQUIRED') blockers.push('This session record needs reconciliation before it can change state again.');
    if (binding.lifecycle === 'PREPARATION_FAILED') blockers.push('Preparation failed — the next dispatch starts a fresh attempt.');
    if (binding.stopStatus === 'REQUESTED') blockers.push('A cancellation request was delivered into the packet; the session has not acknowledged it.');
    if (binding.requirement === 'READ_CONFINEMENT_REQUIRED' && binding.confinementStatus !== 'VERIFIED')
      blockers.push('This context requires read confinement that has not been verified — the worktree lane stays unavailable.');
    const confinementDetail =
      binding.confinementStatus === 'VERIFIED' ? 'Confinement was verified by recorded office evidence.'
      : binding.confinementStatus === 'FAILED' ? 'A confinement check failed — this session is not confined.'
      : binding.confinementStatus === 'STALE' ? 'Confinement verification is stale and must be renewed before relying on it.'
      : binding.requirement === 'READ_CONFINEMENT_REQUIRED' ? 'Read confinement is required but has not been verified.'
      : 'Scoped delivery only — no confinement requirement applies.';
    return localSessionSummarySchema.parse({
      jobId, localSessionId: binding.id, revision: binding.revision,
      layout: binding.layout, surface: binding.surface, lifecycle: binding.lifecycle, stopStatus: binding.stopStatus,
      cwdDisplay: resolveDir(binding).slice(0, 1000),
      grouping: { status: binding.groupingStatus, label: binding.providerProjectId },
      confinement: { required: binding.requirement, status: binding.confinementStatus, detail: confinementDetail },
      requested: { model: assignment?.requestedModel ?? 'unknown', effort: assignment?.requestedEffort ?? 'default', delegation: assignment?.delegation ?? false },
      applied,
      archive: {
        packet: binding.lifecycle === 'ARCHIVED' ? 'ARCHIVED' : 'LIVE',
        provider: !providerOp ? 'NOT_REQUESTED' : providerOp.outcome === 'SUCCESS' ? 'ARCHIVED'
          : providerOp.outcome === 'UNSUPPORTED' ? 'UNSUPPORTED' : providerOp.outcome === 'REFUSED' ? 'BUSY' : 'UNKNOWN',
      },
      blockers,
    });
  }
  /**
   * The bounded launch plan for one bound packet: where the packet lives, its proven hash, and
   * the honest manual steps to run it in the provider's own client. Launching a local packet is
   * always a manual handoff — the office never starts the session — so availability is
   * MANUAL_HANDOFF while the packet is ready and UNSUPPORTED once it is archived or unready.
   */
  localLaunchPlan(jobId: string, resolveDir: (record: LocalSessionRecord) => string): LocalLaunchPlan | null {
    id.parse(jobId); this.assertOpen();
    const binding = (this.readProjection().localSessions ?? []).find(record => record.jobId === jobId);
    if (!binding || !binding.packetHash) return null;
    const cwd = resolveDir(binding).slice(0, 1000);
    const cli = binding.provider === 'claude' ? 'claude' : binding.provider === 'openai' ? 'codex' : 'devin';
    const ready = binding.lifecycle === 'READY' || binding.lifecycle === 'RESTORED_UNBOUND';
    const instructions = [
      `Open a terminal in ${cwd}.`,
      `Start the ${binding.provider} client there (${cli}) — the packet's AGENTS.md and CONTRACT.md carry the task and the required result shape.`,
      'Let the session write result.json plus any files under outputs/ inside this same directory.',
      'Return to this office and Observe the job — a receipt is verified against this packet\'s recorded hash before anything is recorded.',
    ];
    return localLaunchPlanSchema.parse({
      jobId, revision: binding.revision, surface: binding.surface, cwdDisplay: cwd,
      packetHash: binding.packetHash, instructions,
      availability: ready ? 'MANUAL_HANDOFF' : 'UNSUPPORTED',
      detail: ready
        ? 'Manual handoff: the office prepared and verified this packet; running it is your action in the provider\'s own client.'
        : `This packet is ${binding.lifecycle.toLowerCase().replaceAll('_', ' ')} — ${binding.lifecycle === 'ARCHIVED' ? 'it was retired into the archive and is retained, not runnable.' : 'it is not in a runnable state; reconcile the record first.'}`,
    });
  }
  /**
   * Records a session identifier the user reported for a job whose dispatch result the office could
   * not see. This is linkage for reconciliation only: it never changes the job state, promotes a
   * capability, or establishes completion, cancellation or scientific approval.
   */
  recordUserReportedLink(input:{jobId:string;expectedRevision:number;externalId:string;externalUrl:string;at?:string}):AppState {
    id.parse(input.jobId);
    const externalId=z.string().trim().min(1).max(200).parse(input.externalId);
    const externalUrl=z.string().trim().max(2000).parse(input.externalUrl);
    if(externalUrl&&!/^https:\/\/(claude\.ai|code\.claude\.com)\//.test(externalUrl))throw new Error('Link the official provider session URL.');
    return this.transaction(()=>{
      const state=this.readProjection();
      const job=state.jobs?.find(item=>item.id===input.jobId);
      if(!job)throw new Error('Job not found');
      if(job.revision!==input.expectedRevision)throw new Error('This job changed since it was read. Reconcile before acting again.');
      if(['COMPLETED','FAILED','CANCEL_ACKNOWLEDGED'].includes(job.state))throw new Error('This job already has a recorded outcome.');
      if(job.evidence==='PROVIDER_REPORTED'&&job.externalId&&job.externalId!==externalId)throw new Error('This job already carries an identifier the provider itself returned.');
      const at=input.at??new Date().toISOString();
      const next=jobSchema.parse({...job,externalId,externalUrl,evidence:'USER_REPORTED',
        detail:'Session identifier reported by you. The office has not verified it, so this work stays '+job.state.toLowerCase().replaceAll('_',' ')+' until the provider is observed.',
        revision:job.revision+1,updatedAt:at});
      this.append(state,[{collection:'jobs',value:next}],{kind:'PROVIDER_JOB_LINK_USER_REPORTED',projectId:job.projectId,experimentId:null,
        reason:`Linked ${externalId} to this job on your report. User-reported linkage is not a provider receipt, completion or cancellation.`},null);
    });
  }
  /**
   * Records one scoped message between two agents. Immutable, and always tied to a project, request
   * and (when it belongs to one) an assignment, so a message can never float free of its work.
   */
  recordMessage(input:Message):AppState {
    const message=messageSchema.parse(input);
    return this.transaction(()=>{
      const state=this.readProjection();
      const request=state.requests?.find(item=>item.id===message.requestId);
      if(!request||request.projectId!==message.projectId)throw new Error('Message request does not belong to this project');
      for(const round of state.pipeline??[])if(round.kind==='REVIEW_ROUND'&&round.proof.claim.kind==='ISOLATION'
        &&round.proof.claim.contexts.some(c=>c.agentId===message.fromAgentId||c.agentId===message.toAgentId)){
        const reports=(state.pipeline??[]).filter(r=>r.kind==='REVIEW_REPORT'&&r.roundId===round.id&&r.opened);
        if(reports.length!==round.proof.claim.contexts.length)throw new Error('Review messages remain sealed until all immutable first reports are collected.');
      }
      for(const participant of [message.fromAgentId,message.toAgentId]){
        const agent=state.agents?.find(item=>item.id===participant);
        if(!agent)throw new Error('Message participants must be agents in this workspace');
      }
      if(message.fromAgentId===message.toAgentId)throw new Error('An agent cannot message itself');
      if(message.assignmentId){
        const assignment=state.assignments?.find(item=>item.id===message.assignmentId);
        if(!assignment||assignment.requestId!==message.requestId)throw new Error('Message assignment does not belong to this request');
      }
      if(message.scopeSnapshotId&&!state.snapshots?.some(item=>item.id===message.scopeSnapshotId&&item.projectId===message.projectId))
        throw new Error('Shared context must be an input snapshot from this project');
      if(state.messages?.some(item=>item.id===message.id))throw new Error('Message identities are immutable');
      this.append(state,[{collection:'messages',value:message}],{kind:'MESSAGE_SENT',projectId:message.projectId,experimentId:null,
        reason:`${message.kind.toLowerCase().replaceAll('_',' ')} from ${message.fromAgentId} to ${message.toAgentId}; sharing ${message.scopeOutputHashes.length} output reference${message.scopeOutputHashes.length===1?'':'s'}. Sending is not delivery.`},null);
    });
  }
  /** A delivery receipt is recorded separately from the message, and only once. */
  recordMessageDelivery(input:{messageId:string;receipt:string;evidence:JobEvidence;at?:string}):AppState {
    id.parse(input.messageId);
    const receipt=z.string().trim().min(1).max(1000).parse(input.receipt);
    return this.transaction(()=>{
      const state=this.readProjection();
      const message=state.messages?.find(item=>item.id===input.messageId);
      if(!message)throw new Error('Message not found');
      if(message.deliveredAt)throw new Error('This message already has a delivery receipt');
      const at=input.at??new Date().toISOString();
      this.append(state,[{collection:'messages',value:messageSchema.parse({...message,deliveredAt:at,receipt,evidence:input.evidence})}],
        {kind:'MESSAGE_DELIVERED',projectId:message.projectId,experimentId:null,
         reason:`Delivery receipt recorded for one message (${input.evidence.toLowerCase().replaceAll('_',' ')}). A receipt is not a reply.`},null);
    });
  }
  /**
   * Records one independent review decision.
   * Independence is structural: a different agent, a different assignment, and evidence that actually
   * belongs to the work being judged. A role label alone is never independence.
   */
  /**
   * Records one first report by its identity, before anybody reads it.
   *
   * Only the hash is stored here. The office is not the custodian of the text; what it needs is a
   * fact that cannot be reconstructed later, namely that this reviewer had committed to this exact
   * report before seeing anyone else's.
   */
  sealFirstReport(input:SealedReviewReport):AppState {
    const report=sealedReportSchema.parse(input);
    if(report.openedAt!==null)throw new Error('A report is sealed closed. It is opened by opening its round.');
    return this.transaction(()=>{
      const state=this.readProjection();
      const subject=state.assignments?.find(item=>item.id===report.subjectAssignmentId);
      if(!subject||subject.projectId!==report.projectId)throw new Error('The sealed report names an assignment outside this project.');
      if(subject.agentId===report.reviewerAgentId)throw new Error('An agent cannot file a first report on its own work.');
      if(state.sealed?.some(item=>item.id===report.id))throw new Error('Sealed report identities are immutable');
      if(state.sealed?.some(item=>item.subjectAssignmentId===report.subjectAssignmentId&&item.reviewerAgentId===report.reviewerAgentId))
        throw new Error('This reviewer has already sealed a first report for this work.');
      this.append(state,[{collection:'sealed',value:report}],{kind:'FIRST_REPORT_SEALED',projectId:report.projectId,experimentId:null,
        reason:'Recorded the identity of one first report. Its content stays unread until every expected report in the round is sealed.'},null);
    });
  }
  /**
   * Opens a round of first reports, and only a complete one.
   *
   * Returning the reports without this check would make the seal decorative: the guarantee is not
   * that the text was encrypted, it is that nobody could read the first opinion while the others
   * were still forming.
   */
  openSealedRound(input:{subjectAssignmentId:string;expectedReviewerIds:string[];at?:string}):AppState {
    id.parse(input.subjectAssignmentId);
    const expected=z.array(id).min(1).max(64).parse(input.expectedReviewerIds);
    return this.transaction(()=>{
      const state=this.readProjection();
      const reports=(state.sealed??[]).filter(item=>item.subjectAssignmentId===input.subjectAssignmentId);
      const filed=new Set(reports.map(item=>item.reviewerAgentId));
      const outstanding=expected.filter(reviewer=>!filed.has(reviewer));
      if(outstanding.length)throw new Error(`${outstanding.length} of ${expected.length} first reports have not been sealed. A round opens only when it is complete.`);
      const at=input.at??new Date().toISOString();
      const changes:Change[]=reports.filter(item=>item.openedAt===null).map(item=>({collection:'sealed' as const,value:{...item,openedAt:at}}));
      if(!changes.length)return;
      this.append(state,changes,{kind:'SEALED_ROUND_OPENED',projectId:reports[0].projectId,experimentId:null,
        reason:`Opened ${changes.length} first report${changes.length===1?'':'s'} together, once every expected reviewer had committed to theirs.`},null);
    });
  }
  recordReviewDecision(input:ReviewDecision):AppState {
    const decision=decisionSchema.parse(input);
    return this.transaction(()=>{
      const state=this.readProjection();
      const request=state.requests?.find(item=>item.id===decision.requestId);
      if(!request||request.projectId!==decision.projectId)throw new Error('Review request does not belong to this project');
      if(request.revision!==decision.requestRevision)throw new Error('The request changed; review the current version.');
      const subject=state.assignments?.find(item=>item.id===decision.subjectAssignmentId);
      const reviewer=state.assignments?.find(item=>item.id===decision.reviewerAssignmentId);
      if(!subject||subject.requestId!==decision.requestId)throw new Error('The reviewed assignment does not belong to this request');
      if(!reviewer||reviewer.requestId!==decision.requestId)throw new Error('The reviewing assignment does not belong to this request');
      if(subject.id===reviewer.id)throw new Error('A review needs its own separate assignment context');
      if(subject.agentId!==decision.subjectAgentId||reviewer.agentId!==decision.reviewerAgentId)throw new Error('Review agents do not match their assignments');
      if(decision.reviewerAgentId===decision.subjectAgentId)throw new Error('An agent cannot review its own work');
      if(subject.snapshotId!==decision.inputSnapshotId)throw new Error('A review must cite the exact input snapshot the work used');
      const job=(state.jobs??[]).find(item=>item.assignmentId===subject.id);
      if(!job||job.state!=='COMPLETED')throw new Error('There is no completed provider outcome to review yet');
      const outputs=new Set(job.outputs.map(output=>output.sha256));
      if(!decision.outputHashes.length||decision.outputHashes.some(value=>!outputs.has(value)))throw new Error('A review must cite output hashes the provider actually returned');
      const reviewerJob=state.jobs?.find(item=>item.assignmentId===reviewer.id);
      if(!reviewerJob||reviewerJob.state!=='COMPLETED'||reviewerJob.evidence!=='PROVIDER_REPORTED'||!reviewerJob.externalId
        ||!reviewerJob.outputs.length||reviewerJob.outputs.some(output=>!output.stored))
        throw new Error('A review needs its own completed provider outcome and durably retrieved report.');
      if(reviewerJob.externalId===job.externalId)throw new Error('The reviewer must have a separate provider session from the subject.');
      // A verified-independent label is a claim about observed confinement on the route this review
      // actually ran on, so it is checked at the point of the write rather than rendered from intent.
      const independenceBlocker=independenceClaimBlocker({capabilities:state.capabilities??[],reviewer,claim:decision.independence});
      if(independenceBlocker)throw new Error(independenceBlocker);
      if(state.decisions?.some(item=>item.id===decision.id))throw new Error('Review decisions are immutable');
      if(state.decisions?.some(item=>item.subjectAssignmentId===decision.subjectAssignmentId&&item.reviewerAgentId===decision.reviewerAgentId&&item.phase===decision.phase))
        throw new Error('This reviewer already recorded that phase for this work');
      if(decision.phase==='REBUTTAL'&&!state.decisions?.some(item=>item.subjectAssignmentId===decision.subjectAssignmentId&&item.reviewerAgentId===decision.reviewerAgentId&&item.phase==='FIRST'))
        throw new Error('A rebuttal follows that reviewer’s own first report');
      this.append(state,[{collection:'decisions',value:decision}],{kind:'REVIEW_DECISION_RECORDED',projectId:decision.projectId,experimentId:null,
        reason:`${decision.verdict.toLowerCase().replaceAll('_',' ')} by a different agent, bound to request revision ${decision.requestRevision} and ${decision.outputHashes.length} provider output hash${decision.outputHashes.length===1?'':'es'}.`},null);
    });
  }
  /**
   * One page of history, read straight from the index instead of loading the whole log.
   * The cursor is the last sequence seen, so paging is stable while new events arrive.
   */
  historyPage(options:{projectId?:string|null;limit?:number;cursor?:number}={}):{entries:LineageEvent[];nextCursor:number|null;total:number}{
    this.assertOpen();
    const limit=Math.min(Math.max(options.limit??50,1),500);
    const cursor=options.cursor??Number.MAX_SAFE_INTEGER;
    const scopeId=options.projectId??null;const scoped=scopeId!==null;
    if(scoped)id.parse(scopeId);
    const rows=this.db.prepare(scoped
      ?'SELECT sequence FROM event_index WHERE project_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?'
      :'SELECT sequence FROM event_index WHERE sequence<? ORDER BY sequence DESC LIMIT ?')
      .all(...(scoped?[scopeId!,cursor,limit+1]:[cursor,limit+1])) as {sequence:number}[];
    const page=rows.slice(0,limit);
    const total=Number((this.db.prepare(scoped?'SELECT COUNT(*) AS count FROM event_index WHERE project_id=?':'SELECT COUNT(*) AS count FROM event_index').get(...(scoped?[scopeId!]:[]))as{count:number}).count);
    const entries=page.map(row=>{
      const record=this.db.prepare('SELECT record FROM events WHERE sequence=?').get(row.sequence) as {record:string};
      return publicEvent(eventSchema.parse(JSON.parse(record.record)));
    });
    return {entries,nextCursor:rows.length>limit?page.at(-1)!.sequence:null,total};
  }
  /**
   * One page of imported conversation, scoped by agent or conversation, oldest first.
   * The cursor is the ordering key itself (timestamp and row id), so pages never overlap or skip
   * when two entries share a timestamp.
   */
  logPage(options:{agentId?:string;conversationId?:string;limit?:number;cursor?:string}={}):{entries:WorkLog[];nextCursor:string|null;total:number}{
    this.assertOpen();
    const limit=Math.min(Math.max(options.limit??50,1),500);
    const where:string[]=[],parameters:(string|number)[]=[];
    if(options.agentId){id.parse(options.agentId);where.push('agent_id=?');parameters.push(options.agentId);}
    if(options.conversationId){where.push('conversation_id=?');parameters.push(options.conversationId);}
    const countClause=where.length?`WHERE ${where.join(' AND ')}`:'';
    const total=Number((this.db.prepare(`SELECT COUNT(*) AS count FROM log_index ${countClause}`).get(...parameters) as {count:number}).count);
    const paged=[...where],pagedParameters=[...parameters];
    if(options.cursor){
      const [timestamp,...rest]=options.cursor.split('|');
      paged.push('(timestamp>? OR (timestamp=? AND id>?))');
      pagedParameters.push(timestamp,timestamp,rest.join('|'));
    }
    const clause=paged.length?`WHERE ${paged.join(' AND ')}`:'';
    const rows=this.db.prepare(`SELECT id,timestamp FROM log_index ${clause} ORDER BY timestamp,id LIMIT ?`).all(...pagedParameters,limit+1) as {id:string;timestamp:string}[];
    const page=rows.slice(0,limit);
    const logs=this.readProjection().workLogs??[];
    const entries=page.map(row=>logs.find(log=>log.id===row.id.split(':')[0])).filter((log):log is WorkLog=>Boolean(log));
    const last=page.at(-1);
    return {entries,nextCursor:rows.length>limit&&last?`${last.timestamp}|${last.id}`:null,total};
  }
  /** One page of visible provider events for one job, oldest first, keyset paged. */
  jobEventPage(jobId:string,options:{limit?:number;cursor?:string}={}):{entries:JobEvent[];nextCursor:string|null;total:number}{
    id.parse(jobId);this.assertOpen();
    const limit=Math.min(Math.max(options.limit??50,1),500);
    const total=Number((this.db.prepare('SELECT COUNT(*) AS count FROM job_event_index WHERE job_id=?').get(jobId) as {count:number}).count);
    const cursor=options.cursor?options.cursor.split('|'):null;
    const rows=(cursor
      ?this.db.prepare('SELECT id,occurred_at FROM job_event_index WHERE job_id=? AND (occurred_at>? OR (occurred_at=? AND id>?)) ORDER BY occurred_at,id LIMIT ?')
        .all(jobId,cursor[0],cursor[0],cursor.slice(1).join('|'),limit+1)
      :this.db.prepare('SELECT id,occurred_at FROM job_event_index WHERE job_id=? ORDER BY occurred_at,id LIMIT ?').all(jobId,limit+1)) as {id:string;occurred_at:string}[];
    const page=rows.slice(0,limit);
    const known=this.readProjection().jobEvents??[];
    const last=page.at(-1);
    return {entries:page.map(row=>known.find(item=>item.id===row.id)).filter((item):item is JobEvent=>Boolean(item)),
      nextCursor:rows.length>limit&&last?`${last.occurred_at}|${last.id}`:null,total};
  }
  /**
   * Version 1 of the legacy migration: gives old task groups a native request record.
   *
   * It runs only on explicit request, copies the database first, and verifies the rebuilt projection
   * afterwards. Old evidence stays ambiguous: a migrated request is a DRAFT carrying a blocker that
   * says its historical outcome was never recorded as a provider result, and no assignment or job is
   * invented for it. Original event bytes are never rewritten.
   */
  migrateLegacyRequests(options:{copyTo?:string}={}):{migrated:number;skipped:number}{
    this.assertOpen();
    const state=this.readProjection();
    const already=new Set((state.requests??[]).map(request=>request.migratedFromTaskId).filter(Boolean));
    const linkedExperiments=new Set((state.requests??[]).map(request=>request.experimentId).filter(Boolean));
    const groups=new Map<string,ResearchTask[]>();
    for(const task of state.tasks){
      if(task.experimentId&&linkedExperiments.has(task.experimentId))continue;
      const key=task.experimentId??task.id;
      groups.set(key,[...(groups.get(key)??[]),task]);
    }
    const candidates=[...groups.values()]
      .map(tasks=>[...tasks].sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0])
      .filter(root=>!already.has(root.id));
    if(!candidates.length)return {migrated:0,skipped:groups.size};
    if(this.databasePath!==':memory:'){
      const copy=options.copyTo??`${this.databasePath}.before-legacy-request-migration-${randomUUID()}.sqlite`;
      this.db.prepare('VACUUM INTO ?').run(copy);
    }
    const now=new Date().toISOString();
    this.transaction(()=>{
      const current=this.readProjection();
      const changes:Change[]=candidates.map(root=>{
        const experiment=current.experiments.find(item=>item.id===root.experimentId);
        const tasks=groups.get(root.experimentId??root.id)??[root];
        const terminal=tasks.every(task=>['CANCELED','SUPERSEDED'].includes(task.status));
        return {collection:'requests' as const,value:requestSchema.parse({
          migratedFromTaskId:root.id,id:randomUUID(),projectId:root.projectId,experimentId:root.experimentId,
          name:(experiment?.name??root.prompt).slice(0,160).trim()||'Migrated request',
          objective:root.prompt,workType:root.experimentId?'EXPERIMENT':'QUESTION',mode:'SINGLE',
          leadAgentId:null,participantIds:[],acceptanceCriteria:'',revision:0,
          status:terminal?'CANCELED':'DRAFT',
          blockers:[{code:'MIGRATED_LEGACY_RECORD',
            message:`Migrated from a legacy task recorded as ${root.status}. The office never observed a provider result for it.`,
            action:'Review this request and start it again if the work is still wanted.'}],
          delegation:false,createdAt:root.createdAt,updatedAt:now})};
      });
      this.append(current,changes,{kind:'MIGRATION_LEGACY_REQUESTS_V1',projectId:null,experimentId:null,
        reason:`Migrated ${changes.length} legacy task group${changes.length===1?'':'s'} to native requests. Historical outcomes stay ambiguous and no assignment was created.`},null);
    });
    // Replay verification: the rebuilt projection and the hash chain must still agree after migrating.
    this.verifyIntegrity();
    return {migrated:candidates.length,skipped:groups.size-candidates.length};
  }
  /** Open jobs a restarted office must reconcile before it may act on their requests again. */
  openJobs():ProviderJob[]{
    this.assertOpen();
    return (this.readProjection().jobs??[]).filter(job=>!['COMPLETED','FAILED','CANCEL_ACKNOWLEDGED'].includes(job.state));
  }
  importWorkLogs(input:WorkLog[]):number {
    const entries=z.array(logSchema).max(20000).parse(input);let count=0;
    this.transaction(()=>{const state=this.readProjection(),known=new Map((state.workLogs??[]).map(l=>[l.id,l])),changes:Change[]=[];
      for(const entry of entries){const existing=known.get(entry.id);if(existing){const {sourceHash:_old,...left}=existing,{sourceHash:_new,...right}=entry;if(canonical(left)!==canonical(right))throw new Error('Conflicting content for an existing log message. Nothing imported.');continue;}known.set(entry.id,entry);changes.push({collection:'workLogs',value:entry});count++;}
      if(count)this.append(state,changes,{kind:'WORK_LOGS_IMPORTED',projectId:null,experimentId:null,reason:`Imported ${count} user-selected transcript entries; external records are not verified agent execution.`},null);
    });return count;
  }
  workLogs():AgentLog[] {
    this.assertOpen();const result:AgentLog[]=[...(this.readProjection().workLogs??[])];
    for(const event of this.allEvents())for(const change of event.payload.changes)if(change.collection==='agents')result.push({id:event.id+':'+change.value.id,conversationId:'office:'+change.value.id,from:'SYSTEM',to:change.value.id,kind:'STATUS',text:event.reason,timestamp:event.createdAt,sourceHash:event.hash,externalId:event.id,provenance:'OFFICE_EVENT'});
    return result.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id.localeCompare(b.id));
  }
  getArtifact(artifactId: string): Artifact {
    id.parse(artifactId); this.assertOpen();
    const artifact = this.readProjection().artifacts.find(item => item.id === artifactId);
    if (!artifact) throw new Error('Artifact not found');
    return artifact;
  }
  recordTransfer(kind: string, projectId: string | null, reason: string): AppState {
    const transferKind = z.enum(['PROJECT_EXPORTED','WORKSPACE_BACKED_UP','WORKSPACE_RESTORED']).parse(kind);
    const scope = id.nullable().parse(projectId);
    const explanation = z.string().trim().min(1).max(4000).parse(reason);
    return this.transaction(() => {
      const state = this.readProjection();
      if (transferKind === 'PROJECT_EXPORTED' && !scope) throw new Error('Project export requires a project');
      if (transferKind !== 'PROJECT_EXPORTED' && scope !== null) throw new Error('Workspace transfer must use workspace scope');
      if (scope && !state.projects.some(project => project.id === scope)) throw new Error('Project not found');
      this.append(state, [], { kind: transferKind, projectId: scope, experimentId: null, reason: explanation }, null);
    });
  }
  async backup(destination: string): Promise<void> {
    this.assertOpen();
    const normalizedPath = (path: string) => {
      const absolute = existsSync(path) ? realpathSync(path) : resolve(path);
      return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    };
    const source = normalizedPath(this.databasePath), target = normalizedPath(destination);
    if ([source, `${source}-wal`, `${source}-shm`].includes(target)) throw new Error('Backup destination cannot overwrite the active workspace');
    this.verifyIntegrity();
    await sqliteBackup(this.db, destination);
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
