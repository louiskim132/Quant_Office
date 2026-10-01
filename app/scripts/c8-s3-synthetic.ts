import { mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createRunPackageCodec } from '../src/main/run-package';
import { assertForecastSeparateFromEconomics, judgeDiagnostic, judgeStress } from '../src/shared/research-diagnostics';
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
import type { PipelineRecord } from '../src/shared/pipeline';
import type { Assignment, InputSnapshot } from '../src/shared/types';
import { fixture, key, sha256 } from '../tests/fixtures/pipeline';
import { DIAGNOSTIC_POLICY_PREFIX } from '../src/main/returned-analysis';
import { datasetManifestSchema } from '../src/shared/research-contracts';

/**
 * Explicitly authorized LOCAL_SIMULATION of the C8 S3 package workflow.
 * Freeze a plan, generate exactly 100 synthetic rows, run the shipped analysis and check templates,
 * and admit the resulting bundle through the production pipeline. Stage reports are fixtures.
 * No Colab, provider, independent review or held-out evaluation is run. Stop at S7.
 */
async function main() {
  const t = { after: (_fn: unknown) => {} };
  const now = Date.now();
  const clock = () => new Date(now).toISOString();
  const policy = {
    minimumSamples: 30,
    minimumSliceSamples: 10,
    requiredSlices: [],
    requiredCostMultiples: [1, 1.5, 2],
  };
  const f = await fixture(t, undefined, false, {
    shadowPolicy: true,
    clock,
    metricsAndGates: DIAGNOSTIC_POLICY_PREFIX + JSON.stringify(policy),
  });
  // The restart step swaps in a reopened store; whichever instance is current must release the
  // SQLite file before the fixture's cleanup removes the workspace.
  const world = { store: f.store as OfficeStore, controller: f.controller as AssignmentController };
  t.after(() => {
    try {
      world.store.close();
    } catch {
      /* already closed */
    }
  });

  // The frozen request roster must name every appointed agent before the link binds it. Each stage
  // function goes to a distinct agent: a prepared assignment keeps its submission-intent job open
  // forever on the manual path (nothing is ever dispatched), and the store refuses one agent two
  // pieces of in-flight work on the same request.
  const third = f.makeAgent('Skeptic', clock());
  const fourth = f.makeAgent('Correctness reviewer', clock());
  const fifth = f.makeAgent('Assembler', clock());
  f.store.execute({
    type: 'request.update',
    idempotencyKey: key(),
    requestId: f.request.id,
    expectedRevision: f.request.revision,
    objective: f.request.objective,
    leadAgentId: f.principal.id,
    participantIds: [f.second.id, third.id, fourth.id, fifth.id],
    acceptanceCriteria: f.request.acceptanceCriteria,
  });
  const appointee = (stage: Stage, role: string) =>
    role === 'ADVOCATE'
      ? f.second
      : role === 'SKEPTIC'
        ? third
        : role === 'CORRECTNESS_REVIEWER'
          ? fourth
          : stage === 'S4'
            ? fifth
            : f.principal;
  for (const stage of STAGES)
    for (const role of STAGE_FUNCTIONS_REQUIRED[stage]) {
      f.store.appendFunctionAssignment({
        id: key(),
        projectId: f.project.id,
        stage,
        function: role,
        agentId: appointee(stage, role).id,
        agentRevision: 0,
        appendedAt: clock(),
        supersededById: null,
        origin: 'EXPLICIT',
        note: 'Manual pilot appointment',
      });
    }

  // Manual custody: sealed storage and the journal exist; no evaluator is wired into this process,
  // so the isolated route stays honestly closed and only the user-custody route can run.
  const custody = new HoldoutCustody(
    { sealedRoot: path.join(f.root, 'custody', 'sealed'), journalFile: path.join(f.root, 'custody', 'journal.jsonl') },
    {
      sealedStorageSupported: true,
      isolatedEvaluatorSupported: true,
      detail: 'Manual user custody only; no isolated evaluator is provisioned.',
    },
    null,
    clock,
  );

  const codec = createRunPackageCodec({ templatesDir: path.resolve('research-templates'), now: clock });
  const packages = { build: codec, inspect: codec };
  const runPython = (args: string[], cwd: string) => {
    const result = spawnSync('python', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const analysisScript = path.resolve('scripts/synthetic-analysis.py');
  runPython([analysisScript, 'generate', path.join(f.root, 'source')], f.root);
  const location = world.store.snapshot().locations!.find(item => item.projectId === f.project.id)!;
  world.store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: f.project.id,
    expectedRevision: location.revision,
    localFolder: path.join(f.root, 'source'),
    inputPaths: ['input.csv', 'check-config.json', 'planning-plan.json'],
    outputFolder: '',
  });
  const exportedFiles = new Map<string, Uint8Array>();
  const io: PipelineIO = {
    writeObject: f.io.writeObject,
    selectHoldout: async () => Buffer.from('rowId,target\nr1,0.5\n'),
    exportHoldout: async bytes => {
      exportedFiles.set('holdout', bytes);
    },
    exportPackage: async (bytes, packageId) => {
      exportedFiles.set(packageId, bytes);
      return null;
    },
  };

  // The service under test carries no research runtime: no signed harness, no provider-observed
  // isolated contexts. Custody is manual-only; the provider double is a routing fixture, never a
  // host.
  const stageInputs = (input: {
    projectId: string;
    requestId: string;
    requestRevision: number;
    objective: string;
  }): Promise<InputSnapshot> =>
    prepareInputSnapshot({
      store: world.store,
      objectRoot: f.root,
      stagingRoot: path.join(f.root, 'staging'),
      gitExecutable: 'qro-no-such-git',
      ...input,
    });
  const service = () =>
    new PipelineService(world.store, world.controller, custody, stageInputs, f.readObject, clock, null, io, packages);
  const state = () => world.store.snapshot();
  const branch = () => state().branches![0];
  const advance = () => service().run({ type: 'advance', branchId: branch().id, expectedRevision: branch().revision });
  const records = <K extends PipelineRecord['kind']>(kind: K) =>
    (state().pipeline ?? []).filter((r): r is Extract<PipelineRecord, { kind: K }> => r.kind === kind);
  const completion = (stage: Stage) => records('STAGE_COMPLETION').find(r => r.stage === stage)!;
  const receipt = (gate: string) => (state().receipts ?? []).find(r => r.gate === gate)!;

  const artifact = async (body: unknown, name = 'user-carried.json', mediaType = 'application/json') => {
    const object = await io.writeObject(
      body instanceof Uint8Array
        ? body
        : typeof body === 'string'
          ? Buffer.from(body)
          : Buffer.from(JSON.stringify(body)),
    );
    const id = randomUUID();
    world.store.addArtifact({
      id,
      projectId: f.project.id,
      experimentId: null,
      name,
      sha256: object.sha256,
      size: object.bytes,
      kind: 'RESULT',
      classification: 'USER_ATTESTED',
      status: 'QUARANTINED',
      createdAt: clock(),
      mediaType,
      note: 'User-carried pilot evidence',
    });
    return { id, sha256: object.sha256 };
  };

  // A stage report the user carried back, admitted against the exact assignment context. No
  // dispatch, no observe, no provider job: the OPEN attempt settles with USER_IMPORTED provenance.
  const stageReport = (a: Assignment, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      branchId: a.research!.branchId,
      specId: a.research!.specId,
      subjectHash: a.research!.subjectHash,
      stage: a.research!.stage,
      contextHash: a.research!.contextHash,
      gates: [],
      detail: 'LOCAL_SIMULATION stage report; no real provider or Colab execution.',
      ...extra,
    });
  const userStage = async (stage: Stage, extra: (a: Assignment) => Record<string, unknown> = () => ({})) => {
    assert.equal(branch().stage, stage, `the pilot must actually be at ${stage}`);
    const prepared = await service().run({
      type: 'prepare',
      branchId: branch().id,
      expectedRevision: branch().revision,
    });
    for (const a of prepared.assignments!) {
      const carried = await artifact(stageReport(a, extra(a)), `stage-${stage}-report.json`);
      await service().run({ type: 'importStageReport', assignmentId: a.id, artifactId: carried.id });
    }
    return prepared.assignments!;
  };

  // ---- S0: link the exact candidate; the office verifies the frozen prospective specification.
  await service().run({
    type: 'link',
    branchId: branch().id,
    expectedRevision: branch().revision,
    requestId: f.request.id,
    subjectHash: f.subjectHash,
  });
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
    verdict: 'SUPPORTS',
    defectFound: false,
    detail: 'LOCAL_SIMULATION: synthetic correctness assertions for application acceptance only.',
    gates: ['G-CORRECT', 'G-TIME', 'G-SPLIT', 'G-FIT', 'G-TARGET', 'G-SELECT', 'G-TRADETIME'].map(gate => ({
      gate,
      outcome: 'PASS',
      detail: `${gate} reviewed.`,
      rationale: 'LOCAL_SIMULATION assertion; no independent reviewer was run.',
    })),
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
  const exported = await service().run({
    type: 'exportRunPackage',
    branchId: branch().id,
    expectedRevision: branch().revision,
  });
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
  assert.ok(
    !(state().jobs ?? []).some(j => state().assignments?.find(a => a.id === j.assignmentId)?.research?.stage === 'S3'),
    'no execution job exists for the wait, before or after restart',
  );

  const runtime = path.join(f.root, 'simulated-runtime');
  mkdirSync(runtime);
  for (const [name, bytes] of Object.entries(unzipSync(exportedFiles.get(pkg.packageId)!))) {
    const target = path.join(runtime, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const computation = runPython([analysisScript, 'analyze', runtime], runtime);
  datasetManifestSchema.parse(JSON.parse(readFileSync(path.join(runtime, 'outputs/dataset-manifest.json'), 'utf8')));
  runPython(['launcher.v1.py'], runtime);
  const returnBytes = readFileSync(path.join(runtime, 'run-return.zip'));
  const members = unzipSync(returnBytes);
  const returnManifest = JSON.parse(strFromU8(members['return-manifest.json']));
  assert.equal(returnManifest.status, 'COMPLETED', returnManifest.detail);
  const metrics = JSON.parse(computation);
  const attempts: { kind: string; message: string; unchanged: boolean }[] = [];
  const importReturn = (artifactId: string) =>
    service().run({ type: 'importRunReturn', branchId: branch().id, expectedRevision: branch().revision, artifactId });
  for (const kind of ['wrong-package', 'incomplete', 'corrupt']) {
    const bad = { ...members };
    if (kind === 'wrong-package') {
      const manifest = { ...returnManifest, packageId: randomUUID(), packageHash: 'a'.repeat(64) };
      bad['return-manifest.json'] = strToU8(JSON.stringify(manifest));
    } else if (kind === 'incomplete') delete bad['outputs/diagnostics.json'];
    else {
      bad['outputs/diagnostics.json'] = Uint8Array.from(bad['outputs/diagnostics.json']);
      bad['outputs/diagnostics.json'][0] ^= 1;
    }
    const imported = await artifact(zipSync(bad), 'synthetic-' + kind + '.zip', 'application/zip');
    const before = world.store.snapshot().events!.length;
    let message = '';
    try {
      await importReturn(imported.id);
      assert.fail('bad return was admitted');
    } catch (error) {
      message = (error as Error).message;
    }
    assert.notEqual(message, 'bad return was admitted');
    if (kind === 'wrong-package') assert.match(message, /does not match|different package|wrong package/i);
    assert.equal(world.store.snapshot().events!.length, before);
    attempts.push({ kind, message, unchanged: true });
  }
  const returned = await artifact(returnBytes, 'synthetic-run-return.zip', 'application/zip');
  const admitted = await service().run({
    type: 'importRunReturn',
    branchId: branch().id,
    expectedRevision: branch().revision,
    artifactId: returned.id,
  });
  assert.match(admitted.detail, /Bound return admitted/);
  const runReturn = records('RUN_RETURN').at(-1)!;
  assert.equal(runReturn.kind, 'RUN_RETURN');
  assert.equal(runReturn.verification, 'USER_IMPORTED');
  const s3 = completion('S3');
  assert.equal(s3.provenance, 'USER_IMPORTED');
  assert.equal(s3.assignmentId, null);
  assert.equal(s3.jobId, null);
  assert.equal(receipt('G-ARTIFACT').provenance, 'OFFICE');
  for (const gate of ['G-PORTFOLIO', 'G-COST', 'G-ECON']) assert.equal(receipt(gate).provenance, 'USER_RUN');
  const repeatBefore = world.store.snapshot().events!.length;
  const repeat = await importReturn(returned.id);
  assert.equal(world.store.snapshot().events!.length, repeatBefore);
  attempts.push({ kind: 'identical-reimport', message: repeat.detail, unchanged: true });
  const conflict = {
    ...members,
    'return-manifest.json': strToU8(JSON.stringify({ ...returnManifest, runId: 'synthetic-conflicting-second-run' })),
  };
  const conflicting = await artifact(zipSync(conflict), 'synthetic-conflicting.zip', 'application/zip');
  const conflictBefore = world.store.snapshot().events!.length;
  let conflictMessage = '';
  try {
    await importReturn(conflicting.id);
    assert.fail('conflicting return was admitted');
  } catch (error) {
    conflictMessage = (error as Error).message;
  }
  assert.notEqual(conflictMessage, 'conflicting return was admitted');
  assert.equal(world.store.snapshot().events!.length, conflictBefore);
  attempts.push({ kind: 'duplicate-conflicting', message: conflictMessage, unchanged: true });
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

  const diagnostics = {
    ...JSON.parse(readFileSync(path.join(runtime, 'outputs/diagnostics.json'), 'utf8')),
    receiptHash: sha256(returnBytes),
  };
  assertForecastSeparateFromEconomics(diagnostics);
  const diagnosticVerdict = judgeDiagnostic(diagnostics, policy);
  assert.equal(diagnosticVerdict.adequate, true);
  const stress = {
    schemaVersion: 1,
    receiptHash: sha256(returnBytes),
    costMultiples: [1, 1.5, 2],
    note: 'LOCAL_SIMULATION',
    scenarios: metrics.stress.map((item: { multiple: number; netReturn: number; maxDrawdown: number }) => ({
      name: item.multiple + 'x costs',
      perturbation: 'variable trading costs',
      magnitude: item.multiple,
      netReturn: item.netReturn,
      maxDrawdown: item.maxDrawdown,
      samples: 40,
    })),
  };
  const stressVerdict = judgeStress(stress, policy);
  assert.equal(stressVerdict.adequate, true);
  const output = path.resolve(process.argv[2] || path.join(f.root, 'evidence'));
  mkdirSync(output, { recursive: true });
  const summary = {
    provenance: 'LOCAL_SIMULATION',
    colabUsed: false,
    independentReviewRun: false,
    planning: 'S0 frozen specification, S1 prepared/imported synthetic plan, S2 simulated correctness context',
    analysis:
      'Actual OLS fit on 50 synthetic training rows, 10-row purge, 40-row evaluation, portfolio and cost stress',
    sourceRows: 100,
    endStage: branch().stage,
    metrics,
    diagnosticVerdict,
    stressVerdict,
    durableWaitAfterRestart: true,
    attempts,
    packageId: pkg.packageId,
    packageHash: pkg.packageHash,
    returnSha256: sha256(returnBytes),
    providerSubmissions: f.adapter.submissions.length,
    fixtureRoster: state().agents.map(agent => ({
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      effort: agent.effort,
      execution: 'NOT_RUN_SYNTHETIC_CONTEXT',
    })),
    realColabAcceptance: 'NOT_COMPLETED: user explicitly requested simulation',
    conclusion: 'Synthetic application acceptance only. No provider, independent review, real-market or Colab claim.',
  };
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(output, 'input.csv'), readFileSync(path.join(f.root, 'source/input.csv')));
  writeFileSync(path.join(output, 'planning-plan.json'), readFileSync(path.join(f.root, 'source/planning-plan.json')));
  writeFileSync(path.join(output, 'run-package.zip'), exportedFiles.get(pkg.packageId)!);
  writeFileSync(path.join(output, 'run-return.zip'), returnBytes);
  cpSync(path.join(runtime, 'outputs'), path.join(output, 'outputs'), { recursive: true });
  world.store.close();
  cpSync(path.join(f.root, 'workspace.sqlite'), path.join(output, 'workspace.sqlite'));
  console.log(JSON.stringify({ output, ...summary }, null, 2));
}
await main();
