import type { Effort } from './types.js';

/**
 * The staged research workflow, S0 to S10.
 *
 * A branch advances through these in order. The order is not a convention: each stage exists to make
 * a specific way of fooling yourself expensive, and skipping one removes exactly that protection.
 */
export const STAGES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'] as const;
export type Stage = (typeof STAGES)[number];

/**
 * Whether a stage is universally unrunnable in this build.
 *
 * Contract correction 2026-09-14 (section 1.6): the manual user-run path is the default experiment
 * route, so no stage is blanket-blocked for want of hosted execution. Per-capability limits are
 * enforced at the admission points instead — a frozen spec that declares signed-harness evidence,
 * a route that cannot carry an isolated context, a custody path with no evaluator each refuse at
 * the exact operation, with the reason, rather than blocking the whole pipeline up front.
 */
export function pipelineStageBlocker(_stage: Stage): string | null {
  return null;
}

/** Deterministic checks with stable identifiers, so a receipt refers to a check and not to prose. */
export const GATES = [
  'G-SPEC',
  'G-CORRECT',
  'G-TIME',
  'G-SPLIT',
  'G-FIT',
  'G-TARGET',
  'G-SELECT',
  'G-TRADETIME',
  'G-ARTIFACT',
  'G-COST',
  'G-PORTFOLIO',
  'G-ECON',
  'G-INTEGRITY',
  'G-SHADOW',
] as const;
export type GateId = (typeof GATES)[number];

/**
 * A gate can fail, and it can also be genuinely inapplicable — but never merely absent.
 *
 * NOT_APPLICABLE is a claim requiring a frozen rationale, because "this check does not apply here" is
 * exactly the sentence a weak result invites. BLOCKED means the evidence needed to decide is missing,
 * which is different from having decided the check passes.
 */
export type GateOutcome = 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'BLOCKED';

/** What a research branch has concluded, which is independent of whether a provider job finished. */
export type ScientificOutcome =
  'IN_PROGRESS' | 'VALID_NEGATIVE' | 'INCONCLUSIVE' | 'RETIRED' | 'SHADOW_QUALIFIED' | 'SUSPENDED';

/**
 * One line of a research lineage.
 *
 * A branch is the unit that carries a frozen specification, its prediction and its trial history. An
 * amendment does not edit a branch; it creates a linked child, so what was actually preregistered
 * stays legible after the fact.
 */
export interface ResearchBranch {
  id: string;
  projectId: string;
  name: string;
  /** The branch this was amended from, and the root of the whole lineage. */
  parentBranchId: string | null;
  lineageId: string;
  stage: Stage;
  outcome: ScientificOutcome;
  specId: string | null;
  predictionId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  retiredAt?: string;
  retiredReason?: string;
}

/** One mandatory section of the frozen specification. All seven are required before G-SPEC can pass. */
export interface SpecSections {
  estimand: string;
  splitPlan: string;
  searchPlan: string;
  costContract: string;
  portfolioContract: string;
  metricsAndGates: string;
  holdoutPolicy: string;
}
export const SPEC_SECTIONS: (keyof SpecSections)[] = [
  'estimand',
  'splitPlan',
  'searchPlan',
  'costContract',
  'portfolioContract',
  'metricsAndGates',
  'holdoutPolicy',
];

/**
 * The specification as it was frozen, and the thresholds it committed to.
 *
 * Frozen means frozen: `contentHash` covers every field, and the store refuses to rewrite a frozen
 * row. Lowering a threshold after seeing a weak result is the single most tempting move in this
 * whole workflow, so it is not merely discouraged, it is impossible without a new branch.
 */
export interface FrozenResearchSpec {
  id: string;
  branchId: string;
  sections: SpecSections;
  /** Gate thresholds by identifier, frozen with the rest. */
  thresholds: { gate: GateId; rule: string }[];
  /** Gates deliberately declared inapplicable at freeze time, each with its reason. */
  notApplicable: { gate: GateId; rationale: string }[];
  /**
   * Gates the specification requires the stronger signed-harness evidence tier for (section 1.6).
   * Undeclared gates accept any admitted receipt provenance — office validation, reviewer-asserted
   * or user-run — each recorded under its own label, never promoted.
   */
  gateEvidence?: { gate: GateId; tier: 'SIGNED_HARNESS' }[];
  maxSelectionTrials: number;
  frozen: boolean;
  contentHash: string;
  createdAt: string;
  frozenAt: string;
}

