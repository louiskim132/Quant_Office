import React,{useEffect,useState} from 'react';
import type {Agent,AppState,InputSnapshot,ProviderJob,Request,JobEvent} from '../shared/types';
import {agentDispatchReadiness} from '../shared/readiness';
import {requestJobs} from '../shared/queue';

const jobLabels:Record<ProviderJob['state'],string>={
 INTENT:'Prepared · nothing submitted',SUBMITTING:'Submitting',ACCEPTED:'Accepted by the provider',RUNNING:'Running',
 COMPLETED:'Completed with provider output',FAILED:'Failed',UNKNOWN:'Unknown · needs reconciliation',
 CANCEL_REQUESTED:'Cancellation requested · not acknowledged',CANCEL_ACKNOWLEDGED:'Cancellation acknowledged',
};

/**
 * The request actions, each shown with the evidence that allows or blocks it.
 * Preparation and the labeled handoff are separate from automatic start, which stays gated until
 * the office can verify submission, settings, observation, output and cancellation itself.
 */
export function RequestDispatch({request,state,onState}:{request:Request;state:AppState;onState:(s:AppState)=>void}){
 const [busy,setBusy]=useState('');
 const [error,setError]=useState('');
 const [plan,setPlan]=useState<Awaited<ReturnType<typeof window.office.handoffPlan>>>(null);
 const [selectedJob,setSelectedJob]=useState('');
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
 const [sessionId,setSessionId]=useState('');
 const [sessionUrl,setSessionUrl]=useState('');
 const summaries=requestJobs(state,request.id);
 const chosen=summaries.find(item=>item.jobId===selectedJob)??summaries.find(item=>item.unresolved)??summaries.find(item=>!item.settled)??summaries.at(-1);
 const job=(state.jobs??[]).find(item=>item.id===chosen?.jobId);
 const assignment=(state.assignments??[]).find(item=>item.id===job?.assignmentId);
 useEffect(()=>{setPlan(null);setSessionId('');setSessionUrl('');},[job?.id,request.id]);
 const snapshot:InputSnapshot|undefined=assignment?(state.snapshots??[]).find(item=>item.id===assignment.snapshotId):undefined;
 const [events,setEvents]=useState<JobEvent[]>([]);
 const [eventCursor,setEventCursor]=useState<string|null>(null);
 useEffect(()=>{
   let canceled=false;setEvents([]);setEventCursor(null);
   if(job)void window.office.jobEventPage({jobId:job.id,limit:50}).then(page=>{if(!canceled){setEvents(page.entries);setEventCursor(page.nextCursor);}}).catch(e=>{if(!canceled)setError((e as Error).message);});
   return()=>{canceled=true;};
 },[job?.id,job?.revision]);
 const agent:Agent|undefined=state.agents.find(item=>item.id===(assignment?.agentId??request.leadAgentId));
 // The same scope the main process gates on: the route this office would really use, the profile's
 // effort, and the collaboration policy this request authorized. Local profiles have no hosted
 // route, so their gate is scoped to the local transport family instead of a nonexistent handoff.
 const local=agent?.execution==='LOCAL';
 const gate=agent?agentDispatchReadiness(state,agent,{now,...(local?{}:{route:'OFFICIAL_TERMINAL_HANDOFF' as const}),delegation:request.delegation}):undefined;
 const settled=job?['COMPLETED','FAILED','CANCEL_ACKNOWLEDGED'].includes(job.state):false;
 async function run(label:string,action:()=>Promise<AppState|void>){
  setBusy(label);setError('');
  try{const next=await action();if(next)onState(next);}catch(e){setError((e as Error).message);}finally{setBusy('');}
 }
 return <section className="dispatch-card">
  <h3>Provider work</h3>
  {summaries.length>0&&<label className="field">Job history<select value={job?.id??''} onChange={e=>setSelectedJob(e.target.value)}>{summaries.map(item=><option key={item.jobId} value={item.jobId}>{state.agents.find(agent=>agent.id===item.agentId)?.name??'Agent'} · {jobLabels[item.state]} · {item.jobId.slice(0,8)}</option>)}</select></label>}
  {summaries.some(item=>item.unresolved)&&<p className="notice">{summaries.filter(item=>item.unresolved).length} job(s) still require observation or reconciliation, regardless of other completed jobs.</p>}
  {!agent&&<p className="muted">Choose the agent for this request before preparing work.</p>}
  {gate&&<ul className="readiness-list">
   <li data-state={gate.canPrepare?'yes':'no'}>Prepare: {gate.canPrepare?'Available':'Blocked'}</li>
   <li data-state={gate.canHandoff?'yes':'no'}>{local?'Local session handoff':'Official terminal handoff'}: {gate.canHandoff?'Available':'Blocked'}</li>
   <li data-state={gate.canStart?'yes':'no'}>Automatic start: {gate.canStart?'Available':'Blocked'}</li>
  </ul>}
  {local&&<p className="muted">This profile runs sessions on this machine through the official CLI. No local-session transport is configured in this build, so dispatch controls stay disabled; the readiness above reflects local-transport evidence, never hosted.</p>}
  {job&&<p><strong>{jobLabels[job.state]}</strong>{job.externalId?` · ${job.externalId}${job.evidence==='USER_REPORTED'?' (reported by you, unverified)':''}`:''}</p>}
  {job&&<p className="muted">{job.detail}</p>}
  {snapshot&&<p className="muted">Snapshot {snapshot.files.length} file{snapshot.files.length===1?'':'s'} · {snapshot.totalBytes} bytes{snapshot.stagingCommit?` · commit ${snapshot.stagingCommit.slice(0,10)}`:' · no commit'}</p>}
  {snapshot?.warnings.map(warning=><p className="muted" key={warning}>{warning}</p>)}
  {plan&&<pre className="command-preview">{plan.executable} {plan.args.join(' ')}{'\n'}in {plan.cwd}</pre>}
  {plan?.outputDestination&&<div className="command-preview"><p>Reserved results folder: {plan.outputDestination.path}</p><p>Exact staged inventory: {plan.outputDestination.totalBytes} bytes</p><ul>{plan.outputDestination.files.map(file=><li key={file.path}>{file.path} · {file.bytes} bytes · {file.sha256}</li>)}</ul></div>}
  {error&&<p className="notice error" role="alert">{error}</p>}
  <div className="button-row">
   {(!assignment||settled)&&!summaries.some(item=>!item.settled)&&<button className="primary" disabled={!!busy||!agent||local||!gate?.canPrepare||request.status==='CANCELED'||state.projects.some(p=>p.id===request.projectId&&p.archived)} onClick={()=>void run('prepare',async()=>{
    if(!agent)return;
    const result=await window.office.prepareRequest({requestId:request.id,expectedRequestRevision:request.revision,agentId:agent.id,expectedAgentRevision:agent.revision??0});
    setSelectedJob(result.state.jobs?.find(item=>item.assignmentId===result.assignmentId)?.id??'');return result.state;})}>{busy==='prepare'?'Preparing…':local?'Prepare local session':'Prepare Claude handoff'}</button>}
   {assignment&&!settled&&<>
    <button className="secondary" disabled={!!busy} onClick={()=>void run('plan',async()=>{setPlan(await window.office.handoffPlan({assignmentId:assignment.id}));})}>Show exact command</button>
    <button className="primary" disabled={!!busy||job?.state!=='INTENT'||!gate?.canHandoff||request.status==='CANCELED'} onClick={()=>void run('handoff',()=>window.office.openHandoffTerminal({assignmentId:assignment.id}))}>{busy==='handoff'?'Opening…':'Open official Claude terminal'}</button>
    <button className="secondary" disabled={!!busy||job?.state==='INTENT'} onClick={()=>void run('observe',()=>window.office.observeJob({assignmentId:assignment.id}))}>Observe</button>
    {job?.state==='INTENT'&&<button className="secondary" disabled={!!busy} onClick={()=>void run('discard',()=>window.office.discardPreparation({assignmentId:assignment.id}))}>Discard preparation to prepare again</button>}
    <button className="cancel-request" disabled={!!busy} onClick={()=>void run('cancel',()=>window.office.cancelJob({assignmentId:assignment.id}))}>Request cancellation</button>
   </>}
   <button className="secondary" disabled title="Automatic start needs verified submission, settings, observation, output and cancellation for this account.">Start request automatically</button>
  </div>
  {assignment&&!settled&&job?.state==='UNKNOWN'&&<form className="link-session" onSubmit={e=>{e.preventDefault();void run('link',()=>window.office.linkJobSession({assignmentId:assignment.id,externalId:sessionId,externalUrl:sessionUrl}));}}>
   <p className="muted">If the terminal created a session, link it so this work can be reconciled. Linking records your report; it is not a provider receipt.</p>
   <label className="field">Session ID<input value={sessionId} onChange={e=>setSessionId(e.target.value)} maxLength={200} required/></label>
   <label className="field">Session URL<input value={sessionUrl} onChange={e=>setSessionUrl(e.target.value)} maxLength={2000} placeholder="https://claude.ai/code/…"/></label>
   <button className="secondary" disabled={!!busy||!sessionId}>Link session</button>
  </form>}
  {events.length>0&&<details><summary>Provider events ({events.length})</summary><ul className="evidence-list">{events.map(event=><li key={event.id}><b>{event.kind.toLowerCase()}</b> {new Date(event.occurredAt).toLocaleString()} — {event.text}</li>)}</ul>
    {eventCursor&&job&&<button className="secondary" onClick={()=>void window.office.jobEventPage({jobId:job.id,limit:50,cursor:eventCursor}).then(page=>{setEvents(current=>[...current,...page.entries]);setEventCursor(page.nextCursor);}).catch(e=>setError((e as Error).message))}>More provider events</button>}
  </details>}
  {gate&&gate.blockers.length>0&&<details><summary>Why automatic start is blocked</summary><ul className="evidence-list">{gate.blockers.map(blocker=><li key={blocker}>{blocker}</li>)}</ul></details>}
 </section>;
}
