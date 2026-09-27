import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../src/core/store';
import {
  AssignmentController,
  type ObserveResult,
  type ProviderAdapter,
  type SubmitContext,
  type SubmitResult,
} from '../src/main/controller';
import { PipelineService } from '../src/main/pipeline';
import { OutputService } from '../src/main/outputs';
import { prepareInputSnapshot, snapshotObjectPath } from '../src/main/locations';
import { HoldoutCustody } from '../src/main/holdout';
import { TerminalHandoffAdapter } from '../src/main/handoff';
import { stageContextHash, stageReportSchema, type StageContext } from '../src/shared/pipeline';
import type { Agent, CapabilityEvidence, CapabilityOperation, InputSnapshot, ProviderJob } from '../src/shared/types';

import { fixture, completeS1, key, at, sha256, declared, SECTIONS } from './fixtures/pipeline';
import { promotable } from '../src/main/research-controller';

test('a link must name a trial the ledger actually registered for this branch', async t => {
  const f = await fixture(t);
  const unregistered = sha256('never tried');
  await assert.rejects(
    f.service().run({
      type: 'link',
      branchId: f.branch().id,
      requestId: f.request.id,
      subjectHash: unregistered,
      expectedRevision: f.branch().revision,
    }),
    /registered trial/,
    'receipts may only accumulate for an identity the lineage admitted it tried',
  );
});

test('a link against a stale branch revision is refused rather than rebound silently', async t => {
  const f = await fixture(t);
  await assert.rejects(
    f.service().run({
      type: 'link',
      branchId: f.branch().id,
      requestId: f.request.id,
      subjectHash: f.subjectHash,
      expectedRevision: f.branch().revision + 9,
    }),
    /changed in another view/,
  );
});

test('stage work cannot be prepared before the branch is linked to an exact request and subject', async t => {
  const f = await fixture(t);
  await assert.rejects(
    f.service().run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision }),
    /Link this branch/,
  );
});

test('a stage with no appointed function reports its blocker instead of preparing work', async t => {
  const f = await fixture(t, undefined, false);
  await f.linked();
  await assert.rejects(
    f.service().run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision }),
    /No profile is assigned/,
  );
  assert.equal(f.store.snapshot().assignments?.length ?? 0, 0, 'a blocked stage creates no work');
});

test('prepare freezes the link, the stage and the snapshot into each assignment', async t => {
  const f = await fixture(t);
  await f.linked();
  const result = await f
    .service()
    .run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(result.assignments!.length, 1, 'S0 needs exactly the principal');
  const research = result.assignments![0].research!;
  assert.equal(research.branchId, f.branch().id);
  assert.equal(research.branchRevision, f.branch().revision);
  assert.equal(research.specId, f.specId());
  assert.equal(research.subjectHash, f.subjectHash);
  assert.equal(research.stage, 'S0');
  assert.equal(research.function, 'PRINCIPAL');
  assert.equal(research.requestRevision, f.request.revision);
  assert.equal(research.outputSchema, 'research-stage-report@1');
  assert.equal(
    research.contextHash,
    stageContextHash({
      branchId: f.branch().id,
      specId: f.specId(),
      subjectHash: f.subjectHash,
      stage: 'S0',
      function: 'PRINCIPAL',
      agentId: f.principal.id,
      agentRevision: 0,
      outputSchema: 'research-stage-report@1',
      inputs: research,
    }),
    'the recorded context hash is the shared identity, not a second definition',
  );
  const snapshot = result.state.snapshots!.find(item => item.id === result.assignments![0].snapshotId)!;
  assert.deepEqual(
    [...research.objectHashes].sort(),
    [...snapshot.files, ...snapshot.generated!].map(file => file.sha256).sort(),
    'the evidence scope is exactly the prepared input inventory',
  );
  const job = result.state.jobs!.find(item => item.assignmentId === result.assignments![0].id)!;
  assert.equal(job.state, 'INTENT', 'preparation records intent; nothing was dispatched');
});

test('a request edited after linking stops stage preparation until the branch is relinked', async t => {
  const f = await fixture(t);
  await f.linked();
  f.store.execute({
    type: 'request.update',
    idempotencyKey: key(),
    requestId: f.request.id,
    expectedRevision: f.request.revision,
    objective: 'changed objective',
    leadAgentId: f.principal.id,
    participantIds: [f.second.id],
    acceptanceCriteria: '',
  });
  await assert.rejects(
    f.service().run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision }),
    /linked request changed/,
  );
});

