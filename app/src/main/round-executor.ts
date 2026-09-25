import { createHash } from 'node:crypto';
import type { Agent, Assignment, Request, Role } from '../shared/types.js';
import type { ToolProfile } from '../shared/tool-profile.js';
import {
  buildAnalysisRound, buildCommRound, DIRECTOR_TOOL_PROFILE,
  type CommRoundEntry, type CommRoundPhase, type CommRoundSpec,
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
const firstLive = (agents: readonly Agent[], role: Role): Agent | undefined => agents.find(agent => live(agent) && agent.role === role);

/**
 * The seat a spec entry fills. Post-extension entries carry armRole themselves; pre-extension
 * specs are resolved from the key the builder assigned — the same positional seat by
 * construction, so the two readings can never disagree.
 */
function armRoleFor(entry: CommRoundEntry): Role {
  const declared = (entry as CommRoundEntry & { armRole?: Role }).armRole;
  if (declared) return declared;
  switch (entry.key) {
    case 'plan-draft-a': case 'plan-critique-a-on-b': return 'PM_A';
    case 'plan-draft-b': case 'plan-critique-b-on-a': return 'PM_B';
    case 'analysis-interpret': case 'analysis-response-interpret': return 'PM_C';
    case 'analysis-falsify': case 'analysis-response-falsify': return 'PM_D';
    case 'analysis-digest': case 'analysis-report': return 'WORKER';
    default: return entry.key.startsWith('implement-') ? 'WORKER' : 'DIRECTOR';
  }
}

/** The request objective excerpt inside a hop instruction — bounded, marked when truncated. */
function objectiveExcerpt(objective: string): string {
  const text = objective.trim();
  return text.length <= OBJECTIVE_EXCERPT_MAX ? text : `${text.slice(0, OBJECTIVE_EXCERPT_MAX)}…(truncated — the full objective rides the packet)`;
}

/** The bounded per-phase instruction a minted entry carries — keyed by the seat's position. */
function objectiveText(entry: CommRoundEntry, objective: string): string {
  const excerpt = objectiveExcerpt(objective);
  const opposite = entry.dependsOnKeys[0];
  const text = (() => {
    switch (entry.key) {
      case 'plan-brief': case 'analysis-brief':
        return `Brief the round: set the work order the declared arms execute against. Request objective: ${excerpt}`;
      case 'plan-draft-a': case 'plan-draft-b':
        return `Draft the plan for this request from the director's brief. Request objective: ${excerpt}`;
      case 'plan-critique-a-on-b': case 'plan-critique-b-on-a':
        return `Critique only the named opposite artifact ${opposite}. Request objective: ${excerpt}`;
      case 'plan-synthesis':
        return `Arbitrate the two drafts and their critiques into a single plan. Request objective: ${excerpt}`;
      case 'analysis-digest':
        return `Summarize the declared inputs into an evidence brief and name the gaps. Request objective: ${excerpt}`;
      case 'analysis-interpret':
        return `Interpret the digest against the request. Request objective: ${excerpt}`;
      case 'analysis-falsify':
        return `Falsify the digest's claims wherever the declared inputs do not support them. Request objective: ${excerpt}`;
      case 'analysis-response-interpret': case 'analysis-response-falsify':
        return `Respond to the named opposite analysis artifact ${opposite} only. Request objective: ${excerpt}`;
      case 'analysis-finalize':
        return `Arbitrate the analysis arms into the final assessment. Request objective: ${excerpt}`;
      case 'analysis-report':
        return `Write the bounded report from the finalized analysis. Request objective: ${excerpt}`;
      case 'verify':
        return `Verify the declared outputs against the contract. Request objective: ${excerpt}`;
      case 'user-gate':
        return `Human gate: present the verified outcome and await the user's decision — no further hops proceed without it. Request objective: ${excerpt}`;
      default:
        return entry.key.startsWith('implement-')
          ? `Implement your assigned slice of the plan within your declared scope. Request objective: ${excerpt}`
          : `${entry.phase} hop ${entry.key}. Request objective: ${excerpt}`;
    }
  })();
  return text.length <= REFINE_NOTE_MAX ? text : text.slice(0, REFINE_NOTE_MAX);
}

/** Resolution inputs — everything the mint needs, supplied by the caller. */
export interface CommRoundMintInput {
  request: Request;
  agents: readonly Agent[];
  existingAssignments: readonly Assignment[];
}

/**
 * Resolve the roster and expand the declaration into a spec + mint entries. Every required
 * role with no live agent is named in missingRoles — the mint never partially fills a seat and
 * never substitutes an archived agent.
 */
export function planCommRoundMint(input: CommRoundMintInput): CommRoundMint {
  const { request, agents, existingAssignments } = input;
  const kind = request.pipeline?.kind
    ?? (request.workType === 'PLANNING' || request.workType === 'RESULT_ANALYSIS' ? request.workType : null);
  if (!kind)
    return { ok: false, missingRoles: [], detail: `Request ${request.id} carries no pipeline kind — workType ${request.workType} is not a comm-round.` };

  const director = request.leadAgentId ? agents.find(agent => agent.id === request.leadAgentId) : undefined;
  const workers = agents.filter(agent => live(agent) && agent.role === 'WORKER');
  const missingRoles: Role[] = [];
  if (!director || !live(director)) missingRoles.push('DIRECTOR');
  let plannerPair: [string, string] | undefined;
  let analystPair: [string, string] | undefined;
  if (kind === 'PLANNING') {
    const plannerA = firstLive(agents, 'PM_A');
    const plannerB = firstLive(agents, 'PM_B');
    if (!plannerA) missingRoles.push('PM_A');
    if (!plannerB) missingRoles.push('PM_B');
    if (plannerA && plannerB) plannerPair = [plannerA.id, plannerB.id];
  } else {
    const analystC = firstLive(agents, 'PM_C');
    const analystD = firstLive(agents, 'PM_D');
    if (!analystC) missingRoles.push('PM_C');
    if (!analystD) missingRoles.push('PM_D');
    if (analystC && analystD) analystPair = [analystC.id, analystD.id];
  }
  if (workers.length === 0) missingRoles.push('WORKER');
  if (missingRoles.length)
    return { ok: false, missingRoles, detail: `Cannot mint the ${kind} round — no live agent fills ${missingRoles.join(', ')}.` };

  const brief = request.objective;
  let spec: CommRoundSpec;
  if (kind === 'PLANNING') {
    spec = buildCommRound({
      projectId: request.projectId, brief, directorAgentId: director!.id,
      planners: plannerPair!, workerAgentIds: workers.map(agent => agent.id), packetVersion: PACKET_VERSION,
    });
  } else {
    // The analysis spec's digest and report hops are a single seat — the first live worker
    // fills it deterministically; the rest of the roster is unused in this round shape.
    spec = buildAnalysisRound({
      projectId: request.projectId, brief, directorAgentId: director!.id,
      analysts: analystPair!, workerAgentId: workers[0]!.id, packetVersion: PACKET_VERSION,
    });
  }
  const specHash = createHash('sha256').update(JSON.stringify(spec), 'utf8').digest('hex');
  // Request-scoped: two requests mint the same deterministic spec keys, so a pipelineKey lookup
  // must only ever see this request's own assignments — a foreign key is not this round's mint.
  const minted = new Map(existingAssignments.filter(a => a.requestId === request.id && a.pipelineKey).map(a => [a.pipelineKey!, a.id] as const));
  const entries: MintEntry[] = spec.entries.map(specEntry => ({
    key: specEntry.key, phase: specEntry.phase, armRole: armRoleFor(specEntry), agentId: specEntry.agentId,
    toolProfile: specEntry.toolProfile, dependsOnKeys: [...specEntry.dependsOnKeys],
    ...(specEntry.inputScope ? { inputScope: specEntry.inputScope } : {}),
    objectiveText: objectiveText(specEntry, request.objective),
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
  if (note.length > REFINE_NOTE_MAX) throw new Error(`A refine note is bounded to ${REFINE_NOTE_MAX} characters; this note is ${note.length}.`);
  if (!priorBriefKey.trim()) throw new Error('A refine hop must name the prior brief key it depends on.');
  const prior = /^brief-refine-(\d+)$/.exec(priorBriefKey);
  const next = prior ? Number(prior[1]) + 1 : 1;
  return {
    key: `brief-refine-${next}`, phase: 'BRIEF_REFINE', armRole: 'DIRECTOR', agentId: request.leadAgentId,
    toolProfile: DIRECTOR_TOOL_PROFILE, dependsOnKeys: [priorBriefKey], objectiveText: note,
  };
}

export type ResolvedMintEntries =
  | { ok: true; entries: { key: string; assignmentId: string; dependsOn: string[] }[] }
  | { ok: false; detail: string };

/**
 * Re-keys the spec's DAG onto minted assignment ids. The assignment list is scoped to the
 * request before any lookup runs — spec keys are deterministic, so another request's hops
 * carry the same keys and an unscoped map would happily bind them. Every spec key must resolve
 * to exactly one assignment via pipelineKey, and every pipelined assignment must name a spec
 * key — an unknown or unminted key is refused by name rather than resolved to nothing.
 */
export function mintEntriesFor(spec: CommRoundSpec, request: Request, assignments: readonly Assignment[]): ResolvedMintEntries {
  const byKey = new Map<string, string>();
  for (const assignment of assignments) {
    if (assignment.requestId !== request.id || !assignment.pipelineKey) continue;
    const prior = byKey.get(assignment.pipelineKey);
    if (prior && prior !== assignment.id)
      return { ok: false, detail: `Two assignments (${prior}, ${assignment.id}) claim pipeline key '${assignment.pipelineKey}' — the mint cannot resolve it.` };
    byKey.set(assignment.pipelineKey, assignment.id);
  }
  const specKeys = new Set(spec.entries.map(entry => entry.key));
  for (const key of byKey.keys())
    if (!specKeys.has(key)) return { ok: false, detail: `Assignment pipeline key '${key}' names no entry in this spec — unknown keys are refused.` };
  const missing = spec.entries.filter(entry => !byKey.has(entry.key)).map(entry => entry.key);
  if (missing.length) return { ok: false, detail: `No minted assignment carries spec ${missing.length === 1 ? 'key' : 'keys'}: ${missing.join(', ')}.` };
  return {
    ok: true,
    entries: spec.entries.map(entry => ({
      key: entry.key,
      assignmentId: byKey.get(entry.key)!,
      dependsOn: entry.dependsOnKeys.map(key => byKey.get(key)!),
    })),
  };
}
