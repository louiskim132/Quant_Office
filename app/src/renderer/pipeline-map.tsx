import React, { useState } from 'react';
import type { AppState, Assignment } from '../shared/types';
import { latestJobFor } from '../core/jobs';
import { Avatar, StatusPill, Drawer, Disclosure } from './components';
import { formatElapsed } from './status';
import { FilePreviewPane, type FilePreview } from './file-preview';
import './explorer.css';

export function PipelineMap({ hops, state }: { hops: Assignment[]; state: AppState }) {
  const [timeline, setTimeline] = useState(false),
    [selected, setSelected] = useState(''),
    [preview, setPreview] = useState<FilePreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const ticket = React.useRef(0);
  React.useEffect(() => {
    ticket.current++;
    setPreview(null);
    setBusy(false);
    setError('');
  }, [selected]);
  React.useEffect(
    () => () => {
      ticket.current++;
    },
    [],
  );
  const levels = new Map<string, number>();
  const depth = (hop: Assignment, visiting = new Set<string>()): number => {
    if (levels.has(hop.id)) return levels.get(hop.id)!;
    if (visiting.has(hop.id)) return 0;
    const next = new Set(visiting).add(hop.id);
    const parents = (hop.dependsOn ?? []).map(id => hops.find(h => h.id === id)).filter((h): h is Assignment => !!h);
    const level = parents.length ? 1 + Math.max(...parents.map(h => depth(h, next))) : 0;
    levels.set(hop.id, level);
    return level;
  };
  hops.forEach(h => depth(h));
  const chosen = hops.find(h => h.id === selected),
    job = chosen && latestJobFor(state.jobs, chosen.id);
  const allJobs = (state.jobs ?? []).filter(j => hops.some(h => h.id === j.assignmentId));
  const starts = allJobs.map(j => Date.parse(j.dispatchedAt ?? j.createdAt)).filter(Number.isFinite);
  const ends = allJobs.map(j => Date.parse(j.settledAt ?? j.updatedAt)).filter(Number.isFinite);
  const first = Math.min(...starts),
    duration = Math.max(1, Math.max(...ends) - first);
  const status = (state?: string) =>
    state === 'COMPLETED'
      ? 'done'
      : state === 'FAILED'
        ? 'failed'
        : state === 'RUNNING'
          ? 'working'
          : state === 'UNKNOWN'
            ? 'unknown'
            : 'idle';
  const card = (hop: Assignment) => {
    const j = latestJobFor(state.jobs, hop.id),
      a = state.agents.find(a => a.id === hop.agentId);
    return (
      <button className="pipeline-node" key={hop.id} onClick={() => setSelected(hop.id)}>
        <Avatar id={hop.agentId} name={a?.name ?? 'Unassigned'} />
        <strong>{hop.pipelineKey ?? 'Direct dispatch'}</strong>
        <span>{a?.name ?? 'Unassigned'}</span>
        <StatusPill status={status(j?.state)} label={j?.state.toLowerCase().replaceAll('_', ' ') ?? 'Not started'} />
        <small>
          {(hop.dependsOn ?? []).length
            ? `After ${(hop.dependsOn ?? []).map(id => hops.find(h => h.id === id)?.pipelineKey ?? 'prior step').join(', ')}`
            : 'Entry step'}
        </small>
      </button>
    );
  };
  return (
    <section className="pipeline-visual">
      <div className="button-row" role="group" aria-label="Pipeline view">
        <button className="secondary" aria-pressed={!timeline} onClick={() => setTimeline(false)}>
          Steps
        </button>
        <button className="secondary" aria-pressed={timeline} onClick={() => setTimeline(true)}>
          Timeline
        </button>
      </div>
      {!timeline ? (
        <div className="pipeline-levels">
          {[...new Set(levels.values())]
            .sort((a, b) => a - b)
            .map(level => (
              <div className="pipeline-level" key={level}>
                <small className="muted">Step {level + 1}</small>
                {hops.filter(h => levels.get(h.id) === level).map(card)}
              </div>
            ))}
        </div>
      ) : (
        <div className="pipeline-spans">
          {allJobs.map(j => {
            const hop = hops.find(h => h.id === j.assignmentId)!;
            const start = Date.parse(j.dispatchedAt ?? j.createdAt),
              end = Date.parse(j.settledAt ?? j.updatedAt);
            const ms = Math.max(0, end - start);
            return (
              <button key={j.id} className="pipeline-span" onClick={() => setSelected(hop.id)}>
                <strong>
                  {hop.pipelineKey} · attempt {j.attempt ?? 1}
                </strong>
                <span>
                  {j.state.toLowerCase()} · {formatElapsed(ms)}
                </span>
                <i
                  style={{
                    marginLeft: `${Math.max(0, ((start - first) / duration) * 70)}%`,
                    width: `${Math.max(2, (ms / duration) * 70)}%`,
                  }}
                />
              </button>
            );
          })}
        </div>
      )}
      {chosen && (
        <Drawer
          label={`Step: ${chosen.pipelineKey}`}
          head={<h2>{chosen.pipelineKey}</h2>}
          onClose={() => setSelected('')}
        >
          <p>{job?.lastObservation ?? job?.detail ?? 'No job dispatched yet.'}</p>
          <p className="muted">
            Requested model: {chosen.requestedModel} · {chosen.requestedEffort} effort. Applied settings follow the
            recorded job evidence.
          </p>
          <div className="button-row">
            {job?.outputs
              .filter(o => o.stored)
              .map(o => (
                <button
                  className="secondary"
                  key={o.path + o.sha256}
                  disabled={busy}
                  onClick={async () => {
                    const current = ++ticket.current;
                    setBusy(true);
                    setError('');
                    try {
                      const r = await window.office.jobOutputPreview({ jobId: job.id, path: o.path });
                      if (current === ticket.current)
                        setPreview({ name: o.path, text: r.text, truncated: r.truncated, binary: false });
                    } catch (e) {
                      if (current === ticket.current) setError((e as Error).message);
                    } finally {
                      if (current === ticket.current) setBusy(false);
                    }
                  }}
                >
                  Preview {o.path.split('/').pop()}
                </button>
              ))}
          </div>
          {error && <p role="alert">{error}</p>}
          <FilePreviewPane preview={preview} loading={busy} />
          <Disclosure>
            <p>Assignment {chosen.id}</p>
            <p>Job {job?.id ?? 'None'}</p>
            <p>{job?.outputs.map(o => `${o.path} · ${o.sha256}`).join('\n')}</p>
          </Disclosure>
        </Drawer>
      )}
    </section>
  );
}
