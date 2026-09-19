import type { AccountConnection, AdapterRoute, Agent, AppState, CapabilityOperation, EffectiveEvidence, Effort, ExecutionEnvironment, Provider, ProviderCapabilitySnapshot, ProviderReadiness, ReadinessActions } from './types.js';

/** Conservative application defaults. They are our own staleness rules, not provider guarantees. */
export const ACCOUNT_STALE_MS = 5 * 60 * 1000;
// A local account check is an office-observed CLI probe, not provider attestation; the manual
// packet/handoff flow spans more wall-clock than a hosted dispatch, so local scopes get a wider
// window before the check reads as stale.
export const LOCAL_ACCOUNT_STALE_MS = 30 * 60 * 1000;
export const CAPABILITY_EXPIRY_MS = 24 * 60 * 60 * 1000;
type Records = Pick<AppState, 'connections' | 'capabilities'>;
type Options = { now?: number; model?: string; environment?: string; effort?: Effort; delegation?: boolean; route?: AdapterRoute; execution?: ExecutionEnvironment };

/**
 * The exact conditions one external action would run under.
 *
 * Readiness is not a property of an account; it is a property of an account doing a specific thing
 * with a specific tool, model, effort and collaboration policy, through a specific route. Evidence
 * gathered under other conditions is evidence about those conditions, not about this one.
 */
export interface RequestedScope {
  provider: Provider;
  identity: string;
  credentialContext: string;
  toolVersion: string;
  route: AdapterRoute;
  environment: string;
  model: string;
  effort: Effort;
  delegation: boolean;
}

/** Which recorded transports can carry which adapter route. A route with no transport is unsupported. */
const ROUTE_TRANSPORT: Record<RequestedScope['route'], readonly ProviderCapabilitySnapshot['transport'][]> = {
  FAKE_ADAPTER: ['NONE', 'OFFICIAL_CLI_PIPE', 'OFFICIAL_CLI_TERMINAL'],
  OFFICIAL_TERMINAL_HANDOFF: ['OFFICIAL_CLI_TERMINAL'],
  OFFICIAL_CLI_PTY: ['OFFICIAL_CLI_TERMINAL'],
  LOCAL_MAILBOX: ['LOCAL_MAILBOX'],
  LOCAL_CLI_EXEC: ['LOCAL_CLI_EXEC'],
  LOCAL_ACP: ['LOCAL_ACP'],
};

/** The dispatch family a requested scope must satisfy follows its route, never silently the other one. */
function dispatchFamily(route: RequestedScope['route']): readonly CapabilityOperation[] {
  return route.startsWith('LOCAL_') ? LOCAL_DISPATCH : CLOUD_DISPATCH;
}

/**
 * Everything about the requested scope that the recorded evidence does not support.
 *
 * An empty list is not a claim that the action will succeed; it is the absence of a known reason it
 * must not be attempted. Anything unverified is reported, never assumed.
 */
