import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import type { Agent, AppState, Assignment, Experiment, ProviderJob, ResearchStatus, WorkMode } from '../shared/types';
import type { BranchLink, PipelineRecord } from '../shared/pipeline';
import { latestJobFor } from '../core/jobs';
import { Empty, label, Avatar, StatusPill } from './components';
import { FilePreviewPane, type FilePreview } from './file-preview';
import './explorer.css';
import './review.css';
import { pipelineReviewHops, type PipelineReviewHop, type StoredJobOutputRow } from './job-outputs';

/** Stage functions whose work is an independent review rather than production. */
const REVIEW_FUNCTIONS = new Set<string>(['CORRECTNESS_REVIEWER', 'ADVOCATE', 'SKEPTIC']);
/** Minted pipeline keys that carry review work rather than production (the comm-round's own vocabulary). */
const REVIEW_KEY = /critique|falsif|response|verif/;

type PreviewResult = { name: string; text: string; truncated: boolean; binary: boolean };

/**
 * The critique, falsification, response and verification hops recorded on this project's pipeline
 * requests — the review work a round actually performed, with each hop's latest recorded job state
 * and previews of its stored outputs. A minted hop that was never dispatched shows as recorded
 * without a job; nothing about its state is invented.
 */
export function PipelineReviews({
  state,
  projectId,
  experiment,
  busy,
  setPreview,
  onError,
}: {
  state: AppState;
  projectId: string;
  experiment?: Experiment;
  busy: boolean;
  setPreview: (preview: PreviewResult) => void;
  onError: (e: unknown) => void;
}) {
  const experimentOf = (requestId: string) => state.requests?.find(r => r.id === requestId)?.experimentId;
  const groups = pipelineReviewHops(state, projectId, true).filter(
    g => !experiment || experimentOf(g.requestId) === experiment.id,
  );
  return (
    <section className="pipeline-reviews">
      <h2>Pipeline reviews</h2>
      {!groups.length ? (
        <Empty
          icon={ShieldCheck}
          title="No pipeline reviews on record for this scope"
          description="No pipeline steps have been recorded."
        />
      ) : (
        groups.map(group => (
          <details key={group.requestId} className="review-task">
            <summary>
              <strong>{group.requestName}</strong>
              <span className="muted">{group.hops.length} steps</span>
            </summary>
            <div className="review-sequence">
              {group.hops.map((hop, index) => (
                <ReviewHop
                  key={hop.assignmentId + ':' + hop.jobId}
                  hop={hop}
                  index={index}
                  busy={busy}
                  setPreview={setPreview}
                  onError={onError}
                />
              ))}
            </div>
          </details>
        ))
      )}
    </section>
  );
}

