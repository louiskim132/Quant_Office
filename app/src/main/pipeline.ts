import { createHash, randomUUID } from 'node:crypto';
import { canonicalHash } from '../core/canonical.js';
import { parseStrictJson } from '../core/strict-json.js';
import type { OfficeStore } from '../core/store.js';
import type { AssignmentController } from './controller.js';
import { adjudicate as adjudicateStage, scheduleStage } from './research-controller.js';
import type { HoldoutCustody } from './holdout.js';
import { pipelineStageBlocker } from '../shared/research.js';
import {
  pipelineActionSchema,
  stageContextHash,
  stageReportSchema,
  type PipelineAction,
  type StageContext,
} from '../shared/pipeline.js';
import type { AppState, Assignment, InputSnapshot } from '../shared/types.js';
import type { HoldoutReservation } from '../shared/holdout.js';
import type { SignedResearchClaim } from '../shared/research-admission';
import type { RunPackageBuilder, RunReturnInspector } from '../shared/run-package';
import { buildBlindedPacket, buildAdversarialPackets } from './context-policy';
import { z } from 'zod';
import type { Holdout } from '../shared/holdout';
export interface ResearchRuntime {
  prepareReview(input: {
    operationId: string;
    state: AppState;
    branchId: string;
    tasks: ReturnType<typeof scheduleStage>['tasks'];
  }): Promise<{ proof: SignedResearchClaim; snapshots: InputSnapshot[]; body: unknown }>;
  reconcileReview?(
    operationId: string,
  ): Promise<{ proof: SignedResearchClaim; snapshots: InputSnapshot[]; body: unknown } | null>;
  evaluate(input: {
    operationId: string;
    assignment: Assignment;
    job: NonNullable<AppState['jobs']>[number];
    reportHash: string;
    reportBytes: Uint8Array;
  }): Promise<SignedResearchClaim>;
  reconcileHarness?(operationId: string): Promise<SignedResearchClaim | null>;
  rebuttal?(input: {
    operationId: string;
    assignment: Assignment;
    firstReports: { hash: string; bytes: Uint8Array }[];
    maximumCharacters: 4000;
  }): Promise<{ proof: SignedResearchClaim; bytes: Uint8Array }>;
  reconcileRebuttal?(operationId: string): Promise<{ proof: SignedResearchClaim; bytes: Uint8Array } | null>;
}
export interface PipelineIO {
  selectHoldout: () => Promise<Uint8Array | null>;
  exportHoldout: (bytes: Uint8Array) => Promise<void>;
  writeObject: (bytes: Uint8Array) => Promise<{ sha256: string; bytes: number }>;
  /** Writes the frozen run package where the user can take it to Colab. Returns where it went. */
  exportPackage?: (bytes: Uint8Array, packageId: string) => Promise<string | null>;
}

/**
 * The shape a stage's frozen context always carries. Written once here so the scheduler's hash, the
 * assignment's record and the provider's report all agree on the same literal — a stage report that
 * claims any other output shape is not a stage report.
 */
const STAGE_OUTPUT_SCHEMA = 'research-stage-report@1' as const;

export interface PipelineResult {
  state: AppState;
  detail: string;
  /** The stage work created by a prepare action, in schedule order. */
  assignments?: Assignment[];
  reservation?: HoldoutReservation;
}

/**
 * Runs the staged-scientific actions that cross more than one record.
 *
 * The store already refuses a stale revision, an unlinked subject or a gate without a subject. What
 * it cannot know is the order a whole stage is assembled in — the snapshot and its assignments must
 * be frozen against the same link, a report is only collectable when the provider attested it, and
 * a reservation spends an allowance the journal outside this database owns. This service is that
 * order. Every check is re-made inside the store write it feeds; the checks here exist to give the
 * caller a useful reason rather than to replace the ledger's.
 */
export class PipelineService {
  constructor(
    private readonly store: OfficeStore,
    private readonly controller: AssignmentController,
    /** Null in builds without verified custody; holdout actions then refuse honestly. */
    private readonly custody: HoldoutCustody | null,
    /** Stages the linked request's inputs and records the snapshot. Owned by the caller. */
    private readonly stageInputs: (input: {
      projectId: string;
      requestId: string;
      requestRevision: number;
      objective: string;
    }) => Promise<InputSnapshot>,
    /** Reads one content-addressed object by hash; absent bytes return null rather than guessing. */
    private readonly readObject: (sha256: string) => Promise<Uint8Array | null>,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly runtime: ResearchRuntime | null = null,
    private readonly io: PipelineIO | null = null,
    /** The manual-run seams (section 1.6): package authoring and bound-return inspection. */
    private readonly packages: { build?: RunPackageBuilder; inspect?: RunReturnInspector } = {},
  ) {}

  /** Which stronger-evidence and manual-run capabilities this build actually carries. */
  capabilities() {
    return {
      packageExport: !!this.packages.build,
      returnValidation: !!this.packages.inspect,
      independentRuntime: !!this.runtime,
      custody: !!this.custody,
    };
  }

