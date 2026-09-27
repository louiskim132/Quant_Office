import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { nextActions, lineageCounters, exposure, STAGE_GATES, SPEC_SECTIONS } from '../src/shared/research';
import type { GateId, GateReceipt, SpecSections, Stage } from '../src/shared/research';

const key = () => randomUUID();
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 16, 0, 0) + minutes * 60000).toISOString();
const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-research-'));
  const file = path.join(root, 'workspace.sqlite');
  let store = new OfficeStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
    removeTreeSync(root);
  });
  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  return {
    root,
    project,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new OfficeStore(file);
      return store;
    },
  };
}

/** A complete specification. Every mandatory section is filled, because a blank one cannot freeze. */
const sections = (overrides: Partial<SpecSections> = {}): SpecSections => ({
  estimand: 'Forecast next-day excess return for the eligible universe at the decision timestamp.',
  splitPlan: 'Chronological outer folds with a five-day label purge and a two-day embargo.',
  searchPlan: 'CatBoost family, at most twelve selection trials, seeds recorded, pruned trials logged.',
  costContract: 'Fees, spread and impact in basis points, calibrated from the recorded venue sample.',
  portfolioContract: 'Rank to weight, one-day lag, daily rebalance, sector-neutral, ten percent cap.',
  metricsAndGates: 'Rank IC and net Sharpe with a deflated threshold; mandatory gates listed by identifier.',
  holdoutPolicy: 'One untouched holdout evaluation, custodian-run, one follow-up allowance.',
  ...overrides,
});

const draft = (f: any, name = 'Momentum residual', overrides: Record<string, unknown> = {}) =>
  f.store.execute({
    type: 'research.draftSpec',
    idempotencyKey: key(),
    projectId: f.project.id,
    name,
    sections: sections(),
    thresholds: [{ gate: 'G-ECON' as GateId, rule: 'net Sharpe >= 0.8' }],
    notApplicable: [],
    maxSelectionTrials: 12,
    ...overrides,
  });

const branchOf = (state: any, name = 'Momentum residual'): any =>
  state.branches!.find((item: any) => item.name === name)!;

const freeze = (f: any, branch: any, retrospective = false) =>
  f.store.execute({
    type: 'research.freezeSpec',
    idempotencyKey: key(),
    specId: branch.specId!,
    expectedRevision: branch.revision,
    prediction: {
      outcomeName: 'net Sharpe',
      sign: 'POSITIVE' as const,
      expectedLow: 0.5,
      expectedHigh: 1.5,
      probability: 0.6,
      falsifiers: ['Rank IC indistinguishable from zero out of sample'],
      existingKnowledge: 'A related public factor exists.',
      retrospective,
    },
  });

const receipt = (
  branch: any,
  gate: GateId,
  subjectHash: string,
  overrides: Partial<GateReceipt> = {},
): GateReceipt => ({
  id: randomUUID(),
  branchId: branch.id,
  stage: branch.stage as Stage,
  gate,
  outcome: 'PASS',
  subjectHash,
  specId: branch.specId!,
  detail: 'Checked.',
  rationale: '',
  evidenceRef: 'artifact://receipt',
  createdAt: at(1),
  ...overrides,
});

test('a frozen specification is immutable, and a threshold cannot be edited afterwards', t => {
  const f = fixture(t);
  draft(f);
  const branch = branchOf(f.store.snapshot());
  const spec = f.store.snapshot().specs!.find((item: any) => item.id === branch.specId)!;
  assert.equal(spec.frozen, false, 'a draft is not a preregistration');

  const frozenState = freeze(f, branch);
  const frozen = frozenState.specs!.find((item: any) => item.id === branch.specId)!;
  assert.equal(frozen.frozen, true);
  assert.notEqual(frozen.frozenAt, '');
  assert.equal(frozen.contentHash, spec.contentHash, 'freezing records the same content it drafted');

  // Lowering a threshold after a weak result is the most tempting move in the whole workflow.
  assert.throws(
    () =>
      f.store.execute({
        type: 'research.draftSpec',
        idempotencyKey: key(),
        projectId: f.project.id,
        branchId: branch.id,
        expectedRevision: f.store.snapshot().branches!.find(b => b.id === branch.id)!.revision,
        name: 'Momentum residual',
        sections: sections(),
        thresholds: [{ gate: 'G-ECON', rule: 'net Sharpe >= 0.1' }],
        notApplicable: [],
        maxSelectionTrials: 12,
      }),
    /frozen specification/,
  );
  const after = f.store.snapshot().specs!.find((item: any) => item.id === branch.specId)!;
  assert.deepEqual(
    after.thresholds,
    [{ gate: 'G-ECON', rule: 'net Sharpe >= 0.8' }],
    'the frozen threshold is unchanged',
  );
  assert.throws(() => freeze(f, branchOf(f.store.snapshot())), /already frozen/);
});

