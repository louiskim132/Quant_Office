import { OfficeChat } from './office-chat';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Box,
  Check,
  ChevronRight,
  Circle,
  Folder,
  FolderPlus,
  History,
  LayoutDashboard,
  LockKeyhole,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type {
  AppInfo,
  AppState,
  Command,
  Experiment,
  ResearchContract,
  Role,
  WorkType,
  WorkMode,
} from '../shared/types';
import './tokens.css';
import './styles.css';
import { requestQueue } from '../shared/queue';
import { AgentRoster, ProfileEditor, ConnectionBinding } from './office';
import { OfficeScene } from './office-scene';
import { useOfficeActivity } from './use-activity';
import { AgentDrawer } from './agent-drawer';
import { WorkQueue } from './queue';
import { AgentSetup, AgentIsolation, ProviderConnections, SubscriptionUsage } from './agents';
import { ProjectsView } from './projects';
import { HistoryView } from './history';
import { ResearchView } from './research';
import { ProfileTabs } from './profile';
import { AgentDetails, ModelEffortEditor } from './activity';
import { MemoryView } from './memory';
import { ArtifactsPage } from './artifacts';
import { ReviewsView } from './review';
import { Empty, label } from './components';

type Page =
  | 'Agents'
  | 'Office'
  | 'Projects'
  | 'Reviews'
  | 'Artifacts'
  | 'Memory'
  | 'History'
  | 'Usage'
  | 'Settings'
  | 'Add Agent';
type CommandInput = Command extends infer C ? (C extends Command ? Omit<C, 'idempotencyKey'> : never) : never;
const navSections = [
  [
    'WORKSPACE',
    [
      ['Office', LayoutDashboard],
      ['Agents', Users],
      ['Projects', Folder],
    ],
  ],
  [
    'RESEARCH',
    [
      ['Reviews', ShieldCheck],
      ['Artifacts', Box],
      ['Memory', Network],
    ],
  ],
  ['RECORDS', [['History', History]]],
  [
    'SYSTEM',
    [
      ['Usage', Wallet],
      ['Settings', Settings2],
    ],
  ],
] as const;
const roles: { role: Role; label: string; title: string; scope: string; color: string }[] = [
  {
    role: 'DIRECTOR',
    label: 'Director',
    title: 'Research direction',
    scope: 'Defines research contracts, priorities, and final decisions.',
    color: 'amber',
  },
  {
    role: 'PM_A',
    label: 'PM · A',
    title: 'Implementation',
    scope: 'Owns implementation and integration of research work.',
    color: 'teal',
  },
  {
    role: 'PM_B',
    label: 'PM · B',
    title: 'Verification',
    scope: 'Independently verifies code, evidence, and reproducibility.',
    color: 'blue',
  },
  {
    role: 'PM_C',
    label: 'PM · C',
    title: 'Findings',
    scope: 'Interprets statistical evidence and research findings.',
    color: 'purple',
  },
  {
    role: 'PM_D',
    label: 'PM · D',
    title: 'Falsification',
    scope: 'Challenges assumptions, robustness, and economic value.',
    color: 'rose',
  },
  {
    role: 'WORKER',
    label: 'Worker · 01',
    title: 'Research execution',
    scope: 'Completes bounded tasks under a project manager.',
    color: 'neutral',
  },
  {
    role: 'WORKER',
    label: 'Worker · 02',
    title: 'Research execution',
    scope: 'Completes bounded tasks under a project manager.',
    color: 'neutral',
  },
];
const date = (d: string) =>
  new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const savedId = (key: string) => {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
};

/**
 * The request.create command assembled from the New-request form, kept pure so the honesty rules
 * are testable: analysisOfRequestId rides the command only when a plan was actually picked — the
 * select's default is the explicit empty 'None' option — and a grouping mode lands only on
 * OTHER-type requests. Takes the FormData surface it reads, not the element.
 */
