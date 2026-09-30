import type { AppState, Provider } from './types.js';

/** How recent a provider event must be before the office will show it as live work. */
export const ACTIVITY_FRESHNESS_MS = 5 * 60 * 1000;
/** An alive office-spawned process that has written before but went quiet this long reads as stalled. */
export const PRESENCE_STALLED_MS = 10 * 60 * 1000;
/** How long a just-finished job keeps a monitor glowing done/failed. */
export const RECENT_OUTCOME_MS = 10 * 60 * 1000;

export type ActivityKind = 'WORKING' | 'MEETING' | 'IDLE' | 'UNKNOWN';
/**
 * Where the office's claim comes from: the provider's own events, the office watching a process it
 * spawned (alive, nothing more), or nothing at all.
 */
export type ActivityEvidence = 'PROVIDER_REPORTED' | 'OFFICE_OBSERVED' | 'NONE';
export interface OfficeActivity {
  agentId: string;
  kind: ActivityKind;
  since: string;
  requestId: string;
  jobId: string;
  meetingId?: string;
  detail: string;
  /** Who vouches for this activity. Absent on entries that make no live-work claim. */
  evidence?: ActivityEvidence;
  /** When the office-owned process started — present only while the office watches one. */
  startedAt?: string;
  /** Milliseconds since the office-owned process last wrote output (or since launch when silent). */
  silentMs?: number;
  /** Alive, has spoken before, and has been quiet for PRESENCE_STALLED_MS. */
  stalled?: boolean;
  /** An IDLE seat whose last job finished a moment ago: recorded outcome, never inferred. */
  recent?: { outcome: 'DONE' | 'FAILED'; at: string; requestId: string };
}
/**
 * The office's own view of a child process it spawned. Held in memory by the exec adapter — never
 * written to the event chain — and pushed to the renderer so a running agent's monitor can be lit
 * even when the CLI streams nothing until it exits.
 */
export interface LivePresence {
  jobId: string;
  provider: Provider;
  pid: number | null;
  startedAt: string;
  /** Last stdout/stderr chunk from the child, or null if it has been silent since launch. */
  lastOutputAt: string | null;
  alive: boolean;
}
type Records = Pick<
  AppState,
  'agents' | 'assignments' | 'jobs' | 'jobEvents' | 'messages' | 'requests' | 'localSessions'
>;

/** Stop statuses that durably record the office no longer observes a live process. */
const DEAD_STOP_STATUSES = new Set(['PROCESS_EXIT_OBSERVED', 'SESSION_REPORTED_STOPPED', 'LEGACY_UNVERIFIED']);

/**
 * Live office activity, derived only from confirmed evidence.
 *
 * Imported transcripts and local bookkeeping never move anyone. Evidence is either a fresh provider
 * event or — for a process the office itself spawned — the office watching that process stay alive
 * (`presence`). An open job with neither is Unknown rather than Idle, because the office genuinely
 * does not know. Exactly one entry per agent, in a stable order, so no avatar can appear twice.
 */
