import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { AssignmentController } from '../src/main/controller';
import { PipelineService, type PipelineIO } from '../src/main/pipeline';
import { HoldoutCustody } from '../src/main/holdout';
import { prepareInputSnapshot } from '../src/main/locations';
import { STAGE_FUNCTIONS_REQUIRED } from '../src/main/research-controller';
import { STAGES, type Stage } from '../src/shared/research';
import { runPackageHash, runPackageId, runReturnManifestSchema, type RunPackageManifest } from '../src/shared/run-package';
import type { PipelineRecord } from '../src/shared/pipeline';
import type { Assignment, InputSnapshot } from '../src/shared/types';
import { fixture, key, sha256 } from './fixtures/pipeline';

/**
 * The corrected manual pilot (roadmap 1.6 / slice C8), end to end on user-run evidence alone.
 *
 * Every stage is driven through the seam the corrected contract assigns it: agent stages take a
 * user-carried stage report (`importStageReport`), S3 exports the frozen package and waits durably
 * for a bound return, office stages validate admitted evidence, S7 runs the controller-separated
 * review tier, and S8 uses manual holdout custody (export → user-attested report → import).
 *
 * Nothing hosted, signed or independently custodied exists anywhere in this build: the service is
 * constructed with no research runtime, the provider double is never submitted to, the separated
 * round is unsigned, and holdout custody reports USER_IMPORTED verification with no evaluator.
 */
