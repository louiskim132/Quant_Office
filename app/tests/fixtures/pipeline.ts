import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { removeTreeSync } from '../../src/main/fsx';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OfficeStore } from '../../src/core/store';
import {
  AssignmentController,
  type ObserveResult,
  type ProviderAdapter,
  type SubmitContext,
  type SubmitResult,
} from '../../src/main/controller';
import { PipelineService } from '../../src/main/pipeline';
import { OutputService } from '../../src/main/outputs';
import { prepareInputSnapshot, snapshotObjectPath } from '../../src/main/locations';
import { HoldoutCustody } from '../../src/main/holdout';
import { TerminalHandoffAdapter } from '../../src/main/handoff';
import { stageContextHash, stageReportSchema, type StageContext } from '../../src/shared/pipeline';
import type {
  Agent,
  CapabilityEvidence,
  CapabilityOperation,
  InputSnapshot,
  ProviderJob,
} from '../../src/shared/types';
import type { ResearchTrustPin } from '../../src/shared/research-admission';
import type { GateId } from '../../src/shared/research';

export const key = () => randomUUID();
export const at = (minutes: number) => new Date(Date.UTC(2026, 8, 8, 10, 0, 0) + minutes * 60000).toISOString();
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const ROUTES = ['FAKE_ADAPTER', 'OFFICIAL_TERMINAL_HANDOFF', 'OFFICIAL_CLI_PTY'] as const;
const CLOUD: CapabilityOperation[] = [
  'CLOUD_SUBMIT',
  'CLOUD_OBSERVE',
  'CLOUD_OUTPUT_FETCH',
  'CLOUD_CANCEL_REQUEST',
  'CLOUD_CANCEL_ACK',
  'MODEL_APPLICATION',
  'EFFORT_APPLICATION',
  'ENVIRONMENT_IDENTITY',
  'DELEGATION_CONTROL',
  'TOOL_CONFINEMENT',
];
const seen = (
  operation: CapabilityOperation,
  minutes: number,
  extra: Partial<CapabilityEvidence> = {},
): CapabilityEvidence => ({
  operation,
  level: 'ACCOUNT_VERIFIED',
  detail: 'Exercised.',
  evidence: 'OBSERVED',
  verifiedAt: at(minutes),
  source: 'fixture',
  ...extra,
});
const verifiedObservation = (minutes: number) => ({
  provider: 'claude' as const,
  identity: 'researcher@example.com',
  credentialContext: 'claude-code-cli',
  state: 'SIGNED_IN' as const,
  allowance: [],
  note: '',
  toolVersion: '2.1.236',
  transport: 'OFFICIAL_CLI_TERMINAL' as const,
  environment: 'anthropic-managed',
  models: [{ id: 'opus', name: 'Opus' }],
  operations: [
    seen('ACCOUNT_STATUS', minutes),
    seen('MODEL_CATALOG', minutes),
    ...CLOUD.flatMap(o =>
      ROUTES.flatMap(route =>
        o === 'DELEGATION_CONTROL'
          ? [
              seen(o, minutes, { model: 'opus', route, delegation: false }),
              seen(o, minutes, { model: 'opus', route, delegation: true }),
            ]
          : o === 'EFFORT_APPLICATION'
            ? [seen(o, minutes, { model: 'opus', route, effort: 'default' })]
            : o === 'TOOL_CONFINEMENT'
              ? [
                  seen(o, minutes, {
                    model: 'opus',
                    route,
                    confinement: {
                      tools: 'Only the read-only fixture tools were offered.',
                      filesystem: 'Confined to the staged snapshot directory.',
                      network: 'No outbound network was reachable from the session.',
                      environment: 'anthropic-managed',
                    },
                  }),
                ]
              : [seen(o, minutes, { model: 'opus', route })],
      ),
    ),
  ],
  source: 'transport fixture',
  observedAt: at(minutes),
});

/** A test double for the provider. No production code path can inject provider evidence this way. */
class FakeAdapter implements ProviderAdapter {
  readonly route = 'FAKE_ADAPTER' as const;
  readonly isolatedContexts = true as const;
  readonly submissions: SubmitContext[] = [];
  constructor(
    public behaviour: {
      submit?: () => Promise<SubmitResult>;
      observe?: (job: ProviderJob) => Promise<ObserveResult>;
      cancel?: () => Promise<{ acknowledged: boolean; detail: string }>;
    } = {},
  ) {}
  async submit(context: SubmitContext) {
    this.submissions.push(context);
    return this.behaviour.submit
      ? await this.behaviour.submit()
      : {
          externalId: context.assignment.research?.isolatedContextId ?? 'session_' + context.assignment.id,
          externalUrl: 'https://example.invalid/session_fixture_1',
          detail: 'Accepted by the fixture provider.',
        };
  }
  async observe(job: ProviderJob) {
    return this.behaviour.observe
      ? await this.behaviour.observe(job)
      : { state: 'RUNNING' as const, detail: 'Working.' };
  }
  async cancel() {
    return this.behaviour.cancel
      ? await this.behaviour.cancel()
      : { acknowledged: true, detail: 'Provider acknowledged the cancellation.' };
  }
}

