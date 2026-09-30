import { Onboarding } from './onboarding';
import { OfficeChat } from './office-chat';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Box,
  ChevronRight,
  Circle,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  LayoutDashboard,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type { AppInfo, AppState, Command, WorkType, WorkMode } from '../shared/types';
import './tokens.css';
import './styles.css';
import { AgentRoster, ProfileEditor, ConnectionBinding } from './office';
import { OfficeScene } from './office-scene';
import { useOfficeActivity } from './use-activity';
import { AgentDrawer } from './agent-drawer';
import { AgentStrip, AttentionBell, ToastStack } from './shell-widgets';
import { attentionItems } from '../shared/attention';
import type { AttentionItem } from '../shared/attention';
import type { OfficeActivity } from '../shared/activity';
import { activityStatus } from './status';
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
import { Empty, label, Checkbox } from './components';

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

/** One actionable row in the Go to… palette. */
export interface PaletteItem {
  id: string;
  /** The text matched against the query and shown as the button's name. */
  label: string;
  kind: 'page' | 'command' | 'project' | 'request';
  page?: Page;
  command?: 'new-request' | 'add-agent' | 'needs-you';
  projectId?: string;
  requestId?: string;
  /** Set when the command cannot run now — the row stays visible but inert, with the reason as its title. */
  disabledReason?: string;
}
export interface PaletteSection {
  label: string;
  items: PaletteItem[];
}

/**
 * The palette's sections, kept pure for tests. Pages follow the sidebar's own grouping so the
 * palette teaches the same model; projects and requests are recency-ordered (updatedAt) and capped
 * when unfiltered, matching how recents read in every launcher UI.
 */
export function paletteSections(state: Pick<AppState, 'projects' | 'requests'>, query: string): PaletteSection[] {
  const q = query.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);
  const open = (state.projects ?? []).filter(p => !p.archived && !p.removedAt);
  const sections: PaletteSection[] = [];
  for (const [section, items] of navSections) {
    const pages = items
      .filter(([name]) => match(name))
      .map(([name]): PaletteItem => ({ id: `page:${name}`, label: name, kind: 'page', page: name }));
    if (pages.length) sections.push({ label: section, items: pages });
  }
  const commandItems: PaletteItem[] = [
    {
      id: 'command:new-request',
      label: 'New request',
      kind: 'command',
      command: 'new-request',
      disabledReason: open.length ? undefined : 'Create a project first',
    },
    { id: 'command:add-agent', label: 'Add agent', kind: 'command', command: 'add-agent' },
    { id: 'command:needs-you', label: 'Open Needs you', kind: 'command', command: 'needs-you' },
  ];
  const commands = commandItems.filter(item => match(item.label));
  if (commands.length) sections.push({ label: 'Commands', items: commands });
  const projects = open
    .filter(p => match(p.name))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, q ? 10 : 5)
    .map((p): PaletteItem => ({ id: `project:${p.id}`, label: p.name, kind: 'project', projectId: p.id }));
  // Unfiltered the cap shows only the five most recently touched — the "Recent" prefix says so.
  if (projects.length) sections.push({ label: q ? 'Projects' : 'Recent projects', items: projects });
  const requests = (state.requests ?? [])
    .filter(r => !r.removedAt && match(r.name))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, q ? 10 : 5)
    .map((r): PaletteItem => ({ id: `request:${r.id}`, label: r.name, kind: 'request', requestId: r.id }));
  if (requests.length) sections.push({ label: q ? 'Requests' : 'Recent requests', items: requests });
  return sections;
}

/**
 * Per-project live state for the picker: seats the office currently watches working on that
 * project's requests, and request-kind attention items pointing at it. Derived only from recorded
 * state — never a guess.
 */
