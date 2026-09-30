import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Agent, AppState, Experiment, ResearchStatus, WorkMode } from '../shared/types';
import type { BranchLink, PipelineRecord } from '../shared/pipeline';
import { Empty, label } from './components';
import { pipelineReviewHops } from './job-outputs';

/** Stage functions whose work is an independent review rather than production. */
const REVIEW_FUNCTIONS = new Set<string>(['CORRECTNESS_REVIEWER', 'ADVOCATE', 'SKEPTIC']);

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
  const groups = pipelineReviewHops(state, projectId).filter(
    g => !experiment || experimentOf(g.requestId) === experiment.id,
  );
  const preview = (jobId: string, path: string) => {
    window.office
      .jobOutputPreview({ jobId, path })
      .then(r => setPreview({ name: path, text: r.text, truncated: r.truncated, binary: false }))
      .catch(onError);
  };
  return (
    <section>
      <h2>Pipeline reviews</h2>
      <p className="muted">
        Each hop shows its latest attempt only — an earlier attempt's stored bytes stay listed under Artifacts, marked
        superseded.
      </p>
      {!groups.length ? (
        <p className="muted">
          No pipeline reviews on record for this scope. A request's critique, falsification, response and verification
          hops appear here once a launched pipeline mints them.
        </p>
      ) : (
        groups.map(group => (
          <article key={group.requestId} className="task-card">
            <div className="card-heading">
              <h3>{group.requestName}</h3>
            </div>
            <ul className="functions">
              {group.hops.map(hop => (
                <li key={hop.assignmentId}>
                  <b>{label(hop.pipelineKey.replaceAll('-', ' '))}</b>
                  <span>
                    {hop.agentName}
                    {hop.state
                      ? ` · attempt ${hop.attempt} · ${label(hop.state)}`
                      : ' · recorded — no job dispatched yet'}
                  </span>
                  {!!hop.outputs.length && (
                    <span className="button-row">
                      {hop.outputs.map(output => (
                        <button
                          key={output.path + output.sha256}
                          className="secondary"
                          disabled={busy}
                          onClick={() => preview(output.jobId, output.path)}
                          title={`${output.path} · ${output.bytes} bytes · sha256 ${output.sha256.slice(0, 12)}…`}
                        >
                          Preview {output.path}
                        </button>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </article>
        ))
      )}
    </section>
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
          <div key={s.label}>
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
      <ResearchStageReviews state={state} projectId={projectId} experiment={experiment} />
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