const OUTPUT_BYTES = new Map<string, Uint8Array>();
export const declared = (body: string, name = 'stage-report.json') => {
  const bytes = Buffer.from(body);
  const hash = sha256(bytes);
  OUTPUT_BYTES.set(hash, bytes);
  return { path: name, sha256: hash, bytes: bytes.byteLength };
};
const fetchOutput = async (_job: ProviderJob, output: { sha256: string }) => {
  const bytes = OUTPUT_BYTES.get(output.sha256);
  if (!bytes) throw new Error('no bytes for this output');
  return bytes;
};

export const SECTIONS = {
  estimand: 'e',
  splitPlan: 's',
  searchPlan: 'se',
  costContract: 'c',
  portfolioContract: 'p',
  metricsAndGates: 'm',
  holdoutPolicy: 'h',
};

/**
 * A workspace with a bound principal and a second participant, a linked request, and a branch whose
 * specification is frozen far enough to register a trial. The whole C4(a) path runs against the real
 * store, the real controller and the real object store; only the provider is a double.
 */
export async function fixture(
  t: Pick<TestContext, 'after'>,
  observe?: (job: ProviderJob) => Promise<ObserveResult>,
  appoint = true,
  options: {
    researchTrust?: ResearchTrustPin[];
    clock?: () => string;
    shadowPolicy?: boolean;
    gateEvidence?: { gate: GateId; tier: 'SIGNED_HARNESS' }[];
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'qro-pipeline-'));
  const file = path.join(root, 'workspace.sqlite');
  const store = new OfficeStore(file, { researchTrust: options.researchTrust });
  t.after(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    removeTreeSync(root);
  });

  const project = store.execute({
    type: 'project.create',
    idempotencyKey: key(),
    name: 'Alpha',
    mandate: 'm',
    budgetCents: 0,
  }).projects[0];
  const source = path.join(root, 'source');
  mkdirSync(source);
  writeFileSync(path.join(source, 'input.csv'), 'a,b\n1,2\n');
  store.execute({
    type: 'location.save',
    idempotencyKey: key(),
    projectId: project.id,
    expectedRevision: 0,
    localFolder: source,
    inputPaths: ['input.csv'],
    outputFolder: '',
  });

  const makeAgent = (name: string, createdAt: string): Agent => {
    const agent: Agent = {
      id: randomUUID(),
      name,
      provider: 'claude',
      model: 'opus',
      team: 'Research',
      role: 'WORKER',
      instructions: '',
      effort: 'default',
      account: 'researcher@example.com',
      createdAt,
      connectionVerifiedAt: createdAt,
      execution: 'HOSTED_SETUP_REQUIRED',
    };
    const observation = verifiedObservation(0);
    if (options.clock) {
      const now = options.clock();
      observation.observedAt = now;
      observation.operations = observation.operations.map(o => ({ ...o, verifiedAt: now }));
    }
    store.confirmAgentBinding({ observation, agent });
    return agent;
  };
  const principal = makeAgent('Principal', at(0));
  const second = makeAgent('Second opinion', at(1));

  const request = store.execute({
    type: 'request.create',
    idempotencyKey: key(),
    projectId: project.id,
    name: 'Candidate run',
    hypothesis: 'h',
    workType: 'ANALYSIS',
    mode: 'GROUP',
    leadAgentId: principal.id,
    participantIds: [second.id],
  }).requests![0];

  // S0 as far as it can go without a candidate: draft, freeze with a prediction, register the trial.
  store.execute({
    type: 'research.draftSpec',
    idempotencyKey: key(),
    projectId: project.id,
    name: 'Lineage A',
    sections: SECTIONS,
    thresholds: [],
    notApplicable: [],
    ...(options.gateEvidence ? { gateEvidence: options.gateEvidence } : {}),
    maxSelectionTrials: 4,
  });
  const branch = () => store.snapshot().branches![0];
  const specId = () => branch().specId!;
  if (options.shadowPolicy) {
    const policy = {
      minimumElapsedSeconds: 1,
      minimumObservationTimes: 1,
      minimumSamples: 1,
      maximumMissingShare: 0.1,
      retireBelowMetric: -0.1,
      qualifyAtOrAboveMetric: 0.1,
      driftAlarmMetric: 0,
      killBelowMetric: -0.5,
    };
    const { canonicalHash } = await import('../../src/core/canonical');
    store.recordPipeline({
      id: key(),
      kind: 'SHADOW_POLICY',
      projectId: project.id,
      branchId: branch().id,
      createdAt: new Date().toISOString(),
      specId: specId(),
      policy: { ...policy, thresholdHash: canonicalHash(policy) },
    });
  }
  store.execute({
    type: 'research.freezeSpec',
    idempotencyKey: key(),
    specId: specId(),
    expectedRevision: 0,
    prediction: {
      outcomeName: 'sharpe',
      sign: 'POSITIVE',
      expectedLow: 0,
      expectedHigh: 2,
      probability: 0.6,
      falsifiers: ['f'],
      existingKnowledge: 'none',
      retrospective: false,
    },
  });
  const subjectHash = sha256('candidate-1');
  store.execute({
    type: 'research.registerVariant',
    idempotencyKey: key(),
    branchId: branch().id,
    kind: 'VARIANT',
    variantHash: subjectHash,
    description: 'first candidate',
  });

  if (appoint)
    store.appendFunctionAssignment({
      id: randomUUID(),
      projectId: project.id,
      stage: 'S0',
      function: 'PRINCIPAL',
      agentId: principal.id,
      agentRevision: 0,
      appendedAt: at(2),
      supersededById: null,
      origin: 'EXPLICIT',
      note: 'fixture',
    });

  let tick = 0;
  const clock = options.clock ?? (() => at(++tick / 60));
  const adapter = new FakeAdapter(observe ? { observe } : {});
  // The staged bytes are real; only the Git staging step is replaced. A snapshot without a staging
  // commit is still recorded, and the transfer check is stubbed to keep this suite off the Windows
  // git-tree lock that flakes the environment — what is under test is the research context, not Git.
  const controller = new AssignmentController(
    store,
    adapter,
    clock,
    () => Promise.resolve([]),
    undefined,
    undefined,
    fetchOutput,
    new OutputService(store, root).storeBytes,
  );
  const stageInputs = (input: {
    projectId: string;
    requestId: string;
    requestRevision: number;
    objective: string;
  }): Promise<InputSnapshot> =>
    prepareInputSnapshot({
      store,
      objectRoot: root,
      stagingRoot: path.join(root, 'staging'),
      gitExecutable: 'qro-no-such-git',
      ...input,
    });
  const readObject = async (hash: string) => {
    const target = snapshotObjectPath(root, hash);
    return existsSync(target) ? readFileSync(target) : null;
  };
  const io = {
    writeObject: async (bytes: Uint8Array) => {
      const sha = sha256(bytes),
        file = snapshotObjectPath(root, sha);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      return { sha256: sha, bytes: bytes.byteLength };
    },
    selectHoldout: async () => null,
    exportHoldout: async () => {},
  };
  const service = (custody: HoldoutCustody | null = null) =>
    new PipelineService(store, controller, custody, stageInputs, readObject, clock, null, io);

  const linked = async () => {
    await service().run({
      type: 'link',
      branchId: branch().id,
      requestId: request.id,
      subjectHash,
      expectedRevision: branch().revision,
    });
    return branch();
  };
  return {
    root,
    store,
    project,
    principal,
    second,
    request,
    branch,
    specId,
    subjectHash,
    controller,
    adapter,
    stageInputs,
    readObject,
    service,
    linked,
    makeAgent,
    clock,
    io,
  };
}

