import React,{useState} from 'react';
import {ArrowUpRight,Folder,FolderPlus,Plus,Settings2} from 'lucide-react';
import type {AppState,Project,ProjectLocation} from '../shared/types';
import {Empty,SearchField} from './components';
import './projects.css';

function ProjectLocationPanel({project,saved,location,onState}:{project:Project;saved:ProjectLocation|undefined;location:string;onState:(s:AppState)=>void}){
 const [folder,setFolder]=useState(location);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const dirty=folder!==location;
 async function pickFolder(){
  setError('');
  try{const chosen=await window.office.chooseProjectFolder();if(chosen)setFolder(chosen);}
  catch(e){setError((e as Error).message);}
 }
 async function save(){
  setBusy(true);setError('');setNotice('');
  try{onState(await window.office.command({type:'location.save',idempotencyKey:crypto.randomUUID(),projectId:project.id,expectedRevision:saved?.revision??0,localFolder:folder,inputPaths:saved?.inputPaths??[],outputFolder:saved?.outputFolder??''}));setNotice('Saved. Nothing has been transferred.');}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <div className="project-row-panel">
  <div><strong>Project folder on this device</strong><p className="path-text">{location||'Not selected'}</p></div>
  <label className="field">Location<input value={folder} disabled={busy||project.archived} onChange={e=>setFolder(e.target.value)} placeholder="Not selected"/></label>
  {project.archived&&<p className="muted">Archived projects are read-only; restore the project to change its location.</p>}
  {error&&<p className="notice error" role="alert">{error}</p>}
  {notice&&<p className="notice success" role="status">{notice}</p>}
  <div className="button-row"><button className="secondary" disabled={busy||project.archived} onClick={()=>void pickFolder()}>Choose folder</button><button className="primary" disabled={busy||!dirty||project.archived} onClick={()=>void save()}>Save</button></div>
 </div>;
}

export function ProjectsView({state,projectId,onState,onOpenProject,onNewProject}:{state:AppState;project:Project|undefined;projectId:string;onState:(s:AppState)=>void;onOpenProject:(id:string)=>void;onNewProject:()=>void;onError:(e:unknown)=>void}){
 const [projectLifecycle,setProjectLifecycle]=useState('active');
 const [search,setSearch]=useState('');
 const [settingsFor,setSettingsFor]=useState<string|null>(null);
 const activeProjects=state.projects.filter(p=>!p.archived);
 return <><div className="section-toolbar"><span>{activeProjects.length} active projects · {state.projects.filter(p => p.archived).length} archived</span><label className="field">Project lifecycle<select value={projectLifecycle} onChange={e=>setProjectLifecycle(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label><SearchField value={search} onChange={setSearch} placeholder="Find a project"/></div>{!state.projects.length ? <Empty icon={FolderPlus} title="Every discovery starts with a question" description="Create a project for a research question, strategy family, or model comparison. No model family is assumed." action={<button className="primary" onClick={onNewProject}><Plus size={16}/>Create first project</button>}/> : <div className="project-list">{state.projects.filter(p=>projectLifecycle==='all'||(projectLifecycle==='archived')===p.archived).filter(p => `${p.name} ${p.mandate}`.toLowerCase().includes(search.toLowerCase())).map(p => {const saved=state.locations?.find(l=>l.projectId===p.id),location=saved?.localFolder??p.localFolder??'',open=settingsFor===p.id;return <div className={`project-row-item ${p.id === projectId ? 'chosen' : ''}`} key={p.id}><div className="project-row"><span className="folder-emblem"><Folder size={20}/></span><div className="project-row-main"><h2>{p.name}</h2><p>{p.mandate || 'No mandate recorded.'}</p></div><span className="path-text project-row-location">{location||'Not selected'}</span><span className="project-row-count"><strong>{state.experiments.filter(e => e.projectId === p.id).length}</strong> experiments</span><span className="quiet-badge small">{p.archived ? 'Archived' : p.id === projectId ? 'Selected' : 'Active'}</span><div className="project-row-actions"><button className="project-open" onClick={() => onOpenProject(p.id)}>Open project<ArrowUpRight size={15}/></button><button className="icon-button" aria-label={`Location settings for ${p.name}`} aria-expanded={open} onClick={()=>setSettingsFor(open?null:p.id)}><Settings2 size={16}/></button></div></div>{open&&<ProjectLocationPanel project={p} saved={saved} location={location} onState={onState}/>}</div>;})}</div>}</>;
}
