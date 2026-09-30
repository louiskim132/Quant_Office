import { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { OfficeActivity } from '../shared/activity';
import type { Agent, AppState } from '../shared/types';
import { Avatar, Disclosure, StatusPill } from './components';
import { seatView } from './seat-view';
import { timeAgo } from './status';
import './components.css';

/**
 * A side panel for one agent, opened from the office, the roster strip or the Now panel. It keeps the
 * page behind it usable. Everything shown is already recorded; the two actions (Observe, Stop) are the
 * same calls the request cards make, on this agent's open job.
 */
export function AgentDrawer({
  agent,
  activity,
  state,
  now,
  onClose,
  onState,
  onProfile,
  onOpenRequest,
}: {
  agent: Agent;
  activity: OfficeActivity | undefined;
  state: AppState;
  now: number;
  onClose: () => void;
  onState: (s: AppState) => void;
  onProfile: (id: string) => void;
  onOpenRequest: (requestId: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        !document.querySelector('dialog[open]') &&
        [...document.querySelectorAll('.drawer')].at(-1) === ref.current
      ) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const view = seatView(agent, activity, state.requests, now);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [confirmStop, setConfirmStop] = useState(false);
  const openJob = activity?.jobId ? (state.jobs ?? []).find(j => j.id === activity.jobId) : undefined;
  const assignmentIds = new Set((state.assignments ?? []).filter(a => a.agentId === agent.id).map(a => a.id));
  const recent = (state.jobs ?? [])
    .filter(j => assignmentIds.has(j.assignmentId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  async function run(label: string, action: () => Promise<AppState>) {
    setBusy(label);
    setError('');
    try {
      onState(await action());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      setConfirmStop(false);
    }
  }
  const requestName = (id: string) => (state.requests ?? []).find(r => r.id === id)?.name ?? 'Request';
  return (
    <aside ref={ref} tabIndex={-1} className="drawer" role="complementary" aria-label={`${agent.name} details`}>
      <div className="drawer-head">
        <Avatar id={agent.id} name={agent.name} size={36} status={view.status} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2>{agent.name}</h2>
          <span className="muted">
            {agent.role.replaceAll('_', ' ')} · {agent.team}
          </span>
        </div>
        <StatusPill status={view.status} />
        <button className="icon-button" aria-label="Close details" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="drawer-body">
        <section className="drawer-section">
          <h3>Right now</h3>
          <p>{view.line}</p>
          {activity && activity.kind !== 'IDLE' && <p className="muted">{activity.detail}</p>}
          <dl className="drawer-facts">
            {view.requestName && (
              <>
                <dt>Request</dt>
                <dd>{view.requestName}</dd>
              </>
            )}
            {view.elapsed && (
              <>
                <dt>Elapsed</dt>
                <dd>{view.elapsed}</dd>
              </>
            )}
            <dt>Evidence</dt>
            <dd>{view.evidence}</dd>
            <dt>Model</dt>
            <dd>
              {agent.provider} · {agent.model} · {agent.effort ?? 'default'} effort
            </dd>
          </dl>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <div className="drawer-actions" style={{ marginTop: 12 }}>
            {openJob && (
              <>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    void run('observe', () => window.office.observeJob({ assignmentId: openJob.assignmentId }))
                  }
                >
                  {busy === 'observe' ? 'Checking…' : 'Check now'}
                </button>
                {confirmStop ? (
                  <>
                    <button
                      className="cancel-request"
                      disabled={!!busy}
                      onClick={() =>
                        void run('stop', () => window.office.cancelJob({ assignmentId: openJob.assignmentId }))
                      }
                    >
                      {busy === 'stop' ? 'Stopping…' : 'Yes, stop this job'}
                    </button>
                    <button className="text-button" onClick={() => setConfirmStop(false)}>
                      Keep running
                    </button>
                  </>
                ) : (
                  <button className="cancel-request" disabled={!!busy} onClick={() => setConfirmStop(true)}>
                    Stop
                  </button>
                )}
              </>
            )}
            {activity?.requestId && (
              <button className="secondary" onClick={() => onOpenRequest(activity.requestId)}>
                Open request
              </button>
            )}
            <button className="secondary" onClick={() => onProfile(agent.id)}>
              Full profile &amp; logs
            </button>
          </div>
        </section>
        <section className="drawer-section">
          <h3>Recent jobs</h3>
          {recent.length ? (
            <ul className="drawer-jobs">
              {recent.map(job => (
                <li key={job.id}>
                  <span>{requestName(job.requestId)}</span>
                  <span className="chip">{job.state.toLowerCase().replaceAll('_', ' ')}</span>
                  <span className="muted">{timeAgo(job.updatedAt, now)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">This agent has not been given any work yet.</p>
          )}
        </section>
        {activity && activity.jobId && (
          <Disclosure>
            <dl className="drawer-facts">
              <dt>Job</dt>
              <dd>
                <code>{activity.jobId}</code>
              </dd>
              {activity.startedAt && (
                <>
                  <dt>Process started</dt>
                  <dd>{activity.startedAt}</dd>
                </>
              )}
            </dl>
          </Disclosure>
        )}
      </div>
    </aside>
  );
}