export function scopeMismatches(state: Records, scope: RequestedScope, options: Options = {}): string[] {
  const now = options.now ?? Date.now();
  const problems: string[] = [];
  const connection = currentConnection(state, scope.provider);
  if (!connection) return ['No account check has been recorded for this provider yet.'];
  if (connection.identity !== scope.identity) problems.push(`This work was frozen for ${scope.identity}, but ${connection.identity} is the current account context.`);
  if (connection.credentialContext !== scope.credentialContext) problems.push(`The credential context changed from ${scope.credentialContext} to ${connection.credentialContext}.`);
  const snapshot = latestCapability(state, connection.id);
  if (!snapshot) return [...problems, 'No capability snapshot has been recorded for this account.'];
  if (snapshot.toolVersion !== scope.toolVersion) problems.push(`The official tool changed from ${scope.toolVersion} to ${snapshot.toolVersion}; its evidence does not carry over.`);

  // The execution scope is the evidence's own provenance, not the newest snapshot's. A metadata-only
  // refresh records transport NONE and an empty environment; reading the identity of the environment
  // work would run in from that snapshot would let a bare sign-in check redefine the execution scope.
  const supplying = new Set<string>();
  for (const operation of dispatchFamily(scope.route)) {
    const scoped: Options = PROVIDER_WIDE.includes(operation)
      ? { now, environment: scope.environment, route: scope.route }
      : { now, model: scope.model, environment: scope.environment, route: scope.route };
    if (operation === 'EFFORT_APPLICATION') scoped.effort = scope.effort;
    if (operation === 'DELEGATION_CONTROL') scoped.delegation = scope.delegation;
    const evidence = effectiveEvidence(state, connection, operation, scoped);
    if (evidence) supplying.add(evidence.snapshotId);
    if (!verified(evidence, scope.route.startsWith('LOCAL_'))) {
      problems.push(`Unverified ${LABEL[operation]} for this exact scope: ${evidence ? (evidence.impossible ? `evidence is dated after the moment it is being checked at (${evidence.verifiedAt})` : evidence.expired ? `evidence expired (checked ${evidence.verifiedAt})` : `${evidence.level.toLowerCase().replaceAll('_', ' ')}, ${evidence.evidence.toLowerCase()}`) : 'no evidence recorded for these conditions'}.`);
      continue;
    }
    // Each operation's own observation must have come through a transport that carries this route,
    // and must have been taken in the environment the work is frozen for.
    if (!ROUTE_TRANSPORT[scope.route].includes(evidence!.transport))
      problems.push(`${LABEL[operation]} was observed over ${evidence!.transport.toLowerCase().replaceAll('_', ' ')}, which does not carry the ${scope.route.toLowerCase().replaceAll('_', ' ')} route.`);
    // Confinement is the one operation whose content matters, not merely its presence: it must
    // describe an actually observed tool, filesystem, network and environment restriction.
    if (operation === 'TOOL_CONFINEMENT' && !confinementDescribed(evidence!.confinement))
      problems.push('Tool confinement evidence does not describe an observed tool, filesystem, network and environment restriction, so enforced confinement is unproven.');
  }
  return problems;
}

/** A confinement record has to say what was restricted. An empty field asserts nothing. */
function confinementDescribed(policy: EffectiveEvidence['confinement']): boolean {
  return Boolean(policy && policy.tools.trim() && policy.filesystem.trim() && policy.network.trim() && policy.environment.trim());
}

/**
 * Which capability snapshots actually supplied the evidence for one scope.
 *
 * An assignment binds to this whole set. Binding to the newest snapshot alone would let a later
 * metadata-only observation stand in for the transport check that really authorized the work.
 */
export function supplyingSnapshotIds(state: Records, scope: RequestedScope, options: Options = {}): string[] {
  const now = options.now ?? Date.now();
  const connection = currentConnection(state, scope.provider);
  if (!connection) return [];
  const ids = new Set<string>();
  for (const operation of dispatchFamily(scope.route)) {
    const scoped: Options = PROVIDER_WIDE.includes(operation)
      ? { now, environment: scope.environment, route: scope.route }
      : { now, model: scope.model, environment: scope.environment, route: scope.route };
    if (operation === 'EFFORT_APPLICATION') scoped.effort = scope.effort;
    if (operation === 'DELEGATION_CONTROL') scoped.delegation = scope.delegation;
    const evidence = effectiveEvidence(state, connection, operation, scoped);
    if (evidence) ids.add(evidence.snapshotId);
  }
  return [...ids].sort();
}

/**
 * The active context is the newest recorded observation order, not the largest wall-clock time.
 * Clock changes and out-of-order results must not silently reselect an account.
 */
export function currentConnection(state: Pick<AppState, 'connections'>, provider: Provider): AccountConnection | undefined {
  return (state.connections ?? []).filter(c => c.provider === provider)
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.lastCheckedAt.localeCompare(b.lastCheckedAt)).at(-1);
}

/** The newest immutable snapshot recorded for a connection. Snapshots are never edited in place. */
export function latestCapability(state: Pick<AppState, 'capabilities'>, connectionId: string): ProviderCapabilitySnapshot | undefined {
  return (state.capabilities ?? []).filter(c => c.connectionId === connectionId).at(-1);
}

/**
 * Effective evidence for one operation, chosen per operation rather than per snapshot.
 *
 * An observed result outranks documentation regardless of age, so a later metadata-only poll can
 * neither overwrite a real transport check nor renew its verification time. A later observed result
 * does supersede an earlier one, which is how an explicit invalidation takes effect.
 * Evidence is discarded outright when the tool, transport or environment it was taken under has changed.
 */
