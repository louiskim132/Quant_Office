import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AdapterRoute, Agent, Assignment, AppState, Effort, InputSnapshot, JobEvent, JobOutput, Provider, ProviderJob } from '../shared/types.js';
import { canonicalHash } from '../core/canonical.js';
import { isTerminalJob, reconciliationPlan } from '../core/jobs.js';
import { assertHostedExecution, assertWorkerCapacity } from '../core/guards.js';
import type { OfficeStore } from '../core/store.js';
import { agentDispatchReadiness, currentConnection, effectiveEvidence, latestCapability, scopeMismatches, supplyingSnapshotIds, type RequestedScope } from '../shared/readiness.js';
import { dependencyStatus } from '../shared/cooperation.js';
import { verifySnapshotForTransfer, type OutputDestination } from './locations.js';
import { safeEntry, MAX_FILE } from './artifacts.js';
import { pipelineStageBlocker, type FrozenResearchSpec } from '../shared/research.js';
import { stageContextHash } from '../shared/pipeline.js';

/**
 * The complete text one external action would deliver, assembled once and reviewable before launch.
 *
 * The objective alone is not the contract: acceptance criteria say when the work is done, and the
 * profile's instructions say how it must be carried out. An adapter that ships only the objective is
 * delivering something the user never approved, so the payload is built in one place and the preview
 * and the launch both read it.
 */
export interface ProviderPayload {
  requestName: string; objective: string; acceptanceCriteria: string; instructions: string;
  model: string; effort: Effort; delegation: boolean;
  research?: Assignment['research']; researchSpec?: FrozenResearchSpec;
  /** The exact bytes an adapter must transmit, so what was previewed can be compared to what was sent. */
  text: string;
}

export function buildProviderPayload(frozen: Omit<ProviderPayload, 'text'>): ProviderPayload {
  if(frozen.research&&['S2','S7'].includes(frozen.research.stage))frozen={...frozen,
    requestName:`${frozen.research.stage} independent review`,objective:'Review only the independently admitted packet in this isolated context. Commit one complete first report before reading any other review.',
    acceptanceCriteria:'Return the exact stage report contract. Missing evidence must be reported as blocked.',instructions:'Do not read other requests, contexts, reports, caches or external resources.',delegation:false,
    ...(frozen.research.stage==='S2'?{researchSpec:undefined}:{})};
  const sections = [
    `# ${frozen.requestName}`,
    `## Objective\n${frozen.objective.trim()}`,
    frozen.acceptanceCriteria.trim() ? `## Acceptance criteria\n${frozen.acceptanceCriteria.trim()}` : '',
    frozen.instructions.trim() ? `## Standing instructions\n${frozen.instructions.trim()}` : '',
    frozen.research ? `## Research stage context\n${JSON.stringify(frozen.research)}` : '',
    frozen.researchSpec ? `## Frozen research specification\n${JSON.stringify(frozen.researchSpec)}` : '',
    frozen.research ? '## Stage report contract\nReturn research-stage-report@1 JSON with schemaVersion 1, branchId, specId, subjectHash, stage and contextHash exactly as recorded above, a gates array (gate, outcome, detail, rationale), and detail. Review reports also require verdict and defectFound. Provider-written verdicts are unverified claims, not independent gate approval.' : '',
    `## Execution policy\nDelegation is ${frozen.delegation ? 'authorized for this request' : 'not authorized'}. Do not install packages or use the network.`,
  ].filter(Boolean);
  return { ...frozen, text: sections.join('\n\n') };
}

export interface SubmitContext { assignment: Assignment; snapshot: InputSnapshot; objective: string; requestName: string; payload: ProviderPayload }
export interface SubmitResult { externalId: string; externalUrl: string; detail: string; resolvedModel?: string; appliedEffort?: Effort | 'UNVERIFIED' }
export interface ObserveResult {
  state: 'ACCEPTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN'; detail: string;
  events?: Omit<JobEvent, 'id' | 'jobId'>[];
  /** What the provider says exists. Metadata, not bytes: a hash here certifies nothing on its own. */
  outputs?: { path: string; sha256: string; bytes: number }[];
  /**
   * Whose account this state came from.
   *
   * Only an adapter that actually heard from the provider may claim PROVIDER_REPORTED. An adapter
   * describing its own inability to observe is speaking locally, and saying so is the difference
   * between evidence and silence. Defaults to local for UNKNOWN, which is the safe reading.
   */
  provenance?: 'PROVIDER_REPORTED' | 'OFFICE_LOCAL';
}

/** Fetches the bytes an output claims to be, so a deliverable is never certified by a hash alone. */
export interface OutputFetcher {
  (job: ProviderJob, output: { path: string; sha256: string; bytes: number }): Promise<Uint8Array>;
}

/**
 * The only way the office may talk to a provider.
 *
 * Implementations live in the main process and receive typed values, never renderer strings, shell
 * commands or CLI arguments. `submit` may throw or time out; the controller then records Unknown
 * rather than assuming either outcome.
 */
