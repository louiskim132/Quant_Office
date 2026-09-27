import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PipelineService } from '../src/main/pipeline';
import { snapshotObjectPath } from '../src/main/locations';
import { fixture, completeS1, key, at, sha256, declared } from './fixtures/pipeline';
import { STAGE_GATES } from '../src/shared/research';
import {
  runPackageHash,
  runPackageId,
  runReturnManifestSchema,
  type RunPackageManifest,
  type RunReturnManifest,
} from '../src/shared/run-package';
import type { BranchLink, PipelineRecord, StageContext } from '../src/shared/pipeline';
import type { AppState, Assignment } from '../src/shared/types';
import type { FrozenResearchSpec, ResearchBranch } from '../src/shared/research';

/**
 * The runtime-free tier of the manual contract (roadmap section 1.6, slice C8.4): with no
 * independent ResearchRuntime configured, S2/S7 preparation freezes a controller-separated
 * SEPARATED_REVIEW round instead of a hosted REVIEW_ROUND; reports admitted against it are
 * labelled SEPARATE_SESSION_UNVERIFIED and never promoted; and the manual evidence-import
 * actions — imported stage reports, bounded rebuttals carried as artifacts and office
 * validation of bound returns — bind to the same durable records under their own provenance.
 * Everything here runs against the real store, controller and object store; only the provider
 * and the package codec are doubles.
 */

const packages = {
  build: {
    async build(input: {
      state: AppState;
      branch: ResearchBranch;
      link: BranchLink;
      spec: FrozenResearchSpec;
      readObject: (sha256: string) => Promise<Uint8Array | null>;
    }) {
      const base: Omit<RunPackageManifest, 'packageId' | 'packageHash' | 'exportedAt'> = {
        schemaVersion: 1,
        kind: 'RUN_PACKAGE',
        projectId: input.branch.projectId,
        branchId: input.branch.id,
        branchRevision: input.branch.revision,
        specId: input.spec.id,
        specHash: input.spec.contentHash,
        subjectHash: input.link.subjectHash,
        requestId: input.link.requestId,
        requestRevision: input.link.requestRevision,
        entries: [{ path: 'main.py', sha256: sha256('synthetic-launcher'), bytes: 18 }],
        environment: { runtime: 'COLAB_USER_RUN', detail: 'Synthetic package; the user runs it in Colab.' },
        expectedReturn: { files: ['result.json'], requiredGates: ['G-PORTFOLIO', 'G-COST', 'G-ECON'] },
        instructions: 'Open Colab, upload this package, run the launcher, return the produced bundle.',
      };
      const packageHash = runPackageHash(base);
      const manifest: RunPackageManifest = {
        ...base,
        packageId: runPackageId(packageHash),
        packageHash,
        exportedAt: new Date().toISOString(),
      };
      return { manifest, bytes: Buffer.from(JSON.stringify({ kind: 'QRO_RUN_PACKAGE', manifest })) };
    },
  },
  inspect: {
    inspect(input: { bytes: Uint8Array; expect: { packageId: string; packageHash: string } }) {
      const manifest = runReturnManifestSchema.parse(JSON.parse(Buffer.from(input.bytes).toString('utf8')));
      if (manifest.packageId !== input.expect.packageId || manifest.packageHash !== input.expect.packageHash)
        throw new Error('Returned bundle names a different package.');
      return {
        manifest,
        objects: manifest.artifacts.map(a => ({
          path: a.path,
          sha256: a.sha256,
          bytes: Buffer.alloc(Math.max(1, a.bytes)),
        })),
        manifestHash: sha256(input.bytes),
        summary: 'Bound return admitted for package ' + manifest.packageId + '.',
      };
    },
  },
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Separated = Awaited<ReturnType<typeof separatedFixture>>;

/** Pipeline records of one kind, narrowed. */
const records = <K extends PipelineRecord['kind']>(f: Fixture, kind: K) =>
  (f.store.snapshot().pipeline ?? []).filter((r): r is Extract<PipelineRecord, { kind: K }> => r.kind === kind);

/** A stage report bound to one exact assignment context, as that stage's worker would file it. */
function stageReport(context: StageContext, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    branchId: context.branchId,
    specId: context.specId,
    subjectHash: context.subjectHash,
    stage: context.stage,
    contextHash: context.contextHash,
    gates: STAGE_GATES[context.stage].map(gate => ({
      gate,
      outcome: 'PASS',
      detail: gate + ' reviewed.',
      rationale: 'separated review',
    })),
    ...(['S2', 'S7'].includes(context.stage) ? { verdict: 'SUPPORTS', defectFound: false } : {}),
    detail: `Separated ${context.stage} report.`,
    ...overrides,
  });
}