export function effectiveEvidence(state: Records, connection: AccountConnection, operation: CapabilityOperation, options: Options = {}): EffectiveEvidence | undefined {
  const now = options.now ?? Date.now();
  const current = latestCapability(state, connection.id);
  if (!current) return undefined;
  const candidates = (state.capabilities ?? []).map((snapshot, order) => ({ snapshot, order }))
    .filter(({ snapshot }) => snapshot.connectionId === connection.id
      && snapshot.toolVersion === current.toolVersion && snapshot.identity === connection.identity)
    .flatMap(({ snapshot, order }) => snapshot.operations.filter(entry => entry.operation === operation).map(entry => ({ snapshot, entry, order })))
    // The route an observation was taken through is part of what it says. A terminal handoff and an
    // automated PTY session both record OFFICIAL_CLI_TERMINAL, but exercising one does not exercise
    // the other, so evidence that names a route only answers for that route.
    .filter(({ entry }) => !options.route || entry.route === undefined || entry.route === options.route)
    .filter(({ entry }) => !options.model || entry.model === options.model)
    // An observation's environment is the snapshot's unless the entry names a narrower one; that is a
    // fact about where it was taken, not an assumption.
    .filter(({ entry, snapshot }) => !options.environment || (entry.environment ?? snapshot.environment) === options.environment)
    // Effort and delegation have no snapshot-level fallback. Evidence that does not declare the value
    // being asked about is evidence about a different question.
    .filter(({ entry }) => options.effort === undefined || entry.effort === options.effort)
    .filter(({ entry }) => options.delegation === undefined || entry.delegation === options.delegation);
  const rank = (kind: string | undefined) => (kind === 'OBSERVED' ? 1 : 0);
  // Supersession follows the order observations were durably recorded, not the timestamps they
  // carry. A result stamped in the future would otherwise outrank the later invalidation that
  // superseded it, which is precisely how a revoked route could appear to still work.
  const chosen = candidates.sort((a, b) => rank(a.entry.evidence) - rank(b.entry.evidence) || a.order - b.order).at(-1);
  if (!chosen) return undefined;
  const verifiedAt = chosen.entry.verifiedAt ?? chosen.snapshot.observedAt;
  return {
    operation, level: chosen.entry.level, evidence: chosen.entry.evidence ?? 'DOCUMENTED', verifiedAt,
    model: chosen.entry.model ?? '', environment: chosen.entry.environment ?? chosen.snapshot.environment,
    effort: chosen.entry.effort, delegation: chosen.entry.delegation, route: chosen.entry.route,
    confinement: chosen.entry.confinement, transport: chosen.snapshot.transport,
    // A check cannot have been performed later than the moment it is being judged at. Rather than
    // silently treating a negative age as fresh, this is refused outright.
    impossible: Date.parse(verifiedAt) > now,
    detail: chosen.entry.detail, source: chosen.entry.source ?? chosen.snapshot.source, snapshotId: chosen.snapshot.id,
    expired: now - Date.parse(verifiedAt) > CAPABILITY_EXPIRY_MS,
  };
}

/**
 * An operation counts as usable only when it was observed for this exact scope and has not expired.
 * For local scopes the office itself is the observing authority — it writes the packet, reads the
 * receipt and lands the sentinel — so office-observed TOOL_SUPPORTED is the local ceiling. Hosted
 * scopes keep requiring provider-side ACCOUNT_VERIFIED attestation, and the two families share no
 * operations, so office testimony can never stand in for a provider's.
 */
function verified(evidence: EffectiveEvidence | undefined, local = false): boolean {
  return Boolean(evidence && evidence.evidence === 'OBSERVED' && !evidence.expired && !evidence.impossible
    && (evidence.level === 'ACCOUNT_VERIFIED' || (local && evidence.level === 'TOOL_SUPPORTED')));
}

/**
 * Provider-wide facts. Signing in and listing a catalog are not done per model, so asking for
 * model-scoped evidence of them would be asking the wrong question. They may inform catalog display
 * and the signed-in state, and nothing else.
 */
