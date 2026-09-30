import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  LockKeyhole,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import type { AppState, Command, Experiment, Project, Request, ResearchContract } from '../shared/types';
import { requestQueue } from '../shared/queue';
import { summarizeRequest } from '../shared/request-summary';
import { ResearchPipeline } from './pipeline';
import { ProjectLocationPanel } from './projects';
import { label, Avatar } from './components';
import { timeAgo } from './status';
import { useLivePresence, watchedJobs } from './use-activity';
import './research.css';

type CommandInput = Command extends infer C ? (C extends Command ? Omit<C, 'idempotencyKey'> : never) : never;
const date = (d: string) =>
  new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const contractFields: [keyof ResearchContract, string, string][] = [
  [
    'objective',
    'Research objective',
    'What question will this experiment answer? Define the target and output meaning.',
  ],
  [
    'dataPolicy',
    'Data & leakage policy',
    'Data sources, time splits, availability, leakage controls, and permitted use.',
  ],
  ['modelFamilies', 'Model families', 'Candidate methods, baselines, and the comparison you want to make.'],
  ['evaluation', 'Evaluation protocol', 'Metrics, validation design, holdouts, and success / failure criteria.'],
  ['economics', 'Economic assumptions', 'Costs, slippage, capacity, exposures, and any economic constraints.'],
  ['protectedRegions', 'Protected regions', 'Untouched data, protected code, and boundaries requiring an amendment.'],
  ['requiredChecks', 'Required checks', 'Required evidence, reproducibility checks, and falsification tests.'],
  [
    'limitations',
    'Limitations & open questions',
    'Known uncertainty, missing inputs, assumptions, and unresolved decisions.',
  ],
];

/** Seed empty contract sections from the request that created the experiment; never overwrites. */
function seedDraft(draft: ResearchContract, experiment: Experiment, request: Request | undefined): ResearchContract {
  const seeded = { ...draft };
  if (!seeded.objective.trim()) seeded.objective = experiment.hypothesis;
  if (!seeded.requiredChecks.trim() && request?.acceptanceCriteria?.trim())
    seeded.requiredChecks = request.acceptanceCriteria;
  return seeded;
}

interface ContractDraft {
  draft: ResearchContract;
  revision: number;
  saved: string;
}
const contractDrafts = new Map<string, ContractDraft>();
function readContractDraft(experiment: Experiment): ContractDraft {
  const memory = contractDrafts.get(experiment.id);
  if (memory) return memory;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`quant-contract-draft:${experiment.id}`) || 'null');
    if (stored && typeof stored === 'object') {
      const entry = stored as ContractDraft;
      if (
        Number.isSafeInteger(entry.revision) &&
        entry.revision >= 0 &&
        typeof entry.saved === 'string' &&
        entry.draft &&
        contractFields.every(([key]) => typeof entry.draft[key] === 'string' && entry.draft[key].length <= 12000)
      )
        return entry;
    }
  } catch {}
  return {
    draft: { ...experiment.contract },
    revision: experiment.revision,
    saved: JSON.stringify(experiment.contract),
  };
}

