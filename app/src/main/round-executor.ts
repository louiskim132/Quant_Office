import { createHash } from 'node:crypto';
import type { Agent, Assignment, Request, Role, PipelineShape } from '../shared/types.js';
import type { ToolProfile } from '../shared/tool-profile.js';
import {
  buildAnalysisRound,
  buildCommRound,
  DIRECTOR_TOOL_PROFILE,
  type CommRoundEntry,
  type CommRoundPhase,
  type CommRoundSpec,
  buildQuickCommRound,
  buildQuickAnalysisRound,
  buildRestartRound,
} from './round-template.js';

/**
 * The comm-round mint (inter-agent pipeline): the pure resolution layer between a pipeline
 * Request and the spec the office mints from it. planCommRoundMint resolves roster roles to
 * live agents, expands the declaration through the round template, and returns the spec, its
 * content hash and one MintEntry per spec entry. planRefineHop mints the bounded director hop
 * a user note rides. mintEntriesFor re-keys the spec's key-level DAG onto already-minted
 * assignment ids via Assignment.pipelineKey.
 *
 * Nothing here touches the store, the filesystem, the clock or randomness — callers supply
 * every input and identical inputs produce identical output. The module is deliberately
 * tolerant of a round-template that predates worker-1's extension: `armRole` is read off the
 * spec entry when present and derived from the key's declared seat when absent, and a missing
 * buildAnalysisRound is an honest ok:false, never a fabricated spec.
 */

/** A minted hop: the spec entry's identity plus the resolved seat and its bounded instruction. */
export interface MintEntry {
  key: string;
  phase: CommRoundPhase | 'BRIEF_REFINE';
  /** The roster role that fills this seat — from the spec entry's armRole when it carries one. */
  armRole: Role;
  agentId: string;
  toolProfile: ToolProfile;
  /** Spec-declared staging scope — BLIND hops receive withheld paths as hash-only entries. */
  inputScope?: 'BLIND' | 'FULL';
  /** Key-level DAG edges — the caller maps keys to assignment ids via Assignment.pipelineKey. */
  dependsOnKeys: string[];
  /** The bounded per-phase instruction this hop carries. */
  objectiveText: string;
  /** Present when an existing assignment already carries this key — idempotent re-mints only. */
  assignmentId?: string;
}

export type CommRoundMint =
  | { ok: true; spec: CommRoundSpec; specHash: string; entries: MintEntry[] }
  | { ok: false; missingRoles: Role[]; detail: string };

/** The packet contract every minted hop rides — the office-local-session@2 contract. */
const PACKET_VERSION = 2;
/** The cap on a refine note's payload and on any single hop instruction. */
export const REFINE_NOTE_MAX = 4000;
/** The cap on the request-objective excerpt inside a hop instruction. */
const OBJECTIVE_EXCERPT_MAX = 1000;

const live = (agent: Agent): boolean => !agent.removedAt && !agent.deletedAt;
const firstLive = (agents: readonly Agent[], role: Role): Agent | undefined =>
  agents.find(agent => live(agent) && agent.role === role);

/**
 * The seat a spec entry fills. Post-extension entries carry armRole themselves; pre-extension
 * specs are resolved from the key the builder assigned — the same positional seat by
 * construction, so the two readings can never disagree.
 */
function armRoleFor(entry: CommRoundEntry): Role {
  const declared = (entry as CommRoundEntry & { armRole?: Role }).armRole;
  if (declared) return declared;
  switch (entry.key) {
    case 'plan-draft-a':
    case 'plan-critique-a-on-b':
      return 'PM_A';
    case 'plan-draft-b':
    case 'plan-critique-b-on-a':
      return 'PM_B';
    case 'analysis-interpret':
    case 'analysis-response-interpret':
      return 'PM_C';
    case 'analysis-falsify':
    case 'analysis-response-falsify':
      return 'PM_D';
    case 'analysis-digest':
    case 'analysis-report':
      return 'WORKER';
    default:
      return entry.key.startsWith('implement-') ? 'WORKER' : 'DIRECTOR';
  }
}

/** The request objective excerpt inside a hop instruction — bounded, marked when truncated. */
function objectiveExcerpt(objective: string): string {
  const text = objective.trim();
  return text.length <= OBJECTIVE_EXCERPT_MAX
    ? text
    : `${text.slice(0, OBJECTIVE_EXCERPT_MAX)}…(truncated — the full objective rides the packet)`;
}

