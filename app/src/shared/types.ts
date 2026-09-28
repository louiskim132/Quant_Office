export type Role = 'DIRECTOR' | 'PM_A' | 'PM_B' | 'PM_C' | 'PM_D' | 'WORKER';
export type Stage =
  | 'CANCELED'
  | 'DRAFT'
  | 'CONTRACT_REVIEW'
  | 'CONTRACT_FROZEN'
  | 'IMPLEMENTING'
  | 'REMOTE_VERIFIED'
  | 'PREFLIGHT_READY'
  | 'WAITING_FOR_USER_PREFLIGHT'
  | 'PREFLIGHT_REVIEW'
  | 'RUN_APPROVED'
  | 'WAITING_FOR_USER_RUN'
  | 'RESULT_VALIDATION'
  | 'INDEPENDENT_ANALYSIS'
  | 'DIRECTOR_DECISION';
export type TaskStatus = 'BLOCKED' | 'QUEUED' | 'RUNNING' | 'ACCEPTED' | 'CANCELED' | 'SUPERSEDED';
export type WorkType =
  'QUESTION' | 'ANALYSIS' | 'IMPLEMENTATION' | 'CODE_REVIEW' | 'EXPERIMENT' | 'PLANNING' | 'RESULT_ANALYSIS' | 'OTHER';
/**
 * What the pending user decision is bound to — recorded by the office when the round's terminal
 * hop verifies COMPLETED. `headReceiptHash` is the terminal hop's verified v2 receipt hash: the
 * immutable identity of the exact report bytes the user is shown. A decision naming any other
 * spec or receipt is stale and refused.
 */
export interface PipelinePendingDecision {
  specHash: string;
  /** The round's terminal assignment (verify for planning, analysis-report for analysis). */
  headAssignmentId: string;
  headReceiptHash: string;
}
/**
 * The recorded user decision on a finished round — bound to the exact spec hash and report
 * receipt the UI displayed. Only the trusted desktop bridge can issue the command, so the
 * record honestly means "a user action in the office UI," never a model-authored verdict.
 * REVISE is a recorded intent with a bounded note; what it spawns next is a separate action.
 */
export interface PipelineDecision {
  decision: 'APPROVE' | 'REVISE' | 'REJECT';
  note: string | null;
  specHash: string;
  headReceiptHash: string;
  decidedAt: string;
}
/**
 * A pipeline request's durable orchestration state (inter-agent pipeline). `briefAssignmentId`
 * names the assignment that carries the current director brief — the first hop, and the target
 * each user note refines. `phase` flips to LAUNCHED only through an explicit confirm command,
 * to AWAITING_DECISION when the terminal hop verifies, and to DECIDED on a recorded user
 * decision. No hop mints user approval — the gate is a waiting state, not a director task.
 */
/**
 * The round a pipeline mints at confirm. FULL is the diverge→converge debate (two planners,
 * cross-critique, synthesis, one implement hop per worker; the analysis round with both
 * cross-responses). QUICK is for small, well-specified requests: one planner and one worker for
 * planning, and no cross-responses for analysis. The director still briefs first either way.
 */
