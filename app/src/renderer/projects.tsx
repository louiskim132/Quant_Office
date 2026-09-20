import React,{useState} from 'react';
import {ArrowUpRight,Folder,FolderOpen,FolderPlus,Plus} from 'lucide-react';
import type {AppState,Command,Project,ProjectLocation} from '../shared/types';
import {Empty,SearchField} from './components';
import './projects.css';

export function ProjectLocationPanel({project,saved,location,onState}:{project:Project;saved:ProjectLocation|undefined;location:string;onState:(s:AppState)=>void}){
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
  try{onState(await window.office.command({type:'location.save',idempotencyKey:crypto.randomUUID(),projectId:project.id,expectedRevision:saved?.revision??0,localFolder:folder,outputFolder:saved?.outputFolder??''} as Command));setNotice('Saved. Nothing has been transferred.');}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <div className="project-row-panel">
  <div><strong>Project folder on this device</strong><p className="path-text">{folder||'Not selected'}</p>
  {folder&&<p className="muted">Everything in this folder is shared when a request is prepared — hashed into a frozen snapshot the packet manifest lists by path, size and hash. Credential files, tool configuration, dependency and cache folders (e.g. .git, node_modules, .venv) and links are skipped automatically, and each skip is recorded on the snapshot.</p>}</div>
  {project.archived&&<p className="muted">Archived projects are read-only; restore the project to change its location. Remove from list hides it from pickers and lists — its requests, experiments, history and stored files are retained.</p>}
  {error&&<p className="notice error" role="alert">{error}</p>}
  {notice&&<p className="notice success" role="status">{notice}</p>}
  <div className="button-row"><button className="secondary" disabled={busy||project.archived} onClick={()=>void pickFolder()}>Choose folder</button><button className="primary" disabled={busy||!dirty||project.archived} onClick={()=>void save()}>Save</button></div>
 </div>;
}

export function ProjectsView({state,projectId,onState,onOpenProject,onNewProject,onError}:{state:AppState;project:Project|undefined;projectId:string;onState:(s:AppState)=>void;onOpenProject:(id:string)=>void;onNewProject:()=>void;onError:(e:unknown)=>void}){
 const [projectLifecycle,setProjectLifecycle]=useState('active');
 const [search,setSearch]=useState('');
 const removed=state.projects.filter(p=>p.removedAt);
 const visible=state.projects.filter(p=>!p.removedAt);
 const listed=projectLifecycle==='removed'?removed:visible.filter(p=>projectLifecycle==='all'||(projectLifecycle==='archived')===p.archived);
 async function remove(id:string){
  try{onState(await window.office.command({type:'project.delete',idempotencyKey:crypto.randomUUID(),projectId:id}));}
  catch(e){onError(e);}
 }
 async function restore(id:string){
  try{onState(await window.office.command({type:'project.archive',idempotencyKey:crypto.randomUUID(),projectId:id,archived:false}));}
  catch(e){onError(e);}
 }
 async function openFolder(id:string){
  try{await window.office.openProjectFolder(id);}
  catch(e){onError(e);}
 }
 return <><div className="section-toolbar"><span>{visible.filter(p=>!p.archived).length} active projects · {visible.filter(p => p.archived).length} archived{removed.length>0&&` · ${removed.length} removed`}</span><label className="field">Project lifecycle<select value={projectLifecycle} onChange={e=>setProjectLifecycle(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option><option value="removed">Removed</option></select></label><SearchField value={search} onChange={setSearch} placeholder="Find a project"/></div>{!listed.length ? (projectLifecycle==='removed' ? <p className="muted">No removed projects. Removed projects appear here until restored; their records and files are retained.</p> : <Empty icon={FolderPlus} title="Every discovery starts with a question" description="Create a project for a research question, strategy family, or model comparison. No model family is assumed." action={<button className="primary" onClick={onNewProject}><Plus size={16}/>Create first project</button>}/>) : <div className="project-list">{listed.filter(p => `${p.name} ${p.mandate}`.toLowerCase().includes(search.toLowerCase())).map(p => {const saved=state.locations?.find(l=>l.projectId===p.id),location=saved?.localFolder??p.localFolder??'';return <div className={`project-row-item ${p.id === projectId ? 'chosen' : ''}`} key={p.id}><div className="project-row">{p.removedAt?<><span className="folder-emblem"><Folder size={20}/></span><div className="project-row-main"><h2>{p.name}</h2><p>{p.mandate || 'No mandate recorded.'}</p></div></>:<button type="button" className="project-open-region" aria-label={`Open ${p.name}`} onClick={() => onOpenProject(p.id)}><span className="folder-emblem"><Folder size={20}/></span><span className="project-row-main"><span className="project-row-name">{p.name}</span><span className="project-row-mandate">{p.mandate || 'No mandate recorded.'}</span></span></button>}<span className="path-text project-row-location">{location||'Not selected'}</span><span className="project-row-count"><strong>{state.experiments.filter(e => e.projectId === p.id).length}</strong> experiments</span><span className="quiet-badge small">{p.removedAt ? 'Removed' : p.archived ? 'Archived' : p.id === projectId ? 'Selected' : 'Active'}</span><div className="project-row-actions">{p.removedAt ? <button className="project-open" title="Brings this project back into the archived list. Restore it again there to make it active. All records were retained." onClick={()=>void restore(p.id)}>Restore</button> : <><button className="project-open" onClick={() => onOpenProject(p.id)}>Open project<ArrowUpRight size={15}/></button>{p.archived&&<button className="project-remove" title="Hides this archived project from pickers and lists. Its requests, experiments, history and stored files are retained." onClick={()=>void remove(p.id)}>Remove from list</button>}<button className="icon-button" aria-label={`Open folder for ${p.name}`} title={`Open folder for ${p.name}`} onClick={()=>void openFolder(p.id)}><FolderOpen size={16}/></button></>}</div></div></div>;})}</div>}</>;
}
