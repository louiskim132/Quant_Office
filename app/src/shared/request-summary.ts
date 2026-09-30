import type { AppState, ProviderJob } from './types.js';
import { latestJobFor } from '../core/jobs.js';
import type { QueueEntry } from './queue.js';

/**
 * Where a request stands, for lists. Derived from recorded requests, hops and jobs only; it makes no
 * claim beyond them. `needs` means the next move is the user's (or a failure they must look at).
 */
export type RequestBucket = 'needs' | 'running' | 'queued' | 'done' | 'canceled';
export type RequestOutcome = 'APPROVED' | 'REVISION' | 'REJECTED';
export interface RequestSummary {
  bucket: RequestBucket;
  /** One short phrase naming the state: "Decision needed", "Running", "Approved"… */
  label: string;
  /** Why it needs the user, when bucket is `needs`. */
  reason: string;
  steps: { done: number; total: number };
  /** Agents whose current hop is still running. */
  runningAgentIds: string[];
  outcome?: RequestOutcome;
  /** The newest thing recorded on the request (ISO), for sorting and "3 min ago". */
  lastAt: string;
  failedHops: number;
  /** Hops left UNKNOWN with no receipt while the office watches no process for them. */
  unknownHops: number;
}

const RUNNING_STATES: ProviderJob['state'][] = ['SUBMITTING', 'ACCEPTED', 'RUNNING', 'CANCEL_REQUESTED'];

/**
 * `watchedJobIds` is the set of jobs the office holds a live process record for (presence), or
 * undefined until the window has heard presence at least once. A local hop stays UNKNOWN for its whole
 * run — the office records its own delivery, never ACCEPTED — so UNKNOWN is in progress while the office
 * watches the job or holds its receipt, and needs the user only when the office knows it watches
 * nothing for it (for example after a restart). The retry gate's "UNKNOWN without receipt" is not a
 * failure by itself.
 */
export function summarizeRequest(
  state: Pick<AppState, 'assignments' | 'jobs' | 'localSessions'>,
  entry: QueueEntry,
  watchedJobIds?: ReadonlySet<string>,
): RequestSummary {
  const request = entry.request;
  const canceledEntry = entry.status === 'CANCELED';
  const base = { steps: { done: 0, total: 0 }, runningAgentIds: [] as string[], failedHops: 0, unknownHops: 0 };
  if (!request) {
    // Legacy group or standalone task: only its own recorded status is known.
    return {
      ...base,
      bucket: canceledEntry ? 'canceled' : entry.settled || entry.status === 'ACCEPTED' ? 'done' : 'queued',
      label: canceledEntry ? 'Canceled' : entry.status === 'ACCEPTED' ? 'Completed' : 'Waiting',
      reason: '',
      lastAt: entry.root.updatedAt,
    };
  }
  const hops = (state.assignments ?? []).filter(item => item.requestId === request.id && item.pipelineKey);
  const all = (state.assignments ?? []).filter(item => item.requestId === request.id);
  const scoped = hops.length ? hops : all;
  const rows = scoped.map(a => ({ a, job: latestJobFor(state.jobs, a.id) }));
  const receipted = (job: ProviderJob) => !!(state.localSessions ?? []).find(s => s.jobId === job.id)?.lastReceipt;
  // UNKNOWN that nothing accounts for: no receipt, and the office knows it watches no process for it.
  const unaccounted = (job: ProviderJob) =>
    job.state === 'UNKNOWN' && !!watchedJobIds && !watchedJobIds.has(job.id) && !receipted(job);
  const running = rows.filter(
    r => r.job && (RUNNING_STATES.includes(r.job.state) || (r.job.state === 'UNKNOWN' && !unaccounted(r.job))),
  );
  const failed = rows.filter(r => r.job?.state === 'FAILED');
  const unknown = rows.filter(r => r.job && unaccounted(r.job));
  const done = rows.filter(r => r.job?.state === 'COMPLETED').length;
  const times = [request.updatedAt, ...rows.map(r => r.job?.updatedAt ?? '')].filter(Boolean).sort();
  const common = {
    steps: { done, total: rows.length },
    runningAgentIds: [...new Set(running.map(r => r.a.agentId))],
    failedHops: failed.length,
    unknownHops: unknown.length,
    lastAt: times.at(-1) ?? request.updatedAt,
  };
  if (request.status === 'CANCELED') return { ...common, bucket: 'canceled', label: 'Canceled', reason: '' };
  const pipeline = request.pipeline;
  if (pipeline) {
    if (pipeline.phase === 'DECIDED') {
      const decision = pipeline.decision?.decision;
      const outcome: RequestOutcome | undefined =
        decision === 'APPROVE'
          ? 'APPROVED'
          : decision === 'REVISE'
            ? 'REVISION'
            : decision === 'REJECT'
              ? 'REJECTED'
              : undefined;
      return {
        ...common,
        bucket: 'done',
        outcome,
        reason: '',
        label:
          outcome === 'APPROVED'
            ? 'Approved'
            : outcome === 'REVISION'
              ? 'Revision requested'
              : outcome === 'REJECTED'
                ? 'Rejected'
                : 'Decided',
      };
    }
    if (pipeline.phase === 'AWAITING_DECISION')
      return {
        ...common,
        bucket: 'needs',
        label: 'Decision needed',
        reason: 'Review the report, then approve, request a revision or reject.',
      };
    if (failed.length)
      return {
        ...common,
        bucket: 'needs',
        label: failed.length === 1 ? 'A step failed' : `${failed.length} steps failed`,
        reason: 'Open the request to retry or cancel the failed step.',
      };
    if (unknown.length)
      return {
        ...common,
        bucket: 'needs',
        label: unknown.length === 1 ? 'Step status unknown' : `${unknown.length} steps status unknown`,
        reason: 'The office is watching no process for it. Open the request to observe, retry or cancel it.',
      };
    if (pipeline.phase === 'BRIEFING') {
      const brief = pipeline.briefAssignmentId ? latestJobFor(state.jobs, pipeline.briefAssignmentId) : undefined;
      if (brief?.state === 'COMPLETED')
        return {
          ...common,
          bucket: 'needs',
          label: 'Brief ready',
          reason: "Read the director's brief, add notes, then confirm and launch.",
        };
      if (brief && (RUNNING_STATES.includes(brief.state) || (brief.state === 'UNKNOWN' && !unaccounted(brief))))
        return { ...common, bucket: 'running', label: 'Director briefing', reason: '' };
      return {
        ...common,
        bucket: 'queued',
        label: request.status === 'DRAFT' ? 'Draft' : 'Ready to start',
        reason: '',
      };
    }
    return running.length
      ? { ...common, bucket: 'running', label: 'Running', reason: '' }
      : { ...common, bucket: 'queued', label: 'Waiting for the next step', reason: '' };
  }
  if (request.blockers.length)
    return { ...common, bucket: 'needs', label: 'Blocked', reason: request.blockers.map(b => b.message).join(' ') };
  if (failed.length)
    return { ...common, bucket: 'needs', label: 'A job failed', reason: 'Open the request to review the failed job.' };
  if (unknown.length)
    return {
      ...common,
      bucket: 'needs',
      label: 'Job status unknown',
      reason: 'The office is watching no process for it. Open the request to observe or cancel it.',
    };
  if (running.length || entry.actions?.awaitingReconciliation)
    return { ...common, bucket: 'running', label: 'Running', reason: '' };
  if (entry.settled) return { ...common, bucket: 'done', label: 'Completed', reason: '' };
  return { ...common, bucket: 'queued', label: request.status === 'DRAFT' ? 'Draft' : 'Ready to start', reason: '' };
}
