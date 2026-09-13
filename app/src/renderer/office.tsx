import React, {useEffect,useState,useRef,useLayoutEffect} from 'react';
import type {Agent,AppState,Experiment,Role,Command,Request} from '../shared/types';
import {agentBinding,providerReadiness} from '../shared/readiness';
import {RequestDispatch} from './dispatch';
import './office.css';
import {requestQueue,queueScope,type QueueFilter} from '../shared/queue';
import {officeActivity} from '../shared/activity';

// The scene accepts live assignments only. Historical transcripts never imply current activity.
export interface LiveOfficeActivity {agentId:string; kind:'WORKING'|'MEETING'|'IDLE'|'UNKNOWN'; meetingId?:string;}
export function OfficeScene({agents,onAgent,activity=[],state}:{agents:Agent[];onAgent:(id:string)=>void;activity?:LiveOfficeActivity[];state?:AppState}){
 // Activity is derived, never stored: a stale provider feed shows as unknown rather than idle.
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
 const live=state?officeActivity(state,{now}):activity;
 activity=live;
 const team=agents.filter(a=>!a.removedAt);
 const slots=useRef<string[]>([]),rooms=useRef<string[]>([]),scene=useRef<HTMLElement|null>(null),positions=useRef(new Map<string,DOMRect>());
 for(const agent of team)if(!slots.current.includes(agent.id))slots.current.push(agent.id);
 const seats=slots.current.map(id=>team.find(a=>a.id===id)??null);
 useLayoutEffect(()=>{
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches||document.documentElement.dataset.motion==='reduced';
  const next=new Map<string,DOMRect>();
  for(const node of scene.current?.querySelectorAll<HTMLElement>('[data-office-agent]')??[]){
   const id=node.dataset.officeAgent!,rect=node.getBoundingClientRect(),prior=positions.current.get(id);next.set(id,rect);
   if(prior&&!reduced&&(Math.abs(prior.x-rect.x)>1||Math.abs(prior.y-rect.y)>1))node.animate([{transform:'translate('+(prior.x-rect.x)+'px,'+(prior.y-rect.y)+'px)'},{transform:'translate(0,0)'}],{duration:700,easing:'ease-in-out'});
  }
  positions.current=next;
 });
 const person=(agent:Agent,index:number,meeting=false)=><button data-office-agent={agent.id} className={`office-person ${meeting?'talking':''}`} style={{'--shirt':['#3c74c4','#9265b2','#299d9c','#df9850'][index%4]} as React.CSSProperties} onClick={()=>onAgent(agent.id)} aria-label={`Edit ${agent.name} profile`}><span className="person-hair"/><span className="person-head"/><span className="person-body"/><span className="person-arms"/><span className="person-legs"/>{meeting&&<span className="speech">•••</span>}</button>;
 const activeMeetings=[...new Set(activity.filter(a=>a.kind==='MEETING'&&team.some(t=>t.id===a.agentId)).map(a=>a.meetingId??'meeting'))].sort();
 for(const id of activeMeetings)if(!rooms.current.includes(id)){const empty=rooms.current.findIndex(r=>!activeMeetings.includes(r));if(empty<0)rooms.current.push(id);else rooms.current[empty]=id;}
 const meetings=rooms.current.map(id=>activeMeetings.includes(id)?id:null);
 return <section ref={scene} className="sky-office"><div className="sky-wall"><span>QUANT / RESEARCH LAB</span><div className="sky-windows"><i/><i/><i/></div></div><div className="sky-floor"><div className="workstations">{(seats.length?seats:[null,null,null,null]).map((agent,i)=>{const status=activity.find(a=>a.agentId===agent?.id);return <div className="workstation" key={agent?.id??i}><div className={`office-monitor ${status?.kind==='WORKING'?'on':''}`} aria-label={status?.kind==='WORKING'?'Computer on':'Computer off'}><i/></div><div className="office-desk"><i className="keyboard"/><i className="coffee"/></div><div className="office-chair"/>{agent&&status?.kind!=='MEETING'&&person(agent,i)}<div className="station-label">{agent&&<strong className="person-name">{agent.name}</strong>}<span>{agent?status?.kind==='WORKING'?'Working':status?.kind==='MEETING'?'In a meeting':status?.kind==='IDLE'?'Idle · no open provider work':'Unknown · feed disconnected':'Available seat'}</span></div></div>;})}</div><aside className="meeting-wing">{Array.from({length:Math.max(2,meetings.length)},(_,i)=><section className="meeting-room" key={i}><h3>{i===0?'COLLABORATION':'REVIEW'} ROOM {i+1}</h3><div className="meeting-table"/><div className="meeting-people">{team.filter(a=>activity.some(s=>s.agentId===a.id&&s.kind==='MEETING'&&(s.meetingId??'meeting')===meetings[i])).map((a,j)=><div className="meeting-member" key={a.id}>{person(a,j,true)}<strong>{a.name}</strong></div>)}</div><span>{meetings[i]?'Conversation in progress':'No active meeting'}</span></section>)}</aside></div><div className="sky-caption"><span>{team.length} agents · click a person to edit their profile</span><span>Activity follows recorded provider evidence; stale work is unknown</span></div></section>;
}