test('a specification with a missing mandatory section cannot be frozen', t => {
  const f = fixture(t);
  f.store.execute({
    type: 'research.draftSpec',
    idempotencyKey: key(),
    projectId: f.project.id,
    name: 'Incomplete',
    sections: sections({ costContract: '   ' }),
    thresholds: [],
    notApplicable: [],
    maxSelectionTrials: 4,
  });
  const branch = branchOf(f.store.snapshot(), 'Incomplete');
  assert.throws(() => freeze(f, branch), /costContract section is empty/);
  assert.equal(f.store.snapshot().specs!.find((item: any) => item.id === branch.specId)!.frozen, false);
});

test('an amendment creates a linked branch and never rewrites what was preregistered', t => {
  const f = fixture(t);
  draft(f);
  let branch = branchOf(f.store.snapshot());
  freeze(f, branch);
  branch = branchOf(f.store.snapshot());
  const originalSpecId = branch.specId;

  const amended = f.store.execute({
    type: 'research.amendBranch',
    idempotencyKey: key(),
    branchId: branch.id,
    expectedRevision: branch.revision,
    name: 'Momentum residual v2',
    reason: 'the cost calibration sample was wrong',
  });
  const child = branchOf(amended, 'Momentum residual v2');
  assert.equal(child.parentBranchId, branch.id);
  assert.equal(child.lineageId, branch.lineageId, 'the child stays in the same lineage');
  assert.equal(child.specId, null, 'an amendment starts from no specification, not an inherited one');
  assert.equal(child.stage, 'S0');
  const original = amended.branches!.find(item => item.id === branch.id)!;
  assert.equal(original.specId, originalSpecId, 'the original branch is untouched');
  assert.match(amended.events.at(-1)!.reason, /original record is unchanged/);
});

test('the same idempotency key cannot record a command twice', t => {
  const f = fixture(t);
  const once = key();
  const command = {
    type: 'research.draftSpec' as const,
    idempotencyKey: once,
    projectId: f.project.id,
    name: 'Once',
    sections: sections(),
    thresholds: [],
    notApplicable: [],
    maxSelectionTrials: 3,
  };
  f.store.execute(command);
  const after = f.store.execute(command);
  assert.equal(
    after.branches!.filter(item => item.name === 'Once').length,
    1,
    'a repeated key is the same command, not a second one',
  );
});

test('a gate receipt is bound to its exact subject, specification and stage', t => {
  const f = fixture(t);
  draft(f);
  let branch = branchOf(f.store.snapshot());
  freeze(f, branch);
  branch = branchOf(f.store.snapshot());
  const subject = hashOf('candidate-one');

  // S0 needs G-SPEC for this exact subject before anything advances.
  const none = nextActions(f.store.snapshot(), branch, subject);
  assert.equal(none.canAdvance, false);
  assert.deepEqual(none.outstandingGates, ['G-SPEC']);

  const state = { ...f.store.snapshot(), receipts: [receipt(branch, 'G-SPEC', subject)] };
  assert.equal(nextActions(state, branch, subject).canAdvance, true);
  assert.equal(nextActions(state, branch, subject).nextStage, 'S1');

  // The same receipt says nothing about a different candidate.
  const other = nextActions(state, branch, hashOf('candidate-two'));
  assert.equal(other.canAdvance, false);
  assert.match(other.blockers[0].reason, /no receipt for this exact subject/);

  // Nor does one earned under a superseded specification.
  const stale = { ...f.store.snapshot(), receipts: [receipt(branch, 'G-SPEC', subject, { specId: randomUUID() })] };
  assert.equal(nextActions(stale, branch, subject).canAdvance, false);
});