export function requestCreatePayload(form: Pick<FormData, 'get' | 'getAll'>, mode: WorkMode): CommandInput {
  const workType = String(form.get('workType')) as WorkType;
  return {
    type: 'request.create',
    projectId: String(form.get('requestProjectId')),
    name: String(form.get('name')).trim(),
    hypothesis: String(form.get('hypothesis')).trim(),
    workType,
    mode: workType === 'OTHER' ? mode : 'SINGLE',
    leadAgentId: String(form.get('leadAgentId')) || null,
    participantIds: form.getAll('participantIds').map(String),
    acceptanceCriteria: String(form.get('acceptanceCriteria') ?? ''),
    ...(workType === 'RESULT_ANALYSIS' && form.get('analysisOfRequestId')
      ? { analysisOfRequestId: String(form.get('analysisOfRequestId')) }
      : {}),
  };
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [page, setPage] = useState<Page>('Office');
  const [projectId, setProjectId] = useState(() => savedId('quant-project'));
  const [experimentId, setExperimentId] = useState(() => savedId('quant-experiment'));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'project' | 'edit-project' | 'experiment' | null>(null);
  const [agentDetailId, setAgentDetailId] = useState<string | null>(null);
  /** The agent whose side drawer is open — a quick look, distinct from the full profile dialog. */
  const [drawerAgentId, setDrawerAgentId] = useState<string | null>(null);
  /** The request whose detail panel is open on the Office page. */
  const [openRequestId, setOpenRequestId] = useState<string | null>(null);
  const [localFolder, setLocalFolder] = useState<string | null>(null);
  const [requestMode, setRequestMode] = useState<WorkMode>('SINGLE');
  const [requestWorkType, setRequestWorkType] = useState<WorkType>('PLANNING');
  /** The project picked in the New request dialog — '' until the user changes the select. */
  const [requestProject, setRequestProject] = useState('');
  const [preview, setPreview] = useState<{ name: string; text: string; truncated: boolean; binary: boolean } | null>(
    null,
  );
  const { activity, now } = useOfficeActivity(state);
  const project = state?.projects.find(p => p.id === projectId);
  const experiments = state?.experiments.filter(e => e.projectId === projectId) || [];
  const experiment = experiments.find(e => e.id === experimentId);
  const blockedRequests = state ? requestQueue(state).filter(r => r.status === 'BLOCKED').length : 0;
  const scopedArtifacts =
    state?.artifacts.filter(a => a.projectId === projectId && (!experiment || a.experimentId === experiment.id)) || [];
  const scopedEvents = state?.events.filter(e => !project || e.projectId === projectId || e.projectId === null) || [];
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const acceptState = (next: AppState) =>
    setState(previous => (previous && previous.events.length > next.events.length ? previous : next));
  async function refresh() {
    try {
      if (!window.office)
        throw new Error('Desktop connection unavailable. Open Quant Research Office from the desktop application.');
      acceptState(await window.office.getState());
    } catch (e) {
      fail(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    if (!window.office) return;
    void window.office.getInfo().then(setInfo).catch(fail);
    return window.office.onChanged(() => {
      void refresh();
    });
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('quant-project', projectId);
      localStorage.setItem('quant-experiment', experimentId);
    } catch {}
  }, [projectId, experimentId]);
  // A removed project stays in the record but leaves every picker, including the selected-project state.
  useEffect(() => {
    if (project?.removedAt) chooseProject('');
  }, [project?.removedAt]);
  useEffect(() => {
    if (modal === 'experiment') setRequestProject('');
  }, [modal]);
  useEffect(() => {
    if (state) {
      document.documentElement.dataset.theme = state.settings.theme;
      document.documentElement.dataset.motion = state.settings.reducedMotion ? 'reduced' : 'full';
    }
  }, [state?.settings]);
  useEffect(() => {
    document.querySelector('main')?.scrollTo(0, 0);
  }, [page]);
  async function command(input: CommandInput, success?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await window.office.command({ ...input, idempotencyKey: crypto.randomUUID() } as Command);
      acceptState(next);
      if (success) setNotice(success);
      return next;
    } catch (e) {
      fail(e);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function files(action: () => ReturnType<typeof window.office.backupWorkspace>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await action();
      acceptState(result.state);
      if (!result.canceled) setNotice(result.message);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  function chooseProject(id: string) {
    setProjectId(id);
    setExperimentId('');
  }
  useEffect(() => {
    setLocalFolder(null);
  }, [modal]);
  // The location record is the scope the snapshot scan reads; the project field is the display copy.
  // Seeding the dialog from the record keeps Edit project showing the folder that is actually shared.
  const savedScopeFolder =
    state?.locations?.find(l => l.projectId === project?.id)?.localFolder ?? project?.localFolder ?? '';
  async function submitProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const data = {
        name: String(form.get('name')).trim(),
        mandate: String(form.get('mandate')).trim(),
        budgetCents: project?.budgetCents ?? 0,
        localFolder: localFolder ?? (modal === 'edit-project' ? savedScopeFolder : ''),
        cloudWorkspace: String(form.get('cloudWorkspace') ?? ''),
      };
      if (!data.name) throw new Error('Give the project a name.');
      const next = await command(
        modal === 'edit-project' && project
          ? { type: 'project.update', projectId, ...data }
          : { type: 'project.create', ...data },
        modal === 'edit-project' ? 'Project updated.' : 'Project created. Your office is ready for research planning.',
      );
      if (next) {
        if (modal !== 'edit-project') {
          const created = next.projects.find(p => !state?.projects.some(old => old.id === p.id));
          if (created) chooseProject(created.id);
        }
        setModal(null);
      }
    } catch (e) {
      fail(e);
    }
  }
  async function submitExperiment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!String(form.get('name')).trim()) {
      setError('Give the experiment a name.');
      return;
    }
    const next = await command(requestCreatePayload(form, requestMode));
    if (next) {
      setProjectId(String(form.get('requestProjectId')));
      const created = next.experiments.find(e => !state?.experiments.some(old => old.id === e.id));
      if (created) setExperimentId(created.id);
      setNotice(
        created
          ? "Draft saved. Find it in the Office work queue or as an experiment tab on the project's workspace."
          : 'Draft saved. Find it in the Office work queue.',
      );
      setModal(null);
    }
  }
  const needProject = (content: React.ReactNode) =>
    project ? (
      content
    ) : (
      <Empty
        icon={FolderPlus}
        title="A home for your research"
        description="Create or select a project to organize experiments, requests, and evidence."
        action={
          <button className="primary" onClick={() => setModal('project')}>
            <Plus size={15} />
            Create project
          </button>
        }
      />
    );

  if (loading)
    return (
      <div className="startup">
        <div className="brand-mark">
          <Box size={26} />
        </div>
        <h2>Opening your research office</h2>
        <p>Loading the local research record…</p>
      </div>
    );
  if (!state)
    return (
      <div className="startup">
        <div className="brand-mark">
          <Box size={26} />
        </div>
        <h2>Office unavailable</h2>
        <p role="alert">{error}</p>
        <button
          className="primary"
          onClick={() => {
            setError('');
            setLoading(true);
            void refresh();
          }}
        >
          <RefreshCw size={15} />
          Try again
        </button>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Box size={22} />
          </div>
          <div>
            QUANT<span>RESEARCH OFFICE</span>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {navSections.map(([section, items]) => (
            <React.Fragment key={section}>
              <div className="sidebar-section-label">{section}</div>
              {items.map(([name, Icon]) => (
                <button
                  key={name}
                  className={`nav-item ${page === name ? 'active' : ''}`}
                  aria-current={page === name ? 'page' : undefined}
                  onClick={() => {
                    setPage(name);
                    setNotice('');
                    if (name === 'Projects') chooseProject('');
                  }}
                >
                  <Icon size={18} />
                  <span>{name}</span>
                  {name === 'Office' && blockedRequests > 0 && <b>{blockedRequests}</b>}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            className={`sidebar-action ${page === 'Add Agent' ? 'active' : ''}`}
            onClick={() => setPage('Add Agent')}
          >
            <Plus size={15} />
            Add agent
          </button>
          <div className="environment">
            <span className="status-dot" />
            Local workspace
          </div>
          <p>Agents run on this computer through the official provider CLIs.</p>
          <span className="version">DESKTOP · {info?.version || 'INITIAL RELEASE'}</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="context-selector">
            <Folder size={16} />
            <select
              aria-label="Current project"
              value={project?.id || ''}
              onChange={e => {
                const id = e.target.value;
                if (id) {
                  chooseProject(id);
                  setPage('Projects');
                } else chooseProject('');
              }}
            >
              <option value="">Select a project</option>
              {state.projects
                .filter(p => !p.removedAt)
                .map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.archived ? ' (archived)' : ''}
                  </option>
                ))}
            </select>
            <ChevronRight size={14} />
            <select
              aria-label="Current experiment"
              disabled={!project}
              value={experiment?.id || ''}
              onChange={e => setExperimentId(e.target.value)}
            >
              <option value="">All experiments</option>
              {experiments.map(e => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div className="topbar-right">
            <span className="provider-status">
              <span className="status-dot off" />
              {state.agents.filter(a => !a.removedAt).length} agents registered
            </span>
            <button className="spend-pill" onClick={() => setPage('Usage')}>
              <Wallet size={14} />
              Subscription usage
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">{page === 'Office' ? 'YOUR RESEARCH WORKSPACE' : 'QUANT RESEARCH OFFICE'}</div>
              <h1>{page === 'Office' ? 'The office' : page}</h1>
              <p>
                {
                  {
                    Agents: 'Your team, profiles, and membership. Archived agents retain their history.',
                    Office: 'A place for better questions. A team for rigorous answers.',
                    Projects: 'Independent research spaces, with a clear mandate.',
                    Reviews: 'Independent positions, traceable evidence, and recorded decisions.',
                    Artifacts: 'The inputs and outputs that make research reproducible.',
                    Memory:
                      'Office-recorded findings and proposed links — session and user reports, not provider-verified facts.',
                    History: 'A persistent record of decisions and changes.',
                    Usage: 'Your shared subscription allowances and reset times.',
                    Settings: 'Your desktop workspace preferences.',
                    'Add Agent': '',
                  }[page]
                }
              </p>
            </div>
            {page !== 'Add Agent' && (
              <div className="heading-actions">
                {page === 'Projects' ? (
                  <>
                    {!project && state.projects.some(p => !p.archived && !p.removedAt) && (
                      <button className="primary" onClick={() => setModal('experiment')}>
                        <Plus size={16} />
                        New request
                      </button>
                    )}
                    <button
                      className={state.projects.some(p => !p.archived && !p.removedAt) ? 'secondary' : 'primary'}
                      onClick={() => setModal('project')}
                    >
                      <Plus size={16} />
                      New project
                    </button>
                  </>
                ) : page === 'Office' ? (
                  <span className="quiet-badge">
                    <Circle size={12} />
                    Setup mode
                  </span>
                ) : null}
              </div>
            )}
          </div>
          {error && (
            <div className="notice error" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="notice success" role="status">
              <Check size={16} />
              <span>{notice}</span>
              <button aria-label="Dismiss notice" onClick={() => setNotice('')}>
                <X size={16} />
              </button>
            </div>
          )}
          {page === 'Office' && (
            <>
              <div className="office-live-layout">
                <OfficeScene
                  agents={state.agents}
                  activity={activity}
                  now={now}
                  requests={state.requests}
                  onAgent={setDrawerAgentId}
                />
                <OfficeChat state={state} />
              </div>
              <WorkQueue
                onState={acceptState}
                onAction={c => void command(c)}
                state={state}
                busy={busy}
                onNew={() =>
                  state.projects.some(p => !p.archived && !p.removedAt) ? setModal('experiment') : setModal('project')
                }
                onOpen={e => {
                  setProjectId(e.projectId);
                  setExperimentId(e.id);
                  setPage('Projects');
                }}
                onCancel={id =>
                  void command({ type: 'task.cancel', taskId: id }, 'Request and linked research canceled.')
                }
                openRequestId={openRequestId}
                onOpenRequest={setOpenRequestId}
              />
            </>
          )}
          {page === 'Agents' && (
            <AgentRoster
              state={state}
              busy={busy}
              onAgent={setAgentDetailId}
              onAdd={() => setPage('Add Agent')}
              onRemove={(id, removed) => void command({ type: 'agent.remove', agentId: id, removed })}
              onDelete={id => void command({ type: 'agent.delete', agentId: id })}
            />
          )}
          {page === 'Projects' &&
            (project ? (
              <ResearchView
                state={state}
                project={project}
                projectId={projectId}
                experiments={experiments}
                experiment={experiment}
                experimentId={experimentId}
                busy={busy}
                command={command}
                onSelectExperiment={setExperimentId}
                onBack={() => chooseProject('')}
                onEditProject={() => setModal('edit-project')}
                onNewRequest={() => setModal('experiment')}
                onState={acceptState}
                onOpenQueue={requestId => {
                  setPage('Office');
                  if (requestId) setOpenRequestId(requestId);
                }}
              />
            ) : (
              <ProjectsView
                state={state}
                project={project}
                projectId={projectId}
                onState={acceptState}
                onOpenProject={id => chooseProject(id)}
                onNewProject={() => setModal('project')}
                onError={fail}
              />
            ))}
          {page === 'Reviews' &&
            needProject(
              <ReviewsView
                state={state}
                projectId={projectId}
                experiment={experiment}
                busy={busy}
                setPreview={setPreview}
                onError={fail}
              />,
            )}
          {page === 'Artifacts' &&
            needProject(
              <ArtifactsPage
                state={state}
                project={project}
                projectId={projectId}
                experiment={experiment}
                busy={busy}
                files={files}
                setBusy={setBusy}
                setPreview={setPreview}
                onError={fail}
              />,
            )}
          {page === 'Memory' && needProject(<MemoryView state={state} projectId={projectId} />)}
          {page === 'History' && <HistoryView state={state} projectId={projectId || null} label={label} date={date} />}
          {page === 'Usage' && <SubscriptionUsage state={state} />}
          {page === 'Settings' && (
            <>
              <ProviderConnections state={state} />
              <AgentIsolation />
              <div className="settings-card">
                <h2>Appearance</h2>
                <div className="setting-row">
                  <div>
                    <strong>Theme</strong>
                    <p>Choose the appearance of your desktop workspace.</p>
                  </div>
                  <select
                    aria-label="Theme"
                    value={state.settings.theme}
                    disabled={busy}
                    onChange={e =>
                      void command({
                        type: 'settings.update',
                        settings: { ...state.settings, theme: e.target.value as 'dark' | 'light' },
                      })
                    }
                  >
                    <option value="dark">Warm dark</option>
                    <option value="light">Light</option>
                  </select>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Reduce motion</strong>
                    <p>Keep workspace transitions to a minimum.</p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={state.settings.reducedMotion}
                    aria-label="Reduce motion"
                    className={`switch ${state.settings.reducedMotion ? 'on' : ''}`}
                    disabled={busy}
                    onClick={() =>
                      void command({
                        type: 'settings.update',
                        settings: { ...state.settings, reducedMotion: !state.settings.reducedMotion },
                      })
                    }
                  >
                    <span />
                  </button>
                </div>
              </div>
              <div className="settings-card">
                <h2>Data & recovery</h2>
                <div className="setting-row">
                  <div>
                    <strong>Workspace backup</strong>
                    <p>Save a portable copy of the local record and stored artifacts.</p>
                  </div>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void files(() => window.office.backupWorkspace())}
                  >
                    <ArrowUpFromLine size={15} />
                    Create backup
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Restore a backup</strong>
                    <p>Choose a saved workspace to restore. Your current workspace is retained as a recovery copy.</p>
                  </div>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void files(() => window.office.restoreWorkspace())}
                  >
                    <ArrowDownToLine size={15} />
                    Restore backup
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Legacy records</strong>
                    <p>
                      Give old task records a native request. The workspace is copied first and the migration is
                      verified by replay; historical outcomes stay marked as never observed.
                    </p>
                  </div>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      void window.office
                        .migrateLegacyRecords()
                        .then(result => {
                          acceptState(result.state);
                          setNotice(
                            result.migrated
                              ? `Migrated ${result.migrated} legacy record${result.migrated === 1 ? '' : 's'} as drafts carrying an explicit ambiguity blocker.`
                              : 'No legacy records needed migrating.',
                          );
                        })
                        .catch(error => setNotice(error.message));
                    }}
                  >
                    Migrate legacy records
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>Data location</strong>
                    <p className="path-text">{info?.dataDirectory || 'Unavailable'}</p>
                  </div>
                </div>
              </div>
              <div className="settings-card">
                <h2>Execution boundaries</h2>
                <div className="boundary-grid">
                  <div>
                    <span className="boundary-number">01</span>
                    <strong>This desktop</strong>
                    <p>Prompts, task routing, local records, and explicit file transfers.</p>
                  </div>
                  <div>
                    <span className="boundary-number">02</span>
                    <strong>Provider infrastructure</strong>
                    <p>All agent reasoning, coding, verification, and research calculations.</p>
                  </div>
                  <div>
                    <span className="boundary-number">03</span>
                    <strong>Your Colab session</strong>
                    <p>Manual execution by you. No agent access or integration.</p>
                  </div>
                </div>
              </div>
            </>
          )}
          {page === 'Add Agent' && (
            <AgentSetup
              onAdded={(next, execution) => {
                acceptState(next);
                setPage('Office');
                setNotice(
                  execution === 'LOCAL'
                    ? 'Agent added. Sessions run on this machine through the official CLI; no local transport is configured in this build, so dispatch stays blocked.'
                    : 'Agent added. Hosted research execution remains blocked until configured.',
                );
              }}
            />
          )}
        </main>
        <footer className="statusbar">
          <span>
            <span className="status-dot" />
            Local record ready
          </span>
          <span>
            {state.agents.filter(a => !a.removedAt).length} registered agents
            <span className="statusbar-divider">|</span>
            {blockedRequests} blocked requests · all projects<span className="statusbar-divider">|</span>No active
            provider jobs
          </span>
        </footer>
      </div>
      {drawerAgentId && state.agents.find(a => a.id === drawerAgentId) && (
        <AgentDrawer
          key={drawerAgentId}
          agent={state.agents.find(a => a.id === drawerAgentId)!}
          activity={activity.find(a => a.agentId === drawerAgentId)}
          state={state}
          now={now}
          onClose={() => setDrawerAgentId(null)}
          onState={acceptState}
          onProfile={id => setAgentDetailId(id)}
          onOpenRequest={requestId => {
            if (!state.requests?.some(item => item.id === requestId)) return;
            setPage('Office');
            setOpenRequestId(requestId);
            setDrawerAgentId(null);
          }}
        />
      )}
      {agentDetailId && state.agents.find(a => a.id === agentDetailId) && (
        <Dialog
          wide
          title={state.agents.find(a => a.id === agentDetailId)!.name}
          onClose={() => setAgentDetailId(null)}
        >
          <ProfileTabs
            key={agentDetailId + ':tabs'}
            agent={state.agents.find(a => a.id === agentDetailId)!}
            state={state}
            onState={acceptState}
          >
            <ProfileEditor
              key={agentDetailId}
              agent={state.agents.find(a => a.id === agentDetailId)!}
              onState={acceptState}
            />
            <ModelEffortEditor
              key={agentDetailId + ':effort'}
              agent={state.agents.find(a => a.id === agentDetailId)!}
              onState={acceptState}
            />
            <ConnectionBinding
              key={agentDetailId + ':binding'}
              agent={state.agents.find(a => a.id === agentDetailId)!}
              state={state}
              onState={acceptState}
            />
            <AgentDetails
              key={agentDetailId}
              agent={state.agents.find(a => a.id === agentDetailId)!}
              state={state}
              onState={acceptState}
            />
          </ProfileTabs>
        </Dialog>
      )}
      {modal && (
        <Dialog
          title={
            modal === 'experiment' ? 'New request' : modal === 'edit-project' ? 'Edit project' : 'Create a project'
          }
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          <form onSubmit={modal === 'experiment' ? submitExperiment : submitProject}>
            <p className="dialog-description">
              {modal === 'experiment'
                ? 'Save a draft, then Start request to check readiness.'
                : 'A project keeps its experiments and evidence together.'}
            </p>
            <label className="field">
              {modal === 'experiment' ? 'Request name' : 'Project name'}
              <input
                name="name"
                autoFocus
                maxLength={160}
                aria-label={modal === 'experiment' ? 'Request name' : 'Project name'}
                defaultValue={modal === 'edit-project' ? project?.name : ''}
                placeholder={
                  modal === 'experiment'
                    ? 'e.g. Out-of-sample volatility forecast'
                    : 'e.g. Volatility forecasting research'
                }
                required
              />
            </label>
            <label className="field">
              {modal === 'experiment' ? 'Objective' : 'Research mandate'}
              <textarea
                name={modal === 'experiment' ? 'hypothesis' : 'mandate'}
                aria-label={modal === 'experiment' ? 'Objective' : 'Research mandate'}
                defaultValue={modal === 'edit-project' ? project?.mandate : ''}
                maxLength={modal === 'experiment' ? 12000 : 20000}
                rows={4}
                placeholder={
                  modal === 'experiment'
                    ? 'What do you expect to observe, and why?'
                    : 'What should this project investigate?'
                }
                required
              />
            </label>
            {modal !== 'experiment' && (
              <>
                <label className="field">
                  Project folder on this device
                  <button
                    type="button"
                    className="browse-field"
                    onClick={() =>
                      void window.office
                        .chooseProjectFolder()
                        .then(folder => {
                          if (folder) setLocalFolder(folder);
                        })
                        .catch(fail)
                    }
                  >
                    <Folder size={14} />
                    {(localFolder ?? (modal === 'edit-project' ? savedScopeFolder : '')) ? (
                      <span className="path-text browse-field-value" title={localFolder ?? savedScopeFolder}>
                        {localFolder ?? savedScopeFolder}
                      </span>
                    ) : (
                      <span className="browse-field-empty">Choose a folder…</span>
                    )}
                    <span className="browse-field-hint">Browse</span>
                  </button>
                </label>
                <label className="field">
                  Cloud workspace reference
                  <input
                    name="cloudWorkspace"
                    maxLength={1000}
                    aria-label="Cloud workspace reference"
                    defaultValue={modal === 'edit-project' ? (project?.cloudWorkspace ?? '') : ''}
                    placeholder="Provider / environment / repository revision"
                  />
                </label>
                <p className="muted">
                  Cloud reference is unverified. Choosing a folder does not upload or execute files. The office database
                  remains in application data.
                </p>
              </>
            )}
            {modal === 'experiment' && (
              <>
                <label className="field">
                  Project
                  <select
                    name="requestProjectId"
                    aria-label="Project"
                    defaultValue={projectId || state.projects.find(p => !p.archived && !p.removedAt)?.id}
                    onChange={e => setRequestProject(e.target.value)}
                  >
                    {state.projects
                      .filter(p => !p.archived && !p.removedAt)
                      .map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field">
                  Work type
                  <select
                    name="workType"
                    aria-label="Work type"
                    value={requestWorkType}
                    onChange={e => setRequestWorkType(e.target.value as WorkType)}
                  >
                    <option value="PLANNING">Planning</option>
                    <option value="RESULT_ANALYSIS">Result analysis</option>
                    <option value="OTHER">Other</option>
                  </select>
                </label>
                {requestWorkType === 'OTHER' ? (
                  <>
                    <label className="field">
                      Execution mode
                      <select
                        aria-label="Execution mode"
                        value={requestMode}
                        onChange={e => setRequestMode(e.target.value as WorkMode)}
                      >
                        <option value="SINGLE">Single agent</option>
                        <option value="GROUP">Selected group</option>
                        <option value="TEAM">Full research team</option>
                      </select>
                    </label>
                    <label className="field">
                      Responsible agent
                      <select name="leadAgentId" aria-label="Responsible agent">
                        <option value="">Choose later</option>
                        {state.agents
                          .filter(a => !a.removedAt)
                          .map(a => (
                            <option key={a.id} value={a.id}>
                              {a.name} · {a.role}
                            </option>
                          ))}
                      </select>
                    </label>
                    {requestMode !== 'SINGLE' && (
                      <label className="field">
                        Collaborators
                        <select multiple name="participantIds" aria-label="Collaborators">
                          {state.agents
                            .filter(a => !a.removedAt)
                            .map(a => (
                              <option key={a.id} value={a.id}>
                                {a.name} · {a.role}
                              </option>
                            ))}
                        </select>
                      </label>
                    )}
                  </>
                ) : (
                  (() => {
                    const live = state.agents.filter(a => !a.removedAt),
                      directors = live.filter(a => a.role === 'DIRECTOR'),
                      choices = directors.length ? directors : live;
                    return (
                      <>
                        <label className="field">
                          Director
                          <select name="leadAgentId" aria-label="Director">
                            <option value="">Choose the director</option>
                            {choices.map(a => (
                              <option key={a.id} value={a.id}>
                                {a.name} · {a.role}
                              </option>
                            ))}
                          </select>
                        </label>
                        {!directors.length && (
                          <p className="muted">
                            No DIRECTOR-role agent is on the roster — any live agent can take the seat.
                          </p>
                        )}
                        <p className="muted">
                          The director shapes the brief first; the pipeline arms launch only after you confirm the
                          shaped brief.
                        </p>
                        {requestWorkType === 'RESULT_ANALYSIS' &&
                          (() => {
                            const target =
                              requestProject || projectId || state.projects.find(p => !p.archived && !p.removedAt)?.id;
                            const plans = (state.requests ?? [])
                              .filter(
                                r =>
                                  r.projectId === target &&
                                  !r.removedAt &&
                                  r.status !== 'CANCELED' &&
                                  r.pipeline?.kind === 'PLANNING',
                              )
                              .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
                            return (
                              <>
                                <label className="field">
                                  Pre-registered analysis plan
                                  <select
                                    name="analysisOfRequestId"
                                    key={target}
                                    aria-label="Pre-registered analysis plan"
                                    defaultValue=""
                                  >
                                    <option value="">None — the director plans the analysis</option>
                                    {plans.map(r => (
                                      <option key={r.id} value={r.id}>
                                        {r.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <p className="muted">
                                  The analysis starts from the analysis plan that planning request fixed before any
                                  result existed.
                                </p>
                              </>
                            );
                          })()}
                      </>
                    );
                  })()
                )}
                <label className="field">
                  Acceptance criteria
                  <textarea name="acceptanceCriteria" aria-label="Acceptance criteria" maxLength={12000} />
                </label>
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => setModal(null)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy
                  ? 'Saving…'
                  : modal === 'experiment'
                    ? 'Save draft'
                    : modal === 'edit-project'
                      ? 'Save changes'
                      : 'Create project'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {preview && (
        <Dialog title={preview.name} wide onClose={() => setPreview(null)}>
          <div className="inline-note">
            <ShieldCheck size={16} />
            <span>Safe text preview. File contents are never executed.</span>
          </div>
          {preview.binary ? (
            <Empty
              icon={Box}
              title="Binary file"
              description="This file is stored as an artifact. A text preview is not available."
            />
          ) : (
            <pre className="artifact-preview">{preview.text || '(Empty file)'}</pre>
          )}
          {preview.truncated && (
            <p className="footnote">Preview truncated. Export the project to inspect the complete file.</p>
          )}
        </Dialog>
      )}
    </div>
  );
}

function Metric({ label: metricLabel, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="metric-card">
      <span className="mini-label">{metricLabel}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}
function Dialog({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog wide' : 'dialog'}
      aria-label={title}
      onCancel={e => {
        e.preventDefault();
        onClose();
      }}
      onClick={e => {
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
      }}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

// The bootstrap is DOM-only — tests import this module for requestCreatePayload without a document.
if (typeof document !== 'undefined')
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