/**
 * What the director expected, recorded before the candidate was evaluated.
 *
 * `retrospective` is not a formality. A prediction written after seeing results is a description, and
 * labelling it honestly is what keeps the comparison at S7 worth anything.
 */
export interface PredictionRecord {
  id: string;
  branchId: string;
  specId: string;
  outcomeName: string;
  sign: 'POSITIVE' | 'NEGATIVE' | 'NONE';
  expectedLow: number;
  expectedHigh: number;
  probability: number;
  falsifiers: string[];
  existingKnowledge: string;
  retrospective: boolean;
  createdAt: string;
}

/**
 * One entry in the all-trials ledger.
 *
 * Every attempt is recorded, including the ones that failed or were abandoned. A ledger that only
 * remembers the successes is what makes a multiplicity adjustment meaningless.
 */
export interface TrialLedgerEntry {
  id: string;
  lineageId: string;
  branchId: string;
  kind: 'VARIANT' | 'METADATA_RETRY' | 'FOLLOW_UP';
  /** Semantic identity of what was run. Two entries sharing this are the same scientific trial. */
  variantHash: string;
  description: string;
  outcome: 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'PRUNED';
  createdAt: string;
  settledAt: string;
}

/** One attempt at one stage, with the assignment that carried it out when there was one. */
export interface StageAttempt {
  id: string;
  branchId: string;
  stage: Stage;
  assignmentId: string | null;
  trialId: string | null;
  state: 'OPEN' | 'COMPLETED' | 'ABANDONED';
  summary: string;
  createdAt: string;
  settledAt: string;
}

/**
 * The result of running one deterministic check against one exact subject.
 *
 * `subjectHash` is what makes a receipt non-transferable: a receipt earned by one candidate says
 * nothing about a later one, and the reducer refuses to accept it for a different subject.
 */
export interface GateReceipt {
  id: string;
  branchId: string;
  stage: Stage;
  gate: GateId;
  outcome: GateOutcome;
  subjectHash: string;
  specId: string;
  detail: string;
  rationale: string;
  /** Where the deterministic evidence lives. A receipt with no evidence reference is not evidence. */
  evidenceRef: string;
  /**
   * Who produced this evidence (section 1.6 tier): OFFICE validation, REVIEWER_ASSERTED in an
   * admitted stage report, USER_RUN inside the bound returned package, or SIGNED_HARNESS under the
   * separately scoped stronger contract. Absent on receipts recorded before 2026-09-14.
   */
  provenance?: 'OFFICE' | 'REVIEWER_ASSERTED' | 'USER_RUN' | 'SIGNED_HARNESS';
  createdAt: string;
}

/**
 * Which gates each stage requires before a branch may leave it.
 *
 * Table-driven on purpose: a prerequisite that lives in a table can be read, reviewed and tested,
 * whereas one scattered through branching code is a rule nobody can audit.
 */
export const STAGE_GATES: Record<Stage, GateId[]> = {
  S0: ['G-SPEC'],
  S1: [],
  S2: ['G-CORRECT', 'G-TIME', 'G-SPLIT', 'G-FIT', 'G-TARGET', 'G-SELECT', 'G-TRADETIME'],
  S3: ['G-ARTIFACT'],
  S4: [],
  S5: ['G-PORTFOLIO'],
  S6: ['G-COST', 'G-ECON'],
  S7: [],
  S8: ['G-INTEGRITY'],
  S9: ['G-SHADOW'],
  S10: [],
};

/** Gates whose failure can never be waived, adjudicated around or argued past. */
export const MANDATORY_GATES: GateId[] = [
  'G-SPEC',
  'G-CORRECT',
  'G-TIME',
  'G-SPLIT',
  'G-FIT',
  'G-TARGET',
  'G-SELECT',
  'G-TRADETIME',
  'G-ARTIFACT',
  'G-COST',
  'G-INTEGRITY',
];

export interface ResearchRecords {
  pipeline?: import('./pipeline').PipelineRecord[];
  branches?: ResearchBranch[];
  specs?: FrozenResearchSpec[];
  predictions?: PredictionRecord[];
  trials?: TrialLedgerEntry[];
  attempts?: StageAttempt[];
  receipts?: GateReceipt[];
}