export interface ProviderAdapter {
  /** Implementations must actually deliver into the independently attested context ID. */
  readonly isolatedContexts?:true;
  readonly route: AdapterRoute;
  /** Which providers this adapter can actually reach. Omitted means the route's default below. */
  readonly providers?: readonly Provider[];
  submit(context: SubmitContext): Promise<SubmitResult>;
  observe(job: ProviderJob): Promise<ObserveResult>;
  cancel(job: ProviderJob): Promise<{ acknowledged: boolean; detail: string }>;
}

/** Everything one external action needs, gathered and validated together by `launchGuard`. */
interface LaunchContext {
  state: AppState; assignment: Assignment; agent: AppState['agents'][number];
  request: NonNullable<AppState['requests']>[number]; frozen: NonNullable<Assignment['frozen']>;
  snapshot: InputSnapshot; connection: NonNullable<AppState['connections']>[number]; now: number;
}

export class UnknownDispatchError extends Error {
  constructor(message: string) { super(message); this.name = 'UnknownDispatchError'; }
}

/**
 * Owns the single-agent lifecycle: freeze, dispatch, observe, cancel, reconcile.
 * Every state change goes through the store, so the queue and the UI read one projection.
 */
export class AssignmentController {
  constructor(
    private readonly store: OfficeStore,
    private readonly adapter: ProviderAdapter,
    private readonly now: () => string = () => new Date().toISOString(),
    /** The frozen-input check the transfer path runs. Injectable so tests can drive its failures. */
    private readonly verifyTransfer: (snapshot: InputSnapshot) => Promise<string[]> = verifySnapshotForTransfer,
    /**
     * Records a fresh official account observation. Called inside this class before every external
     * action, so a future caller cannot reach a launch path that skipped it. Omitted in tests that
     * drive the fake adapter, where there is no official tool to ask.
     */
    private readonly refreshAccount?: (provider: Provider) => Promise<void>,
    /**
     * Rebuilds a missing staging directory from the workspace's stored objects.
     *
     * Staging is disposable and a restore does not carry it, so the first launch after one would
     * otherwise fail against inputs the workspace still holds the bytes for. Reconstruction never
     * reads the original source folder, and a snapshot with no stored bytes stays unreconstructable.
     */
    private readonly recoverStaging?: (snapshot: InputSnapshot) => Promise<string>,
    /** Retrieves the actual bytes of a reported output. Absent means this route cannot retrieve them. */
    private readonly fetchOutput?: OutputFetcher,
    /** Persists verified output bytes into managed content-addressed storage. */
    private readonly storeOutput?: (sha256: string, bytes: Uint8Array, job: ProviderJob, output: JobOutput) => Promise<void>,
    private readonly prepareOutputs?: (assignment: Assignment, snapshot: InputSnapshot) => OutputDestination,
    /**
     * Resolves which adapter carries a piece of work. At preparation time it is asked for the agent;
     * after that the recorded route is the durable fact, so it is asked for the route instead. When
     * configured, a miss is a hard failure — there is never a silent fallback to another route.
     */
    private readonly adapters?: (ref: { agent?: Agent; route?: AdapterRoute }) => ProviderAdapter | undefined,
  ) {}

  /** One clock for gates and records, so evidence freshness never depends on the wall calendar. */
  private nowMs(): number { return Date.parse(this.now()); }

  private adapterFor(ref: { agent?: Agent; route?: AdapterRoute }): ProviderAdapter {
    if (!this.adapters) return this.adapter;
    const adapter = this.adapters(ref);
    if (!adapter) throw new Error(`No adapter is configured for ${ref.route ? `the ${ref.route.toLowerCase().replaceAll('_', ' ')} route` : `${ref.agent?.provider ?? 'this provider'} work`}. Configure a supported route or use a handoff.`);
    return adapter;
  }