export function WorkQueue({state,busy,onNew,onOpen,onCancel,onAction,onState}:{state:AppState;onAction:(command:Command)=>void;busy:boolean;onNew:()=>void;onOpen:(e:Experiment)=>void;onCancel:(id:string)=>void;onState:(s:AppState)=>void}){
 const [filter,setFilter]=useState<'active'|'completed'|'canceled'|'all'>('active');
 const [scopeProject,setScopeProject]=useState('');
 const [scopeAgent,setScopeAgent]=useState('');
 const [scopeTeam,setScopeTeam]=useState('');
 const [search,setSearch]=useState('');
 const queueFilter:QueueFilter={lifecycle:filter.toUpperCase() as QueueFilter['lifecycle'],
  ...(scopeProject?{projectId:scopeProject}:{}),...(scopeAgent?{agentId:scopeAgent}:{}),...(scopeTeam?{teamId:scopeTeam}:{}),...(search?{search}:{})};
 const scope=queueScope(state,queueFilter);
 const rows=[...scope.entries].reverse();
 return <section className="work-queue"><div className="section-toolbar"><div><h2>Work queue · {scopeProject?state.projects.find(p=>p.id===scopeProject)?.name??'one project':'all projects'}</h2><p className="muted">New request → Research details → Review → Provider work → Results</p></div><button className="primary" onClick={onNew}>New request</button></div><div className="log-filters">
 <label className="field queue-filter">Show requests<select value={filter} onChange={e=>setFilter(e.target.value as typeof filter)}>
  <option value="active">Active ({scope.counts.active})</option><option value="completed">Completed ({scope.counts.completed})</option>
  <option value="canceled">Canceled ({scope.counts.canceled})</option><option value="all">All requests ({scope.counts.all})</option></select></label>
 <label className="field">Project<select value={scopeProject} onChange={e=>setScopeProject(e.target.value)}><option value="">All projects</option>{state.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
 <label className="field">Agent<select value={scopeAgent} onChange={e=>setScopeAgent(e.target.value)}><option value="">Any agent</option>{state.agents.filter(a=>!a.removedAt).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
 <label className="field">Team<select value={scopeTeam} onChange={e=>setScopeTeam(e.target.value)}><option value="">Any team</option>{(state.teams??[]).map(team=><option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
 <label className="field">Search<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Request or agent"/></label>
</div>
<p className="muted">{scope.counts.all} request{scope.counts.all===1?'':'s'} in this scope · {scope.counts.active} active · {scope.counts.completed} completed · {scope.counts.canceled} canceled</p>{!rows.length&&<p className="inline-note">No {filter==='all'?'':filter} requests. Create a new request to start an investigation.</p>}<div className="task-list">{rows.map(row=>{const {root}=row,exp=state.experiments.find(e=>e.id===root.experimentId),project=state.projects.find(p=>p.id===root.projectId),canceled=row.status==='CANCELED';return <article className="task-card" key={root.id}><div className="card-heading"><h3>{row.request?.name??exp?.name??'Research request'}</h3><span className="status-badge">{canceled?'Canceled':row.status==='ACCEPTED'?'Completed':row.status.toLowerCase()}</span></div><p>{root.prompt}</p><p className="muted">{project?.name} · {exp?.stage.replaceAll('_',' ').toLowerCase()??'Project request'}</p>{!canceled&&root.blocker&&<p className="blocker">{root.blocker}</p>}{row.request&&<><p className="muted">{row.request.workType.toLowerCase().replaceAll('_',' ')} · {row.request.mode.toLowerCase()} · Lead: {state.agents.find(a=>a.id===row.request?.leadAgentId)?.name??'Not selected'}</p>{row.request.blockers.map(b=><p className="blocker" key={b.code+b.message}>{b.message} {b.action}.</p>)}<details><summary>Participants and acceptance criteria</summary><p>{[...new Set([row.request.leadAgentId,...row.request.participantIds])].filter(Boolean).map(id=>state.agents.find(a=>a.id===id)?.name??id).join(', ')||'None selected'}</p><p>{row.request.acceptanceCriteria||'No criteria recorded.'}</p>{row.canCancel&&<><RequestEditor key={row.id+':'+row.request.revision} request={row.request} state={state} busy={busy} onAction={onAction}/><RequestDispatch key={row.id+":dispatch"} request={row.request} state={state} onState={onState}/></>}<p>{row.request.delegation?'Collaboration requested':'Automatic delegation disabled'} · No provider job submitted · No independent review</p></details></>}<div className="button-row">{row.request&&<><button disabled={busy||!row.canCancel} onClick={()=>onAction({type:'request.start',requestId:row.id,expectedRevision:row.request!.revision,idempotencyKey:crypto.randomUUID()})}>Start request</button><button disabled={busy||project?.archived} onClick={()=>onAction({type:'request.duplicate',requestId:row.id,expectedRevision:row.request!.revision,idempotencyKey:crypto.randomUUID()})}>Use as new request</button></>}{exp&&<button className="secondary" onClick={()=>onOpen(exp)}>{canceled?'View research details':'Open research details'}</button>}{row.canCancel&&<button className="cancel-request" disabled={busy||project?.archived} onClick={()=>row.request?onAction({type:'request.cancel',requestId:row.id,expectedRevision:row.request.revision,idempotencyKey:crypto.randomUUID()}):onCancel(row.id)}>Cancel request</button>}</div></article>;})}</div></section>;
}

export function AgentRoster({state,busy,onAgent,onAdd,onRemove}:{state:AppState;busy:boolean;onAgent:(id:string)=>void;onAdd:()=>void;onRemove:(id:string,removed:boolean)=>void}){
 const [lifecycle,setLifecycle]=useState('active'),[search,setSearch]=useState(''),[team,setTeam]=useState(''),[role,setRole]=useState(''),[provider,setProvider]=useState(''),[page,setPage]=useState(0);
 useEffect(()=>setPage(0),[lifecycle,search,team,role,provider]);
 const agents=state.agents.filter(a=>(lifecycle==='all'||(lifecycle==='archived')===!!a.removedAt)&&(!team||a.team===team)&&(!role||a.role===role)&&(!provider||a.provider===provider)&&[a.name,a.team,a.model].join(' ').toLowerCase().includes(search.toLowerCase()));
 const lastPage=Math.max(0,Math.ceil(agents.length/24)-1),currentPage=Math.min(page,lastPage);
 return <><div className="section-toolbar"><span>{agents.length} matching agents · no seat limit</span><button className="primary" onClick={onAdd}>Add agent</button></div>
 <div className="log-filters"><label className="field">Membership<select value={lifecycle} onChange={e=>setLifecycle(e.target.value)}><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></label><label className="field">Search agents<input value={search} onChange={e=>setSearch(e.target.value)}/></label><label className="field">Team<select value={team} onChange={e=>setTeam(e.target.value)}><option value="">All teams</option>{[...new Set(state.agents.map(a=>a.team))].map(t=><option key={t}>{t}</option>)}</select></label><label className="field">Role<select value={role} onChange={e=>setRole(e.target.value)}><option value="">All roles</option>{['DIRECTOR','PM_A','PM_B','PM_C','PM_D','WORKER'].map(r=><option key={r}>{r}</option>)}</select></label><label className="field">Provider<select value={provider} onChange={e=>setProvider(e.target.value)}><option value="">All providers</option><option value="openai">OpenAI</option><option value="claude">Claude</option></select></label></div>
 {!agents.length&&<p className="inline-note">No agents match these filters.</p>}<div className="project-grid">{agents.slice(currentPage*24,(currentPage+1)*24).map(a=><article className="project-card" key={a.id}><h2>{a.name}</h2><p>{a.team} · {a.role.replaceAll('_',' ')}</p><p>{a.provider} · {a.model} · {a.effort??'default'} effort</p><p>Account verified at setup: {a.account}</p><p>{a.removedAt?'Archived · history retained':'Hosted setup required'}</p><div className="button-row"><button className="secondary" onClick={()=>onAgent(a.id)}>Profile &amp; logs</button><button className="cancel-request" disabled={busy} onClick={()=>onRemove(a.id,!a.removedAt)}>{a.removedAt?'Restore agent':'Archive agent'}</button></div></article>)}</div><div className="button-row"><button disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><span>Page {currentPage+1} of {lastPage+1}</span><button disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}>Next</button></div></>;
}
const profileDrafts=new Map<string,{name:string;team:string;role:Role;instructions:string;revision:number}>();
/**
 * Bound account, current context, last verification and cloud readiness are separate facts.
 * Verify keeps the profile's own account; Change is an explicit move and says both identities.
 */
export function ConnectionBinding({agent,state,onState}:{agent:Agent;state:AppState;onState:(s:AppState)=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirming,setConfirming]=useState(false);
 const binding=agentBinding(state,agent);
 const readiness=providerReadiness(state,agent.provider,{model:agent.model});
 async function run(intent:'VERIFY'|'CHANGE'){setBusy(true);setError('');
  try{onState(await window.office.bindAgentConnection({agentId:agent.id,expectedRevision:agent.revision??0,intent}));setConfirming(false);}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="binding-card">
  <h3>Account connection</h3>
  <dl className="binding-facts">
   <div><dt>Bound account</dt><dd>{binding.boundIdentity||'Unverified'}</dd></div>
   <div><dt>Profile was created for</dt><dd>{binding.setupIdentity}</dd></div>
   <div><dt>Currently signed in</dt><dd>{binding.currentIdentity||'No recorded account check'}</dd></div>
   <div><dt>Last verified</dt><dd>{binding.lastVerifiedAt?new Date(binding.lastVerifiedAt).toLocaleString():'Never'}</dd></div>
   <div><dt>Cloud readiness</dt><dd>{readiness.cloudChecked?'Verified transport':'Hosted execution unverified'}</dd></div>
  </dl>
  {binding.blockers.map(blocker=><p className="muted" key={blocker}>{blocker}</p>)}
  {error&&<p className="notice error" role="alert">{error}</p>}
  {!agent.removedAt&&<div className="button-row">
   <button type="button" className="secondary" disabled={busy} onClick={()=>void run('VERIFY')}>{busy?'Checking…':'Verify connection'}</button>
   {confirming
    ?<><button type="button" className="secondary" disabled={busy} onClick={()=>void run('CHANGE')}>Move this profile to the signed-in account</button>
       <button type="button" className="text-button" disabled={busy} onClick={()=>setConfirming(false)}>Keep current binding</button></>
    :<button type="button" className="text-button" disabled={busy} onClick={()=>{setError('');setConfirming(true);}}>Change connection…</button>}
  </div>}
  {confirming&&<p className="muted">This moves {agent.name} from {binding.boundIdentity||binding.setupIdentity} to {binding.currentIdentity||'the signed-in account'}. Existing assignments keep the account they were created under.</p>}
 </section>;
}

export function ProfileEditor({agent,onState}:{agent:Agent;onState:(s:AppState)=>void}){
 const fromAgent=()=>({name:agent.name,team:agent.team,role:agent.role,instructions:agent.instructions,revision:agent.revision??0});
 const [draft,setDraft]=useState(()=>profileDrafts.get(agent.id)??fromAgent()),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const dirty=['name','team','role','instructions'].some(key=>draft[key as keyof typeof draft]!==agent[key as keyof Agent]);
 const conflict=draft.revision!==(agent.revision??0);
 useEffect(()=>{if(dirty)profileDrafts.set(agent.id,draft);else profileDrafts.delete(agent.id);},[draft,dirty,agent.id]);
 function edit(patch:Partial<typeof draft>){setDraft({...draft,...patch});setSaved(false);}
 return <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const {revision,...fields}=draft;const state=await window.office.command({type:'agent.update',idempotencyKey:crypto.randomUUID(),agentId:agent.id,expectedRevision:revision,...fields});onState(state);setDraft({...draft,revision:state.agents.find(a=>a.id===agent.id)?.revision??0});setSaved(true);profileDrafts.delete(agent.id);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
 <fieldset disabled={busy||!!agent.removedAt}><div className="profile-fields"><label className="field">Name<input value={draft.name} onChange={e=>edit({name:e.target.value})} required maxLength={160}/></label><label className="field">Team<input value={draft.team} onChange={e=>edit({team:e.target.value})} required maxLength={160}/></label><label className="field">Role<select value={draft.role} onChange={e=>edit({role:e.target.value as Role})}>{['DIRECTOR','PM_A','PM_B','PM_C','PM_D','WORKER'].map(r=><option key={r}>{r}</option>)}</select></label></div><label className="field">Instructions<textarea value={draft.instructions} onChange={e=>edit({instructions:e.target.value})} maxLength={12000}/></label><button className="secondary" disabled={!dirty||conflict}>Save profile</button></fieldset>
 <p role="status">{agent.removedAt?'Archived profile is read-only.':conflict?'Profile changed in another view. Reload before saving.':dirty?'Unsaved changes retained while this app is open.':saved?'Profile saved.':'Profile is up to date.'}</p>{(conflict||dirty)&&<button type="button" onClick={()=>{profileDrafts.delete(agent.id);setDraft(fromAgent());setError('');}}>Discard draft and reload</button>}{error&&<p role="alert">{error}</p>}</form>;
}

function RequestEditor({request,state,busy,onAction}:{request:Request;state:AppState;busy:boolean;onAction:(c:Command)=>void}){
 return <form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);onAction({type:'request.update',idempotencyKey:crypto.randomUUID(),requestId:request.id,expectedRevision:request.revision,objective:String(f.get('objective')),leadAgentId:String(f.get('leadAgentId'))||null,participantIds:f.getAll('participantIds').map(String),acceptanceCriteria:String(f.get('acceptanceCriteria'))});}}><fieldset disabled={busy}><label className="field">Objective<textarea name="objective" defaultValue={request.objective} required maxLength={12000}/></label><label className="field">Responsible agent<select name="leadAgentId" defaultValue={request.leadAgentId??''}><option value="">Choose an agent</option>{state.agents.filter(a=>!a.removedAt).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>{request.mode!=='SINGLE'&&<label className="field">Collaborators<select multiple name="participantIds" defaultValue={request.participantIds}>{state.agents.filter(a=>!a.removedAt).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}<label className="field">Acceptance criteria<textarea name="acceptanceCriteria" defaultValue={request.acceptanceCriteria} maxLength={12000}/></label><button>Save request revision</button></fieldset></form>;
}
