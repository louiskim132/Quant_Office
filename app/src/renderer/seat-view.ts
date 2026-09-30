import type { OfficeActivity } from '../shared/activity';
import type { Agent, AppState } from '../shared/types';
import { activityStatus, formatElapsed, timeAgo, type StatusKey } from './status';

/** What one seat shows, derived once so the scene, the Now panel, the drawer and the strip agree. */
export interface SeatView {
  status: StatusKey;
  /** Short line for the seat label and the Now panel: never claims more than the evidence. */
  line: string;
  /** Text in the speech bubble above the head; empty when the seat is quiet. */
  bubble: string;
  requestName: string;
  /** Where the claim comes from, in words a person can weigh. */
  evidence: string;
  elapsed: string;
  monitor: 'off' | 'working' | 'unknown' | 'away' | 'done' | 'failed' | 'stalled';
}

const MONITOR: Record<StatusKey, SeatView['monitor']> = {
  working: 'working',
  stalled: 'stalled',
  meeting: 'away',
  unknown: 'unknown',
  done: 'done',
  failed: 'failed',
  idle: 'off',
  needs: 'working',
};

export function seatView(
  agent: Agent,
  activity: OfficeActivity | undefined,
  requests: AppState['requests'],
  now: number,
): SeatView {
  const status = activityStatus(activity);
  const requestId = activity?.requestId || activity?.recent?.requestId || '';
  const requestName = requestId ? ((requests ?? []).find(r => r.id === requestId)?.name ?? '') : '';
  const started = activity?.startedAt ? Date.parse(activity.startedAt) : Date.parse(activity?.since ?? '');
  const elapsed =
    Number.isFinite(started) && (activity?.kind === 'WORKING' || activity?.kind === 'MEETING')
      ? formatElapsed(now - started)
      : '';
  const evidence =
    activity?.evidence === 'PROVIDER_REPORTED'
      ? 'Provider reported activity'
      : activity?.evidence === 'OFFICE_OBSERVED'
        ? 'The office sees its process running'
        : activity?.kind === 'IDLE'
          ? 'No open work'
          : 'No signal';
  let line: string;
  let bubble = '';
  switch (status) {
    case 'working':
      line = requestName ? `Working · ${requestName}` : 'Working';
      bubble = elapsed ? `Working · ${elapsed}` : 'Working';
      break;
    case 'stalled':
      line = `Quiet for ${formatElapsed(activity?.silentMs ?? 0)} · process still running`;
      bubble = `Quiet ${formatElapsed(activity?.silentMs ?? 0)}`;
      break;
    case 'meeting':
      line = requestName ? `In a meeting · ${requestName}` : 'In a meeting';
      bubble = '•••';
      break;
    case 'unknown':
      line = 'Unknown · no signal from this job';
      bubble = '?';
      break;
    case 'done':
      line = `Finished ${timeAgo(activity!.recent!.at, now)}`;
      bubble = 'Done';
      break;
    case 'failed':
      line = `Failed ${timeAgo(activity!.recent!.at, now)}`;
      bubble = 'Failed';
      break;
    default:
      line = agent.removedAt ? 'Archived' : 'Idle · no open provider work';
  }
  return { status, line, bubble, requestName, evidence, elapsed, monitor: MONITOR[status] };
}
