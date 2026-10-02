import type { Agent, AccountConnection, AppState } from '../../shared/types';
import type { OfficeActivity } from '../../shared/activity';
import type { StatusKey } from '../status';
import type { Location } from './engine';
import type { BoardSummary } from './world';
import type { OfficeLayout, ZoneKey } from './layout';

/** The CSS token that colours each status — the same tokens every other surface uses. */
export const STATUS_VAR: Record<StatusKey, string> = {
  working: '--st-working',
  stalled: '--st-stalled',
  needs: '--st-needs',
  failed: '--st-failed',
  done: '--st-done',
  unknown: '--st-unknown',
  idle: '--st-idle',
  meeting: '--st-meeting',
};

/**
 * Seated figures keep typing only while the office has evidence of work. A stalled process is
 * alive but quiet, so it does not type; nothing here invents activity.
 */
export const typesWhile = (status: StatusKey) => status === 'working' || status === 'needs';

/** Counts for the wall board and the status line, derived only from the seat views. */
export function stageSummary(statuses: readonly StatusKey[]): BoardSummary {
  const count = (...keys: StatusKey[]) => statuses.filter(s => keys.includes(s)).length;
  return {
    working: count('working', 'stalled'),
    meeting: count('meeting'),
    idle: count('idle', 'done'),
    attention: count('needs', 'failed', 'unknown', 'stalled'),
    total: statuses.length,
  };
}

export function stageLine(summary: BoardSummary): string {
  const parts = [`${summary.working} working`, `${summary.meeting} in meeting`, `${summary.idle} idle`];
  if (summary.attention) parts.push(`${summary.attention} need${summary.attention === 1 ? 's' : ''} attention`);
  return parts.join(' · ');
}

/**
 * Meeting tables by slot: an id keeps its table while the meeting lasts, a finished meeting frees
 * its slot for the next one, and slots never shift under people who are still talking.
 */
export function assignRooms(previous: readonly (string | null)[], active: readonly string[]): (string | null)[] {
  const slots = previous.map(id => (id && active.includes(id) ? id : null));
  for (const id of active)
    if (!slots.includes(id)) {
      const free = slots.indexOf(null);
      if (free < 0) slots.push(id);
      else slots[free] = id;
    }
  return slots;
}

export const zoneOf = (agent: Pick<Agent, 'role'>): ZoneKey =>
  agent.role === 'DIRECTOR' ? 'director' : agent.role.startsWith('PM') ? 'pm' : 'worker';

/** Where everyone sits: agents fill their zone's desks in join order. */
export function assignDesks(layout: OfficeLayout, team: readonly Pick<Agent, 'id' | 'role'>[]): Map<string, number> {
  const result = new Map<string, number>();
  const used: Record<ZoneKey, number> = { director: 0, pm: 0, worker: 0 };
  for (const agent of team) {
    const zone = zoneOf(agent);
    const desks = layout.desks.filter(d => d.zone === zone);
    const desk = desks[used[zone]++];
    if (desk) result.set(agent.id, desk.index);
  }
  return result;
}

/** At or below this share of an allowance an agent stays at rest. */
export const REST_BELOW_PERCENT = 5;
/** An observation older than this says nothing about the allowance today. */
const USAGE_FRESH_MS = 12 * 3600_000;

/**
 * The lowest remaining share of any allowance window that has not reset yet, for the account this
 * agent runs under — or null when there is no recent observation. Only recorded sign-in
 * observations are used; nothing is guessed.
 */
export function remainingAllowance(
  agent: Pick<Agent, 'provider' | 'account'>,
  connections: readonly AccountConnection[] | undefined,
  now: number,
): number | null {
  const mine = (connections ?? []).filter(
    c =>
      c.provider === agent.provider &&
      c.state === 'SIGNED_IN' &&
      (!agent.account || !c.identity || c.identity.toLowerCase() === agent.account.toLowerCase()),
  );
  const latest = mine.sort((a, b) => Date.parse(b.lastCheckedAt) - Date.parse(a.lastCheckedAt))[0];
  if (!latest || !(now - Date.parse(latest.lastCheckedAt) <= USAGE_FRESH_MS)) return null;
  const live = latest.allowance.filter(w => w.resetsAt * 1000 > now);
  return live.length ? Math.min(...live.map(w => w.remainingPercent)) : null;
}

/** Project attendance changes location only; it never invents a working status. */
export function projectDeskAgents(
  state: Pick<AppState, 'agents' | 'requests' | 'teams' | 'memberships' | 'assignments'>,
  activity: readonly OfficeActivity[],
): Set<string> {
  const requests = (state.requests ?? []).filter(r => !r.removedAt && r.status !== 'CANCELED');
  const running = activity.filter(a => a.kind === 'WORKING' || a.kind === 'MEETING');
  const projects = new Set(requests.filter(r => running.some(a => a.requestId === r.id)).map(r => r.projectId));
  const related = requests.filter(r => projects.has(r.projectId));
  const teams = (state.teams ?? []).filter(
    t => !t.archived && ((t.projectId !== null && projects.has(t.projectId)) || related.some(r => r.teamId === t.id)),
  );
  const ids = new Set(running.map(a => a.agentId));
  for (const r of related) {
    if (r.leadAgentId) ids.add(r.leadAgentId);
    for (const id of r.participantIds ?? []) ids.add(id);
  }
  for (const m of state.memberships ?? []) if (!m.removedAt && teams.some(t => t.id === m.teamId)) ids.add(m.agentId);
  for (const a of state.assignments ?? [])
    if (projects.has(a.projectId) && related.some(r => r.id === a.requestId)) ids.add(a.agentId);
  return ids;
}

export function shouldRest(projectRunning: boolean, remaining: number | null): boolean {
  return (remaining !== null && remaining <= REST_BELOW_PERCENT) || !projectRunning;
}

/**
 * One location per agent: the rest area when they are resting, a chair at the room their meeting
 * was given, or their own desk.
 */
export function locate(
  agent: Pick<Agent, 'id'>,
  desks: ReadonlyMap<string, number>,
  activity: Pick<OfficeActivity, 'agentId' | 'kind' | 'meetingId'> | undefined,
  slots: readonly (string | null)[],
  seatInMeeting: ReadonlyMap<string, number>,
  restSlots: readonly (string | null)[] = [],
): Location {
  const spot = restSlots.indexOf(agent.id);
  if (spot >= 0) return { kind: 'rest', spot };
  if (activity?.kind === 'MEETING') {
    const room = slots.indexOf(activity.meetingId ?? 'meeting');
    if (room >= 0) return { kind: 'room', index: room, seat: seatInMeeting.get(agent.id) ?? 0 };
  }
  return { kind: 'desk', index: desks.get(agent.id) ?? 0 };
}
