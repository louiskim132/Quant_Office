import {z} from 'zod';
import {STAGES,GATES} from './research';

const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const harnessGateSchema=z.object({gate:z.enum(GATES),outcome:z.enum(['PASS','FAIL','BLOCKED','NOT_APPLICABLE']),detail:z.string().max(4000),rationale:z.string().max(4000)}).strict();
const common={version:z.literal(1),keyId:z.string().min(1).max(120),harnessHash:hash,issuedAt:z.string().datetime(),
 projectId:id,branchId:id,branchRevision:z.number().int().nonnegative(),requestId:id,requestRevision:z.number().int().nonnegative(),
 specId:id,specHash:hash,subjectHash:hash,stage:z.enum(STAGES)};
export const isolationClaimSchema=z.object({...common,kind:z.literal('ISOLATION'),operationId:id,roundId:id,subjectAssignmentId:id,
 evidenceHash:hash,objectHashes:z.array(hash).min(1).max(256),
 contexts:z.array(z.object({agentId:id,contextId:z.string().min(1).max(240),snapshotId:id}).strict()).min(1).max(2),
 // These are independently signed assertions, never provider report fields or renderer intent.
 access:z.literal('EXACT_OBJECTS_ONLY'),cache:z.literal('NO_INTERPRETATION_CACHE'),firstReports:z.literal('SEALED'),
 correctnessBlinded:z.boolean(),route:z.enum(['FAKE_ADAPTER','OFFICIAL_CLI_PTY']),expiresAt:z.string().datetime(),
}).strict();
export const harnessClaimSchema=z.object({...common,kind:z.literal('HARNESS'),operationId:id,assignmentId:id,jobId:id,contextHash:hash,
 externalRunId:z.string().min(1).max(240),reportHash:hash,inputHashes:z.array(hash).max(256),outputHashes:z.array(hash).min(1).max(256),
 gates:z.array(harnessGateSchema).max(32),
 custodyReportHash:hash.optional(),
 shadowEvidenceHash:hash.optional(),thresholdHash:hash.optional(),
}).strict();
export const rebuttalClaimSchema=z.object({...common,kind:z.literal('REBUTTAL'),operationId:id,roundId:id,assignmentId:id,contextId:z.string().min(1).max(240),firstReportHashes:z.array(hash).length(2),reportHash:hash}).strict();
export const signedResearchClaimSchema=z.object({claim:z.discriminatedUnion('kind',[isolationClaimSchema,harnessClaimSchema,rebuttalClaimSchema]),signature:z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256)}).strict();
export type SignedResearchClaim=z.infer<typeof signedResearchClaimSchema>;
export type IsolationClaim=z.infer<typeof isolationClaimSchema>;
export type HarnessClaim=z.infer<typeof harnessClaimSchema>;

/** Supplied by the main-process adapter integration, never imported from candidate outputs/backups. */
export interface ResearchTrustPin {keyId:string;publicKeyPem:string;harnessHash:string;environment:'LOCAL_FIXTURE'|'HOSTED';route:'FAKE_ADAPTER'|'OFFICIAL_CLI_PTY'}