  async run(input: unknown): Promise<PipelineResult> {
    const action = pipelineActionSchema.parse(input);
    switch (action.type) {
      case 'link':
        return this.link(action);
      case 'prepare':
        return this.prepare(action);
      case 'advance':
        return this.advance(action);
      case 'collect':
        return this.collect(action);
      case 'submit':
        return {
          state: await this.controller.dispatch(action.assignmentId),
          detail: 'Submitted through the verified provider route.',
        };
      case 'verifySpec': {
        const state = this.store.snapshot({ history: false }),
          branch = this.branch(state, action.branchId, action.expectedRevision);
        const spec = state.specs?.find(s => s.id === branch.specId),
          link = this.branchLink(state, branch.id);
        if (!spec || branch.stage !== 'S0') throw new Error('Office specification verification belongs to S0.');
        this.store.recordResearchGates({
          branchId: branch.id,
          expectedRevision: branch.revision,
          receipts: [
            {
              id: randomUUID(),
              branchId: branch.id,
              specId: spec.id,
              stage: 'S0',
              gate: 'G-SPEC',
              outcome: 'PASS',
              subjectHash: link.subjectHash,
              evidenceRef: spec.contentHash,
              detail: 'Office verified the frozen prospective specification.',
              rationale: 'All required registration fields and prospective prediction are present.',
              createdAt: this.now(),
            },
          ],
        });
        return {
          state: this.store.snapshot({ history: false }),
          detail: 'Prospective specification verified by the office.',
        };
      }
      case 'adjudicate':
        return this.adjudicate(action);
      case 'rebuttal':
        return this.rebuttal(action);
      case 'exportRunPackage':
        return this.exportRunPackage(action);
      case 'importRunReturn':
        return this.importRunReturn(action);
      case 'importStageReport':
        return this.importStageReport(action);
      case 'validateReturn':
        return this.validateReturn(action);
      case 'shadowPolicy':
        return this.shadowPolicy(action);
      case 'shadowIngest':
        return this.shadowIngest(action);
      case 'monitor':
        return this.shadowIngest(action);
      case 'holdoutReserve':
        return this.holdoutReserve(action);
      case 'holdoutRegister':
        return this.holdoutRegister(action);
      case 'holdoutEvaluate':
        return this.holdoutEvaluate(action);
      case 'holdoutExport':
        return this.holdoutExport(action);
      case 'holdoutImport':
        return this.holdoutImport(action);
    }
  }

  private branch(state: AppState, branchId: string, expectedRevision?: number) {
    const branch = (state.branches ?? []).find(item => item.id === branchId);
    if (!branch) throw new Error('Research branch not found.');
    if (state.projects.find(p => p.id === branch.projectId)?.archived)
      throw new Error('Archived research is read-only.');
    if (expectedRevision !== undefined && branch.revision !== expectedRevision)
      throw new Error('The branch changed in another view. Reload before acting on it.');
    return branch;
  }

  /** The link a branch's stage work is bound to. No link, no research context. */
  private branchLink(state: AppState, branchId: string) {
    const link = (state.pipeline ?? []).filter(item => item.kind === 'LINK' && item.branchId === branchId).at(-1);
    if (!link || link.kind !== 'LINK')
      throw new Error('Link this branch to an exact request and trial before doing stage work.');
    return link;
  }

  /**
   * Binds a branch to one request and one registered trial, at their current revisions.
   *
   * The caller names a subject hash rather than a trial row because the hash is the semantic
   * identity receipts are written against; the store refuses the link unless a trial ledger entry
   * registered that exact identity for this branch.
   */
  private link(action: Extract<PipelineAction, { type: 'link' }>): PipelineResult {
    const state = this.store.snapshot({ history: false });
    const branch = this.branch(state, action.branchId, action.expectedRevision);
    const request = (state.requests ?? []).find(item => item.id === action.requestId);
    if (!request) throw new Error('Request not found.');
    this.store.recordPipeline({
      id: randomUUID(),
      projectId: branch.projectId,
      branchId: branch.id,
      createdAt: this.now(),
      kind: 'LINK',
      requestId: request.id,
      subjectHash: action.subjectHash,
      requestRevision: request.revision,
      branchRevision: branch.revision,
    });
    return {
      state: this.store.snapshot({ history: false }),
      detail: `Linked ${branch.name} to this request at revision ${request.revision}. Stage work is now frozen against exactly this candidate.`,
    };
  }