/** Where a predecessor hop's verified outputs are staged in a dependent packet (see local-packet.ts). */
const inheritedDir = (key: string): string => `inputs/inherited/${key}/`;

/** What the round looks like around one entry — the facts a hop instruction must name. */
interface RoundShape {
  /** The number of implement hops the round minted (one per live worker). */
  workerCount: number;
  /** The hop the implement hops execute against: 'plan-synthesis', 'analysis-finalize' with the phase-2 mirror, 'plan-draft-a' in a quick round, 'plan-brief' in a restart. */
  planKey: string;
  /** A revision that keeps the settled plan and restarts at implementation. */
  restart: boolean;
}

/**
 * The bounded per-phase instruction a minted entry carries — keyed by the seat's position.
 *
 * Every instruction names the exact file(s) the hop writes and what it must not do. Without that
 * line each seat read "Request objective: … Deliverables: a script and a README" as its own
 * work order, so the brief, both drafts, both critiques, the synthesis, every worker and the
 * verifier all re-implemented the deliverable (observed 2026-09-25: nine hops writing the same
 * ema5.py). Inputs are named by the directory the packet stages them under.
 */
function objectiveText(entry: CommRoundEntry, objective: string, shape: RoundShape): string {
  const excerpt = objectiveExcerpt(objective);
  const opposite = entry.dependsOnKeys[0];
  const slices = shape.workerCount > 1;
  const noDeliverable = "Do not write code or the request's deliverables — later hops do that.";
  const sliced = (file: string) =>
    slices
      ? `${file} split into exactly ${shape.workerCount} sections headed "## Slice 1" … "## Slice ${shape.workerCount}" that touch disjoint files (write "EMPTY" under a slice when the work does not split that far)`
      : file;
  const text = (() => {
    switch (entry.key) {
      case 'plan-brief':
        if (shape.restart)
          return `This revision keeps the approved plan and restarts at implementation. From the prior round's settled plan (inputs/inherited/prior-*/plan.md), its verification and the revision note, write outputs/plan.md — the prior plan amended only where the note or the verification requires — outputs/analysis-plan.md carried forward (changed only if the note changes it), and outputs/brief.md stating what changed and why. ${noDeliverable} Request objective: ${excerpt}`;
        return `Brief the round: set the work order the declared arms execute against. Write outputs/brief.md — goal, constraints, the exact definitions the result must use, acceptance criteria, and any question the user should answer before planning. ${noDeliverable} Request objective: ${excerpt}`;
      case 'analysis-brief':
        return `Brief the round: set the work order the declared arms execute against. Write outputs/brief.md — the questions to answer, the metrics and thresholds that decide them, and the evidence each arm should check. When an inherited analysis-plan.md is present (pre-registered when the plan was synthesized), adopt it as the work order: restate it briefly and name only deliberate deviations. Do not compute results yourself. Request objective: ${excerpt}`;
      case 'plan-draft-a':
      case 'plan-draft-b':
        if (shape.planKey === entry.key)
          return `Write the plan the worker executes, from the director's brief (${inheritedDir('plan-brief')}brief.md). This is a quick round: there is no second planner, critique or synthesis, so this plan is final. Write ${sliced('outputs/plan.md — approach, files to create, exact definitions, edge cases and how the result will be checked —')}, and outputs/analysis-plan.md — the pre-registered result analysis: metrics, thresholds, decision rules and what would falsify the result, fixed now before any result exists. ${noDeliverable} Request objective: ${excerpt}`;
        return `Draft the plan for this request from the director's brief (${inheritedDir('plan-brief')}brief.md). Write outputs/plan.md — approach, files to create, exact definitions, edge cases, and how the result will be checked. ${noDeliverable} Request objective: ${excerpt}`;
      case 'plan-critique-a-on-b':
      case 'plan-critique-b-on-a':
        return `Critique only the named opposite artifact ${opposite} (${inheritedDir(opposite)}plan.md). Write outputs/critique.md — concrete defects, missing cases and the fix for each. Do not write your own plan or code. Request objective: ${excerpt}`;
      case 'plan-synthesis':
        return `Arbitrate the two drafts and their critiques (${inheritedDir('plan-draft-a')}, ${inheritedDir('plan-draft-b')} and the two critique directories) into a single plan. Write ${sliced('outputs/plan.md — the single plan the workers execute —')}, and outputs/analysis-plan.md — the pre-registered result analysis: metrics, thresholds, decision rules and what would falsify the result, fixed now before any result exists. ${noDeliverable} Request objective: ${excerpt}`;
      case 'analysis-digest':
        return `Summarize the declared inputs into an evidence brief and name the gaps, following the director's brief (${inheritedDir('analysis-brief')}brief.md). Write outputs/digest.md. Request objective: ${excerpt}`;
      case 'analysis-interpret':
        return `Interpret the digest against the request. Write outputs/interpretation.md. Request objective: ${excerpt}`;
      case 'analysis-falsify':
        return `Falsify the digest's claims wherever the declared inputs do not support them. Write outputs/falsification.md. Request objective: ${excerpt}`;
      case 'analysis-response-interpret':
      case 'analysis-response-falsify':
        return `Respond to the named opposite analysis artifact ${opposite} only (${inheritedDir(opposite)}). Write outputs/response.md. Request objective: ${excerpt}`;
      case 'analysis-finalize':
        return shape.planKey === 'analysis-finalize'
          ? `Arbitrate the analysis arms into the final plan the workers execute. Write ${sliced('outputs/plan.md')}, and carry forward outputs/analysis-plan.md from ${inheritedDir('plan-synthesis')} with only the changes the arms justified. ${noDeliverable} Request objective: ${excerpt}`
          : `Arbitrate the analysis arms into the final assessment. Write outputs/assessment.md. Request objective: ${excerpt}`;
      case 'analysis-report':
        return `Write the bounded report from the finalized analysis (${inheritedDir('analysis-finalize')}). Write outputs/report.md. Request objective: ${excerpt}`;
      case 'verify':
        return `Verify the declared outputs against the contract and the plan. The workers' outputs are under ${inheritedDir('implement-1')}${shape.workerCount > 1 ? ` … ${inheritedDir(`implement-${shape.workerCount}`)}` : ''}. Run them where they are runnable and write outputs/verification.md — pass or fail per acceptance criterion, with the evidence. Do not rewrite the deliverables; report defects instead. Request objective: ${excerpt}`;
      case 'user-gate':
        return `Human gate: present the verified outcome and await the user's decision — no further hops proceed without it. Request objective: ${excerpt}`;
      default: {
        const slice = /^implement-(\d+)$/.exec(entry.key);
        if (!slice) return `${entry.phase} hop ${entry.key}. Request objective: ${excerpt}`;
        const plan = `${inheritedDir(shape.planKey)}plan.md`;
        if (shape.restart)
          return `Apply the amended plan ${plan}. The previous round's deliverables are under inputs/inherited/prior-implement-*/ — start from them, change only what the amended plan requires, and write the complete deliverables under outputs/. Request objective: ${excerpt}`;
        return slices
          ? `Implement Slice ${slice[1]} of ${plan} exactly, within your declared scope, writing its deliverables under outputs/. If Slice ${slice[1]} is EMPTY, write outputs/slice-${slice[1]}.md saying so and finish without further work. Do not implement other slices. Request objective: ${excerpt}`
          : `Implement ${plan} exactly, within your declared scope, writing the deliverables under outputs/. Request objective: ${excerpt}`;
      }
    }
  })();
  return text.length <= REFINE_NOTE_MAX ? text : text.slice(0, REFINE_NOTE_MAX);
}