/** Historical unlinked records remain readable; linked application work needs durable collection. */
export function stageCompletionBlocker(
  records: ResearchRecords,
  branch: ResearchBranch,
  subjectHash: string,
): string | null {
  if (branch.stage === 'S0') return null;
  const link = records.pipeline?.filter(r => r.kind === 'LINK' && r.branchId === branch.id).at(-1);
  if (!link || link.kind !== 'LINK') return null;
  return records.pipeline?.some(
    r =>
      r.kind === 'STAGE_COMPLETION' &&
      r.branchId === branch.id &&
      r.stage === branch.stage &&
      r.branchRevision === branch.revision &&
      r.specId === branch.specId &&
      r.subjectHash === subjectHash &&
      r.requestRevision === link.requestRevision,
  )
    ? null
    : 'Collect a completed exact-context stage report before advancement.';
}

/** Why a branch may not advance. An empty list is permission to advance, not a prediction of success. */
export interface StageBlocker {
  gate: GateId | null;
  reason: string;
}

export interface NextActions {
  stage: Stage;
  nextStage: Stage | null;
  canAdvance: boolean;
  blockers: StageBlocker[];
  /** Gates this stage still needs, in the order the table declares them. */
  outstandingGates: GateId[];
}

function currentSpec(records: ResearchRecords, branch: ResearchBranch): FrozenResearchSpec | undefined {
  return (records.specs ?? []).find(spec => spec.id === branch.specId);
}

/**
 * Whether a branch may leave its current stage, and what is stopping it.
 *
 * Pure and side-effect free, so the same answer can be shown in the interface, asserted in a test and
 * enforced in the store without three implementations drifting apart.
 */
export function nextActions(records: ResearchRecords, branch: ResearchBranch, subjectHash: string): NextActions {
  const index = STAGES.indexOf(branch.stage);
  const nextStage = index >= 0 && index < STAGES.length - 1 ? STAGES[index + 1] : null;
  const blockers: StageBlocker[] = [];
  const required = STAGE_GATES[branch.stage];
  const outstanding: GateId[] = [];

  if (branch.outcome === 'RETIRED' || branch.outcome === 'SUSPENDED')
    blockers.push({ gate: null, reason: `This branch is ${branch.outcome.toLowerCase()} and does not advance.` });

  const spec = currentSpec(records, branch);
  if (!spec) blockers.push({ gate: null, reason: 'No specification has been drafted for this branch.' });
  else if (!spec.frozen)
    blockers.push({
      gate: null,
      reason: 'The specification is still a draft. Freeze it before any candidate is evaluated.',
    });

  if (branch.stage === 'S0') {
    if (spec)
      for (const section of SPEC_SECTIONS)
        if (!spec.sections[section].trim())
          blockers.push({
            gate: 'G-SPEC',
            reason: `The specification is missing its ${section} section, which is mandatory.`,
          });
    if (!branch.predictionId)
      blockers.push({
        gate: null,
        reason: 'No prediction has been registered. Record one before the candidate is evaluated.',
      });
  }

  for (const gate of required) {
    // A receipt only counts for the exact subject it was earned against, from the current frozen spec.
    const receipts = (records.receipts ?? []).filter(
      receipt =>
        receipt.branchId === branch.id &&
        receipt.gate === gate &&
        receipt.subjectHash === subjectHash &&
        receipt.specId === branch.specId,
    );
    const receipt = receipts.at(-1);
    if (!receipt) {
      outstanding.push(gate);
      blockers.push({ gate, reason: `${gate} has no receipt for this exact subject.` });
      continue;
    }
    if (receipt.outcome === 'PASS') continue;
    if (receipt.outcome === 'NOT_APPLICABLE') {
      // Inapplicability has to have been declared at freeze time, with a reason, or it is just a way
      // of skipping a check that became inconvenient.
      const declared = spec?.notApplicable.find(item => item.gate === gate);
      if (!declared)
        blockers.push({
          gate,
          reason: `${gate} is recorded as not applicable, but the frozen specification never declared it so.`,
        });
      else if (!receipt.rationale.trim())
        blockers.push({ gate, reason: `${gate} is recorded as not applicable with no rationale.` });
      continue;
    }
    if (receipt.outcome === 'FAIL' && MANDATORY_GATES.includes(gate))
      blockers.push({
        gate,
        reason: `${gate} failed and is mandatory. It cannot be waived; repair the candidate and rerun it.`,
      });
    else blockers.push({ gate, reason: `${gate} is ${receipt.outcome.toLowerCase()} for this subject.` });
  }

  return {
    stage: branch.stage,
    nextStage,
    canAdvance: blockers.length === 0 && nextStage !== null,
    blockers,
    outstandingGates: outstanding,
  };
}

