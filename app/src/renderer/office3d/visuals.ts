import type { Agent } from '../../shared/types';
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

/** One location per agent: their desk, or a chair at the table their meeting was given. */
export function locate(
  agent: Pick<Agent, 'id'>,
  desks: ReadonlyMap<string, number>,
  activity: Pick<OfficeActivity, 'agentId' | 'kind' | 'meetingId'> | undefined,
  slots: readonly (string | null)[],
  seatInMeeting: ReadonlyMap<string, number>,
): Location {
  if (activity?.kind === 'MEETING') {
    const table = slots.indexOf(activity.meetingId ?? 'meeting');
    if (table >= 0) return { kind: 'table', index: table, seat: seatInMeeting.get(agent.id) ?? 0 };
  }
  return { kind: 'desk', index: desks.get(agent.id) ?? 0 };
}