/** Resolution inputs — everything the mint needs, supplied by the caller. */
export interface CommRoundMintInput {
  request: Request;
  agents: readonly Agent[];
  existingAssignments: readonly Assignment[];
  /**
   * The round shape to mint. Absent: the shape the request recorded at confirm, else FULL. The
   * confirm gate passes the shape the user is about to confirm, before the store records it.
   */
  shape?: PipelineShape;
}

/**
 * Resolve the roster and expand the declaration into a spec + mint entries. Every required
 * role with no live agent is named in missingRoles — the mint never partially fills a seat and
 * never substitutes an archived agent.
 */
export function planCommRoundMint(input: CommRoundMintInput): CommRoundMint {
  const { request, agents, existingAssignments } = input;
  const roundShape: PipelineShape = input.shape ?? request.pipeline?.shape ?? 'FULL';
  const quick = roundShape === 'QUICK';
  const kind =
    request.pipeline?.kind ??
    (request.workType === 'PLANNING' || request.workType === 'RESULT_ANALYSIS' ? request.workType : null);
  if (!kind)
    return {
      ok: false,
      missingRoles: [],
      detail: `Request ${request.id} carries no pipeline kind — workType ${request.workType} is not a comm-round.`,
    };
  const restart = request.revisionOf?.restartAt === 'IMPLEMENTATION' && kind === 'PLANNING';

  const director = request.leadAgentId ? agents.find(agent => agent.id === request.leadAgentId) : undefined;
  const workers = agents.filter(agent => live(agent) && agent.role === 'WORKER');
  const missingRoles: Role[] = [];
  if (!director || !live(director)) missingRoles.push('DIRECTOR');
  let plannerPair: [string, string] | undefined;
  let analystPair: [string, string] | undefined;
  if (kind === 'PLANNING' && restart) {
    // A restart keeps the settled plan: no planner seat is needed.
  } else if (kind === 'PLANNING') {
    const plannerA = firstLive(agents, 'PM_A');
    const plannerB = firstLive(agents, 'PM_B');
    if (!plannerA) missingRoles.push('PM_A');
    // A quick round has a single planner seat — PM_B is not required.
    if (!plannerB && !quick) missingRoles.push('PM_B');
    if (plannerA && plannerB) plannerPair = [plannerA.id, plannerB.id];
    else if (plannerA && quick) plannerPair = [plannerA.id, plannerA.id];
  } else {
    const analystC = firstLive(agents, 'PM_C');
    const analystD = firstLive(agents, 'PM_D');
    if (!analystC) missingRoles.push('PM_C');
    if (!analystD) missingRoles.push('PM_D');
    if (analystC && analystD) analystPair = [analystC.id, analystD.id];
  }
  if (workers.length === 0) missingRoles.push('WORKER');
  if (missingRoles.length)
    return {
      ok: false,
      missingRoles,
      detail: `Cannot mint the ${kind} round — no live agent fills ${missingRoles.join(', ')}.`,
    };

  const brief = request.objective;
  let spec: CommRoundSpec;
  if (kind === 'PLANNING' && restart) {
    spec = buildRestartRound({
      projectId: request.projectId,
      brief,
      directorAgentId: director!.id,
      workerAgentId: workers[0]!.id,
      packetVersion: PACKET_VERSION,
    });
  } else if (kind === 'PLANNING' && quick) {
    // The quick round is one planner and one worker — the first live worker fills the seat.
    spec = buildQuickCommRound({
      projectId: request.projectId,
      brief,
      directorAgentId: director!.id,
      planner: plannerPair![0],
      workerAgentId: workers[0]!.id,
      packetVersion: PACKET_VERSION,
    });
  } else if (kind === 'PLANNING') {
    spec = buildCommRound({
      projectId: request.projectId,
      brief,
      directorAgentId: director!.id,
      planners: plannerPair!,
      workerAgentIds: workers.map(agent => agent.id),
      packetVersion: PACKET_VERSION,
    });
  } else {
    // The analysis spec's digest and report hops are a single seat — the first live worker
    // fills it deterministically; the rest of the roster is unused in this round shape.
    spec = (quick ? buildQuickAnalysisRound : buildAnalysisRound)({
      projectId: request.projectId,
      brief,
      directorAgentId: director!.id,
      analysts: analystPair!,
      workerAgentId: workers[0]!.id,
      packetVersion: PACKET_VERSION,
    });
  }
  const implementHops = spec.entries.filter(item => item.key.startsWith('implement-'));
  const shape: RoundShape = {
    workerCount: implementHops.length,
    planKey: implementHops[0]?.dependsOnKeys[0] ?? 'plan-synthesis',
    restart,
  };
  const specHash = createHash('sha256').update(JSON.stringify(spec), 'utf8').digest('hex');
  // Request-scoped: two requests mint the same deterministic spec keys, so a pipelineKey lookup
  // must only ever see this request's own assignments — a foreign key is not this round's mint.
  const minted = new Map(
    existingAssignments
      .filter(a => a.requestId === request.id && a.pipelineKey)
      .map(a => [a.pipelineKey!, a.id] as const),
  );
  const entries: MintEntry[] = spec.entries.map(specEntry => ({
    key: specEntry.key,
    phase: specEntry.phase,
    armRole: armRoleFor(specEntry),
    agentId: specEntry.agentId,
    toolProfile: specEntry.toolProfile,
    dependsOnKeys: [...specEntry.dependsOnKeys],
    ...(specEntry.inputScope ? { inputScope: specEntry.inputScope } : {}),
    objectiveText: objectiveText(specEntry, request.objective, shape),
    ...(minted.has(specEntry.key) ? { assignmentId: minted.get(specEntry.key)! } : {}),
  }));
  return { ok: true, spec, specHash, entries };
}

