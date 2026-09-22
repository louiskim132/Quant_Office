import type { ToolProfile } from '../shared/tool-profile.js';

/**
 * The diverge→converge round planner (inter-agent pipeline W5).
 *
 * One declaration expands into a deterministic ordered spec: two isolated planner drafts on
 * identical inputs, one bounded cross-critique round answering the opposite draft's named
 * artifact, and a director synthesis — optionally mirrored by an analyst interpret/falsify
 * pair with bounded cross-responses and a director finalize — then the implement, verify and
 * user-gate hops. Predecessors pass artifact references only: no field anywhere in the spec
 * carries a transcript, prompt prose or free-text carryover, so a hop can only ever point at
 * the named items it was declared against.
 *
 * The module is pure: no I/O, no clock, no randomness. The executor that turns this spec into
 * requests and assignments is wired separately; byte-identical declarations produce
 * byte-identical specs (canonical ordering, positional keys).
 */

/** The hop roles a round can carry, in the order the spec emits them. */
export type CommRoundPhase = 'PLAN_DRAFT' | 'PLAN_CRITIQUE' | 'PLAN_SYNTHESIS' | 'IMPLEMENT' | 'VERIFY' | 'USER_GATE';

export interface CommRoundDeclaration {
 projectId: string;
 brief: string;
 directorAgentId: string;
 /** Exactly two planner arms — the diverge pair whose isolation makes the critique meaningful. */
 planners: [string, string];
 /** Optional second pair running the phase-2 mirror against the synthesized plan. */
 analysts?: [string, string];
 workerAgentIds: string[];
 /** The packet contract version every hop in this round rides. */
 packetVersion: number;
}

export interface CommRoundEntry {
 /** Positional key, deterministic for a given declaration — never derived from run time. */
 key: string;
 phase: CommRoundPhase;
 agentId: string;
 /** Artifact refs this hop may read — keys of earlier entries only. Never transcripts. */
 dependsOnKeys: string[];
 toolProfile: ToolProfile;
 /** The declared input manifest: the packet version, the brief, and named artifact refs. */
 inputManifestNote: string;
}

export interface CommRoundSpec {
 schema: 'office-comm-round@1';
 projectId: string;
 packetVersion: number;
 entries: CommRoundEntry[];
}

/**
 * The per-arm tool table. Planners navigate the project read-only through the serena stdio
 * server; analysts query only the grant-checked evidence surface; workers are the single arm
 * allowed to write outside outputs/. The director's decision hops declare no write scope at
 * all — their answer rides the result contract like every other receipt.
 */
export const PLANNER_TOOL_PROFILE: ToolProfile = {
 mcpServers: [{ id: 'serena', command: 'serena start-mcp-server', args: ['--project', '.'], readOnly: true }],
 filesystem: 'READ_PROJECT',
 canWrite: false,
};
export const ANALYST_TOOL_PROFILE: ToolProfile = {
 mcpServers: [{ id: 'evidence-surface', command: 'office evidence-surface', readOnly: true }],
 filesystem: 'PACKET_ONLY',
 canWrite: false,
};
export const WORKER_TOOL_PROFILE: ToolProfile = { canWrite: true };
export const DIRECTOR_TOOL_PROFILE: ToolProfile = { canWrite: false };

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Every input manifest names the packet version, the declaration brief and only artifact refs. */
function manifestNote(declaration: CommRoundDeclaration, dependsOnKeys: string[]): string {
 return [`packet-v${declaration.packetVersion}`, 'declaration.brief', ...dependsOnKeys.map(key => `artifact:${key}`)].join(' + ');
}

function entry(declaration: CommRoundDeclaration, key: string, phase: CommRoundPhase, agentId: string, toolProfile: ToolProfile, dependsOnKeys: string[]): CommRoundEntry {
 return { key, phase, agentId, dependsOnKeys, toolProfile, inputManifestNote: manifestNote(declaration, dependsOnKeys) };
}

function validate(declaration: CommRoundDeclaration): void {
 if (!declaration || typeof declaration !== 'object') throw new Error('A comm-round declaration is required.');
 if (!nonEmpty(declaration.projectId)) throw new Error('The declaration must name the office project this round belongs to.');
 if (!nonEmpty(declaration.brief)) throw new Error('The declaration must carry the round brief.');
 if (!nonEmpty(declaration.directorAgentId)) throw new Error('The declaration must name the director arm.');
 // Each diverge pair needs exactly two distinct arms: a pair that is one agent twice cannot
 // diverge, and a critique between identical arms would pretend to be a second opinion.
 for (const [name, pair] of [['planners', declaration.planners], ['analysts', declaration.analysts]] as const) {
  if (pair === undefined) continue;
  if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(nonEmpty))
   throw new Error(`The ${name} arm must be exactly two distinct agents.`);
  if (pair[0] === pair[1]) throw new Error(`The ${name} arms must be two different agents — a diverge pair cannot be one agent twice.`);
 }
 if (!Array.isArray(declaration.planners)) throw new Error('The planners arm is required.');
 if (!Array.isArray(declaration.workerAgentIds) || declaration.workerAgentIds.length === 0 || !declaration.workerAgentIds.every(nonEmpty))
  throw new Error('The round needs at least one worker arm for the implement hop.');
 if (new Set(declaration.workerAgentIds).size !== declaration.workerAgentIds.length)
  throw new Error('Worker arms must be distinct — a duplicated worker would own two identical implement keys.');
 if (!Number.isSafeInteger(declaration.packetVersion) || declaration.packetVersion < 1)
  throw new Error('packetVersion must be a positive integer naming the packet contract every hop rides.');
}

