import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, BookOpen, Box, Check, ChevronRight, Circle, Folder, FolderPlus, History, LayoutDashboard, ListTodo, LockKeyhole, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles, Users, Wallet, X } from 'lucide-react';
import type { AppInfo, AppState, Command, Experiment, ResearchContract, Role, WorkType, WorkMode } from '../shared/types';
import './styles.css';
import {requestQueue} from '../shared/queue';
import { OfficeScene, WorkQueue, AgentRoster, ProfileEditor, ConnectionBinding } from './office';
import { AgentSetup, ProviderConnections, SubscriptionUsage } from './agents';
import { ProjectLocationEditor } from './location';
import { HistoryPager } from './history';
import { ResearchPipeline } from './pipeline';
import { ProfileTabs } from './profile';
import { ActivityView, AgentDetails } from './activity';

type Page = 'Agents' | 'Office' | 'Projects' | 'Tasks' | 'Research' | 'Reviews' | 'Artifacts' | 'History' | 'Logs' | 'Usage' | 'Settings' | 'Add Agent';
type CommandInput = Command extends infer C ? C extends Command ? Omit<C, 'idempotencyKey'> : never : never;
const nav = [ ['Office', LayoutDashboard], ['Agents', Users], ['Projects', Folder], ['Tasks', ListTodo], ['Research', BookOpen], ['Reviews', ShieldCheck], ['Artifacts', Box], ['History', History], ['Logs', ListTodo], ['Usage', Wallet], ['Settings', Settings2], ['Add Agent', Plus] ] as const;
const roles: { role: Role; label: string; title: string; scope: string; color: string }[] = [
 { role: 'DIRECTOR', label: 'Director', title: 'Research direction', scope: 'Defines research contracts, priorities, and final decisions.', color: 'amber' },
 { role: 'PM_A', label: 'PM · A', title: 'Implementation', scope: 'Owns implementation and integration of research work.', color: 'teal' },
 { role: 'PM_B', label: 'PM · B', title: 'Verification', scope: 'Independently verifies code, evidence, and reproducibility.', color: 'blue' },
 { role: 'PM_C', label: 'PM · C', title: 'Findings', scope: 'Interprets statistical evidence and research findings.', color: 'purple' },
 { role: 'PM_D', label: 'PM · D', title: 'Falsification', scope: 'Challenges assumptions, robustness, and economic value.', color: 'rose' },
 { role: 'WORKER', label: 'Worker · 01', title: 'Research execution', scope: 'Completes bounded tasks under a project manager.', color: 'neutral' },
 { role: 'WORKER', label: 'Worker · 02', title: 'Research execution', scope: 'Completes bounded tasks under a project manager.', color: 'neutral' },
];
const contractFields: [keyof ResearchContract, string, string][] = [
 ['objective', 'Research objective', 'What question will this experiment answer? Define the target and output meaning.'],
 ['dataPolicy', 'Data & leakage policy', 'Data sources, time splits, availability, leakage controls, and permitted use.'],
 ['modelFamilies', 'Model families', 'Candidate methods, baselines, and the comparison you want to make.'],
 ['evaluation', 'Evaluation protocol', 'Metrics, validation design, holdouts, and success / failure criteria.'],
 ['economics', 'Economic assumptions', 'Costs, slippage, capacity, exposures, and any economic constraints.'],
 ['protectedRegions', 'Protected regions', 'Untouched data, protected code, and boundaries requiring an amendment.'],
 ['requiredChecks', 'Required checks', 'Required evidence, reproducibility checks, and falsification tests.'],
 ['limitations', 'Limitations & open questions', 'Known uncertainty, missing inputs, assumptions, and unresolved decisions.'],
];
const date = (d: string) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const label = (s: string) => s.replaceAll('_', ' ').toLowerCase();
const savedId = (key: string) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
interface ContractDraft { draft: ResearchContract; revision: number; saved: string; }
const contractDrafts = new Map<string, ContractDraft>();
function readContractDraft(experiment: Experiment): ContractDraft {
 const memory = contractDrafts.get(experiment.id);
 if (memory) return memory;
 try {
  const stored: unknown = JSON.parse(localStorage.getItem(`quant-contract-draft:${experiment.id}`) || 'null');
  if (stored && typeof stored === 'object') {
   const entry = stored as ContractDraft;
   if (Number.isSafeInteger(entry.revision) && entry.revision >= 0 && typeof entry.saved === 'string' && entry.draft && contractFields.every(([key]) => typeof entry.draft[key] === 'string' && entry.draft[key].length <= 12000)) return entry;
  }
 } catch {}
 return { draft: { ...experiment.contract }, revision: experiment.revision, saved: JSON.stringify(experiment.contract) };
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
 const [agentDetailId,setAgentDetailId]=useState<string|null>(null);
 const [search, setSearch] = useState('');
 const [localFolder,setLocalFolder]=useState<string|null>(null);
 const [projectLifecycle,setProjectLifecycle]=useState('active');
 const [requestMode,setRequestMode]=useState<WorkMode>('SINGLE');
 const [preview, setPreview] = useState<{ name: string; text: string; truncated: boolean; binary: boolean } | null>(null);
 const project = state?.projects.find(p => p.id === projectId);
 const experiments = state?.experiments.filter(e => e.projectId === projectId) || [];
 const experiment = experiments.find(e => e.id === experimentId);
 const activeProjects = state?.projects.filter(p => !p.archived) || [];
 const blockedRequests = state ? requestQueue(state).filter(r=>r.status==='BLOCKED').length : 0;
 const scopedArtifacts = state?.artifacts.filter(a => a.projectId === projectId && (!experiment || a.experimentId === experiment.id)) || [];
 const scopedEvents = state?.events.filter(e => !project || e.projectId === projectId || e.projectId === null) || [];
 const scopedReviews = state?.reviews.filter(r => r.projectId === projectId) || [];
 const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
 const acceptState = (next: AppState) => setState(previous => previous && previous.events.length > next.events.length ? previous : next);
 async function refresh() {
  try { if (!window.office) throw new Error('Desktop connection unavailable. Open Quant Research Office from the desktop application.'); acceptState(await window.office.getState()); }
  catch (e) { fail(e); } finally { setLoading(false); }
 }
 useEffect(() => { void refresh(); if (!window.office) return; void window.office.getInfo().then(setInfo).catch(fail); return window.office.onChanged(() => { void refresh(); }); }, []);
 useEffect(() => { try { localStorage.setItem('quant-project', projectId); localStorage.setItem('quant-experiment', experimentId); } catch {} }, [projectId, experimentId]);
 useEffect(() => { if (state) { document.documentElement.dataset.theme = state.settings.theme; document.documentElement.dataset.motion = state.settings.reducedMotion ? 'reduced' : 'full'; } }, [state?.settings]);
 useEffect(() => { setSearch(''); document.querySelector('main')?.scrollTo(0,0); }, [page]);
 async function command(input: CommandInput, success?: string) {
  setBusy(true); setError(''); setNotice('');
  try { const next = await window.office.command({ ...input, idempotencyKey: crypto.randomUUID() } as Command); acceptState(next); if (success) setNotice(success); return next; }
  catch (e) { fail(e); return null; } finally { setBusy(false); }
 }
 async function files(action: () => ReturnType<typeof window.office.backupWorkspace>) {
  setBusy(true); setError(''); setNotice(''); try { const result = await action(); acceptState(result.state); if (!result.canceled) setNotice(result.message); } catch (e) { fail(e); } finally { setBusy(false); }
 }
 function chooseProject(id: string) { setProjectId(id); setExperimentId(''); }
 useEffect(()=>{setLocalFolder(null);},[modal]);
 async function submitProject(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault(); const form = new FormData(event.currentTarget);
  try {
   const data = { name: String(form.get('name')).trim(), mandate: String(form.get('mandate')).trim(), budgetCents: project?.budgetCents ?? 0,localFolder:localFolder??(modal==='edit-project'?project?.localFolder??'':''),cloudWorkspace:String(form.get('cloudWorkspace')??'') };
   if (!data.name) throw new Error('Give the project a name.');
   const next = await command(modal === 'edit-project' && project ? { type: 'project.update', projectId, ...data } : { type: 'project.create', ...data }, modal === 'edit-project' ? 'Project updated.' : 'Project created. Your office is ready for research planning.');
   if (next) { if (modal !== 'edit-project') { const created = next.projects.find(p => !state?.projects.some(old => old.id === p.id)); if (created) chooseProject(created.id); } setModal(null); }
  } catch (e) { fail(e); }
 }
 async function submitExperiment(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault(); const form = new FormData(event.currentTarget);
  if (!String(form.get('name')).trim()) { setError('Give the experiment a name.'); return; }
  const next = await command({ type: 'request.create', projectId:String(form.get('requestProjectId')), name: String(form.get('name')).trim(), hypothesis: String(form.get('hypothesis')).trim(),workType:String(form.get('workType')) as WorkType,mode:requestMode,leadAgentId:String(form.get('leadAgentId'))||null,participantIds:form.getAll('participantIds').map(String),acceptanceCriteria:String(form.get('acceptanceCriteria')??'') }, 'Draft saved. Start request checks readiness before any work is queued.');
  if (next) { setProjectId(String(form.get('requestProjectId')));const created = next.experiments.find(e => !state?.experiments.some(old => old.id === e.id)); if (created) setExperimentId(created.id); setPage(created?'Research':'Tasks'); setModal(null); }
 }
 const needProject = (content: React.ReactNode) => project ? content : <Empty icon={FolderPlus} title="A home for your research" description="Create or select a project to organize experiments, requests, and evidence." action={<button className="primary" onClick={() => setModal('project')}><Plus size={15}/>Create project</button>}/>;

 if (loading) return <div className="startup"><div className="brand-mark"><Box size={26}/></div><h2>Opening your research office</h2><p>Loading the local research record…</p></div>;
 if (!state) return <div className="startup"><div className="brand-mark"><Box size={26}/></div><h2>Office unavailable</h2><p role="alert">{error}</p><button className="primary" onClick={() => { setError(''); setLoading(true); void refresh(); }}><RefreshCw size={15}/>Try again</button></div>;
 return <div className="app-shell">
  <aside className="sidebar">
   <div className="brand"><div className="brand-mark"><Box size={22}/></div><div>QUANT<span>RESEARCH OFFICE</span></div></div>
   <div className="sidebar-section-label">WORKSPACE</div>
   <nav aria-label="Main navigation">{nav.map(([name, Icon], i) => <React.Fragment key={name}>{name === 'Settings' && <div className="nav-divider"/>}<button className={`nav-item ${page === name ? 'active' : ''}`} aria-current={page === name ? 'page' : undefined} onClick={() => setPage(name)}><Icon size={18}/><span>{name}</span>{name === 'Tasks' && blockedRequests > 0 && <b>{blockedRequests}</b>}{name === 'Add Agent' && <span className="later-dot"/>}</button></React.Fragment>)}</nav>
   <div className="sidebar-footer"><div className="environment"><span className="status-dot"/>Local workspace</div><p>Research runs on provider infrastructure.</p><span className="version">DESKTOP · {info?.version || 'INITIAL RELEASE'}</span></div>
  </aside>
  <div className="workspace">
   <header className="topbar"><div className="context-selector"><Folder size={16}/><select aria-label="Current project" value={project?.id || ''} onChange={e => chooseProject(e.target.value)}><option value="">Select a project</option>{state.projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? ' (archived)' : ''}</option>)}</select><ChevronRight size={14}/><select aria-label="Current experiment" disabled={!project} value={experiment?.id || ''} onChange={e => setExperimentId(e.target.value)}><option value="">All experiments</option>{experiments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div><div className="topbar-right"><span className="provider-status"><span className="status-dot off"/>{state.agents.filter(a=>!a.removedAt).length} agents registered</span><button className="spend-pill" onClick={() => setPage('Usage')}><Wallet size={14}/>Subscription usage</button></div></header>
   <main>
    <div className="page-heading"><div><div className="eyebrow">{page === 'Office' ? 'YOUR RESEARCH WORKSPACE' : 'QUANT RESEARCH OFFICE'}</div><h1>{page === 'Office' ? 'The office' : page}</h1><p>{({ Agents: 'Your team, profiles, and membership. Archived agents retain their history.', Office: 'A place for better questions. A team for rigorous answers.', Projects: 'Independent research spaces, with a clear mandate.', Tasks: 'Every request, its current state, and what happens next.', Research: 'Make the scientific choices explicit before implementation.', Reviews: 'Independent positions, traceable evidence, and recorded decisions.', Artifacts: 'The inputs and outputs that make research reproducible.', History: 'A persistent record of decisions and changes.', Logs: 'Visible conversations, work events, and exchanges between agents.', Usage: 'Your shared subscription allowances and reset times.', Settings: 'Your desktop workspace preferences.', 'Add Agent': '' })[page]}</p></div>{page !== 'Add Agent' && <div className="heading-actions">{page === 'Projects' ? <button className="primary" onClick={() => setModal('project')}><Plus size={16}/>New project</button> : page === 'Research' ? <button className="primary" disabled={!project || project.archived} onClick={() => setModal('experiment')}><Plus size={16}/>New request</button> : page === 'Office' ? <span className="quiet-badge"><Circle size={12}/>Setup mode</span> : null}</div>}</div>
    {error && <div className="notice error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16}/></button></div>}
    {notice && <div className="notice success" role="status"><Check size={16}/><span>{notice}</span><button aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={16}/></button></div>}
    {page === 'Office' && <><OfficeScene agents={state.agents} state={state} onAgent={setAgentDetailId}/><WorkQueue onState={acceptState} onAction={c=>void command(c)} state={state} busy={busy} onNew={()=>project&&!project.archived?setModal('experiment'):setModal('project')} onOpen={e=>{setProjectId(e.projectId);setExperimentId(e.id);setPage('Research');}} onCancel={id=>void command({type:'task.cancel',taskId:id},'Request and linked research canceled.')}/></>}
    {page === 'Agents' && <AgentRoster state={state} busy={busy} onAgent={setAgentDetailId} onAdd={()=>setPage('Add Agent')} onRemove={(id,removed)=>void command({type:'agent.remove',agentId:id,removed})}/>}
    {page === 'Projects' && <><div className="section-toolbar"><span>{activeProjects.length} active projects · {state.projects.filter(p => p.archived).length} archived</span><label className="field">Project lifecycle<select value={projectLifecycle} onChange={e=>setProjectLifecycle(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label><SearchField value={search} onChange={setSearch} placeholder="Find a project"/></div>{!state.projects.length ? <Empty icon={FolderPlus} title="Every discovery starts with a question" description="Create a project for a research question, strategy family, or model comparison. No model family is assumed." action={<button className="primary" onClick={() => setModal('project')}><Plus size={16}/>Create first project</button>}/> : <div className="project-grid">{state.projects.filter(p=>projectLifecycle==='all'||(projectLifecycle==='archived')===p.archived).filter(p => `${p.name} ${p.mandate}`.toLowerCase().includes(search.toLowerCase())).map(p => <article className={`project-card ${p.id === projectId ? 'chosen' : ''}`} key={p.id}><div className="card-heading"><span className="folder-emblem"><Folder size={22}/></span><span className="quiet-badge small">{p.archived ? 'Archived' : p.id === projectId ? 'Selected' : 'Active'}</span></div><h2>{p.name}</h2><p>{p.mandate || 'No mandate recorded.'}</p><p className="path-text">{p.localFolder||'Folder not selected'}</p><p>Cloud workspace: {p.cloudWorkspace||'Not selected'} · Unverified</p>{p.localFolder&&<button onClick={()=>void window.office.openProjectFolder(p.id).catch(fail)}>Open folder</button>}<div className="project-stats"><span><strong>{state.experiments.filter(e => e.projectId === p.id).length}</strong> experiments</span><span>Subscription only</span></div><button className="card-link" onClick={() => { chooseProject(p.id); setPage('Research'); }}>Open project<ArrowUpRight size={17}/></button></article>)}</div>}</>}
    {page === 'Projects' && project && <ProjectLocationEditor key={project.id} project={project} state={state} onState={acceptState}/>}
    {page === 'Tasks' && <WorkQueue onState={acceptState} onAction={c=>void command(c)} state={state} busy={busy} onNew={()=>project&&!project.archived?setModal('experiment'):setModal('project')} onOpen={e=>{setProjectId(e.projectId);setExperimentId(e.id);setPage('Research');}} onCancel={id=>void command({type:'task.cancel',taskId:id},'Request and linked research canceled.')}/>}
    {page === 'Research' && needProject(<><ResearchPipeline key={projectId} state={state} projectId={projectId}/><div className="research-overview"><div><span className="mini-label">PROJECT MANDATE</span><h2>{project?.name}</h2><p>{project?.mandate || 'Add a mandate to describe the scope of this project.'}</p></div><div className="button-row"><button className="secondary" onClick={() => setModal('edit-project')}>Edit project</button><button className="text-button" disabled={busy} onClick={() => void command({ type: 'project.archive', projectId, archived: !project?.archived }, project?.archived ? 'Project restored.' : 'Project archived.')}>{project?.archived ? 'Restore project' : 'Archive project'}</button></div></div>{experiments.length > 0 && <div className="experiment-tabs" aria-label="Experiments">{experiments.map(e => <button aria-pressed={experimentId === e.id} className={experimentId === e.id ? 'selected' : ''} onClick={() => setExperimentId(e.id)} key={e.id}>{e.name}<span>{label(e.stage)}</span></button>)}</div>}{experiment ? <ContractEditor key={experiment.id} experiment={experiment} disabled={busy || !!project?.archived} command={command}/> : <Empty icon={BookOpen} title={experiments.length ? 'Choose an experiment' : 'Define your first experiment'} description="Open research details from the work queue, or create a new request." action={<button className="primary" disabled={project?.archived} onClick={() => setModal('experiment')}><Plus size={15}/>New request</button>}/>}</>)}
    {page === 'Reviews' && needProject(<><div className="review-gates">{['Independent evidence', 'One rebuttal round', 'Director decision'].map((s, i) => <div key={s}><span className="gate-number">0{i + 1}</span><strong>{s}</strong><span className="quiet-badge small">Pending</span></div>)}</div>{!scopedReviews.length ? <Empty icon={ShieldCheck} title="Evidence before approval" description="No review reports have been submitted. Independent provider agents must be configured before a research contract or code package can be reviewed."/> : <div className="task-list">{scopedReviews.filter(r => !experiment || r.experimentId === experiment.id).map(r => <article className="task-card" key={r.id}><div className="card-heading"><h3>{roles.find(role => role.role === r.role)?.label}</h3><span className="quiet-badge">{r.disclosed ? r.verdict : 'Awaiting disclosure'}</span></div><p>{r.disclosed ? r.content : 'Independent report remains sealed until the disclosure gate is satisfied.'}</p><code className="hash">Bundle {r.bundleHash}</code></article>)}</div>}</>)}
    {page === 'Artifacts' && needProject(<><div className="section-toolbar artifact-toolbar"><span>{scopedArtifacts.length} files stored</span><div className="button-row"><button className="secondary" disabled={busy || project?.archived} onClick={() => void files(() => window.office.importFiles({ projectId, experimentId: experiment?.id || null, kind: 'REFERENCE' }))}><ArrowDownToLine size={15}/>Import references</button><button className="secondary" disabled={busy || project?.archived} onClick={() => void files(() => window.office.importFiles({ projectId, experimentId: experiment?.id || null, kind: 'RESULT' }))}><ArrowDownToLine size={15}/>Import my results</button><button className="primary" disabled={busy} onClick={() => void files(() => window.office.exportProject(projectId))}><ArrowUpFromLine size={15}/>Export project</button></div></div><div className="inline-note"><LockKeyhole size={16}/><span>Files are stored as evidence. Imported results await provider verification. Finalized ML code runs manually in your own Colab session; this app never connects to it.</span></div>{!scopedArtifacts.length ? <Empty icon={Box} title="A cabinet for your evidence" description="Import reference code, datasets, or results you produced yourself. Nothing you import is executed by this app."/> : <div className="table-wrap"><table><thead><tr><th>Artifact</th><th>Type / state</th><th>Integrity</th><th>Added</th><th/></tr></thead><tbody>{scopedArtifacts.filter(a => !experiment || a.experimentId === experiment.id).map(a => <tr key={a.id}><td><strong>{a.name}</strong><small>{a.size.toLocaleString()} bytes · {a.mediaType}</small></td><td><span className="quiet-badge small">{label(a.kind)}</span><small>{label(a.status)} · {label(a.classification)}</small></td><td><code title={a.sha256}>{a.sha256.slice(0, 12)}…</code></td><td>{date(a.createdAt)}</td><td><button className="secondary" disabled={busy} onClick={async () => { setBusy(true); try { setPreview({ name: a.name, ...await window.office.previewArtifact(a.id) }); } catch (e) { fail(e); } finally { setBusy(false); } }}>Preview</button></td></tr>)}</tbody></table></div>}<p className="footnote">Project export includes the current local record and stored files. It does not certify code as approved.</p></>)}
    {page === 'History' && <HistoryPager projectId={projectId||null} search={search} label={label} date={date}/>}
    {page === 'Logs' && <ActivityView state={state}/>}
    {page === 'Usage' && <SubscriptionUsage state={state}/>}
    {page === 'Settings' && <><ProviderConnections state={state}/><div className="settings-card"><h2>Appearance</h2><div className="setting-row"><div><strong>Theme</strong><p>Choose the appearance of your desktop workspace.</p></div><select aria-label="Theme" value={state.settings.theme} disabled={busy} onChange={e => void command({ type: 'settings.update', settings: { ...state.settings, theme: e.target.value as 'dark' | 'light' } })}><option value="dark">Warm dark</option><option value="light">Light</option></select></div><div className="setting-row"><div><strong>Reduce motion</strong><p>Keep workspace transitions to a minimum.</p></div><button role="switch" aria-checked={state.settings.reducedMotion} aria-label="Reduce motion" className={`switch ${state.settings.reducedMotion ? 'on' : ''}`} disabled={busy} onClick={() => void command({ type: 'settings.update', settings: { ...state.settings, reducedMotion: !state.settings.reducedMotion } })}><span/></button></div></div><div className="settings-card"><h2>Data & recovery</h2><div className="setting-row"><div><strong>Workspace backup</strong><p>Save a portable copy of the local record and stored artifacts.</p></div><button className="secondary" disabled={busy} onClick={() => void files(() => window.office.backupWorkspace())}><ArrowUpFromLine size={15}/>Create backup</button></div><div className="setting-row"><div><strong>Restore a backup</strong><p>Choose a saved workspace to restore. Your current workspace is retained as a recovery copy.</p></div><button className="secondary" disabled={busy} onClick={() => void files(() => window.office.restoreWorkspace())}><ArrowDownToLine size={15}/>Restore backup</button></div><div className="setting-row"><div><strong>Legacy records</strong><p>Give old task records a native request. The workspace is copied first and the migration is verified by replay; historical outcomes stay marked as never observed.</p></div><button className="secondary" disabled={busy} onClick={() => { void window.office.migrateLegacyRecords().then(result => { acceptState(result.state); setNotice(result.migrated ? `Migrated ${result.migrated} legacy record${result.migrated === 1 ? '' : 's'} as drafts carrying an explicit ambiguity blocker.` : 'No legacy records needed migrating.'); }).catch(error => setNotice(error.message)); }}>Migrate legacy records</button></div><div className="setting-row"><div><strong>Data location</strong><p className="path-text">{info?.dataDirectory || 'Unavailable'}</p></div></div></div><div className="settings-card"><h2>Execution boundaries</h2><div className="boundary-grid"><div><span className="boundary-number">01</span><strong>This desktop</strong><p>Prompts, task routing, local records, and explicit file transfers.</p></div><div><span className="boundary-number">02</span><strong>Provider infrastructure</strong><p>All agent reasoning, coding, verification, and research calculations.</p></div><div><span className="boundary-number">03</span><strong>Your Colab session</strong><p>Manual execution by you. No agent access or integration.</p></div></div></div></>}
    {page === 'Add Agent' && <AgentSetup onAdded={next=>{acceptState(next);setPage('Office');setNotice('Agent added. Hosted research execution remains blocked until configured.');}}/>}
   </main>
   <footer className="statusbar"><span><span className="status-dot"/>Local record ready</span><span>{state.agents.filter(a=>!a.removedAt).length} registered agents<span className="statusbar-divider">|</span>{blockedRequests} blocked requests · all projects<span className="statusbar-divider">|</span>No active provider jobs</span></footer>
  </div>
  {agentDetailId && state.agents.find(a=>a.id===agentDetailId) && <Dialog wide title={state.agents.find(a=>a.id===agentDetailId)!.name} onClose={()=>setAgentDetailId(null)}><ProfileTabs key={agentDetailId+":tabs"} agent={state.agents.find(a=>a.id===agentDetailId)!} state={state} onState={acceptState}><ProfileEditor key={agentDetailId} agent={state.agents.find(a=>a.id===agentDetailId)!} onState={acceptState}/><ConnectionBinding key={agentDetailId+":binding"} agent={state.agents.find(a=>a.id===agentDetailId)!} state={state} onState={acceptState}/><AgentDetails key={agentDetailId} agent={state.agents.find(a=>a.id===agentDetailId)!} state={state} onState={acceptState}/></ProfileTabs></Dialog>}
  {modal && <Dialog title={modal === 'experiment' ? 'New request' : modal === 'edit-project' ? 'Edit project' : 'Create a project'} onClose={() => { if (!busy) setModal(null); }}><form onSubmit={modal === 'experiment' ? submitExperiment : submitProject}><p className="dialog-description">{modal === 'experiment' ? 'Save a draft, then Start request to check readiness. Only empirical experiments create scientific details.' : 'A project keeps its experiments and evidence together.'}</p><label className="field">{modal === 'experiment' ? 'Request name' : 'Project name'}<input name="name" autoFocus maxLength={160} defaultValue={modal === 'edit-project' ? project?.name : ''} placeholder={modal === 'experiment' ? 'e.g. Out-of-sample volatility forecast' : 'e.g. Volatility forecasting research'} required/></label><label className="field">{modal === 'experiment' ? 'Objective' : 'Research mandate'}<textarea name={modal === 'experiment' ? 'hypothesis' : 'mandate'} defaultValue={modal === 'edit-project' ? project?.mandate : ''} maxLength={modal === 'experiment' ? 12000 : 20000} rows={4} placeholder={modal === 'experiment' ? 'What do you expect to observe, and why?' : 'What should this project investigate?'} required/></label>{modal!=='experiment'&&<><label className="field">Project folder on this device<input readOnly value={localFolder??(modal==='edit-project'?project?.localFolder??'':'')} placeholder="Folder not selected"/></label><button type="button" onClick={()=>void window.office.chooseProjectFolder().then(folder=>{if(folder)setLocalFolder(folder);}).catch(fail)}>Choose project folder</button><label className="field">Cloud workspace reference<input name="cloudWorkspace" maxLength={1000} defaultValue={modal==='edit-project'?project?.cloudWorkspace??'':''} placeholder="Provider / environment / repository revision"/></label><p className="muted">Cloud reference is unverified. Choosing a folder does not upload or execute files. The office database remains in application data.</p></>}{modal==='experiment'&&<><label className="field">Project<select name="requestProjectId" defaultValue={projectId}>{state.projects.filter(p=>!p.archived).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="field">Work type<select name="workType" defaultValue="QUESTION"><option value="QUESTION">Question</option><option value="ANALYSIS">Research analysis</option><option value="IMPLEMENTATION">Code implementation</option><option value="CODE_REVIEW">Code review</option><option value="EXPERIMENT">Empirical experiment</option></select></label><label className="field">Execution mode<select value={requestMode} onChange={e=>setRequestMode(e.target.value as WorkMode)}><option value="SINGLE">Single agent</option><option value="GROUP">Selected group</option><option value="TEAM">Full research team</option></select></label><label className="field">Responsible agent<select name="leadAgentId"><option value="">Choose later</option>{state.agents.filter(a=>!a.removedAt).map(a=><option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}</select></label>{requestMode!=='SINGLE'&&<label className="field">Collaborators<select multiple name="participantIds">{state.agents.filter(a=>!a.removedAt).map(a=><option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}</select></label>}<label className="field">Acceptance criteria<textarea name="acceptanceCriteria" maxLength={12000}/></label></>}{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setModal(null)}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : modal === 'experiment' ? 'Save draft' : modal === 'edit-project' ? 'Save changes' : 'Create project'}</button></div></form></Dialog>}
  {preview && <Dialog title={preview.name} wide onClose={() => setPreview(null)}><div className="inline-note"><ShieldCheck size={16}/><span>Safe text preview. File contents are never executed.</span></div>{preview.binary ? <Empty icon={Box} title="Binary file" description="This file is stored as an artifact. A text preview is not available."/> : <pre className="artifact-preview">{preview.text || '(Empty file)'}</pre>}{preview.truncated && <p className="footnote">Preview truncated. Export the project to inspect the complete file.</p>}</Dialog>}
 </div>;
}

function ContractEditor({ experiment, disabled, command }: { experiment: Experiment; disabled: boolean; command: (c: CommandInput, n?: string) => Promise<AppState | null> }) {
 const [initial] = useState(() => readContractDraft(experiment));
 const [draft, setDraft] = useState<ResearchContract>(initial.draft);
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
   try { localStorage.setItem(key, JSON.stringify(snapshot)); } catch {}
  } else {
   contractDrafts.delete(experiment.id);
   try { localStorage.removeItem(key); } catch {}
  }
 }, [draft, baseRevision, saved, dirty, experiment.id]);
 useEffect(() => {
  if (!dirty && experiment.revision !== baseRevision) {
   setDraft({ ...experiment.contract }); setBaseRevision(experiment.revision); setSaved(JSON.stringify(experiment.contract));
  }
 }, [experiment.revision, experiment.contract, baseRevision, dirty]);
 const reload = () => { setDraft({ ...experiment.contract }); setBaseRevision(experiment.revision); setSaved(JSON.stringify(experiment.contract)); };
 async function save() { const next = await command({ type: 'contract.save', experimentId: experiment.id, expectedRevision: baseRevision, contract: draft }, 'Research contract saved as a new version.'); const updated = next?.experiments.find(e => e.id === experiment.id); if (updated) { setBaseRevision(updated.revision); setSaved(JSON.stringify(updated.contract)); setDraft({ ...updated.contract }); } }
 async function submit() { const next = await command({ type: 'contract.submit', experimentId: experiment.id, expectedRevision: baseRevision }, 'Contract submitted. Review remains blocked until agents are configured.'); const updated = next?.experiments.find(e => e.id === experiment.id); if (updated) { setBaseRevision(updated.revision); setSaved(JSON.stringify(updated.contract)); setDraft({ ...updated.contract }); } }
 return <section className="contract-editor"><div className="contract-heading"><div><div className="eyebrow">RESEARCH CONTRACT · VERSION {baseRevision}</div><h2>{experiment.name}</h2><p>{experiment.hypothesis}</p></div><span className="status-badge">{label(experiment.stage)}</span></div>{conflict && <div className="notice error"><span>A newer contract revision is available. Reload the current version before saving; your unsaved edits will be replaced.</span><button className="secondary" onClick={reload}>Discard edits &amp; reload</button></div>}{!editable && <div className="inline-note"><LockKeyhole size={16}/>{experiment.stage==='CANCELED'?'This request was canceled. Its research details are read-only.':'This contract is frozen for its current stage.'}</div>}<div className="contract-fields">{contractFields.map(([key, title, placeholder], i) => <label className="field contract-field" key={key}><span><b>{String(i + 1).padStart(2, '0')}</b>{title}</span><textarea value={draft[key]} disabled={disabled || !editable} rows={3} maxLength={12000} placeholder={placeholder} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}/></label>)}</div><div className="contract-actions"><span className="muted">{dirty ? 'Unsaved changes · draft retained' : 'Saved version'} · Reviews require configured provider agents</span><div className="button-row"><button className="secondary" disabled={disabled || !editable || !dirty || conflict} onClick={() => void save()}>Save contract</button><button className="primary" disabled={disabled || !editable || dirty || conflict || experiment.stage === 'CONTRACT_REVIEW' || !draft.objective.trim()} onClick={() => void submit()}><ShieldCheck size={15}/>{experiment.stage === 'CONTRACT_REVIEW' ? 'Awaiting review' : 'Submit for review'}</button></div></div></section>;
}

function Empty({ icon: Icon, title, description, action }: { icon: typeof Folder; title: string; description: string; action?: React.ReactNode }) { return <div className="empty-state"><div className="empty-icon"><Icon size={29} strokeWidth={1.4}/></div><h2>{title}</h2><p>{description}</p>{action}</div>; }
function Metric({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="metric-card"><span className="mini-label">{label}</span><strong>{value}</strong><p>{detail}</p></div>; }
function SearchField({ value, onChange, placeholder }: { value: string; onChange: (s: string) => void; placeholder: string }) { return <label className="search-field"><Search size={15}/><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}/></label>; }
function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
 const ref = useRef<HTMLDialogElement>(null);
 useEffect(() => { const dialog = ref.current; if (!dialog) return; const previous = document.activeElement as HTMLElement | null; dialog.showModal(); return () => { dialog.close(); previous?.focus(); }; }, []);
 return <dialog ref={ref} className={wide ? 'dialog wide' : 'dialog'} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }}><div className="dialog-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={19}/></button></div>{children}</dialog>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);



