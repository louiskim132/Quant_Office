import React,{useCallback,useEffect,useState} from 'react';
import type {Agent,ResearchStatus,WorkMode} from '../shared/types';

/** Stage functions whose work is an independent review rather than production. */
const REVIEW_FUNCTIONS=new Set<string>(['CORRECTNESS_REVIEWER','ADVOCATE','SKEPTIC']);

/**
 * Where a research branch actually stands, stated as what is stopping it rather than as a status.
 *
 * The panel deliberately shows blockers before anything else and never offers a promote control. A
 * button that is disabled for a reason invites the reason to be argued with; the decision is made in
 * main from gate receipts, and this view reports it.
 */
export function BranchStanding({branchId,subjectHash,mode,label}:{branchId:string;subjectHash:string;mode:WorkMode;label:(value:string)=>string}){
 const [status,setStatus]=useState<ResearchStatus|null>(null);
 const [agents,setAgents]=useState<Agent[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const load=useCallback(async()=>{
  setBusy(true);setError('');
  try{
   const [next,app]=await Promise.all([window.office.researchStatus({branchId,subjectHash,mode}),window.office.getState()]);
   setStatus(next);setAgents(app.agents.filter(a=>!a.removedAt));
  }
  catch(e){setError((e as Error).message);setStatus(null);setAgents([]);}finally{setBusy(false);}
 },[branchId,subjectHash,mode]);
 useEffect(()=>{void load();},[load]);
 useEffect(()=>window.office.onChanged(()=>{void load();}),[load]);

 if(error)return <p className="notice error" role="alert">{error}</p>;
 if(!status)return <p className="muted">{busy?'Reading stage standing…':'No stage standing available.'}</p>;
 const blockers=[...status.promotionBlockers,...status.scheduleBlockers.filter(item=>!status.promotionBlockers.includes(item))];
 const profile=(id:string)=>agents.find(a=>a.id===id)?.name;
 const unassigned=status.functions.filter(item=>item.blockers.length);
 const reviewStage=status.functions.some(item=>REVIEW_FUNCTIONS.has(item.function));
 return <section className="standing">
  <div className="card-heading">
   <h3>{label(status.stage)} · {label(status.outcome.replaceAll('_',' '))}</h3>
   <span className="quiet-badge small">{status.canPromote?'All gates for this subject are earned':'Blocked'}</span>
  </div>

  <div className="standing-section">
   {blockers.length>0&&<>
    <p className="muted">This branch does not advance until each of these is resolved. Nothing here can be waived from this view.</p>
    <ul className="blockers">{blockers.map(reason=><li key={reason}>{reason}</li>)}</ul>
   </>}
   {!blockers.length&&<p className="muted">Every gate this stage requires has a passing receipt for this exact subject.</p>}
  </div>

  <div className="standing-section">
   <h4>Functions this stage needs</h4>
   <ul className="functions">{status.functions.map(item=>
    <li key={item.function}>
     <b>{label(item.function.replaceAll('_',' '))}</b>
     {item.blockers.length
      ?<span className="unassigned">{item.blockers.join(' ')}</span>
      :<span>{profile(item.agentId)??'Appointed profile'} · assigned at profile revision {item.agentRevision}</span>}
    </li>)}</ul>
  </div>

  {unassigned.length>0&&<div className="standing-section">
   <h4>What you can do now</h4>
   <p className="muted">Appoint a profile to each open function under 'Assign stage functions' below — an appointment binds the profile at its current revision.{agents.length?` Active profiles that can be appointed: ${agents.map(a=>a.name).join(', ')}.`:" No active profiles are registered — add one from 'Add agent' in the sidebar."}</p>
  </div>}

  {reviewStage&&<div className="standing-section">
   <h4>How this review concludes</h4>
   <p className="muted">Review is performed by the appointed profiles; first reports stay sealed until every expected report in the round is sealed, then the round opens them together. Advancement is recorded from gate receipts in main — there is no approve or decline button in this view.</p>
  </div>}

  {status.tasks.length>0&&<div className="standing-section">
   <h4>Next work this stage would create</h4>
   <ul className="functions">{status.tasks.map(task=>
    <li key={task.contextHash}>
     <b>{label(task.function.replaceAll('_',' '))}</b>
     <span>output {task.outputSchema}{task.dependsOn.length?` · after ${task.dependsOn.length} worker task${task.dependsOn.length===1?'':'s'}`:''}</span>
     <details><summary>Frozen context</summary><code className="hash">{task.contextHash}</code></details>
    </li>)}</ul>
  </div>}
 </section>;
}
