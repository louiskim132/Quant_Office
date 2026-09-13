import { randomUUID } from 'node:crypto';
import { removeTreeSync } from './fsx.js';
import type { AccountConnection, CapabilityEvidence, ProbeAttempt } from '../shared/types.js';
import { canonicalHash } from '../core/canonical.js';
import { prepareInputSnapshot } from './locations.js';
import { buildProviderPayload } from './controller.js';
import type { ProviderAdapter, SubmitContext } from './controller.js';
import type { OfficeStore } from '../core/store.js';
import { currentConnection, latestCapability } from '../shared/readiness.js';
import type { AccountObservation } from './subscriptions.js';

export interface ProbeResult { verified: boolean; detail: string; externalId: string; externalUrl: string }

const PROBE_OBJECTIVE = 'Read README.md, reply with its first line, and stop. Do not delegate, install packages, or use the network.';
const PROBE_CRITERIA = 'The first line of README.md is reported and nothing else is done.';

/**
 * The only way `CLOUD_SUBMIT` can ever become `ACCOUNT_VERIFIED`: actually create one tiny session
 * and record what happened.
 *
 * This is always user-initiated, spends the user's own subscription, and sends no research data —
 * only a generated fixture directory. Success records observed evidence scoped to the exact model
 * and tool version; failure records the exact error as observed evidence that the route did not work.
 * Neither outcome touches any other operation: observation, output retrieval, cancellation,
 * applied settings, environment identity and delegation control stay unverified.
 *
 * No production route reaches this function while R1-A containment is in force (see
 * shared/transport.ts). Its defects -- the fabricated staging commit and manifest hash below, the
 * missing durable intent, the staging removed in `finally`, and the absent duplicate refusal -- are
 * R1-B work that depends on R2, R3 and R4. Do not wire a new caller to it before then.
 */
/**
 * Failure metadata the office is willing to persist.
 *
 * A raw CLI exception can carry a path, a prompt, a token or an account detail, and capability
 * evidence is long-lived, so only a recognised class and its own fixed wording are stored. An
 * unrecognised failure is recorded as unclassified rather than pasted through verbatim.
 */
const FAILURE_CLASSES: { code: string; match: RegExp; detail: string }[] = [
  { code: 'INTERACTIVE_TERMINAL_REQUIRED', match: /requires an interactive terminal/i,
    detail: 'the official tool refused cloud creation without an interactive terminal' },
  { code: 'NO_RECEIPT_BEFORE_TIMEOUT', match: /did not report a session within/i,
    detail: 'the official terminal reported no session before the office stopped waiting' },
  { code: 'EXITED_WITHOUT_RECEIPT', match: /exited with code/i,
    detail: 'the official terminal exited without printing a creation receipt' },
  { code: 'OUTPUT_LIMIT_EXCEEDED', match: /more output than the office will read/i,
    detail: 'the official terminal produced more output than the office will read' },
  { code: 'NO_SESSION_IDENTIFIER', match: /no session identifier/i,
    detail: 'the official tool returned no session identifier' },
  { code: 'TRANSPORT_MODULE_MISSING', match: /terminal transport module/i,
    detail: 'the terminal transport module is not available in this build' },
];

/** Classifies a probe failure without persisting the raw text it came from. */
export function classifyProbeFailure(message: string): { code: string; detail: string } {
  const found = FAILURE_CLASSES.find(item => item.match.test(message));
  return found ? { code: found.code, detail: found.detail }
    : { code: 'UNCLASSIFIED', detail: 'the route failed for a reason the office does not recognise; the raw tool output was not stored' };
}

/**
 * The model scope a submission may honestly claim.
 *
 * Scope is taken from the command the adapter would really run, never from the model the caller
 * asked about. This route selects no model today, so evidence carries no model scope and says so.
 */
function submittedModel(adapter: ProviderAdapter, context: SubmitContext): string {
  const planner = adapter as ProviderAdapter & { plan?: (context: SubmitContext) => { args: string[] } };
  if (!planner.plan) return '';
  try {
    const args = planner.plan(context).args;
    const index = args.findIndex(argument => argument === '--model');
    return index >= 0 ? (args[index + 1] ?? '') : '';
  } catch {
    // A plan that cannot be built proves nothing about model scope.
    return '';
  }
}

/**
 * The only way `CLOUD_SUBMIT` can ever become `ACCOUNT_VERIFIED`: actually create one tiny session
 * and record what happened.
 *
 * This is always user-initiated, spends the user's own subscription, and sends no research data —
 * only a real generated-only snapshot, prepared through the ordinary R2 route so its commit and
 * manifest hash are genuine rather than fabricated. The intent is written durably before the
 * provider is contacted, so a crash or a timeout afterwards is Unknown rather than proof that
 * nothing was submitted, and an unresolved attempt refuses another.
 *
 * Success records observed submission evidence scoped to whatever the command actually selected;
 * failure records a classified code. Neither outcome touches any other operation: observation,
 * output retrieval, cancellation, applied settings, environment identity, delegation control and
 * tool confinement all stay unverified.
 *
 * The action reaching this function is still contained (shared/transport.ts) until R5 supplies live
 * evidence that the route works. R1-B repaired the implementation; it did not re-enable the action.
 */
