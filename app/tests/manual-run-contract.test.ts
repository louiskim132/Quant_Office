import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import { AssignmentController } from '../src/main/controller';
import { PipelineService } from '../src/main/pipeline';
import { fixture, completeS1, key, at, sha256, declared } from './fixtures/pipeline';
import { researchFixture } from './fixtures/research-workflow';
import {
  runPackageHash,
  runPackageId,
  runReturnManifestSchema,
  type RunPackageManifest,
  type RunReturnManifest,
} from '../src/shared/run-package';
import type { BranchLink } from '../src/shared/pipeline';
import type { AppState } from '../src/shared/types';
import type { FrozenResearchSpec, ResearchBranch } from '../src/shared/research';

/**
 * The C8 manual-run contract (roadmap section 1.6): export a frozen package, wait durably, import a
 * bound return, and let its evidence flow through the office stages under its own provenance labels.
 * The package seam here is a JSON-envelope test double — the production zip codec is a separate
 * worker packet; what is under test is the store/pipeline admission contract the codec serves.
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

const USER_RUN_GATES = [
  { gate: 'G-PORTFOLIO', stage: 'S5', outcome: 'PASS', detail: 'Portfolio gate passed.', rationale: 'user run' },
  { gate: 'G-COST', stage: 'S6', outcome: 'PASS', detail: 'Cost gate passed.', rationale: 'user run' },
  { gate: 'G-ECON', stage: 'S6', outcome: 'PASS', detail: 'Economics gate passed.', rationale: 'user run' },
] as const;

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
    gates: [...USER_RUN_GATES],
    failedRuns: [],
    detail: 'Synthetic user-run return.',
    ...overrides,
  };
}

/** Drive the base fixture to S3 through the separated (runtime-free) review tier. */
async function manualToS3(t: TestContext, options: Parameters<typeof fixture>[3] = {}) {
  const f = await fixture(t, undefined, true, options);
  const service = () =>
    new PipelineService(f.store, f.controller, null, f.stageInputs, f.readObject, f.clock, null, f.io, packages);
  await f.linked();
  f.store.recordResearchGates({
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
    receipts: [
      {
        id: key(),
        branchId: f.branch().id,
        stage: 'S0',
        gate: 'G-SPEC',
        outcome: 'PASS',
        subjectHash: f.subjectHash,
        specId: f.specId(),
        detail: 'Frozen spec',
        rationale: 'Office verification',
        evidenceRef: f.store.snapshot().specs![0].contentHash,
        createdAt: at(3),
      },
    ],
  });
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  await completeS1(f);
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  f.store.appendFunctionAssignment({
    id: key(),
    projectId: f.project.id,
    stage: 'S2',
    function: 'CORRECTNESS_REVIEWER',
    agentId: f.second.id,
    agentRevision: 0,
    appendedAt: at(3),
    supersededById: null,
    origin: 'EXPLICIT',
    note: 'Reviewer',
  });
  const prepared = await service().run({
    type: 'prepare',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
  });
  const reviewer = prepared.assignments![0];
  f.adapter.behaviour.observe = async job => {
    const c = f.store.snapshot().assignments!.find(a => a.id === job.assignmentId)!.research!;
    return {
      state: 'COMPLETED' as const,
      detail: 'Review delivered.',
      outputs: [
        declared(
          JSON.stringify({
            schemaVersion: 1,
            branchId: c.branchId,
            specId: c.specId,
            subjectHash: c.subjectHash,
            stage: c.stage,
            contextHash: c.contextHash,
            gates: ['G-CORRECT', 'G-TIME', 'G-SPLIT', 'G-FIT', 'G-TARGET', 'G-SELECT', 'G-TRADETIME'].map(gate => ({
              gate,
              outcome: 'PASS',
              detail: gate + ' reviewed.',
              rationale: 'separated review',
            })),
            verdict: 'SUPPORTS',
            defectFound: false,
            detail: 'Separated S2 review complete.',
          }),
        ),
      ],
    };
  };
  await f.controller.dispatch(reviewer.id);
  await f.controller.observe(reviewer.id);
  await service().run({ type: 'collect', assignmentId: reviewer.id });
  const report = f.store.snapshot().pipeline!.find(r => r.kind === 'REVIEW_REPORT' && r.stage === 'S2')!;
  assert.equal(report.kind, 'REVIEW_REPORT');
  assert.equal(
    report.independence,
    'SEPARATE_SESSION_UNVERIFIED',
    'a separated-round report is labelled, never promoted',
  );
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(f.branch().stage, 'S3');
  return { f, service };
}