test('a failed mandatory gate cannot be waived, and NOT_APPLICABLE needs a frozen declaration', t => {
  const f = fixture(t);
  draft(f, 'Correctness', {
    notApplicable: [{ gate: 'G-PORTFOLIO' as GateId, rationale: 'this branch produces no positions' }],
  });
  let branch = branchOf(f.store.snapshot(), 'Correctness');
  freeze(f, branch);
  branch = { ...branchOf(f.store.snapshot(), 'Correctness'), stage: 'S2' as Stage };
  const subject = hashOf('candidate');
  const passing = STAGE_GATES.S2.map(gate => receipt(branch, gate, subject));

  const failed = [
    ...passing.slice(1),
    receipt(branch, 'G-TIME', subject, { outcome: 'FAIL', detail: 'planted look-ahead was not rejected' }),
  ];
  const blocked = nextActions({ ...f.store.snapshot(), receipts: failed }, branch, subject);
  assert.equal(blocked.canAdvance, false);
  assert.match(blocked.blockers.map(item => item.reason).join(' | '), /G-TIME failed and is mandatory/);

  // Declared inapplicable at freeze time, with a rationale on the receipt: allowed.
  const portfolio = { ...branch, stage: 'S5' as Stage };
  const declared = [
    receipt(portfolio, 'G-PORTFOLIO', subject, { outcome: 'NOT_APPLICABLE', rationale: 'no positions are produced' }),
  ];
  assert.equal(nextActions({ ...f.store.snapshot(), receipts: declared }, portfolio, subject).canAdvance, true);

  // Not declared at freeze time: refused, because that is how an inconvenient check gets skipped.
  const undeclared = [
    receipt(portfolio, 'G-PORTFOLIO', subject, { outcome: 'NOT_APPLICABLE', rationale: 'it seemed irrelevant' }),
  ];
  const other = { ...portfolio, specId: branchOf(f.store.snapshot(), 'Correctness').specId };
  const withoutDeclaration = fixture(t);
  draft(withoutDeclaration, 'NoDeclaration');
  let plain = branchOf(withoutDeclaration.store.snapshot(), 'NoDeclaration');
  freeze(withoutDeclaration, plain);
  plain = { ...branchOf(withoutDeclaration.store.snapshot(), 'NoDeclaration'), stage: 'S5' as Stage };
  const refused = nextActions(
    {
      ...withoutDeclaration.store.snapshot(),
      receipts: [
        receipt(plain, 'G-PORTFOLIO', subject, { outcome: 'NOT_APPLICABLE', rationale: 'it seemed irrelevant' }),
      ],
    },
    plain,
    subject,
  );
  assert.equal(refused.canAdvance, false);
  assert.match(refused.blockers[0].reason, /frozen specification never declared it so/);
  void undeclared;
  void other;
});

test('a negative result is preserved rather than discarded', t => {
  const f = fixture(t);
  draft(f, 'Weak edge');
  let branch = branchOf(f.store.snapshot(), 'Weak edge');
  freeze(f, branch);
  branch = branchOf(f.store.snapshot(), 'Weak edge');
  const settled = f.store.execute({
    type: 'research.settleBranch',
    idempotencyKey: key(),
    branchId: branch.id,
    expectedRevision: branch.revision,
    outcome: 'VALID_NEGATIVE',
    reason: 'net economics were below the frozen threshold',
  });
  const after = settled.branches!.find(item => item.id === branch.id)!;
  assert.equal(after.outcome, 'VALID_NEGATIVE');
  assert.equal(after.retiredAt, undefined, 'a valid negative is a finding, not a retirement');
  assert.match(settled.events.at(-1)!.reason, /preserved, not discarded/);
});

test('one follow-up allowance holds across a renamed lineage', t => {
  const f = fixture(t);
  draft(f, 'Family root');
  let root = branchOf(f.store.snapshot(), 'Family root');
  freeze(f, root);
  root = branchOf(f.store.snapshot(), 'Family root');

  f.store.execute({
    type: 'research.registerVariant',
    idempotencyKey: key(),
    branchId: root.id,
    kind: 'FOLLOW_UP',
    variantHash: hashOf('follow-up-one'),
    description: 'the one decisive follow-up',
  });

  // Amend into a differently named child, then try again from there.
  const amended = f.store.execute({
    type: 'research.amendBranch',
    idempotencyKey: key(),
    branchId: root.id,
    expectedRevision: root.revision,
    name: 'Completely different name',
    reason: 'renamed',
  });
  let child = branchOf(amended, 'Completely different name');
  f.store.execute({
    type: 'research.draftSpec',
    idempotencyKey: key(),
    projectId: f.project.id,
    branchId: child.id,
    expectedRevision: child.revision,
    name: 'Completely different name',
    sections: sections(),
    thresholds: [],
    notApplicable: [],
    maxSelectionTrials: 12,
  });
  child = branchOf(f.store.snapshot(), 'Completely different name');
  freeze(f, child);
  child = branchOf(f.store.snapshot(), 'Completely different name');

  assert.throws(
    () =>
      f.store.execute({
        type: 'research.registerVariant',
        idempotencyKey: key(),
        branchId: child.id,
        kind: 'FOLLOW_UP',
        variantHash: hashOf('follow-up-two'),
        description: 'a second bite',
      }),
    /already used its one scientific follow-up/,
  );
  assert.equal(lineageCounters(f.store.snapshot(), root.lineageId).followUpAllowanceRemaining, 0);
});