const PROVIDER_WIDE: CapabilityOperation[] = ['ACCOUNT_STATUS', 'MODEL_CATALOG', 'ALLOWANCE_READ'];
const CLOUD_DISPATCH: CapabilityOperation[] = ['CLOUD_SUBMIT', 'CLOUD_OBSERVE', 'CLOUD_OUTPUT_FETCH', 'CLOUD_CANCEL_REQUEST', 'CLOUD_CANCEL_ACK', 'MODEL_APPLICATION', 'EFFORT_APPLICATION', 'ENVIRONMENT_IDENTITY', 'DELEGATION_CONTROL', 'TOOL_CONFINEMENT'];
/**
 * The local-session dispatch family. Evidence here is office-observed — the office writes the packet
 * or spawns the child itself — so it is TOOL_SUPPORTED/OBSERVED, never an ACCOUNT_VERIFIED provider
 * attestation. Scoped workspace delivery is recorded under TOOL_CONFINEMENT and is not isolation.
 */
const LOCAL_DISPATCH: CapabilityOperation[] = ['LOCAL_SUBMIT', 'LOCAL_OBSERVE', 'LOCAL_OUTPUT_FETCH', 'LOCAL_CANCEL', 'MODEL_APPLICATION', 'EFFORT_APPLICATION', 'DELEGATION_CONTROL', 'TOOL_CONFINEMENT'];
const REPORTED: CapabilityOperation[] = [...new Set(['ACCOUNT_STATUS', 'MODEL_CATALOG', 'ALLOWANCE_READ', ...CLOUD_DISPATCH, 'CLOUD_FOLLOW_UP', ...LOCAL_DISPATCH] as CapabilityOperation[])];
const LABEL: Record<CapabilityOperation, string> = {
  ACCOUNT_STATUS: 'account status', MODEL_CATALOG: 'model catalog', ALLOWANCE_READ: 'allowance read',
  CLOUD_SUBMIT: 'cloud submission', CLOUD_OBSERVE: 'cloud observation', CLOUD_FOLLOW_UP: 'cloud follow-up',
  CLOUD_OUTPUT_FETCH: 'output retrieval', CLOUD_CANCEL_REQUEST: 'cancellation request', CLOUD_CANCEL_ACK: 'cancellation acknowledgement',
  MODEL_APPLICATION: 'applied model', EFFORT_APPLICATION: 'applied effort', ENVIRONMENT_IDENTITY: 'environment identity',
  DELEGATION_CONTROL: 'delegation control', TOOL_CONFINEMENT: 'tool, filesystem and network confinement', CLOUD_CANCEL: 'cancellation (legacy record)',
  LOCAL_SUBMIT: 'local session submission', LOCAL_OBSERVE: 'local session observation', LOCAL_OUTPUT_FETCH: 'local output retrieval', LOCAL_CANCEL: 'local session cancellation', LOCAL_RETIRE: 'local session retirement',
};

/**
 * Per-action readiness. Signed in, model checked, cloud checked and ready stay separate, and no
 * action is enabled by another action's evidence. Submission alone never means ready.
 */