test('export enters a durable user wait that survives restart, and the bound return completes S3 with user-run provenance', async t => {
  const { f, service } = await manualToS3(t);
  const exported = await service().run({
    type: 'exportRunPackage',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
  });
  assert.match(exported.detail, /waiting|manual user run/i);
  const pkg = f.store.snapshot().pipeline!.find(r => r.kind === 'RUN_PACKAGE')!;
  assert.equal(pkg.kind, 'RUN_PACKAGE');
  assert.equal(pkg.state, 'AWAITING_RETURN');
  const wait = f.store.snapshot().attempts!.find(a => a.stage === 'S3')!;
  assert.equal(wait.state, 'OPEN');
  assert.equal(wait.assignmentId, null, 'no execution job exists while the user runs the package');

  const again = await service().run({
    type: 'exportRunPackage',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
  });
  assert.match(again.detail, /already exported/);
  assert.equal(
    f.store.snapshot().pipeline!.filter(r => r.kind === 'RUN_PACKAGE').length,
    1,
    're-export of identical content is idempotent, not a new package',
  );

  // Restart between export and return: the wait, the package identity and the open attempt persist.
  const tip = f.store.lineageTip();
  f.store.close();
  const reopened = new OfficeStore(path.join(f.root, 'workspace.sqlite'));
  try {
    const rpkg = reopened.snapshot().pipeline!.find(r => r.kind === 'RUN_PACKAGE')!;
    assert.equal(rpkg.kind, 'RUN_PACKAGE');
    assert.equal(rpkg.state, 'AWAITING_RETURN');
    assert.deepEqual(reopened.lineageTip(), tip, 'restart changes no lineage history');
    assert.equal(reopened.snapshot().attempts!.find(a => a.stage === 'S3')!.state, 'OPEN');

    const controller = new AssignmentController(
      reopened,
      f.adapter,
      () => at(20),
      async () => [],
    );
    const restarted = new PipelineService(
      reopened,
      controller,
      null,
      f.stageInputs,
      f.readObject,
      () => at(20),
      null,
      f.io,
      packages,
    );
    const artifactId = await artifact(f, returnManifest(pkg), reopened);
    const admitted = await restarted.run({
      type: 'importRunReturn',
      branchId: pkg.branchId,
      expectedRevision: pkg.branchRevision,
      artifactId,
    });
    assert.match(admitted.detail, /Bound return admitted/);
    const state = reopened.snapshot();
    const ret = state.pipeline!.find(r => r.kind === 'RUN_RETURN')!;
    assert.equal(ret.kind, 'RUN_RETURN');
    assert.equal(ret.verification, 'USER_IMPORTED');
    const completion = state.pipeline!.find(r => r.kind === 'STAGE_COMPLETION' && r.stage === 'S3')!;
    assert.equal(completion.kind, 'STAGE_COMPLETION');
    assert.equal(completion.provenance, 'USER_IMPORTED');
    assert.equal(completion.assignmentId, null);
    for (const gate of ['G-PORTFOLIO', 'G-COST', 'G-ECON'])
      assert.equal(
        state.receipts!.find(r => r.gate === gate)!.provenance,
        'USER_RUN',
        'user-run gates keep their own label',
      );
    assert.equal(
      state.receipts!.find(r => r.gate === 'G-ARTIFACT')!.provenance,
      'OFFICE',
      'the transfer check is office work, not user evidence',
    );
    await restarted.run({ type: 'advance', branchId: pkg.branchId, expectedRevision: pkg.branchRevision });
    assert.equal(reopened.snapshot().branches![0].stage, 'S4');
  } finally {
    reopened.close();
  }
});