  /** Freezes the exact inputs for one request and records the intent to submit. */
  prepare(input: { requestId: string; agentId: string; snapshotId: string; expectedRequestRevision?: number; expectedAgentRevision?: number; dependsOn?: string[]; research?: Assignment['research'] }): { state: AppState; assignment: Assignment } {
    const state = this.store.snapshot({history:false});
    const request = state.requests?.find(item => item.id === input.requestId);
    if (!request) throw new Error('Request not found.');
    const agent = state.agents.find(item => item.id === input.agentId);
    if (!agent) throw new Error('Agent not found.');
    this.assertLifecycle(state, request, agent);
    // The caller freezes the versions it actually showed the user; a concurrent edit must not be swept in.
    if (input.expectedRequestRevision !== undefined && input.expectedRequestRevision !== request.revision) throw new Error('The request changed in another view. Reload before starting it.');
    if (input.expectedAgentRevision !== undefined && input.expectedAgentRevision !== (agent.revision ?? 0)) throw new Error('The profile changed in another view. Reload before starting it.');
    if (request.mode === 'SINGLE' && request.participantIds.filter(id => id !== input.agentId).length)
      throw new Error('A single-agent request cannot carry collaborators.');
    const snapshot = state.snapshots?.find(item => item.id === input.snapshotId);
    if (!snapshot) throw new Error('Prepare the request inputs first.');
    if (snapshot.projectId !== request.projectId) throw new Error('That input snapshot belongs to a different project.');
    const gate = agentDispatchReadiness(state, agent, { now: this.nowMs() });
    if (!gate.binding.available) throw new Error(gate.binding.blockers[0] ?? 'This profile is not usable in the current account context.');
    const connection = currentConnection(state, agent.provider);
    const capability = connection ? latestCapability(state, connection.id) : undefined;
    if (!connection || !capability) throw new Error('Check the provider account before preparing work.');
    // The agent picks the route once, here; everything after reads the recorded route.
    const adapter = this.adapterFor({ agent });
    const assignment: Assignment = {
      id: randomUUID(), projectId: request.projectId, requestId: request.id, requestRevision: request.revision,
      agentId: agent.id, agentRevision: agent.revision ?? 0, connectionId: connection.id, capabilitySnapshotId: capability.id,
      snapshotId: snapshot.id, route: adapter.route, requestedModel: agent.model, resolvedModel: '',
      capabilitySnapshotIds: supplyingSnapshotIds(state, {
        provider: agent.provider, identity: connection.identity, credentialContext: connection.credentialContext,
        toolVersion: capability.toolVersion, route: adapter.route, environment: capability.environment,
        model: agent.model, effort: agent.effort ?? 'default', delegation: request.delegation,
      }, { now: this.nowMs() }),
      requestedEffort: agent.effort ?? 'default', appliedEffort: 'UNVERIFIED', delegation: request.delegation,
      objectiveHash: canonicalHash({ objective: request.objective, criteria: request.acceptanceCriteria }),
      // The exact text the adapter will receive, captured now. Launch uses this and never re-reads
      // the request, so a later edit cannot ride along with these frozen inputs and this binding.
      frozen: {
        requestName: request.name, objective: request.objective, acceptanceCriteria: request.acceptanceCriteria,
        instructions: agent.instructions, model: agent.model, effort: agent.effort ?? 'default', delegation: request.delegation,
        accountIdentity: connection.identity, credentialContext: connection.credentialContext,
        outputFolder: state.locations?.find(item => item.projectId === request.projectId)?.outputFolder ?? '',
      },
      createdAt: this.now(),
      ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
      // The staged-scientific context is part of what is frozen; the store re-validates it against
      // the recorded link, so a caller cannot name a stage or subject the branch is not on.
      ...(input.research ? { research: input.research } : {}),
    };
    this.prepareOutputs?.(assignment, state.snapshots!.find(item => item.id === assignment.snapshotId)!);
    const next = this.store.createAssignment({
      assignment,
      job: { id: randomUUID(), assignmentId: assignment.id, projectId: assignment.projectId, requestId: assignment.requestId, provider: agent.provider, route: adapter.route },
    });
    return { state: next, assignment };
  }

  /**
   * The status checks every external path needs, not only creation.
   *
   * A request can be canceled, or its project archived, at any point after preparation. Checking
   * only at creation means a canceled request can still be launched from a window opened earlier.
   */
  private assertLifecycle(state: AppState, request: { id: string; projectId: string; status: string; participantIds: string[]; leadAgentId: string | null; mode: string }, agent: { id: string; removedAt?: string; name: string }): void {
    const project = state.projects.find(item => item.id === request.projectId);
    if (!project) throw new Error('Project not found.');
    if (project.archived) throw new Error('This project is archived. Restore it before starting work.');
    if (request.status === 'CANCELED') throw new Error('This request was canceled. Duplicate it if the work is still wanted.');
    if (agent.removedAt) throw new Error(`${agent.name} is archived. Restore the profile before using it.`);
    // A single-agent request has a closed roster by definition. Group and team work deliberately
    // draws in agents who are not listed participants - a reviewer must not be the author - but that
    // explains who may be added, it does not authorize everyone: an unlisted agent needs an explicit
    // grant recorded against this request.
    if (request.mode === 'SINGLE') {
      if (request.leadAgentId !== agent.id)
        throw new Error(`${agent.name} is not the agent this single-agent request was assigned to.`);
    } else {
      const listed = request.leadAgentId === agent.id || request.participantIds.includes(agent.id);
      const granted = (state.grants ?? []).some(grant => grant.requestId === request.id && grant.agentId === agent.id && !grant.revokedAt);
      if (!listed && !granted)
        throw new Error(`${agent.name} is neither listed on this request nor granted a role on it. Record an explicit grant before assigning this work.`);
    }
  }