export type PipelineShape = 'FULL' | 'QUICK';
export interface RequestPipeline {
  kind: 'PLANNING' | 'RESULT_ANALYSIS';
  /** Recorded at the first confirm; absent on rounds confirmed before shapes existed (FULL). */
  shape?: PipelineShape;
  specHash: string | null;
  phase: 'BRIEFING' | 'LAUNCHED' | 'AWAITING_DECISION' | 'DECIDED';
  briefAssignmentId: string | null;
  /** A soft, non-blocking heads-up recorded at start (for example outcome-looking files visible to
   *  a planning round with no withheld set). It never gates the request — the user decides. */
  notice?: string;
  pendingDecision?: PipelinePendingDecision;
  decision?: PipelineDecision;
}
/** A bounded user note to the director while a pipeline request is still briefing. */
export interface PipelineNote {
  id: string;
  text: string;
  createdAt: string;
}
export type WorkMode = 'SINGLE' | 'GROUP' | 'TEAM';
export interface Request {
  migratedFromTaskId?: string;
  teamId?: string;
  roleSlots?: RoleSlot[];
  id: string;
  projectId: string;
  experimentId: string | null;
  name: string;
  objective: string;
  workType: WorkType;
  mode: WorkMode;
  leadAgentId: string | null;
  participantIds: string[];
  acceptanceCriteria: string;
  revision: number;
  status: 'DRAFT' | 'READY' | 'CANCELED';
  removedAt?: string;
  blockers: { code: string; message: string; action: string }[];
  delegation: boolean;
  createdAt: string;
  updatedAt: string;
  sourceRequestId?: string;
  /** Present on PLANNING/RESULT_ANALYSIS requests — the comm-round orchestration record. */
  pipeline?: RequestPipeline; /** Bounded user→director notes recorded while briefing. */
  pipelineNotes?: PipelineNote[];
  /** Set on a request minted by a REVISE decision: which request it revises, when, and its ordinal. */
  revisionOf?: {
    requestId: string;
    decisionAt: string;
    round: number;
    /** IMPLEMENTATION: the revision keeps the settled plan — the director amends it and one worker re-applies it. Absent: a full new round. */
    restartAt?: 'IMPLEMENTATION';
  };
  /**
   * Set on a RESULT_ANALYSIS request that analyzes a planning round's result: the PLANNING request
   * whose plan-synthesis pre-registered outputs/analysis-plan.md. The analysis brief inherits that
   * hop's verified outputs, so the analysis plan is fixed at the end of planning — before any
   * result exists — instead of being re-derived at the start of analysis.
   */
  analysisOf?: { requestId: string };
}
export interface Project {
  localFolder?: string;
  cloudWorkspace?: string;
  id: string;
  name: string;
  mandate: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  removedAt?: string;
  budgetCents: number;
}
export interface Experiment {
  id: string;
  projectId: string;
  name: string;
  hypothesis: string;
  stage: Stage;
  revision: number;
  createdAt: string;
  updatedAt: string;
  contract: ResearchContract;
}
export interface ResearchContract {
  objective: string;
  dataPolicy: string;
  modelFamilies: string;
  evaluation: string;
  economics: string;
  protectedRegions: string;
  requiredChecks: string;
  limitations: string;
}
export interface ResearchTask {
  id: string;
  projectId: string;
  experimentId: string | null;
  prompt: string;
  recipient: Role;
  status: TaskStatus;
  blocker: string | null;
  removedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Artifact {
  id: string;
  projectId: string;
  experimentId: string | null;
  name: string;
  sha256: string;
  size: number;
  kind: 'REFERENCE' | 'RESULT';
  classification: 'UNCLASSIFIED' | 'USER_ATTESTED';
  status: 'STORED' | 'CONTENT_VERIFIED' | 'QUARANTINED';
  createdAt: string;
  mediaType: string;
  note: string;
}
export interface ReviewReport {
  id: string;
  projectId: string;
  experimentId: string;
  role: Role;
  bundleHash: string;
  verdict: string;
  content: string;
  disclosed: boolean;
  createdAt: string;
}
export interface LineageEvent {
  sequence: number;
  id: string;
  kind: string;
  projectId: string | null;
  experimentId: string | null;
  actor: string;
  reason: string;
  createdAt: string;
  previousHash: string;
  hash: string;
}
export interface Settings {
  theme: 'dark' | 'light';
  reducedMotion: boolean;
  globalBudgetCents: number;
}
export interface Spend {
  actualCents: number;
  reservedCents: number;
}
export type Provider = 'openai' | 'claude' | 'devin';
/** Where an agent session actually runs. LOCAL means this machine's installed CLI; nothing silently falls back between environments. */
export type ExecutionEnvironment = 'HOSTED_SETUP_REQUIRED' | 'LOCAL';
/** What a session may access; navigation profiles (e.g. a Serena-backed index) ride this field later. */
export type ToolProfile = 'STANDARD' | 'CODE_NAV';
export type Effort = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export interface AgentDraft {
  name: string;
  provider: Provider;
  model: string;
  team: string;
  role: Role;
  instructions: string;
  effort?: Effort;
  execution?: ExecutionEnvironment;
  toolProfile?: ToolProfile;
  /** Which local adapter serves a LOCAL profile: the manual mailbox packet or the office-spawned CLI run. Absent means mailbox. */ localRoute?:
    'LOCAL_MAILBOX' | 'LOCAL_CLI_EXEC';
}
/** `account` is the identity this profile was created for. `connectionId` is set only by an explicit, verified binding. */
/**
 * `account` is the identity this profile is bound to now; `setupAccount` is the identity it was
 * created for and never changes. A deliberate rebinding moves the first and preserves the second, so
 * the profile's origin stays legible afterwards. Profiles saved before this distinction existed have
 * no `setupAccount`, and their origin is genuinely unknown rather than assumed to be the current one.
 */
export interface Agent extends AgentDraft {
  revision?: number;
  removedAt?: string;
  deletedAt?: string;
  id: string;
  account: string;
  setupAccount?: string;
  createdAt: string;
  connectionVerifiedAt: string;
  connectionId?: string;
  bindingVerifiedAt?: string;
  execution: ExecutionEnvironment;
}
export interface UsageWindow {
  label: string;
  remainingPercent: number;
  resetsAt: number;
}
export interface Connection {
  provider: Provider;
  connected: boolean;
  account: string;
  models: {
    id: string;
    name: string;
    efforts?: Effort[];
    defaultEffort?: Effort;
    effortDescriptions?: { effort: Effort; description: string }[];
    family?: string;
    effort?: Effort;
    source?: string;
  }[];
  windows: UsageWindow[];
  checkedAt: string;
  note: string;
}
export interface WorkLog {
  id: string;
  conversationId: string;
  from: string;
  to: string;
  kind: 'MESSAGE' | 'TOOL' | 'STATUS';
  text: string;
  timestamp: string;
  sourceHash: string;
  externalId: string;
  provenance: 'USER_IMPORTED';
}
export interface AgentLog extends Omit<WorkLog, 'provenance'> {
  provenance: 'USER_IMPORTED' | 'OFFICE_EVENT';
}
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  messages: number;
}
export interface LocalUsage {
  root: string;
  scannedAt: string;
  files: number;
  skipped: number;
  malformed: number;
  duplicates: number;
  partial: boolean;
  sessions: number;
  last5Hours: TokenTotals;
  last7Days: TokenTotals;
  daily: { day: string; totals: TokenTotals }[];
  models: { model: string; totals: TokenTotals }[];
  note: string;
}
export interface AgentTicket {
  id: string;
  draft: AgentDraft;
  connection: Connection;
  expiresAt: number;
}
/** Durable record of an official provider sign-in observation. Never stores raw credentials. */
export interface AccountConnection {
  id: string;
  provider: Provider;
  identity: string;
  credentialContext: string;
  state: 'SIGNED_IN' | 'SIGNED_OUT' | 'UNKNOWN';
  allowance: UsageWindow[];
  note: string;
  revision: number;
  firstSeenAt: string;
  lastCheckedAt: string;
  sequence?: number;
}
export type VerificationLevel = 'DOCUMENTED' | 'TOOL_SUPPORTED' | 'ACCOUNT_VERIFIED' | 'UNAVAILABLE' | 'UNKNOWN';
/** OBSERVED evidence came from actually exercising the operation. DOCUMENTED evidence is reference material only and can never make anything runnable. */
export type EvidenceKind = 'OBSERVED' | 'DOCUMENTED';
import type { ObjectDescription, ReadResult, SearchResult, StagePacket } from './evidence.js';
import type {
  ResearchBranch,
  FrozenResearchSpec,
  PredictionRecord,
  TrialLedgerEntry,
  StageAttempt,
  GateReceipt,
  FunctionAssignment,
  StageFunction,
  Stage as ResearchStage,
  GateId,
  SpecSections,
  ScientificOutcome,
} from './research.js';
export type { ResearchBranch, FrozenResearchSpec, PredictionRecord, TrialLedgerEntry, StageAttempt, GateReceipt };