test('a caller cannot name a subject, stage or context the ledger did not freeze', async t => {
  const f = await fixture(t);
  await f.linked();
  const snapshot = await prepareInputSnapshot({
    store: f.store,
    objectRoot: f.root,
    stagingRoot: path.join(f.root, 'staging'),
    gitExecutable: 'qro-no-such-git',
    projectId: f.project.id,
    requestId: f.request.id,
    requestRevision: f.request.revision,
  });
  const objectHashes = [...snapshot.files, ...snapshot.generated!].map(file => file.sha256);
  const base: StageContext = {
    branchId: f.branch().id,
    branchRevision: f.branch().revision,
    specId: f.specId(),
    subjectHash: f.subjectHash,
    stage: 'S0',
    function: 'PRINCIPAL',
    contextHash: stageContextHash({
      branchId: f.branch().id,
      specId: f.specId(),
      subjectHash: f.subjectHash,
      stage: 'S0',
      function: 'PRINCIPAL',
      agentId: f.principal.id,
      agentRevision: 0,
      outputSchema: 'research-stage-report@1',
      inputs: { branchRevision: f.branch().revision, requestRevision: f.request.revision, objectHashes },
    }),
    outputSchema: 'research-stage-report@1',
    objectHashes,
    requestRevision: f.request.revision,
  };
  const prepare = (research: StageContext, agentId = f.principal.id) =>
    f.controller.prepare({ requestId: f.request.id, agentId, snapshotId: snapshot.id, research });

  assert.throws(
    () => prepare({ ...base, contextHash: stageContextHash({ ...base, agentId: f.principal.id, agentRevision: 0 }) }),
    /context identity/,
  );
  assert.throws(() => prepare({ ...base, subjectHash: sha256('other candidate') }), /exact linked request and subject/);
  assert.throws(() => prepare({ ...base, stage: 'S1' }), /branch moved/);
  assert.throws(
    () =>
      prepare({
        ...base,
        contextHash: stageContextHash({
          branchId: f.branch().id,
          specId: f.specId(),
          subjectHash: f.subjectHash,
          stage: 'S0',
          function: 'DIRECTOR',
          agentId: f.principal.id,
          agentRevision: 0,
          outputSchema: 'research-stage-report@1',
        }),
      }),
    /context identity does not match/,
    'a hash computed for a different function is not this context',
  );
  const changed = { ...base, objectHashes: objectHashes.slice(1) };
  assert.throws(
    () =>
      prepare({
        ...changed,
        contextHash: stageContextHash({ ...changed, agentId: f.principal.id, agentRevision: 0, inputs: changed }),
      }),
    /exactly the prepared input objects/,
  );
  assert.throws(
    () => prepare(base, f.second.id),
    /does not hold the named stage function/,
    'a listed participant without the appointment cannot take stage work',
  );
});

test('a report is collectable only once the provider reports completion with stored bytes', async t => {
  const f = await fixture(t);
  await f.linked();
  const prepared = await f
    .service()
    .run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const assignment = prepared.assignments![0];
  await assert.rejects(
    f.service().run({ type: 'collect', assignmentId: assignment.id }),
    /provider reported/,
    'an intent is not evidence, whatever it was prepared to do',
  );
});