export function providerReadiness(state: Records, provider: Provider, options: Options = {}): ProviderReadiness {
  const now = options.now ?? Date.now();
  const model = options.model ?? '';
  const connection = currentConnection(state, provider);
  const snapshot = connection ? latestCapability(state, connection.id) : undefined;
  // Model scope is applied only to operations that actually have one. A provider-wide observation is
  // not evidence about a model, and must not be discarded for failing to mention one either.
  // Each operation is asked about under the scope it actually has. Provider-wide operations are not
  // asked about a model; effort and delegation are asked only of the operations that record them.
  const evidence = connection ? REPORTED.map(operation => {
    if (PROVIDER_WIDE.includes(operation)) return effectiveEvidence(state, connection, operation, { ...options, model: undefined, effort: undefined, delegation: undefined, now });
    const scoped: Options = { ...options, now };
    if (operation !== 'EFFORT_APPLICATION') delete scoped.effort;
    if (operation !== 'DELEGATION_CONTROL') delete scoped.delegation;
    return effectiveEvidence(state, connection, operation, scoped);
  }).filter((item): item is EffectiveEvidence => Boolean(item)) : [];
  const found = new Map(evidence.map(item => [item.operation, item]));
  // Evidence that exists but does not match the requested scope still deserves to be described, so a
  // blocker can say "documented, for another model" rather than the less useful "nothing recorded".
  // It is only ever read for the message; `has` below stays strictly scoped.
  const described = new Map((connection ? REPORTED.map(operation => effectiveEvidence(state, connection, operation, { now }))
    .filter((item): item is EffectiveEvidence => Boolean(item)) : []).map(item => [item.operation, item]));
  // The verification bar follows the requested family: an explicit route is the ground truth,
  // otherwise the execution environment chooses. A route's family never relaxes for the other one.
  const localScope = options.route ? options.route.startsWith('LOCAL_') : options.execution === 'LOCAL';
  const has = (operation: CapabilityOperation) => verified(found.get(operation), localScope);

  const signedIn = connection?.state === 'SIGNED_IN' && has('ACCOUNT_STATUS');
  const accountStaleMs = localScope ? LOCAL_ACCOUNT_STALE_MS : ACCOUNT_STALE_MS;
  const accountFresh = Boolean(connection && now - Date.parse(connection.lastCheckedAt) <= accountStaleMs);
  // A provider-wide catalog does not verify the selected model; scoped application evidence does.
  const modelChecked = model
    ? has('MODEL_APPLICATION') && found.get('MODEL_APPLICATION')?.model === model
    : has('MODEL_CATALOG') && Boolean(snapshot?.models.length);
  // The dispatch family follows where the session would run, never silently the other one.
  const requiredDispatch = options.route ? [...dispatchFamily(options.route)] : options.execution === 'LOCAL' ? LOCAL_DISPATCH : CLOUD_DISPATCH;
  const dispatchChecked = requiredDispatch.every(has);
  const ready = signedIn && accountFresh && modelChecked && dispatchChecked;

  const blockers: string[] = [];
  const blockerDetails: NonNullable<ProviderReadiness['blockerDetails']> = [];
  // A blocker that fails the actions.handoff conditions (signed-in + fresh account) blocks the
  // manual action in front of the user. Evidence gaps for individual dispatch operations gate only
  // automatic start — manual packet write and handoff stay available while they are unverified.
  const block = (message: string, blocks: 'THIS_ACTION' | 'AUTOMATIC_START') => { blockers.push(message); blockerDetails.push({ message, blocks }); };
  if (!connection) block('No account check has been recorded for this provider yet.', 'THIS_ACTION');
  else if (connection.state !== 'SIGNED_IN') block(connection.note || 'The official tool does not report a signed-in subscription.', 'THIS_ACTION');
  else if (!has('ACCOUNT_STATUS')) block('The signed-in state has not been confirmed by an observed account check.', 'THIS_ACTION');
  if (connection && !snapshot) block('No capability snapshot has been recorded for this account.', 'THIS_ACTION');
  if (connection && !accountFresh) block('The account check is stale; recheck before any external action.', 'THIS_ACTION');
  if (signedIn && !modelChecked) block(model ? `The office has not verified that ${model} is the model a job would actually use.` : 'Model entitlement has not been verified for this account.', 'AUTOMATIC_START');
  for (const operation of requiredDispatch) {
    if (has(operation)) continue;
    const item = found.get(operation) ?? described.get(operation);
    const outOfScope = !found.has(operation) && described.has(operation) ? ' for these exact conditions' : '';
    block(`Unverified ${LABEL[operation]}${outOfScope}: ${item ? (item.expired ? `evidence expired (${item.level.toLowerCase().replace('_', ' ')}, checked ${item.verifiedAt})` : `${item.level.toLowerCase().replace('_', ' ')}, ${item.evidence.toLowerCase()}`) : 'no evidence recorded'}.`, 'AUTOMATIC_START');
  }

  const actions: ReadinessActions = {
    // Preparation, duplication and reading past handoffs are local bookkeeping and stay available.
    prepare: true, duplicate: true, viewTerminalHistory: true,
    handoff: signedIn && accountFresh,
    automaticStart: ready,
    observe: has(options.execution === 'LOCAL' ? 'LOCAL_OBSERVE' : 'CLOUD_OBSERVE'),
    requestCancellation: has(options.execution === 'LOCAL' ? 'LOCAL_CANCEL' : 'CLOUD_CANCEL_REQUEST'),
  };
  return {
    provider, connectionId: connection?.id ?? '', identity: connection?.identity ?? '', signedIn, accountFresh,
    modelChecked, dispatchChecked, ready, model, lastObservedAt: connection?.lastCheckedAt ?? '', lastCheckedAt: connection?.lastCheckedAt ?? '',
    actions, evidence, blockers, blockerDetails,
  };
}