export function officeActivity(
  state: Records,
  options: { now?: number; freshnessMs?: number; presence?: readonly LivePresence[] } = {},
): OfficeActivity[] {
  const now = options.now ?? Date.now();
  const freshness = options.freshnessMs ?? ACTIVITY_FRESHNESS_MS;
  const presenceByJob = new Map((options.presence ?? []).map(item => [item.jobId, item]));
  const agents = (state.agents ?? [])
    .filter(agent => !agent.removedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const requests = new Map((state.requests ?? []).map(request => [request.id, request]));
  const sessions = new Map((state.localSessions ?? []).map(session => [session.jobId, session]));
  const result: OfficeActivity[] = [];
  for (const agent of agents) {
    const assignments = (state.assignments ?? []).filter(item => item.agentId === agent.id);
    const jobs = (state.jobs ?? []).filter(job => assignments.some(item => item.id === job.assignmentId));
    const openJobs = jobs
      .filter(job => ['ACCEPTED', 'RUNNING', 'CANCEL_REQUESTED', 'UNKNOWN', 'SUBMITTING'].includes(job.state))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const open = openJobs.at(-1);
    // A canceled request's leftover work only holds a seat while the office still observes live
    // work on it. A durably dead process — or no fresh evidence at all — reads as IDLE with the
    // honest 'outcome unresolved' note, never a misleading UNKNOWN that implies a provider gap.
    const cancelled = open ? requests.get(open.requestId)?.status === 'CANCELED' : false;
    // 'Not alive' must be proven: a durably recorded dead stop, or no office-owned process was ever
    // recorded for the job. A binding that might still be running keeps the honest UNKNOWN.
    const deadProcess = open
      ? sessions.get(open.id)
        ? DEAD_STOP_STATUSES.has(sessions.get(open.id)!.stopStatus)
        : true
      : false;
    const events = open
      ? (state.jobEvents ?? [])
          .filter(event => event.jobId === open.id && event.evidence === 'PROVIDER_REPORTED')
          .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      : [];
    const last = events.at(-1);
    const heard = open
      ? last
        ? Date.parse(last.receivedAt)
        : open.evidence === 'PROVIDER_REPORTED'
          ? Date.parse(open.updatedAt)
          : Number.NaN
      : Number.NaN;
    const providerFresh = Number.isFinite(heard) && now - heard <= freshness;
    const presence = open ? presenceByJob.get(open.id) : undefined;
    const observed = !!presence?.alive;
    const fresh = providerFresh || observed;
    if (!open || (cancelled && !fresh && deadProcess)) {
      const dropped = !open;
      // A job that just settled is a recorded outcome the monitor may flash — done or failed — for a short while.
      const settled = dropped
        ? jobs
            .filter(job => job.state === 'COMPLETED' || job.state === 'FAILED')
            .map(job => ({ job, at: Date.parse(job.settledAt || job.updatedAt) }))
            .filter(item => Number.isFinite(item.at) && now - item.at >= 0 && now - item.at <= RECENT_OUTCOME_MS)
            .sort((a, b) => a.at - b.at)
            .at(-1)
        : undefined;
      result.push({
        agentId: agent.id,
        kind: 'IDLE',
        since: '',
        requestId: '',
        jobId: '',
        detail: dropped ? 'No provider work is open for this profile.' : 'Last job cancelled; outcome unresolved',
        ...(settled
          ? {
              recent: {
                outcome: settled.job.state === 'COMPLETED' ? ('DONE' as const) : ('FAILED' as const),
                at: new Date(settled.at).toISOString(),
                requestId: settled.job.requestId,
              },
            }
          : {}),
      });
      continue;
    }
    if (!fresh) {
      result.push({
        agentId: agent.id,
        kind: 'UNKNOWN',
        since: last?.receivedAt ?? open.updatedAt,
        requestId: open.requestId,
        jobId: open.id,
        evidence: 'NONE',
        detail: presence
          ? "The office's process for this job has exited; its result is being read."
          : last
            ? "No fresh provider event; this job's current state is unknown."
            : 'No provider event has been received for this job.',
      });
      continue;
    }
    const silentSince = presence?.lastOutputAt ?? presence?.startedAt;
    const silentMs = observed && silentSince ? Math.max(0, now - Date.parse(silentSince)) : undefined;
    const stalled = observed && !!presence?.lastOutputAt && (silentMs ?? 0) >= PRESENCE_STALLED_MS;
    const observedFields = observed
      ? {
          startedAt: presence!.startedAt,
          ...(silentMs !== undefined ? { silentMs } : {}),
          ...(stalled ? { stalled } : {}),
        }
      : {};
    // A delivered message between agents on the same request is the only thing that gathers people.
    const meeting = (state.messages ?? []).find(
      message =>
        message.requestId === open.requestId &&
        message.deliveredAt &&
        now - Date.parse(message.deliveredAt) <= freshness &&
        [message.fromAgentId, message.toAgentId].includes(agent.id),
    );
    const evidence: ActivityEvidence = providerFresh ? 'PROVIDER_REPORTED' : 'OFFICE_OBSERVED';
    result.push(
      meeting
        ? {
            agentId: agent.id,
            kind: 'MEETING',
            since: meeting.deliveredAt,
            requestId: open.requestId,
            jobId: open.id,
            meetingId: open.requestId,
            detail: 'Exchanging work on this request.',
            evidence,
            ...observedFields,
          }
        : {
            agentId: agent.id,
            kind: 'WORKING',
            since: providerFresh ? (last?.occurredAt ?? open.updatedAt) : (presence?.startedAt ?? open.updatedAt),
            requestId: open.requestId,
            jobId: open.id,
            detail: providerFresh
              ? (last?.text ?? open.detail)
              : `The office is running this profile's ${presence!.provider} process; the CLI has not reported progress.`,
            evidence,
            ...observedFields,
          },
    );
  }
  return result;
}