export function ResearchView({
  state,
  project,
  projectId,
  experiments,
  experiment,
  experimentId,
  busy,
  command,
  onState,
  onSelectExperiment,
  onBack,
  onEditProject,
  onNewRequest,
  onOpenQueue,
  onPage,
}: {
  state: AppState;
  project: Project;
  projectId: string;
  experiments: Experiment[];
  experiment: Experiment | undefined;
  experimentId: string;
  busy: boolean;
  command: (c: CommandInput, n?: string) => Promise<AppState | null>;
  onState: (s: AppState) => void;
  onSelectExperiment: (id: string) => void;
  onBack: () => void;
  onEditProject: () => void;
  onNewRequest: () => void;
  onOpenQueue: (requestId?: string) => void;
  onPage: (page: 'Memory' | 'Artifacts' | 'Reviews') => void;
}) {
  const requests = (state.requests ?? []).filter(r => r.projectId === projectId && !r.removedAt);
  const findings = (state.findings ?? []).filter(f => f.projectId === projectId && !f.supersededById);
  const involved = new Set((state.assignments ?? []).filter(a => a.projectId === projectId).map(a => a.agentId));
  const latest = state.events.filter(e => e.projectId === projectId).at(-1);
  const savedLocation = state.locations?.find(l => l.projectId === projectId);
  const location = savedLocation?.localFolder ?? project.localFolder ?? '';
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={15} />
        Back to projects
      </button>
      <div className="research-overview">
        <div className="research-overview-body">
          <span className="mini-label">PROJECT MANDATE</span>
          <div className="research-overview-title">
            <h2>{project?.name}</h2>
            <span className="quiet-badge small">{project?.archived ? 'Archived' : 'Active'}</span>
          </div>
          <p>{project?.mandate || 'Add a mandate to describe the scope of this project.'}</p>
        </div>
        <div className="button-row">
          <button className="primary" disabled={busy || project?.archived} onClick={onNewRequest}>
            <Plus size={15} />
            New request
          </button>
          <button className="secondary" onClick={onEditProject}>
            Edit project
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void command(
                { type: 'project.archive', projectId, archived: !project?.archived },
                project?.archived ? 'Project restored.' : 'Project archived.',
              )
            }
          >
            {project?.archived ? 'Restore project' : 'Archive project'}
          </button>
        </div>
        <details className="location-details">
          <summary>
            <FolderOpen size={14} />
            Location &amp; inputs
          </summary>
          <ProjectLocationPanel
            project={project}
            saved={savedLocation}
            location={location}
            requests={state.requests}
            onState={onState}
          />
        </details>
      </div>
      <div className="project-summary-grid">
        <div>
          <strong>{requests.length}</strong>
          <span>Requests</span>
        </div>
        <div>
          <strong>{requests.filter(r => r.pipeline?.phase === 'AWAITING_DECISION').length}</strong>
          <span>Open decisions</span>
        </div>
        <div>
          <strong>{findings.length}</strong>
          <span>Findings</span>
        </div>
        <div>
          <strong>{state.artifacts.filter(a => a.projectId === projectId).length}</strong>
          <span>Imported files</span>
        </div>
      </div>
      <div className="project-shortcuts button-row" aria-label="Project views">
        <button className="secondary" onClick={() => onPage('Memory')}>
          Memory
        </button>
        <button className="secondary" onClick={() => onPage('Artifacts')}>
          Artifacts
        </button>
        <button className="secondary" onClick={() => onPage('Reviews')}>
          Reviews
        </button>
        <span className="muted">{latest ? `Last activity ${timeAgo(latest.createdAt)}` : 'No activity recorded'}</span>
        {state.agents
          .filter(a => involved.has(a.id))
          .map(a => (
            <Avatar key={a.id} id={a.id} name={a.name} />
          ))}
      </div>
      {!!findings.length && (
        <details className="project-latest-findings">
          <summary>Latest findings</summary>
          {findings
            .slice(-3)
            .reverse()
            .map(f => (
              <article key={f.id}>
                <strong>{f.title}</strong>
                <p>{f.body.slice(0, 200)}</p>
              </article>
            ))}
        </details>
      )}
      <ProjectRequests state={state} projectId={projectId} onOpenQueue={onOpenQueue} />
      {experiments.length > 0 && (
        <div className="experiment-tabs" aria-label="Experiments">
          {experiments.map(e => (
            <button
              aria-pressed={experimentId === e.id}
              className={experimentId === e.id ? 'selected' : ''}
              onClick={() => onSelectExperiment(e.id)}
              key={e.id}
            >
              {e.name}
              <span>{label(e.stage)}</span>
            </button>
          ))}
        </div>
      )}
      {experiment ? (
        <ContractEditor
          key={experiment.id}
          experiment={experiment}
          request={state.requests?.find(r => r.experimentId === experiment.id && r.status !== 'CANCELED')}
          state={state}
          disabled={busy || !!project?.archived}
          command={command}
        />
      ) : (
        <p className="research-hint muted">
          <BookOpen size={14} />
          {experiments.length
            ? 'Choose an experiment above to see its research contract.'
            : 'Research details appear here once a request creates an experiment.'}
        </p>
      )}
      <ResearchPipeline key={projectId} state={state} projectId={projectId} />
    </>
  );
}

