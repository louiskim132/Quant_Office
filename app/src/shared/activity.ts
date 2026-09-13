import type { AppState } from './types.js';

/** How recent a provider event must be before the office will show it as live work. */
export const ACTIVITY_FRESHNESS_MS = 5 * 60 * 1000;

export type ActivityKind = 'WORKING' | 'MEETING' | 'IDLE' | 'UNKNOWN';
export interface OfficeActivity {
  agentId: string; kind: ActivityKind; since: string; requestId: string; jobId: string; meetingId?: string; detail: string;
}
type Records = Pick<AppState, 'agents' | 'assignments' | 'jobs' | 'jobEvents' | 'messages'>;

/**
 * Live office activity, derived only from confirmed provider evidence.
 *
 * Imported transcripts and local bookkeeping never move anyone. An open job whose last provider
 * event has gone stale is Unknown rather than Idle, because the office genuinely does not know.
 * Exactly one entry per agent, in a stable order, so no avatar can appear twice.
 */
export function officeActivity(state: Records, options: { now?: number; freshnessMs?: number } = {}): OfficeActivity[] {
  const now = options.now ?? Date.now();
  const freshness = options.freshnessMs ?? ACTIVITY_FRESHNESS_MS;
  const agents = (state.agents ?? []).filter(agent => !agent.removedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const result: OfficeActivity[] = [];
  for (const agent of agents) {
    const assignments = (state.assignments ?? []).filter(item => item.agentId === agent.id);
    const jobs = (state.jobs ?? []).filter(job => assignments.some(item => item.id === job.assignmentId));
    const open = jobs.filter(job => ['ACCEPTED', 'RUNNING', 'CANCEL_REQUESTED', 'UNKNOWN', 'SUBMITTING'].includes(job.state))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
    if (!open) { result.push({ agentId: agent.id, kind: 'IDLE', since: '', requestId: '', jobId: '', detail: 'No provider work is open for this profile.' }); continue; }
    const events = (state.jobEvents ?? []).filter(event => event.jobId === open.id && event.evidence === 'PROVIDER_REPORTED')
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const last = events.at(-1);
    const heard = last ? Date.parse(last.receivedAt) : (open.evidence === 'PROVIDER_REPORTED' ? Date.parse(open.updatedAt) : Number.NaN);
    if (!Number.isFinite(heard) || now - heard > freshness) {
      result.push({ agentId: agent.id, kind: 'UNKNOWN', since: last?.receivedAt ?? open.updatedAt, requestId: open.requestId, jobId: open.id,
        detail: last ? 'No fresh provider event; this job\'s current state is unknown.' : 'No provider event has been received for this job.' });
      continue;
    }
    // A delivered message between agents on the same request is the only thing that gathers people.
    const meeting = (state.messages ?? []).find(message => message.requestId === open.requestId && message.deliveredAt
      && now - Date.parse(message.deliveredAt) <= freshness && [message.fromAgentId, message.toAgentId].includes(agent.id));
    result.push(meeting
      ? { agentId: agent.id, kind: 'MEETING', since: meeting.deliveredAt, requestId: open.requestId, jobId: open.id, meetingId: open.requestId, detail: 'Exchanging work on this request.' }
      : { agentId: agent.id, kind: 'WORKING', since: last?.occurredAt ?? open.updatedAt, requestId: open.requestId, jobId: open.id, detail: last?.text ?? open.detail });
  }
  return result;
}