export function projectLiveCounts(
  requests: { id: string; projectId: string }[],
  activity: OfficeActivity[],
  attention: AttentionItem[],
): Map<string, { working: number; needsYou: number }> {
  const requestProject = new Map(requests.map(r => [r.id, r.projectId]));
  const counts = new Map<string, { working: number; needsYou: number }>();
  const bump = (projectId: string, key: 'working' | 'needsYou') => {
    const entry = counts.get(projectId) ?? { working: 0, needsYou: 0 };
    entry[key] += 1;
    counts.set(projectId, entry);
  };
  for (const seat of activity) {
    const status = activityStatus(seat);
    if ((status === 'working' || status === 'stalled') && seat.requestId) {
      const projectId = requestProject.get(seat.requestId);
      if (projectId) bump(projectId, 'working');
    }
  }
  for (const item of attention) {
    if (item.kind !== 'request') continue;
    const projectId = requestProject.get(item.targetId);
    if (projectId) bump(projectId, 'needsYou');
  }
  return counts;
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [page, setPage] = useState<Page>('Office');
  const [settingsSection, setSettingsSection] = useState('all');
  const [taskbarAttention, setTaskbarAttention] = useState(() => {
    try {
      return localStorage.getItem('qro.taskbar-attention') !== 'off';
    } catch {
      return true;
    }
  });
  const [palette, setPalette] = useState(false),
    [paletteQuery, setPaletteQuery] = useState(''),
    [paletteIndex, setPaletteIndex] = useState(0),
    [needsYouOpen, setNeedsYouOpen] = useState(false);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(p => !p);
        setPaletteQuery('');
        setPaletteIndex(0);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
  const [projectId, setProjectId] = useState(() => savedId('quant-project'));
  const [experimentId, setExperimentId] = useState(() => savedId('quant-experiment'));
  /** The last project the user actually opened — leads the picker as "Last opened". */
  const [lastProjectId, setLastProjectId] = useState(() => savedId('quant-project-last'));
  /** True once the user clears the project pick on purpose; stops sole-project auto-select undoing it. */
  const clearedProject = useRef(false);
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
  const { activity, now, watchedJobIds } = useOfficeActivity(state);
  const project = state?.projects.find(p => p.id === projectId);
  const openProjects = state?.projects.filter(p => !p.archived && !p.removedAt) ?? [];
  const experiments = state?.experiments.filter(e => e.projectId === projectId) || [];
  const experiment = experiments.find(e => e.id === experimentId);
  const attention = state ? attentionItems(state, activity, watchedJobIds) : [];
  const needsYou = attention.length;
  const working = activity.filter(a => ['working', 'stalled'].includes(activityStatus(a))).length;
  const failedSeats = activity.filter(a => activityStatus(a) === 'failed').length;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  // Every state the main process sends omits the event history, so the newest state always wins.
  const acceptState = (next: AppState) => setState(next);
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
      localStorage.setItem('quant-project-last', lastProjectId);
    } catch {}
  }, [projectId, experimentId, lastProjectId]);
  // A removed or archived project stays in the record but leaves every picker, including the selection.
  // This clear is not the user's pick, so it does not mark the selection deliberately cleared.
  useEffect(() => {
    if (project?.removedAt || project?.archived) chooseProject('', false);
  }, [project?.removedAt, project?.archived]);
  // Any selection — restored, auto, or manual — ends the cleared flag; only an explicit '' sets it.
  useEffect(() => {
    if (projectId) clearedProject.current = false;
  }, [projectId]);
  // A single open project selects itself unless the user deliberately cleared the pick this session.
  useEffect(() => {
    if (!project && !clearedProject.current && openProjects.length === 1) setProjectId(openProjects[0].id);
  }, [project, openProjects]);
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
    void window.office?.setAttentionCount?.(taskbarAttention ? needsYou : 0).catch(() => {});
  }, [needsYou, taskbarAttention]);
  useEffect(() => {
    setDrawerAgentId(null);
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
  function chooseProject(id: string, userAction = true) {
    if (!id && userAction) clearedProject.current = true;
    setProjectId(id);
    setExperimentId('');
    if (id) setLastProjectId(id);
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
  // Nothing is selected on a fresh start or after the Projects page. When projects exist, offer them
  // here instead of sending the user to create another one. Each pick carries the live state the
  // office already recorded — requests, seats working on them, and items that need the user.
  const liveByProject = projectLiveCounts(state?.requests ?? [], activity, attention);
  const needProject = (content: React.ReactNode) =>
    project ? (
      content
    ) : openProjects.length ? (
      <Empty
        icon={FolderOpen}
        title="Choose a project"
        description="This page shows one project at a time."
        action={
          <div className="project-picks">
            {[...openProjects]
              .sort(
                (a, b) =>
                  Number(b.id === lastProjectId) - Number(a.id === lastProjectId) ||
                  b.updatedAt.localeCompare(a.updatedAt),
              )
              .map(p => {
                const live = liveByProject.get(p.id);
                const requests = (state?.requests ?? []).filter(r => r.projectId === p.id && !r.removedAt).length;
                const bits = [
                  requests ? `${requests} request${requests === 1 ? '' : 's'}` : '',
                  live?.working ? `${live.working} working` : '',
                  live?.needsYou ? `${live.needsYou} ${live.needsYou === 1 ? 'needs' : 'need'} you` : '',
                ].filter(Boolean);
                return (
                  <button key={p.id} className="project-pick" onClick={() => chooseProject(p.id)}>
                    <strong>{p.name}</strong>
                    <span className="project-pick-state">{bits.length ? bits.join(' · ') : 'No requests yet'}</span>
                    {p.id === lastProjectId && <span className="project-pick-tag">Last opened</span>}
                  </button>
                );
              })}
          </div>
        }
      />
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
  const closePalette = () => {
    setPalette(false);
    setPaletteQuery('');
    setPaletteIndex(0);
  };
  const paletteSectionList = palette ? paletteSections(state, paletteQuery) : [];
  // Disabled rows render but can never be activated — arrows and Enter skip them.
  const paletteFlat = paletteSectionList.flatMap(section => section.items).filter(item => !item.disabledReason);
  const paletteActive = Math.min(paletteIndex, Math.max(paletteFlat.length - 1, 0));
  function runPaletteItem(item: PaletteItem) {
    closePalette();
    if (item.page) setPage(item.page);
    else if (item.command === 'new-request') setModal('experiment');
    else if (item.command === 'add-agent') setPage('Add Agent');
    else if (item.command === 'needs-you') setNeedsYouOpen(true);
    else if (item.projectId) {
      chooseProject(item.projectId);
      setPage('Projects');
    } else if (item.requestId) {
      setPage('Office');
      setOpenRequestId(item.requestId);
    }
  }
  // The eyebrow echoes the page's sidebar section so the heading block follows one rule.
  const pageSection = navSections.find(([, items]) => items.some(([name]) => name === page))?.[0] ?? 'WORKSPACE';
  const agentCount = state.agents.filter(a => !a.removedAt).length;
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
                  {name === 'Office' && needsYou > 0 && (
                    <b aria-label={`${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`}>{needsYou}</b>
                  )}
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
            {project && (
              <>
                <ChevronRight size={14} />
                <select
                  aria-label="Current experiment"
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
              </>
            )}
          </div>
          <div className="topbar-right">
            <button
              className="text-button"
              aria-label="Go to a page, project, or request"
              title="Ctrl+K"
              onClick={() => {
                setPalette(true);
                setPaletteQuery('');
                setPaletteIndex(0);
              }}
            >
              Go to…
            </button>
            <AgentStrip agents={state.agents} activity={activity} onPick={setDrawerAgentId} />
            <AttentionBell
              items={attention}
              open={needsYouOpen}
              onOpenChange={setNeedsYouOpen}
              onPick={item => {
                if (item.kind === 'agent') setDrawerAgentId(item.targetId);
                else {
                  setPage('Office');
                  setOpenRequestId(item.targetId);
                }
              }}
            />
            <span className="provider-status">
              <span className="status-dot off" />
              {agentCount} {agentCount === 1 ? 'agent' : 'agents'} registered
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
              <div className="eyebrow">{pageSection}</div>
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
          {page === 'Office' && (
            <>
              <Onboarding
                state={state}
                onAgents={() => setPage('Add Agent')}
                onProjects={() => setModal('project')}
                onRequest={() => setModal('experiment')}
              />
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
                watchedJobIds={watchedJobIds}
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
                onPage={setPage}
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
                setPreview={setPreview}
                onError={fail}
              />,
            )}
          {page === 'Memory' && needProject(<MemoryView state={state} projectId={projectId} />)}
          {page === 'History' && <HistoryView state={state} projectId={projectId || null} label={label} date={date} />}
          {page === 'Usage' && <SubscriptionUsage state={state} />}
          {page === 'Settings' && (
            <>
              <nav className="settings-nav button-row" aria-label="Settings sections">
                {[
                  ['all', 'All settings'],
                  ['connections', 'Connections'],
                  ['isolation', 'Agents & isolation'],
                  ['notifications', 'Notifications'],
                  ['appearance', 'Appearance'],
                  ['data', 'Data & recovery'],
                  ['about', 'About'],
                ].map(([id, title]) => (
                  <button
                    key={id}
                    className="secondary"
                    aria-pressed={settingsSection === id}
                    onClick={() => setSettingsSection(id)}
                  >
                    {title}
                  </button>
                ))}
              </nav>
              {['all', 'connections'].includes(settingsSection) && <ProviderConnections state={state} />}
              {['all', 'isolation'].includes(settingsSection) && <AgentIsolation />}

              <div className="settings-card" hidden={!['all', 'notifications'].includes(settingsSection)}>
                <h2>Notifications</h2>
                <Checkbox
                  checked={taskbarAttention}
                  onChange={enabled => {
                    setTaskbarAttention(enabled);
                    try {
                      localStorage.setItem('qro.taskbar-attention', enabled ? 'on' : 'off');
                    } catch {}
                  }}
                >
                  Taskbar badge and attention flash when the office needs you
                </Checkbox>
                <p className="muted">
                  The in-app inbox stays available. Desktop popups and sounds are off in this revision.
                </p>
              </div>
              <div className="settings-card" hidden={!['all', 'appearance'].includes(settingsSection)}>
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
              <div className="settings-card" hidden={!['all', 'data'].includes(settingsSection)}>
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
              <div className="settings-card" hidden={!['all', 'about'].includes(settingsSection)}>
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
                    <p>
                      Agent sessions use the configured official client. Main experiments run manually in your Colab
                      session.
                    </p>
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
                    ? 'Agent added. Sessions run on this machine through the signed-in official CLI, subject to the recorded launch checks.'
                    : 'Agent added. Hosted research execution remains blocked until configured.',
                );
              }}
            />
          )}
        </main>
        <ToastStack
          error={error}
          notice={notice}
          onDismissError={() => setError('')}
          onDismissNotice={() => setNotice('')}
        />
        <footer className="statusbar">
          <span>
            <span className="status-dot" />
            Local record ready
          </span>
          <span>
            <span className="statusbar-counts">
              <button className="statusbar-seg" onClick={() => setPage('Office')} title="Open the Office work queue">
                <b>{working}</b> working
              </button>
              <span className="statusbar-divider">|</span>
              <button className="statusbar-seg" onClick={() => setNeedsYouOpen(true)} title="Open the Needs you list">
                <b>{needsYou}</b> {needsYou === 1 ? 'needs' : 'need'} you
              </button>
              {failedSeats > 0 && (
                <>
                  <span className="statusbar-divider">|</span>
                  <button className="statusbar-seg failed" onClick={() => setPage('History')} title="Open History">
                    <b>{failedSeats}</b> failed lately
                  </button>
                </>
              )}
              <span className="statusbar-divider">|</span>
              <button className="statusbar-seg" onClick={() => setPage('Agents')} title="Open the Agents roster">
                <b>{agentCount}</b> registered {agentCount === 1 ? 'agent' : 'agents'}
              </button>
            </span>
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
          onProfile={id => {
            setDrawerAgentId(null);
            setAgentDetailId(id);
          }}
          onOpenRequest={requestId => {
            if (!state.requests?.some(item => item.id === requestId)) return;
            setPage('Office');
            setOpenRequestId(requestId);
            setDrawerAgentId(null);
          }}
        />
      )}
      {palette && (
        <Dialog title="Go to…" onClose={closePalette}>
          <input
            autoFocus
            className="palette-input"
            aria-label="Find a page, project, or request"
            placeholder="Search pages, projects, requests…"
            value={paletteQuery}
            onChange={e => {
              setPaletteQuery(e.target.value);
              setPaletteIndex(0);
            }}
            onKeyDown={e => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (paletteFlat.length)
                  setPaletteIndex(
                    (paletteActive + (e.key === 'ArrowDown' ? 1 : paletteFlat.length - 1)) % paletteFlat.length,
                  );
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const item = paletteFlat[paletteActive];
                if (item) runPaletteItem(item);
              }
            }}
          />
          <div className="palette-results">
            {paletteSectionList.map(section => (
              <div key={section.label} className="palette-group">
                <div className="palette-group-label">{section.label}</div>
                {section.items.map(item => {
                  const flatIndex = paletteFlat.indexOf(item);
                  return (
                    <button
                      key={item.id}
                      className={`secondary palette-item${flatIndex === paletteActive ? ' active' : ''}`}
                      disabled={Boolean(item.disabledReason)}
                      title={item.disabledReason}
                      onMouseEnter={() => {
                        if (flatIndex >= 0) setPaletteIndex(flatIndex);
                      }}
                      onClick={() => runPaletteItem(item)}
                      ref={el => {
                        if (flatIndex === paletteActive) el?.scrollIntoView({ block: 'nearest' });
                      }}
                    >
                      {(item.kind === 'project' || item.kind === 'request') && (
                        <span className="palette-kind">{item.kind === 'project' ? 'Project' : 'Request'}</span>
                      )}
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
            {!paletteSectionList.length && <p className="muted">Nothing matches.</p>}
          </div>
          <div className="palette-hints">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>Enter</kbd> open
            </span>
            <span>
              <kbd>Esc</kbd> close
            </span>
          </div>
        </Dialog>
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