  /**
   * Creates one stage's assignments, frozen against the recorded link.
   *
   * The scheduler decides who is needed and refuses to plan beyond the stage the branch is on. The
   * input snapshot is staged once for the whole stage so every function argues from the same bytes,
   * and each assignment's research context carries exactly those object hashes — the store re-checks
   * the context identity, the link and the appointment before any of it is written.
   */
  private async prepare(action: Extract<PipelineAction, { type: 'prepare' }>): Promise<PipelineResult> {
    const state = this.store.snapshot({ history: false });
    const branch = this.branch(state, action.branchId, action.expectedRevision);
    if (branch.outcome !== 'IN_PROGRESS') throw new Error('A settled branch creates no further stage work.');
    if (!branch.specId) throw new Error('Draft this branch’s specification before preparing stage work.');
    const blocker = this.store.researchStageBlocker(branch.stage);
    if (blocker) throw new Error(blocker);
    this.store.assertStagePreparation(branch.id, branch.revision);
    const link = this.branchLink(state, branch.id);
    const request = (state.requests ?? []).find(item => item.id === link.requestId);
    if (!request || request.status === 'CANCELED' || request.revision !== link.requestRevision)
      throw new Error('The linked request changed. Amend or relink the branch before preparing stage work.');

    const schedule = scheduleStage({
      state,
      records: state,
      assignments: (state.functions ?? []).filter(item => !item.supersededById),
      branch,
      subjectHash: link.subjectHash,
      mode: request.mode,
      outputSchema: STAGE_OUTPUT_SCHEMA,
    });
    if (!schedule.tasks.length)
      throw new Error(schedule.blockers[0] ?? `${branch.stage} produces no stage work to prepare.`);

    let review: Awaited<ReturnType<ResearchRuntime['prepareReview']>> | null = null;
    // The separated pilot tier: the office freezes the same context bindings as a durable record
    // instead of an independent signature (section 1.6). Its reports admit as
    // SEPARATE_SESSION_UNVERIFIED and are never promoted past that label.
    let separated: {
      roundId: string;
      contexts: { agentId: string; contextId: string; snapshotId: string }[];
      snapshots: InputSnapshot[];
    } | null = null;
    if (['S2', 'S7'].includes(branch.stage)) {
      const intent = this.store.beginReview(branch.id, branch.revision, canonicalHash(schedule.tasks));
      const saved = state.pipeline?.find(
        r => r.kind === 'REVIEW_ROUND' && r.branchId === branch.id && r.proof.claim.branchRevision === branch.revision,
      );
      const savedSeparated = state.pipeline?.find(
        r => r.kind === 'SEPARATED_REVIEW' && r.branchId === branch.id && r.branchRevision === branch.revision,
      );
      if (saved && saved.kind === 'REVIEW_ROUND')
        review = { proof: saved.proof, snapshots: state.snapshots ?? [], body: null };
      else if (savedSeparated && savedSeparated.kind === 'SEPARATED_REVIEW')
        separated = { roundId: savedSeparated.id, contexts: savedSeparated.contexts, snapshots: state.snapshots ?? [] };
      else if (this.runtime) {
        review =
          (intent.existing
            ? await this.runtime.reconcileReview?.(intent.operationId)
            : await this.runtime.prepareReview({
                operationId: intent.operationId,
                state,
                branchId: branch.id,
                tasks: schedule.tasks,
              })) ?? null;
        if (!review)
          throw new Error(
            'Isolated context preparation is unresolved. Reconcile the existing operation; new contexts will not be created.',
          );
        const verified = this.store.verifyResearchClaim(review.proof),
          claim = verified.signed.claim;
        if (claim.kind !== 'ISOLATION') throw new Error('Review preparation requires an isolation receipt.');
        if (claim.operationId !== intent.operationId)
          throw new Error('Isolation receipt names a different preparation operation.');
        if (branch.stage === 'S2') {
          buildBlindedPacket({
            stage: 'S2',
            subjectId: link.subjectHash,
            reviewerAgentId: schedule.tasks[0].agentId,
            objectHashes: claim.objectHashes,
            body: review.body,
          });
          if (
            createHash('sha256')
              .update(
                JSON.stringify({
                  subjectId: link.subjectHash,
                  hashes: [...claim.objectHashes].sort(),
                  body: review.body,
                }),
              )
              .digest('hex') !== claim.evidenceHash
          )
            throw new Error('S2 receipt does not bind the blinded evidence body.');
        } else {
          const packets = buildAdversarialPackets({
            subjectId: link.subjectHash,
            objectHashes: claim.objectHashes,
            body: review.body,
            advocateAgentId: schedule.tasks.find(t => t.function === 'ADVOCATE')!.agentId,
            skepticAgentId: schedule.tasks.find(t => t.function === 'SKEPTIC')!.agentId,
          });
          if (packets.evidenceHash !== claim.evidenceHash)
            throw new Error('S7 receipt must bind the same evidence body and objects for both reviewers.');
        }
        for (const snapshot of review.snapshots) this.store.recordInputSnapshot(snapshot);
        this.store.recordPipeline({
          id: claim.roundId,
          kind: 'REVIEW_ROUND',
          projectId: branch.projectId,
          branchId: branch.id,
          createdAt: this.now(),
          proof: review.proof,
          verification: verified.environment,
        });
      } else {
        if (!this.io) throw new Error('Review evidence storage is not configured in this build.');
        const spec = state.specs?.find(s => s.id === branch.specId);
        const body = {
          kind: 'OFFICE_REVIEW_EVIDENCE',
          stage: branch.stage,
          subjectHash: link.subjectHash,
          specId: branch.specId,
          specHash: spec?.contentHash ?? '',
          requestRevision: request.revision,
          objective: request.objective,
        };
        const object = await this.io.writeObject(Buffer.from(JSON.stringify(body)));
        // One staging per round: every reviewer context binds the same delivered evidence set. The
        // base snapshot is staged once and cloned per context with a fresh record id; staging per
        // context would embed a different snapshot id/timestamp in each generated inventory and break
        // the round's union binding.
        const base = await this.stageInputs({
          projectId: branch.projectId,
          requestId: request.id,
          requestRevision: request.revision,
          objective: request.objective,
        });
        const snapshots: InputSnapshot[] = schedule.tasks.map(() => ({
          ...base,
          id: randomUUID(),
          files: [...base.files, { path: 'review-evidence.json', sha256: object.sha256, bytes: object.bytes }],
          totalBytes: base.totalBytes + object.bytes,
        }));
        const objectHashes = [
          ...new Set(snapshots.flatMap(s => [...s.files, ...(s.generated ?? [])].map(f => f.sha256))),
        ].sort();
        const evidenceHash =
          branch.stage === 'S2'
            ? createHash('sha256')
                .update(JSON.stringify({ subjectId: link.subjectHash, hashes: [...objectHashes].sort(), body }))
                .digest('hex')
            : buildAdversarialPackets({
                subjectId: link.subjectHash,
                objectHashes,
                body,
                advocateAgentId: schedule.tasks.find(t => t.function === 'ADVOCATE')!.agentId,
                skepticAgentId: schedule.tasks.find(t => t.function === 'SKEPTIC')!.agentId,
              }).evidenceHash;
        if (branch.stage === 'S2')
          buildBlindedPacket({
            stage: 'S2',
            subjectId: link.subjectHash,
            reviewerAgentId: schedule.tasks[0].agentId,
            objectHashes,
            body,
          });
        for (const snapshot of snapshots) this.store.recordInputSnapshot(snapshot);
        const contexts = schedule.tasks.map((task, index) => ({
          agentId: task.agentId,
          contextId: randomUUID(),
          snapshotId: snapshots[index].id,
        }));
        const round = this.store.beginSeparatedReview({
          branchId: branch.id,
          expectedRevision: branch.revision,
          scheduleHash: canonicalHash(schedule.tasks),
          contexts,
          objectHashes,
          evidenceHash,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          correctnessBlinded: branch.stage === 'S2',
        });
        separated = { roundId: round.roundId, contexts, snapshots };
      }
    }
    const ordinarySnapshot =
      review || separated
        ? null
        : await this.stageInputs({
            projectId: branch.projectId,
            requestId: request.id,
            requestRevision: request.revision,
            objective: request.objective,
          });
    const assignments: Assignment[] = [];
    for (const task of schedule.tasks) {
      const existing = state.assignments?.find(
        a =>
          a.research?.branchId === branch.id &&
          a.research.branchRevision === branch.revision &&
          a.research.stage === branch.stage &&
          a.research.function === task.function &&
          a.agentId === task.agentId,
      );
      if (existing) {
        assignments.push(existing);
        continue;
      }
      const claim = review?.proof.claim;
      const context =
        claim?.kind === 'ISOLATION'
          ? claim.contexts.find(c => c.agentId === task.agentId)
          : separated
            ? (separated.contexts.find(c => c.agentId === task.agentId) ?? null)
            : null;
      const snapshot = separated
        ? separated.snapshots.find(s => s.id === context?.snapshotId)
        : (ordinarySnapshot ?? review!.snapshots.find(s => s.id === context?.snapshotId));
      if (!snapshot) throw new Error('The reviewer snapshot for the appointed reviewer is missing.');
      const objectHashes = [...snapshot.files, ...(snapshot.generated ?? [])].map(f => f.sha256);
      const isolated = context
        ? {
            reviewRoundId: separated ? separated.roundId : claim && claim.kind === 'ISOLATION' ? claim.roundId : '',
            isolatedContextId: context.contextId,
          }
        : {};
      const research: StageContext = {
        branchId: branch.id,
        branchRevision: branch.revision,
        specId: branch.specId,
        subjectHash: link.subjectHash,
        stage: branch.stage,
        function: task.function,
        contextHash: stageContextHash({
          ...task,
          specId: branch.specId,
          subjectHash: link.subjectHash,
          inputs: { branchRevision: branch.revision, requestRevision: request.revision, objectHashes, ...isolated },
        }),
        outputSchema: STAGE_OUTPUT_SCHEMA,
        objectHashes,
        requestRevision: link.requestRevision,
        ...isolated,
      };
      // The store re-validates the whole context against the recorded link inside the write, so a
      // context computed here cannot name a stage, subject or profile revision the ledger moved past.
      assignments.push(
        this.controller.prepare({ requestId: request.id, agentId: task.agentId, snapshotId: snapshot.id, research })
          .assignment,
      );
    }
    return {
      state: this.store.snapshot({ history: false }),
      assignments,
      detail: `Prepared ${assignments.length} ${branch.stage} task${assignments.length === 1 ? '' : 's'} for ${branch.name}: ${schedule.tasks.map(item => item.function.toLowerCase().replaceAll('_', ' ')).join(', ')}. Nothing has been dispatched.`,
    };
  }