/** The provider double files the context-bound report for whichever assignment is observed. */
function observeStageReports(f: Fixture) {
  f.adapter.behaviour.observe = async job => {
    const context = f.store.snapshot().assignments!.find(a => a.id === job.assignmentId)!.research!;
    return {
      state: 'COMPLETED' as const,
      detail: 'Stage report delivered.',
      outputs: [declared(stageReport(context))],
    };
  };
}

/** Register imported bytes as a quarantined project artifact, exactly as the UI import does. */
async function artifact(f: Fixture, body: unknown, name = 'return.zip'): Promise<{ id: string; sha256: string }> {
  const object = await f.io.writeObject(Buffer.from(JSON.stringify(body)));
  const id = randomUUID();
  f.store.addArtifact({
    id,
    projectId: f.project.id,
    experimentId: null,
    name,
    sha256: object.sha256,
    size: object.bytes,
    kind: 'RESULT',
    classification: 'USER_ATTESTED',
    status: 'QUARANTINED',
    createdAt: at(12),
    mediaType: name.endsWith('.zip') ? 'application/zip' : 'application/json',
    note: 'Synthetic imported bytes',
  });
  return { id, sha256: object.sha256 };
}

function returnManifest(
  pkg: {
    packageId: string;
    packageHash: string;
    branchId: string;
    specId: string;
    specHash: string;
    subjectHash: string;
  },
  overrides: Partial<RunReturnManifest> = {},
) {
  return {
    schemaVersion: 1,
    kind: 'RUN_RETURN',
    packageId: pkg.packageId,
    packageHash: pkg.packageHash,
    branchId: pkg.branchId,
    specId: pkg.specId,
    specHash: pkg.specHash,
    subjectHash: pkg.subjectHash,
    runId: 'synthetic-run-' + randomUUID().slice(0, 8),
    startedAt: at(10),
    finishedAt: at(11),
    status: 'COMPLETED',
    artifacts: [{ path: 'result.json', sha256: sha256('synthetic-result'), bytes: 16 }],
    gates: [
      { gate: 'G-PORTFOLIO', stage: 'S5', outcome: 'PASS', detail: 'Portfolio gate passed.', rationale: 'user run' },
      { gate: 'G-COST', stage: 'S6', outcome: 'PASS', detail: 'Cost gate passed.', rationale: 'user run' },
      { gate: 'G-ECON', stage: 'S6', outcome: 'PASS', detail: 'Economics gate passed.', rationale: 'user run' },
    ],
    failedRuns: [],
    detail: 'Synthetic user-run return.',
    ...overrides,
  };
}

/** A linked workspace on the runtime-free tier, driven to S2 with S1 completed. */
async function separatedFixture(t: TestContext) {
  const f = await fixture(t, undefined, true);
  const skeptic = f.makeAgent('Skeptic', at(2));
  // Both independent reviewers sit on the frozen request roster before the link is recorded.
  f.store.execute({
    type: 'request.update',
    idempotencyKey: key(),
    requestId: f.request.id,
    expectedRevision: f.request.revision,
    objective: f.request.objective,
    leadAgentId: f.principal.id,
    participantIds: [f.second.id, skeptic.id],
    acceptanceCriteria: f.request.acceptanceCriteria,
  });
  const service = () =>
    new PipelineService(f.store, f.controller, null, f.stageInputs, f.readObject, f.clock, null, f.io, packages);
  await f.linked();
  await service().run({ type: 'verifySpec', branchId: f.branch().id, expectedRevision: f.branch().revision });
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const s1 = await completeS1(f);
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(f.branch().stage, 'S2');
  return { f, service, skeptic, s1 };
}

const appoint = (
  f: Fixture,
  stage: 'S2' | 'S4' | 'S7',
  fn: 'PRINCIPAL' | 'CORRECTNESS_REVIEWER' | 'ADVOCATE' | 'SKEPTIC',
  agentId: string,
  minute: number,
) =>
  f.store.appendFunctionAssignment({
    id: key(),
    projectId: f.project.id,
    stage,
    function: fn,
    agentId,
    agentRevision: 0,
    appendedAt: at(minute),
    supersededById: null,
    origin: 'EXPLICIT',
    note: fn.toLowerCase().replaceAll('_', ' '),
  });