export async function probeCloudTransport(input: {
  store: OfficeStore; adapter: ProviderAdapter; stagingRoot: string; model: string;
  observation: AccountObservation; now?: () => string; objectRoot?: string; gitExecutable?: string;
}): Promise<ProbeResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const state = input.store.snapshot({history:false});
  const connection: AccountConnection | undefined = currentConnection(state, input.observation.provider);
  if (input.observation.state !== 'SIGNED_IN') throw new Error('Sign in to the provider before verifying the transport.');
  if (!connection) throw new Error('Check the account before verifying the transport.');
  const capability = latestCapability(state, connection.id);
  if (!capability) throw new Error('Check the account before verifying the transport.');

  // A real one-commit fixture through the ordinary preparation route. Nothing about the commit or
  // the manifest hash is invented, so the snapshot satisfies the same contract user work does.
  const project = input.store.execute({
    type: 'project.create', idempotencyKey: randomUUID(),
    name: `Transport probe ${now()}`, mandate: 'Generated fixture for one transport verification. No research data.', budgetCents: 0,
  }).projects.at(-1)!;
  const snapshot = await prepareInputSnapshot({
    store: input.store, stagingRoot: input.stagingRoot, projectId: project.id,
    objective: PROBE_OBJECTIVE, gitExecutable: input.gitExecutable, now,
    ...(input.objectRoot ? { objectRoot: input.objectRoot } : {}),
  });
  if (!snapshot.stagingCommit)
    throw new Error(`The probe fixture could not be committed: ${snapshot.warnings[0] ?? 'git is unavailable'}. Nothing was submitted.`);

  const id = randomUUID();
  const context: SubmitContext = {
    assignment: {
      id, projectId: project.id, requestId: id, requestRevision: 0, agentId: id, agentRevision: 0, connectionId: connection.id,
      capabilitySnapshotId: capability.id, snapshotId: snapshot.id, route: input.adapter.route, requestedModel: input.model, resolvedModel: '',
      requestedEffort: 'default', appliedEffort: 'UNVERIFIED', delegation: false,
      objectiveHash: canonicalHash({ objective: PROBE_OBJECTIVE, criteria: PROBE_CRITERIA }), createdAt: now(),
    },
    snapshot,
    objective: PROBE_OBJECTIVE,
    requestName: 'Office transport probe',
    payload: buildProviderPayload({
      requestName: 'Office transport probe', objective: PROBE_OBJECTIVE, acceptanceCriteria: PROBE_CRITERIA,
      instructions: '', model: input.model, effort: 'default', delegation: false,
    }),
  };

  const scopedModel = submittedModel(input.adapter, context);
  const scope = scopedModel ? { model: scopedModel } : {};
  const unscoped = scopedModel ? '' : ' The route selected no model, so this does not verify which model a job would use.';

  // Durable intent, written and committed before any provider contact. Everything after this point
  // is reconcilable: the attempt exists whether or not the office survives the call.
  const attempt = {
    id, provider: input.observation.provider, connectionId: connection.id, identity: connection.identity,
    credentialContext: connection.credentialContext, toolVersion: capability.toolVersion, environment: capability.environment,
    route: input.adapter.route, model: scopedModel, state: 'INTENT' as const,
    externalId: '', externalUrl: '', detail: 'Preparing to create one verification session.', failureCode: '',
    stagingPath: snapshot.stagingPath, snapshotId: snapshot.id, startedAt: now(), settledAt: '',
  };
  input.store.recordProbeIntent(attempt);

  let evidence: CapabilityEvidence;
  let result: ProbeResult;
  let settled: ProbeAttempt;
  try {
    const submitted = await input.adapter.submit(context);
    if (!submitted.externalId) throw new Error('The official tool returned no session identifier.');
    // The receipt is persisted immediately, before any further work can fail.
    settled = { ...attempt, state: 'ACCEPTED' as const, externalId: submitted.externalId, externalUrl: submitted.externalUrl,
      detail: submitted.detail, settledAt: now() };
    input.store.recordProbeOutcome(settled);
    evidence = {
      operation: 'CLOUD_SUBMIT', level: 'ACCOUNT_VERIFIED', evidence: 'OBSERVED', verifiedAt: now(), ...scope,
      route: input.adapter.route, environment: capability.environment,
      detail: `A real cloud session was created for this account: ${submitted.externalId}.${unscoped}`,
      source: `office transport probe via ${input.adapter.route}`,
    };
    result = { verified: true, detail: submitted.detail, externalId: submitted.externalId, externalUrl: submitted.externalUrl };
  } catch (error) {
    const failure = classifyProbeFailure(error instanceof Error ? error.message : '');
    // The call started, so the provider's view is unknown. This is never recorded as "not submitted",
    // and the fixture is kept so the attempt can be reconciled later.
    settled = { ...attempt, state: 'UNKNOWN' as const, detail: failure.detail, failureCode: failure.code, settledAt: now() };
    input.store.recordProbeOutcome(settled);
    evidence = {
      operation: 'CLOUD_SUBMIT', level: 'UNAVAILABLE', evidence: 'OBSERVED', verifiedAt: now(), ...scope,
      route: input.adapter.route, environment: capability.environment,
      detail: `The route did not produce a session for this account (${failure.code}): ${failure.detail}.`,
      source: `office transport probe via ${input.adapter.route}`,
    };
    result = { verified: false, detail: `The route did not produce a session (${failure.code}): ${failure.detail}.`, externalId: '', externalUrl: '' };
  }
  // Staging is retained deliberately while an attempt is unresolved: deleting it would destroy the
  // only local record of exactly what was sent.
  if (settled.state === 'ACCEPTED') removeTreeSync(snapshot.stagingPath);
  // Recorded as one observation, so the probe's finding lives with the tool version it was taken under.
  input.store.recordAccountObservation({
    ...input.observation,
    transport: input.adapter.route === 'OFFICIAL_CLI_PTY' ? 'OFFICIAL_CLI_TERMINAL' : 'NONE',
    observedAt: now(),
    operations: [...input.observation.operations.filter(item => item.operation !== 'CLOUD_SUBMIT'), evidence],
  });
  return result;
}
