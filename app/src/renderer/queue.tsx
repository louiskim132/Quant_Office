import { useEffect, useState } from 'react';
import { ChevronRight, ListTodo, Search } from 'lucide-react';
import type { AppState, Experiment, Command, Request } from '../shared/types';
import { queueScope, type QueueEntry, type QueueFilter } from '../shared/queue';
import { summarizeRequest, type RequestBucket, type RequestSummary } from '../shared/request-summary';
import { Avatar, Drawer, Empty, StatusPill } from './components';
import { timeAgo, type StatusKey } from './status';
import { RequestDispatch } from './dispatch';
import { PipelineCard } from './pipeline-card';
import './queue.css';
import './office.css';

const GROUPS: { key: RequestBucket; title: string; hint: string }[] = [
  { key: 'needs', title: 'Needs you', hint: 'The next move is yours' },
  { key: 'running', title: 'Running', hint: 'Agents are working' },
  { key: 'queued', title: 'Drafts & waiting', hint: 'Not started, or between steps' },
  { key: 'done', title: 'Done', hint: 'Finished with a recorded outcome' },
  { key: 'canceled', title: 'Canceled', hint: 'Kept for the record' },
];
const BUCKET_STATUS: Record<RequestBucket, StatusKey> = {
  needs: 'needs',
  running: 'working',
  queued: 'idle',
  done: 'done',
  canceled: 'idle',
};
const DONE_SHOWN = 8;