export type CapabilityOperation =
  | 'ACCOUNT_STATUS'
  | 'MODEL_CATALOG'
  | 'ALLOWANCE_READ'
  | 'CLOUD_SUBMIT'
  | 'CLOUD_OBSERVE'
  | 'CLOUD_FOLLOW_UP'
  | 'CLOUD_OUTPUT_FETCH'
  | 'CLOUD_CANCEL_REQUEST'
  | 'CLOUD_CANCEL_ACK'
  | 'MODEL_APPLICATION'
  | 'EFFORT_APPLICATION'
  | 'ENVIRONMENT_IDENTITY'
  | 'DELEGATION_CONTROL'
  | 'TOOL_CONFINEMENT'
  | 'CLOUD_CANCEL'
  | 'LOCAL_SUBMIT'
  | 'LOCAL_OBSERVE'
  | 'LOCAL_OUTPUT_FETCH'
  | 'LOCAL_CANCEL'
  | 'LOCAL_RETIRE';
/** The adapter route an observation was taken through. Two routes sharing a transport are not equivalent. */
export type AdapterRoute =
  'FAKE_ADAPTER' | 'OFFICIAL_TERMINAL_HANDOFF' | 'OFFICIAL_CLI_PTY' | 'LOCAL_MAILBOX' | 'LOCAL_CLI_EXEC' | 'LOCAL_ACP';
/**
 * What was actually observed to be confined, as opposed to what was requested.
 *
 * Delegation control describes delegation and nothing else. Whether tools, the filesystem, the
 * network and the environment were really restricted is a separate fact needing its own observation;
 * a boolean on a request, or a model's assurance, is not evidence of an enforced restriction.
 */
export interface ConfinementPolicy {
  tools: string;
  filesystem: string;
  network: string;
  environment: string;
}
/**
 * Evidence for one operation, scoped to the exact conditions it was observed under.
 *
 * `model`, `environment`, `effort` and `delegation` are the scope. Evidence that does not declare a
 * value cannot stand in for a check that requires one: an observation taken without a chosen effort
 * says nothing about whether a non-default effort would actually be applied. `environment` falls
 * back to the snapshot's own environment, because that is genuinely where the observation happened.
 */