/** Prepares the separated S2 round and returns the reviewer assignment; nothing is collected yet. */
async function prepareS2(
  ctx: Separated,
): Promise<{ reviewer: Assignment; round: Extract<PipelineRecord, { kind: 'SEPARATED_REVIEW' }> }> {
  const { f, service } = ctx;
  appoint(f, 'S2', 'CORRECTNESS_REVIEWER', f.second.id, 3);
  const prepared = await service().run({
    type: 'prepare',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
  });
  const reviewer = prepared.assignments![0];
  const round = records(f, 'SEPARATED_REVIEW').find(r => r.stage === 'S2')!;
  assert.equal(round.kind, 'SEPARATED_REVIEW', 'S2 prepares a separated round when no runtime is configured');
  return { reviewer, round };
}

/** Drives S2 through the separated round and the provider-observed report path, into S3. */
async function separatedS2(ctx: Separated) {
  const { f, service } = ctx;
  const prepared = await prepareS2(ctx);
  observeStageReports(f);
  await f.controller.dispatch(prepared.reviewer.id);
  await f.controller.observe(prepared.reviewer.id);
  await service().run({ type: 'collect', assignmentId: prepared.reviewer.id });
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(f.branch().stage, 'S3');
  return prepared;
}

/** S3: export the frozen package, admit the bound return, advance to S4. */
async function manualS3(ctx: Separated, overrides: Partial<RunReturnManifest> = {}) {
  const { f, service } = ctx;
  await service().run({ type: 'exportRunPackage', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const pkg = records(f, 'RUN_PACKAGE').at(-1)!;
  assert.equal(pkg.state, 'AWAITING_RETURN', 'the durable user wait is the package record itself');
  const returned = await artifact(f, returnManifest(pkg, overrides));
  await service().run({
    type: 'importRunReturn',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
    artifactId: returned.id,
  });
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(f.branch().stage, 'S4');
  return pkg;
}

/** S4: the analysis stage runs once, through provider observation or manual import. */
async function analystS4(ctx: Separated, via: 'provider' | 'import'): Promise<Assignment> {
  const { f, service } = ctx;
  appoint(f, 'S4', 'PRINCIPAL', f.principal.id, 13);
  const prepared = await service().run({
    type: 'prepare',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
  });
  const analyst = prepared.assignments![0];
  if (via === 'provider') {
    observeStageReports(f);
    await f.controller.dispatch(analyst.id);
    await f.controller.observe(analyst.id);
    await service().run({ type: 'collect', assignmentId: analyst.id });
  } else {
    const imported = await artifact(f, JSON.parse(stageReport(analyst.research!)), 's4-report.json');
    await service().run({ type: 'importStageReport', assignmentId: analyst.id, artifactId: imported.id });
  }
  return analyst;
}

/** An office stage: validate the bound admitted evidence, then advance. */
async function officeStage(ctx: Separated, stage: 'S5' | 'S6') {
  const { f, service } = ctx;
  assert.equal(f.branch().stage, stage);
  await service().run({ type: 'validateReturn', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const completion = records(f, 'STAGE_COMPLETION').find(r => r.stage === stage)!;
  assert.equal(completion.kind, 'STAGE_COMPLETION');
  assert.equal(completion.provenance, 'OFFICE_VALIDATED');
  assert.equal(completion.assignmentId, null);
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  return completion;
}

test('the runtime-free separated path drives S2 and S7 through SEPARATED_REVIEW rounds to adjudication', async t => {
  const ctx = await separatedFixture(t);
  const { f, service } = ctx;
  // No independent runtime or custody is configured; the separated tier is the pilot contract.
  assert.deepEqual(service().capabilities(), {
    packageExport: true,
    returnValidation: true,
    independentRuntime: false,
    custody: false,
  });

  // S2: the blinded correctness review freezes a separated round, not a hosted one.
  const { round: s2round } = await separatedS2(ctx);
  assert.equal(s2round.correctnessBlinded, true);
  assert.equal(s2round.contexts.length, 1);
  const s2report = records(f, 'REVIEW_REPORT').find(r => r.stage === 'S2')!;
  assert.equal(s2report.roundId, s2round.id);
  assert.equal(s2report.opened, true, 'a one-reviewer round opens as soon as its report files');
  assert.equal(s2report.independence, 'SEPARATE_SESSION_UNVERIFIED');

  await manualS3(ctx);
  const s4 = await analystS4(ctx, 'import');
  const s4completion = records(f, 'STAGE_COMPLETION').find(r => r.stage === 'S4')!;
  assert.equal(s4completion.assignmentId, s4.id);
  assert.equal(s4completion.jobId, null, 'the imported report completes the stage with no provider job');
  assert.equal(s4completion.provenance, 'USER_IMPORTED');
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  await officeStage(ctx, 'S5');
  assert.equal(f.branch().stage, 'S6');
  await officeStage(ctx, 'S6');
  assert.equal(f.branch().stage, 'S7');

  // S7: advocate and skeptic appointments freeze one separated round with two contexts.
  appoint(f, 'S7', 'ADVOCATE', f.second.id, 14);
  appoint(f, 'S7', 'SKEPTIC', ctx.skeptic.id, 15);
  const prepared = await service().run({
    type: 'prepare',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
  });
  const s7round = records(f, 'SEPARATED_REVIEW').find(r => r.stage === 'S7')!;
  assert.equal(s7round.kind, 'SEPARATED_REVIEW');
  assert.equal(s7round.contexts.length, 2);
  assert.equal(s7round.correctnessBlinded, false, 'S7 argues economics; both sides see the same evidence');
  assert.equal(records(f, 'REVIEW_ROUND').length, 0, 'no hosted review round exists anywhere in this build');
  const advocate = prepared.assignments!.find(a => a.research!.function === 'ADVOCATE')!;
  const skeptic = prepared.assignments!.find(a => a.research!.function === 'SKEPTIC')!;
  assert.equal(advocate.research!.reviewRoundId, s7round.id);
  assert.equal(skeptic.research!.reviewRoundId, s7round.id);
  assert.notEqual(advocate.research!.isolatedContextId, skeptic.research!.isolatedContextId);
  assert.deepEqual(
    [...advocate.research!.objectHashes].sort(),
    [...skeptic.research!.objectHashes].sort(),
    'both sides argue the same evidence set',
  );

  // The bounded response is imported up front; it can only be admitted once both reports are open.
  const rebuttal = await artifact(
    f,
    { phase: 'REBUTTAL', contextHash: advocate.research!.contextHash, detail: 'Bounded post-disclosure response.' },
    'rebuttal.json',
  );

  observeStageReports(f);
  await f.controller.dispatch(advocate.id);
  await f.controller.observe(advocate.id);
  await service().run({ type: 'collect', assignmentId: advocate.id });
  const filed = records(f, 'REVIEW_REPORT').filter(r => r.roundId === s7round.id);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].opened, false, 'the first report stays sealed until the round is complete');
  assert.equal(f.store.snapshot().sealed!.filter(s => s.openedAt === null).length, 1);
  await assert.rejects(
    service().run({ type: 'rebuttal', assignmentId: advocate.id, artifactId: rebuttal.id }),
    /first reports must be immutable/,
  );
  await assert.rejects(
    service().run({
      type: 'adjudicate',
      branchId: f.branch().id,
      expectedRevision: f.branch().revision,
      followUp: false,
    }),
    /first reports/i,
  );

  await f.controller.dispatch(skeptic.id);
  await f.controller.observe(skeptic.id);
  await service().run({ type: 'collect', assignmentId: skeptic.id });
  const opened = records(f, 'REVIEW_REPORT').filter(r => r.roundId === s7round.id);
  assert.equal(opened.length, 2);
  for (const r of opened) assert.equal(r.opened, true, 'both reports open once every reviewer has filed');
  assert.equal(f.store.snapshot().sealed!.filter(s => s.openedAt === null).length, 0);

  // With no configured runtime the only rebuttal transport is the imported bounded artifact.
  await assert.rejects(service().run({ type: 'rebuttal', assignmentId: advocate.id }), /transport is unavailable/);
  const response = await service().run({ type: 'rebuttal', assignmentId: advocate.id, artifactId: rebuttal.id });
  assert.match(response.detail, /office-bound/);
  const bounded = records(f, 'REBUTTAL').find(r => r.assignmentId === advocate.id)!;
  assert.equal(bounded.roundId, s7round.id);
  assert.equal(bounded.proof, null, 'a separated-tier rebuttal carries no independent signature');
  assert.equal(bounded.reportHash, rebuttal.sha256);
  const again = await service().run({ type: 'rebuttal', assignmentId: advocate.id, artifactId: rebuttal.id });
  assert.match(again.detail, /already recorded/);

  const decided = await service().run({
    type: 'adjudicate',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
    followUp: false,
  });
  const verdict = records(f, 'ADJUDICATION').at(-1)!;
  assert.equal(verdict.roundId, s7round.id);
  assert.equal(verdict.outcome, 'UPHELD');
  assert.equal(verdict.decision, 'PROMOTE');
  assert.deepEqual(
    verdict.reportIds,
    opened.map(r => r.id),
  );
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(f.branch().stage, 'S8', 'adjudication completes the round and the branch moves on');

  // Every produced review report keeps the unverified-independence label; nothing is promoted.
  const reports = records(f, 'REVIEW_REPORT');
  assert.equal(reports.length, 3, 'one S2 report plus the two S7 first reports');
  for (const r of reports) assert.equal(r.independence, 'SEPARATE_SESSION_UNVERIFIED');
  assert.equal(records(f, 'HARNESS_RECEIPT').length, 0);
  const returned = records(f, 'RUN_RETURN').at(-1)!;
  assert.equal(returned.verification, 'USER_IMPORTED');
  for (const gate of ['G-PORTFOLIO', 'G-COST', 'G-ECON'])
    assert.equal(
      f.store.snapshot().receipts!.find(r => r.gate === gate)!.provenance,
      'USER_RUN',
      'user-run gates keep their own label',
    );
  assert.equal(records(f, 'STAGE_COMPLETION').find(r => r.stage === 'S3')!.provenance, 'USER_IMPORTED');
});

test('importStageReport admits an exact-context report and refuses tampered, foreign-context and attemptless imports', async t => {
  const ctx = await separatedFixture(t);
  const { f, service } = ctx;
  const { reviewer } = await prepareS2(ctx);

  // Tampered bytes: the object no longer matches the identity the artifact registered.
  const honest = JSON.parse(stageReport(reviewer.research!));
  const object = await f.io.writeObject(Buffer.from(JSON.stringify(honest)));
  writeFileSync(
    snapshotObjectPath(f.root, object.sha256),
    Buffer.from(JSON.stringify({ ...honest, detail: 'Altered after hashing.' })),
  );
  const tampered = randomUUID();
  f.store.addArtifact({
    id: tampered,
    projectId: f.project.id,
    experimentId: null,
    name: 's2-report.json',
    sha256: object.sha256,
    size: object.bytes,
    kind: 'RESULT',
    classification: 'USER_ATTESTED',
    status: 'QUARANTINED',
    createdAt: at(12),
    mediaType: 'application/json',
    note: 'tampered',
  });
  await assert.rejects(
    service().run({ type: 'importStageReport', assignmentId: reviewer.id, artifactId: tampered }),
    /identity mismatch/,
  );

  // A well-formed report that names a different context is not this assignment's report.
  const foreign = await artifact(f, { ...honest, contextHash: ctx.s1.research!.contextHash }, 's2-report.json');
  await assert.rejects(
    service().run({ type: 'importStageReport', assignmentId: reviewer.id, artifactId: foreign.id }),
    /different research/,
  );

  // The pending attempt admits a correctly bound report with no provider job anywhere.
  const pending = f.store.snapshot().attempts!.find(a => a.assignmentId === reviewer.id)!;
  assert.equal(pending.state, 'OPEN');
  const imported = await artifact(f, honest, 's2-report.json');
  const admitted = await service().run({
    type: 'importStageReport',
    assignmentId: reviewer.id,
    artifactId: imported.id,
  });
  assert.match(admitted.detail, /user-imported provenance/);
  const completion = records(f, 'STAGE_COMPLETION').find(r => r.assignmentId === reviewer.id)!;
  assert.equal(completion.provenance, 'USER_IMPORTED');
  assert.equal(completion.jobId, null);
  assert.equal(completion.reportHash, imported.sha256);
  assert.equal(f.store.snapshot().attempts!.find(a => a.id === pending.id)!.state, 'COMPLETED');
  assert.equal(
    f.store.snapshot().jobs!.find(j => j.assignmentId === reviewer.id)!.state,
    'INTENT',
    'the import never touched the provider job',
  );
  const report = records(f, 'REVIEW_REPORT').find(r => r.assignmentId === reviewer.id)!;
  assert.equal(report.opened, true, 'the single-context separated round completes on admission');
  assert.equal(report.independence, 'SEPARATE_SESSION_UNVERIFIED');
  for (const receipt of f.store.snapshot().receipts!.filter(r => r.stage === 'S2'))
    assert.equal(receipt.provenance, 'REVIEWER_ASSERTED', 'imported reviewer claims stay reviewer-asserted');

  // Once the prepared work is discarded, no attempt awaits a report and import refuses honestly.
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  await manualS3(ctx);
  appoint(f, 'S4', 'PRINCIPAL', f.principal.id, 13);
  const prepared = await service().run({
    type: 'prepare',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
  });
  const analyst = prepared.assignments![0];
  f.controller.discardPreparation(analyst.id);
  const attempt = f.store.snapshot().attempts!.find(a => a.assignmentId === analyst.id)!;
  assert.equal(attempt.state, 'ABANDONED');
  const late = await artifact(f, JSON.parse(stageReport(analyst.research!)), 's4-report.json');
  await assert.rejects(
    service().run({ type: 'importStageReport', assignmentId: analyst.id, artifactId: late.id }),
    /durable open attempt/,
  );
});

test('validateReturn refuses a failed user-run verdict without dropping the record, and a foreign package return is never imported', async t => {
  const ctx = await separatedFixture(t);
  const { f, service } = ctx;
  await separatedS2(ctx);
  await service().run({ type: 'exportRunPackage', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const pkg = records(f, 'RUN_PACKAGE').at(-1)!;
  const args = { branchId: f.branch().id, expectedRevision: f.branch().revision };

  // A return naming a different package identity is rejected at the binding, not imported.
  const wrong = await artifact(f, returnManifest(pkg, { packageId: randomUUID() }));
  await assert.rejects(service().run({ type: 'importRunReturn', ...args, artifactId: wrong.id }), /different package/);
  assert.equal(records(f, 'RUN_RETURN').length, 0);

  // An honestly completed run whose portfolio check failed is admitted and preserved verbatim.
  const failed = await artifact(
    f,
    returnManifest(pkg, {
      gates: [
        {
          gate: 'G-PORTFOLIO',
          stage: 'S5',
          outcome: 'FAIL',
          detail: 'Portfolio gate failed in the user run.',
          rationale: 'user run',
        },
        { gate: 'G-COST', stage: 'S6', outcome: 'PASS', detail: 'Cost gate passed.', rationale: 'user run' },
        { gate: 'G-ECON', stage: 'S6', outcome: 'PASS', detail: 'Economics gate passed.', rationale: 'user run' },
      ],
      detail: 'The user run completed; the portfolio check failed.',
    }),
  );
  await service().run({ type: 'importRunReturn', ...args, artifactId: failed.id });
  const returned = records(f, 'RUN_RETURN').at(-1)!;
  assert.equal(returned.status, 'COMPLETED');
  assert.equal(returned.verification, 'USER_IMPORTED');
  const gate = f.store.snapshot().receipts!.find(r => r.gate === 'G-PORTFOLIO')!;
  assert.equal(gate.outcome, 'FAIL');
  assert.equal(gate.provenance, 'USER_RUN', 'a failed verdict keeps user-run provenance too');

  await service().run({ type: 'advance', ...args });
  await analystS4(ctx, 'provider');
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(f.branch().stage, 'S5');

  // The office validation reports the failure and leaves the stage incomplete; the record stands.
  await assert.rejects(
    service().run({ type: 'validateReturn', branchId: f.branch().id, expectedRevision: f.branch().revision }),
    /G-PORTFOLIO.*no passing admitted evidence/,
  );
  assert.equal(
    records(f, 'STAGE_COMPLETION').some(r => r.stage === 'S5'),
    false,
  );
  assert.equal(records(f, 'RUN_RETURN').length, 1, 'the failed return is preserved, not dropped');
  await assert.rejects(
    service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision }),
    /stage report|completion/i,
  );
});