test('a completed stage report retains exact-subject evidence, but only the office specification check permits advancement', async t => {
  let contextHash = '';
  const f = await fixture(t, async () => ({
    state: 'COMPLETED' as const,
    detail: 'Stage report delivered.',
    outputs: [
      declared(
        JSON.stringify({
          schemaVersion: 1,
          branchId: f.branch().id,
          specId: f.specId(),
          subjectHash: f.subjectHash,
          stage: 'S0',
          contextHash,
          gates: [
            {
              gate: 'G-SPEC',
              outcome: 'PASS',
              detail: 'All seven sections frozen.',
              rationale: 'Specification frozen before evaluation.',
            },
          ],
          detail: 'S0 complete.',
        }),
      ),
    ],
  }));
  await f.linked();
  const prepared = await f
    .service()
    .run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const assignment = prepared.assignments![0];
  contextHash = assignment.research!.contextHash;

  await f.controller.dispatch(assignment.id);
  const observed = await f.controller.observe(assignment.id);
  const job = observed.jobs!.find(item => item.assignmentId === assignment.id)!;
  assert.equal(job.state, 'COMPLETED');
  assert.equal(job.outputs[0].stored, true, 'the report bytes are durably stored before they are evidence');

  const collected = await f.service().run({ type: 'collect', assignmentId: assignment.id });
  const receipt = collected.state.receipts!.find(item => item.branchId === f.branch().id)!;
  assert.equal(receipt.gate, 'G-SPEC');
  assert.equal(
    receipt.outcome,
    'PASS',
    'outcomes are recorded verbatim — the tier lives in provenance, not a rewritten outcome',
  );
  assert.equal(receipt.provenance, 'REVIEWER_ASSERTED');
  assert.equal(receipt.subjectHash, f.subjectHash, 'the receipt belongs to this subject and no other');
  assert.equal(receipt.specId, f.specId());
  assert.equal(receipt.evidenceRef, job.outputs[0].sha256, 'the receipt names the bytes it was earned from');

  await assert.rejects(
    f.service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision }),
    /office-verified/,
  );
  recordSpecGate(f);
  const advanced = await f
    .service()
    .run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(advanced.state.branches![0].stage, 'S1');
});

test('a stage report written for a different context is not this stage\u2019s evidence', async t => {
  const wrong = sha256('a different context');
  const f = await fixture(t, async () => ({
    state: 'COMPLETED' as const,
    detail: 'Done.',
    outputs: [
      declared(
        JSON.stringify({
          schemaVersion: 1,
          branchId: f.branch().id,
          specId: f.specId(),
          subjectHash: f.subjectHash,
          stage: 'S0',
          contextHash: wrong,
          gates: [{ gate: 'G-SPEC', outcome: 'PASS', detail: 'd', rationale: 'r' }],
          detail: 'Done.',
        }),
      ),
    ],
  }));
  await f.linked();
  const prepared = await f
    .service()
    .run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const assignment = prepared.assignments![0];
  await f.controller.dispatch(assignment.id);
  await f.controller.observe(assignment.id);
  await assert.rejects(f.service().run({ type: 'collect', assignmentId: assignment.id }), /exact stage context/);
  assert.equal(
    (f.store.snapshot().receipts ?? []).length,
    0,
    'no receipt was written for work the context does not identify',
  );
});

test('work prepared for one stage cannot be dispatched after the branch has moved on', async t => {
  const f = await fixture(t);
  await f.linked();
  const prepared = await f
    .service()
    .run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const assignment = prepared.assignments![0];
  // G-SPEC may be recorded by the office itself at S0, without a completed assignment.
  f.store.recordResearchGates({
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
    receipts: [
      {
        id: randomUUID(),
        branchId: f.branch().id,
        stage: 'S0',
        gate: 'G-SPEC',
        outcome: 'PASS',
        subjectHash: f.subjectHash,
        specId: f.specId(),
        detail: 'frozen',
        rationale: 'frozen before evaluation',
        evidenceRef: f.store.snapshot().specs![0].contentHash,
        createdAt: at(3),
      },
    ],
  });
  await f.service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(f.branch().stage, 'S1');
  await assert.rejects(
    f.controller.dispatch(assignment.id),
    /branch moved/,
    'a context frozen against S0 describes work nobody is waiting for once the branch is at S1',
  );
});

test('adjudication belongs to S7 and nowhere else', async t => {
  const f = await fixture(t);
  await f.linked();
  await assert.rejects(
    f
      .service()
      .run({ type: 'adjudicate', branchId: f.branch().id, expectedRevision: f.branch().revision, followUp: false }),
    /belongs to S7/,
  );
});

