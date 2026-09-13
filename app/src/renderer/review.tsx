import React,{useCallback,useEffect,useState} from 'react';
import type {ResearchStatus,WorkMode} from '../shared/types';

/**
 * Where a research branch actually stands, stated as what is stopping it rather than as a status.
 *
 * The panel deliberately shows blockers before anything else and never offers a promote control. A
 * button that is disabled for a reason invites the reason to be argued with; the decision is made in
 * main from gate receipts, and this view reports it.
 */
export function BranchStanding({branchId,subjectHash,mode,label}:{branchId:string;subjectHash:string;mode:WorkMode;label:(value:string)=>string}){
 const [status,setStatus]=useState<ResearchStatus|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const load=useCallback(async()=>{
  setBusy(true);setError('');
  try{setStatus(await window.office.researchStatus({branchId,subjectHash,mode}));}
  catch(e){setError((e as Error).message);setStatus(null);}finally{setBusy(false);}
 },[branchId,subjectHash,mode]);
 useEffect(()=>{void load();},[load]);
 useEffect(()=>window.office.onChanged(()=>{void load();}),[load]);

 if(error)return <p className="notice error" role="alert">{error}</p>;
 if(!status)return <p className="muted">{busy?'Reading stage standing…':'No stage standing available.'}</p>;
 const blockers=[...status.promotionBlockers,...status.scheduleBlockers.filter(item=>!status.promotionBlockers.includes(item))];
 return <section className="standing">
  <div className="card-heading">
   <h3>{label(status.stage)} · {label(status.outcome.replaceAll('_',' '))}</h3>
   <span className="quiet-badge small">{status.canPromote?'All gates for this subject are earned':'Blocked'}</span>
  </div>

  {blockers.length>0&&<>
   <p className="muted">This branch does not advance until each of these is resolved. Nothing here can be waived from this view.</p>
   <ul className="blockers">{blockers.map(reason=><li key={reason}>{reason}</li>)}</ul>
  </>}
  {!blockers.length&&<p className="muted">Every gate this stage requires has a passing receipt for this exact subject.</p>}

  <h4>Functions this stage needs</h4>
  <ul className="functions">{status.functions.map(item=>
   <li key={item.function}>
    <b>{label(item.function.replaceAll('_',' '))}</b>
    {item.blockers.length
     ?<span className="unassigned">{item.blockers.join(' ')}</span>
     :<span>assigned at profile revision {item.agentRevision}</span>}
   </li>)}</ul>

  {status.tasks.length>0&&<>
   <h4>Next work this stage would create</h4>
   <ul className="functions">{status.tasks.map(task=>
    <li key={task.contextHash}>
     <b>{label(task.function.replaceAll('_',' '))}</b>
     <span>output {task.outputSchema}{task.dependsOn.length?` · after ${task.dependsOn.length} worker task${task.dependsOn.length===1?'':'s'}`:''}</span>
     <details><summary>Frozen context</summary><code className="hash">{task.contextHash}</code></details>
    </li>)}</ul>
  </>}
 </section>;
}