export function WorkQueue({
  state,
  busy,
  onNew,
  onOpen,
  onCancel,
  onAction,
  onState,
  openRequestId,
  onOpenRequest,
  watchedJobIds,
}: {
  state: AppState;
  onAction: (command: Command) => void;
  busy: boolean;
  onNew: () => void;
  onOpen: (e: Experiment) => void;
  onCancel: (id: string) => void;
  onState: (s: AppState) => void;
  /** The request whose detail panel is open — owned by the app so other surfaces can open it too. */
  openRequestId: string | null;
  onOpenRequest: (id: string | null) => void;
  /** Jobs the office watches a process for (presence); see summarizeRequest. */
  watchedJobIds?: ReadonlySet<string>;
}) {
  const [scopeProject, setScopeProject] = useState('');
  const [scopeAgent, setScopeAgent] = useState('');
  const [scopeTeam, setScopeTeam] = useState('');
  const [search, setSearch] = useState('');
  const [only, setOnly] = useState<RequestBucket | ''>('');
  const [showAllDone, setShowAllDone] = useState(false);
  const queueFilter: QueueFilter = {
    lifecycle: 'ALL',
    ...(scopeProject ? { projectId: scopeProject } : {}),
    ...(scopeAgent ? { agentId: scopeAgent } : {}),
    ...(scopeTeam ? { teamId: scopeTeam } : {}),
    ...(search ? { search } : {}),
  };
  const scope = queueScope(state, queueFilter);
  const rows = scope.entries.map(entry => ({ entry, summary: summarizeRequest(state, entry, watchedJobIds) }));
  const byBucket = (key: RequestBucket) =>
    rows.filter(r => r.summary.bucket === key).sort((a, b) => b.summary.lastAt.localeCompare(a.summary.lastAt));
  const counts = Object.fromEntries(GROUPS.map(g => [g.key, byBucket(g.key).length])) as Record<RequestBucket, number>;
  const open = openRequestId ? rows.find(r => r.entry.id === openRequestId) : undefined;
  // A request that no longer exists must not leave a stale panel behind.
  useEffect(() => {
    if (openRequestId && !(state.requests ?? []).some(r => r.id === openRequestId)) onOpenRequest(null);
  }, [openRequestId, state.requests]);
  return (
    <section className="work-queue">
      <div className="section-toolbar">
        <div>
          <h2>Requests</h2>
          <p className="muted">
            {scope.counts.all === 0
              ? 'Nothing yet. A request is a question for the team.'
              : `${counts.needs ? counts.needs + ' need you · ' : ''}${counts.running} running · ${counts.done} done`}
          </p>
        </div>
        <button className="primary" onClick={onNew}>
          New request
        </button>
      </div>
      <div className="queue-tools">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="Search requests"
            placeholder="Search requests or agents"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </label>
        <select aria-label="Project" value={scopeProject} onChange={e => setScopeProject(e.target.value)}>
          <option value="">All projects</option>
          {state.projects.map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select aria-label="Agent" value={scopeAgent} onChange={e => setScopeAgent(e.target.value)}>
          <option value="">Any agent</option>
          {state.agents
            .filter(a => !a.removedAt)
            .map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        {!!(state.teams ?? []).length && (
          <select aria-label="Team" value={scopeTeam} onChange={e => setScopeTeam(e.target.value)}>
            <option value="">Any team</option>
            {(state.teams ?? []).map(team => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        )}
        <div className="queue-chips" role="group" aria-label="Show">
          <button className={only === '' ? 'on' : ''} aria-pressed={only === ''} onClick={() => setOnly('')}>
            All {scope.counts.all}
          </button>
          {GROUPS.filter(g => counts[g.key] > 0).map(g => (
            <button
              key={g.key}
              className={only === g.key ? 'on' : ''}
              aria-pressed={only === g.key}
              onClick={() => setOnly(g.key)}
            >
              {g.title} {counts[g.key]}
            </button>
          ))}
        </div>
      </div>
      {!rows.length && (
        <Empty
          icon={ListTodo}
          title={scope.counts.all ? 'No requests match these filters' : 'No requests yet'}
          description={
            scope.counts.all
              ? 'Clear the search or the project and agent filters to see them again.'
              : 'Create a request to start an investigation.'
          }
        />
      )}
      {GROUPS.filter(g => (!only || only === g.key) && counts[g.key] > 0).map(g => {
        const list = byBucket(g.key);
        const collapsed = g.key === 'canceled' && !only;
        const shown = g.key === 'done' && !showAllDone && !only ? list.slice(0, DONE_SHOWN) : list;
        return (
          <details className="queue-group" key={g.key} open={!collapsed} data-bucket={g.key}>
            <summary>
              <h3>{g.title}</h3>
              <span className="chip">{list.length}</span>
              <span className="muted">{g.hint}</span>
            </summary>
            <ul className="queue-list">
              {shown.map(({ entry, summary }) => (
                <QueueRow
                  key={entry.id}
                  entry={entry}
                  summary={summary}
                  state={state}
                  selected={openRequestId === entry.id}
                  onOpen={() => onOpenRequest(entry.id)}
                />
              ))}
            </ul>
            {shown.length < list.length && (
              <button className="text-button" onClick={() => setShowAllDone(true)}>
                Show all {list.length} finished requests
              </button>
            )}
          </details>
        );
      })}
      {open && (
        <RequestDetail
          key={open.entry.id}
          entry={open.entry}
          summary={open.summary}
          state={state}
          busy={busy}
          onClose={() => onOpenRequest(null)}
          onOpen={onOpen}
          onCancel={onCancel}
          onAction={onAction}
          onState={onState}
        />
      )}
    </section>
  );
}

/** Filled dots for finished steps. The count is also in the accessible name. */
function Stepper({ done, total }: { done: number; total: number }) {
  if (!total) return <span className="stepper muted">No steps yet</span>;
  return (
    <span className="stepper" role="img" aria-label={`${done} of ${total} steps done`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < done ? 'on' : ''} />
      ))}
      <b>
        {done}/{total}
      </b>
    </span>
  );
}

function QueueRow({
  entry,
  summary,
  state,
  selected,
  onOpen,
}: {
  entry: QueueEntry;
  summary: RequestSummary;
  state: AppState;
  selected: boolean;
  onOpen: () => void;
}) {
  const project = state.projects.find(p => p.id === entry.root.projectId);
  const name =
    entry.request?.name ?? state.experiments.find(e => e.id === entry.root.experimentId)?.name ?? 'Research request';
  const kind = entry.request?.pipeline
    ? entry.request.pipeline.kind === 'PLANNING'
      ? 'Planning'
      : 'Result analysis'
    : entry.request
      ? entry.request.workType.toLowerCase().replaceAll('_', ' ')
      : 'Legacy task';
  const agents = summary.runningAgentIds.map(id => state.agents.find(a => a.id === id)).filter(Boolean);
  return (
    <li>
      <button
        className={`queue-row${selected ? ' selected' : ''}`}
        data-bucket={summary.bucket}
        onClick={onOpen}
        aria-label={`${name}. ${summary.label}. Open details`}
      >
        <span className="queue-main">
          <strong>{name}</strong>
          <span className="muted">
            {project?.name ?? 'Project'} · {kind}
          </span>
        </span>
        <span className="queue-status">
          <StatusPill status={BUCKET_STATUS[summary.bucket]} label={summary.label} />
          {summary.reason && <span className="muted queue-reason">{summary.reason}</span>}
        </span>
        <Stepper {...summary.steps} />
        <span className="queue-agents">
          {agents.slice(0, 3).map(a => (
            <Avatar key={a!.id} id={a!.id} name={a!.name} size={22} status="working" />
          ))}
        </span>
        <span className="muted queue-time">{timeAgo(summary.lastAt)}</span>
        <ChevronRight size={16} />
      </button>
    </li>
  );
}

function RequestDetail({
  entry,
  summary,
  state,
  busy,
  onClose,
  onOpen,
  onCancel,
  onAction,
  onState,
}: {
  entry: QueueEntry;
  summary: RequestSummary;
  state: AppState;
  busy: boolean;
  onClose: () => void;
  onOpen: (e: Experiment) => void;
  onCancel: (id: string) => void;
  onAction: (c: Command) => void;
  onState: (s: AppState) => void;
}) {
  const { root } = entry,
    exp = state.experiments.find(e => e.id === root.experimentId),
    project = state.projects.find(p => p.id === root.projectId),
    canceled = entry.status === 'CANCELED',
    request = entry.request;
  const jobs = entry.jobs ?? [],
    focusJob = jobs.find(item => item.unresolved) ?? jobs.at(-1);
  const jobText = focusJob
    ? `Provider job: ${focusJob.state.toLowerCase().replaceAll('_', ' ')}${jobs.length > 1 ? ` · ${jobs.length} on record` : ''}${focusJob.unresolved ? ' — needs reconciliation' : ''}`
    : 'No provider job submitted';
  const assignmentIds = new Set(
    (state.assignments ?? []).filter(item => item.requestId === root.id).map(item => item.id),
  );
  const reviewRecords =
    (state.decisions ?? []).filter(item => item.requestId === root.id).length +
    (request?.experimentId ? state.reviews.filter(item => item.experimentId === request.experimentId).length : 0) +
    (state.sealed ?? []).filter(item => item.subjectAssignmentId && assignmentIds.has(item.subjectAssignmentId)).length;
  const reviewText = reviewRecords
    ? `Independent review: ${reviewRecords} record${reviewRecords === 1 ? '' : 's'} on file`
    : 'No independent review';
  const name = request?.name ?? exp?.name ?? 'Research request';
  // Actions appear only where they can apply: no Start on a started request, no Cancel on a finished one.
  const canStart = !!request && request.status === 'DRAFT' && entry.canCancel;
  const canCancel = entry.canCancel && summary.bucket !== 'done';
  return (
    <Drawer
      wide
      label={`Request: ${name}`}
      onClose={onClose}
      head={
        <>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2>{name}</h2>
            <span className="muted">{project?.name}</span>
          </div>
          <StatusPill status={BUCKET_STATUS[summary.bucket]} label={summary.label} />
        </>
      }
    >
      <article className="task-card">
        {summary.reason && <p className="blocker">{summary.reason}</p>}
        <p className="task-prompt">{root.prompt}</p>
        {request?.pipeline && <PipelineCard request={request} state={state} busy={busy} onAction={onAction} />}
        {!canceled && root.blocker && <p className="blocker">{root.blocker}</p>}
        {request && (
          <>
            {request.blockers.map(b => (
              <p className="blocker" key={b.code + b.message}>
                {b.message} {b.action}.
              </p>
            ))}
            <details>
              <summary>Participants and acceptance criteria</summary>
              <p>
                {[...new Set([request.leadAgentId, ...request.participantIds])]
                  .filter(Boolean)
                  .map(id => state.agents.find(a => a.id === id)?.name ?? id)
                  .join(', ') || 'None selected'}
              </p>
              <p>{request.acceptanceCriteria || 'No criteria recorded.'}</p>
              {entry.canCancel && summary.bucket !== 'done' && (
                <>
                  <RequestEditor
                    key={entry.id + ':' + request.revision}
                    request={request}
                    state={state}
                    busy={busy}
                    onAction={onAction}
                  />
                  <RequestDispatch key={entry.id + ':dispatch'} request={request} state={state} onState={onState} />
                </>
              )}
              <p>
                {request.delegation ? 'Collaboration requested' : 'Automatic delegation disabled'} · {jobText} ·{' '}
                {reviewText}
              </p>
            </details>
          </>
        )}
        {request && !entry.canCancel && entry.actions?.awaitingReconciliation && (
          <RequestDispatch key={entry.id + ':dispatch'} request={request} state={state} onState={onState} />
        )}
        {request && canceled && !entry.deletable && (
          <p className="muted remove-note">
            Remove stays unavailable while a provider job outcome is unresolved — reconcile the provider outcome first.
            The record and its history are retained either way.
          </p>
        )}
        <div className="button-row task-actions">
          {canStart && (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                onAction({
                  type: 'request.start',
                  requestId: entry.id,
                  expectedRevision: request!.revision,
                  idempotencyKey: crypto.randomUUID(),
                })
              }
            >
              Start request
            </button>
          )}
          {request && (
            <button
              className="secondary"
              disabled={busy || project?.archived}
              onClick={() =>
                onAction({
                  type: 'request.duplicate',
                  requestId: entry.id,
                  expectedRevision: request.revision,
                  idempotencyKey: crypto.randomUUID(),
                })
              }
            >
              Use as new request
            </button>
          )}
          {exp && (
            <button className="secondary" onClick={() => onOpen(exp)}>
              {canceled ? 'View research details' : 'Open research details'}
            </button>
          )}
          {canCancel && !request?.pipeline && (
            <button
              className="cancel-request"
              disabled={busy || project?.archived}
              onClick={() =>
                request
                  ? onAction({
                      type: 'request.cancel',
                      requestId: entry.id,
                      expectedRevision: request.revision,
                      idempotencyKey: crypto.randomUUID(),
                    })
                  : onCancel(entry.id)
              }
            >
              Cancel request
            </button>
          )}
          {entry.deletable && (
            <button
              className="cancel-request"
              disabled={busy}
              onClick={() =>
                onAction({
                  type: 'task.delete',
                  idempotencyKey: crypto.randomUUID(),
                  taskId: root.id,
                  ...(request ? { expectedRevision: request.revision } : {}),
                })
              }
            >
              Remove
            </button>
          )}
        </div>
      </article>
    </Drawer>
  );
}