test('a holdout reservation needs custody and cannot be requested before S8', async t => {
  const f = await fixture(t);
  await f.linked();
  await assert.rejects(
    f
      .service()
      .run({ type: 'holdoutReserve', branchId: f.branch().id, holdoutId: randomUUID(), refitHash: sha256('refit') }),
    /No holdout custody/,
    'a build without verified custody refuses rather than improvising it',
  );

  const custody = new HoldoutCustody(
    { sealedRoot: path.join(f.root, 'sealed'), journalFile: path.join(f.root, 'journal.jsonl') },
    { sealedStorageSupported: true, isolatedEvaluatorSupported: true, detail: 'fixture custody' },
    null,
    () => at(4),
  );
  await assert.rejects(
    f
      .service(custody)
      .run({ type: 'holdoutReserve', branchId: f.branch().id, holdoutId: randomUUID(), refitHash: sha256('refit') }),
    /belongs to S8/,
    'configured custody cannot bypass stage admission',
  );
});

test('shadow thresholds are set before the specification freezes, never after', async t => {
  const f = await fixture(t);
  const policy = {
    minimumSamples: 5,
    maximumMissingShare: 0.2,
    retireBelowMetric: -1,
    qualifyAtOrAboveMetric: 1,
    driftAlarmMetric: 2,
    killBelowMetric: -3,
  };
  // The fixture froze its spec already; drafting a second branch leaves a live draft to set thresholds on.
  f.store.execute({
    type: 'research.draftSpec',
    idempotencyKey: key(),
    projectId: f.project.id,
    name: 'Lineage B',
    sections: SECTIONS,
    thresholds: [],
    notApplicable: [],
    maxSelectionTrials: 4,
  });
  const draft = f.store.snapshot().branches!.find(item => item.name === 'Lineage B')!;
  const recorded = await f
    .service()
    .run({ type: 'shadowPolicy', branchId: draft.id, expectedRevision: draft.revision, policy });
  const record = recorded.state.pipeline!.find(item => item.kind === 'SHADOW_POLICY')!;
  assert.equal(record.kind === 'SHADOW_POLICY' && record.specId, draft.specId);

  await assert.rejects(
    f.service().run({ type: 'shadowPolicy', branchId: f.branch().id, expectedRevision: f.branch().revision, policy }),
    /before freezing/,
    'a frozen specification cannot grow thresholds it did not commit to',
  );
});

const recordSpecGate = (f: Awaited<ReturnType<typeof fixture>>) =>
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
        rationale: 'Prospective fixture',
        evidenceRef: f.store.snapshot().specs![0].contentHash,
        createdAt: at(3),
      },
    ],
  });

async function completedReport(
  t: TestContext,
  gates: unknown[] = [{ gate: 'G-SPEC', outcome: 'PASS', detail: 'Provider claim', rationale: '' }],
) {
  const f = await fixture(t, async job => {
    const context = f.store.snapshot().assignments!.find(a => a.id === job.assignmentId)!.research!;
    return {
      state: 'COMPLETED',
      detail: 'Delivered',
      outputs: [
        declared(
          JSON.stringify({
            schemaVersion: 1,
            branchId: context.branchId,
            specId: context.specId,
            subjectHash: context.subjectHash,
            stage: context.stage,
            contextHash: context.contextHash,
            gates,
            detail: 'Unverified report',
          }),
        ),
      ],
    };
  });
  await f.linked();
  const prepared = await f
    .service()
    .run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const assignment = prepared.assignments![0];
  await f.controller.dispatch(assignment.id);
  await f.controller.observe(assignment.id);
  return { ...f, assignment };
}

test('research context identity changes with input bytes and frozen revisions', () => {
  const input = {
    branchId: key(),
    specId: key(),
    subjectHash: sha256('candidate'),
    stage: 'S0' as const,
    function: 'PRINCIPAL' as const,
    agentId: key(),
    agentRevision: 0,
    outputSchema: 'research-stage-report@1',
    inputs: { branchRevision: 1, requestRevision: 2, objectHashes: [sha256('a'), sha256('b')] },
  };
  for (const inputs of [
    { ...input.inputs, branchRevision: 2 },
    { ...input.inputs, requestRevision: 3 },
    { ...input.inputs, objectHashes: [sha256('changed')] },
  ])
    assert.notEqual(stageContextHash({ ...input, inputs }), stageContextHash(input));
  assert.equal(
    stageContextHash({ ...input, inputs: { ...input.inputs, objectHashes: [...input.inputs.objectHashes].reverse() } }),
    stageContextHash(input),
  );
});

