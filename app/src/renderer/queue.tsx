import { useEffect, useState } from 'react';
import { ChevronRight, ListTodo, Search } from 'lucide-react';
import type { AppState, Experiment, Command, JobEvidence, Request } from '../shared/types';
import { isTerminalJob, latestJobFor } from '../core/jobs';
import { queueScope, type QueueEntry, type QueueFilter } from '../shared/queue';
import { summarizeRequest, type RequestBucket, type RequestSummary } from '../shared/request-summary';
import { Avatar, Drawer, Empty, StatusPill } from './components';
import { formatDateTime } from './format';
import { timeAgo, type StatusKey } from './status';
import { RequestDispatch } from './dispatch';
import { PipelineCard } from './pipeline-card';
import './queue.css';
import './office.css';

/**
 * Attention classes for the work queue — a reordering of the recorded request buckets, never a new
 * state. `summarizeRequest` remains the source of truth: `needs` splits into work the user must fix
 * (`needs`) and work waiting on a user decision (`awaiting`), `queued` reads as `drafts`, and
 * `done`/`canceled` settle together last.
 */
export type AttentionGroup = 'needs' | 'awaiting' | 'running' | 'drafts' | 'settled';
export const ATTENTION_GROUPS: { key: AttentionGroup; title: string; hint: string }[] = [
  { key: 'needs', title: 'Needs you', hint: 'Failed or blocked — the next move is yours' },
  { key: 'awaiting', title: 'Awaiting your decision', hint: 'Work is recorded; you decide what happens next' },
  { key: 'running', title: 'Running', hint: 'Agents are working' },
  { key: 'drafts', title: 'Drafts & waiting', hint: 'Not started, or between steps' },
  { key: 'settled', title: 'Done & canceled', hint: 'Finished with a recorded outcome' },
];
/** The summarizeRequest labels that mean "review the product and decide", not "fix something". */
const DECISION_LABELS = new Set(['Decision needed', 'Brief ready']);

export function attentionGroupOf(summary: Pick<RequestSummary, 'bucket' | 'label'>): AttentionGroup {
  if (summary.bucket === 'needs') return DECISION_LABELS.has(summary.label) ? 'awaiting' : 'needs';
  if (summary.bucket === 'running') return 'running';
  if (summary.bucket === 'queued') return 'drafts';
  return 'settled';
}