function ReviewHop({
  hop,
  index,
  busy,
  setPreview,
  onError,
}: {
  hop: PipelineReviewHop;
  index: number;
  busy: boolean;
  setPreview: (preview: PreviewResult) => void;
  onError: (e: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<FilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const ticket = useRef(0);
  const primary =
    hop.outputs.find(o => /(^|[/\\\\])report\.md$/i.test(o.path)) ?? hop.outputs.find(o => /\.(md|txt)$/i.test(o.path));
  const preview = useCallback(
    async (output: StoredJobOutputRow) => {
      const current = ++ticket.current;
      setLoading(true);
      setError('');
      setSelected(null);
      try {
        const result = await window.office.jobOutputPreview({ jobId: output.jobId, path: output.path });
        if (ticket.current === current)
          setSelected({ name: output.path, text: result.text, truncated: result.truncated, binary: false });
      } catch (e) {
        if (ticket.current === current) {
          setError((e as Error).message);
          onError(e);
        }
      } finally {
        if (ticket.current === current) setLoading(false);
      }
    },
    [onError],
  );
  useEffect(() => {
    return () => {
      ticket.current++;
    };
  }, []);
  useEffect(() => {
    if (open && primary && !selected && !loading && !error) void preview(primary);
  }, [open, primary?.jobId, primary?.path, primary?.sha256, selected, loading, error, preview]);
  return (
    <details className="review-step" onToggle={e => setOpen(e.currentTarget.open)}>
      <summary>
        <ChevronRight className="review-chevron" size={14} aria-hidden="true" />
        <span className="review-number">{index + 1}</span>
        <Avatar id={hop.agentId} name={hop.agentName} />
        <span className="review-step-name">
          <strong>{hop.agentName}</strong>
          <small>{label(hop.pipelineKey.replaceAll('-', ' '))}</small>
        </span>
        <StatusPill
          status={
            hop.state === 'FAILED'
              ? 'failed'
              : hop.state === 'COMPLETED'
                ? 'done'
                : hop.state === 'RUNNING'
                  ? 'working'
                  : 'unknown'
          }
          label={hop.state ? label(hop.state) : 'Not dispatched'}
        />
      </summary>
      <div className="review-content">
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {selected || loading ? (
          <FilePreviewPane preview={selected} loading={loading} onOpen={() => selected && setPreview(selected)} />
        ) : (
          <p className="review-detail">{hop.detail || 'No stored report yet.'}</p>
        )}
        {hop.outputs.length > 0 && (
          <div className="button-row review-files">
            {hop.outputs.map(output => (
              <button
                key={output.path + output.sha256}
                className="secondary"
                disabled={busy || loading}
                onClick={() => void preview(output)}
                title={output.path}
              >
                Preview {output.path.split(/[/\\\\]/).pop()}
              </button>
            ))}
          </div>
        )}
        <details className="review-recorded">
          <summary>Recorded details</summary>
          <p className="review-detail">{hop.detail}</p>
          <p className="muted">Attempt {hop.attempt ?? 'Not dispatched'} · Verdict: unverified</p>
          {hop.jobId && <p className="muted">Job: {hop.jobId}</p>}
          <p className="muted">Completion records execution state, not an independently verified review verdict.</p>
        </details>
      </div>
    </details>
  );
}

/** The research-stage review sequence each S2/S7 gate step's recorded state is derived from. */
const STAGE_GATE: { label: string; done: (records: PipelineRecord[]) => boolean }[] = [
  {
    label: 'Independent evidence',
    done: r =>
      r.some(item => item.kind === 'REVIEW_REPORT' || item.kind === 'REVIEW_ROUND' || item.kind === 'SEPARATED_REVIEW'),
  },
  { label: 'One rebuttal round', done: r => r.some(item => item.kind === 'REBUTTAL') },
  { label: 'Director decision', done: r => r.some(item => item.kind === 'ADJUDICATION') },
];

/**
 * The research-stage (S2/S7) review record for this project, retitled so it is not misread as the
 * pipeline reviews above. Each gate step's badge is derived from the branch pipeline records —
 * reports actually sealed, rebuttals actually recorded, an adjudication actually decided — never
 * a static placeholder.
 */
export function ResearchStageReviews({
  state,
  projectId,
  experiment,
}: {
  state: AppState;
  projectId: string;
  experiment?: Experiment;
}) {
  const links = (state.pipeline ?? []).filter((r): r is BranchLink => r.kind === 'LINK' && r.projectId === projectId);
  const experimentOf = (branchId: string) => {
    const requestId = links.find(l => l.branchId === branchId)?.requestId;
    return state.requests?.find(r => r.id === requestId)?.experimentId;
  };
  const inScope = (r: PipelineRecord) =>
    r.projectId === projectId && (!experiment || experimentOf(r.branchId) === experiment.id);
  const reports = (state.pipeline ?? []).filter(r => r.kind === 'REVIEW_REPORT' && inScope(r));
  const records = (state.pipeline ?? []).filter(inScope);
  const flatReports = state.reviews.filter(
    r => r.projectId === projectId && (!experiment || r.experimentId === experiment.id),
  );
  return (
    <section>
      <h2>Research-stage reviews (S2/S7)</h2>
      <div className="review-gates">
        {STAGE_GATE.map((s, i) => (
          <div key={s.label} data-recorded={s.done(records)}>
            <span className="gate-number">0{i + 1}</span>
            <strong>{s.label}</strong>
            <span className="quiet-badge small">{s.done(records) ? 'Recorded' : 'Pending'}</span>
          </div>
        ))}
      </div>
      {!reports.length && !flatReports.length ? (
        <Empty
          icon={ShieldCheck}
          title="No research-stage reviews recorded"
          description="S2 correctness review and S7 advocate/skeptic reports belong to a research branch's stage sequence, recorded under the project's research workspace. 'Pending' describes that sequence — pipeline critiques and verifications are a separate record, listed in the section above."
        />
      ) : (
        <div className="task-list">
          {reports.map(
            r =>
              r.kind === 'REVIEW_REPORT' && (
                <article className="task-card" key={r.id}>
                  <div className="card-heading">
                    <h3>
                      {r.stage} · {r.opened ? label(r.verdict) : 'First report sealed'}
                    </h3>
                    <span className="quiet-badge">{label(r.independence)}</span>
                  </div>
                  <p>
                    {r.opened ? r.detail : 'Independent report remains sealed until the disclosure gate is satisfied.'}
                  </p>
                  <code className="hash">Report {r.reportHash}</code>
                </article>
              ),
          )}
          {flatReports.map(r => (
            <article className="task-card" key={r.id}>
              <div className="card-heading">
                <h3>{label(r.role)}</h3>
                <span className="quiet-badge">{r.disclosed ? r.verdict : 'Awaiting disclosure'}</span>
              </div>
              <p>
                {r.disclosed ? r.content : 'Independent report remains sealed until the disclosure gate is satisfied.'}
              </p>
              <code className="hash">Bundle {r.bundleHash}</code>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

/** One recorded verdict chip on a position hop — the label exactly as the record carries it. */
export interface PositionVerdict {
  text: string;
  /** Which recorded document the chip reports. */
  source: 'review report' | 'review decision';
  tone: 'supports' | 'opposes' | 'changes' | 'sealed';
  title: string;
}
export interface PositionHop {
  assignmentId: string;
  pipelineKey: string | null;
  agentId: string;
  agentName: string;
  /** Latest recorded job state; null when the hop was minted but no job is on record. */
  jobId: string | null;
  attempt: number | null;
  state: ProviderJob['state'] | null;
  verdicts: PositionVerdict[];
  outputs: StoredJobOutputRow[];
}
export interface PositionLane {
  /** The recorded function: the stage function on a research-bound hop, else the review family of its minted key. */
  function: string;
  hops: PositionHop[];
}

const laneFunction = (assignment: Assignment): string => {
  if (assignment.research && REVIEW_FUNCTIONS.has(assignment.research.function)) return assignment.research.function;
  const key = assignment.pipelineKey ?? '';
  if (/critique/.test(key)) return 'CRITIQUE';
  // 'analysis-response-falsify' is a response hop answering the falsify artifact — check the
  // response prefix before the falsification family it names.
  if (/response/.test(key)) return 'RESPONSE';
  if (/falsif/.test(key)) return 'FALSIFICATION';
  return 'VERIFICATION';
};

/**
 * A request's recorded review work laid out as positions: one lane per function the round's records
 * name — the minted critique/falsify/response/verify keys, or the stage function a research-bound
 * assignment carries — each hop showing its latest recorded job state and every verdict a review
 * report or review decision actually recorded against it. A sealed report shows 'sealed', never its
 * undisclosed verdict. Lanes keep mint order; nothing about a hop's state or verdict is computed.
 */
export function requestReviewLanes(
  state: Pick<AppState, 'assignments' | 'jobs' | 'agents' | 'decisions' | 'pipeline'>,
  requestId: string,
): PositionLane[] {
  const lanes = new Map<string, PositionLane>();
  for (const a of state.assignments ?? []) {
    if (a.requestId !== requestId) continue;
    const isReviewHop =
      (a.pipelineKey && REVIEW_KEY.test(a.pipelineKey)) || (a.research && REVIEW_FUNCTIONS.has(a.research.function));
    if (!isReviewHop) continue;
    const job = latestJobFor(state.jobs, a.id);
    const verdicts: PositionVerdict[] = [];
    for (const r of state.pipeline ?? []) {
      if (r.kind !== 'REVIEW_REPORT' || r.assignmentId !== a.id) continue;
      verdicts.push({
        text: r.opened ? r.verdict.toLowerCase() : 'sealed',
        source: 'review report',
        tone: r.opened ? (r.verdict === 'SUPPORTS' ? 'supports' : 'opposes') : 'sealed',
        title: r.opened
          ? `Recorded review report · ${label(r.independence)}`
          : 'First report sealed — it opens when every first report of the round is immutable.',
      });
    }
    for (const d of state.decisions ?? []) {
      if (d.requestId !== requestId || d.reviewerAssignmentId !== a.id) continue;
      verdicts.push({
        text: `${d.phase === 'REBUTTAL' ? 'rebuttal · ' : ''}${label(d.verdict)}`,
        source: 'review decision',
        tone: d.verdict === 'APPROVED' ? 'supports' : d.verdict === 'REJECTED' ? 'opposes' : 'changes',
        title: `Recorded ${label(d.phase)} review decision`,
      });
    }
    const fn = laneFunction(a);
    const lane = lanes.get(fn) ?? { function: fn, hops: [] };
    lanes.set(fn, lane);
    lane.hops.push({
      assignmentId: a.id,
      pipelineKey: a.pipelineKey ?? null,
      agentId: a.agentId,
      agentName: state.agents?.find(x => x.id === a.agentId)?.name ?? `profile ${a.agentId.slice(0, 8)}`,
      jobId: job?.id ?? null,
      attempt: job ? (job.attempt ?? 1) : null,
      state: job?.state ?? null,
      verdicts,
      outputs: (job?.outputs ?? [])
        .filter(o => o.stored)
        .map(o => ({
          jobId: job!.id,
          assignmentId: a.id,
          path: o.path,
          bytes: o.bytes,
          sha256: o.sha256,
          attempt: job!.attempt ?? 1,
          superseded: false,
        })),
    });
  }
  return [...lanes.values()];
}

/**
 * The per-request argument map: one card per request that carries a round, its recorded review hops
 * laid into per-function lanes so opposing verdicts sit side by side. Every chip is a stored review
 * decision or review report's own label — the section never computes a verdict the records do not
 * carry. A request with no review records says so rather than vanishing.
 */
export function RequestPositions({
  state,
  projectId,
  experiment,
  busy,
  setPreview,
  onError,
}: {
  state: AppState;
  projectId: string;
  experiment?: Experiment;
  busy: boolean;
  setPreview: (preview: PreviewResult) => void;
  onError: (e: unknown) => void;
}) {
  const [selectedPreview, setSelectedPreview] = useState<FilePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewTicket = useRef(0);
  useEffect(() => {
    previewTicket.current++;
    setSelectedPreview(null);
    setPreviewBusy(false);
    return () => {
      previewTicket.current++;
    };
  }, [projectId, experiment?.id]);
  const preview = async (jobId: string, path: string) => {
    const ticket = ++previewTicket.current;
    setPreviewBusy(true);
    setSelectedPreview(null);
    try {
      const r = await window.office.jobOutputPreview({ jobId, path });
      if (ticket === previewTicket.current)
        setSelectedPreview({ name: path, text: r.text, truncated: r.truncated, binary: false });
    } catch (e) {
      if (ticket === previewTicket.current) onError(e);
    } finally {
      if (ticket === previewTicket.current) setPreviewBusy(false);
    }
  };
  const requests = (state.requests ?? [])
    .filter(r => r.projectId === projectId && (!experiment || r.experimentId === experiment.id))
    .map(request => ({ request, lanes: requestReviewLanes(state, request.id) }))
    .filter(({ request, lanes }) => request.pipeline || lanes.length > 0)
    .sort((a, b) => a.request.createdAt.localeCompare(b.request.createdAt) || a.request.id.localeCompare(b.request.id));
  return (
    <section>
      <h2>Positions</h2>
      <p className="muted">
        Each lane groups one function's recorded review hops; a chip repeats the verdict a review decision or report
        actually recorded. The office reports these records — it never computes a verdict of its own.
      </p>
      {!requests.length ? (
        <p className="muted">No recorded review work for this request.</p>
      ) : (
        requests.map(({ request, lanes }) => (
          <article key={request.id} className="task-card">
            <div className="card-heading">
              <h3>{request.name}</h3>
            </div>
            {!lanes.length ? (
              <p className="muted">No recorded review work for this request.</p>
            ) : (
              <div className="position-lanes">
                {lanes.map(lane => (
                  <section className="position-lane" key={lane.function}>
                    <h4 className="position-fn">{label(lane.function)}</h4>
                    {lane.hops.map(hop => (
                      <div className="position-hop" key={hop.assignmentId}>
                        <div className="card-heading">
                          <Avatar id={hop.agentId} name={hop.agentName} />
                          <strong>{hop.agentName}</strong>
                          <StatusPill
                            status={
                              hop.state === 'FAILED'
                                ? 'failed'
                                : hop.state === 'COMPLETED'
                                  ? 'done'
                                  : hop.state === 'RUNNING'
                                    ? 'working'
                                    : 'unknown'
                            }
                            label={hop.state ? label(hop.state) : 'Not dispatched'}
                          />
                        </div>
                        <small className="muted">
                          {hop.pipelineKey ? label(hop.pipelineKey.replaceAll('-', ' ')) : 'stage hop'}
                          {hop.attempt != null ? ` · attempt ${hop.attempt}` : ''}
                        </small>
                        <div className="position-verdicts">
                          {hop.verdicts.map((verdict, i) => (
                            <span key={i} className="verdict-chip" data-tone={verdict.tone} title={verdict.title}>
                              {verdict.text}
                            </span>
                          ))}
                          {!hop.verdicts.length && <small className="muted">No verdict on record</small>}
                        </div>
                        {!!hop.outputs.length && (
                          <div className="button-row">
                            {hop.outputs.map(output => (
                              <button
                                key={output.path + output.sha256}
                                className="secondary"
                                disabled={busy}
                                onClick={() => void preview(output.jobId, output.path)}
                                title={output.path}
                              >
                                Preview {output.path.split('/').pop()}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            )}
          </article>
        ))
      )}
      <FilePreviewPane
        preview={selectedPreview}
        loading={previewBusy}
        onOpen={() => selectedPreview && setPreview(selectedPreview)}
      />
    </section>
  );
}

/**
 * The Reviews page body: pipeline review work first, then the research-stage sequence — kept in
 * separate sections so 'pending' on one is never read as the other never happening.
 */
export function ReviewsView({
  state,
  projectId,
  experiment,
  busy,
  setPreview,
  onError,
}: {
  state: AppState;
  projectId: string;
  experiment?: Experiment;
  busy: boolean;
  setPreview: (preview: PreviewResult) => void;
  onError: (e: unknown) => void;
}) {
  return (
    <>
      <PipelineReviews
        state={state}
        projectId={projectId}
        experiment={experiment}
        busy={busy}
        setPreview={setPreview}
        onError={onError}
      />
      <details className="review-task">
        <summary>Request positions</summary>
        <RequestPositions
          state={state}
          projectId={projectId}
          experiment={experiment}
          busy={busy}
          setPreview={setPreview}
          onError={onError}
        />
      </details>
      <details className="review-task">
        <summary>Research-stage reviews</summary>
        <ResearchStageReviews state={state} projectId={projectId} experiment={experiment} />
      </details>
    </>
  );
}

/**
 * Where a research branch actually stands, stated as what is stopping it rather than as a status.
 *
 * The panel deliberately shows blockers before anything else and never offers a promote control. A
 * button that is disabled for a reason invites the reason to be argued with; the decision is made in
 * main from gate receipts, and this view reports it.
 */
export function BranchStanding({
  branchId,
  subjectHash,
  mode,
  label,
}: {
  branchId: string;
  subjectHash: string;
  mode: WorkMode;
  label: (value: string) => string;
}) {
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const [next, app] = await Promise.all([
        window.office.researchStatus({ branchId, subjectHash, mode }),
        window.office.getState(),
      ]);
      setStatus(next);
      setAgents(app.agents.filter(a => !a.removedAt));
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
      setAgents([]);
    } finally {
      setBusy(false);
    }
  }, [branchId, subjectHash, mode]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () =>
      window.office.onChanged(() => {
        void load();
      }),
    [load],
  );

  if (error)
    return (
      <p className="notice error" role="alert">
        {error}
      </p>
    );
  if (!status) return <p className="muted">{busy ? 'Reading stage standing…' : 'No stage standing available.'}</p>;
  const blockers = [
    ...status.promotionBlockers,
    ...status.scheduleBlockers.filter(item => !status.promotionBlockers.includes(item)),
  ];
  const profile = (id: string) => agents.find(a => a.id === id)?.name;
  const unassigned = status.functions.filter(item => item.blockers.length);
  const reviewStage = status.functions.some(item => REVIEW_FUNCTIONS.has(item.function));
  return (
    <section className="standing">
      <div className="card-heading">
        <h3>
          {label(status.stage)} · {label(status.outcome.replaceAll('_', ' '))}
        </h3>
        <span className="quiet-badge small">
          {status.canPromote ? 'All gates for this subject are earned' : 'Blocked'}
        </span>
      </div>

      <div className="standing-section">
        {blockers.length > 0 && (
          <>
            <p className="muted">
              This branch does not advance until each of these is resolved. Nothing here can be waived from this view.
            </p>
            <ul className="blockers">
              {blockers.map(reason => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </>
        )}
        {!blockers.length && (
          <p className="muted">Every gate this stage requires has a passing receipt for this exact subject.</p>
        )}
      </div>

      <div className="standing-section">
        <h4>Functions this stage needs</h4>
        <ul className="functions">
          {status.functions.map(item => (
            <li key={item.function}>
              <b>{label(item.function.replaceAll('_', ' '))}</b>
              {item.blockers.length ? (
                <span className="unassigned">{item.blockers.join(' ')}</span>
              ) : (
                <span>
                  {profile(item.agentId) ?? 'Appointed profile'} · assigned at profile revision {item.agentRevision}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {unassigned.length > 0 && (
        <div className="standing-section">
          <h4>What you can do now</h4>
          <p className="muted">
            Appoint a profile to each open function under 'Assign stage functions' below — an appointment binds the
            profile at its current revision.
            {agents.length
              ? ` Active profiles that can be appointed: ${agents.map(a => a.name).join(', ')}.`
              : " No active profiles are registered — add one from 'Add agent' in the sidebar."}
          </p>
        </div>
      )}

      {reviewStage && (
        <div className="standing-section">
          <h4>How this review concludes</h4>
          <p className="muted">
            Review is performed by the appointed profiles; first reports stay sealed until every expected report in the
            round is sealed, then the round opens them together. Advancement is recorded from gate receipts in main —
            there is no approve or decline button in this view.
          </p>
        </div>
      )}

      {status.tasks.length > 0 && (
        <div className="standing-section">
          <h4>Next work this stage would create</h4>
          <ul className="functions">
            {status.tasks.map(task => (
              <li key={task.contextHash}>
                <b>{label(task.function.replaceAll('_', ' '))}</b>
                <span>
                  output {task.outputSchema}
                  {task.dependsOn.length
                    ? ` · after ${task.dependsOn.length} worker task${task.dependsOn.length === 1 ? '' : 's'}`
                    : ''}
                </span>
                <details>
                  <summary>Frozen context</summary>
                  <code className="hash">{task.contextHash}</code>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