test('the submitted payload carries the exact research context and frozen specification', async t => {
  const f = await completedReport(t);
  const payload = f.adapter.submissions[0].payload;
  assert.deepEqual(
    JSON.parse(payload.text.split('## Research stage context\n')[1].split('\n\n')[0]),
    f.assignment.research,
    'context must reach the provider, not just the local assignment',
  );
  assert.deepEqual(
    JSON.parse(payload.text.split('## Frozen research specification\n')[1].split('\n\n')[0]),
    f.store.snapshot().specs![0],
    'the specification must be delivered, not just its ID',
  );
  assert.match(payload.text, /research-stage-report@1/);
});

test('provider-written PASS is stored verbatim as reviewer-asserted and cannot authorize advancement', async t => {
  const f = await completedReport(t);
  await f.service().run({ type: 'collect', assignmentId: f.assignment.id });
  const receipts = f.store.snapshot().receipts!;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].outcome, 'PASS');
  assert.equal(
    receipts[0].provenance,
    'REVIEWER_ASSERTED',
    'the claim is kept, labelled as what it is — never rewritten and never promoted',
  );
  await assert.rejects(
    f.service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision }),
    /office-verified/,
  );
});

test('gate storage keeps provider claims verbatim and still requires frozen NOT_APPLICABLE declarations', async t => {
  const f = await completedReport(t);
  f.store.recordResearchGates({
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
    assignmentId: f.assignment.id,
    receipts: [
      {
        id: key(),
        branchId: f.branch().id,
        stage: 'S0',
        gate: 'G-SPEC',
        outcome: 'PASS',
        subjectHash: f.subjectHash,
        specId: f.specId(),
        detail: 'Unchecked',
        rationale: 'Claim',
        evidenceRef: f.store.snapshot().jobs![0].outputs[0].sha256,
        createdAt: at(3),
      },
    ],
  });
  assert.equal(f.store.snapshot().receipts!.at(-1)!.outcome, 'PASS');
  assert.equal(f.store.snapshot().receipts!.at(-1)!.provenance, 'REVIEWER_ASSERTED');
  assert.throws(
    () =>
      f.store.recordResearchGates({
        branchId: f.branch().id,
        expectedRevision: f.branch().revision,
        assignmentId: f.assignment.id,
        receipts: [
          {
            id: key(),
            branchId: f.branch().id,
            stage: 'S0',
            gate: 'G-SPEC',
            outcome: 'NOT_APPLICABLE',
            subjectHash: f.subjectHash,
            specId: f.specId(),
            detail: 'Unchecked',
            rationale: 'Claim',
            evidenceRef: f.store.snapshot().jobs![0].outputs[0].sha256,
            createdAt: at(3),
          },
        ],
      }),
    /prospectively|inapplicability/i,
  );
});

test('a stage cannot write gates owned by a different stage', async t => {
  const f = await completedReport(t, [{ gate: 'G-COST', outcome: 'FAIL', detail: 'Wrong stage', rationale: '' }]);
  await assert.rejects(f.service().run({ type: 'collect', assignmentId: f.assignment.id }), /does not belong/);
  assert.equal(f.store.snapshot().receipts?.length ?? 0, 0);
});

test('collecting the same report again does not append duplicate gate evidence', async t => {
  const f = await completedReport(t, [
    { gate: 'G-SPEC', outcome: 'BLOCKED', detail: 'Missing evidence', rationale: '' },
  ]);
  await f.service().run({ type: 'collect', assignmentId: f.assignment.id });
  const before = f.store.snapshot();
  await f.service().run({ type: 'collect', assignmentId: f.assignment.id });
  assert.deepEqual(f.store.snapshot().events, before.events);
  assert.deepEqual(f.store.snapshot().receipts, before.receipts);
});

test('collect rechecks the linked request after reading report bytes', async t => {
  const f = await completedReport(t, [
    { gate: 'G-SPEC', outcome: 'BLOCKED', detail: 'Missing evidence', rationale: '' },
  ]);
  const service = new PipelineService(f.store, f.controller, null, f.stageInputs, async hash => {
    const bytes = await f.readObject(hash);
    f.store.execute({
      type: 'request.update',
      idempotencyKey: key(),
      requestId: f.request.id,
      expectedRevision: f.request.revision,
      objective: 'Changed while reading',
      leadAgentId: f.principal.id,
      participantIds: [f.second.id],
      acceptanceCriteria: '',
    });
    return bytes;
  });
  await assert.rejects(service.run({ type: 'collect', assignmentId: f.assignment.id }), /[Ll]inked request changed/);
  assert.equal(f.store.snapshot().receipts?.length ?? 0, 0);
});

