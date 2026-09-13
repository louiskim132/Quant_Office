import { canonicalHash } from './canonical.js';

export const MAX_BUDGET_CENTS = 100_000_000;
const HASH = /^[a-f0-9]{64}$/;
function cents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BUDGET_CENTS) throw new Error(`Invalid ${label}`);
}

export interface BudgetScope { scope: 'task' | 'experiment' | 'project' | 'global'; ceilingCents: number; actualCents: number; reservedCents: number; }
/** Maximum provider-enforced liability is mandatory; planning estimates never authorize dispatch. */
export function assertBudgetReservation(maxLiabilityCents: number | null, scopes: readonly BudgetScope[]): void {
  if (maxLiabilityCents === null) throw new Error('Unknown maximum liability blocks dispatch');
  cents(maxLiabilityCents, 'maximum liability');
  const required = ['task', 'experiment', 'project', 'global'];
  if (scopes.length !== 4 || required.some(scope => scopes.filter(item => item.scope === scope).length !== 1)) throw new Error('All four distinct budget scopes are required');
  for (const item of scopes) {
    cents(item.ceilingCents, 'budget ceiling'); cents(item.actualCents, 'actual spend'); cents(item.reservedCents, 'reservation');
    if (item.actualCents + item.reservedCents + maxLiabilityCents > item.ceilingCents) throw new Error(`${item.scope} budget exceeded`);
  }
}

export interface ApprovalBundle {
  schemaVersion: 1; projectId: string; experimentId: string; purpose: 'PREFLIGHT' | 'FULL_RUN';
  sourceHash: string; dataHash: string; configurationHash: string; testsHash: string; environmentHash: string; launcherHash: string; policyHash: string;
}
export function bundleHash(bundle: ApprovalBundle): string {
  const keys = ['schemaVersion','projectId','experimentId','purpose','sourceHash','dataHash','configurationHash','testsHash','environmentHash','launcherHash','policyHash'];
  if (Object.keys(bundle).length !== keys.length || keys.some(key => !Object.hasOwn(bundle, key))) throw new Error('Approval bundle has missing or unknown fields');
  if (bundle.schemaVersion !== 1 || !bundle.projectId || !bundle.experimentId || !['PREFLIGHT', 'FULL_RUN'].includes(bundle.purpose)) throw new Error('Invalid approval bundle scope');
  for (const key of keys.filter(key => key.endsWith('Hash'))) if (!HASH.test((bundle as unknown as Record<string, string>)[key])) throw new Error(`Invalid ${key}`);
  return canonicalHash(bundle);
}

export function assertExactApproval(bundle: ApprovalBundle, approval: { projectId: string; experimentId: string; bundleHash: string; purpose: string; revoked: boolean }): void {
  if (approval.revoked || approval.projectId !== bundle.projectId || approval.experimentId !== bundle.experimentId || approval.purpose !== bundle.purpose || approval.bundleHash !== bundleHash(bundle)) throw new Error('Approval does not match the exact active bundle');
}

export interface SmokeEvidence { bundleHash: string; accepted: boolean; origin: 'PROVIDER_VERIFIED' | 'USER_ATTESTED'; }
export interface LauncherGate { bundleHash: string; reviewed: boolean; failsClosed: boolean; smokeBeforeExpensiveStages: boolean; }
export function assertSmokeGate(expectedBundleHash: string, evidence: SmokeEvidence | null, launcher: LauncherGate | null): 'PASSED' | 'CONDITIONAL' {
  if (!HASH.test(expectedBundleHash)) throw new Error('Invalid smoke bundle hash');
  if (evidence?.bundleHash === expectedBundleHash && evidence.accepted && evidence.origin === 'PROVIDER_VERIFIED') return 'PASSED';
  if (launcher?.bundleHash === expectedBundleHash && launcher.reviewed && launcher.failsClosed && launcher.smokeBeforeExpensiveStages) return 'CONDITIONAL';
  throw new Error('Full run requires compatible verified smoke or a reviewed fail-closed launcher');
}