test('wrong-package, corrupt, undeclared, incomplete and conflicting returns are each refused at their own check', async t => {
  const { f, service } = await manualToS3(t);
  await service().run({ type: 'exportRunPackage', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const pkg = f.store.snapshot().pipeline!.find(r => r.kind === 'RUN_PACKAGE')!;
  assert.equal(pkg.kind, 'RUN_PACKAGE');
  const args = { branchId: f.branch().id, expectedRevision: f.branch().revision };

  // Wrong package identity: the manifest names a package this branch never exported.
  const wrong = await artifact(f, returnManifest(pkg, { packageId: randomUUID() }));
  await assert.rejects(service().run({ type: 'importRunReturn', ...args, artifactId: wrong }), /different package/);

  // Corrupt bytes: the artifact's stored identity does not match what was registered.
  const corrupt = randomUUID();
  f.store.addArtifact({
    id: corrupt,
    projectId: f.project.id,
    experimentId: null,
    name: 'return.zip',
    sha256: '0'.repeat(64),
    size: 10,
    kind: 'RESULT',
    classification: 'USER_ATTESTED',
    status: 'QUARANTINED',
    createdAt: at(12),
    mediaType: 'application/zip',
    note: '',
  });
  await assert.rejects(
    service().run({ type: 'importRunReturn', ...args, artifactId: corrupt }),
    /identity mismatch|unavailable/,
  );

  // A return naming the right package but the wrong subject is refused at the store's own binding.
  const wrongSubject = await artifact(f, returnManifest(pkg, { subjectHash: sha256('a different candidate') }));
  await assert.rejects(
    service().run({ type: 'importRunReturn', ...args, artifactId: wrongSubject }),
    /different package, subject or specification/,
  );

  // Undeclared files and missing required files are each refused.
  const extra = await artifact(
    f,
    returnManifest(pkg, {
      artifacts: [
        { path: 'result.json', sha256: sha256('synthetic-result'), bytes: 16 },
        { path: 'smuggled.bin', sha256: sha256('smuggled'), bytes: 8 },
      ],
    }),
  );
  await assert.rejects(service().run({ type: 'importRunReturn', ...args, artifactId: extra }), /did not declare/);
  const missing = await artifact(f, returnManifest(pkg, { artifacts: [] }));
  await assert.rejects(
    service().run({ type: 'importRunReturn', ...args, artifactId: missing }),
    /missing expected file/,
  );
  const gateless = await artifact(f, returnManifest(pkg, { gates: [] }));
  await assert.rejects(service().run({ type: 'importRunReturn', ...args, artifactId: gateless }), /required gate/);

  // A valid return admits; the identical bundle re-imported is idempotent; a different manifest
  // claiming the same package is a conflict nobody may resolve by picking a side.
  const good = await artifact(f, returnManifest(pkg));
  await service().run({ type: 'importRunReturn', ...args, artifactId: good });
  const events = f.store.snapshot().events;
  await service().run({ type: 'importRunReturn', ...args, artifactId: good });
  assert.deepEqual(f.store.snapshot().events, events, 'the identical return re-imports without new history');
  const conflicting = await artifact(f, returnManifest(pkg, { detail: 'A second, different run.' }));
  await assert.rejects(
    service().run({ type: 'importRunReturn', ...args, artifactId: conflicting }),
    /conflicting returns are rejected/,
  );
});

test('a failed-execution return is preserved as evidence and does not complete the stage', async t => {
  const { f, service } = await manualToS3(t);
  await service().run({ type: 'exportRunPackage', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const pkg = f.store.snapshot().pipeline!.find(r => r.kind === 'RUN_PACKAGE')!;
  assert.equal(pkg.kind, 'RUN_PACKAGE');
  const failed = await artifact(
    f,
    returnManifest(pkg, {
      status: 'EXECUTION_FAILED',
      artifacts: [],
      gates: [],
      failedRuns: [{ reason: 'Colab runtime crashed during fit.', failedAt: at(11) }],
      detail: 'The run failed honestly.',
    }),
  );
  await service().run({
    type: 'importRunReturn',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
    artifactId: failed,
  });
  const state = f.store.snapshot();
  const ret = state.pipeline!.find(r => r.kind === 'RUN_RETURN')!;
  assert.equal(ret.kind, 'RUN_RETURN');
  assert.equal(ret.status, 'EXECUTION_FAILED', 'the failed run is durably preserved, not silently dropped');
  assert.equal(
    state.pipeline!.some(r => r.kind === 'STAGE_COMPLETION' && r.stage === 'S3'),
    false,
    'a failed run never completes the stage',
  );
  await assert.rejects(
    service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision }),
    /stage report|completion/i,
  );
});

test('a spec-declared signed-harness gate cannot be satisfied by user-run evidence', async t => {
  const { f, service } = await manualToS3(t, { gateEvidence: [{ gate: 'G-PORTFOLIO', tier: 'SIGNED_HARNESS' }] });
  await service().run({ type: 'exportRunPackage', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const pkg = f.store.snapshot().pipeline!.find(r => r.kind === 'RUN_PACKAGE')!;
  assert.equal(pkg.kind, 'RUN_PACKAGE');
  const good = await artifact(f, returnManifest(pkg));
  await service().run({
    type: 'importRunReturn',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
    artifactId: good,
  });
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  // S4 is agent work: the analysis stage still runs through the ordinary assignment path.
  f.store.appendFunctionAssignment({
    id: key(),
    projectId: f.project.id,
    stage: 'S4',
    function: 'PRINCIPAL',
    agentId: f.principal.id,
    agentRevision: 0,
    appendedAt: at(13),
    supersededById: null,
    origin: 'EXPLICIT',
    note: 'S4 analyst',
  });
  f.adapter.behaviour.observe = async job => {
    const c = f.store.snapshot().assignments!.find(a => a.id === job.assignmentId)!.research!;
    return {
      state: 'COMPLETED' as const,
      detail: 'Analysis delivered.',
      outputs: [
        declared(
          JSON.stringify({
            schemaVersion: 1,
            branchId: c.branchId,
            specId: c.specId,
            subjectHash: c.subjectHash,
            stage: c.stage,
            contextHash: c.contextHash,
            gates: [],
            detail: 'S4 analysis complete.',
          }),
        ),
      ],
    };
  };
  const s4 = await service().run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  await f.controller.dispatch(s4.assignments![0].id);
  await f.controller.observe(s4.assignments![0].id);
  await service().run({ type: 'collect', assignmentId: s4.assignments![0].id });
  await service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(f.branch().stage, 'S5');
  // The office validation admits the bound evidence; promotion still reports the missing tier
  // at exactly the gate the frozen specification declared.
  await service().run({ type: 'validateReturn', branchId: f.branch().id, expectedRevision: f.branch().revision });
  await assert.rejects(
    service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision }),
    /signed-harness/,
    'the declared gate reports its missing tier at the exact gate that requires it',
  );
});

test('the complete manual pilot reaches S7 review through user-run evidence alone', async t => {
  const f = await researchFixture(t);
  await f.through('S7');
  const state = f.store.snapshot();
  assert.equal(f.branch().stage, 'S7');
  const ret = state.pipeline!.find(r => r.kind === 'RUN_RETURN')!;
  assert.equal(ret.kind, 'RUN_RETURN');
  assert.equal(ret.verification, 'USER_IMPORTED');
  for (const stage of ['S3', 'S5', 'S6'] as const) {
    const completion = state.pipeline!.find(r => r.kind === 'STAGE_COMPLETION' && r.stage === stage)!;
    assert.equal(completion.kind, 'STAGE_COMPLETION');
    assert.equal(completion.assignmentId, null, stage + ' completed with no agent or execution job');
  }
  assert.equal(state.pipeline!.filter(r => r.kind === 'RUN_PACKAGE').length, 1);
});

/** Register imported return bytes as a quarantined project artifact, exactly as the UI import does. */
async function artifact(
  f: Awaited<ReturnType<typeof manualToS3>>['f'] | Awaited<ReturnType<typeof researchFixture>>,
  body: unknown,
  store: OfficeStore = f.store,
): Promise<string> {
  const object = await f.io.writeObject(Buffer.from(JSON.stringify(body)));
  const id = randomUUID();
  store.addArtifact({
    id,
    projectId: f.project.id,
    experimentId: null,
    name: 'return.zip',
    sha256: object.sha256,
    size: object.bytes,
    kind: 'RESULT',
    classification: 'USER_ATTESTED',
    status: 'QUARANTINED',
    createdAt: at(12),
    mediaType: 'application/zip',
    note: 'Synthetic returned bundle',
  });
  return id;
}