test('the manual pilot journey reaches S10 on user-run evidence alone', async t => {
  let now = Date.now();
  const clock = () => new Date(now).toISOString();
  const f = await fixture(t, undefined, false, { shadowPolicy: true, clock });
  // The restart step swaps in a reopened store; whichever instance is current must release the
  // SQLite file before the fixture's cleanup removes the workspace.
  const world = { store: f.store as OfficeStore, controller: f.controller as AssignmentController };
  t.after(() => { try { world.store.close(); } catch { /* already closed */ } });

  // The frozen request roster must name every appointed agent before the link binds it. Each stage
  // function goes to a distinct agent: a prepared assignment keeps its submission-intent job open
  // forever on the manual path (nothing is ever dispatched), and the store refuses one agent two
  // pieces of in-flight work on the same request.
  const third = f.makeAgent('Skeptic', clock());
  const fourth = f.makeAgent('Correctness reviewer', clock());
  const fifth = f.makeAgent('Assembler', clock());
  f.store.execute({
    type: 'request.update', idempotencyKey: key(), requestId: f.request.id, expectedRevision: f.request.revision,
    objective: f.request.objective, leadAgentId: f.principal.id, participantIds: [f.second.id, third.id, fourth.id, fifth.id],
    acceptanceCriteria: f.request.acceptanceCriteria,
  });
  const appointee = (stage: Stage, role: string) =>
    role === 'ADVOCATE' ? f.second : role === 'SKEPTIC' ? third : role === 'CORRECTNESS_REVIEWER' ? fourth : stage === 'S4' ? fifth : f.principal;
  for (const stage of STAGES) for (const role of STAGE_FUNCTIONS_REQUIRED[stage]) {
    f.store.appendFunctionAssignment({
      id: key(), projectId: f.project.id, stage, function: role, agentId: appointee(stage, role).id, agentRevision: 0,
      appendedAt: clock(), supersededById: null, origin: 'EXPLICIT', note: 'Manual pilot appointment',
    });
  }

  // Manual custody: sealed storage and the journal exist; no evaluator is wired into this process,
  // so the isolated route stays honestly closed and only the user-custody route can run.
  const custody = new HoldoutCustody(
    { sealedRoot: path.join(f.root, 'custody', 'sealed'), journalFile: path.join(f.root, 'custody', 'journal.jsonl') },
    { sealedStorageSupported: true, isolatedEvaluatorSupported: true, detail: 'Manual user custody only; no isolated evaluator is provisioned.' },
    null, clock);

  // The manual-run seams as test doubles: a JSON envelope stands in for the production zip codec,
  // while the store and pipeline admission paths under test run exactly as shipped.
  const packages = {
    build: {
      async build(input: { state: ReturnType<OfficeStore['snapshot']>; branch: { id: string; revision: number; projectId: string; specId: string | null }; link: { subjectHash: string; requestId: string; requestRevision: number }; spec: { id: string; contentHash: string } }) {
        const base: Omit<RunPackageManifest, 'packageId' | 'packageHash' | 'exportedAt'> = {
          schemaVersion: 1, kind: 'RUN_PACKAGE', projectId: input.branch.projectId, branchId: input.branch.id, branchRevision: input.branch.revision,
          specId: input.spec.id, specHash: input.spec.contentHash, subjectHash: input.link.subjectHash,
          requestId: input.link.requestId, requestRevision: input.link.requestRevision,
          entries: [{ path: 'main.py', sha256: sha256('pilot-launcher'), bytes: 14 }],
          environment: { runtime: 'COLAB_USER_RUN', detail: 'Synthetic package; the user runs it in Colab by hand.' },
          expectedReturn: { files: ['result.json'], requiredGates: ['G-PORTFOLIO', 'G-COST', 'G-ECON'] },
          instructions: 'Open Colab, upload this package, run the launcher, return the produced bundle.',
        };
        const packageHash = runPackageHash(base);
        const manifest: RunPackageManifest = { ...base, packageId: runPackageId(packageHash), packageHash, exportedAt: clock() };
        return { manifest, bytes: Buffer.from(JSON.stringify({ kind: 'QRO_RUN_PACKAGE', manifest })) };
      },
    },
    inspect: {
      inspect(input: { bytes: Uint8Array; expect: { packageId: string; packageHash: string } }) {
        const manifest = runReturnManifestSchema.parse(JSON.parse(Buffer.from(input.bytes).toString('utf8')));
        if (manifest.packageId !== input.expect.packageId || manifest.packageHash !== input.expect.packageHash)
          throw new Error('Returned bundle names a different package.');
        return {
          manifest, manifestHash: sha256(input.bytes), summary: 'Bound return admitted for package ' + manifest.packageId + '.',
          objects: manifest.artifacts.map(a => ({ path: a.path, sha256: a.sha256, bytes: Buffer.alloc(a.bytes, a.sha256.slice(0, 2)) })),
        };
      },
    },
  };

  const exportedFiles = new Map<string, Uint8Array>();
  const io: PipelineIO = {
    writeObject: f.io.writeObject,
    selectHoldout: async () => Buffer.from('rowId,target\nr1,0.5\n'),
    exportHoldout: async bytes => { exportedFiles.set('holdout', bytes); },
    exportPackage: async (bytes, packageId) => { exportedFiles.set(packageId, bytes); return null; },
  };

  // The service under test carries no research runtime: no signed harness, no provider-observed
  // isolated contexts. Custody is manual-only; the provider double is a routing fixture, never a
  // host.
  const stageInputs = (input: { projectId: string; requestId: string; requestRevision: number; objective: string }): Promise<InputSnapshot> =>
    prepareInputSnapshot({ store: world.store, objectRoot: f.root, stagingRoot: path.join(f.root, 'staging'), gitExecutable: 'qro-no-such-git', ...input });
  const service = () => new PipelineService(world.store, world.controller, custody, stageInputs, f.readObject, clock, null, io, packages);
  const state = () => world.store.snapshot();
  const branch = () => state().branches![0];
  const specId = () => branch().specId!;
  const advance = () => service().run({ type: 'advance', branchId: branch().id, expectedRevision: branch().revision });
  const records = <K extends PipelineRecord['kind']>(kind: K) =>
    (state().pipeline ?? []).filter((r): r is Extract<PipelineRecord, { kind: K }> => r.kind === kind);
  const completion = (stage: Stage) => records('STAGE_COMPLETION').find(r => r.stage === stage)!;
  const receipt = (gate: string) => (state().receipts ?? []).find(r => r.gate === gate)!;

  const artifact = async (body: unknown, name = 'user-carried.json', mediaType = 'application/json') => {
    const object = await io.writeObject(typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body)));
    const id = randomUUID();
    world.store.addArtifact({
      id, projectId: f.project.id, experimentId: null, name, sha256: object.sha256, size: object.bytes,
      kind: 'RESULT', classification: 'USER_ATTESTED', status: 'QUARANTINED', createdAt: clock(), mediaType,
      note: 'User-carried pilot evidence',
    });
    return { id, sha256: object.sha256 };
  };

  // A stage report the user carried back, admitted against the exact assignment context. No
  // dispatch, no observe, no provider job: the OPEN attempt settles with USER_IMPORTED provenance.
  const stageReport = (a: Assignment, extra: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: 1, branchId: a.research!.branchId, specId: a.research!.specId, subjectHash: a.research!.subjectHash,
    stage: a.research!.stage, contextHash: a.research!.contextHash, gates: [], detail: 'User-carried stage report.', ...extra,
  });
  const userStage = async (stage: Stage, extra: (a: Assignment) => Record<string, unknown> = () => ({})) => {
    assert.equal(branch().stage, stage, `the pilot must actually be at ${stage}`);
    const prepared = await service().run({ type: 'prepare', branchId: branch().id, expectedRevision: branch().revision });
    for (const a of prepared.assignments!) {
      const carried = await artifact(stageReport(a, extra(a)), `stage-${stage}-report.json`);
      await service().run({ type: 'importStageReport', assignmentId: a.id, artifactId: carried.id });
    }
    return prepared.assignments!;
  };

  // ---- S0: link the exact candidate; the office verifies the frozen prospective specification.
  await service().run({ type: 'link', branchId: branch().id, expectedRevision: branch().revision, requestId: f.request.id, subjectHash: f.subjectHash });
  await service().run({ type: 'verifySpec', branchId: branch().id, expectedRevision: branch().revision });
  assert.equal(receipt('G-SPEC').provenance, 'OFFICE');
  await advance();
  assert.equal(branch().stage, 'S1');

  // ---- S1: specification analysis returns as a user-carried report on the prepared context.
  await userStage('S1');
  const s1 = completion('S1');
  assert.equal(s1.provenance, 'USER_IMPORTED');
  await advance();
  assert.equal(branch().stage, 'S2');

  // ---- S2: blinded correctness review in the controller-separated tier — unsigned, unverifiable
  // as independent, labelled SEPARATE_SESSION_UNVERIFIED and never promoted past it.
  await userStage('S2', () => ({
    verdict: 'SUPPORTS', defectFound: false, detail: 'Separated S2 review complete.',
    gates: ['G-CORRECT', 'G-TIME', 'G-SPLIT', 'G-FIT', 'G-TARGET', 'G-SELECT', 'G-TRADETIME']
      .map(gate => ({ gate, outcome: 'PASS', detail: `${gate} reviewed.`, rationale: 'Separated pilot review.' })),
  }));
  const s2round = records('SEPARATED_REVIEW').find(r => r.stage === 'S2')!;
  assert.equal(s2round.correctnessBlinded, true);
  const s2report = records('REVIEW_REPORT').find(r => r.stage === 'S2')!;
  assert.equal(s2report.independence, 'SEPARATE_SESSION_UNVERIFIED');
  assert.equal(s2report.opened, true);
  for (const gate of ['G-CORRECT', 'G-TIME', 'G-SPLIT', 'G-FIT', 'G-TARGET', 'G-SELECT', 'G-TRADETIME'])
    assert.equal(receipt(gate).provenance, 'REVIEWER_ASSERTED');
  await advance();
  assert.equal(branch().stage, 'S3');

  // ---- S3: the office authors the frozen package; the branch then waits — durably, across a
  // restart — with an OPEN attempt and no execution job anywhere.
  const exported = await service().run({ type: 'exportRunPackage', branchId: branch().id, expectedRevision: branch().revision });
  assert.match(exported.detail, /waits for the manual user run; no execution job exists anywhere/);
  const pkg = records('RUN_PACKAGE').at(-1)!;
  assert.equal(pkg.kind, 'RUN_PACKAGE');
  assert.equal(pkg.state, 'AWAITING_RETURN');
  assert.ok(exportedFiles.has(pkg.packageId), 'the package bytes were handed to the user');
  const wait = state().attempts!.find(a => a.stage === 'S3')!;
  assert.equal(wait.state, 'OPEN');
  assert.equal(wait.assignmentId, null);
  assert.equal(f.adapter.submissions.length, 0, 'export is authoring, not submission');

  const tipBeforeRestart = world.store.snapshot().events!.length;
  world.store.close();
  world.store = new OfficeStore(path.join(f.root, 'workspace.sqlite'));
  world.controller = new AssignmentController(world.store, f.adapter, clock, async () => []);
  assert.equal(state().events!.length, tipBeforeRestart, 'the wait state replays identically after restart');
  const reopened = records('RUN_PACKAGE').at(-1)!;
  assert.equal(reopened.kind, 'RUN_PACKAGE');
  assert.equal(reopened.state, 'AWAITING_RETURN');
  const reopenedWait = state().attempts!.find(a => a.stage === 'S3')!;
  assert.equal(reopenedWait.state, 'OPEN');
  assert.equal(reopenedWait.assignmentId, null);
  for (const job of state().jobs ?? []) assert.equal(job.state, 'INTENT', 'prepared stage work was never dispatched');
  assert.ok(!(state().jobs ?? []).some(j => (state().assignments?.find(a => a.id === j.assignmentId)?.research?.stage) === 'S3'),
    'no execution job exists for the wait, before or after restart');

  // A bound return names the package byte-for-byte; admission is user-imported, never provider or
  // harness evidence.
  const returnManifest = {
    schemaVersion: 1, kind: 'RUN_RETURN', packageId: reopened.packageId, packageHash: reopened.packageHash,
    branchId: reopened.branchId, specId: reopened.specId, specHash: reopened.specHash, subjectHash: reopened.subjectHash,
    runId: 'colab-user-run-' + randomUUID().slice(0, 8), startedAt: clock(), finishedAt: clock(), status: 'COMPLETED',
    artifacts: [{ path: 'result.json', sha256: sha256('pilot-result-bytes'), bytes: 18 }],
    gates: [
      { gate: 'G-PORTFOLIO', stage: 'S5', outcome: 'PASS', detail: 'User-run portfolio gate passed.', rationale: 'Bound return.' },
      { gate: 'G-COST', stage: 'S6', outcome: 'PASS', detail: 'User-run cost gate passed.', rationale: 'Bound return.' },
      { gate: 'G-ECON', stage: 'S6', outcome: 'PASS', detail: 'User-run economics gate passed.', rationale: 'Bound return.' },
    ],
    failedRuns: [], detail: 'User ran the exported package in Colab and carried the bundle back.',
  };
  const returned = await artifact(returnManifest, 'return.zip', 'application/zip');
  const admitted = await service().run({ type: 'importRunReturn', branchId: branch().id, expectedRevision: branch().revision, artifactId: returned.id });
  assert.match(admitted.detail, /Bound return admitted/);
  const runReturn = records('RUN_RETURN').at(-1)!;
  assert.equal(runReturn.kind, 'RUN_RETURN');
  assert.equal(runReturn.verification, 'USER_IMPORTED');
  const s3 = completion('S3');
  assert.equal(s3.provenance, 'USER_IMPORTED');
  assert.equal(s3.assignmentId, null);
  assert.equal(s3.jobId, null);
  assert.equal(receipt('G-ARTIFACT').provenance, 'OFFICE');
  for (const gate of ['G-PORTFOLIO', 'G-COST', 'G-ECON'])
    assert.equal(receipt(gate).provenance, 'USER_RUN');
  await advance();
  assert.equal(branch().stage, 'S4');

  // ---- S4: candidate assembly returns as a user-carried report.
  await userStage('S4');
  assert.equal(completion('S4').provenance, 'USER_IMPORTED');
  await advance();
  assert.equal(branch().stage, 'S5');

  // ---- S5/S6: the office validates the bound return's gate receipts — office evidence, not a
  // rerun and not the user's say-so promoted.
  for (const stage of ['S5', 'S6'] as const) {
    await service().run({ type: 'validateReturn', branchId: branch().id, expectedRevision: branch().revision });
    const validated = completion(stage);
    assert.equal(validated.provenance, 'OFFICE_VALIDATED');
    assert.equal(validated.assignmentId, null);
    assert.equal(validated.jobId, null);
    await advance();
  }
  assert.equal(branch().stage, 'S7');

  // ---- S7: the separated adversarial round. Two reviewers, two sealed first reports opened only
  // once both are immutable, one bounded office-bound rebuttal, then adjudication — all unsigned.
  const s7assignments = await userStage('S7', () => ({ verdict: 'SUPPORTS', defectFound: false, detail: 'Separated S7 report.' }));
  assert.equal(s7assignments.length, 2);
  const s7round = records('SEPARATED_REVIEW').find(r => r.stage === 'S7')!;
  assert.equal(s7round.contexts.length, 2);
  const s7reports = records('REVIEW_REPORT').filter(r => r.stage === 'S7');
  assert.equal(s7reports.length, 2);
  for (const r of s7reports) {
    assert.equal(r.opened, true, 'a separated first report opens only when every first report is filed');
    assert.equal(r.independence, 'SEPARATE_SESSION_UNVERIFIED');
  }
  const rebuttal = await artifact({ phase: 'REBUTTAL', contextHash: s7assignments[0].research!.contextHash, detail: 'Bounded office-bound response.' }, 'rebuttal.json');
  await service().run({ type: 'rebuttal', assignmentId: s7assignments[0].id, artifactId: rebuttal.id });
  const rebuttalRecord = records('REBUTTAL').at(-1)!;
  assert.equal(rebuttalRecord.proof, null, 'an office-bound rebuttal carries no signature claim');
  await service().run({ type: 'adjudicate', branchId: branch().id, expectedRevision: branch().revision, followUp: false });
  const adjudication = records('ADJUDICATION').at(-1)!;
  assert.equal(adjudication.outcome, 'UPHELD');
  assert.equal(adjudication.decision, 'PROMOTE');
  await advance();
  assert.equal(branch().stage, 'S8');

  // ---- S8: manual holdout custody. Register, reserve, export to the user, import the attested
  // report; the isolated route itself refuses because no evaluator exists in this build.
  await service().run({ type: 'holdoutRegister', branchId: branch().id, name: 'Pilot sealed holdout', timezoneOffsetMinutes: 0, allowancePerPeriod: 1 });
  const holdout = records('HOLDOUT').at(-1)!.holdout;
  const query = await artifact([{ rowId: 'r1', prediction: 0.5 }], 'holdout-query.json');
  const reserved = await service().run({ type: 'holdoutReserve', branchId: branch().id, holdoutId: holdout.id, refitHash: runReturn.outputHashes[0], queryArtifactId: query.id });
  const reservation = reserved.reservation!;
  // The isolated route itself is honestly closed: custody carries no evaluator, so the call
  // refuses before any exposure is journalled and the manual export/import path below is the only
  // way this reservation can settle.
  await assert.rejects(
    custody.evaluate(reservation, holdout, [{ rowId: 'r1', prediction: 0.5 }]),
    /No isolated evaluator is configured/);
  const holdoutExport = await service().run({ type: 'holdoutExport', branchId: branch().id, reservationId: reservation.id });
  assert.ok(exportedFiles.has('holdout'), 'the sealed bytes were handed to the user');
  assert.match(holdoutExport.detail, /USER_CUSTODY/);
  const manualReport = await artifact({
    reservationId: reservation.id, candidateHash: f.subjectHash, refitHash: reservation.refitHash, queryHash: reservation.queryHash,
    result: { metric: 'synthetic', value: 0.5, samples: 1, detail: 'User-attested manual holdout report.' },
  }, 'holdout-report.json');
  await service().run({ type: 'holdoutImport', branchId: branch().id, reservationId: reservation.id, artifactId: manualReport.id });
  const holdoutResult = records('HOLDOUT_RESULT').at(-1)!;
  assert.equal(holdoutResult.verification, 'USER_IMPORTED', 'manual custody stays user-imported, never relabelled');
  await service().run({ type: 'validateReturn', branchId: branch().id, expectedRevision: branch().revision });
  const s8 = completion('S8');
  assert.equal(s8.provenance, 'OFFICE_VALIDATED');
  assert.equal(receipt('G-INTEGRITY').provenance, 'OFFICE');
  await advance();
  assert.equal(branch().stage, 'S9');

  // ---- S9/S10: office shadow evidence. Imported prospective batches replay under the frozen
  // policy; the verdict and every batch stay USER_IMPORTED and the office validation is its own
  // labelled act, not a promotion of the imports.
  const predictionId = randomUUID();
  const forecastFor = new Date(now + 120_000).toISOString();
  const scope = { schemaVersion: 1, branchId: branch().id, specId: specId(), candidateHash: f.subjectHash };
  const predictions = await artifact({
    ...scope, kind: 'PREDICTIONS',
    predictions: [{ id: predictionId, branchId: branch().id, specId: specId(), candidateHash: f.subjectHash, symbol: 'SYNTH', recordedAt: clock(), forecastFor, prediction: 1, horizonSeconds: 120 }],
  }, 'shadow-predictions.json');
  await service().run({ type: 'shadowIngest', branchId: branch().id, expectedRevision: branch().revision, artifactId: predictions.id });
  assert.equal(records('MONITOR_VERDICT').at(-1)!.outcome, 'INCONCLUSIVE',
    'an unripe shadow period reports inconclusive, never a convenient pass');

  now += 130_000; // the forecast horizon elapses between ingestion and observation
  const observations = await artifact({
    ...scope, kind: 'OBSERVATIONS',
    quotes: [{ symbol: 'SYNTH', at: forecastFor, bid: 1, ask: 1.01, source: 'user-maintained feed' }],
    fills: [{ predictionId, symbol: 'SYNTH', at: forecastFor, quantity: 1, price: 1.01, kind: 'SIMULATED', provenance: 'user-run shadow report' }],
    outcomes: { [predictionId]: 0.5 },
  }, 'shadow-observations.json');
  await service().run({ type: 'shadowIngest', branchId: branch().id, expectedRevision: branch().revision, artifactId: observations.id });
  const verdict = records('MONITOR_VERDICT').at(-1)!;
  assert.equal(verdict.kind, 'MONITOR_VERDICT');
  assert.equal(verdict.outcome, 'SHADOW_QUALIFIED');
  assert.equal(verdict.verification, 'USER_IMPORTED');
  for (const batch of records('SHADOW_BATCH'))
    assert.equal(batch.verification, 'USER_IMPORTED');
  const beforeMonitor = state().pipeline!.length;
  await service().run({ type: 'monitor', branchId: branch().id, expectedRevision: branch().revision });
  assert.equal(state().pipeline!.length, beforeMonitor, 'an unchanged replay dedups rather than restating the verdict');
  await service().run({ type: 'validateReturn', branchId: branch().id, expectedRevision: branch().revision });
  const s9 = completion('S9');
  assert.equal(s9.provenance, 'OFFICE_VALIDATED');
  assert.equal(receipt('G-SHADOW').provenance, 'OFFICE');
  await advance();
  assert.equal(branch().stage, 'S10');

  await service().run({ type: 'monitor', branchId: branch().id, expectedRevision: branch().revision });
  await service().run({ type: 'validateReturn', branchId: branch().id, expectedRevision: branch().revision });
  const s10 = completion('S10');
  assert.equal(s10.provenance, 'OFFICE_VALIDATED');
  await assert.rejects(advance(), /final stage has no successor/);

  // ---- What this journey was not. The evidence labels below are the claim this test makes and
  // the ceiling it may never exceed: nothing hosted, nothing signed, nothing independently
  // custodied was configured anywhere in the build.
  assert.deepEqual(service().capabilities(), { packageExport: true, returnValidation: true, independentRuntime: false, custody: true });
  assert.equal(custody.status.verification, 'USER_IMPORTED');
  assert.equal(f.adapter.submissions.length, 0, 'no provider submission happened anywhere in the journey');
  for (const job of state().jobs ?? []) {
    assert.equal(job.state, 'INTENT', 'prepared stage work was never dispatched');
    assert.notEqual(job.evidence, 'PROVIDER_REPORTED');
  }
  const ledger = state().pipeline!;
  assert.equal(ledger.filter(r => r.kind === 'HARNESS_RECEIPT' || r.kind === 'REVIEW_ROUND' || r.kind === 'HARNESS_INTENT').length, 0,
    'no signed-harness evidence of any kind exists');
  for (const r of ledger)
    if ('verification' in r) assert.equal(r.verification, 'USER_IMPORTED', `${r.kind} must stay user-imported, never promoted`);
  for (const r of state().receipts ?? []) assert.notEqual(r.provenance, 'SIGNED_HARNESS');
  assert.equal(branch().stage, 'S10');
  world.store.close();
});