/**
 * Counters for a whole lineage, not a single branch.
 *
 * Renaming a branch, or amending it into a child, does not reset how many times this family has been
 * tried. That is the entire point: an allowance that resets on rename is not an allowance.
 */
export interface LineageCounters {
  variants: number;
  metadataRetries: number;
  followUps: number;
  failed: number;
  canceled: number;
  distinctVariants: number;
  followUpAllowanceRemaining: number;
}

export const FOLLOW_UP_ALLOWANCE = 1;

export function lineageCounters(records: ResearchRecords, lineageId: string): LineageCounters {
  const entries = (records.trials ?? []).filter(entry => entry.lineageId === lineageId);
  const variants = entries.filter(entry => entry.kind === 'VARIANT');
  const branches = new Set((records.branches ?? []).filter(b => b.lineageId === lineageId).map(b => b.id));
  const grants = (records.pipeline ?? []).filter(
    r => r.kind === 'ADJUDICATION' && r.decision === 'DECISIVE_TEST' && branches.has(r.branchId),
  ).length;
  return {
    variants: variants.length,
    // A retry that changed nothing semantic is not a new scientific trial and must not inflate the
    // multiplicity count, but it is still recorded rather than discarded.
    metadataRetries: entries.filter(entry => entry.kind === 'METADATA_RETRY').length,
    followUps: entries.filter(entry => entry.kind === 'FOLLOW_UP').length,
    failed: entries.filter(entry => entry.outcome === 'FAILED').length,
    canceled: entries.filter(entry => entry.outcome === 'CANCELED').length,
    distinctVariants: new Set(variants.map(entry => entry.variantHash)).size,
    followUpAllowanceRemaining: Math.max(
      0,
      FOLLOW_UP_ALLOWANCE - Math.max(grants, entries.filter(entry => entry.kind === 'FOLLOW_UP').length),
    ),
  };
}

/**
 * How much of the registered search budget a lineage has spent.
 *
 * Reported rather than enforced silently: exceeding it is a fact the adjudicator needs, and an
 * operational brake is not a statistical guarantee.
 */
export function exposure(
  records: ResearchRecords,
  branch: ResearchBranch,
): { used: number; allowed: number; exceeded: boolean } {
  const spec = currentSpec(records, branch);
  const counters = lineageCounters(records, branch.lineageId);
  const allowed = spec?.maxSelectionTrials ?? 0;
  return { used: counters.distinctVariants, allowed, exceeded: allowed > 0 && counters.distinctVariants > allowed };
}

export const STAGE_FUNCTIONS = [
  'PRINCIPAL',
  'CORRECTNESS_REVIEWER',
  'ADVOCATE',
  'SKEPTIC',
  'CUSTODIAN',
  'DIRECTOR',
] as const;
export type StageFunction = (typeof STAGE_FUNCTIONS)[number];

/**
 * One append-only assignment of a profile to a named scientific function at one stage.
 *
 * Legacy workspaces routed work by four interchangeable PM roles. Migrating those is an explicit,
 * appended operation because a function is a responsibility, not a label: silently reinterpreting
 * "PM_B" as "the skeptic" would rewrite what past reviews meant, and editing a profile to fit a
 * function would change who actually did the work. Re-assigning appends a new row and supersedes
 * the old one; nothing is rewritten in place.
 */
export interface FunctionAssignment {
  id: string;
  projectId: string;
  stage: Stage;
  function: StageFunction;
  agentId: string;
  agentRevision: number;
  appendedAt: string;
  supersededById: string | null;
  origin: 'EXPLICIT' | 'MIGRATED_FROM_ROLE';
  note: string;
}
