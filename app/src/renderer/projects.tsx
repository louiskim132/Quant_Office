import React,{useState} from 'react';
import {ArrowUpRight,Folder,FolderPlus,Plus,Settings2,X} from 'lucide-react';
import type {AppState,Project,ProjectLocation} from '../shared/types';
import {Empty,SearchField} from './components';
import './projects.css';

const samePaths=(a:string[],b:string[])=>a.length===b.length&&a.every((value,index)=>value===b[index]);
const childPath=(root:string,name:string)=>`${root.replace(/[\\/]+$/,'')}${root.includes('\\')?'\\':'/'}${name}`;

export function ProjectLocationPanel({project,saved,location,onState}:{project:Project;saved:ProjectLocation|undefined;location:string;onState:(s:AppState)=>void}){
 const [folder,setFolder]=useState(location);
 const [inputs,setInputs]=useState<string[]>(saved?.inputPaths??[]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const dirty=folder!==location||!samePaths(inputs,saved?.inputPaths??[]);
 async function pickFolder(){
  setError('');
  // Selected paths are relative to the folder they were picked under: a new root clears the pending
  // list, while returning to the saved root restores the saved selection.
  try{const chosen=await window.office.chooseProjectFolder();if(chosen){setFolder(chosen);if(chosen!==folder)setInputs(chosen===location?saved?.inputPaths??[]:[]);}}
  catch(e){setError((e as Error).message);}
 }
 async function pickInputs(){
  setError('');
  try{const chosen=await window.office.chooseInputFiles(folder);if(chosen.length)setInputs(prev=>[...new Set([...prev,...chosen])].sort());}
  catch(e){setError((e as Error).message);}
 }
 async function save(){
  setBusy(true);setError('');setNotice('');
  try{onState(await window.office.command({type:'location.save',idempotencyKey:crypto.randomUUID(),projectId:project.id,expectedRevision:saved?.revision??0,localFolder:folder,inputPaths:inputs,outputFolder:saved?.outputFolder??''}));setNotice('Saved. Nothing has been transferred.');}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <div className="project-row-panel">
  <div><strong>Project folder on this device</strong><p className="path-text">{folder||'Not selected'}</p>
  {folder&&<p className="muted">Files placed in <span className="path-text">{childPath(folder,'inputs')}</span> or selected below are shared with requests.</p>}</div>
  <div><strong>Input files</strong>
  {inputs.length?<ul className="input-file-list">{inputs.map(item=><li key={item}><span className="path-text">{item}</span><button className="icon-button" aria-label={`Remove ${item}`} disabled={busy||project.archived} onClick={()=>setInputs(prev=>prev.filter(entry=>entry!==item))}><X size={13}/></button></li>)}</ul>:<p className="muted">{folder?'No files selected.':'Choose the project folder before selecting files.'}</p>}
  {inputs.length>0&&<p className="muted">Selected paths resolve under <span className="path-text">{folder}</span>.</p>}</div>
  {project.archived&&<p className="muted">Archived projects are read-only; restore the project to change its location. Remove from list hides it from pickers and lists — its requests, experiments, history and stored files are retained.</p>}
  {error&&<p className="notice error" role="alert">{error}</p>}
  {notice&&<p className="notice success" role="status">{notice}</p>}
  <div className="button-row"><button className="secondary" disabled={busy||project.archived} onClick={()=>void pickFolder()}>Choose folder</button><button className="secondary" disabled={busy||!folder||project.archived} onClick={()=>void pickInputs()}>Choose input files</button><button className="primary" disabled={busy||!dirty||project.archived} onClick={()=>void save()}>Save</button></div>
 </div>;
}

export function ProjectsView({state,projectId,onState,onOpenProject,onNewProject,onError}:{state:AppState;project:Project|undefined;projectId:string;onState:(s:AppState)=>void;onOpenProject:(id:string)=>void;onNewProject:()=>void;onError:(e:unknown)=>void}){
 const [projectLifecycle,setProjectLifecycle]=useState('active');
 const [search,setSearch]=useState('');
 const [settingsFor,setSettingsFor]=useState<string|null>(null);
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
 return <><div className="section-toolbar"><span>{visible.filter(p=>!p.archived).length} active projects · {visible.filter(p => p.archived).length} archived{removed.length>0&&` · ${removed.length} removed`}</span><label className="field">Project lifecycle<select value={projectLifecycle} onChange={e=>setProjectLifecycle(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option><option value="removed">Removed</option></select></label><SearchField value={search} onChange={setSearch} placeholder="Find a project"/></div>{!listed.length ? (projectLifecycle==='removed' ? <p className="muted">No removed projects. Removed projects appear here until restored; their records and files are retained.</p> : <Empty icon={FolderPlus} title="Every discovery starts with a question" description="Create a project for a research question, strategy family, or model comparison. No model family is assumed." action={<button className="primary" onClick={onNewProject}><Plus size={16}/>Create first project</button>}/>) : <div className="project-list">{listed.filter(p => `${p.name} ${p.mandate}`.toLowerCase().includes(search.toLowerCase())).map(p => {const saved=state.locations?.find(l=>l.projectId===p.id),location=saved?.localFolder??p.localFolder??'',open=settingsFor===p.id;return <div className={`project-row-item ${p.id === projectId ? 'chosen' : ''}`} key={p.id}><div className="project-row"><span className="folder-emblem"><Folder size={20}/></span><div className="project-row-main"><h2>{p.name}</h2><p>{p.mandate || 'No mandate recorded.'}</p></div><span className="path-text project-row-location">{location||'Not selected'}</span><span className="project-row-count"><strong>{state.experiments.filter(e => e.projectId === p.id).length}</strong> experiments</span><span className="quiet-badge small">{p.removedAt ? 'Removed' : p.archived ? 'Archived' : p.id === projectId ? 'Selected' : 'Active'}</span><div className="project-row-actions">{p.removedAt ? <button className="project-open" title="Brings this project back into the archived list. Restore it again there to make it active. All records were retained." onClick={()=>void restore(p.id)}>Restore</button> : <><button className="project-open" onClick={() => onOpenProject(p.id)}>Open project<ArrowUpRight size={15}/></button>{p.archived&&<button className="project-remove" title="Hides this archived project from pickers and lists. Its requests, experiments, history and stored files are retained." onClick={()=>void remove(p.id)}>Remove from list</button>}<button className="icon-button" aria-label={`Location settings for ${p.name}`} aria-expanded={open} onClick={()=>setSettingsFor(open?null:p.id)}><Settings2 size={16}/></button></>}</div></div>{open&&<ProjectLocationPanel project={p} saved={saved} location={location} onState={onState}/>}</div>;})}</div>}</>;
}