/** Exercise S1 through the same durable provider/output/collection path as application work. */
export async function completeS1(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.appendFunctionAssignment({
    id: key(),
    projectId: f.project.id,
    stage: 'S1',
    function: 'PRINCIPAL',
    agentId: f.principal.id,
    agentRevision: 0,
    appendedAt: at(3),
    supersededById: null,
    origin: 'EXPLICIT',
    note: 'Synthetic S1',
  });
  f.adapter.behaviour.observe = async job => {
    const context = f.store.snapshot().assignments!.find(a => a.id === job.assignmentId)!.research!;
    return {
      state: 'COMPLETED',
      detail: 'Synthetic completed specification report',
      outputs: [
        declared(
          JSON.stringify({
            schemaVersion: 1,
            branchId: context.branchId,
            specId: context.specId,
            subjectHash: context.subjectHash,
            stage: context.stage,
            contextHash: context.contextHash,
            gates: [],
            detail: 'Completed fixture specification.',
          }),
        ),
      ],
    };
  };
  const result = await f
    .service()
    .run({ type: 'prepare', branchId: f.branch().id, expectedRevision: f.branch().revision });
  const assignment = result.assignments![0];
  await f.controller.dispatch(assignment.id);
  await f.controller.observe(assignment.id);
  await f.service().run({ type: 'collect', assignmentId: assignment.id });
  return assignment;
}