/** This project's work-queue rows, including requests that never produced an experiment. */
function ProjectRequests({
  state,
  projectId,
  onOpenQueue,
}: {
  state: AppState;
  projectId: string;
  onOpenQueue: (requestId?: string) => void;
}) {
  const watchedJobIds = watchedJobs(useLivePresence().presence);
  const rows = requestQueue(state)
    .filter(entry => entry.root.projectId === projectId)
    .slice()
    .reverse();
  return (
    <section className="project-requests" aria-label="Project requests">
      <h2>Requests</h2>
      <p className="muted">
        Every request on this project, including ones without an experiment. Expand a row for its objective and
        provider-job record, or manage it from the Office work queue.
      </p>
      {!rows.length ? (
        <p className="muted">No requests on this project yet.</p>
      ) : (
        rows.map(row => {
          const canceled = row.status === 'CANCELED';
          const name =
            row.request?.name ??
            state.experiments.find(e => e.id === row.root.experimentId)?.name ??
            'Research request';
          const leadAgent = row.request?.leadAgentId
            ? state.agents.find(a => a.id === row.request?.leadAgentId)
            : undefined;
          const lead = row.request?.leadAgentId ? (leadAgent?.name ?? 'Not selected') : 'No lead';
          const team = leadAgent
            ? leadAgent.team.trim() || 'No team'
            : row.request?.teamId
              ? ((state.teams ?? []).find(t => t.id === row.request?.teamId)?.name ?? 'No team')
              : 'No team';
          const jobs = row.jobs ?? [],
            focus = jobs.find(j => j.unresolved) ?? jobs[jobs.length - 1];
          const blockers = [
            ...(row.request?.blockers ?? []).map(b => `${b.code}: ${b.message}`),
            ...(row.root.blocker ? [row.root.blocker] : []),
          ];
          return (
            <details className="request-row-item" key={row.id}>
              <summary>
                <span className="request-row-left">
                  <span className="request-row-name">{name}</span>
                  <span className={`status-badge${canceled ? ' canceled' : ''}`}>
                    {summarizeRequest(state, row, watchedJobIds).label}
                  </span>
                  <span className="request-row-time muted">{date(row.root.createdAt)}</span>
                </span>
                <span className="request-row-right">
                  <span className="request-row-team muted">{team}</span>
                  <span className="request-row-lead muted">{lead}</span>
                </span>
              </summary>
              <div className="request-row-detail">
                <p>{row.root.prompt}</p>
                <p className="muted">Status: {label(row.status)}</p>
                {blockers.map(b => (
                  <p className="blocker" key={b}>
                    {b}
                  </p>
                ))}
                <p className="muted">
                  {focus
                    ? `Provider job: ${label(focus.state)}${focus.unresolved ? ' — needs reconciliation' : ''}${jobs.length > 1 ? ` · ${jobs.length} on record` : ''}`
                    : 'No provider job submitted'}
                </p>
                <div className="button-row">
                  <button className="secondary" onClick={() => onOpenQueue(row.id)}>
                    Open request
                  </button>
                </div>
              </div>
            </details>
          );
        })
      )}
    </section>
  );
}

