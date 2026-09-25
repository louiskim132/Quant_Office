import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AdapterRoute, Agent, Assignment, AppState, CapabilityEvidence, Effort, InputSnapshot, JobEvent, JobOutput, Provider, ProviderJob } from '../shared/types.js';
import { canonicalHash } from '../core/canonical.js';
import { isTerminalJob, reconciliationPlan } from '../core/jobs.js';
import { assertHostedExecution, assertLocalExecution, assertWorkerCapacity } from '../core/guards.js';
import type { OfficeStore } from '../core/store.js';
import { appliedReportPayloadSchema, type LocalSessionRecord, type MemoryDigest } from '../shared/local-session.js';
import { agentDispatchReadiness, currentConnection, effectiveEvidence, latestCapability, scopeMismatches, supplyingSnapshotIds, type RequestedScope } from '../shared/readiness.js';
import { dependencyStatus } from '../shared/cooperation.js';
import { recordChainHandoff } from './chain-messages.js';
import { verifySnapshotForTransfer, type OutputDestination } from './locations.js';
import { localRequirementFor } from './local-lane.js';
import { safeEntry, MAX_FILE } from './artifacts.js';
import { pipelineStageBlocker, type FrozenResearchSpec } from '../shared/research.js';
import { stageContextHash } from '../shared/pipeline.js';
import { settlePipelineDecision } from './pipeline-runner.js';
import { ingestReceiptMemory } from './memory-ingest.js';
import type { ToolProfile } from '../shared/tool-profile.js';

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