test('launch rechecks that the prepared agent still holds its stage function', async t => {
  const f = await fixture(t);
  await f.linked();
  const prepared = await f
    .service()
    .run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  f.store.appendFunctionAssignment({
    id: key(),
    projectId: f.project.id,
    stage: 'S0',
    function: 'PRINCIPAL',
    agentId: f.second.id,
    agentRevision: 0,
    appendedAt: at(3),
    supersededById: null,
    origin: 'EXPLICIT',
    note: 'Reassigned',
  });
  await assert.rejects(f.controller.dispatch(prepared.assignments![0].id), /stage function/);
  assert.equal(f.adapter.submissions.length, 0);
});

test('a separated S2 round opens without a configured runtime, durably bound to its prepared contexts', async t => {
  const f = await fixture(t);
  await f.linked();
  recordSpecGate(f);
  await f.service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  await completeS1(f);
  await f.service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
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
  const prepared = await f
    .service()
    .run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  assert.equal(prepared.assignments!.length, 1, 'the separated tier still assigns the appointed correctness reviewer');
  const round = f.store.snapshot().pipeline!.find(r => r.kind === 'SEPARATED_REVIEW');
  assert.ok(
    round && round.kind === 'SEPARATED_REVIEW',
    'the office freezes its own separation intent as a durable record',
  );
  assert.equal(round.branchId, f.branch().id);
  assert.equal(round.branchRevision, f.branch().revision);
  assert.equal(round.correctnessBlinded, true, 'S2 blinding is a scheduling contract, not a runtime claim');
  assert.equal(round.contexts.length, 1);
  assert.equal(round.contexts[0].agentId, f.second.id);
  assert.ok(
    prepared.assignments![0].research!.isolatedContextId,
    'the assignment is still bound to a separated context',
  );
  assert.equal(prepared.assignments![0].research!.reviewRoundId, round.id);
});

test('research context and reviewer-asserted gate evidence survive store reopen without rewriting history', async t => {
  const f = await completedReport(t);
  await f.service().run({ type: 'collect', assignmentId: f.assignment.id });
  const before = f.store.snapshot();
  f.store.close();
  const reopened = new OfficeStore(path.join(f.root, 'workspace.sqlite'));
  try {
    assert.deepEqual(reopened.snapshot().events, before.events);
    assert.deepEqual(reopened.snapshot().assignments, before.assignments);
    assert.deepEqual(reopened.snapshot().receipts, before.receipts);
    assert.throws(
      () => reopened.advanceResearch(f.assignment.research!.branchId, f.assignment.research!.branchRevision),
      /office-verified/,
    );
  } finally {
    reopened.close();
  }
});

test('research handoff refuses a terminal route that only sends the request title', async t => {
  const f = await fixture(t);
  await f.linked();
  let launches = 0;
  const adapter = new TerminalHandoffAdapter({
    executable: () => 'unused-fixture-provider',
    launch: async () => {
      launches++;
      return { launched: true, detail: 'Fixture' };
    },
  });
  const controller = new AssignmentController(
    f.store,
    adapter,
    () => at(2),
    async () => [],
  );
  const service = new PipelineService(f.store, controller, null, f.stageInputs, f.readObject);
  const prepared = await service.run({
    type: 'prepare',
    branchId: f.branch().id,
    expectedRevision: f.branch().revision,
  });
  await assert.rejects(controller.handoff(prepared.assignments![0].id), /cannot deliver the frozen stage context/);
  assert.equal(launches, 0);
  assert.equal(f.store.snapshot().jobs![0].state, 'INTENT');
});

test('review report schemas reject missing verdicts before collection can write gates', () => {
  for (const stage of ['S2', 'S7'] as const)
    assert.equal(
      stageReportSchema.safeParse({
        schemaVersion: 1,
        branchId: key(),
        specId: key(),
        subjectHash: sha256('candidate'),
        stage,
        contextHash: sha256('context'),
        gates: [],
        detail: 'Incomplete review',
      }).success,
      false,
    );
});

