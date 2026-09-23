import type { Agent, AppState, Assignment, InputSnapshot, Request } from '../shared/types.js';
import type { OfficeStore } from '../core/store.js';
import { planCommRoundMint, planRefineHop, type MintEntry } from './round-executor.js';

/**
 * The pipeline mint (inter-agent pipeline): the office-side orchestration that turns a pipeline
 * request's durable state into minted hops. Every hop is a real assignment + INTENT job minted
 * through the same `prepare` path a manual dispatch uses — frozen snapshot, capability evidence,
 * dependsOn edges — with `pipelineKey` carrying the spec key and the hop's bounded instruction
 * riding as the frozen objective. The chain machinery (`advanceLocalChain`/`reconcileLocalChain`)
 * launches dependents as their recorded predecessors settle; the office never claims completion
 * from anything but a verified receipt on the hop's own job.
 *
 * The flow: `request.start` mints only the director's brief hop (the user↔director exchange
 * begins there); each `request.pipeline.note` mints a `brief-refine-N` hop chained off the prior
 * brief; `request.pipeline.confirm` mints every remaining spec entry in topological order. A hop
 * that cannot resolve its seat or its edges is a thrown error, never a silent skip.
 *
 * Everything side-effecting is injected: the store, the snapshot path and the assignment mint.
 * Tests drive it with fakes; production wires it to the real controller and snapshot factory.
 */
export interface PipelineMintContext {
  store: OfficeStore;
  /** Freezes one hop's inputs — the office's prepareInputSnapshot path, supplied by the caller. */
  snapshotFor: (request: Request, hop: MintEntry) => Promise<InputSnapshot>;
  /** The office's assignment mint — controller.prepare, supplied by the caller. */
  prepare: (input: {
    requestId: string; agentId: string; snapshotId: string;
    dependsOn?: string[]; toolProfile?: MintEntry['toolProfile'];
    pipelineKey?: string; objective?: string;
  }) => { state: AppState; assignment: Assignment };
}

const liveAgents = (state: AppState): Agent[] => (state.agents ?? []).filter(item => !item.removedAt);
const briefKey = (request: Request): string => request.pipeline?.kind === 'RESULT_ANALYSIS' ? 'analysis-brief' : 'plan-brief';

function freshRequest(store: OfficeStore, requestId: string): Request {
  const request = store.snapshot({ history: false }).requests?.find(item => item.id === requestId);
  if (!request) throw new Error('Request not found');
  return request;
}

/**
 * The confirm gate: the whole spec must resolve before the phase flips to LAUNCHED. Called
 * BEFORE `request.pipeline.confirm` executes — a refusal here means the command never lands and
 * the request stays honestly in BRIEFING.
 */
export function pipelineConfirmGate(store: OfficeStore, requestId: string): { ok: true } | { ok: false; detail: string } {
  const state = store.snapshot({ history: false });
  const request = state.requests?.find(item => item.id === requestId);
  if (!request?.pipeline) return { ok: false, detail: 'Only a pipeline request carries a round to mint.' };
  const mint = planCommRoundMint({ request, agents: liveAgents(state), existingAssignments: state.assignments ?? [] });
  return mint.ok ? { ok: true } : { ok: false, detail: mint.detail };
}

/**
 * Mints the director's brief hop after `request.start` lands a pipeline request READY, then
 * binds it as the briefing gate. Idempotent: a re-run with the hop already minted re-binds the
 * recorded assignment rather than minting a second seat.
 */
export async function mintPipelineBrief(ctx: PipelineMintContext, request: Request): Promise<{ minted: true; assignment: Assignment } | { minted: false; detail: string }> {
  const state = ctx.store.snapshot({ history: false });
  const mint = planCommRoundMint({ request, agents: liveAgents(state), existingAssignments: state.assignments ?? [] });
  if (!mint.ok) return { minted: false, detail: mint.detail };
  const entry = mint.entries.find(item => item.key === briefKey(request));
  if (!entry) return { minted: false, detail: `The ${request.pipeline?.kind} spec carries no brief entry.` };
  if (entry.assignmentId) {
    const existing = (state.assignments ?? []).find(item => item.id === entry.assignmentId && item.requestId === request.id)!;
    const fresh = freshRequest(ctx.store, request.id);
    ctx.store.bindPipelineBrief({ requestId: request.id, expectedRevision: fresh.revision, briefAssignmentId: existing.id, specHash: mint.specHash });
    return { minted: true, assignment: existing };
  }
  const snapshot = await ctx.snapshotFor(request, entry);
  const { assignment } = ctx.prepare({
    requestId: request.id, agentId: entry.agentId, snapshotId: snapshot.id,
    toolProfile: entry.toolProfile, pipelineKey: entry.key, objective: entry.objectiveText,
  });
  const fresh = freshRequest(ctx.store, request.id);
  ctx.store.bindPipelineBrief({ requestId: request.id, expectedRevision: fresh.revision, briefAssignmentId: assignment.id, specHash: mint.specHash });
  return { minted: true, assignment };
}

/**
 * Mints one bounded director refine hop for a recorded user note, chained off the prior brief
 * hop. The note text is the hop's payload verbatim — the bound was already enforced by the
 * command that recorded it.
 */