  /** Promotion is decided by the store against the recorded gates; this is the request for it. */
  private advance(action: Extract<PipelineAction, { type: 'advance' }>): PipelineResult {
    const state = this.store.advanceResearch(action.branchId, action.expectedRevision);
    const branch = (state.branches ?? []).find(item => item.id === action.branchId);
    return { state, detail: `${branch?.name ?? 'The branch'} advanced to ${branch?.stage ?? 'the next stage'}.` };
  }

  /**
   * Turns a provider-reported completion into stage receipts.
   *
   * The report is located among the job's durably stored outputs by content, not by filename: the
   * output that parses as a stage report for this assignment's exact context is the report. Its gate
   * outcomes are recorded as receipts for the linked subject only, and S2/S7 reports additionally
   * become review records, so a later adjudication argues from what was actually filed.
   */
  private async collect(action: Extract<PipelineAction, { type: 'collect' }>): Promise<PipelineResult> {
    const state = this.store.snapshot({ history: false });
    const assignment = (state.assignments ?? []).find(item => item.id === action.assignmentId);
    if (!assignment?.research) throw new Error('This assignment carries no research context.');
    const research = assignment.research;
    const branch = this.branch(state, research.branchId);
    const blocker = this.store.researchStageBlocker(branch.stage);
    if (blocker) throw new Error(blocker);
    if (branch.stage !== research.stage)
      throw new Error(
        `The branch has moved to ${branch.stage}. A report for ${research.stage} is stale and cannot be collected.`,
      );
    const job = (state.jobs ?? []).find(item => item.assignmentId === assignment.id);
    if (!job || job.state !== 'COMPLETED' || job.evidence !== 'PROVIDER_REPORTED')
      throw new Error(
        'Only a completion the provider reported can be collected. An office-local or user-reported outcome is not stage evidence.',
      );

    const reports: { sha256: string; bytes: Uint8Array; report: ReturnType<typeof stageReportSchema.parse> }[] = [];
    for (const output of job.outputs.filter(item => item.stored && item.path.toLowerCase().endsWith('.json'))) {
      const bytes = await this.readObject(output.sha256);
      if (!bytes) continue;
      if (createHash('sha256').update(bytes).digest('hex') !== output.sha256 || bytes.byteLength !== output.bytes)
        throw new Error('Stored stage report bytes do not match the output identity.');
      try {
        reports.push({
          sha256: output.sha256,
          bytes,
          report: stageReportSchema.parse(parseStrictJson(Buffer.from(bytes).toString('utf8'))),
        });
      } catch {
        /* A JSON output that is not a stage report is simply not the report. */
      }
    }
    const matches = reports.filter(item => item.report.contextHash === research.contextHash);
    if (!matches.length)
      throw new Error(
        reports.length
          ? 'No stored stage report was written for this exact stage context.'
          : 'None of the job’s stored outputs is a stage report.',
      );
    // The same bytes may be listed under two paths; that is one report. Two different byte identities
    // claiming this context is a conflict nobody may pick a side of.
    if (new Set(matches.map(item => item.sha256)).size > 1)
      throw new Error(
        'Two different stored outputs claim this stage context. Resolve the conflict before collecting either.',
      );
    const { report, sha256, bytes } = matches[0];
    if (
      report.branchId !== research.branchId ||
      report.specId !== research.specId ||
      report.subjectHash !== research.subjectHash ||
      report.stage !== research.stage
    )
      throw new Error('The stage report’s scope does not match the context it claims.');

    const completed = state.pipeline?.find(r => r.kind === 'STAGE_COMPLETION' && r.assignmentId === assignment.id);
    if (completed) {
      if (completed.kind !== 'STAGE_COMPLETION' || completed.reportHash !== sha256)
        throw new Error('Conflicting stage completion report.');
      return { state, detail: 'This exact stage report is already durably collected.' };
    }
    let harness: SignedResearchClaim | undefined;
    if (this.runtime) {
      const intent = this.store.beginHarness(assignment.id, sha256);
      const receipt = intent.existing
        ? await this.runtime.reconcileHarness?.(intent.operationId)
        : await this.runtime.evaluate({
            operationId: intent.operationId,
            assignment,
            job,
            reportHash: sha256,
            reportBytes: bytes,
          });
      if (!receipt)
        throw new Error(
          'Independent harness execution is unresolved. Reconcile the existing operation before collection; it will not be submitted again.',
        );
      harness = receipt;
    }
    const harnessGates = harness?.claim.kind === 'HARNESS' ? harness.claim.gates : null;
    this.store.recordResearchGates({
      branchId: branch.id,
      expectedRevision: branch.revision,
      assignmentId: assignment.id,
      completion: { reportHash: sha256, bytes, harness },
      // Outcomes are recorded verbatim. A harness receipt promotes receipts to SIGNED_HARNESS;
      // without one they stay REVIEWER_ASSERTED — the tier is labelled, never rewritten (section 1.6).
      receipts: (harnessGates ?? report.gates).map(gate => ({
        id: randomUUID(),
        branchId: branch.id,
        stage: research.stage,
        gate: gate.gate,
        outcome: gate.outcome,
        subjectHash: research.subjectHash,
        specId: research.specId,
        detail: gate.detail,
        rationale: gate.rationale,
        evidenceRef: sha256,
        createdAt: this.now(),
      })),
    });

    return {
      state: this.store.snapshot({ history: false }),
      detail: `Collected the ${research.stage} report for ${branch.name}: ${report.gates.length} gate outcome${report.gates.length === 1 ? '' : 's'} recorded against this exact subject.`,
    };
  }