/**
 * The bounded director hop a user note rides while the pipeline is still briefing. The note
 * text is the payload verbatim — over the bound the hop is refused rather than silently
 * truncated, because a clipped instruction is a different instruction.
 */
export function planRefineHop(request: Request, noteText: string, priorBriefKey: string): MintEntry {
  if (!request.leadAgentId) throw new Error('A refine hop needs the director seat — the request has no leadAgentId.');
  const note = noteText.trim();
  if (!note) throw new Error('A refine hop needs note text — an empty payload carries no instruction.');
  if (note.length > REFINE_NOTE_MAX)
    throw new Error(`A refine note is bounded to ${REFINE_NOTE_MAX} characters; this note is ${note.length}.`);
  if (!priorBriefKey.trim()) throw new Error('A refine hop must name the prior brief key it depends on.');
  const prior = /^brief-refine-(\d+)$/.exec(priorBriefKey);
  const next = prior ? Number(prior[1]) + 1 : 1;
  return {
    key: `brief-refine-${next}`,
    phase: 'BRIEF_REFINE',
    armRole: 'DIRECTOR',
    agentId: request.leadAgentId,
    toolProfile: DIRECTOR_TOOL_PROFILE,
    dependsOnKeys: [priorBriefKey],
    objectiveText: note,
  };
}

