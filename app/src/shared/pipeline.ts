import {createHash} from 'node:crypto';
import {z} from 'zod';
import {STAGES,STAGE_FUNCTIONS,GATES,type StageFunction} from './research';
import {holdoutSchema,reservationSchema} from './holdout';
import {shadowPredictionSchema,quoteSchema,fillSchema,shadowPolicySchema} from './shadow';
import {signedResearchClaimSchema} from './research-admission';

const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),at=z.string().datetime();
const base={id,projectId:id,branchId:id,createdAt:at};
export const stageContextSchema=z.object({branchId:id,branchRevision:z.number().int().nonnegative(),specId:id,subjectHash:hash,stage:z.enum(STAGES),function:z.enum(STAGE_FUNCTIONS),contextHash:hash,outputSchema:z.literal('research-stage-report@1'),objectHashes:z.array(hash).max(256),requestRevision:z.number().int().nonnegative(),reviewRoundId:id.optional(),isolatedContextId:z.string().min(1).max(240).optional()}).strict();
export type StageContext=z.infer<typeof stageContextSchema>;

/**
 * The identity of one stage task: branch, exact subject, stage, function, profile revision and the
 * output shape it must produce. Computed in one place so the scheduler that creates a task and the
 * store that records it are hashing the same thing — a context that does not recompute is not this
 * task.
 */
export function stageContextHash(input:{branchId:string;specId:string;subjectHash:string;stage:typeof STAGES[number];function:StageFunction;agentId:string;agentRevision:number;outputSchema:string;inputs?:Pick<StageContext,'branchRevision'|'requestRevision'|'objectHashes'|'reviewRoundId'|'isolatedContextId'>}):string{
 return createHash('sha256').update(JSON.stringify({
  branchId:input.branchId,specId:input.specId,subjectHash:input.subjectHash,
  stage:input.stage,function:input.function,agentId:input.agentId,agentRevision:input.agentRevision,
  outputSchema:input.outputSchema,
  ...(input.inputs?{inputs:{branchRevision:input.inputs.branchRevision,requestRevision:input.inputs.requestRevision,objectHashes:[...input.inputs.objectHashes].sort(),...(input.inputs.reviewRoundId?{reviewRoundId:input.inputs.reviewRoundId,isolatedContextId:input.inputs.isolatedContextId}: {})}}:{}),
 })).digest('hex');
}
export const shadowImportSchema=z.object({schemaVersion:z.literal(1),branchId:id,specId:id,subjectHash:hash,policy:shadowPolicySchema,predictions:z.array(shadowPredictionSchema).max(100000),quotes:z.array(quoteSchema).max(100000),fills:z.array(fillSchema).max(100000),outcomes:z.record(id,z.number().finite().nullable()),evaluatedAt:at}).strict();
export const stageReportSchema=z.object({schemaVersion:z.literal(1),branchId:id,specId:id,subjectHash:hash,stage:z.enum(STAGES),contextHash:hash,
 gates:z.array(z.object({gate:z.enum(['G-SPEC','G-CORRECT','G-TIME','G-SPLIT','G-FIT','G-TARGET','G-SELECT','G-TRADETIME','G-ARTIFACT','G-COST','G-PORTFOLIO','G-ECON','G-INTEGRITY','G-SHADOW']),outcome:z.enum(['PASS','FAIL','BLOCKED','NOT_APPLICABLE']),detail:z.string().max(4000),rationale:z.string().max(4000)}).strict()).max(32),
 realisedPrediction:z.object({predictionId:id,outcomeName:z.string().min(1).max(160),value:z.number().finite()}).strict().optional(),
 verdict:z.enum(['SUPPORTS','OPPOSES']).optional(),defectFound:z.boolean().optional(),detail:z.string().max(12000)}).strict()
 .refine(report=>!['S2','S7'].includes(report.stage)||(report.verdict!==undefined&&report.defectFound!==undefined),'A review stage report must declare a verdict and whether it found a defect.');