export async function mintPipelineRefine(ctx: PipelineMintContext, request: Request, noteText: string): Promise<{ minted: true; assignment: Assignment } | { minted: false; detail: string }> {
  const state = ctx.store.snapshot({ history: false });
  const prior = request.pipeline?.briefAssignmentId
    ? (state.assignments ?? []).find(item => item.id === request.pipeline!.briefAssignmentId && item.requestId === request.id)
    : undefined;
  if (!prior?.pipelineKey) return { minted: false, detail: 'No minted brief hop exists to refine — start the request first.' };
  const entry = planRefineHop(request, noteText, prior.pipelineKey);
  const snapshot = await ctx.snapshotFor(request, entry);
  const { assignment } = ctx.prepare({
    requestId: request.id, agentId: entry.agentId, snapshotId: snapshot.id,
    dependsOn: [prior.id], toolProfile: entry.toolProfile, pipelineKey: entry.key, objective: entry.objectiveText,
  });
  const fresh = freshRequest(ctx.store, request.id);
  ctx.store.bindPipelineBrief({ requestId: request.id, expectedRevision: fresh.revision, briefAssignmentId: assignment.id });
  return { minted: true, assignment };
}

/**
 * Mints every not-yet-minted spec entry after `request.pipeline.confirm` lands. Entries are
 * emitted in topological order, so each hop's dependsOn resolves to assignments minted earlier
 * in this same pass or already on record. The brief hop itself is skipped — it was minted and
 * bound during briefing.
 */
export async function mintPipelineRound(ctx: PipelineMintContext, request: Request): Promise<{ minted: number }> {
  const state = ctx.store.snapshot({ history: false });
  const mint = planCommRoundMint({ request, agents: liveAgents(state), existingAssignments: state.assignments ?? [] });
  if (!mint.ok) throw new Error(mint.detail);
  // Request-scoped: spec keys are deterministic, so every simultaneous pipeline mints the same
  // keys — an unscoped map would resolve this round's edges onto another request's hops.
  const keyToAssignment = new Map<string, string>();
  for (const item of state.assignments ?? []) if (item.requestId === request.id && item.pipelineKey) keyToAssignment.set(item.pipelineKey, item.id);
  let minted = 0;
  for (const entry of mint.entries) {
    if (entry.assignmentId || keyToAssignment.has(entry.key)) continue;
    const missing = entry.dependsOnKeys.filter(key => !keyToAssignment.has(key));
    if (missing.length) throw new Error(`Cannot mint hop '${entry.key}' — ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not minted yet.`);
    const snapshot = await ctx.snapshotFor(request, entry);
    const { assignment } = ctx.prepare({
      requestId: request.id, agentId: entry.agentId, snapshotId: snapshot.id,
      dependsOn: entry.dependsOnKeys.map(key => keyToAssignment.get(key)!),
      toolProfile: entry.toolProfile, pipelineKey: entry.key, objective: entry.objectiveText,
    });
    keyToAssignment.set(entry.key, assignment.id);
    minted++;
  }
  return { minted };
}

/**
 * The office settle: once every minted hop of a LAUNCHED round has a verified COMPLETED job,
 * the pipeline's decision wait opens, bound to the terminal hop's own verified receipt hash.
 * The seal barrier is a report, never a throw — one still-open or failed hop means the round
 * has not settled, and nothing mutates. The terminal hop is 'verify' for PLANNING and
 * 'analysis-report' for RESULT_ANALYSIS; an in-flight spec that still minted 'user-gate' as a
 * hop settles on it instead. Every lookup is request-scoped — spec keys are deterministic, so
 * another request's hops carry identical keys.
 */
export function settlePipelineDecision(ctx: { store: OfficeStore }, request: Request): { settled: true } | { settled: false; reason: string } {
  const pipeline = request.pipeline;
  if (!pipeline) return { settled: false, reason: 'Only a pipeline request carries a round to settle.' };
  if (pipeline.phase !== 'LAUNCHED')
    return { settled: false, reason: `The pipeline is ${pipeline.phase}, not LAUNCHED — the decision wait opens only after the round launches.` };
  if (!pipeline.specHash) return { settled: false, reason: 'The pipeline has no recorded spec hash — there is no spec to settle against.' };
  const state = ctx.store.snapshot({ history: false });
  const hops = (state.assignments ?? []).filter(item => item.requestId === request.id && item.pipelineKey);
  if (!hops.length) return { settled: false, reason: 'No pipeline hops are minted for this request.' };
  const jobs = state.jobs ?? [];
  const open = hops.filter(hop => jobs.find(item => item.assignmentId === hop.id)?.state !== 'COMPLETED');
  if (open.length)
    return { settled: false, reason: `${open.length} minted ${open.length === 1 ? 'hop is' : 'hops are'} not COMPLETED (${open.map(hop => hop.pipelineKey).join(', ')}) — the seal barrier holds until every hop verifies.` };
  const headKey = hops.some(hop => hop.pipelineKey === 'user-gate') ? 'user-gate' : pipeline.kind === 'RESULT_ANALYSIS' ? 'analysis-report' : 'verify';
  const head = hops.find(hop => hop.pipelineKey === headKey);
  if (!head) return { settled: false, reason: `No terminal hop '${headKey}' is minted for this request — the round has no head to settle on.` };
  const headJob = jobs.find(item => item.assignmentId === head.id)!;
  const headReceiptHash = ctx.store.localSessionForJob(headJob.id)?.lastReceipt?.hash;
  if (!headReceiptHash)
    return { settled: false, reason: `The terminal hop '${headKey}' has no verified receipt on record — nothing binds the decision.` };
  try {
    ctx.store.markPipelineAwaitingDecision({ requestId: request.id, specHash: pipeline.specHash, headAssignmentId: head.id, headReceiptHash });
  } catch (error) {
    return { settled: false, reason: `markPipelineAwaitingDecision refused: ${error instanceof Error ? error.message : 'unknown error'}` };
  }
  return { settled: true };
}