export interface SubmitContext {
  assignment: Assignment; snapshot: InputSnapshot; objective: string; requestName: string; payload: ProviderPayload;
  /** The durable job this submission serves — created before submit so a packet can bind it. */
  jobId: string;
  /** The persisted local delivery binding when one exists; hosted adapters ignore it. */
  localSession?: LocalSessionRecord;
  /**
   * Verified bytes of completed predecessor outputs, resolved from content-addressed storage by
   * the controller. A local packet writes them under `inputs/inherited/<sourceJobId>/` and binds
   * the exact {sourceJobId, objectHash} provenance in its manifest; hosted adapters ignore this.
   */
  inherited?: { name: string; bytes: Uint8Array; sourceJobId: string; objectHash: string }[];
  /**
   * The project's bounded memory-ledger projection, populated by the controller for bound local
   * submits. The packet writer alone decides whether it mounts — only the seats
   * authorizeMemorySearch authorizes receive memory-digest.json; everywhere else the value is
   * ignored and no file or declaration is written.
   */
  memoryDigest?: Pick<MemoryDigest, 'findings' | 'links'>;
}
export interface SubmitResult {
  externalId: string; externalUrl: string; detail: string; resolvedModel?: string; appliedEffort?: Effort | 'UNVERIFIED';
  /**
   * Set only by local-layout adapters that wrote a versioned packet: the verified packet hash the
   * service persists on the binding before reporting delivery. Hosted adapters never set it.
   */
  localPacket?: { packetHash: string };
}
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
  /**
   * Self-reported applied facts a verified receipt declared — what the session says it ran, not
   * what the office asked for. Absent keys mean the tool said nothing; they are never inferred.
   */
  applied?: { model?: string; effort?: Effort; delegation?: boolean };
  /**
   * A validated cooperative-stop acknowledgement the session wrote for the recorded cancel
   * request. Present only when the bytes satisfied the ack contract and bound the exact request
   * — a local record the caller persists as stop status, never a provider acknowledgement.
   */
  cancelAck?: { requestId: string; outcome: 'STOPPED'; detail: string };
  /**
   * The identity of a receipt the local adapter verified this observation — its declared sequence
   * and the sha256 of the bytes as read. The caller persists it as the binding's lastReceipt so a
   * replayed or rewound receipt is refused next time. Hosted adapters never set it.
   */
  receipt?: { sequence: number; hash: string };
  /**
   * The verified receipt's optional self-reported memory sections — `findings`/`links` exactly
   * as the receipt declared them. The caller ingests them through the office ledger's own
   * validation; they are session self-report, never office-verified facts.
   */
  memory?: Pick<import('../shared/local-session.js').LocalResultV2, 'findings' | 'links'>;
  /**
   * An office-observed provider-side record for this session's directory — the record's own
   * identity (session id, project key, rollout name), found by read-only discovery. Present only
   * when discovery actually resolved a record; absence downgrades nothing. This observation is
   * independent of receipt state — a started session's record is real even while the receipt is
   * absent or defective.
   */
  providerGrouping?: { key: string; kind: string };
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
  /** The packet contract version a local adapter writes; the binding records it at preparation. */
  readonly packetVersion?: 1 | 2;
  submit(context: SubmitContext): Promise<SubmitResult>;
  /**
   * `local` carries the resolved delivery binding on local routes so the adapter can enforce the
   * bound packet version, attempt identity and storage path. Hosted adapters ignore it.
   */
  observe(job: ProviderJob, local?: LocalSessionRecord | null): Promise<ObserveResult>;
  /**
   * Requests cooperative cancellation. `acknowledged` means the office delivered the request —
   * never that anything stopped. `requestId` names the request the office wrote so the caller can
   * persist it on the binding; an absent or mismatched acknowledgement later is its own state.
   */
  cancel(job: ProviderJob, local?: LocalSessionRecord | null): Promise<{ acknowledged: boolean; detail: string; requestId?: string }>;
  /**
   * Office-observed evidence from a completed local operation. Only local-route adapters implement
   * these; what they return is the office's own testimony about work it performed — the caller
   * scopes it to the recorded route and request, and it is never provider attestation. Returning
   * no entries records nothing.
   */
  submitEvidence?(context: SubmitContext, result: SubmitResult): CapabilityEvidence[];
  observeEvidence?(job: ProviderJob, result: ObserveResult): CapabilityEvidence[];
  cancelEvidence?(job: ProviderJob): CapabilityEvidence[];
  /** Reads bytes for an output this route verifies itself, when the office has no fetcher for it. */
  fetch?(job: ProviderJob, output: { path: string; sha256: string; bytes: number }, local?: LocalSessionRecord | null): Promise<Uint8Array>;
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
    /**
     * Provider-side session lifecycle for local packets — inspect/archive against the provider's
     * own record identity. Absent means provider archive is never attempted and honestly says so.
     */
    private readonly providerLifecycle?: import('./local-provider-lifecycle.js').ProviderLifecycle,
    /**
     * Reads a content-addressed stored output back, hash-verified. Dependent packets inherit
     * predecessor bytes only through this path — absent means a dependent can never be prepared.
     */
    private readonly readObject?: (sha256: string) => Promise<Uint8Array>,
  ) {}

  /** One clock for gates and records, so evidence freshness never depends on the wall calendar. */
  private nowMs(): number { return Date.parse(this.now()); }

  private adapterFor(ref: { agent?: Agent; route?: AdapterRoute }): ProviderAdapter {
    if (!this.adapters) return this.adapter;
    const adapter = this.adapters(ref);
    if (!adapter) throw new Error(`No adapter is configured for ${ref.route ? `the ${ref.route.toLowerCase().replaceAll('_', ' ')} route` : `${ref.agent?.provider ?? 'this provider'} work`}. Configure a supported route or use a handoff.`);
    return adapter;
  }

  /**
   * Persists office-observed transport evidence for a local route. The connection and the model the
   * evidence answers for come from the recorded assignment and its bound snapshot — never from
   * adapter-supplied identity — and the route stamped on every entry is the job's recorded one.
   * A recording failure is reported on the job rather than corrupting the outcome it describes:
   * the operation the evidence would describe genuinely happened.
   */
  private noteLocalEvidence(job: ProviderJob, entries: CapabilityEvidence[]): void {
    if (!entries.length || !job.route.startsWith('LOCAL_')) return;
    try {
      const state = this.store.snapshot({ history: false });
      const assignment = (state.assignments ?? []).find(item => item.id === job.assignmentId);
      const capability = assignment ? (state.capabilities ?? []).find(item => item.id === assignment.capabilitySnapshotId) : undefined;
      const connection = capability ? (state.connections ?? []).find(item => item.id === capability.connectionId) : undefined;
      if (!assignment || !connection) return;
      this.store.recordTransportEvidence({
        connectionId: connection.id, route: job.route, environment: 'LOCAL_MACHINE',
        model: assignment.requestedModel, operations: entries,
        source: 'office-local-transport', observedAt: this.now(),
      });
    } catch (error) {
      this.store.recordJobEvents(job.id, [{ externalId: `transport-evidence:${job.revision}:${Date.parse(this.now())}`, cursor: '', kind: 'STATUS',
        text: `Office-observed transport evidence could not be recorded: ${error instanceof Error ? error.message : 'unknown error'}`,
        occurredAt: this.now(), receivedAt: this.now(), evidence: 'OFFICE_LOCAL' }]);
    }
  }

  /** Freezes the exact inputs for one request and records the intent to submit. */
  prepare(input: { requestId: string; agentId: string; snapshotId: string; expectedRequestRevision?: number; expectedAgentRevision?: number; dependsOn?: string[]; research?: Assignment['research']; toolProfile?: ToolProfile; pipelineKey?: string; objective?: string }): { state: AppState; assignment: Assignment } {
    const state = this.store.snapshot({history:false});
    const request = state.requests?.find(item => item.id === input.requestId);
    if (!request) throw new Error('Request not found.');
    const agent = state.agents.find(item => item.id === input.agentId);
    if (!agent) throw new Error('Agent not found.');
    this.assertLifecycle(state, request, agent, Boolean(input.pipelineKey));
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
      objectiveHash: canonicalHash({ objective: input.objective ?? request.objective, criteria: request.acceptanceCriteria }),
      // The exact text the adapter will receive, captured now. Launch uses this and never re-reads
      // the request, so a later edit cannot ride along with these frozen inputs and this binding.
      // Pipeline hops override the objective with the minted hop's bounded instruction.
      frozen: {
        requestName: request.name, objective: input.objective ?? request.objective, acceptanceCriteria: request.acceptanceCriteria,
        instructions: agent.instructions, model: agent.model, effort: agent.effort ?? 'default', delegation: request.delegation,
        accountIdentity: connection.identity, credentialContext: connection.credentialContext,
        outputFolder: state.locations?.find(item => item.projectId === request.projectId)?.outputFolder ?? '',
      },
      createdAt: this.now(),
      ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
      ...(input.toolProfile ? { toolProfile: input.toolProfile } : {}),
      ...(input.pipelineKey ? { pipelineKey: input.pipelineKey } : {}),
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
  private assertLifecycle(state: AppState, request: { id: string; projectId: string; status: string; participantIds: string[]; leadAgentId: string | null; mode: string }, agent: { id: string; removedAt?: string; name: string }, pipelineSeat = false): void {
    const project = state.projects.find(item => item.id === request.projectId);
    if (!project) throw new Error('Project not found.');
    if (project.archived) throw new Error('This project is archived. Restore it before starting work.');
    if (request.status === 'CANCELED') throw new Error('This request was canceled. Duplicate it if the work is still wanted.');
    if (agent.removedAt) throw new Error(`${agent.name} is archived. Restore the profile before using it.`);
    // A single-agent request has a closed roster by definition. Group and team work deliberately
    // draws in agents who are not listed participants - a reviewer must not be the author - but that
    // explains who may be added, it does not authorize everyone: an unlisted agent needs an explicit
    // grant recorded against this request. Pipeline hops are the exception: their seats resolve by
    // roster role through the office mint, which is itself the recorded authorization.
    if (pipelineSeat) return;
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
    this.assertLifecycle(state, request, agent, Boolean(assignment.pipelineKey));
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
    const localRoute = assignment.route.startsWith('LOCAL_');
    // The confinement level bar follows the route family: the office is the observing authority for
    // local delivery, so TOOL_SUPPORTED is its ceiling, exactly as the scope check already applied.
    const levelOk = confinement && (confinement.level === 'ACCOUNT_VERIFIED' || (localRoute && confinement.level === 'TOOL_SUPPORTED'));
    const toolsConfined = Boolean(confinement && levelOk && confinement.evidence === 'OBSERVED'
      && !confinement.expired && !confinement.impossible
      && policy && policy.tools.trim() && policy.filesystem.trim() && policy.network.trim() && policy.environment.trim());
    if (localRoute) {
      // A local route runs only under office-observed scoped delivery — honestly labeled, never a
      // claim of enforced isolation or provider attestation.
      assertLocalExecution({ constrainedTools: toolsConfined, colabAccess: false });
    } else {
      assertHostedExecution({
        provider: agent.provider === 'claude' ? 'ANTHROPIC' : 'OPENAI',
        location: capability?.environment === 'anthropic-managed' ? 'PROVIDER_HOSTED' : 'UNVERIFIED',
        constrainedTools: toolsConfined,
        // Every permitted route submits to provider-hosted infrastructure; the office never runs research locally.
        colabAccess: false,
        localExecution: false,
      });
    }
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
    const adapter = this.adapterFor({ route: assignment.route });
    // Dependent work inherits only verified predecessor bytes — resolved before the durable intent
    // binding so an unreadable or corrupted object fails the launch as a preflight, never a
    // stranded submission.
    const inherited = localRoute && assignment.dependsOn?.length ? await this.inheritedInputs(assignment) : undefined;
    // A local route submits only through a persisted delivery binding: the record is the durable
    // intent the router requires, written before the job says SUBMITTING so a refused
    // classification or an un-retryable binding leaves the job honestly undispatched.
    const attempt = localRoute ? this.prepareLocalSession({ assignment, agent, adapter, job }) : null;
    this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'SUBMITTING', evidence: 'OFFICE_LOCAL', detail: `Submitting through ${assignment.route}.`, at: this.now() });
    job = this.job(assignmentId);
    const submitContext: SubmitContext = { assignment, snapshot: staged, objective: frozen.objective, requestName: frozen.requestName, payload: this.providerPayload(assignment), jobId: job.id };
    if (attempt) { submitContext.localSession = attempt.binding; submitContext.memoryDigest = this.store.memoryDigest(assignment.projectId); }
    if (inherited?.length) submitContext.inherited = inherited;
    try {
      const result = await adapter.submit(submitContext);
      if (!result.externalId) throw new UnknownDispatchError('The provider returned no identifier for this submission.');
      if (attempt) this.settleLocalPreparation(attempt, 'READY', result.localPacket?.packetHash ?? null, null);
      // A local transport delivers into a mailbox the office owns; nothing has run or been accepted
      // yet, so the honest record is the office's submission awaiting a session — never ACCEPTED.
      const submitted = localRoute
        ? this.store.recordJobTransition({
          jobId: job.id, expectedRevision: job.revision, to: 'UNKNOWN', evidence: 'OFFICE_LOCAL',
          detail: result.detail, externalId: result.externalId, externalUrl: result.externalUrl, at: this.now(),
        })
        : this.store.recordJobTransition({
          jobId: job.id, expectedRevision: job.revision, to: 'ACCEPTED', evidence: 'PROVIDER_REPORTED',
          detail: result.detail, externalId: result.externalId, externalUrl: result.externalUrl, at: this.now(),
        });
      // The office itself performed this delivery, so what it did is recorded as office evidence.
      this.noteLocalEvidence(job, adapter.submitEvidence?.(submitContext, result) ?? []);
      return submitted;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The dispatch failed for an unknown reason.';
      if (attempt) this.settleLocalPreparation(attempt, 'PREPARATION_FAILED', null, `Dispatch outcome unknown: ${message}`);
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
    return { ...adapter.plan({ assignment, snapshot, objective: frozen.objective, requestName: frozen.requestName, payload: this.providerPayload(assignment), jobId: this.job(assignmentId).id }),
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
    const adapter = this.adapterFor({ route: assignment.route });
    const localRoute = assignment.route.startsWith('LOCAL_');
    // Same preflight rule as dispatch: verified predecessor bytes resolve before the durable
    // intent binding, so a dependent with unreadable inputs stays honestly prepared.
    const inherited = localRoute && assignment.dependsOn?.length ? await this.inheritedInputs(assignment) : undefined;
    // Same durable-intent rule as dispatch: the persisted binding goes with the submission.
    const attempt = localRoute ? this.prepareLocalSession({ assignment, agent: context.agent, adapter, job }) : null;
    this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'SUBMITTING', evidence: 'OFFICE_LOCAL', detail: 'Opening the official terminal for a manual submission.', at: this.now() });
    job = this.job(assignmentId);
    const submitContext: SubmitContext = { assignment, snapshot: staged, objective: frozen.objective, requestName: frozen.requestName, payload: this.providerPayload(assignment), jobId: job.id };
    if (attempt) { submitContext.localSession = attempt.binding; submitContext.memoryDigest = this.store.memoryDigest(assignment.projectId); }
    if (inherited?.length) submitContext.inherited = inherited;
    try {
      const result = await adapter.submit(submitContext);
      if (attempt) this.settleLocalPreparation(attempt, 'READY', result.localPacket?.packetHash ?? null, null);
      // For a local transport the office knows the session identity it created; recording it keeps
      // observation and cancellation pointed at the packet directory that actually exists.
      const opened = this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'UNKNOWN', evidence: 'OFFICE_LOCAL',
        detail: result.detail, externalId: localRoute ? result.externalId : undefined, at: this.now() });
      this.noteLocalEvidence(job, adapter.submitEvidence?.(submitContext, result) ?? []);
      return opened;
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'unknown launcher failure';
      if (attempt) this.settleLocalPreparation(attempt, 'PREPARATION_FAILED', null, failure);
      // The failure class follows where the launcher ran. A local route fails writing the session
      // packet on this machine — the provider never saw the attempt, so naming it would send the
      // user to the wrong place. Only a hosted-route failure points at the provider.
      const detail = localRoute
        ? `The local session packet could not be written on this machine: ${failure} Check the workspace and try again.`
        : `The handoff could not be completed: ${failure} Check the provider before trying again.`;
      return this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'UNKNOWN', evidence: 'OFFICE_LOCAL',
        detail, at: this.now() });
    }
  }

  /** Records a session the user says was created. Linkage only; it settles nothing. */
  link(assignmentId: string, externalId: string, externalUrl: string): AppState {
    const job = this.job(assignmentId);
    return this.store.recordUserReportedLink({ jobId: job.id, expectedRevision: job.revision, externalId, externalUrl, at: this.now() });
  }

  /**
   * The verified predecessor bytes a dependent packet inherits.
   *
   * Only outputs the office fetched, hash-checked and durably stored qualify — `stored: true` is
   * set only after that retrieval path completes, so an output claimed but never verified never
   * reaches a dependent. The bytes are then read back from content-addressed storage and the hash
   * is re-verified before they are handed to the packet writer; a missing or corrupted object is
   * a launch refusal, never a partially delivered input.
   */
  private async inheritedInputs(assignment: Assignment): Promise<NonNullable<SubmitContext['inherited']>> {
    const state = this.store.snapshot({history:false});
    const inherited: NonNullable<SubmitContext['inherited']> = [];
    for (const dependency of assignment.dependsOn ?? []) {
      const job = (state.jobs ?? []).find(item => item.assignmentId === dependency);
      for (const output of job?.outputs ?? []) {
        if (!output.stored) continue;
        if (!this.readObject) throw new Error('This workspace cannot read stored predecessor output for a dependent packet.');
        const bytes = await this.readObject(output.sha256);
        if (createHash('sha256').update(bytes).digest('hex') !== output.sha256)
          throw new Error(`The recorded output ${output.path} could not be read back intact for the dependent packet.`);
        inherited.push({ name: output.path, bytes, sourceJobId: job!.id, objectHash: output.sha256 });
      }
    }
    return inherited;
  }

  /**
   * Advances the local dependency chain after one assignment's job was observed COMPLETED.
   *
   * A dependent launches only while it is still INTENT — an already-dispatched or discarded job
   * is never resubmitted by this path, which makes repeated calls idempotent. Every launch runs
   * the same guard, binding and packet path a manual launch would, so a chain step records exactly
   * the evidence a user-initiated launch does. Hosted-route dependents are never auto-launched;
   * a refused launch is recorded on the job as office-local testimony, not swallowed.
   */
  async advanceLocalChain(assignmentId: string): Promise<AppState> {
    const state = this.store.snapshot({history:false});
    const settled = (state.jobs ?? []).find(item => item.assignmentId === assignmentId);
    if (!settled || settled.state !== 'COMPLETED') return state;
    for (const dependent of (state.assignments ?? []).filter(item => (item.dependsOn ?? []).includes(assignmentId)))
      await this.launchChainDependent(state, dependent, assignmentId);
    this.settlePipelineForAssignment(assignmentId);
    return this.store.snapshot({history:false});
  }

  /**
   * Startup and reconciliation pass for the chain: every INTENT dependent whose recorded
   * predecessors all completed is launched through the same guarded path. Durable and
   * idempotent — a job already launched is never touched, and nothing outside the recorded
   * `dependsOn` set is considered.
   */
  async reconcileLocalChain(): Promise<AppState> {
    const state = this.store.snapshot({history:false});
    for (const dependent of (state.assignments ?? []).filter(item => item.dependsOn?.length))
      await this.launchChainDependent(state, dependent);
    // Startup reconciliation also seals a launched round whose last hop completed while the
    // office was down — the settle reports a non-terminal round instead of throwing, so a
    // mid-round request passes through untouched.
    const current = this.store.snapshot({history:false});
    for (const request of (current.requests ?? []).filter(item => item.pipeline?.phase === 'LAUNCHED'))
      try { settlePipelineDecision({ store: this.store }, request); } catch {}
    return this.store.snapshot({history:false});
  }

  /** A completed hop may seal its round — the office settle is a no-op until every minted hop verifies. */
  private settlePipelineForAssignment(assignmentId: string): void {
    const state = this.store.snapshot({history:false});
    const assignment = state.assignments?.find(item => item.id === assignmentId);
    if (!assignment?.pipelineKey) return;
    const request = state.requests?.find(item => item.id === assignment.requestId);
    if (request?.pipeline?.phase !== 'LAUNCHED') return;
    try { settlePipelineDecision({ store: this.store }, request); } catch {}
  }

  /** Serializes chain launches — two predecessors settling together must not race one dependent. */
  private chainTail: Promise<unknown> = Promise.resolve();

  private async launchChainDependent(state: AppState, dependent: Assignment, settledAssignmentId?: string): Promise<void> {
    const job = (state.jobs ?? []).find(item => item.assignmentId === dependent.id);
    if (!job || job.state !== 'INTENT' || !dependent.route.startsWith('LOCAL_')) return;
    if (!dependencyStatus(state, dependent).ready) return;
    const run = this.chainTail.then(async () => {
      // Another completion signal may already have launched this job while this callback waited.
      // Recheck durable eligibility inside the serialized section, before account checks or handoff.
      const current = this.store.snapshot({ history: false });
      const currentAssignment = current.assignments?.find(item => item.id === dependent.id);
      const currentJob = current.jobs?.find(item => item.id === job.id);
      if (!currentAssignment || currentJob?.state !== 'INTENT'
        || !currentAssignment.route.startsWith('LOCAL_') || !dependencyStatus(current, currentAssignment).ready) return;
      let launched = false;
      try {
        await this.handoff(dependent.id);
        launched = true;
        this.store.recordJobEvents(job.id, [{ externalId: `chain-launch:${job.id}`, cursor: '', kind: 'STATUS',
          text: 'The office launched this work automatically — its recorded predecessor work completed with verified output.',
          occurredAt: this.now(), receivedAt: this.now(), evidence: 'OFFICE_LOCAL' }]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        this.store.recordJobEvents(job.id, [{ externalId: `chain-blocked:${canonicalHash({ job: job.id, revision: job.revision, detail })}`, cursor: '', kind: 'STATUS',
          text: `The automatic chain launch could not run: ${detail} The work stays prepared; launch it manually when the blocker clears.`,
          occurredAt: this.now(), receivedAt: this.now(), evidence: 'OFFICE_LOCAL' }]);
      }
      // The handoff message rides only on a launch that actually ran: the helper itself confirms
      // the packet settled READY before naming it, and every other path stays silent by contract.
      if (launched) this.chainHandoff(dependent.id, settledAssignmentId);
    });
    this.chainTail = run;
    await run;
  }

  /**
   * Writes the chain hop's durable record — one HANDOFF message plus the office's delivery
   * receipt — after a chain launch that actually ran. A refusal is recorded on the job with its
   * true reason; it is never folded into the launch failure event, because the launch succeeded.
   */
  private chainHandoff(dependentId: string, settledAssignmentId?: string): void {
    const state = this.store.snapshot({ history: false });
    const dependent = state.assignments?.find(item => item.id === dependentId);
    const job = dependent ? state.jobs?.find(item => item.assignmentId === dependentId) : undefined;
    if (!dependent || !job) return;
    try {
      const outcome = recordChainHandoff({ store: this.store, state, dependent, settledAssignmentId, now: this.now });
      if (!outcome.recorded)
        this.store.recordJobEvents(job.id, [{ externalId: `chain-handoff-note:${job.id}`, cursor: '', kind: 'STATUS',
          text: `The chain launch stands, but no handoff message was recorded: ${outcome.reason}`,
          occurredAt: this.now(), receivedAt: this.now(), evidence: 'OFFICE_LOCAL' }]);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      this.store.recordJobEvents(job.id, [{ externalId: `chain-handoff-blocked:${canonicalHash({ job: job.id, detail })}`, cursor: '', kind: 'STATUS',
        text: `The chain launch ran, but its handoff record could not be written: ${detail}`,
        occurredAt: this.now(), receivedAt: this.now(), evidence: 'OFFICE_LOCAL' }]);
    }
  }

  /**
   * Prepares the durable local-session binding a local route submits against (QO-LOCAL-REV §10).
   *
   * The assignment's confinement requirement is classified before anything is persisted: a
   * requirement with no permitted layout refuses loudly, and scoped delivery selects the flat
   * packet lane — the worktree lane is never silently selected; it becomes reachable only when a
   * user-level layout choice exists. The record lands PREPARING as durable intent before the job
   * claims SUBMITTING, so a refused classification or an un-retryable existing binding leaves the
   * job honestly undispatched. Hosted routes never reach this helper.
   */
  private prepareLocalSession(input: { assignment: Assignment; agent: Agent; adapter: ProviderAdapter; job: ProviderJob }): { binding: LocalSessionRecord; operationId: string } {
    const { assignment, agent, adapter, job } = input;
    const decision = localRequirementFor(assignment);
    if (!decision.allowed)
      throw new Error(`This assignment cannot be delivered to a local session: ${decision.reason}`);
    if (decision.requirement === 'READ_CONFINEMENT_REQUIRED')
      throw new Error(decision.detail);
    const operationId = randomUUID();
    const mint = () => `session-${this.now().replace(/[^0-9A-Za-z]/g, '')}-${randomUUID()}`;
    const existing = this.store.localSessionForJob(job.id);
    if (!existing) {
      const binding = this.store.createLocalSession({
        schemaVersion: 1, jobId: job.id, assignmentId: assignment.id, projectId: assignment.projectId,
        attemptId: randomUUID(), provider: agent.provider, surface: 'UNKNOWN', layout: 'FLAT_PACKET',
        packetVersion: adapter.packetVersion ?? 1, packetHash: null, storageRelativePath: mint(),
        originalCwd: null, repoRelativePath: null, seedCommit: null, providerSessionId: null,
        providerProjectId: null, confinementEvidenceId: null, archiveRelativePath: null,
        worktreeOwner: 'NONE', bindingEvidence: 'UNBOUND', groupingStatus: 'UNKNOWN',
        requirement: decision.requirement, confinementStatus: 'UNVERIFIED', lastReceipt: null,
        cancelRequestId: null, stopStatus: 'NOT_REQUESTED', lifecycle: 'PREPARING',
        // An explicit undefined would break canonical hashing — the field rides along only when set.
        ...(assignment.toolProfile ? { toolProfile: assignment.toolProfile } : {}),
      });
      this.store.appendLocalJournal({ operationId, localSessionId: binding.id, jobId: job.id, kind: 'PREPARE', phase: 'INTENT',
        expectedRevision: binding.revision, source: null, destination: binding.storageRelativePath, outcome: 'NONE', failureDetail: null });
      return { binding, operationId };
    }
    if (existing.lifecycle === 'PREPARATION_FAILED') {
      // The declared re-attempt edge: a fresh attempt in a fresh directory. The failed attempt's
      // residue is never touched — its receipts and cancel records die on attemptId mismatch, so
      // attempt-scoped state resets and the new attempt's first receipt starts at sequence 1.
      const { revision: _revision, updatedAt: _updatedAt, ...rest } = existing;
      const binding = this.store.updateLocalSession({
        localSessionId: existing.id, expectedRevision: existing.revision,
        next: { ...rest, lifecycle: 'PREPARING', attemptId: randomUUID(), storageRelativePath: mint(),
          packetHash: null, lastReceipt: null, cancelRequestId: null, stopStatus: 'NOT_REQUESTED' },
      });
      this.store.appendLocalJournal({ operationId, localSessionId: binding.id, jobId: job.id, kind: 'PREPARE', phase: 'INTENT',
        expectedRevision: binding.revision, source: null, destination: binding.storageRelativePath, outcome: 'NONE', failureDetail: null });
      return { binding, operationId };
    }
    throw new Error(`This job already has a local-session binding in ${existing.lifecycle}; reconcile it before dispatching again — the office never silently rebinds.`);
  }

  /**
   * Records what submit actually did to a bound delivery. A returned packet hash is the adapter's
   * proof it wrote a versioned (v2) packet — the record then carries the proven contract, not only
   * the adapter's declaration — and a thrown submit fails the preparation. The CAS only ever acts
   * on the PREPARING record this attempt observed; a binding that already moved belongs to
   * reconciliation and is never overwritten by a dispatch finishing late.
   */
  private settleLocalPreparation(attempt: { binding: LocalSessionRecord; operationId: string }, outcome: 'READY' | 'PREPARATION_FAILED', packetHash: string | null, failureDetail: string | null): void {
    const current = this.store.localSessionForJob(attempt.binding.jobId);
    if (!current || current.id !== attempt.binding.id || current.lifecycle !== 'PREPARING') return;
    try {
      const { revision: _revision, updatedAt: _updatedAt, ...rest } = current;
      const next = this.store.updateLocalSession({
        localSessionId: current.id, expectedRevision: current.revision,
        next: outcome === 'READY'
          ? { ...rest, lifecycle: 'READY', packetHash, packetVersion: packetHash ? 2 : current.packetVersion }
          : { ...rest, lifecycle: 'PREPARATION_FAILED' },
      });
      this.store.appendLocalJournal({
        operationId: attempt.operationId, localSessionId: next.id, jobId: next.jobId, kind: 'PREPARE',
        phase: outcome === 'READY' ? 'VERIFIED' : 'FAILED', expectedRevision: next.revision,
        source: null, destination: current.storageRelativePath, outcome: outcome === 'READY' ? 'SUCCESS' : 'UNKNOWN',
        failureDetail: failureDetail === null ? null : failureDetail.slice(0, 2000),
      });
    } catch {
      // A record that already moved belongs to reconciliation, not to this dispatch.
    }
  }

  /**
   * Persists what a bound local observation verified: a receipt's sequence and read-hash become
   * the binding's lastReceipt — the next receipt must advance past it — and a validated cancel
   * acknowledgement marks the stop status SESSION_REPORTED_STOPPED, the session's own word that it
   * stopped. These are same-lifecycle metadata updates through the store's CAS; the job's own
   * observation handling is unchanged.
   */
  private recordLocalObservation(job: ProviderJob, result: ObserveResult): void {
    if (!result.receipt && !result.cancelAck && !result.providerGrouping) return;
    const binding = this.store.localSessionForJob(job.id);
    if (!binding) return;
    const { revision: _revision, updatedAt: _updatedAt, ...rest } = binding;
    const next = { ...rest };
    if (result.receipt) next.lastReceipt = { sequence: result.receipt.sequence, hash: result.receipt.hash, observedAt: this.now() };
    if (result.cancelAck) next.stopStatus = 'SESSION_REPORTED_STOPPED';
    // A resolved provider record upgrades the grouping claim only — a later observe that finds
    // nothing reports no field and downgrades nothing. The record's own key is also the exact
    // identity provider-side inspect/archive needs (session id, project key or rollout name).
    if (result.providerGrouping) {
      next.groupingStatus = 'OBSERVED';
      next.providerProjectId = result.providerGrouping.key;
      next.providerSessionId = result.providerGrouping.key;
    }
    this.store.updateLocalSession({ localSessionId: binding.id, expectedRevision: binding.revision, next });
  }

  /** Records what the provider currently reports, including its visible events. */
  async observe(assignmentId: string): Promise<AppState> {
    let job = this.job(assignmentId);
    if (isTerminalJob(job.state)) return this.store.snapshot({history:false});
    const adapter = this.adapterFor({ route: job.route });
    const result = await adapter.observe(job);
    if (result.events?.length) this.store.recordJobEvents(job.id, result.events);
    this.recordLocalObservation(job, result);
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
      // adapter.fetch is a method that reads its own adapter state (the session root), so it
      // must stay bound to the adapter — extracting it bare crashes every declared output.
      const fetch = adapter.fetch ? adapter.fetch.bind(adapter) : this.fetchOutput;
      if (!fetch) { failures.push(`${output.path} was reported but this route cannot retrieve bytes.`); continue; }
      if (!this.storeOutput) { failures.push(`${output.path} cannot be durably stored by this route.`); continue; }
      try {
        const bytes = await fetch(job, output);
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
    // A verified receipt's applied self-report is the session's own claim about what ran — never
    // folded into the job's verified outcome. A bound v2 receipt names its own event identity
    // (the receipt hash), so replaying the same receipt dedupes while a fresh receipt reporting
    // identical values still lands. An unbound report has no receipt identity, so it dedupes
    // against the latest report instead of the content hash alone — that keeps repeated polls of
    // an unchanged file quiet while a return to an earlier value (A→B→A) still lands.
    if (result.applied && (result.applied.model !== undefined || result.applied.effort !== undefined || result.applied.delegation !== undefined)) {
      const declared: string[] = [];
      if (result.applied.model !== undefined) declared.push(`appliedModel=${JSON.stringify(result.applied.model)}`);
      if (result.applied.effort !== undefined) declared.push(`appliedEffort=${JSON.stringify(result.applied.effort)}`);
      if (result.applied.delegation !== undefined) declared.push(`delegation=${result.applied.delegation}`);
      const text = `Session self-reported ${declared.join(', ')} on a verified receipt — the session's own claim, not office-verified.`;
      // Present-but-undefined fields are stripped before hashing — canonical values carry none.
      const stripped = {
        ...(result.applied.model !== undefined ? { model: result.applied.model } : {}),
        ...(result.applied.effort !== undefined ? { effort: result.applied.effort } : {}),
        ...(result.applied.delegation !== undefined ? { delegation: result.applied.delegation } : {}),
      };
      const latest = this.store.appliedReports(job.id, 1).at(-1);
      let externalId: string | null;
      let applied;
      if (result.receipt) {
        externalId = `applied:${result.receipt.hash}`;
        const binding = this.store.localSessionForJob(job.id);
        applied = binding ? appliedReportPayloadSchema.parse({
          schema: 'office-applied-report@1', attemptId: binding.attemptId,
          receiptSequence: result.receipt.sequence, receiptHash: result.receipt.hash, ...stripped,
        }) : undefined;
      } else {
        externalId = latest?.text === text ? null
          : `applied:${canonicalHash({ report: stripped, after: latest?.id ?? 'none' })}`;
        applied = undefined;
      }
      if (externalId) this.store.recordJobEvents(job.id, [{ externalId, cursor: '', kind: 'STATUS', text,
        occurredAt: this.now(), receivedAt: this.now(), evidence: 'PROVIDER_REPORTED',
        // A present-but-undefined key would survive zod and poison the change's canonical hash.
        ...(applied ? { applied } : {}) }]);
    }
    const fresh = retrieved.filter(output => !job.outputs.some(old => old.path === output.path && old.sha256 === output.sha256 && old.stored));
    if (job.state === result.state && !fresh.length) return this.store.snapshot({history:false});
    const transitioned = this.store.recordJobTransition({
      jobId: job.id, expectedRevision: job.revision, to: result.state, evidence: 'PROVIDER_REPORTED',
      detail, outputs: fresh.length ? fresh : undefined, at: this.now(),
    });
    // A verified observation of a local session is itself office evidence — recorded only when the
    // observation changed something, so repeated polls do not churn capability snapshots.
    this.noteLocalEvidence(job, adapter.observeEvidence?.(job, result) ?? []);
    // The receipt's self-reported memory ingests only after the verified COMPLETED transition —
    // every cited output already exists as a stored artifact by then. Malformed entries are
    // skipped by ingest, never thrown; the report lands as a dedup-keyed job event.
    if (result.state === 'COMPLETED' && result.receipt && result.memory && (result.memory.findings?.length || result.memory.links?.length)) {
      const assignment = this.store.snapshot({ history: false }).assignments?.find(item => item.id === job.assignmentId);
      try {
        if (!assignment) throw new Error('the job names an assignment the office does not hold');
        const report = ingestReceiptMemory(this.store, {
          projectId: assignment.projectId, requestId: assignment.requestId, assignmentId: assignment.id,
          agentId: assignment.agentId, receiptHash: result.receipt.hash,
        }, result.memory);
        const summary = `Receipt memory ingested: ${report.findings.length} finding${report.findings.length === 1 ? '' : 's'} recorded, ${report.links.length} link${report.links.length === 1 ? '' : 's'} proposed` +
          (report.findingsSkipped.length || report.linksSkipped.length
            ? `; ${report.findingsSkipped.length + report.linksSkipped.length} malformed entr${report.findingsSkipped.length + report.linksSkipped.length === 1 ? 'y' : 'ies'} skipped`
            : '') + '.';
        this.store.recordJobEvents(job.id, [{ externalId: `memory:${result.receipt.hash}`, cursor: '', kind: 'STATUS', text: summary,
          occurredAt: this.now(), receivedAt: this.now(), evidence: 'OFFICE_LOCAL' }]);
      } catch (error) {
        this.store.recordJobEvents(job.id, [{ externalId: `memory-failed:${result.receipt.hash}`, cursor: '', kind: 'STATUS',
          text: `Receipt memory could not be ingested: ${error instanceof Error ? error.message : 'unknown error'}`,
          occurredAt: this.now(), receivedAt: this.now(), evidence: 'OFFICE_LOCAL' }]);
      }
    }
    return transitioned;
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
    const adapter = this.adapterFor({ route: job.route });
    const result = await adapter.cancel(job);
    const binding = this.store.localSessionForJob(job.id);
    if (!result.acknowledged) {
      if (binding) this.store.appendLocalJournal({
        operationId: randomUUID(), localSessionId: binding.id, jobId: job.id, kind: 'CANCEL_REQUEST',
        phase: 'EXECUTED', expectedRevision: binding.revision, source: null, destination: null,
        outcome: 'REFUSED', failureDetail: result.detail.slice(0, 2000),
      });
      this.store.recordJobEvents(job.id, [{ externalId: `cancel-attempt:${job.revision}`, cursor: '', kind: 'STATUS',
        text: `Cancellation not acknowledged: ${result.detail}`, occurredAt: this.now(), receivedAt: this.now(), evidence: 'OFFICE_LOCAL' }]);
      return this.store.snapshot({history:false});
    }
    if (binding && result.requestId) {
      // A cooperative cancel request was delivered into the packet — persist which request and
      // that a request is now outstanding. The job stays CANCEL_REQUESTED: delivering a request
      // is not a stopped session, and the session's own acknowledgement arrives through observe().
      const { revision: _r, updatedAt: _u, ...rest } = binding;
      const requested = this.store.updateLocalSession({
        localSessionId: binding.id, expectedRevision: binding.revision,
        next: { ...rest, cancelRequestId: result.requestId, stopStatus: 'REQUESTED' },
      });
      this.store.appendLocalJournal({
        operationId: randomUUID(), localSessionId: requested.id, jobId: job.id, kind: 'CANCEL_REQUEST',
        phase: 'EXECUTED', expectedRevision: requested.revision, source: null, destination: null,
        outcome: 'SUCCESS', failureDetail: null,
      });
      this.noteLocalEvidence(job, adapter.cancelEvidence?.(job) ?? []);
      return this.store.snapshot({history:false});
    }
    // The acknowledgement's provenance follows who actually answered: a hosted provider's reply is
    // PROVIDER_REPORTED, but a local route's acknowledgement is the office's own sentinel write —
    // recording that as provider testimony manufactures evidence (defect F02, legacy path).
    const acknowledged = this.store.recordJobTransition({ jobId: job.id, expectedRevision: job.revision, to: 'CANCEL_ACKNOWLEDGED',
      evidence: job.route.startsWith('LOCAL_') ? 'OFFICE_LOCAL' : 'PROVIDER_REPORTED', detail: result.detail, at: this.now() });
    this.noteLocalEvidence(job, adapter.cancelEvidence?.(job) ?? []);
    return acknowledged;
  }

  /**
   * Retires one settled local session: the packet directory moves under archive/ (bytes retained,
   * never deleted), and the provider-side record is archived only through a supported exact-id
   * verb — providers without one report UNSUPPORTED and are never touched. The journal records
   * durable intent before anything moves, so a crash mid-retire leaves a reconcilable record
   * instead of a half-moved packet. Retirement changes the packet's storage, never the job's
   * recorded outcome.
   */
  async retireLocal(assignmentId: string): Promise<{
    state: AppState;
    archive: { operationId: string; packetOutcome: 'ARCHIVED' | 'ALREADY_ARCHIVED' | 'REFUSED' | 'UNKNOWN'; providerOutcome: 'NOT_REQUESTED' | 'ARCHIVED' | 'ALREADY_ARCHIVED' | 'UNSUPPORTED' | 'BUSY' | 'UNKNOWN'; detail: string };
  }> {
    const job = this.job(assignmentId);
    const binding = this.store.localSessionForJob(job.id);
    if (!binding) throw new Error('This job has no local-session binding — nothing to retire.');
    if (!isTerminalJob(job.state))
      throw new Error(`This job is ${job.state.toLowerCase().replaceAll('_', ' ')} — only finished work retires; observe or cancel it first.`);
    if (binding.lifecycle !== 'READY')
      throw new Error(`This packet is ${binding.lifecycle.toLowerCase().replaceAll('_', ' ')} — only a ready packet archives; reconcile the record first if it disagrees.`);
    if (binding.layout !== 'FLAT_PACKET')
      throw new Error('The worktree layout carries no retire operation — reconcile it manually.');
    const operationId = randomUUID();
    const destination = `archive/${binding.storageRelativePath}`;
    this.store.appendLocalJournal({
      operationId, localSessionId: binding.id, jobId: job.id, kind: 'PACKET_ARCHIVE', phase: 'INTENT',
      expectedRevision: binding.revision, source: binding.storageRelativePath, destination, outcome: 'NONE', failureDetail: null,
    });
    const { revision: _r0, updatedAt: _u0, ...rest0 } = binding;
    let current = this.store.updateLocalSession({
      localSessionId: binding.id, expectedRevision: binding.revision, next: { ...rest0, lifecycle: 'ARCHIVING' },
    });
    const adapter = this.adapterFor({ route: job.route });
    const retiring = adapter as ProviderAdapter & { retire?: (job: ProviderJob) => Promise<{ retired: boolean; alreadyArchived?: boolean; archivedAs?: string; detail: string }> };
    let retired: { retired: boolean; alreadyArchived?: boolean; archivedAs?: string; detail: string };
    try {
      retired = typeof retiring.retire === 'function'
        ? await retiring.retire(job)
        : { retired: false, detail: 'This route carries no retire operation.' };
    } catch (error) {
      // A thrown retire may have partially moved the packet — the record claims neither side.
      const message = error instanceof Error ? error.message : 'unknown error';
      const { revision: _rx, updatedAt: _ux, ...restx } = current;
      current = this.store.updateLocalSession({
        localSessionId: current.id, expectedRevision: current.revision, next: { ...restx, lifecycle: 'RECONCILE_REQUIRED' },
      });
      this.store.appendLocalJournal({
        operationId, localSessionId: binding.id, jobId: job.id, kind: 'PACKET_ARCHIVE', phase: 'FAILED',
        expectedRevision: current.revision, source: binding.storageRelativePath, destination,
        outcome: 'UNKNOWN', failureDetail: `The packet move threw (${message.slice(0, 1900)}) — the directory may be partially moved; reconcile before trusting either side.`,
      });
      return { state: this.store.snapshot({ history: false }),
        archive: { operationId, packetOutcome: 'UNKNOWN', providerOutcome: 'NOT_REQUESTED',
          detail: `The packet move threw: ${message.slice(0, 1800)} The record is reconcile-required; provider archive was not attempted.` } };
    }
    const packetOutcome = retired.retired ? (retired.alreadyArchived ? 'ALREADY_ARCHIVED' : 'ARCHIVED') : 'REFUSED';
    {
      const { revision: _r1, updatedAt: _u1, ...rest1 } = current;
      current = this.store.updateLocalSession({
        localSessionId: current.id, expectedRevision: current.revision,
        next: retired.retired
          ? { ...rest1, lifecycle: 'ARCHIVED', archiveRelativePath: retired.archivedAs ?? destination }
          : { ...rest1, lifecycle: 'READY' },
      });
      this.store.appendLocalJournal({
        operationId, localSessionId: binding.id, jobId: job.id, kind: 'PACKET_ARCHIVE', phase: 'EXECUTED',
        expectedRevision: current.revision, source: binding.storageRelativePath, destination,
        outcome: retired.retired ? 'SUCCESS' : 'REFUSED', failureDetail: retired.retired ? null : retired.detail.slice(0, 2000),
      });
    }
    // Provider-side archive runs only when discovery recorded an exact record identity, and only
    // through a supported verb — an unobserved or unsupported record is honestly NOT_REQUESTED or
    // UNSUPPORTED, and no provider bytes are ever deleted by the office.
    let providerOutcome: 'NOT_REQUESTED' | 'ARCHIVED' | 'ALREADY_ARCHIVED' | 'UNSUPPORTED' | 'BUSY' | 'UNKNOWN' = 'NOT_REQUESTED';
    let detail = retired.detail;
    if (!binding.providerSessionId) {
      detail += ' No provider-side record identity was observed for this session — provider archive was not requested.';
    } else if (!this.providerLifecycle) {
      providerOutcome = 'UNKNOWN';
      detail += ' No provider lifecycle service is configured — provider archive was not attempted.';
    } else {
      const outcome = await this.providerLifecycle.archive({ provider: binding.provider, providerSessionId: binding.providerSessionId }, operationId);
      providerOutcome = outcome.status;
      detail += ` ${outcome.detail}`;
      this.store.appendLocalJournal({
        operationId, localSessionId: binding.id, jobId: job.id, kind: 'PROVIDER_ARCHIVE', phase: 'EXECUTED',
        expectedRevision: current.revision, source: null, destination: null,
        outcome: outcome.status === 'ARCHIVED' || outcome.status === 'ALREADY_ARCHIVED' ? 'SUCCESS'
          : outcome.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : outcome.status === 'BUSY' ? 'REFUSED' : 'UNKNOWN',
        failureDetail: outcome.status === 'ARCHIVED' || outcome.status === 'ALREADY_ARCHIVED' ? null : outcome.detail.slice(0, 2000),
      });
    }
    this.noteLocalEvidence(job, (adapter as { retireEvidence?: (id: string) => CapabilityEvidence[] }).retireEvidence?.(job.externalId) ?? []);
    return { state: this.store.snapshot({ history: false }),
      archive: { operationId, packetOutcome, providerOutcome, detail: detail.slice(0, 2000) } };
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