export interface QueueRowData {
  entry: QueueEntry;
  summary: RequestSummary;
}
/** Groups rows by attention class in fixed order, newest recorded activity first inside a group. */
export function groupByAttention(rows: QueueRowData[]): { key: AttentionGroup; rows: QueueRowData[] }[] {
  const grouped = new Map<AttentionGroup, QueueRowData[]>();
  for (const row of rows) {
    const key = attentionGroupOf(row.summary);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return ATTENTION_GROUPS.map(g => ({
    key: g.key,
    rows: (grouped.get(g.key) ?? []).sort((a, b) => b.summary.lastAt.localeCompare(a.summary.lastAt)),
  })).filter(g => g.rows.length > 0);
}

const BUCKET_STATUS: Record<RequestBucket, StatusKey> = {
  needs: 'needs',
  running: 'working',
  queued: 'idle',
  done: 'done',
  canceled: 'idle',
};
const DONE_SHOWN = 8;

/** Who recorded the event — the office itself, the provider's own report, or a user's import. */
export type TimelineProvenance = 'office-observed' | 'provider-reported' | 'user-reported';
export interface QueueTimelineEvent {
  at: string;
  label: string;
  provenance: TimelineProvenance;
}

const provenanceOf = (evidence: JobEvidence | undefined): TimelineProvenance =>
  evidence === 'PROVIDER_REPORTED'
    ? 'provider-reported'
    : evidence === 'USER_REPORTED'
      ? 'user-reported'
      : 'office-observed';

const jobStateText = (state: string) => state.toLowerCase().replaceAll('_', ' ');

/**
 * The recorded lifecycle of one request — minted → hop minted → dispatched → observed/receipted →
 * settled/failed — assembled only from assignment, job and localSession rows already on the state.
 * Every event carries who said it; a hop with no job on record appears minted and nothing more.
 */
export function requestTimeline(
  state: Pick<AppState, 'assignments' | 'jobs' | 'localSessions' | 'agents'>,
  entry: QueueEntry,
): QueueTimelineEvent[] {
  const events: QueueTimelineEvent[] = [];
  const minted = entry.request?.createdAt ?? entry.root.createdAt;
  if (minted) events.push({ at: minted, label: 'Request minted', provenance: 'office-observed' });
  const agentName = (id: string) => state.agents?.find(a => a.id === id)?.name ?? 'assigned agent';
  const all = (state.assignments ?? []).filter(a => a.requestId === entry.id);
  const hops = all.filter(a => a.pipelineKey);
  const scoped = (hops.length ? hops : all)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const a of scoped) {
    const name = `${agentName(a.agentId)}${a.pipelineKey ? ` · ${a.pipelineKey}` : ''}`;
    const job = latestJobFor(state.jobs, a.id);
    if (!job) {
      events.push({
        at: a.createdAt,
        label: `Hop minted for ${name} — no provider job on record`,
        provenance: 'office-observed',
      });
      continue;
    }
    const attempt = job.attempt ?? 1;
    const suffix = attempt > 1 ? ` (attempt ${attempt})` : '';
    events.push({ at: a.createdAt, label: `Hop minted for ${name}`, provenance: 'office-observed' });
    if (job.dispatchedAt)
      events.push({ at: job.dispatchedAt, label: `Dispatched to ${name}${suffix}`, provenance: 'office-observed' });
    else if (job.createdAt)
      events.push({
        at: job.createdAt,
        label: `Job record opened for ${name}${suffix}`,
        provenance: 'office-observed',
      });
    const session = (state.localSessions ?? []).find(s => s.jobId === job.id);
    if (session?.lastReceipt)
      events.push({
        at: session.lastReceipt.observedAt,
        label: `Receipt ${session.lastReceipt.sequence} verified`,
        provenance: 'office-observed',
      });
    if (isTerminalJob(job.state) && job.settledAt)
      events.push({
        at: job.settledAt,
        label: `Settled — ${jobStateText(job.state)}`,
        provenance: provenanceOf(job.evidence),
      });
    else if (job.updatedAt)
      events.push({
        at: job.updatedAt,
        label: `Observed — ${jobStateText(job.state)}`,
        provenance: provenanceOf(job.evidence),
      });
  }
  return events.sort((x, y) => x.at.localeCompare(y.at) || x.label.localeCompare(y.label));
}