  /**
   * Every check that must hold before an external action, gathered in one place.
   *
   * dispatch and handoff previously each assembled their own subset, which is how the handoff path
   * ended up with no provider/route check at all: a profile bound to OpenAI could reach the default
   * Claude terminal adapter. This runs for both, and is re-run after every await, because each await
   * is a window in which a request can be canceled, a project archived or a profile rebound.
   */
  private launchGuard(assignmentId: string, kind: 'DISPATCH' | 'HANDOFF'): LaunchContext {
    const state = this.store.snapshot({history:false});
    const assignment = (state.assignments ?? []).find(item => item.id === assignmentId);
    if (!assignment) throw new Error('Assignment not found.');
    const agent = state.agents.find(item => item.id === assignment.agentId);
    if (!agent) throw new Error('Agent not found.');
    const dependencies = dependencyStatus(state, assignment);
    if (!dependencies.ready) throw new Error(`This work waits on other work: ${dependencies.blockers[0]}`);
    const now = this.nowMs();
    const gate = agentDispatchReadiness(state, agent, { now });
    if (kind === 'DISPATCH' && !gate.canStart) throw new Error(`Automatic start is blocked: ${gate.blockers[0] ?? 'the transport is unverified.'}`);
    if (kind === 'HANDOFF' && !gate.canHandoff) throw new Error(`The handoff is blocked: ${gate.blockers[0] ?? 'the account is not usable right now.'}`);

    const request = state.requests?.find(item => item.id === assignment.requestId);
    if (!request) throw new Error('Request not found.');
    this.assertLifecycle(state, request, agent);
    const frozen = this.frozenPayload(assignment);
    const snapshot = state.snapshots?.find(item => item.id === assignment.snapshotId);
    if (!snapshot) throw new Error('The prepared inputs for this work are no longer recorded.');

    if (assignment.delegation && request.mode === 'SINGLE')
      throw new Error('Uncontrolled delegation: this request is single-agent, so delegated execution is not authorized.');

    // The route must be able to reach this provider at all, on every path. No substitution: an
    // unsupported pairing is refused rather than quietly sent somewhere that might accept it.
    const adapter = this.adapterFor({ route: assignment.route });
    const supported = adapter.providers ?? (adapter.route === 'FAKE_ADAPTER' ? (['claude', 'openai', 'devin'] as const) : (['claude'] as const));
    if (!supported.includes(agent.provider))
      throw new Error(`No supported route: the ${adapter.route.toLowerCase().replaceAll('_', ' ')} adapter cannot run ${agent.provider} work. Use a handoff, or configure a supported route.`);

    // The account context this work was frozen against must still be the one in force, by record and
    // not merely by name: a different connection with the same address is a different context.
    const connection = (state.connections ?? []).find(item => item.id === assignment.connectionId);
    if (!connection) throw new Error('The account this work was frozen against is no longer in this workspace.');
    if (connection.provider !== agent.provider) throw new Error('The frozen account belongs to a different provider than this profile.');
    const active = currentConnection(state, agent.provider);
    if (!active || active.id !== connection.id)
      throw new Error(`This work was prepared for ${connection.identity}, but ${active?.identity ?? 'no account'} is the current account context. Sign that account back in, or prepare the work again.`);
    // Compared against the values frozen at preparation, not against the connection row, which a
    // later observation rewrites in place. Same address, different credential context, is a different
    // account context and this work was not prepared against it.
    if (active.identity !== frozen.accountIdentity || active.credentialContext !== frozen.credentialContext)
      throw new Error(`The signed-in account context changed since this work was prepared: it was frozen for ${frozen.accountIdentity} (${frozen.credentialContext}) and is now ${active.identity} (${active.credentialContext}). Prepare it again.`);
    if (agent.connectionId !== connection.id)
      throw new Error(`${agent.name} is no longer bound to the account this work was frozen against. Prepare the work again.`);
    if ((agent.revision ?? 0) !== assignment.agentRevision)
      throw new Error(`${agent.name} changed since this work was frozen. Prepare the work again.`);
    if (request.revision !== assignment.requestRevision)
      throw new Error('The request changed since this work was frozen. Prepare it again.');
    // Stage work is frozen against one exact branch revision. A branch that advanced, amended or was
    // settled since makes this context a description of work nobody is waiting for anymore.
    if (assignment.research) {
      const research = assignment.research;
      const branch = (state.branches ?? []).find(item => item.id === research.branchId);
      const link = (state.pipeline ?? []).filter(item => item.kind === 'LINK' && item.branchId === research.branchId).at(-1);
      if (!branch || branch.revision !== research.branchRevision || branch.stage !== research.stage)
        throw new Error('The research branch moved since this work was prepared. Prepare it again for the current stage.');
      if (!link || link.kind !== 'LINK' || link.requestId !== assignment.requestId || link.requestRevision !== assignment.requestRevision || link.subjectHash !== research.subjectHash)
        throw new Error('The branch-to-request link changed since this work was prepared. Prepare it again.');
      if (branch.outcome !== 'IN_PROGRESS' || branch.specId !== research.specId)
        throw new Error('The research branch is no longer active under this specification.');
      const blocker = this.store.researchStageBlocker(research.stage);
      if (blocker) throw new Error(blocker);
      this.store.assertIsolatedLaunch(assignment.id,adapter.route);
      if(['S2','S7'].includes(research.stage)&&!adapter.isolatedContexts)throw new Error('This adapter has no isolated context delivery implementation.');
      if (kind === 'HANDOFF') throw new Error('Research handoff is blocked: the terminal route cannot deliver the frozen stage context.');
      if (stageContextHash({ ...research, agentId: assignment.agentId, agentRevision: assignment.agentRevision, inputs: research }) !== research.contextHash)
        throw new Error('This research context predates exact input/revision binding. Prepare it again.');
      const appointment = (state.functions ?? []).filter(item => item.projectId === assignment.projectId && item.stage === research.stage
        && item.function === research.function && !item.supersededById).at(-1);
      if (!appointment || appointment.agentId !== assignment.agentId || appointment.agentRevision !== assignment.agentRevision)
        throw new Error('This profile no longer holds the prepared stage function. Prepare the work again.');
    }

    return { state, assignment, agent, request, frozen, snapshot, connection, now };
  }