  /**
   * Settles the S7 disagreement from the two reports that were actually filed.
   *
   * The reports are located by the function that wrote them, not by submission order. An advocate
   * and skeptic who both filed, on the same subject and spec, are what the adjudicator may weigh;
   * anything else is a reason to wait.
   */
  private adjudicate(action: Extract<PipelineAction, { type: 'adjudicate' }>): PipelineResult {
    const state = this.store.adjudicateResearch(action);
    const record = state.pipeline?.filter(r => r.kind === 'ADJUDICATION' && r.branchId === action.branchId).at(-1);
    return { state, detail: record?.kind === 'ADJUDICATION' ? record.detail : 'Adjudication already recorded.' };
  }

  private async rebuttal(action: Extract<PipelineAction, { type: 'rebuttal' }>): Promise<PipelineResult> {
    const state = this.store.snapshot({ history: false }),
      assignment = state.assignments?.find(a => a.id === action.assignmentId);
    if (!assignment) throw new Error('Reviewer assignment not found.');
    if (state.pipeline?.some(r => r.kind === 'REBUTTAL' && r.assignmentId === assignment.id))
      return { state, detail: 'The bounded rebuttal is already recorded.' };
    if (action.artifactId) {
      // Separated tier: the bounded response arrives as imported bytes and binds the durable intent.
      this.store.beginRebuttal(assignment.id);
      const artifact = state.artifacts.find(a => a.id === action.artifactId && a.projectId === assignment.projectId);
      if (!artifact) throw new Error('Import the bounded response artifact into this project first.');
      const bytes = await this.readObject(artifact.sha256);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256 || bytes.byteLength > 20000)
        throw new Error('Rebuttal bytes are unavailable, corrupt or exceed the bounded size.');
      this.store.recordResearchRebuttal({
        assignmentId: assignment.id,
        reportHash: artifact.sha256,
        bytes,
        proof: null,
      });
      return {
        state: this.store.snapshot({ history: false }),
        detail:
          'Recorded the bounded rebuttal for this exact round, labelled office-bound rather than independently attested.',
      };
    }
    if (!this.runtime?.rebuttal || !this.io)
      throw new Error(
        'Independent post-disclosure review transport is unavailable. Import the bounded response artifact instead.',
      );
    const intent = this.store.beginRebuttal(assignment.id),
      firstReports = [];
    for (const hash of intent.firstReportHashes) {
      const bytes = await this.readObject(hash);
      if (!bytes || createHash('sha256').update(bytes).digest('hex') !== hash)
        throw new Error('First report bytes are unavailable or corrupt.');
      firstReports.push({ hash, bytes });
    }
    const result = intent.existing
      ? await this.runtime.reconcileRebuttal?.(intent.operationId)
      : await this.runtime.rebuttal({
          operationId: intent.operationId,
          assignment,
          firstReports,
          maximumCharacters: 4000,
        });
    if (!result) throw new Error('Rebuttal execution is unresolved; reconcile it without resubmitting.');
    if (result.bytes.byteLength > 20000) throw new Error('Rebuttal exceeds the bounded output size.');
    const stored = await this.io.writeObject(result.bytes);
    this.store.recordResearchRebuttal({
      assignmentId: assignment.id,
      reportHash: stored.sha256,
      bytes: result.bytes,
      proof: result.proof,
    });
    return {
      state: this.store.snapshot({ history: false }),
      detail: 'Recorded the bounded rebuttal for this exact round.',
    };
  }

  /**
   * S3: freezes the run package and opens the durable user-wait. The builder is a build seam — the
   * office does not run the experiment, connect to Colab, or poll anything; it hands the user a
   * package whose identity the return must name byte-for-byte.
   */
  private async exportRunPackage(
    action: Extract<PipelineAction, { type: 'exportRunPackage' }>,
  ): Promise<PipelineResult> {
    const state = this.store.snapshot({ history: false });
    const branch = this.branch(state, action.branchId, action.expectedRevision);
    if (branch.stage !== 'S3') throw new Error('Run-package export belongs to S3.');
    const link = this.branchLink(state, branch.id);
    const spec = state.specs?.find(s => s.id === branch.specId);
    if (!spec?.frozen) throw new Error('A frozen specification is required before export.');
    if (!this.io) throw new Error('Package object storage is not configured in this build.');
    if (!this.packages.build) throw new Error('Run-package authoring is not configured in this build.');
    const built = await this.packages.build.build({ state, branch, link, spec, readObject: this.readObject });
    const object = await this.io.writeObject(built.bytes);
    const result = this.store.recordRunPackage({
      branchId: branch.id,
      expectedRevision: branch.revision,
      manifest: built.manifest,
      objectHash: object.sha256,
    });
    const destination = await this.io.exportPackage?.(built.bytes, built.manifest.packageId);
    return {
      state: this.store.snapshot({ history: false }),
      detail:
        (result.existing
          ? 'This exact run package is already exported; the branch is still waiting for its return.'
          : `Exported run package ${built.manifest.packageId}. The branch now waits for the manual user run; no execution job exists anywhere.`) +
        (destination ? ` Written to ${destination}.` : ''),
    };
  }

  /**
   * S3: binds an imported returned bundle to the awaiting package. The inspector parses and hashes
   * the archive; the store re-checks the binding, completeness and duplicates before admitting it
   * as user-run evidence — never provider-reported, never independently attested.
   */
  private async importRunReturn(action: Extract<PipelineAction, { type: 'importRunReturn' }>): Promise<PipelineResult> {
    if (!this.io || !this.packages.inspect)
      throw new Error('Return-bundle validation is not configured in this build.');
    const state = this.store.snapshot({ history: false });
    const branch = this.branch(state, action.branchId, action.expectedRevision);
    const pkg = (state.pipeline ?? [])
      .filter(r => r.kind === 'RUN_PACKAGE' && r.branchId === branch.id && r.branchRevision === branch.revision)
      .at(-1);
    // A RETURNED package still accepts imports: the store makes the identical manifest idempotent
    // and refuses a conflicting one — the duplicate check must not be pre-empted by the wait state.
    if (!pkg || pkg.kind !== 'RUN_PACKAGE' || pkg.state === 'SUPERSEDED')
      throw new Error('No awaiting run package exists for this branch revision.');
    const artifact = state.artifacts.find(a => a.id === action.artifactId && a.projectId === branch.projectId);
    if (!artifact) throw new Error('Import the returned bundle into this project first.');
    const bytes = await this.readObject(artifact.sha256);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error('Returned bundle identity mismatch.');
    const inspection = this.packages.inspect.inspect({
      bytes,
      expect: { packageId: pkg.packageId, packageHash: pkg.packageHash },
    });
    for (const object of inspection.objects) await this.io.writeObject(object.bytes);
    this.store.admitRunReturn({
      branchId: branch.id,
      expectedRevision: branch.revision,
      artifactId: artifact.id,
      manifest: inspection.manifest,
      manifestHash: inspection.manifestHash,
      outputHashes: inspection.objects.map(o => o.sha256),
    });
    return { state: this.store.snapshot({ history: false }), detail: inspection.summary };
  }

  /**
   * The manual counterpart of `collect`: a stage report the user carried back, admitted against the
   * exact assignment context with USER_IMPORTED provenance rather than a provider observation.
   */
  private async importStageReport(
    action: Extract<PipelineAction, { type: 'importStageReport' }>,
  ): Promise<PipelineResult> {
    const state = this.store.snapshot({ history: false });
    const assignment = (state.assignments ?? []).find(a => a.id === action.assignmentId);
    if (!assignment?.research) throw new Error('This assignment carries no research context.');
    const artifact = state.artifacts.find(a => a.id === action.artifactId && a.projectId === assignment.projectId);
    if (!artifact) throw new Error('Import the stage report into this project first.');
    const bytes = await this.readObject(artifact.sha256);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error('Imported report identity mismatch.');
    this.store.admitImportedStageReport({ assignmentId: assignment.id, reportHash: artifact.sha256, bytes });
    return {
      state: this.store.snapshot({ history: false }),
      detail: 'Admitted the imported stage report for this exact context with user-imported provenance.',
    };
  }

  /** Office stages validate the bound evidence already admitted — return, custody, monitoring. */
  private validateReturn(action: Extract<PipelineAction, { type: 'validateReturn' }>): PipelineResult {
    this.store.validateOfficeStage({ branchId: action.branchId, expectedRevision: action.expectedRevision });
    const state = this.store.snapshot({ history: false });
    const branch = (state.branches ?? []).find(b => b.id === action.branchId);
    return {
      state,
      detail: `${branch?.stage ?? 'The stage'} validated against the bound admitted evidence and completed with office-validated provenance.`,
    };
  }

  /** Shadow thresholds are committed before the specification freezes, never after. */
  private shadowPolicy(action: Extract<PipelineAction, { type: 'shadowPolicy' }>): PipelineResult {
    const state = this.store.snapshot({ history: false });
    const branch = this.branch(state, action.branchId, action.expectedRevision);
    if (!branch.specId) throw new Error('Draft this branch’s specification before setting shadow thresholds.');
    const policy = { ...action.policy, thresholdHash: canonicalHash(action.policy) };
    this.store.recordPipeline({
      id: randomUUID(),
      projectId: branch.projectId,
      branchId: branch.id,
      createdAt: this.now(),
      kind: 'SHADOW_POLICY',
      specId: branch.specId,
      policy,
    });
    return {
      state: this.store.snapshot({ history: false }),
      detail:
        'Shadow thresholds recorded against the draft specification. They freeze with it and cannot be revised after the numbers are seen.',
    };
  }
  private async shadowIngest(
    action: Extract<PipelineAction, { type: 'shadowIngest' | 'monitor' }>,
  ): Promise<PipelineResult> {
    const state = this.store.snapshot({ history: false }),
      branch = this.branch(state, action.branchId, action.expectedRevision);
    const admitted = (state.pipeline ?? []).filter(
      (r): r is Extract<NonNullable<AppState['pipeline']>[number], { kind: 'SHADOW_BATCH' }> =>
        r.kind === 'SHADOW_BATCH' && r.branchId === branch.id && r.specId === branch.specId,
    );
    const artifact =
      action.type === 'shadowIngest'
        ? state.artifacts.find(a => a.id === action.artifactId && a.projectId === branch.projectId)
        : null;
    if (action.type === 'shadowIngest' && !artifact)
      throw new Error('Import a shadow batch artifact in this project first.');
    if (artifact && admitted.some(r => r.sourceHash === artifact.sha256))
      return { state, detail: 'This exact shadow batch is already durably ingested.' };
    const now = this.now(),
      sources = [
        ...admitted.map(r => ({ sourceHash: r.sourceHash, receivedAt: r.createdAt })),
        ...(artifact ? [{ sourceHash: artifact.sha256, receivedAt: now }] : []),
      ];
    const documents = [];
    for (const source of sources) {
      const bytes = await this.readObject(source.sourceHash);
      if (!bytes || bytes.byteLength > 32 * 1024 * 1024)
        throw new Error('Shadow batch bytes are missing or exceed the bounded import size.');
      documents.push({ ...source, bytes });
    }
    this.store.recordShadow({
      branchId: branch.id,
      expectedRevision: branch.revision,
      ...(artifact ? { artifactId: artifact.id } : {}),
      documents,
      now,
    });
    return {
      state: this.store.snapshot({ history: false }),
      detail:
        'Shadow evidence and monitoring standing recorded. Imported executions remain separately user-attested; qualification still requires an independent G-SHADOW receipt.',
    };
  }

  /**
   * Spends one holdout allowance on this exact candidate.
   *
   * The journal — not this database — decides whether the allowance is spent, and the journal entry
   * is written before anything else moves. The store record made afterwards is the reservation's
   * receipt inside the workspace; restoring an old backup cannot un-spend what the journal saw.
   */
  private async holdoutReserve(action: Extract<PipelineAction, { type: 'holdoutReserve' }>): Promise<PipelineResult> {
    if (!this.custody)
      throw new Error(
        'No holdout custody is configured in this build. S8 stays blocked rather than improvising custody.',
      );
    const state = this.store.snapshot({ history: false });
    const branch = this.branch(state, action.branchId);
    if (branch.stage !== 'S8')
      throw new Error('Holdout reservation belongs to S8, after independently verified gates and adjudication.');
    const blocker = this.store.researchStageBlocker(branch.stage);
    if (blocker) throw new Error(blocker);
    const link = this.branchLink(state, branch.id);
    const record = (state.pipeline ?? [])
      .filter(item => item.kind === 'HOLDOUT' && item.holdout.id === action.holdoutId)
      .at(-1);
    if (!record || record.kind !== 'HOLDOUT') throw new Error('Register this holdout before reserving against it.');
    const adjudication = (state.pipeline ?? [])
      .filter(
        item =>
          item.kind === 'ADJUDICATION' &&
          item.branchId === branch.id &&
          item.specId === branch.specId &&
          item.subjectHash === link.subjectHash,
      )
      .at(-1);
    if (!action.queryArtifactId)
      throw new Error('Freeze an exact prediction query artifact before holdout reservation.');
    const predictions = await this.holdoutQuery(action.queryArtifactId, branch.projectId);
    const latest = this.store.snapshot({ history: false });
    if (this.branch(latest, branch.id).revision !== branch.revision)
      throw new Error('Branch changed before holdout reservation.');
    this.store.assertHoldoutPrerequisites(branch.id, branch.revision, action.refitHash);
    this.custody.reconcileAfterRestore(
      (latest.pipeline ?? [])
        .filter(r => r.kind === 'RESERVATION')
        .map(r => (r.kind === 'RESERVATION' ? r.reservation.id : '')),
    );
    const { reservation } = this.custody.reserve({
      holdout: record.holdout,
      lineageId: branch.lineageId,
      branchId: branch.id,
      candidateHash: link.subjectHash,
      refitHash: action.refitHash,
      queryHash: canonicalHash(predictions),
      gates: (state.receipts ?? [])
        .filter(
          item => item.branchId === branch.id && item.subjectHash === link.subjectHash && item.specId === branch.specId,
        )
        .map(item => ({ gate: item.gate, outcome: item.outcome })),
      adjudication: adjudication?.kind === 'ADJUDICATION' ? adjudication.outcome : null,
    });
    this.store.recordPipeline({
      id: randomUUID(),
      projectId: branch.projectId,
      branchId: branch.id,
      createdAt: this.now(),
      kind: 'RESERVATION',
      reservation,
    });
    return {
      state: this.store.snapshot({ history: false }),
      reservation,
      detail: `Reserved holdout ${record.holdout.name} for this candidate in ${reservation.period}. The allowance is spent from this moment, whether or not a report ever comes back.`,
    };
  }
  private async holdoutQuery(artifactId: string, projectId: string) {
    const artifact = this.store
      .snapshot({ history: false })
      .artifacts.find(a => a.id === artifactId && a.projectId === projectId);
    if (!artifact) throw new Error('Prediction query artifact does not belong to this project.');
    const bytes = await this.readObject(artifact.sha256);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error('Prediction query bytes are unavailable.');
    const rows = z
      .array(z.object({ rowId: z.string().min(1).max(240), prediction: z.number().finite() }).strict())
      .min(1)
      .max(100000)
      .parse(parseStrictJson(Buffer.from(bytes).toString('utf8')));
    if (new Set(rows.map(r => r.rowId)).size !== rows.length) throw new Error('Holdout query has duplicate rows.');
    return rows;
  }
  private reservation(state: AppState, branchId: string, reservationId: string) {
    const record = state.pipeline
      ?.filter(r => r.kind === 'RESERVATION' && r.branchId === branchId && r.reservation.id === reservationId)
      .at(-1);
    if (!record || record.kind !== 'RESERVATION') throw new Error('Reservation not found in this branch.');
    const registration = state.pipeline?.find(
      r => r.kind === 'HOLDOUT' && r.holdout.id === record.reservation.holdoutId,
    );
    if (!registration || registration.kind !== 'HOLDOUT') throw new Error('Registered holdout not found.');
    return { reservation: record.reservation, holdout: registration.holdout };
  }
  private async holdoutRegister(action: Extract<PipelineAction, { type: 'holdoutRegister' }>): Promise<PipelineResult> {
    if (!this.io || !this.custody) throw new Error('Custody import is not configured.');
    const branch = this.branch(this.store.snapshot({ history: false }), action.branchId);
    const bytes = await this.io.selectHoldout();
    if (!bytes) return { state: this.store.snapshot({ history: false }), detail: 'Holdout registration canceled.' };
    if (!bytes.length) throw new Error('An empty file is not a holdout.');
    const current = this.branch(this.store.snapshot({ history: false }), branch.id, branch.revision);
    const holdout = this.custody.register({
      projectId: current.projectId,
      name: action.name,
      bytes,
      timezoneOffsetMinutes: action.timezoneOffsetMinutes,
      allowancePerPeriod: action.allowancePerPeriod,
    });
    this.store.recordPipeline({
      id: randomUUID(),
      projectId: branch.projectId,
      branchId: branch.id,
      createdAt: this.now(),
      kind: 'HOLDOUT',
      holdout,
    });
    return {
      state: this.store.snapshot({ history: false }),
      detail:
        'Registered bytes in separate custody storage. Live isolation is not established by this import. ' +
        this.custody.status.detail,
    };
  }
  private async holdoutEvaluate(action: Extract<PipelineAction, { type: 'holdoutEvaluate' }>): Promise<PipelineResult> {
    if (!this.custody || !this.io) throw new Error('Isolated holdout evaluator is not configured.');
    const state = this.store.snapshot({ history: false }),
      branch = this.branch(state, action.branchId),
      { reservation, holdout } = this.reservation(state, branch.id, action.reservationId);
    const predictions = await this.holdoutQuery(action.queryArtifactId, branch.projectId);
    if (reservation.queryHash !== canonicalHash(predictions))
      throw new Error('A changed query is a new holdout exposure.');
    if (reservation.state === 'EXPOSED' && reservation.reportHash) {
      this.custody.fetchReport(reservation, {
        reportHash: reservation.reportHash,
        candidateHash: reservation.candidateHash,
      });
      return {
        state: this.store.snapshot({ history: false }),
        reservation,
        detail: 'Returning the same completed custody report without another exposure.',
      };
    }
    this.store.assertHoldoutPrerequisites(branch.id, branch.revision, reservation.refitHash);
    try {
      const evaluated = await this.custody.evaluate(reservation, holdout, predictions);
      const result = z
        .object({
          reportHash: z.string().regex(/^[a-f0-9]{64}$/),
          metric: z.string().max(200),
          value: z.number().finite().nullable(),
          samples: z.number().int().nonnegative(),
          detail: z.string().max(4000),
        })
        .strict()
        .parse(evaluated.result);
      const bytes = Buffer.from(JSON.stringify(result)),
        object = await this.io.writeObject(bytes);
      this.store.recordHoldoutResult({
        branchId: branch.id,
        expectedRevision: branch.revision,
        reservation: evaluated.reservation,
        queryHash: reservation.queryHash,
        object,
        result,
        verification: this.custody.status.verification,
      });
      return {
        state: this.store.snapshot({ history: false }),
        reservation: evaluated.reservation,
        detail:
          'Stored the completed isolated evaluation. S8 still requires its independently admitted G-INTEGRITY stage report.',
      };
    } catch (error) {
      this.store.recordPipeline({
        id: randomUUID(),
        projectId: branch.projectId,
        branchId: branch.id,
        createdAt: this.now(),
        kind: 'RESERVATION',
        reservation: {
          ...reservation,
          state: 'UNKNOWN',
          detail: 'Evaluation or result delivery failed; exposure is spent and must be reconciled.',
        },
      });
      throw error;
    }
  }
  private async holdoutImport(action: Extract<PipelineAction, { type: 'holdoutImport' }>): Promise<PipelineResult> {
    if (!this.custody || !this.io) throw new Error('Custody import is unavailable.');
    const state = this.store.snapshot({ history: false }),
      branch = this.branch(state, action.branchId),
      { reservation } = this.reservation(state, branch.id, action.reservationId);
    const artifact = state.artifacts.find(a => a.id === action.artifactId && a.projectId === branch.projectId);
    if (!artifact || artifact.size > 1024 * 1024) throw new Error('Select a bounded imported custody report artifact.');
    const bytes = await this.readObject(artifact.sha256);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error('Imported report identity mismatch.');
    const body = z
      .object({
        reservationId: z.string().uuid(),
        candidateHash: z.string(),
        refitHash: z.string(),
        queryHash: z.string(),
        result: z
          .object({
            metric: z.string().max(200),
            value: z.number().finite().nullable(),
            samples: z.number().int().nonnegative(),
            detail: z.string().max(4000),
          })
          .strict(),
      })
      .strict()
      .parse(parseStrictJson(Buffer.from(bytes).toString('utf8')));
    if (
      body.reservationId !== reservation.id ||
      body.candidateHash !== reservation.candidateHash ||
      body.refitHash !== reservation.refitHash ||
      body.queryHash !== reservation.queryHash
    )
      throw new Error('Manual report names a different candidate, refit or query.');
    const prior = state.pipeline?.find(r => r.kind === 'HOLDOUT_RESULT' && r.reservationId === reservation.id);
    if (prior) {
      if (prior.kind !== 'HOLDOUT_RESULT' || prior.reportHash !== artifact.sha256)
        throw new Error('Conflicting manual custody report.');
      return { state, detail: 'This exact user-attested report is already recorded.' };
    }
    if (
      this.custody
        .journal()
        .filter(e => e.reservationId === reservation.id)
        .at(-1)?.kind !== 'EXPORTED'
    )
      throw new Error('The non-restorable journal does not attest this manual export.');
    const settled = {
      ...reservation,
      state: 'EXPOSED' as const,
      reportHash: artifact.sha256,
      settledAt: this.now(),
      detail: 'User-attested manual return; exposure remains spent.',
    };
    this.store.recordHoldoutResult({
      branchId: branch.id,
      expectedRevision: branch.revision,
      reservation: settled,
      queryHash: body.queryHash,
      object: { sha256: artifact.sha256, bytes: bytes.byteLength },
      result: { ...body.result, reportHash: artifact.sha256 },
      verification: 'USER_IMPORTED',
    });
    return {
      state: this.store.snapshot({ history: false }),
      detail: 'Manual report imported as user-attested evidence. It cannot authorize G-INTEGRITY.',
    };
  }
  private async holdoutExport(action: Extract<PipelineAction, { type: 'holdoutExport' }>): Promise<PipelineResult> {
    if (!this.custody || !this.io) throw new Error('Manual custody export is unavailable.');
    const state = this.store.snapshot({ history: false }),
      branch = this.branch(state, action.branchId),
      scope = this.reservation(state, branch.id, action.reservationId);
    this.store.assertHoldoutPrerequisites(branch.id, branch.revision, scope.reservation.refitHash);
    const exported = this.custody.exportPackage(scope.reservation, scope.holdout);
    this.store.recordPipeline({
      id: randomUUID(),
      projectId: branch.projectId,
      branchId: branch.id,
      createdAt: this.now(),
      kind: 'RESERVATION',
      reservation: exported.reservation,
    });
    await this.io.exportHoldout(exported.bytes);
    return {
      state: this.store.snapshot({ history: false }),
      reservation: exported.reservation,
      detail: exported.classification,
    };
  }
}
