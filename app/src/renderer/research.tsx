import React, { useEffect, useState } from 'react';
import { ArrowLeft, BookOpen, LockKeyhole, Plus, ShieldCheck } from 'lucide-react';
import type { AppState, Command, Experiment, Project, ResearchContract } from '../shared/types';
import { ResearchPipeline } from './pipeline';
import { Empty, label } from './components';
import './research.css';

type CommandInput = Command extends infer C ? C extends Command ? Omit<C, 'idempotencyKey'> : never : never;

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

export function ResearchView({ state, project, projectId, experiments, experiment, experimentId, busy, command, onSelectExperiment, onBack, onEditProject, onNewRequest }: { state: AppState; project: Project; projectId: string; experiments: Experiment[]; experiment: Experiment | undefined; experimentId: string; busy: boolean; command: (c: CommandInput, n?: string) => Promise<AppState | null>; onSelectExperiment: (id: string) => void; onBack: () => void; onEditProject: () => void; onNewRequest: () => void }) {
 return <><button className="back-link" onClick={onBack}><ArrowLeft size={15}/>Back to projects</button><ResearchPipeline key={projectId} state={state} projectId={projectId}/><div className="research-overview"><div className="research-overview-body"><span className="mini-label">PROJECT MANDATE</span><div className="research-overview-title"><h2>{project?.name}</h2><span className="quiet-badge small">{project?.archived ? 'Archived' : 'Active'}</span></div><p>{project?.mandate || 'Add a mandate to describe the scope of this project.'}</p></div><div className="button-row"><button className="primary" disabled={busy || project?.archived} onClick={onNewRequest}><Plus size={15}/>New request</button><button className="secondary" onClick={onEditProject}>Edit project</button><button className="text-button" disabled={busy} onClick={() => void command({ type: 'project.archive', projectId, archived: !project?.archived }, project?.archived ? 'Project restored.' : 'Project archived.')}>{project?.archived ? 'Restore project' : 'Archive project'}</button></div></div>{experiments.length > 0 && <div className="experiment-tabs" aria-label="Experiments">{experiments.map(e => <button aria-pressed={experimentId === e.id} className={experimentId === e.id ? 'selected' : ''} onClick={() => onSelectExperiment(e.id)} key={e.id}>{e.name}<span>{label(e.stage)}</span></button>)}</div>}{experiment ? <ContractEditor key={experiment.id} experiment={experiment} disabled={busy || !!project?.archived} command={command}/> : <Empty icon={BookOpen} title={experiments.length ? 'Choose an experiment' : 'Define your first experiment'} description="Open research details from the work queue, or create a new request." action={<button className="primary" disabled={project?.archived} onClick={onNewRequest}><Plus size={15}/>New request</button>}/>}</>;
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