  /**
   * Asks the official tool what account is signed in now, and commits that observation, before any
   * launch path runs its checks.
   *
   * The five-minute freshness window describes what the interface last displayed, not what is true
   * at this instant. The observation is recorded first so the guard that follows judges against a
   * durable fact; `launchGuard` then does the comparison against the frozen connection.
   */
  private async refreshFrozenAccount(assignmentId: string): Promise<void> {
    if (!this.refreshAccount) return;
    const state = this.store.snapshot({history:false});
    const assignment = (state.assignments ?? []).find(item => item.id === assignmentId);
    if (!assignment) throw new Error('Assignment not found.');
    const agent = state.agents.find(item => item.id === assignment.agentId);
    if (!agent) throw new Error('Agent not found.');
    await this.refreshAccount(agent.provider);
  }

  /**
   * Rebuilds staging from stored bytes when it is gone, before anything is verified or launched.
   *
   * Returns the snapshot to actually use. Where staging had to be rebuilt, that is a copy carrying
   * the runtime location; the recorded snapshot keeps its original identity and is never rewritten
   * to describe where its bytes currently happen to sit.
   */
  private async recoverMissingStaging(snapshot: InputSnapshot): Promise<InputSnapshot> {
    if (!this.recoverStaging || existsSync(snapshot.stagingPath)) return snapshot;
    return { ...snapshot, stagingPath: await this.recoverStaging(snapshot) };
  }

  private job(assignmentId: string): ProviderJob {
    const job = (this.store.snapshot({history:false}).jobs ?? []).find(item => item.assignmentId === assignmentId);
    if (!job) throw new Error('This assignment has no job record.');
    return job;
  }