/** How one profile relates to the accounts the office has actually observed. */
export interface AgentBinding {
  bound: boolean; setupIdentity: string; boundIdentity: string; currentIdentity: string;
  /** False when the profile predates the setup/bound distinction, so its origin is not recoverable. */
  setupIdentityKnown: boolean;
  rebound: boolean;
  matchesActiveContext: boolean; available: boolean; lastVerifiedAt: string; blockers: string[];
}

/**
 * A profile is usable only while its own binding matches the account the official tool reports now.
 * An absent binding is Unverified; it never inherits the current account.
 */
export function agentBinding(state: Records, agent: Pick<Agent, 'provider' | 'account' | 'setupAccount' | 'connectionId' | 'bindingVerifiedAt' | 'removedAt'>): AgentBinding {
  const bound = (state.connections ?? []).find(c => c.id === agent.connectionId);
  const active = currentConnection(state, agent.provider);
  const matchesActiveContext = Boolean(bound && active && bound.id === active.id);
  const available = matchesActiveContext && active?.state === 'SIGNED_IN';
  const blockers: string[] = [];
  if (!agent.connectionId) blockers.push(`Unverified: this profile was created for ${agent.account} and has not been checked against a recorded account. Use Verify connection.`);
  else if (!bound) blockers.push('This profile references an account record that is not in this workspace.');
  else if (!matchesActiveContext) blockers.push(active?.identity
    ? `Bound to ${bound.identity}, but ${active.identity} is the current context. Sign that account back in, or change the binding deliberately.`
    : `Bound to ${bound.identity}, but the current ${agent.provider} context did not report an account identity, so the binding cannot be verified. Check the account again; if the official tool still cannot name it, sign in through it.`);
  else if (active?.state !== 'SIGNED_IN') blockers.push('The bound account is not signed in right now.');
  if (agent.removedAt) blockers.push('Archived profiles are read-only until restored.');
  const setupIdentity = agent.setupAccount ?? agent.account;
  return {
    bound: Boolean(bound), setupIdentity, boundIdentity: bound?.identity ?? '', currentIdentity: active?.identity ?? '',
    setupIdentityKnown: agent.setupAccount !== undefined, rebound: setupIdentity !== agent.account,
    matchesActiveContext, available, lastVerifiedAt: agent.bindingVerifiedAt ?? '', blockers,
  };
}

/**
 * The full gate one profile must pass before any external dispatch: an available binding, a fresh
 * account check, and verified transport evidence for the exact model this profile would use.
 */
export function agentDispatchReadiness(state: Records, agent: Pick<Agent, 'provider' | 'model' | 'effort' | 'account' | 'setupAccount' | 'connectionId' | 'bindingVerifiedAt' | 'removedAt' | 'execution'>, options: Options = {}) {
  const binding = agentBinding(state, agent);
  // The profile's own effort is part of what would actually be requested, so readiness answers for
  // it rather than for an unspecified one. Route and delegation come from the caller when known.
  // The execution environment picks the dispatch family: LOCAL agents are gated on office-observed
  // local transport evidence, never silently on the hosted family.
  const readiness = providerReadiness(state, agent.provider, { ...options, execution: agent.execution ?? 'HOSTED_SETUP_REQUIRED', model: agent.model, effort: options.effort ?? agent.effort ?? 'default' });
  return {
    binding, readiness,
    canPrepare: !agent.removedAt,
    canHandoff: !agent.removedAt && binding.available && readiness.actions.handoff,
    canStart: !agent.removedAt && binding.available && readiness.actions.automaticStart,
    blockers: [...binding.blockers, ...readiness.blockers],
  };
}