function ContractEditor({
  experiment,
  request,
  state,
  disabled,
  command,
}: {
  experiment: Experiment;
  request: Request | undefined;
  state: AppState;
  disabled: boolean;
  command: (c: CommandInput, n?: string) => Promise<AppState | null>;
}) {
  const [initial] = useState(() => readContractDraft(experiment));
  const [draft, setDraft] = useState<ResearchContract>(() => seedDraft(initial.draft, experiment, request));
  const [expanded, setExpanded] = useState(() => contractFields.slice(1).some(([key]) => draft[key].trim()));
  const [baseRevision, setBaseRevision] = useState(initial.revision);
  const [saved, setSaved] = useState(initial.saved);
  const dirty = JSON.stringify(draft) !== saved;
  const conflict = experiment.revision !== baseRevision;
  const editable = experiment.stage === 'DRAFT' || experiment.stage === 'CONTRACT_REVIEW';
  useEffect(() => {
    const key = `quant-contract-draft:${experiment.id}`;
    if (dirty) {
      const snapshot = { draft, revision: baseRevision, saved };
      contractDrafts.set(experiment.id, snapshot);
      try {
        localStorage.setItem(key, JSON.stringify(snapshot));
      } catch {}
    } else {
      contractDrafts.delete(experiment.id);
      try {
        localStorage.removeItem(key);
      } catch {}
    }
  }, [draft, baseRevision, saved, dirty, experiment.id]);
  useEffect(() => {
    if (!dirty && experiment.revision !== baseRevision) {
      setDraft(seedDraft({ ...experiment.contract }, experiment, request));
      setBaseRevision(experiment.revision);
      setSaved(JSON.stringify(experiment.contract));
    }
  }, [experiment.revision, experiment.contract, baseRevision, dirty, request]);
  const reload = () => {
    setDraft(seedDraft({ ...experiment.contract }, experiment, request));
    setBaseRevision(experiment.revision);
    setSaved(JSON.stringify(experiment.contract));
  };
  async function save() {
    const next = await command(
      { type: 'contract.save', experimentId: experiment.id, expectedRevision: baseRevision, contract: draft },
      'Research contract saved as a new version.',
    );
    const updated = next?.experiments.find(e => e.id === experiment.id);
    if (updated) {
      setBaseRevision(updated.revision);
      setSaved(JSON.stringify(updated.contract));
      setDraft({ ...updated.contract });
    }
  }
  async function submit() {
    const next = await command(
      { type: 'contract.submit', experimentId: experiment.id, expectedRevision: baseRevision },
      'Contract submitted. Review remains blocked until agents are configured.',
    );
    const updated = next?.experiments.find(e => e.id === experiment.id);
    if (updated) {
      setBaseRevision(updated.revision);
      setSaved(JSON.stringify(updated.contract));
      setDraft({ ...updated.contract });
    }
  }
  const reviewTask = state.tasks.find(
    t =>
      t.experimentId === experiment.id && t.status === 'BLOCKED' && t.prompt.startsWith('[Contract review revision '),
  );
  const reviewerRole = reviewTask?.recipient ?? 'DIRECTOR';
  const reviewers = state.agents.filter(a => !a.removedAt && a.role === reviewerRole);
  const reviews = state.reviews.filter(r => r.experimentId === experiment.id);
  const [objectiveField, ...restFields] = contractFields;
  const fieldRow = ([key, title, placeholder]: (typeof contractFields)[number], i: number) => (
    <label className="field contract-field" key={key}>
      <span>
        <b>{String(i + 1).padStart(2, '0')}</b>
        {title}
      </span>
      <textarea
        value={draft[key]}
        disabled={disabled || !editable}
        rows={3}
        maxLength={12000}
        placeholder={placeholder}
        onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
      />
    </label>
  );
  return (
    <section className="contract-editor">
      <div className="contract-heading">
        <div>
          <div className="eyebrow">RESEARCH CONTRACT · VERSION {baseRevision}</div>
          <h2>{experiment.name}</h2>
          <p>{experiment.hypothesis}</p>
        </div>
        <span className="status-badge">{label(experiment.stage)}</span>
      </div>
      {conflict && (
        <div className="notice error">
          <span>
            A newer contract revision is available. Reload the current version before saving; your unsaved edits will be
            replaced.
          </span>
          <button className="secondary" onClick={reload}>
            Discard edits &amp; reload
          </button>
        </div>
      )}
      {!editable && (
        <div className="inline-note">
          <LockKeyhole size={16} />
          {experiment.stage === 'CANCELED'
            ? 'This request was canceled. Its research details are read-only.'
            : 'This contract is frozen for its current stage.'}
        </div>
      )}
      <p className="contract-intro">
        These sections define the contract reviewers will check. The director authors them; the request seeds the
        objective{request?.acceptanceCriteria ? ' and the required checks' : ''}.
      </p>
      <div className="contract-fields">
        {fieldRow(objectiveField, 0)}
        {restFields.map((f, i) => (expanded ? fieldRow(f, i + 1) : null))}
      </div>
      <button
        type="button"
        className="text-button contract-more"
        aria-expanded={expanded}
        onClick={() => setExpanded(e => !e)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {expanded
          ? 'Collapse the remaining sections'
          : `Define the remaining ${restFields.length} sections — data policy, evaluation, checks and limits`}
      </button>
      {experiment.stage === 'CONTRACT_REVIEW' && (
        <div className="contract-await">
          <div className="eyebrow">CONTRACT REVIEW</div>
          <h3>Awaiting review by a {label(reviewerRole)}</h3>
          <ul className="await-list">
            <li>
              <b>Required reviewer</b>
              <span>
                {label(reviewerRole)}
                {reviewTask?.blocker ? ` · ${reviewTask.blocker}` : ''}
              </span>
            </li>
            <li>
              <b>Agents that can fill it</b>
              <span>
                {reviewers.length
                  ? reviewers.map(a => a.name).join(', ')
                  : `None configured — add a ${label(reviewerRole)} agent from 'Add agent' in the sidebar`}
              </span>
            </li>
            <li>
              <b>Reports</b>
              <span>
                {reviews.length
                  ? `${reviews.length} filed · ${reviews.filter(r => !r.disclosed).length} sealed until the disclosure gate is satisfied`
                  : 'None yet — independent reports stay sealed until the disclosure gate is satisfied'}
              </span>
            </li>
          </ul>
          <p>
            Review is performed by configured agents; the director records the decision. There is no approve or decline
            button here.
          </p>
          <div className="button-row">
            <button className="secondary" disabled={disabled || conflict} onClick={() => void save()}>
              Withdraw review — save as draft
            </button>
            {(request || reviewTask) && (
              <button
                className="cancel-request"
                disabled={disabled}
                onClick={() =>
                  void (request
                    ? command(
                        { type: 'request.cancel', requestId: request.id, expectedRevision: request.revision },
                        'Request and linked research canceled.',
                      )
                    : command({ type: 'task.cancel', taskId: reviewTask!.id }, 'Research request canceled.'))
                }
              >
                Cancel request
              </button>
            )}
          </div>
        </div>
      )}
      <div className="contract-actions">
        <span className="muted">
          {dirty ? 'Unsaved changes · draft retained' : 'Saved version'} · Reviews require configured provider agents
        </span>
        <div className="button-row">
          <button
            className="secondary"
            disabled={disabled || !editable || !dirty || conflict}
            onClick={() => void save()}
          >
            Save contract
          </button>
          <button
            className="primary"
            disabled={
              disabled ||
              !editable ||
              dirty ||
              conflict ||
              experiment.stage === 'CONTRACT_REVIEW' ||
              !draft.objective.trim()
            }
            onClick={() => void submit()}
          >
            <ShieldCheck size={15} />
            {experiment.stage === 'CONTRACT_REVIEW' ? 'Awaiting review' : 'Submit for review'}
          </button>
        </div>
      </div>
    </section>
  );
}
