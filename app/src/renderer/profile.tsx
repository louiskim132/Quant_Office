import { OfficeChat } from './office-chat';
import React, { useEffect, useRef, useState } from 'react';
import type { Agent, AppState, Assignment, JobEvent, ProviderJob, Request, WorkLog } from '../shared/types';
import { agentDispatchReadiness } from '../shared/readiness';
import { formatDateTime } from './format';

/**
 * One frozen assignment and the job that runs it. The applied self-report comes from the bounded
 * structured query, never the pushed snapshot — publicState strips jobEvents entirely. Structured
 * payloads exist only on bound v2 receipts, so the mismatch check reads them directly; unbound
 * legacy reports still show their recorded text.
 */
function AssignmentRow({
  assignment,
  job,
  request,
  state,
}: {
  assignment: Assignment;
  job: ProviderJob | undefined;
  request: Request | undefined;
  state: AppState;
}) {
  const [report, setReport] = useState<JobEvent | undefined>(undefined);
  useEffect(() => {
    if (!job) return;
    let canceled = false;
    void window.office
      .appliedReports({ jobId: job.id, limit: 20 })
      .then(page => {
        if (!canceled) setReport(page.entries.at(-1));
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [job?.id, job?.revision, state]);
  const applied = report?.applied;
  const appliedMismatch = Boolean(
    applied &&
    ((applied.model !== undefined && applied.model !== assignment.requestedModel) ||
      (applied.effort !== undefined && applied.effort !== assignment.requestedEffort)),
  );
  return (
    <article className="assignment-row">
      <strong>{request?.name ?? 'Request'}</strong>
      <p className="muted">
        {assignment.requestedModel} · requested effort {assignment.requestedEffort} · applied{' '}
        {assignment.appliedEffort.toLowerCase()}
      </p>
      {report && <p className="muted">{report.text}</p>}
      {appliedMismatch && (
        <p className="blocker">
          The session's self-reported applied values differ from the requested model/effort — self-reported, not
          office-verified.
        </p>
      )}
      <p>
        {job
          ? `${job.state.replaceAll('_', ' ').toLowerCase()}${job.externalId ? ` · ${job.externalId}` : ''}`
          : 'No job record'}
      </p>
      {job?.detail && <p className="muted">{job.detail}</p>}
    </article>
  );
}

const tabs = ['Profile', 'Assignments', 'Conversation', 'Logs'] as const;
type Tab = (typeof tabs)[number];

/**
 * One profile, four views: who they are, what work they hold, what was said to them, and the
 * imported record. Assignments and conversation come from real records, never from a status guess.
 */
export function ProfileTabs({
  agent,
  state,
  children,
  onState: _onState,
}: {
  agent: Agent;
  state: AppState;
  children: React.ReactNode;
  onState: (state: AppState) => void;
}) {
  const [tab, setTab] = useState<Tab>('Profile');
  const [logs, setLogs] = useState<WorkLog[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const eventGeneration = useRef(0);
  const [error, setError] = useState('');
  const assignments = (state.assignments ?? []).filter(item => item.agentId === agent.id);
  const jobs = (state.jobs ?? []).filter(job => assignments.some(item => item.id === job.assignmentId));
  const [selectedJobId, setSelectedJobId] = useState('');
  const selectedJob = jobs.find(j => j.id === selectedJobId) ?? jobs.at(-1);
  const gate = agentDispatchReadiness(
    state,
    agent,
    agent.execution === 'LOCAL' ? {} : { route: 'OFFICIAL_TERMINAL_HANDOFF' },
  );
  useEffect(() => {
    if (tab !== 'Logs') return;
    let cancelled = false;
    void window.office
      .logPage({ agentId: agent.id, limit: 50 })
      .then(page => {
        if (!cancelled) {
          setLogs(page.entries);
          setCursor(page.nextCursor);
        }
      })
      .catch(e => setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [tab, agent.id]);
  useEffect(() => {
    eventGeneration.current++;
    setEvents([]);
    setEventCursor(null);
    if (tab !== 'Assignments' || !selectedJob) return;
    let cancelled = false;
    setEventsLoading(true);
    void window.office
      .jobEventPage({ jobId: selectedJob!.id, limit: 50 })
      .then(page => {
        if (!cancelled) {
          setEvents(page.entries);
          setEventCursor(page.nextCursor);
        }
      })
      .catch(e => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false);
      });
    return () => {
      cancelled = true;
      eventGeneration.current++;
    };
  }, [tab, selectedJob?.id, selectedJob?.revision]);
  return (
    <div className="profile-tabs">
      <div className="tab-row" role="tablist">
        {tabs.map(name => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={`tab ${tab === name ? 'active' : ''}`}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {tab === 'Profile' && <div className="tab-panel">{children}</div>}
      {tab === 'Assignments' && (
        <div className="tab-panel">
          {jobs.length > 0 && (
            <label>
              Assignment event scope
              <select
                aria-label="Assignment event scope"
                value={selectedJob?.id ?? ''}
                onChange={e => setSelectedJobId(e.target.value)}
              >
                {jobs.map(job => (
                  <option key={job.id} value={job.id}>
                    {job.assignmentId.slice(0, 8)} · {job.state}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="muted">
            {assignments.length} assignment{assignments.length === 1 ? '' : 's'} · dispatch{' '}
            {gate.canStart ? 'available' : 'blocked'}
          </p>
          {!assignments.length && <p>No work has been frozen for this profile yet.</p>}
          {assignments.map(assignment => (
            <AssignmentRow
              key={assignment.id}
              assignment={assignment}
              state={state}
              job={jobs.find(item => item.assignmentId === assignment.id)}
              request={(state.requests ?? []).find(item => item.id === assignment.requestId)}
            />
          ))}
          {events.length > 0 && (
            <details>
              <summary>Provider events ({events.length}, oldest first)</summary>
              <ul className="evidence-list">
                {events.map(event => (
                  <li key={event.id}>
                    {formatDateTime(event.occurredAt)} — {event.text}
                  </li>
                ))}
              </ul>
              {eventCursor && selectedJob && (
                <button
                  disabled={eventsLoading}
                  onClick={() => {
                    const jobId = selectedJob.id;
                    const generation = eventGeneration.current;
                    setEventsLoading(true);
                    void window.office
                      .jobEventPage({ jobId, limit: 50, cursor: eventCursor })
                      .then(page => {
                        if (eventGeneration.current !== generation) return;
                        setEvents(current => [
                          ...current,
                          ...page.entries.filter(entry => !current.some(old => old.id === entry.id)),
                        ]);
                        setEventCursor(page.nextCursor);
                      })
                      .catch(e => {
                        if (eventGeneration.current === generation) setError((e as Error).message);
                      })
                      .finally(() => {
                        if (eventGeneration.current === generation) setEventsLoading(false);
                      });
                  }}
                >
                  More provider events
                </button>
              )}
            </details>
          )}
        </div>
      )}
      {tab === 'Conversation' && (
        <div className="tab-panel profile-conversation">
          <OfficeChat key={agent.id} state={state} initialAgentId={agent.id} />
        </div>
      )}
      {tab === 'Logs' && (
        <div className="tab-panel">
          {!logs.length && <p>No imported conversation for this profile.</p>}
          <ul className="evidence-list">
            {logs.map(log => (
              <li key={log.id}>
                <b>{formatDateTime(log.timestamp)}</b> — {log.text.slice(0, 400)}
              </li>
            ))}
          </ul>
          {cursor && (
            <button
              className="secondary"
              onClick={() =>
                void window.office.logPage({ agentId: agent.id, limit: 50, cursor }).then(page => {
                  setLogs(current => [...current, ...page.entries]);
                  setCursor(page.nextCursor);
                })
              }
            >
              Load more
            </button>
          )}
          <p className="muted">Imported records are historical evidence. They never drive live office activity.</p>
        </div>
      )}
    </div>
  );
}