export const pipelineRecordSchema=z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('REVIEW_INTENT'),branchRevision:z.number().int().nonnegative(),scheduleHash:hash}).strict(),
 z.object({...base,kind:z.literal('HARNESS_INTENT'),assignmentId:id,reportHash:hash,status:z.enum(['OPEN','COMPLETED'])}).strict(),
 z.object({...base,kind:z.literal('REVIEW_ROUND'),proof:signedResearchClaimSchema,verification:z.enum(['LOCAL_FIXTURE','HOSTED'])}).strict(),
 // The controller-separated review round (section 1.6): the same context binding an isolation claim
 // carries, recorded by the office rather than an independent signer. It is the pilot-tier evidence;
 // nothing in it claims provider-side isolation.
 z.object({...base,kind:z.literal('SEPARATED_REVIEW'),stage:z.enum(['S2','S7']),specId:id,specHash:hash,subjectHash:hash,
  branchRevision:z.number().int().nonnegative(),requestId:id,requestRevision:z.number().int().nonnegative(),
  scheduleHash:hash,subjectAssignmentId:id.nullable(),evidenceHash:hash,objectHashes:z.array(hash).min(1).max(256),
  contexts:z.array(z.object({agentId:id,contextId:z.string().min(1).max(240),snapshotId:id}).strict()).min(1).max(2),
  correctnessBlinded:z.boolean(),expiresAt:at}).strict(),
 z.object({...base,kind:z.literal('HARNESS_RECEIPT'),proof:signedResearchClaimSchema,verification:z.enum(['LOCAL_FIXTURE','HOSTED'])}).strict(),
 z.object({...base,kind:z.literal('REBUTTAL_INTENT'),roundId:id,assignmentId:id,firstReportHashes:z.array(hash).length(2)}).strict(),
 // proof is absent on controller-separated rounds: binding is checked against the durable intent.
 z.object({...base,kind:z.literal('REBUTTAL'),roundId:id,assignmentId:id,reportHash:hash,reportBytes:z.number().int().nonnegative(),proof:signedResearchClaimSchema.nullable(),detail:z.string().max(4000)}).strict(),
 // assignmentId/jobId are null when the stage completed without a provider job: a user-run return
 // (S3) or an office validation of bound evidence (S5/S6/S8/S9/S10), labelled by provenance.
 z.object({...base,kind:z.literal('STAGE_COMPLETION'),assignmentId:id.nullable(),jobId:id.nullable(),attemptId:id,specId:id,subjectHash:hash,contextHash:hash,reportHash:hash,stage:z.enum(STAGES),branchRevision:z.number().int().nonnegative(),requestRevision:z.number().int().nonnegative(),provenance:z.enum(['PROVIDER_REPORTED','USER_IMPORTED','OFFICE_VALIDATED']).optional()}).strict(),
 // The exported manual-run package (S3): one frozen identity per branch revision. AWAITING_RETURN is
 // the durable user-wait state — it survives restart and restore without any execution job existing.
 z.object({...base,kind:z.literal('RUN_PACKAGE'),packageId:id,packageHash:hash,specId:id,specHash:hash,subjectHash:hash,
  branchRevision:z.number().int().nonnegative(),requestRevision:z.number().int().nonnegative(),
  expectedFiles:z.array(z.string().max(240)).max(256),requiredGates:z.array(z.enum(GATES)).max(32),objectHash:hash,
  state:z.enum(['AWAITING_RETURN','RETURNED','SUPERSEDED']),returnManifestHash:hash.optional(),exportedAt:at,detail:z.string().max(4000)}).strict(),
 // A bound user return for an exported package. USER_IMPORTED is a provenance label, not approval.
 z.object({...base,kind:z.literal('RUN_RETURN'),packageId:id,packageHash:hash,specId:id,subjectHash:hash,artifactId:id,manifestHash:hash,
  outputHashes:z.array(hash).max(512),status:z.enum(['COMPLETED','EXECUTION_FAILED','INCONCLUSIVE']),
  verification:z.literal('USER_IMPORTED'),summary:z.string().max(4000)}).strict(),
 z.object({...base,kind:z.literal('FORECAST_OUTCOME'),predictionId:id,specId:id,subjectHash:hash,reportHash:hash,value:z.number().finite()}).strict(),
 z.object({...base,kind:z.literal('LINK'),requestId:id,subjectHash:hash,requestRevision:z.number().int().nonnegative(),branchRevision:z.number().int().nonnegative()}).strict(),
 z.object({...base,kind:z.literal('IMPORT'),artifactId:id,subjectHash:hash,specId:id,format:z.enum(['CATBOOST','SHADOW','STAGE_REPORT']),status:z.literal('QUARANTINED'),summary:z.string().max(4000)}).strict(),
 z.object({...base,kind:z.literal('SHADOW_POLICY'),specId:id,policy:shadowPolicySchema}).strict(),
 z.object({...base,kind:z.literal('SHADOW_BATCH'),specId:id,subjectHash:hash,artifactId:id,sourceHash:hash,batchType:z.enum(['PREDICTIONS','OBSERVATIONS','EXECUTIONS']),rows:z.number().int().nonnegative(),thresholdHash:hash,verification:z.literal('USER_IMPORTED')}).strict(),
 z.object({...base,kind:z.literal('MONITOR_VERDICT'),specId:id,subjectHash:hash,thresholdHash:hash,sourceHashes:z.array(hash).max(256),outcome:z.enum(['SHADOW_QUALIFIED','UNKNOWN','INCONCLUSIVE','SUSPENDED','RETIRED']),metric:z.number().finite().nullable(),samples:z.number().int().nonnegative(),missingShare:z.number().min(0).max(1),alarm:z.boolean(),killed:z.boolean(),detail:z.string().max(4000),problems:z.array(z.string().max(120)).max(64),verification:z.literal('USER_IMPORTED')}).strict(),
 z.object({...base,kind:z.literal('HOLDOUT'),holdout:holdoutSchema}).strict(),
 z.object({...base,kind:z.literal('RESERVATION'),reservation:reservationSchema}).strict(),
 z.object({...base,kind:z.literal('HOLDOUT_RESULT'),reservationId:id,specId:id,subjectHash:hash,queryHash:hash,reportHash:hash,reportBytes:z.number().int().nonnegative(),verification:z.enum(['LOCAL_FIXTURE','HOSTED','USER_IMPORTED']),result:z.object({metric:z.string().max(200),value:z.number().finite().nullable(),samples:z.number().int().nonnegative(),detail:z.string().max(4000)}).strict()}).strict(),
 z.object({...base,kind:z.literal('REVIEW_REPORT'),roundId:id.optional(),assignmentId:id,subjectHash:hash,specId:id,reportHash:hash,expectedReviewerIds:z.array(id).min(1).max(64),stage:z.enum(['S2','S7']),verdict:z.enum(['SUPPORTS','OPPOSES']),defectFound:z.boolean(),detail:z.string().max(12000),opened:z.boolean(),independence:z.enum(['VERIFIED_INDEPENDENT','VERIFIED_LOCAL','SEPARATE_SESSION_UNVERIFIED'])}).strict(),
 z.object({...base,kind:z.literal('ADJUDICATION'),roundId:id.optional(),decision:z.enum(['PROMOTE','RETIRE','INCONCLUSIVE','DECISIVE_TEST']).optional(),subjectHash:hash,specId:id,outcome:z.enum(['UPHELD','REVISION_REQUIRED','FOLLOW_UP_GRANTED','LINEAGE_SUSPENDED']),reportIds:z.array(id).length(2),detail:z.string().max(4000)}).strict(),
]);
export type PipelineRecord=z.infer<typeof pipelineRecordSchema>;
export type BranchLink=Extract<PipelineRecord,{kind:'LINK'}>;
export const pipelineActionSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('link'),branchId:id,requestId:id,subjectHash:hash,expectedRevision:z.number().int().nonnegative()}).strict(),
 // The snapshot is staged inside the action so the frozen bytes and the assignments are one step;
 // a caller-supplied snapshot id could name bytes prepared for a different request revision.
 z.object({type:z.literal('prepare'),branchId:id,expectedRevision:z.number().int().nonnegative()}).strict(),
 z.object({type:z.literal('advance'),branchId:id,expectedRevision:z.number().int().nonnegative()}).strict(),
 z.object({type:z.literal('collect'),assignmentId:id}).strict(),
 z.object({type:z.literal('submit'),assignmentId:id}).strict(),
 z.object({type:z.literal('verifySpec'),branchId:id,expectedRevision:z.number().int().nonnegative()}).strict(),
 z.object({type:z.literal('adjudicate'),branchId:id,expectedRevision:z.number().int().nonnegative(),followUp:z.boolean()}).strict(),
 // artifactId selects the imported bounded response on the manual path; absent means ask the runtime.
 z.object({type:z.literal('rebuttal'),assignmentId:id,artifactId:id.optional()}).strict(),
 // S3: export the frozen run package, then admit a bound return. The wait between them is the
 // RUN_PACKAGE record itself — durable across restart, with no execution job anywhere.
 z.object({type:z.literal('exportRunPackage'),branchId:id,expectedRevision:z.number().int().nonnegative()}).strict(),
 z.object({type:z.literal('importRunReturn'),branchId:id,expectedRevision:z.number().int().nonnegative(),artifactId:id}).strict(),
 // Manual collection for any stage assignment: bind an imported stage report to the exact context.
 z.object({type:z.literal('importStageReport'),assignmentId:id,artifactId:id}).strict(),
 // Office stages validate the admitted bound return (or custody/monitoring records) and complete.
 z.object({type:z.literal('validateReturn'),branchId:id,expectedRevision:z.number().int().nonnegative()}).strict(),
 z.object({type:z.literal('shadowPolicy'),branchId:id,expectedRevision:z.number().int().nonnegative(),policy:shadowPolicySchema.omit({thresholdHash:true})}).strict(),
 z.object({type:z.literal('shadowIngest'),branchId:id,artifactId:id,expectedRevision:z.number().int().nonnegative()}).strict(),
 z.object({type:z.literal('monitor'),branchId:id,expectedRevision:z.number().int().nonnegative()}).strict(),
 z.object({type:z.literal('holdoutRegister'),branchId:id,name:z.string().trim().min(1).max(200),timezoneOffsetMinutes:z.number().int().min(-840).max(840),allowancePerPeriod:z.number().int().min(1).max(16)}).strict(),
 z.object({type:z.literal('holdoutReserve'),branchId:id,holdoutId:id,refitHash:hash,queryArtifactId:id.optional()}).strict(),
 z.object({type:z.literal('holdoutEvaluate'),branchId:id,reservationId:id,queryArtifactId:id}).strict(),
 z.object({type:z.literal('holdoutExport'),branchId:id,reservationId:id}).strict(),
 z.object({type:z.literal('holdoutImport'),branchId:id,reservationId:id,artifactId:id}).strict(),
]);
export type PipelineAction=z.infer<typeof pipelineActionSchema>;
export interface PipelinePage {entries:PipelineRecord[];nextCursor:string|null;total:number}
