import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Box, FileText, FileCode, Table } from 'lucide-react';
import type { AppState, Experiment, FileActionResult, Project } from '../shared/types';
import { Empty, SearchField, Checkbox } from './components';
import { projectJobOutputs } from './job-outputs';
import { FilePreviewPane, type FilePreview } from './file-preview';
import { timeAgo } from './status';
import './explorer.css';

export function humanBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
export function ArtifactsPage({
  state,
  project,
  projectId,
  experiment,
  busy,
  files,
  setPreview,
  onError,
}: {
  state: AppState;
  project: Project | undefined;
  projectId: string;
  experiment: Experiment | undefined;
  busy: boolean;
  files: (action: () => Promise<FileActionResult>) => void;
  setPreview: (preview: FilePreview) => void;
  onError: (e: unknown) => void;
}) {
  const [search, setSearch] = useState(''),
    [source, setSource] = useState(''),
    [type, setType] = useState(''),
    [showOld, setShowOld] = useState(false);
  const [selected, setSelected] = useState(''),
    [preview, setLocalPreview] = useState<FilePreview | null>(null),
    [loading, setLoading] = useState(false);
  const ticket = useRef(0);
  useEffect(() => {
    ticket.current++;
    setSelected('');
    setLocalPreview(null);
    setLoading(false);
  }, [projectId, experiment?.id]);
  useEffect(
    () => () => {
      ticket.current++;
    },
    [],
  );
  const imported = state.artifacts.filter(
    a => a.projectId === projectId && (!experiment || a.experimentId === experiment.id),
  );
  const outputs = projectJobOutputs(state, projectId).filter(
    g => !experiment || state.requests?.find(r => r.id === g.requestId)?.experimentId === experiment.id,
  );
  const rows = [
    ...imported.map(a => ({
      key: a.id,
      name: a.name,
      context: `Imported · ${a.kind.toLowerCase()} · ${a.status.toLowerCase()}`,
      bytes: a.size,
      hash: a.sha256,
      source: 'imported',
      old: false,
      time: a.createdAt,
      read: async () => ({ name: a.name, ...(await window.office.previewArtifact(a.id)) }),
    })),
    ...outputs.flatMap(g =>
      g.hops.flatMap(h =>
        h.outputs.map(o => ({
          key: `${o.jobId}:${o.path}:${o.sha256}`,
          name: o.path,
          context: `${g.requestName} · ${h.agentName} · ${h.pipelineKey ?? 'Direct dispatch'} · attempt ${o.attempt}${o.superseded ? ' · superseded' : ''}${g.requestStatus === 'CANCELED' ? ' · request canceled' : ''}`,
          bytes: o.bytes,
          hash: o.sha256,
          source: 'output',
          old: o.superseded,
          time: (state.jobs ?? []).find(j => j.id === o.jobId)?.createdAt ?? '',
          read: async () => ({
            name: o.path,
            ...(await window.office.jobOutputPreview({ jobId: o.jobId, path: o.path })),
            binary: false,
          }),
        })),
      ),
    ),
  ];
  const extension = (name: string) => {
    const base = name.split(/[\\/]/).pop() ?? '';
    return base.includes('.') ? (base.split('.').pop()?.toLowerCase() ?? '') : '';
  };
  const visible = rows.filter(
    r =>
      (showOld || !r.old) &&
      (!source || r.source === source) &&
      (!type || extension(r.name) === type) &&
      `${r.name} ${r.context}`.toLowerCase().includes(search.toLowerCase()),
  );
  async function choose(row: (typeof rows)[number]) {
    const current = ++ticket.current;
    setSelected(row.key);
    setLoading(true);
    setLocalPreview(null);
    try {
      const value = await row.read();
      if (current === ticket.current) setLocalPreview(value);
    } catch (e) {
      if (current === ticket.current) onError(e);
    } finally {
      if (current === ticket.current) setLoading(false);
    }
  }
  return (
    <section className="artifact-explorer">
      <div className="section-toolbar artifact-toolbar">
        <span>
          {imported.length} imported · {rows.length - imported.length} agent outputs
        </span>
        <div className="button-row">
          <button
            className="secondary"
            disabled={busy || project?.archived}
            onClick={() =>
              files(() =>
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
              files(() =>
                window.office.importFiles({ projectId, experimentId: experiment?.id || null, kind: 'RESULT' }),
              )
            }
          >
            Import my results
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => files(() => window.office.exportProject(projectId))}
          >
            <ArrowUpFromLine size={15} />
            Export project
          </button>
        </div>
      </div>
      <p className="muted">
        Stored evidence and agent outputs. Byte integrity does not verify findings; imported results keep their recorded
        provenance.
      </p>
      <div className="explorer-filters">
        <SearchField value={search} onChange={setSearch} placeholder="Search files or agents" />
        <select aria-label="File source" value={source} onChange={e => setSource(e.target.value)}>
          <option value="">All sources</option>
          <option value="imported">Imported files</option>
          <option value="output">Agent outputs</option>
        </select>
        <select aria-label="File type" value={type} onChange={e => setType(e.target.value)}>
          <option value="">All file types</option>
          {[...new Set(rows.map(r => extension(r.name)))].sort().map(t => (
            <option key={t} value={t}>
              {t || 'No extension'}
            </option>
          ))}
        </select>
        <Checkbox checked={showOld} onChange={setShowOld}>
          Include superseded attempts
        </Checkbox>
      </div>
      {!rows.length ? (
        <Empty
          icon={Box}
          title="A cabinet for your evidence"
          description="Import references or results. Agent files appear after the office stores their outputs."
        />
      ) : (
        <div className="explorer-layout">
          <div className="explorer-files" aria-label="Files">
            <p className="muted">{visible.length} matching files</p>
            {!visible.length && <p>No files match these filters.</p>}
            {visible.map(row => {
              const ext = extension(row.name),
                Icon = ext === 'csv' ? Table : ['ts', 'js', 'py', 'json'].includes(ext) ? FileCode : FileText;
              return (
                <button
                  key={row.key}
                  className={`file-row${selected === row.key ? ' selected' : ''}`}
                  aria-pressed={selected === row.key}
                  onClick={() => void choose(row)}
                >
                  <Icon size={18} />
                  <span>
                    <strong>{row.name}</strong>
                    <small>{row.context}</small>
                    <small>
                      {humanBytes(row.bytes)} · {row.time && timeAgo(row.time)} ·{' '}
                      <code title={row.hash}>{row.hash.slice(0, 12)}…</code>
                    </small>
                  </span>
                  <span>Preview</span>
                </button>
              );
            })}
          </div>
          <FilePreviewPane preview={preview} loading={loading} onOpen={() => preview && setPreview(preview)} />
        </div>
      )}
    </section>
  );
}
