import { ArrowDownToLine, ArrowUpFromLine, Box, LockKeyhole } from 'lucide-react';
import type { AppState, Experiment, FileActionResult, Project } from '../shared/types';
import { Empty, label } from './components';
import { projectJobOutputs } from './job-outputs';
import './office.css';
import { formatNumber } from './format';

const date = (d: string) =>
  new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function ArtifactsPage({
  state,
  project,
  projectId,
  experiment,
  busy,
  files,
  setBusy,
  setPreview,
  onError,
}: {
  state: AppState;
  project: Project | undefined;
  projectId: string;
  experiment: Experiment | undefined;
  busy: boolean;
  files: (action: () => Promise<FileActionResult>) => void;
  setBusy: (busy: boolean) => void;
  setPreview: (preview: { name: string; text: string; truncated: boolean; binary: boolean }) => void;
  onError: (e: unknown) => void;
}) {
  const scopedArtifacts = state.artifacts.filter(
    a => a.projectId === projectId && (!experiment || a.experimentId === experiment.id),
  );
  const requestOf = (id: string) => state.requests?.find(r => r.id === id);
  const outputGroups = projectJobOutputs(state, projectId).filter(
    group => !experiment || requestOf(group.requestId)?.experimentId === experiment.id,
  );
  const outputCount = outputGroups.reduce(
    (sum, group) => sum + group.hops.reduce((n, hop) => n + hop.outputs.length, 0),
    0,
  );
  const previewOutput = (jobId: string, path: string) => {
    setBusy(true);
    window.office
      .jobOutputPreview({ jobId, path })
      .then(r => setPreview({ name: path, text: r.text, truncated: r.truncated, binary: false }))
      .catch(onError)
      .finally(() => setBusy(false));
  };
  return (
    <>
      <div className="section-toolbar artifact-toolbar">
        <span>
          {scopedArtifacts.length} imported · {outputCount} agent output{outputCount === 1 ? '' : 's'}
        </span>
        <div className="button-row">
          <button
            className="secondary"
            disabled={busy || project?.archived}
            onClick={() =>
              void files(() =>
                window.office.importFiles({ projectId, experimentId: experiment?.id || null, kind: 'REFERENCE' }),
              )
            }
          >
            <ArrowDownToLine size={15} />
            Import references
          </button>
          <button
            className="secondary"
            disabled={busy || project?.archived}
            onClick={() =>
              void files(() =>
                window.office.importFiles({ projectId, experimentId: experiment?.id || null, kind: 'RESULT' }),
              )
            }
          >
            <ArrowDownToLine size={15} />
            Import my results
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void files(() => window.office.exportProject(projectId))}
          >
            <ArrowUpFromLine size={15} />
            Export project
          </button>
        </div>
      </div>
      <h2>Imported files</h2>
      <div className="inline-note">
        <LockKeyhole size={16} />
        <span>
          Files are stored as evidence. Imported results await provider verification. Finalized ML code runs manually in
          your own Colab session; this app never connects to it.
        </span>
      </div>
      {!scopedArtifacts.length ? (
        <Empty
          icon={Box}
          title="A cabinet for your evidence"
          description="Import reference code, datasets, or results you produced yourself. Nothing you import is executed by this app."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Artifact</th>
                <th>Type / state</th>
                <th>Integrity</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {scopedArtifacts
                .filter(a => !experiment || a.experimentId === experiment.id)
                .map(a => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>
                      <small>
                        {formatNumber(a.size)} bytes · {a.mediaType}
                      </small>
                    </td>
                    <td>
                      <span className="quiet-badge small">{label(a.kind)}</span>
                      <small>
                        {label(a.status)} · {label(a.classification)}
                      </small>
                    </td>
                    <td>
                      <code title={a.sha256}>{a.sha256.slice(0, 12)}…</code>
                    </td>
                    <td>{date(a.createdAt)}</td>
                    <td>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            setPreview({ name: a.name, ...(await window.office.previewArtifact(a.id)) });
                          } catch (e) {
                            onError(e);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Preview
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-heading">
        <h2>Agent outputs</h2>
        {!!outputCount && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void files(() => window.office.exportProject(projectId))}
          >
            <ArrowUpFromLine size={15} />
            Export project
          </button>
        )}
      </div>
      <p className="footnote">
        Bytes the office fetched, hash-checked and durably stored from recorded agent sessions — the record of what a
        session produced, not verification that its findings are correct. Each row names the attempt that stored those
        bytes; 'superseded' marks bytes a newer attempt replaced rather than reproduced. A canceled request keeps its
        stored outputs — the record is kept. Included in project export.
      </p>
      {!outputCount ? (
        <p className="muted">
          No stored job outputs yet — outputs appear here after a dispatched job reports files the office could fetch
          and store.
        </p>
      ) : (
        <div className="task-list">
          {outputGroups.map(group => (
            <article key={group.requestId} className="task-card">
              <div className="card-heading">
                <h3>{group.requestName}</h3>
                {group.requestStatus === 'CANCELED' && <span className="quiet-badge small">request canceled</span>}
              </div>
              {group.hops.map(hop => (
                <div key={hop.key}>
                  <p className="muted">
                    <strong>{hop.pipelineKey ?? 'Direct dispatch'}</strong> · {hop.agentName}
                  </p>
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        {hop.outputs.map(output => (
                          <tr key={output.path + output.sha256}>
                            <td>
                              <code>{output.path}</code>
                            </td>
                            <td>{formatNumber(output.bytes)} bytes</td>
                            <td>
                              <code title={output.sha256}>{output.sha256.slice(0, 12)}…</code>
                            </td>
                            <td>
                              <small className="muted">
                                attempt {output.attempt}
                                {output.superseded ? ' · superseded' : ''}
                              </small>
                            </td>
                            <td>
                              <button
                                className="secondary"
                                disabled={busy}
                                onClick={() => previewOutput(output.jobId, output.path)}
                              >
                                Preview
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </article>
          ))}
        </div>
      )}
      <p className="footnote">
        Project export includes the current local record and stored files. It does not certify code as approved.
      </p>
    </>
  );
}