export interface CapabilityEvidence {
  operation: CapabilityOperation;
  level: VerificationLevel;
  detail: string;
  evidence?: EvidenceKind;
  verifiedAt?: string;
  model?: string;
  environment?: string;
  effort?: Effort;
  delegation?: boolean;
  route?: AdapterRoute;
  confinement?: ConfinementPolicy;
  source?: string;
}
export interface CapabilityModel {
  id: string;
  name: string;
  efforts?: Effort[];
  defaultEffort?: Effort;
  effortDescriptions?: { effort: Effort; description: string }[];
  family?: string;
  effort?: Effort;
  source?: string;
}
/** Immutable evidence of what one provider tool could actually do for one account at one moment. */
export interface ProviderCapabilitySnapshot {
  id: string;
  provider: Provider;
  connectionId: string;
  identity: string;
  toolVersion: string;
  transport: 'NONE' | 'OFFICIAL_CLI_PIPE' | 'OFFICIAL_CLI_TERMINAL' | 'LOCAL_MAILBOX' | 'LOCAL_CLI_EXEC' | 'LOCAL_ACP';
  environment: string;
  models: CapabilityModel[];
  operations: CapabilityEvidence[];
  source: string;
  contentHash: string;
  observedAt: string;
  /** Set only in the projection: this older snapshot's model list was omitted (LR-6); the event log still holds it. */
  modelsOmitted?: true;
}
/** Each action is decided on its own evidence. They are deliberately never collapsed into one optimistic boolean. */
export interface ReadinessActions {
  prepare: boolean;
  handoff: boolean;
  automaticStart: boolean;
  observe: boolean;
  requestCancellation: boolean;
  duplicate: boolean;
  viewTerminalHistory: boolean;
}
export interface EffectiveEvidence {
  operation: CapabilityOperation;
  level: VerificationLevel;
  evidence: EvidenceKind;
  verifiedAt: string;
  model: string;
  environment: string;
  effort?: Effort;
  delegation?: boolean;
  route?: AdapterRoute;
  confinement?: ConfinementPolicy;
  transport: ProviderCapabilitySnapshot['transport'];
  detail: string;
  source: string;
  snapshotId: string;
  expired: boolean;
  /** Stamped later than the moment it is being judged at, so it cannot be treated as verified. */ impossible: boolean;
}
export interface ProviderReadiness {
  provider: Provider;
  connectionId: string;
  identity: string;
  signedIn: boolean;
  accountFresh: boolean;
  modelChecked: boolean;
  dispatchChecked: boolean;
  ready: boolean;
  model: string;
  lastObservedAt: string;
  lastCheckedAt: string;
  actions: ReadinessActions;
  evidence: EffectiveEvidence[];
  blockers: string[];
  blockerDetails?: { message: string; blocks: 'THIS_ACTION' | 'AUTOMATIC_START' }[];
}
/** Where a project's inputs come from and where its outputs go. Versioned; edits carry an expected revision. */
export interface ProjectLocation {
  id: string;
  projectId: string;
  localFolder: string;
  inputPaths: string[];
  outputFolder: string;
  /** Project-relative path prefixes withheld from BLIND-scope planning packets (e.g. `results/`).
   *  Hash-only entries in the packet manifest keep the withholding itself on the record. */
  withheldPaths: string[];
  sourceRepository: string;
  snapshotRoute: 'SELECTED_FILES_GIT_SNAPSHOT' | 'PROJECT_FOLDER_SNAPSHOT';
  providerTarget: {
    provider: Provider;
    host: 'ANTHROPIC_MANAGED' | 'LOCAL_MACHINE';
    selection: 'PROVIDER_DEFAULT';
    environmentId: string;
    resolved: boolean;
  };
  legacyNote: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface SnapshotFile {
  path: string;
  bytes: number;
  sha256: string;
}
/** Immutable record of the exact bytes staged for one transfer. Later source edits cannot change it. */
export interface InputSnapshot {
  /** New snapshots with durable objects require those objects in backups and restores. */
  objectsStored?: true;
  id: string;
  projectId: string;
  requestId: string | null;
  locationRevision: number;
  requestRevision: number | null;
  route: 'SELECTED_FILES_GIT_SNAPSHOT' | 'PROJECT_FOLDER_SNAPSHOT' | 'GENERATED_REQUEST_ONLY';
  files: SnapshotFile[];
  /** Office-written bookkeeping under the reserved directory. Absent on snapshots prepared before R2. */
  generated?: SnapshotFile[];
  totalBytes: number;
  manifestHash: string;
  stagingCommit: string;
  stagingPath: string;
  warnings: string[];
  provenance: 'OFFICE_STAGED';
  createdAt: string;
}
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** A team is an identity, not a routing key: renaming one never changes who work goes to. */
export interface Team {
  id: string;
  projectId: string | null;
  name: string;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface TeamMembership {
  id: string;
  teamId: string;
  agentId: string;
  role: Role;
  createdAt: string;
  removedAt?: string;
}
export interface RoleSlot {
  role: Role;
  count: number;
}
/** One scoped exchange between two agents. Content and delivery are recorded separately. */
export interface Message {
  id: string;
  projectId: string;
  requestId: string;
  assignmentId: string | null;
  fromAgentId: string;
  toAgentId: string;
  kind: 'HANDOFF' | 'QUESTION' | 'ANSWER' | 'REVIEW_REQUEST' | 'REVIEW_RESULT';
  body: string;
  scopeSnapshotId: string | null;
  scopeOutputHashes: string[];
  sentAt: string;
  deliveredAt: string;
  receipt: string;
  evidence: JobEvidence;
}
/**
 * Exactly what the adapter will be given, captured when the user froze the work.
 *
 * A hash proves a later payload is different; it cannot reproduce the original. Without the text
 * itself, launching would have to re-read the current request, which is how a freshly edited prompt
 * ends up travelling with an old input snapshot and an old account binding.
 */
export interface FrozenAssignmentPayload {
  /** Empty means the restored workspace's managed output root. Absent on legacy assignments. */
  outputFolder?: string;
  requestName: string;
  objective: string;
  acceptanceCriteria: string;
  instructions: string;
  model: string;
  effort: Effort;
  delegation: boolean;
  /**
   * The account context by value. The connection row this work points at is updated in place by
   * later observations, so an identifier alone cannot detect a context change; these can.
   */
  accountIdentity: string;
  credentialContext: string;
}
/**
 * Permission for one agent to act on one request in one named function.
 *
 * R4 removed the participant check because a reviewer must not be the author, and listing reviewers
 * as participants would defeat the point. That is a reason for a separate grant, not a reason to let
 * any agent join any request: independence explains who may review, it does not authorize everyone.
 */
/**
 * A durable record of one attempt to create a verification session.
 *
 * Written before the provider is contacted, so a crash, a timeout or a failed write after the call
 * leaves evidence that something may have been created. That is the difference between "we know
 * nothing was submitted" and "we do not know", and it is what lets an unresolved attempt block
 * another one instead of silently spending the user's subscription twice.
 */
export interface ProbeAttempt {
  id: string;
  provider: Provider;
  connectionId: string;
  identity: string;
  credentialContext: string;
  toolVersion: string;
  environment: string;
  route: AdapterRoute;
  model: string;
  /**
   * INTENT and UNKNOWN are unresolved: the provider's view is not established, and another attempt
   * is refused. RECONCILED means a person checked with the provider and recorded what they found;
   * it closes the attempt without ever becoming evidence that the route works.
   */
  state: 'INTENT' | 'ACCEPTED' | 'UNKNOWN' | 'REFUSED' | 'RECONCILED';
  externalId: string;
  externalUrl: string;
  detail: string;
  failureCode: string;
  /** Kept for reconciliation while unresolved, so a later investigation has the exact fixture. */
  stagingPath: string;
  snapshotId: string;
  startedAt: string;
  settledAt: string;
}
export interface RequestGrant {
  id: string;
  requestId: string;
  projectId: string;
  agentId: string;
  capacity: 'REVIEW' | 'WORKER' | 'DIRECTOR' | 'DELEGATE';
  grantedAt: string;
  revokedAt?: string;
}
/** A review is bound to the exact versions it judged. Change any of them and it stops counting. */
export interface ReviewDecision {
  id: string;
  projectId: string;
  requestId: string;
  requestRevision: number;
  subjectAssignmentId: string;
  subjectAgentId: string;
  reviewerAssignmentId: string;
  reviewerAgentId: string;
  inputSnapshotId: string;
  outputHashes: string[];
  bundleHash: string;
  phase: 'FIRST' | 'REBUTTAL';
  verdict: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  rationale: string;
  /** Absent on decisions recorded before C4; never upgraded after the fact. */
  independence?: 'VERIFIED_INDEPENDENT' | 'SEPARATE_SESSION_UNVERIFIED';
  independenceDetail?: string;
  createdAt: string;
}
export type JobState =
  | 'INTENT'
  | 'SUBMITTING'
  | 'ACCEPTED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'CANCEL_REQUESTED'
  | 'CANCEL_ACKNOWLEDGED';
/** Who says so. USER_REPORTED linkage is a hint to reconcile, never an outcome. */
export type JobEvidence = 'OFFICE_LOCAL' | 'PROVIDER_REPORTED' | 'USER_REPORTED';
export type DispatchRoute =
  'FAKE_ADAPTER' | 'OFFICIAL_TERMINAL_HANDOFF' | 'OFFICIAL_CLI_PTY' | 'LOCAL_MAILBOX' | 'LOCAL_CLI_EXEC' | 'LOCAL_ACP';
/** Everything one attempt was frozen against. Later edits to the request, profile or files cannot change it. */
export interface Assignment {
  research?: import('./pipeline').StageContext;
  dependsOn?: string[];
  /** Declared tool scope for this assignment; absent on records frozen before the field existed. */
  toolProfile?: import('./tool-profile').ToolProfile;
  /** The comm-round spec entry this assignment was minted for — idempotent mints key on it. */
  pipelineKey?: string;
  /** BLIND packets receive the project's withheld paths as hash-only manifest entries; FULL (the
   *  default, and every record frozen before this field existed) receives the staged files. */
  inputScope?: 'BLIND' | 'FULL';
  id: string;
  projectId: string;
  requestId: string;
  requestRevision: number;
  agentId: string;
  agentRevision: number;
  connectionId: string;
  capabilitySnapshotId: string;
  snapshotId: string;
  route: DispatchRoute;
  requestedModel: string;
  resolvedModel: string;
  requestedEffort: Effort;
  appliedEffort: Effort | 'UNVERIFIED';
  delegation: boolean;
  objectiveHash: string;
  /**
   * Every capability snapshot that supplied evidence for this scope, not only the newest one.
   * Binding to the newest alone lets a later metadata-only observation stand in for the transport
   * check that actually authorized the work. Absent on assignments frozen before R3-A.
   */
  capabilitySnapshotIds?: string[];
  /** Absent on assignments frozen before this payload existed; those must be prepared again. */
  frozen?: FrozenAssignmentPayload;
  createdAt: string;
}
/** A first report whose identity is on record before its text may be read. */
export interface SealedReviewReport {
  id: string;
  projectId: string;
  subjectAssignmentId: string | null;
  reviewerAgentId: string;
  phase: 'FIRST';
  contentHash: string;
  sealedAt: string;
  openedAt: string | null;
}
export interface JobOutput {
  path: string;
  sha256: string;
  bytes: number;
  stored?: true;
}
export interface ProviderJob {
  id: string;
  assignmentId: string;
  projectId: string;
  requestId: string;
  provider: Provider;
  route: DispatchRoute;
  state: JobState;
  evidence: JobEvidence;
  detail: string;
  externalId: string;
  externalUrl: string;
  outputs: JobOutput[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string;
  settledAt: string;
  /** Which run of this assignment this job record is — absent on records written before retries
   *  existed; treat absent as attempt 1. One assignment may carry several attempts. */
  attempt?: number;
  /** The last thing an observation verified about this job, bounded. Never used to claim a state
   *  the transition record did not settle. */
  lastObservation?: string;
}
/** One visible provider event. Hidden reasoning is never imported. */
export interface JobEvent {
  id: string;
  jobId: string;
  externalId: string;
  cursor: string;
  kind: 'STATUS' | 'MESSAGE' | 'TOOL' | 'OUTPUT';
  text: string;
  occurredAt: string;
  receivedAt: string;
  evidence: JobEvidence;
  /** Structured self-report payload; absent on historical events and non-applied events. */
  applied?: import('./local-session.js').AppliedReportPayload;
}
export type { FunctionAssignment, StageFunction };
// --- Office-controlled memory (M-memory workstream) -------------------------------------
/** What a finding asserts. The office stores the claim and its provenance — never a truth verdict. */
export type FindingKind = 'OBSERVATION' | 'HYPOTHESIS' | 'RESULT' | 'DEFECT' | 'DECISION' | 'NOTE';
/** How one finding bears on another. Relationships are validated links, not endorsed truth. */
export type RelationshipKind = 'SUPPORTS' | 'CONTRADICTS' | 'RELATES' | 'DUPLICATES' | 'REFINES';
/** A reference anchoring a finding to durable evidence the office already holds. */
export interface FindingEvidenceRef {
  kind: 'OBJECT' | 'ASSIGNMENT' | 'JOB' | 'REQUEST' | 'FINDING';
  /** The object sha256 for OBJECT; the record id for the other kinds. */
  id: string;
}
/** Who recorded the entry — the surface honestly distinguishes session self-report from office/user authorship. */
export interface MemoryAuthor {
  surface: 'AGENT_SESSION' | 'OFFICE' | 'USER';
  agentId?: string;
  /** For AGENT_SESSION entries: the verified v2 receipt hash the finding rode in on. */
  receiptHash?: string;
}
/**
 * One append-only memory finding. Findings are never edited or deleted — a correction is a new
 * finding that supersedes the old, and the old record keeps its provenance. The Office store is
 * the authoritative ledger; external memory engines, if ever attached, are derived projections.
 */
export interface MemoryFinding {
  id: string;
  projectId: string;
  requestId: string | null;
  assignmentId: string | null;
  kind: FindingKind;
  /** One-line claim — the graph label. */
  title: string;
  /** Bounded body — the finding itself, never a transcript dump. */
  body: string;
  evidenceRefs: FindingEvidenceRef[];
  createdBy: MemoryAuthor;
  createdAt: string;
  /** Set when a later finding corrects or replaces this one; the record itself is never rewritten. */
  supersededById?: string | null;
}
export type RelationshipStatus = 'PROPOSED' | 'CONFIRMED' | 'REFUTED';
/**
 * A proposed link between two findings in the same project. Sessions propose; the office
 * validates endpoints mechanically; a user (or office review) settles the status. PROPOSED
 * links render as unconfirmed — they are never silently treated as established structure.
 */
export interface MemoryRelationship {
  id: string;
  projectId: string;
  fromFindingId: string;
  toFindingId: string;
  kind: RelationshipKind;
  note: string | null;
  status: RelationshipStatus;
  createdBy: MemoryAuthor;
  createdAt: string;
  decidedAt?: string;
}
/** Bounded read model for the interactive graph — nodes and edges only; bodies come via detail lookups. */
export interface MemoryGraphNode {
  findingId: string;
  kind: FindingKind;
  title: string;
  superseded: boolean;
}
export interface MemoryGraphEdge {
  relationshipId: string;
  from: string;
  to: string;
  kind: RelationshipKind;
  status: RelationshipStatus;
}
export interface MemoryGraph {
  projectId: string;
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}
export interface AppState {
  pipeline?: import('./pipeline').PipelineRecord[];
  schemaVersion: 1;
  requests?: Request[];
  findings?: MemoryFinding[];
  relationships?: MemoryRelationship[];
  grants?: RequestGrant[];
  probes?: ProbeAttempt[];
  branches?: ResearchBranch[];
  specs?: FrozenResearchSpec[];
  predictions?: PredictionRecord[];
  trials?: TrialLedgerEntry[];
  attempts?: StageAttempt[];
  receipts?: GateReceipt[];
  functions?: FunctionAssignment[];
  sealed?: SealedReviewReport[];
  teams?: Team[];
  memberships?: TeamMembership[];
  messages?: Message[];
  decisions?: ReviewDecision[];
  locations?: ProjectLocation[];
  snapshots?: InputSnapshot[];
  assignments?: Assignment[];
  jobs?: ProviderJob[];
  jobEvents?: JobEvent[];
  connections?: AccountConnection[];
  capabilities?: ProviderCapabilitySnapshot[];
  localSessions?: import('./local-session.js').LocalSessionRecord[];
  localOps?: import('./local-session.js').LocalSessionJournal[];
  projects: Project[];
  experiments: Experiment[];
  tasks: ResearchTask[];
  artifacts: Artifact[];
  reviews: ReviewReport[];
  events: LineageEvent[];
  agents: Agent[];
  settings: Settings;
  spend: Spend;
}
export type Command =
  | {
      type: 'request.create';
      idempotencyKey: string;
      projectId: string;
      name: string;
      hypothesis: string;
      workType?: WorkType;
      mode?: WorkMode;
      leadAgentId?: string | null;
      participantIds?: string[];
      acceptanceCriteria?: string;
      analysisOfRequestId?: string;
    }
  | {
      type: 'request.update';
      idempotencyKey: string;
      requestId: string;
      expectedRevision: number;
      objective: string;
      leadAgentId: string | null;
      participantIds: string[];
      acceptanceCriteria: string;
    }
  | {
      type: 'request.start' | 'request.cancel' | 'request.duplicate';
      idempotencyKey: string;
      requestId: string;
      expectedRevision: number;
    }
  /** specHash is filled by the main process from the confirm gate's mint; the renderer sends only the shape. */
  | {
      type: 'request.pipeline.confirm';
      idempotencyKey: string;
      requestId: string;
      expectedRevision: number;
      shape?: PipelineShape;
      specHash?: string;
    }
  | { type: 'request.pipeline.note'; idempotencyKey: string; requestId: string; expectedRevision: number; text: string }
  /** Re-arm one pipeline hop after a settled or verified-unresolved attempt: mints the next attempt job on the same assignment. */
  | {
      type: 'request.pipeline.retryHop';
      idempotencyKey: string;
      requestId: string;
      expectedRevision: number;
      pipelineKey: string;
    }
  /** The user's decision on a finished round — carries the hashes the UI displayed so a stale approval is refused. */
  | {
      type: 'request.pipeline.decide';
      idempotencyKey: string;
      requestId: string;
      expectedRevision: number;
      decision: 'APPROVE' | 'REVISE' | 'REJECT';
      note?: string;
      restartAt?: 'IMPLEMENTATION';
      expectedSpecHash: string;
      expectedReceiptHash: string;
    }
  /** A user-authored finding in the office memory ledger — bounded, evidence-referenced, append-only. */
  | {
      type: 'memory.finding.note';
      idempotencyKey: string;
      projectId: string;
      requestId?: string | null;
      kind: FindingKind;
      title: string;
      body: string;
      evidenceRefs?: FindingEvidenceRef[];
      supersedesFindingId?: string;
    }
  | {
      type: 'memory.relationship.settle';
      idempotencyKey: string;
      relationshipId: string;
      status: 'CONFIRMED' | 'REFUTED';
    }
  | {
      type: 'memory.relationship.propose';
      idempotencyKey: string;
      projectId: string;
      fromFindingId: string;
      toFindingId: string;
      kind: RelationshipKind;
      note?: string;
    }
  | { type: 'agent.remove'; idempotencyKey: string; agentId: string; removed: boolean }
  | { type: 'agent.delete'; idempotencyKey: string; agentId: string }
  | {
      type: 'agent.update';
      idempotencyKey: string;
      agentId: string;
      expectedRevision?: number;
      name: string;
      team: string;
      role: Role;
      instructions: string;
    }
  | {
      type: 'project.create';
      idempotencyKey: string;
      name: string;
      mandate: string;
      budgetCents: number;
      localFolder?: string;
      cloudWorkspace?: string;
    }
  | {
      type: 'project.update';
      idempotencyKey: string;
      projectId: string;
      name: string;
      mandate: string;
      budgetCents: number;
      localFolder?: string;
      cloudWorkspace?: string;
    }
  | { type: 'project.archive'; idempotencyKey: string; projectId: string; archived: boolean }
  | { type: 'team.create'; idempotencyKey: string; name: string; projectId: string | null }
  | { type: 'team.rename'; idempotencyKey: string; teamId: string; expectedRevision: number; name: string }
  | { type: 'team.member'; idempotencyKey: string; teamId: string; agentId: string; role: Role; member: boolean }
  | {
      type: 'request.slots';
      idempotencyKey: string;
      requestId: string;
      expectedRevision: number;
      teamId: string | null;
      slots: RoleSlot[];
    }
  | {
      type: 'request.grant';
      idempotencyKey: string;
      requestId: string;
      agentId: string;
      capacity: RequestGrant['capacity'];
      granted: boolean;
    }
  | {
      type: 'research.draftSpec';
      idempotencyKey: string;
      projectId: string;
      branchId?: string;
      expectedRevision?: number;
      name: string;
      sections: SpecSections;
      thresholds: { gate: GateId; rule: string }[];
      notApplicable: { gate: GateId; rationale: string }[];
      gateEvidence?: { gate: GateId; tier: 'SIGNED_HARNESS' }[];
      maxSelectionTrials: number;
    }
  | {
      type: 'research.freezeSpec';
      idempotencyKey: string;
      specId: string;
      expectedRevision: number;
      prediction: {
        outcomeName: string;
        sign: PredictionRecord['sign'];
        expectedLow: number;
        expectedHigh: number;
        probability: number;
        falsifiers: string[];
        existingKnowledge: string;
        retrospective: boolean;
      };
    }
  | {
      type: 'research.registerVariant';
      idempotencyKey: string;
      branchId: string;
      kind: TrialLedgerEntry['kind'];
      variantHash: string;
      description: string;
    }
  | {
      type: 'research.createStageAttempt';
      idempotencyKey: string;
      branchId: string;
      stage: ResearchStage;
      assignmentId: string | null;
      trialId: string | null;
      summary: string;
    }
  | {
      type: 'research.amendBranch';
      idempotencyKey: string;
      branchId: string;
      expectedRevision: number;
      name: string;
      reason: string;
    }
  | {
      type: 'research.settleBranch';
      idempotencyKey: string;
      branchId: string;
      expectedRevision: number;
      outcome: ScientificOutcome;
      reason: string;
    }
  | {
      type: 'location.save';
      idempotencyKey: string;
      projectId: string;
      expectedRevision: number;
      localFolder: string;
      inputPaths: string[];
      outputFolder: string;
      withheldPaths?: string[];
    }
  | { type: 'experiment.create'; idempotencyKey: string; projectId: string; name: string; hypothesis: string }
  | {
      type: 'contract.save';
      idempotencyKey: string;
      experimentId: string;
      expectedRevision: number;
      contract: ResearchContract;
    }
  | { type: 'contract.submit'; idempotencyKey: string; experimentId: string; expectedRevision: number }
  | {
      type: 'task.create';
      idempotencyKey: string;
      projectId: string;
      experimentId: string | null;
      prompt: string;
      recipient: Role;
    }
  | { type: 'task.cancel'; idempotencyKey: string; taskId: string }
  | { type: 'task.delete'; idempotencyKey: string; taskId: string; expectedRevision?: number }
  | { type: 'project.delete'; idempotencyKey: string; projectId: string }
  | { type: 'settings.update'; idempotencyKey: string; settings: Settings };
export interface FileActionResult {
  canceled: boolean;
  count: number;
  message: string;
  state: AppState;
}
export interface AppInfo {
  version: string;
  dataDirectory: string;
  platform: string;
  packaged: boolean;
  transportModule: boolean;
  transportDetail: string;
}
export interface OfficeAPI {
  chooseProjectFolder(): Promise<string | null>;
  /** Choose files to share. Returns paths relative to the given project folder; anything outside it is refused. */
  chooseInputFiles(localFolder: string): Promise<string[]>;
  openProjectFolder(projectId: string): Promise<void>;
  scanClaudeUsage(chooseFolder: boolean): Promise<LocalUsage | null>;
  changeAgentEffort(input: { agentId: string; effort: Effort; expectedEffort: Effort }): Promise<AppState>;
  changeAgentModel(input: { agentId: string; model: string; expectedModel: string }): Promise<AppState>;
  getWorkLogs(): Promise<AgentLog[]>;
  importWorkLogs(agentId: string): Promise<{ count: number; skipped: number; message: string }>;
  /** Verify or deliberately change the account a profile is bound to. The observation is taken in the main process. */
  bindAgentConnection(input: {
    agentId: string;
    expectedRevision: number;
    intent: 'VERIFY' | 'CHANGE';
  }): Promise<AppState>;
  connectAgent(draft: AgentDraft): Promise<AgentTicket>;
  confirmAgent(ticket: string): Promise<AppState>;
  cancelAgent(): Promise<void>;
  connectionStatus(provider: Provider): Promise<Connection>;
  /** Run the provider's official sign-in outside the add-agent flow and record the observation. */
  loginProvider(provider: Provider): Promise<Connection>;
  selectProviderTool(provider: Provider): Promise<void>;
  openProviderUsage(provider: Provider): Promise<void>;
  /** Freeze one request's inputs and record the intent to submit. Nothing is transferred. */
  prepareRequest(input: {
    requestId: string;
    expectedRequestRevision: number;
    agentId: string;
    expectedAgentRevision: number;
  }): Promise<{ state: AppState; assignmentId: string; snapshot: InputSnapshot }>;
  /** The exact official command a handoff would run, for display before launching anything. */
  handoffPlan(input: { assignmentId: string }): Promise<{
    executable: string;
    args: string[];
    cwd: string;
    outputDestination?: { path: string; totalBytes: number; files: SnapshotFile[] };
  } | null>;
  discardPreparation(input: { assignmentId: string }): Promise<AppState>;
  openHandoffTerminal(input: { assignmentId: string }): Promise<AppState>;
  observeJob(input: { assignmentId: string }): Promise<AppState>;
  cancelJob(input: { assignmentId: string }): Promise<AppState>;
  /** Link a session you created yourself. Recorded as user-reported linkage, never as an outcome. */
  linkJobSession(input: { assignmentId: string; externalId: string; externalUrl: string }): Promise<AppState>;
  /** Cursor-paged history. The renderer never loads the whole event log to show a page of it. */
  historyPage(input: {
    projectId?: string | null;
    limit?: number;
    cursor?: number;
  }): Promise<{ entries: LineageEvent[]; nextCursor: number | null; total: number }>;
  logPage(input: {
    agentId?: string;
    conversationId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ entries: WorkLog[]; nextCursor: string | null; total: number }>;
  jobEventPage(input: {
    jobId: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ entries: JobEvent[]; nextCursor: string | null; total: number }>;
  officeChatPage(input: import('./office-chat').OfficeChatQuery): Promise<import('./office-chat').OfficeChatPage>;
  /** Chronological applied self-report events for one job — the structured query the applied-report
   *  UI reads. publicState strips jobEvents, so the pushed snapshot never carries them. */
  appliedReports(input: { jobId: string; limit?: number }): Promise<{ entries: JobEvent[] }>;
  /** The bounded local-session summary for one job, or null when the job has no local binding. */
  localSessionSummary(jobId: string): Promise<import('./local-session').LocalSessionSummary | null>;
  localLaunchPlan(jobId: string): Promise<import('./local-session').LocalLaunchPlan | null>;
  localSessionArchive(
    assignmentId: string,
  ): Promise<{ state: AppState; archive: import('./local-session').LocalArchiveResult }>;
  /** Give old task records a native request, after a database copy and replay verification. */
  migrateLegacyRecords(): Promise<{ migrated: number; skipped: number; state: AppState }>;
  getState(): Promise<AppState>;
  messagePage(input: {
    agentId?: string;
    requestId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ entries: Message[]; nextCursor: string | null; total: number }>;
  researchPage(input: {
    projectId: string;
    branchId?: string;
    kind: 'pipeline' | 'trials';
    cursor?: string;
    limit?: number;
    query?: string;
  }): Promise<{
    entries: (import('./pipeline').PipelineRecord | TrialLedgerEntry)[];
    nextCursor: string | null;
    total: number;
  }>;
  researchInsights(input: { projectId: string; branchId: string }): Promise<{
    calibration: import('../core/monitoring').CalibrationReport;
    methods: ReturnType<typeof import('../core/monitoring').compareMethods>;
    ancestry: import('../core/monitoring').AncestryNode[];
  }>;
  exportResearch(input: { branchId: string }): Promise<FileActionResult>;
  getInfo(): Promise<AppInfo>;
  /** Create one real, tiny cloud session to find out whether this account can submit at all. */
  verifyCloudTransport(input: {
    provider: Provider;
  }): Promise<{ verified: boolean; detail: string; externalId: string; externalUrl: string; state: AppState }>;
  command(command: Command): Promise<AppState>;
  importFiles(input: {
    projectId: string;
    experimentId: string | null;
    kind: 'REFERENCE' | 'RESULT';
  }): Promise<FileActionResult>;
  previewArtifact(id: string): Promise<{ text: string; truncated: boolean; binary: boolean }>;
  exportProject(projectId: string): Promise<FileActionResult>;
  backupWorkspace(): Promise<FileActionResult>;
  restoreWorkspace(): Promise<FileActionResult>;
  /** Describe, read, search and summarise stored evidence. Grants are checked in main, before any index or cache. */
  describeObject(input: { agentId: string; objectHash: string }): Promise<ObjectDescription>;
  readObject(input: {
    agentId: string;
    objectHash: string;
    from?: number;
    limit?: number;
    cursor?: string;
  }): Promise<ReadResult>;
  queryEvidence(input: {
    agentId: string;
    projectId: string;
    pattern: string;
    objectHashes?: string[];
    limit?: number;
    cursor?: string;
  }): Promise<SearchResult>;
  stagePacket(input: {
    agentId: string;
    projectId: string;
    subjectId: string;
    stage: ResearchStage;
    maxObjects?: number;
  }): Promise<StagePacket>;
  /** Read-only stage standing for one research branch: what it needs next and what stops it advancing. */
  researchStatus(input: { branchId: string; subjectHash: string; mode: WorkMode }): Promise<ResearchStatus>;
  /** Append-only: gives one stage function to one profile at its current revision. Profiles are not edited. */
  assignResearchFunction(input: {
    projectId: string;
    stage: ResearchStage;
    function: StageFunction;
    agentId: string;
    expectedAgentRevision: number;
    note: string;
  }): Promise<AppState>;
  /** Turns this project's legacy PM roles into explicit function assignments, appending each one. */
  migrateResearchFunctions(input: {
    projectId: string;
    stage: ResearchStage;
  }): Promise<{ appended: number; state: AppState }>;
  /**
   * Runs one staged-scientific action in the main process: link a branch to an exact request and
   * trial, prepare a stage's assignments, collect a provider-reported stage report into receipts,
   * advance a branch past its earned gates, adjudicate S7, set shadow thresholds, or reserve a
   * holdout. The renderer names the action; every check is re-made inside the store writes it feeds.
   */
  pipelineAction(input: import('./pipeline').PipelineAction): Promise<{
    state: AppState;
    detail: string;
    assignments?: Assignment[];
    reservation?: import('./holdout').HoldoutReservation;
  }>;
  /** Read a bounded, read-only preview of one recorded job output (e.g. a brief or report before deciding). */
  jobOutputPreview(input: {
    jobId: string;
    path: string;
  }): Promise<{ path: string; sha256: string; bytes: number; text: string; truncated: boolean; verified: true }>;
  /** Re-arm one failed or verified-unresolved pipeline hop and dispatch its next attempt. */
  retryPipelineHop(input: { requestId: string; pipelineKey: string; expectedRevision: number }): Promise<AppState>;
  searchMemory(input: { projectId: string; text: string; limit?: number }): Promise<{ findings: MemoryFinding[] }>;
  memoryGraph(projectId: string): Promise<MemoryGraph>;
  onChanged(callback: () => void): () => void;
}
/** Reported, never acted on by the renderer: promotion is decided in main, from gate receipts. */
export interface ResearchStatus {
  canPrepare?: boolean;
  stage: ResearchStage;
  outcome: ScientificOutcome;
  requiredFunctions: string[];
  functions: { function: string; agentId: string; agentRevision: number; blockers: string[] }[];
  tasks: {
    branchId: string;
    stage: ResearchStage;
    function: string;
    agentId: string;
    contextHash: string;
    outputSchema: string;
    dependsOn: string[];
  }[];
  scheduleBlockers: string[];
  canPromote: boolean;
  promotionBlockers: string[];
  /** How this stage's work is delivered under the section-1.6 contract. */
  stageDelivery?: 'AGENT' | 'USER_RUN' | 'OFFICE';
  /** The manual-run surface: export when at S3, the durable wait, and bound-import availability. */
  manual?: {
    canExport: boolean;
    awaitingPackageId: string | null;
    exportedAt: string | null;
    canImport: boolean;
    canValidate: boolean;
  };
  /** Section 5.3's split: each capability on its own evidence, never one collapsed readiness flag. */
  capabilities?: import('./run-package').ManualRunReadiness;
}
declare global {
  interface Window {
    office: OfficeAPI;
  }
}