export interface DataAccess {
  projectId: string; artifactProjectId: string; artifactHash: string;
  classification: 'ORDINARY' | 'PROTECTED' | 'PROTECTED_DERIVED' | 'MIXED' | 'UNCLASSIFIED';
  ordinaryGrant: boolean;
  protectedGrant: { projectId: string; artifactHash: string; userDecisionId: string; exposureEventSequence: number } | null;
}
export function assertProviderDisclosure(access: DataAccess): void {
  if (!access.projectId || access.projectId !== access.artifactProjectId || !HASH.test(access.artifactHash)) throw new Error('Cross-project or invalid artifact disclosure');
  if (access.classification === 'UNCLASSIFIED' || access.classification === 'MIXED') throw new Error('Classify and partition the artifact before disclosure');
  if (access.classification === 'ORDINARY') {
    if (!access.ordinaryGrant) throw new Error('Explicit project data grant required');
    return;
  }
  if (!['PROTECTED', 'PROTECTED_DERIVED'].includes(access.classification)) throw new Error('Unknown data classification');
  const grant = access.protectedGrant;
  if (!grant || grant.projectId !== access.projectId || grant.artifactHash !== access.artifactHash || !grant.userDecisionId || !Number.isSafeInteger(grant.exposureEventSequence) || grant.exposureEventSequence <= 0) throw new Error('Protected disclosure requires a specific user decision and recorded exposure');
}

export type ReviewParticipant = 'PM_A' | 'PM_B' | 'PM_C' | 'PM_D';
export interface IsolatedReport { role: ReviewParticipant; phase: 'FIRST' | 'REBUTTAL'; contentHash: string; bundleHash: string; }
export interface ReviewRound { bundleHash: string; participants: readonly ReviewParticipant[]; reports: readonly IsolatedReport[]; }
function validateRound(round: ReviewRound): void {
  if (!HASH.test(round.bundleHash) || round.participants.length < 2 || new Set(round.participants).size !== round.participants.length || round.participants.some(role => !['PM_A','PM_B','PM_C','PM_D'].includes(role))) throw new Error('Invalid independent review participants');
  const seen = new Set<string>();
  for (const report of round.reports) {
    const key = `${report.role}:${report.phase}`;
    if (!round.participants.includes(report.role) || report.bundleHash !== round.bundleHash || !HASH.test(report.contentHash) || !['FIRST','REBUTTAL'].includes(report.phase) || seen.has(key)) throw new Error('Invalid or duplicate review report');
    if (report.phase === 'REBUTTAL' && !round.participants.every(role => seen.has(`${role}:FIRST`))) throw new Error('Rebuttal preceded all independent first reports');
    seen.add(key);
  }
}
export function commitReview(round: ReviewRound, report: IsolatedReport): ReviewRound {
  validateRound(round);
  const next = { ...round, participants: [...round.participants], reports: [...round.reports, { ...report }] };
  validateRound(next);
  return next;
}
export function disclosedReports(round: ReviewRound, viewer: ReviewParticipant): readonly IsolatedReport[] {
  validateRound(round);
  if (!round.participants.includes(viewer)) throw new Error('Viewer is not a review participant');
  const complete = round.participants.every(role => round.reports.some(report => report.role === role && report.phase === 'FIRST'));
  return round.reports.filter(report => complete || report.role === viewer).map(report => ({ ...report }));
}

export function assertHostedExecution(capability: { provider: string; location: string; constrainedTools: boolean; colabAccess: boolean; localExecution: boolean }): void {
  if (!['OPENAI', 'ANTHROPIC'].includes(capability.provider) || capability.location !== 'PROVIDER_HOSTED' || !capability.constrainedTools || capability.colabAccess || capability.localExecution) throw new Error('Only constrained provider-hosted execution is allowed; no local or Colab access');
}

export interface WorkerInvocation {
  id: string;
  state: 'RESERVED' | 'SUBMITTED' | 'RUNNING' | 'UNKNOWN' | 'CANCEL_REQUESTED' | 'COMPLETED' | 'FAILED' | 'CANCELED_ACKNOWLEDGED';
}
/** Call with the complete global set, including nested worker invocations. Unknown jobs retain their slots. */
export function assertWorkerCapacity(globalInvocations: readonly WorkerInvocation[], requestedSlots = 1, providerLimit?: number): void {
  if (!Number.isSafeInteger(requestedSlots) || requestedSlots < 1 || providerLimit !== undefined && (!Number.isSafeInteger(providerLimit) || providerLimit < 1)) throw new Error('Invalid worker slot request');
  const active = new Set(['RESERVED','SUBMITTED','RUNNING','UNKNOWN','CANCEL_REQUESTED']);
  const terminal = new Set(['COMPLETED','FAILED','CANCELED_ACKNOWLEDGED']);
  const identities = new Set<string>();
  for (const invocation of globalInvocations) {
    if (!invocation.id || identities.has(invocation.id) || (!active.has(invocation.state) && !terminal.has(invocation.state))) throw new Error('Invalid or duplicate global worker invocation');
    identities.add(invocation.id);
  }
  if (providerLimit !== undefined && globalInvocations.filter(invocation => active.has(invocation.state)).length + requestedSlots > providerLimit) throw new Error('Provider concurrency capacity exceeded');
}