/**
 * The spec's own invariants, asserted on the finished entries rather than trusted to the
 * construction: keys are unique, and every dependency names an entry that was already emitted,
 * which is what makes the ordering a DAG a reader can trust without re-checking.
 */
function assertDag(entries: CommRoundEntry[]): void {
 const seen = new Set<string>();
 for (const item of entries) {
  if (seen.has(item.key)) throw new Error(`Duplicate spec key ${item.key}.`);
  for (const dep of item.dependsOnKeys) {
   if (!seen.has(dep)) throw new Error(`Entry ${item.key} depends on ${dep}, which no earlier entry produced — forward or unknown dependencies are refused.`);
  }
  seen.add(item.key);
 }
}

export function buildCommRound(declaration: CommRoundDeclaration): CommRoundSpec {
 validate(declaration);
 const [plannerA, plannerB] = declaration.planners;
 const entries: CommRoundEntry[] = [];
 // Phase 1: two isolated first positions on identical inputs — the draft arms carry the same
 // manifest by construction, so neither draft is privileged by what it was shown.
 const draftA = entry(declaration, 'plan-draft-a', 'PLAN_DRAFT', plannerA, PLANNER_TOOL_PROFILE, []);
 const draftB = entry(declaration, 'plan-draft-b', 'PLAN_DRAFT', plannerB, PLANNER_TOOL_PROFILE, []);
 // One bounded cross-response each: a critique names only the opposite draft's artifact.
 const critiqueA = entry(declaration, 'plan-critique-a-on-b', 'PLAN_CRITIQUE', plannerA, PLANNER_TOOL_PROFILE, [draftB.key]);
 const critiqueB = entry(declaration, 'plan-critique-b-on-a', 'PLAN_CRITIQUE', plannerB, PLANNER_TOOL_PROFILE, [draftA.key]);
 const synthesis = entry(declaration, 'plan-synthesis', 'PLAN_SYNTHESIS', declaration.directorAgentId, DIRECTOR_TOOL_PROFILE,
  [draftA.key, draftB.key, critiqueA.key, critiqueB.key]);
 entries.push(draftA, draftB, critiqueA, critiqueB, synthesis);
 // Phase 2 mirrors phase 1 against the synthesized plan: interpret ∥ falsify, one bounded
 // cross-response each, then the director finalizes. Same roles, same phase labels.
 let head = synthesis;
 if (declaration.analysts) {
  const [analystC, analystD] = declaration.analysts;
  const interpret = entry(declaration, 'analysis-interpret', 'PLAN_DRAFT', analystC, ANALYST_TOOL_PROFILE, [synthesis.key]);
  const falsify = entry(declaration, 'analysis-falsify', 'PLAN_DRAFT', analystD, ANALYST_TOOL_PROFILE, [synthesis.key]);
  const responseC = entry(declaration, 'analysis-response-interpret', 'PLAN_CRITIQUE', analystC, ANALYST_TOOL_PROFILE, [falsify.key]);
  const responseD = entry(declaration, 'analysis-response-falsify', 'PLAN_CRITIQUE', analystD, ANALYST_TOOL_PROFILE, [interpret.key]);
  const finalize = entry(declaration, 'analysis-finalize', 'PLAN_SYNTHESIS', declaration.directorAgentId, DIRECTOR_TOOL_PROFILE,
   [interpret.key, falsify.key, responseC.key, responseD.key]);
  entries.push(interpret, falsify, responseC, responseD, finalize);
  head = finalize;
 }
 const implements_ = declaration.workerAgentIds.map((agentId, index) =>
  entry(declaration, `implement-${index + 1}`, 'IMPLEMENT', agentId, WORKER_TOOL_PROFILE, [head.key]));
 const verify = entry(declaration, 'verify', 'VERIFY', declaration.directorAgentId, DIRECTOR_TOOL_PROFILE, implements_.map(item => item.key));
 const gate = entry(declaration, 'user-gate', 'USER_GATE', declaration.directorAgentId, DIRECTOR_TOOL_PROFILE, [verify.key]);
 entries.push(...implements_, verify, gate);
 assertDag(entries);
 return { schema: 'office-comm-round@1', projectId: declaration.projectId, packetVersion: declaration.packetVersion, entries };
}