export type ResolvedMintEntries =
  { ok: true; entries: { key: string; assignmentId: string; dependsOn: string[] }[] } | { ok: false; detail: string };

/**
 * Re-keys the spec's DAG onto minted assignment ids. The assignment list is scoped to the
 * request before any lookup runs — spec keys are deterministic, so another request's hops
 * carry the same keys and an unscoped map would happily bind them. Every spec key must resolve
 * to exactly one assignment via pipelineKey, and every pipelined assignment must name a spec
 * key — an unknown or unminted key is refused by name rather than resolved to nothing.
 */
export function mintEntriesFor(
  spec: CommRoundSpec,
  request: Request,
  assignments: readonly Assignment[],
): ResolvedMintEntries {
  const byKey = new Map<string, string>();
  for (const assignment of assignments) {
    if (assignment.requestId !== request.id || !assignment.pipelineKey) continue;
    const prior = byKey.get(assignment.pipelineKey);
    if (prior && prior !== assignment.id)
      return {
        ok: false,
        detail: `Two assignments (${prior}, ${assignment.id}) claim pipeline key '${assignment.pipelineKey}' — the mint cannot resolve it.`,
      };
    byKey.set(assignment.pipelineKey, assignment.id);
  }
  const specKeys = new Set(spec.entries.map(entry => entry.key));
  for (const key of byKey.keys())
    if (!specKeys.has(key))
      return {
        ok: false,
        detail: `Assignment pipeline key '${key}' names no entry in this spec — unknown keys are refused.`,
      };
  const missing = spec.entries.filter(entry => !byKey.has(entry.key)).map(entry => entry.key);
  if (missing.length)
    return {
      ok: false,
      detail: `No minted assignment carries spec ${missing.length === 1 ? 'key' : 'keys'}: ${missing.join(', ')}.`,
    };
  return {
    ok: true,
    entries: spec.entries.map(entry => ({
      key: entry.key,
      assignmentId: byKey.get(entry.key)!,
      dependsOn: entry.dependsOnKeys.map(key => byKey.get(key)!),
    })),
  };
}