function RequestEditor({
  request,
  state,
  busy,
  onAction,
}: {
  request: Request;
  state: AppState;
  busy: boolean;
  onAction: (c: Command) => void;
}) {
  return (
    <form
      className="request-editor"
      onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onAction({
          type: 'request.update',
          idempotencyKey: crypto.randomUUID(),
          requestId: request.id,
          expectedRevision: request.revision,
          objective: String(f.get('objective')),
          leadAgentId: String(f.get('leadAgentId')) || null,
          participantIds: f.getAll('participantIds').map(String),
          acceptanceCriteria: String(f.get('acceptanceCriteria')),
        });
      }}
    >
      <fieldset disabled={busy}>
        <label className="field">
          Objective
          <textarea name="objective" defaultValue={request.objective} required maxLength={12000} />
        </label>
        <label className="field">
          Responsible agent
          <select name="leadAgentId" defaultValue={request.leadAgentId ?? ''}>
            <option value="">Choose an agent</option>
            {state.agents
              .filter(a => !a.removedAt)
              .map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        {request.mode !== 'SINGLE' && (
          <label className="field">
            Collaborators
            <select multiple name="participantIds" defaultValue={request.participantIds}>
              {state.agents
                .filter(a => !a.removedAt)
                .map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field">
          Acceptance criteria
          <textarea name="acceptanceCriteria" defaultValue={request.acceptanceCriteria} maxLength={12000} />
        </label>
        <button className="secondary">Save request revision</button>
      </fieldset>
    </form>
  );
}