  /**
   * Dispatches one frozen assignment. The intent is already durable, so an error or timeout after
   * this point becomes Unknown and is never retried automatically.
   */
  async dispatch(assignmentId: string): Promise<AppState> {
    await this.refreshFrozenAccount(assignmentId);
    let context = this.launchGuard(assignmentId, 'DISPATCH');
    const { assignment, agent, snapshot } = context;
    let { state, frozen, connection, now } = context;
    // The execution policy is enforced here, from recorded evidence, not assumed by the adapter.
    const capability = (state.capabilities ?? []).find(item => item.id === assignment.capabilitySnapshotId);
    // One normalized scope, checked as a whole. Evidence for another model, environment, tool version,
    // effort or delegation policy is evidence about a different question and does not authorize this.
    const scope: RequestedScope = {
      provider: agent.provider, identity: connection.identity, credentialContext: connection.credentialContext,
      toolVersion: capability?.toolVersion ?? '', route: assignment.route, environment: capability?.environment ?? '',
      model: assignment.requestedModel, effort: assignment.requestedEffort, delegation: assignment.delegation,
    };
    const mismatches = scopeMismatches(state, scope, { now });
    if (mismatches.length) throw new Error(`This work is not verified for the exact conditions it would run under: ${mismatches[0]}`);

    // The evidence that authorized this work must be the same evidence that authorized it when the
    // user froze it. A later observation can supply a different snapshot for the same operation.
    if (assignment.capabilitySnapshotIds) {
      const supplying = supplyingSnapshotIds(state, scope, { now });
      const frozenSet = [...assignment.capabilitySnapshotIds].sort().join(',');
      if (supplying.join(',') !== frozenSet)
        throw new Error('The capability evidence behind this work changed since it was frozen. Prepare the request again.');
    }

    // Confinement is read as its own fact, from its own observation, rather than inferred from the
    // other checks passing. Delegation control describes delegation; it says nothing about whether
    // tools, the filesystem or the network were actually restricted.
    const confinement = effectiveEvidence(state, connection, 'TOOL_CONFINEMENT', {
      now, model: scope.model, environment: scope.environment, route: scope.route,
    });
    const policy = confinement?.confinement;
    const toolsConfined = Boolean(confinement && confinement.level === 'ACCOUNT_VERIFIED' && confinement.evidence === 'OBSERVED'
      && !confinement.expired && !confinement.impossible
      && policy && policy.tools.trim() && policy.filesystem.trim() && policy.network.trim() && policy.environment.trim());
    assertHostedExecution({
      provider: agent.provider === 'claude' ? 'ANTHROPIC' : 'OPENAI',
      location: capability?.environment === 'anthropic-managed' ? 'PROVIDER_HOSTED' : 'UNVERIFIED',
      constrainedTools: toolsConfined,
      // Every permitted route submits to provider-hosted infrastructure; the office never runs research locally.
      colabAccess: false,
      localExecution: false,
    });
    // Every open job in the workspace counts against capacity, including this one.
    assertWorkerCapacity((state.jobs ?? []).map(job => ({ id: job.id, state: job.state === 'INTENT' ? 'RESERVED' : job.state === 'SUBMITTING' ? 'SUBMITTED' : job.state === 'CANCEL_ACKNOWLEDGED' ? 'CANCELED_ACKNOWLEDGED' : job.state === 'ACCEPTED' ? 'SUBMITTED' : job.state })), 1);
    // The frozen bytes are re-checked against the staged tree and its commit immediately before the
    // provider is contacted. A refusal happens before the intent transition, so nothing is stranded.
    const staged = await this.recoverMissingStaging(snapshot);
    const problems = await this.verifyTransfer(staged);
    if (problems.length) throw new Error(`The prepared inputs no longer match what was frozen: ${problems[0]} Prepare the request again.`);
    // Verification is an await, and the workspace stayed writable throughout it. Everything the guard
    // established could have been invalidated in that window, so it is established again here, with no
    // further await before the adapter call.
    context = this.launchGuard(assignmentId, 'DISPATCH');
    this.prepareOutputs?.(assignment, staged);
    ({ state, frozen, connection, now } = context);
    let job = this.job(assignmentId);
    this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'SUBMITTING', evidence: 'OFFICE_LOCAL', detail: `Submitting through ${assignment.route}.`, at: this.now() });
    job = this.job(assignmentId);
    const adapter = this.adapterFor({ route: assignment.route });
    try {
      const result = await adapter.submit({ assignment, snapshot: staged, objective: frozen.objective, requestName: frozen.requestName, payload: this.providerPayload(assignment) });
      if (!result.externalId) throw new UnknownDispatchError('The provider returned no identifier for this submission.');
      return this.store.recordJobTransition({
        jobId: job.id, expectedRevision: job.revision, to: 'ACCEPTED', evidence: 'PROVIDER_REPORTED',
        detail: result.detail, externalId: result.externalId, externalUrl: result.externalUrl, at: this.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The dispatch failed for an unknown reason.';
      // Any failure after the call started leaves the provider's view unknown, never "not submitted".
      return this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'UNKNOWN', evidence: 'OFFICE_LOCAL',
        detail: `Dispatch outcome unknown: ${message} The office will not resubmit automatically.`, at: this.now() });
    }
  }

  /**
   * The immutable payload this assignment was frozen with.
   *
   * An assignment recorded before the payload existed cannot be launched: re-reading the request now
   * would mix a current prompt with old inputs and an old binding, which is exactly the defect this
   * replaces. Explicit re-preparation is the only way forward, and it is offered as such.
   */
  private frozenPayload(assignment: Assignment): NonNullable<Assignment['frozen']> {
    if (!assignment.frozen)
      throw new Error('This work was frozen before the office recorded the exact payload it would send. Prepare the request again.');
    return assignment.frozen;
  }

  private providerPayload(assignment: Assignment): ProviderPayload {
    const frozen = this.frozenPayload(assignment);
    if (!assignment.research) return buildProviderPayload(frozen);
    const spec = (this.store.snapshot({history:false}).specs ?? []).find(item => item.id === assignment.research!.specId);
    if (!spec?.frozen) throw new Error('Research payload requires its exact frozen specification.');
    return buildProviderPayload({ ...frozen, research: assignment.research, researchSpec: spec });
  }

  /** The exact command a handoff would run, for display before anything is launched. */
  handoffPlan(assignmentId: string): { executable: string; args: string[]; cwd: string; outputDestination?: OutputDestination } | null {
    const state = this.store.snapshot({history:false});
    const assignment = (state.assignments ?? []).find(item => item.id === assignmentId);
    if (!assignment) throw new Error('Assignment not found.');
    const adapter = this.adapterFor({ route: assignment.route }) as ProviderAdapter & { plan?: (context: SubmitContext) => { executable: string; args: string[]; cwd: string } };
    if (!adapter.plan) return null;
    const snapshot = state.snapshots!.find(item => item.id === assignment.snapshotId)!;
    const frozen = this.frozenPayload(assignment);
    // The preview and the launch read the same frozen values, so what the user approves is what runs.
    return { ...adapter.plan({ assignment, snapshot, objective: frozen.objective, requestName: frozen.requestName, payload: this.providerPayload(assignment) }),
      outputDestination: this.prepareOutputs?.(assignment, snapshot) };
  }

  /**
   * Opens the labeled handoff. The office prepares and launches; it does not claim a submission,
   * so the job becomes Unknown until the provider is observed or the user links the session.
   */
  async handoff(assignmentId: string): Promise<AppState> {
    await this.refreshFrozenAccount(assignmentId);
    let context = this.launchGuard(assignmentId, 'HANDOFF');
    const { assignment, snapshot } = context;
    // Local preflight happens before the job is marked as being submitted. A staging problem means no
    // launcher ever ran, so the work stays prepared and retryable rather than becoming an ambiguous
    // Unknown that implies the provider may have seen something.
    const staged = await this.recoverMissingStaging(snapshot);
    const problems = await this.verifyTransfer(staged);
    if (problems.length) throw new Error(`The prepared inputs no longer match what was frozen: ${problems[0]} Prepare the request again. Nothing was opened, so this work is still prepared.`);
    // Re-established after the await, immediately before the terminal is opened.
    context = this.launchGuard(assignmentId, 'HANDOFF');
    this.prepareOutputs?.(assignment, staged);
    const frozen = context.frozen;
    let job = this.job(assignmentId);
    this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'SUBMITTING', evidence: 'OFFICE_LOCAL', detail: 'Opening the official terminal for a manual submission.', at: this.now() });
    job = this.job(assignmentId);
    const adapter = this.adapterFor({ route: assignment.route });
    try {
      const result = await adapter.submit({ assignment, snapshot: staged, objective: frozen.objective, requestName: frozen.requestName, payload: this.providerPayload(assignment) });
      return this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'UNKNOWN', evidence: 'OFFICE_LOCAL', detail: result.detail, at: this.now() });
    } catch (error) {
      return this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'UNKNOWN', evidence: 'OFFICE_LOCAL',
        detail: `The handoff could not be completed: ${error instanceof Error ? error.message : 'unknown launcher failure'} Check the provider before trying again.`, at: this.now() });
    }
  }

  /** Records a session the user says was created. Linkage only; it settles nothing. */
  link(assignmentId: string, externalId: string, externalUrl: string): AppState {
    const job = this.job(assignmentId);
    return this.store.recordUserReportedLink({ jobId: job.id, expectedRevision: job.revision, externalId, externalUrl, at: this.now() });
  }

  /** Records what the provider currently reports, including its visible events. */
  async observe(assignmentId: string): Promise<AppState> {
    let job = this.job(assignmentId);
    if (isTerminalJob(job.state)) return this.store.snapshot({history:false});
    const result = await this.adapterFor({ route: job.route }).observe(job);
    if (result.events?.length) this.store.recordJobEvents(job.id, result.events);
    job = this.job(assignmentId);
    if (isTerminalJob(job.state)) return this.store.snapshot({history:false});
    // An adapter that cannot observe anything is describing its own limits, not reporting what the
    // provider said. Recording that as provider testimony would manufacture evidence out of silence,
    // and it must not overwrite a receipt or a pending cancellation the office already holds. An
    // adapter that really did hear UNKNOWN from the provider says so through `provenance`.
    if (result.state === 'UNKNOWN' && (result.provenance ?? 'OFFICE_LOCAL') === 'OFFICE_LOCAL') {
      if (job.externalId || job.state === 'CANCEL_REQUESTED' || job.state === 'UNKNOWN') return this.store.snapshot({history:false});
      return this.store.recordJobTransition({
        jobId: job.id, expectedRevision: job.revision, to: 'UNKNOWN', evidence: 'OFFICE_LOCAL',
        detail: result.detail, at: this.now(),
      });
    }
    // Output metadata is what the provider says exists. Before any of it is recorded as a retrieved
    // deliverable, the bytes are fetched and hashed here; anything that does not match its claimed
    // identity or length is dropped, with the mismatch reported rather than quietly stored.
    const retrieved: JobOutput[] = [];
    const failures: string[] = [];
    const names = new Map<string, string>();
    if ((result.outputs?.length ?? 0) > 256) throw new Error('The output inventory exceeds 256 entries.');
    for (const output of result.outputs ?? []) {
      if (!safeEntry(output.path) || !Number.isSafeInteger(output.bytes) || output.bytes < 0 || output.bytes > MAX_FILE || !/^[a-f0-9]{64}$/.test(output.sha256)) {
        failures.push('An output has an unsafe path, size or identity.'); continue;
      }
      const previous = names.get(output.path.toLowerCase());
      if (previous && previous !== output.sha256) { failures.push('The output inventory has conflicting paths.'); continue; }
      names.set(output.path.toLowerCase(), output.sha256);
      if (!this.fetchOutput) { failures.push(`${output.path} was reported but this route cannot retrieve bytes.`); continue; }
      if (!this.storeOutput) { failures.push(`${output.path} cannot be durably stored by this route.`); continue; }
      try {
        const bytes = await this.fetchOutput(job, output);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (bytes.byteLength !== output.bytes) { failures.push(`${output.path} arrived as ${bytes.byteLength} bytes, not the ${output.bytes} reported.`); continue; }
        if (digest !== output.sha256) { failures.push(`${output.path} does not match the identity the provider reported.`); continue; }
        // Content addressing dedupes a repeated event: the same bytes land on the same object.
        await this.storeOutput(digest, bytes, job, output);
        if (!retrieved.some(item => item.path === output.path && item.sha256 === digest)) retrieved.push({ ...output, sha256: digest, stored: true });
      } catch (error) {
        failures.push(`${output.path} could not be retrieved: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    const detail = failures.length ? `${result.detail} Some reported output was not retrieved: ${failures[0]}` : result.detail;
    if (failures.length) {
      this.store.recordJobEvents(job.id, [{ externalId: `retrieval:${canonicalHash({ outputs: result.outputs, failures })}`, cursor: '', kind: 'STATUS',
        text: detail.slice(0,1900), occurredAt: this.now(), receivedAt: this.now(), evidence: 'OFFICE_LOCAL' }]);
      throw new Error(`Completion needs attributable output durably stored for the entire reported inventory. ${failures[0]}`);
    }
    job = this.job(assignmentId);
    if (isTerminalJob(job.state)) return this.store.snapshot({history:false});
    const fresh = retrieved.filter(output => !job.outputs.some(old => old.path === output.path && old.sha256 === output.sha256 && old.stored));
    if (job.state === result.state && !fresh.length) return this.store.snapshot({history:false});
    return this.store.recordJobTransition({
      jobId: job.id, expectedRevision: job.revision, to: result.state, evidence: 'PROVIDER_REPORTED',
      detail, outputs: fresh.length ? fresh : undefined, at: this.now(),
    });
  }

  /**
   * Cancels undispatched work immediately; for accepted work it records the request, asks the
   * provider, and waits for an acknowledgement rather than assuming one.
   */
  async cancel(assignmentId: string): Promise<AppState> {
    let job = this.job(assignmentId);
    if (isTerminalJob(job.state)) throw new Error('This job already has a recorded outcome.');
    if (job.state === 'INTENT') {
      return this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'CANCEL_ACKNOWLEDGED', evidence: 'OFFICE_LOCAL',
        detail: 'Canceled before anything was submitted.', at: this.now() });
    }
    if (job.state !== 'CANCEL_REQUESTED') {
      this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'CANCEL_REQUESTED', evidence: 'OFFICE_LOCAL',
        detail: 'Cancellation requested; no dependent work will be dispatched while this is open.', at: this.now() });
      job = this.job(assignmentId);
    }
    const result = await this.adapterFor({ route: job.route }).cancel(job);
    if (!result.acknowledged) {
      this.store.recordJobEvents(job.id, [{ externalId: `cancel-attempt:${job.revision}`, cursor: '', kind: 'STATUS',
        text: `Cancellation not acknowledged: ${result.detail}`, occurredAt: this.now(), receivedAt: this.now(), evidence: 'OFFICE_LOCAL' }]);
      return this.store.snapshot({history:false});
    }
    return this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'CANCEL_ACKNOWLEDGED', evidence: 'PROVIDER_REPORTED',
      detail: result.detail, at: this.now() });
  }

  /** Retire only a proven-undispatched preparation so a new revision can be prepared. */
  discardPreparation(assignmentId: string): AppState {
    const job = this.job(assignmentId);
    if (job.state !== 'INTENT' || job.dispatchedAt || job.externalId) throw new Error('Only undispatched preparation can be discarded. Reconcile provider work instead.');
    return this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'FAILED', evidence: 'OFFICE_LOCAL',
      detail: 'Preparation discarded by the user before dispatch. The request remains available for a new preparation.', at: this.now() });
  }

  /**
   * Called at startup. Work interrupted mid-dispatch becomes Unknown; open work is observed.
   * A crash never marks anything completed or canceled, and never resubmits.
   */
  async reconcile(): Promise<{ jobId: string; action: string; detail: string }[]> {
    const results: { jobId: string; action: string; detail: string }[] = [];
    for (const job of this.store.openJobs()) {
      const plan = reconciliationPlan(job);
      if (plan.action === 'MARK_UNKNOWN') {
        this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'UNKNOWN', evidence: 'OFFICE_LOCAL', detail: plan.reason, at: this.now() });
        results.push({ jobId: job.id, action: 'MARK_UNKNOWN', detail: plan.reason });
        continue;
      }
      if (plan.action === 'OBSERVE') {
        try { await this.observe(job.assignmentId); results.push({ jobId: job.id, action: 'OBSERVE', detail: plan.reason }); }
        catch (error) { results.push({ jobId: job.id, action: 'OBSERVE_FAILED', detail: error instanceof Error ? error.message : 'Observation failed.' }); }
      }
    }
    return results;
  }
}