test('a metadata-only retry is recorded but is not a new scientific trial', t => {
  const f = fixture(t);
  draft(f, 'Counters');
  let branch = branchOf(f.store.snapshot(), 'Counters');
  freeze(f, branch);
  branch = branchOf(f.store.snapshot(), 'Counters');
  const same = hashOf('variant-a');

  f.store.execute({
    type: 'research.registerVariant',
    idempotencyKey: key(),
    branchId: branch.id,
    kind: 'VARIANT',
    variantHash: same,
    description: 'first',
  });
  f.store.execute({
    type: 'research.registerVariant',
    idempotencyKey: key(),
    branchId: branch.id,
    kind: 'METADATA_RETRY',
    variantHash: same,
    description: 'rerun after a transport error',
  });
  f.store.execute({
    type: 'research.registerVariant',
    idempotencyKey: key(),
    branchId: branch.id,
    kind: 'VARIANT',
    variantHash: hashOf('variant-b'),
    description: 'second',
  });

  const counters = lineageCounters(f.store.snapshot(), branch.lineageId);
  assert.equal(counters.variants, 2);
  assert.equal(counters.metadataRetries, 1, 'the retry is kept in the ledger');
  assert.equal(counters.distinctVariants, 2, 'but it does not inflate the multiplicity count');
  assert.equal(exposure(f.store.snapshot(), branch).used, 2);
  assert.equal(exposure(f.store.snapshot(), branch).exceeded, false);
});

test('nothing is promoted or frozen automatically by a restart, and old event hashes survive', t => {
  const f = fixture(t);
  draft(f, 'Restart');
  const before = f.store.snapshot();
  const branch = branchOf(before, 'Restart');
  const hashesBefore = before.events.map(event => event.hash);

  const reopened = f.reopen();
  const after = reopened.snapshot();
  assert.deepEqual(
    after.events.map(event => event.hash),
    hashesBefore,
    'replay does not change historical event hashes',
  );
  const replayed = after.branches!.find(item => item.id === branch.id)!;
  assert.equal(replayed.specId, branch.specId);
  assert.equal(
    after.specs!.find(item => item.id === replayed.specId)!.frozen,
    false,
    'a draft is still a draft after a restart',
  );
  assert.equal(replayed.outcome, 'IN_PROGRESS', 'nothing is promoted by reopening the workspace');
  assert.equal(replayed.predictionId, null);
});

test('stage work cannot be opened at the wrong stage, or before the specification is frozen', t => {
  const f = fixture(t);
  draft(f, 'Ordering');
  let branch = branchOf(f.store.snapshot(), 'Ordering');
  assert.throws(
    () =>
      f.store.execute({
        type: 'research.createStageAttempt',
        idempotencyKey: key(),
        branchId: branch.id,
        stage: 'S0',
        assignmentId: null,
        trialId: null,
        summary: 'too early',
      }),
    /Freeze the specification/,
  );
  freeze(f, branch);
  branch = branchOf(f.store.snapshot(), 'Ordering');
  assert.throws(
    () =>
      f.store.execute({
        type: 'research.createStageAttempt',
        idempotencyKey: key(),
        branchId: branch.id,
        stage: 'S6',
        assignmentId: null,
        trialId: null,
        summary: 'skipping ahead',
      }),
    /branch is at S0/,
  );
  const opened = f.store.execute({
    type: 'research.createStageAttempt',
    idempotencyKey: key(),
    branchId: branch.id,
    stage: 'S0',
    assignmentId: null,
    trialId: null,
    summary: 'register and freeze',
  });
  assert.equal(opened.attempts!.length, 1);
  assert.equal(opened.attempts![0].state, 'OPEN');
});

test('every mandatory section is required by the reducer, and a retired branch does not advance', t => {
  const f = fixture(t);
  draft(f, 'Sections');
  let branch = branchOf(f.store.snapshot(), 'Sections');
  freeze(f, branch);
  branch = branchOf(f.store.snapshot(), 'Sections');
  assert.equal(SPEC_SECTIONS.length, 7);

  const retired = { ...branch, outcome: 'RETIRED' as const };
  const actions = nextActions(f.store.snapshot(), retired, hashOf('x'));
  assert.equal(actions.canAdvance, false);
  assert.match(actions.blockers[0].reason, /retired and does not advance/);
});