test('S1 requires atomic durable report collection even though it has no gates', async t => {
  const f = await fixture(t);
  await f.linked();
  recordSpecGate(f);
  await f.service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision });
  await assert.rejects(
    f.service().run({ type: 'advance', branchId: f.branch().id, expectedRevision: f.branch().revision }),
    /completed exact-context/,
  );
  assert.equal(promotable(f.store.snapshot(), f.branch(), f.subjectHash).allowed, false);
  const assignment = await completeS1(f);
  const before = f.store.snapshot();
  assert.equal(before.attempts!.find(a => a.assignmentId === assignment.id)!.state, 'COMPLETED');
  assert.equal(
    before.pipeline!.filter(r => r.kind === 'STAGE_COMPLETION' && r.assignmentId === assignment.id).length,
    1,
  );
  assert.equal(before.receipts!.length, 1, 'a gate-free completion fabricates no scientific receipts');
  assert.equal(promotable(before, f.branch(), f.subjectHash).allowed, true);
  const completion = before.pipeline!.find(r => r.kind === 'STAGE_COMPLETION' && r.assignmentId === assignment.id)!;
  assert.throws(
    () => f.store.recordPipeline({ ...completion, id: key() }),
    /atomic report admission/,
    'generic record writes cannot fabricate stage completion',
  );
  await Promise.all([
    f.service().run({ type: 'collect', assignmentId: assignment.id }),
    f.service().run({ type: 'collect', assignmentId: assignment.id }),
  ]);
  assert.deepEqual(f.store.snapshot().events, before.events, 'concurrent re-collection is idempotent');
  f.store.close();
  const reopened = new OfficeStore(path.join(f.root, 'workspace.sqlite'));
  try {
    assert.deepEqual(reopened.snapshot().attempts, before.attempts);
    assert.deepEqual(reopened.snapshot().pipeline, before.pipeline);
    reopened.advanceResearch(assignment.research!.branchId, assignment.research!.branchRevision);
    assert.equal(reopened.snapshot().branches![0].stage, 'S2');
  } finally {
    reopened.close();
  }
});

test('provider completion leaves its attempt open until collection', async t => {
  const f = await completedReport(t);
  assert.equal(f.store.snapshot().attempts!.find(a => a.assignmentId === f.assignment.id)!.state, 'OPEN');
  await f.service().run({ type: 'collect', assignmentId: f.assignment.id });
  assert.equal(f.store.snapshot().attempts!.find(a => a.assignmentId === f.assignment.id)!.state, 'COMPLETED');
});

test('failed stage jobs abandon their attempts without producing completion evidence', async t => {
  const f = await fixture(t, async () => ({ state: 'FAILED', detail: 'Synthetic failure' }));
  await f.linked();
  const result = await f
    .service()
    .run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const assignment = result.assignments![0];
  await f.controller.dispatch(assignment.id);
  await f.controller.observe(assignment.id);
  assert.equal(f.store.snapshot().attempts!.find(a => a.assignmentId === assignment.id)!.state, 'ABANDONED');
  await assert.rejects(f.service().run({ type: 'collect', assignmentId: assignment.id }), /provider reported/);
  assert.equal(f.store.snapshot().pipeline!.filter(r => r.kind === 'STAGE_COMPLETION').length, 0);
});

test('mismatched object bytes cannot complete a stage or write gate evidence', async t => {
  const f = await completedReport(t);
  const service = new PipelineService(f.store, f.controller, null, f.stageInputs, async () => Buffer.from('{}'));
  await assert.rejects(service.run({ type: 'collect', assignmentId: f.assignment.id }), /output identity/);
  assert.equal(f.store.snapshot().receipts?.length ?? 0, 0);
  assert.equal(f.store.snapshot().attempts![0].state, 'OPEN');
});

test('invalid gate collection rolls back stage completion and leaves the attempt open', async t => {
  const f = await completedReport(t, [{ gate: 'G-COST', outcome: 'FAIL', detail: 'Wrong stage', rationale: '' }]);
  const before = f.store.snapshot();
  await assert.rejects(f.service().run({ type: 'collect', assignmentId: f.assignment.id }), /does not belong/);
  assert.deepEqual(f.store.snapshot().attempts, before.attempts);
  assert.deepEqual(f.store.snapshot().pipeline, before.pipeline);
  assert.deepEqual(f.store.snapshot().events, before.events);
});
