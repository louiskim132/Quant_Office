import React,{useEffect,useState} from 'react';
import type {Agent,AppState,InputSnapshot,ProviderJob,Request,JobEvent} from '../shared/types';
import type {LocalSessionSummary,LocalLaunchPlan} from '../shared/local-session';
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
 const [note,setNote]=useState('');
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
 // The job's latest applied self-report — the session's own claim on a verified receipt, never
 // inferred. It comes from the structured query: publicState strips jobEvents, so the snapshot
 // never carries them. Bound v2 receipts carry the structured payload the mismatch check reads.
 const [reports,setReports]=useState<JobEvent[]>([]);
 const [localSummary,setLocalSummary]=useState<LocalSessionSummary|null>(null);
 const [localPlan,setLocalPlan]=useState<LocalLaunchPlan|null>(null);
 const appliedReport=reports.at(-1);
 const reportedModel=appliedReport?.applied?.model;
 const reportedEffort=appliedReport?.applied?.effort;
 const appliedMismatch=Boolean(assignment&&appliedReport?.applied&&((reportedModel!==undefined&&reportedModel!==assignment.requestedModel)||(reportedEffort!==undefined&&reportedEffort!==assignment.requestedEffort)));
 useEffect(()=>{setPlan(null);setSessionId('');setSessionUrl('');setNote('');},[job?.id,request.id]);
 const snapshot:InputSnapshot|undefined=assignment?(state.snapshots??[]).find(item=>item.id===assignment.snapshotId):undefined;
 const [events,setEvents]=useState<JobEvent[]>([]);
 const [eventCursor,setEventCursor]=useState<string|null>(null);
 useEffect(()=>{
   let canceled=false;setEvents([]);setEventCursor(null);
   if(job)void window.office.jobEventPage({jobId:job.id,limit:50}).then(page=>{if(!canceled){setEvents(page.entries);setEventCursor(page.nextCursor);}}).catch(e=>{if(!canceled)setError((e as Error).message);});
   return()=>{canceled=true;};
 },[job?.id,job?.revision]);
 useEffect(()=>{
   let canceled=false;
   if(job){
     void window.office.appliedReports({jobId:job.id,limit:50}).then(page=>{if(!canceled)setReports(page.entries);}).catch(()=>{});
     void window.office.localSessionSummary(job.id).then(summary=>{if(!canceled)setLocalSummary(summary);}).catch(()=>{});
     void window.office.localLaunchPlan(job.id).then(plan=>{if(!canceled)setLocalPlan(plan);}).catch(()=>{});
   }
   return()=>{canceled=true;};
 },[job?.id,job?.revision,state]);
 useEffect(()=>{setReports([]);setLocalSummary(null);setLocalPlan(null);},[job?.id]);
 const agent:Agent|undefined=state.agents.find(item=>item.id===(assignment?.agentId??request.leadAgentId));
 // The same scope the main process gates on: the route this office would really use, the profile's
 // effort, and the collaboration policy this request authorized. Local profiles have no hosted
 // route, so their gate is scoped to the local transport family instead of a nonexistent handoff.
 const local=agent?.execution==='LOCAL';
 const exec=local&&agent?.localRoute==='LOCAL_CLI_EXEC';
 const gate=agent?agentDispatchReadiness(state,agent,{now,...(local?{}:{route:'OFFICIAL_TERMINAL_HANDOFF' as const}),delegation:request.delegation}):undefined;
 const settled=job?['COMPLETED','FAILED','CANCEL_ACKNOWLEDGED'].includes(job.state):false;
 const canceledRequest=request.status==='CANCELED';
 const projectArchived=state.projects.some(item=>item.id===request.projectId&&item.archived);
 // A canceled request or an archived project is never offered a fresh dispatch action — only the
 // controls that reconcile or end work already on record (Observe, job cancel, Link session).
 const closed=canceledRequest||projectArchived;
 async function run(label:string,action:()=>Promise<AppState|void>){
  setBusy(label);setError('');setNote('');
  try{const next=await action();if(next)onState(next);}catch(e){setError((e as Error).message);}finally{setBusy('');}
 }
 // Reconciliation actions must always say what they found: a spinner that resolves to nothing looks
 // like it worked. The returned state carries the job's post-action record even when nothing moved.
 async function reportJob(label:string,action:()=>Promise<AppState>){
  await run(label,async()=>{const next=await action();const updated=job?next.jobs?.find(item=>item.id===job.id):undefined;setNote(updated?`${jobLabels[updated.state]}${updated.detail?` — ${updated.detail}`:''}`:'The action returned without a record for this job.');
   // Pin the selection to the job this action just ran against: a settled job must stay
   // selected so its observation, applied reports and launch/retire controls remain visible
   // instead of the card reverting to the newest unresolved item.
   if(job)setSelectedJob(job.id);return next;});
 }
 return <section className="dispatch-card">
  <h3>{local?'Local session work':'Provider work'}</h3>
  {summaries.length>0&&<label className="field">Job history<select value={job?.id??''} onChange={e=>setSelectedJob(e.target.value)}>{summaries.map(item=><option key={item.jobId} value={item.jobId}>{state.agents.find(agent=>agent.id===item.agentId)?.name??'Agent'} · {jobLabels[item.state]} · {item.jobId.slice(0,8)}</option>)}</select></label>}
  {summaries.some(item=>item.unresolved)&&<p className="notice">{summaries.filter(item=>item.unresolved).length} job(s) still require observation or reconciliation, regardless of other completed jobs.</p>}
  {closed&&<p className="muted">{canceledRequest?'This request is canceled':'This project is archived'} — only job reconciliation remains: observe the recorded job, request its cancellation, or link a session you ran.</p>}
  {!agent&&!closed&&<p className="muted">Choose the agent for this request before preparing work.</p>}
  {gate&&!closed&&<ul className="readiness-list">
   <li data-state={gate.canPrepare?'yes':'no'}>Prepare: {gate.canPrepare?'Available':'Blocked'}</li>
   <li data-state={gate.canHandoff?'yes':'no'}>{local?(exec?'Office-spawned session launch':'Local session handoff'):'Official terminal handoff'}: {gate.canHandoff?'Available':'Blocked'}</li>
   <li data-state={gate.canStart?'yes':'no'}>Automatic start: {gate.canStart?'Available':'Blocked'}</li>
  </ul>}
  {local&&!closed&&<p className="muted">{exec?'Launch office-spawned session → observe. The office spawns the provider CLI on this machine and owns the process (cancel kills it). Launch records office-observed evidence for this exact scope; automatic start stays blocked until that local evidence exists. Not provider-hosted, isolated or independently attested.':'Write local session packet → run the session → observe. This profile runs sessions on this machine through the official CLI. Writing the session packet records office-observed evidence for this exact scope; automatic start stays blocked until that local evidence exists. The office never runs the session itself.'}</p>}
  {agent&&gate&&!closed&&gate.readiness.connectionId&&!gate.readiness.accountFresh&&<p><button className="secondary" disabled={!!busy} onClick={()=>void run('recheck',async()=>{await window.office.connectionStatus(agent.provider);return window.office.getState();})}>{busy==='recheck'?'Checking…':'Re-check account'}</button> <span className="muted">The account check is stale; a live re-check refreshes it in place.</span></p>}
  {job&&<p><strong>{jobLabels[job.state]}</strong>{job.externalId?` · ${job.externalId}${job.evidence==='USER_REPORTED'?' (reported by you, unverified)':''}`:''}</p>}
  {job&&<p className="muted">{job.detail}</p>}
  {localSummary&&<p className="muted">Local session {localSummary.lifecycle.toLowerCase().replaceAll('_',' ')} · {localSummary.layout==='FLAT_PACKET'?'packet folder':'project worktree'} · {localSummary.cwdDisplay}{localSummary.stopStatus!=='NOT_REQUESTED'?` · stop ${localSummary.stopStatus.toLowerCase().replaceAll('_',' ')}`:''}{localSummary.archive.packet!=='LIVE'?` · packet ${localSummary.archive.packet.toLowerCase()}`:''}{localSummary.archive.provider!=='NOT_REQUESTED'?` · provider ${localSummary.archive.provider.toLowerCase().replaceAll('_',' ')}`:''}</p>}
  {localSummary?.blockers.map(blocker=><p className="blocker" key={blocker}>{blocker}</p>)}
  {localPlan&&!closed&&<details><summary>How to run this packet ({localPlan.availability==='MANUAL_HANDOFF'?'manual handoff':'unavailable'})</summary>
   <p className="muted">{localPlan.detail}</p>
   <ul className="evidence-list">{localPlan.instructions.map((step,index)=><li key={index}>{step}</li>)}</ul>
   <p className="muted">Packet hash {localPlan.packetHash.slice(0,16)}… — receipts verify against this exact hash.</p>
  </details>}
  {appliedReport&&assignment&&<p className="muted">Requested {assignment.requestedModel} · effort {assignment.requestedEffort.toLowerCase()} — {appliedReport.text}</p>}
  {appliedMismatch&&<p className="blocker">The session's self-reported applied values differ from the requested model/effort — self-reported, not office-verified.</p>}
  {note&&<p className="notice" role="status">{note}</p>}
  {snapshot&&<p className="muted">Snapshot {snapshot.files.length} file{snapshot.files.length===1?'':'s'} · {snapshot.totalBytes} bytes{snapshot.stagingCommit?` · commit ${snapshot.stagingCommit.slice(0,10)}`:' · no commit'}</p>}
  {snapshot?.warnings.map(warning=><p className="muted" key={warning}>{warning}</p>)}
  {plan&&<pre className="command-preview">{plan.executable} {plan.args.join(' ')}{'\n'}in {plan.cwd}</pre>}
  {plan?.outputDestination&&<div className="command-preview"><p>Reserved results folder: {plan.outputDestination.path}</p><p>Exact staged inventory: {plan.outputDestination.totalBytes} bytes</p><ul>{plan.outputDestination.files.map(file=><li key={file.path}>{file.path} · {file.bytes} bytes · {file.sha256}</li>)}</ul></div>}
  {error&&<p className="notice error" role="alert">{error}</p>}
  <div className="button-row">
   {!closed&&(!assignment||settled)&&!summaries.some(item=>!item.settled)&&<button className="primary" disabled={!!busy||!agent||!gate?.canPrepare} onClick={()=>void run('prepare',async()=>{
    if(!agent)return;
    const result=await window.office.prepareRequest({requestId:request.id,expectedRequestRevision:request.revision,agentId:agent.id,expectedAgentRevision:agent.revision??0});
    setSelectedJob(result.state.jobs?.find(item=>item.assignmentId===result.assignmentId)?.id??'');return result.state;})}>{busy==='prepare'?'Preparing…':local?'Prepare local session':'Prepare Claude handoff'}</button>}
   {assignment&&!settled&&<>
    {!closed&&!local&&<button className="secondary" disabled={!!busy} onClick={()=>void run('plan',async()=>{setPlan(await window.office.handoffPlan({assignmentId:assignment.id}));})}>Show exact command</button>}
    {!closed&&<button className="primary" disabled={!!busy||job?.state!=='INTENT'||!gate?.canHandoff} onClick={()=>void run('handoff',()=>window.office.openHandoffTerminal({assignmentId:assignment.id}))}>{busy==='handoff'?(exec?'Launching…':'Opening…'):local?(exec?'Launch office-spawned session':'Write local session packet'):'Open official Claude terminal'}</button>}
    <button className="secondary" disabled={!!busy||job?.state==='INTENT'} onClick={()=>void reportJob('observe',()=>window.office.observeJob({assignmentId:assignment.id}))}>{busy==='observe'?'Observing…':'Observe'}</button>
    {!closed&&job?.state==='INTENT'&&<button className="secondary" disabled={!!busy} onClick={()=>void run('discard',()=>window.office.discardPreparation({assignmentId:assignment.id}))}>Discard preparation to prepare again</button>}
    <button className="cancel-request" disabled={!!busy} onClick={()=>void reportJob('cancel',()=>window.office.cancelJob({assignmentId:assignment.id}))}>{busy==='cancel'?'Requesting…':job?.state==='CANCEL_REQUESTED'?'Cancellation requested — re-check acknowledgment':'Request cancellation'}</button>
   </>}
   {local&&assignment&&settled&&localSummary?.lifecycle==='READY'&&<button className="secondary" disabled={!!busy} onClick={()=>void run('retire',async()=>{
    const result=await window.office.localSessionArchive(assignment.id);
    setNote(result.archive.detail);return result.state;})}>{busy==='retire'?'Retiring…':'Retire local session'}</button>}
   {!closed&&<button className="secondary" disabled title="Automatic start needs verified submission, settings, observation, output and cancellation for this account.">Start request automatically</button>}
  </div>
  {assignment&&!settled&&job?.state==='UNKNOWN'&&!(local&&job.externalId)&&<form className="link-session" onSubmit={e=>{e.preventDefault();void run('link',()=>window.office.linkJobSession({assignmentId:assignment.id,externalId:sessionId,externalUrl:sessionUrl}));}}>
   <p className="muted">If the terminal created a session, link it so this work can be reconciled. Linking records your report; it is not a provider receipt.</p>
   <label className="field">Session ID<input value={sessionId} onChange={e=>setSessionId(e.target.value)} maxLength={200} required/></label>
   <label className="field">Session URL<input value={sessionUrl} onChange={e=>setSessionUrl(e.target.value)} maxLength={2000} placeholder="https://claude.ai/code/…"/></label>
   <button className="secondary" disabled={!!busy||!sessionId}>Link session</button>
  </form>}
  {events.length>0&&<details><summary>{local?'Session events':'Provider events'} ({events.length})</summary><ul className="evidence-list">{events.map(event=><li key={event.id}><b>{event.kind.toLowerCase()}</b> {new Date(event.occurredAt).toLocaleString()} — {event.text}</li>)}</ul>
    {eventCursor&&job&&<button className="secondary" onClick={()=>void window.office.jobEventPage({jobId:job.id,limit:50,cursor:eventCursor}).then(page=>{setEvents(current=>[...current,...page.entries]);setEventCursor(page.nextCursor);}).catch(e=>setError((e as Error).message))}>{local?'More session events':'More provider events'}</button>}
  </details>}
  {gate&&!closed&&gate.blockers.length>0&&(()=>{
   // What a blocker gates is part of the gate itself: account problems stop the manual action in
   // front of the user, while unverified dispatch evidence gates only automatic start. Binding
   // problems block every external action, so they group with the action blockers.
   const details=gate.readiness.blockerDetails;
   if(!details)return<details><summary>Why actions are blocked</summary><ul className="evidence-list">{gate.blockers.map(blocker=><li key={blocker}>{blocker}</li>)}</ul></details>;
   const thisAction=[...gate.binding.blockers,...details.filter(item=>item.blocks==='THIS_ACTION').map(item=>item.message)];
   const automatic=details.filter(item=>item.blocks==='AUTOMATIC_START').map(item=>item.message);
   return<>
    {thisAction.length>0&&<details open><summary>Blocks this action</summary><ul className="evidence-list">{thisAction.map(blocker=><li key={blocker}>{blocker}</li>)}</ul></details>}
    {automatic.length>0&&<details><summary>Gates automatic start</summary><ul className="evidence-list">{automatic.map(blocker=><li key={blocker}>{blocker}</li>)}</ul></details>}
   </>;
  })()}
 </section>;
}
