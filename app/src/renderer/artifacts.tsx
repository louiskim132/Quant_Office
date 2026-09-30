import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Box, FileText, FileCode, Search, Table } from 'lucide-react';
import type { AppState, Experiment, FileActionResult, Project } from '../shared/types';
import { Empty, Checkbox } from './components';
import { projectJobOutputs } from './job-outputs';
import { FilePreviewPane, type FilePreview } from './file-preview';
import { formatDateTime, plural } from './format';
import { timeAgo } from './status';
import './explorer.css';

export function humanBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export type ArtifactGroupBy = 'none' | 'kind' | 'project' | 'source';

/** The displayable metadata one listed artifact row carries — an imported record or a stored output. */
export interface ArtifactExplorerRow {
  key: string;
  name: string;
  context: string;
  bytes: number;
  hash: string;
  /** 'imported' for user-imported records, 'output' for stored agent outputs. */
  source: 'imported' | 'output';
  old: boolean;
  time: string;
  /** The record's kind for imports ('REFERENCE'/'RESULT'); 'OUTPUT' marks stored agent outputs. */
  kind: string;
  projectName: string;
  experimentName: string;
  /** The producing agent for outputs; empty for user imports. */
  producer: string;
}

/**
 * Every listed-metadata word a query can hit — name/path, kind, hash (so any prefix matches),
 * provenance context, project and experiment labels, and the recorded timestamp in ISO and the UI
 * locale. Byte content is never searched; no such IPC exists.
 */
export function artifactSearchText(row: ArtifactExplorerRow): string {
  const stamp = row.time ? `${row.time} ${formatDateTime(row.time)}` : '';
  return [
    row.name,
    row.context,
    row.kind,
    row.source,
    row.producer,
    row.projectName,
    row.experimentName,
    row.hash,
    stamp,
  ].join(' ');
}

export function artifactMatches(row: ArtifactExplorerRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || artifactSearchText(row).toLowerCase().includes(q);
}

/**
 * The group heading for one row under `by` — every name comes from a recorded field. Imported
 * records carry no origin beyond their kind, so 'source' groups them as user imports and outputs
 * by their recorded producing agent; no lineage is invented.
 */
export function artifactGroupName(row: ArtifactExplorerRow, by: Exclude<ArtifactGroupBy, 'none'>): string {
  if (by === 'kind')
    return row.kind === 'OUTPUT' ? 'Agent output' : `${row.kind.charAt(0)}${row.kind.slice(1).toLowerCase()} import`;
  if (by === 'project') return row.projectName || 'No project recorded';
  return row.source === 'imported'
    ? `Imported ${row.kind.toLowerCase()}`
    : `Produced by ${row.producer || 'an unrecorded agent'}`;
}

export interface ArtifactGroup<T> {
  label: string;
  count: number;
  rows: T[];
}

/** Re-bucket rows under `by`, preserving row order inside each group; 'none' keeps one flat list. */
export function groupArtifacts<T extends ArtifactExplorerRow>(
  rows: readonly T[],
  by: ArtifactGroupBy,
): ArtifactGroup<T>[] {
  if (by === 'none') return [{ label: '', count: rows.length, rows: [...rows] }];
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = artifactGroupName(row, by);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  return [...buckets.entries()].map(([label, bucket]) => ({ label, count: bucket.length, rows: bucket }));
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
    [groupBy, setGroupBy] = useState<ArtifactGroupBy>('none'),
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
  const experimentName = (id: string | null | undefined) =>
    id ? (state.experiments.find(e => e.id === id)?.name ?? '') : '';
  const rows: (ArtifactExplorerRow & { read: () => Promise<FilePreview> })[] = [
    ...imported.map(a => ({
      key: a.id,
      name: a.name,
      context: `Imported · ${a.kind.toLowerCase()} · ${a.status.toLowerCase()}`,
      bytes: a.size,
      hash: a.sha256,
      source: 'imported' as const,
      old: false,
      time: a.createdAt,
      kind: a.kind,
      projectName: project?.name ?? '',
      experimentName: experimentName(a.experimentId),
      producer: '',
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
          source: 'output' as const,
          old: o.superseded,
          time: (state.jobs ?? []).find(j => j.id === o.jobId)?.createdAt ?? '',
          kind: 'OUTPUT',
          projectName: project?.name ?? '',
          experimentName: experimentName(state.requests?.find(r => r.id === g.requestId)?.experimentId),
          producer: h.agentName,
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
      artifactMatches(r, search),
  );
  const groups = groupArtifacts(visible, groupBy);
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
          {plural(imported.length, 'imported file')} · {plural(rows.length - imported.length, 'agent output')}
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
        <label
          className="search-field"
          title="Searches the listed records' names, paths, kinds, hashes, project/experiment labels and timestamps — never file contents"
        >
          <Search size={15} />
          <input
            aria-label="Search listed artifacts — search files or agents"
            placeholder="Search listed artifacts"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </label>
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
        <select
          aria-label="Group artifacts"
          value={groupBy}
          onChange={e => setGroupBy(e.target.value as ArtifactGroupBy)}
        >
          <option value="none">Group by: none</option>
          <option value="kind">Group by: kind</option>
          <option value="project">Group by: project</option>
          <option value="source">Group by: source</option>
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
          action={
            <button
              className="primary"
              disabled={busy || project?.archived}
              onClick={() =>
                files(() =>
                  window.office.importFiles({ projectId, experimentId: experiment?.id || null, kind: 'REFERENCE' }),
                )
              }
            >
              Import your first references
            </button>
          }
        />
      ) : (
        <div className="explorer-layout">
          <div className="explorer-files" aria-label="Files">
            <p className="muted">
              {visible.length === rows.length
                ? plural(rows.length, 'file')
                : `${visible.length} of ${rows.length} files shown`}
            </p>
            {!visible.length && <p>No files match these filters. Widen the search or clear the filters.</p>}
            {groups.map(group => (
              <section className="explorer-group" key={group.label || 'all'}>
                {group.label && (
                  <h3 className="explorer-group-label muted">
                    {group.label} · {plural(group.count, 'file')}
                  </h3>
                )}
                {group.rows.map(row => {
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
              </section>
            ))}
          </div>
          <FilePreviewPane preview={preview} loading={loading} onOpen={() => preview && setPreview(preview)} />
        </div>
      )}
    </section>
  );
}