/** Per-request "seen" marks kept renderer-locally in localStorage — no store schema, no IPC. */
const SEEN_KEY = 'qro.workQueue.seen.v1';
interface SeenStore {
  /** When the queue was last open — the baseline for rows the user never opened. */
  lastView: string;
  /** When each request's detail was last opened. */
  seen: Record<string, string>;
}
function loadSeenStore(): SeenStore {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.lastView === 'string' && parsed.seen && typeof parsed.seen === 'object')
        return { lastView: parsed.lastView, seen: parsed.seen as Record<string, string> };
    }
  } catch {
    /* storage can be unavailable or corrupted — falling back to a fresh store is honest */
  }
  return { lastView: '', seen: {} };
}
function writeSeenStore(store: SeenStore) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(store));
  } catch {
    /* best-effort marker only — a failed write loses nothing recorded elsewhere */
  }
}

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
  const [only, setOnly] = useState<AttentionGroup | ''>('');
  const [showAllDone, setShowAllDone] = useState(false);
  // Last-look baseline: the previous visit's timestamp, plus per-request opens recorded this session.
  const [store] = useState(loadSeenStore);
  const [seen, setSeen] = useState(store.seen);
  const [mountAt] = useState(() => new Date().toISOString());
  const lastView = store.lastView || mountAt;
  useEffect(() => {
    // Advance the baseline once per mount so a stale view never marks everything forever.
    writeSeenStore({ lastView: new Date().toISOString(), seen });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const markSeen = (id: string) =>
    setSeen(prev => {
      const at = new Date().toISOString();
      const next = { ...prev, [id]: at };
      writeSeenStore({ lastView: at, seen: next });
      return next;
    });
  const queueFilter: QueueFilter = {
    lifecycle: 'ALL',
    ...(scopeProject ? { projectId: scopeProject } : {}),
    ...(scopeAgent ? { agentId: scopeAgent } : {}),
    ...(scopeTeam ? { teamId: scopeTeam } : {}),
    ...(search ? { search } : {}),
  };
  const scope = queueScope(state, queueFilter);
  const rows = scope.entries.map(entry => ({ entry, summary: summarizeRequest(state, entry, watchedJobIds) }));
  const groups = groupByAttention(rows);
  // The header count line stays on the recorded buckets: everything that needs the user is `needs`.
  const bucketCounts = Object.fromEntries(
    (['needs', 'running', 'done'] as RequestBucket[]).map(key => [
      key,
      rows.filter(r => r.summary.bucket === key).length,
    ]),
  ) as Record<'needs' | 'running' | 'done', number>;
  const isNew = (row: QueueRowData) => row.summary.lastAt > (seen[row.entry.id] ?? lastView);
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
              : `${bucketCounts.needs ? bucketCounts.needs + ' need you · ' : ''}${bucketCounts.running} running · ${bucketCounts.done} done`}
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
          {groups.map(g => (
            <button
              key={g.key}
              className={only === g.key ? 'on' : ''}
              aria-pressed={only === g.key}
              onClick={() => setOnly(g.key)}
            >
              {ATTENTION_GROUPS.find(x => x.key === g.key)!.title} {g.rows.length}
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
      {groups
        .filter(g => !only || only === g.key)
        .map(g => {
          const info = ATTENTION_GROUPS.find(x => x.key === g.key)!;
          const shown = g.key === 'settled' && !showAllDone && !only ? g.rows.slice(0, DONE_SHOWN) : g.rows;
          return (
            <details className="queue-group" key={g.key} open data-bucket={g.key}>
              <summary>
                <h3>{info.title}</h3>
                <span className="chip">{g.rows.length}</span>
                <span className="muted">{info.hint}</span>
              </summary>
              <ul className="queue-list">
                {shown.map(row => (
                  <QueueRow
                    key={row.entry.id}
                    entry={row.entry}
                    summary={row.summary}
                    state={state}
                    fresh={isNew(row)}
                    selected={openRequestId === row.entry.id}
                    onOpen={() => {
                      markSeen(row.entry.id);
                      onOpenRequest(row.entry.id);
                    }}
                  />
                ))}
              </ul>
              {shown.length < g.rows.length && (
                <button className="text-button" onClick={() => setShowAllDone(true)}>
                  Show all {g.rows.length} finished requests
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
  fresh,
  selected,
  onOpen,
}: {
  entry: QueueEntry;
  summary: RequestSummary;
  state: AppState;
  /** Updated since the user last looked — a renderer-local mark, not a record claim. */
  fresh: boolean;
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
  const jobs = entry.jobs ?? [];
  const focusJob = jobs.find(j => j.unresolved) ?? jobs.at(-1);
  const jobLine = focusJob
    ? `Provider job: ${jobStateText(focusJob.state)}${jobs.length > 1 ? ` · ${jobs.length} on record` : ''}`
    : 'No provider job';
  return (
    <li>
      <button
        className={`queue-row${selected ? ' selected' : ''}`}
        data-bucket={attentionGroupOf(summary)}
        onClick={onOpen}
        aria-label={`${name}. ${summary.label}. Open details`}
      >
        <span className="queue-main">
          <strong>
            {name}
            {fresh && (
              <span className="queue-new" title="Recorded activity since you last looked at this request">
                New
              </span>
            )}
          </strong>
          <span className="muted">
            {project?.name ?? 'Project'} · {kind}
          </span>
        </span>
        <span className="queue-status">
          <StatusPill status={BUCKET_STATUS[summary.bucket]} label={summary.label} />
        </span>
        <Stepper {...summary.steps} />
        <span className="queue-agents">
          {agents.slice(0, 3).map(a => (
            <Avatar key={a!.id} id={a!.id} name={a!.name} size={22} status="working" />
          ))}
        </span>
        <ChevronRight size={16} />
        <span className="queue-sub muted">
          {summary.reason ? `${summary.reason} · ` : ''}
          {jobLine} · {timeAgo(summary.lastAt)}
        </span>
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
        <JobTimeline state={state} entry={entry} />
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

/** The recorded lifecycle of the request — each event tagged by who recorded it. */
function JobTimeline({ state, entry }: { state: AppState; entry: QueueEntry }) {
  const events = requestTimeline(state, entry);
  return (
    <details className="job-timeline" open>
      <summary>
        Job timeline — {events.length} recorded event{events.length === 1 ? '' : 's'}
      </summary>
      <ol className="timeline">
        {events.map(ev => (
          <li key={`${ev.at}|${ev.label}`}>
            <time className="muted">{formatDateTime(ev.at)}</time>
            <span className="tl-label">{ev.label}</span>
            <span className="tl-prov" data-prov={ev.provenance}>
              {ev.provenance}
            </span>
          </li>
        ))}
      </ol>
    </details>
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
