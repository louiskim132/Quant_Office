import React, {useState} from 'react';
import type {AppState,Command,Request} from '../shared/types';
import {latestJobFor} from '../core/jobs';
import './pipeline.css';
import './office.css';

export function PipelineCard({request,state,busy,onAction}:{request:Request;state:AppState;busy:boolean;onAction:(c:Command)=>void}){
 const pipeline=request.pipeline!;
 const briefJob=pipeline.briefAssignmentId?latestJobFor(state.jobs,pipeline.briefAssignmentId):undefined;
 const ready=request.status==='READY';
 const hops=(state.assignments??[]).filter(item=>item.requestId===request.id&&item.pipelineKey);
 const notes=request.pipelineNotes??[];
 const pending=pipeline.pendingDecision;
 const headJob=pending?latestJobFor(state.jobs,pending.headAssignmentId):undefined;
 const [decisionNote,setDecisionNote]=useState('');
 const decide=(decision:'APPROVE'|'REVISE'|'REJECT')=>{
  if(!pending)return;
  const note=decisionNote.trim();
  if(decision==='REVISE'&&!note)return;
  onAction({type:'request.pipeline.decide',idempotencyKey:crypto.randomUUID(),requestId:request.id,expectedRevision:request.revision,decision,...(note?{note}:{}),expectedSpecHash:pending.specHash,expectedReceiptHash:pending.headReceiptHash});
 };
 const hopsLine=`Launched${hops.length?` — ${hops.length} minted hop${hops.length===1?'':'s'}: ${hops.map(item=>item.pipelineKey).join(', ')}`:' — no minted hops on record yet'}`;
 return <div className="pipeline-card">
  {pipeline.phase==='BRIEFING'&&<>
   <p className="muted">Director brief{pipeline.briefAssignmentId?`: ${briefJob?briefJob.state.toLowerCase().replaceAll('_',' '):'hop recorded; no job on record yet'}`:' — not minted yet; start the request to brief the director'}</p>
   {!!notes.length&&<ul className="evidence-list">{notes.map(item=><li key={item.id}>{item.text} <span className="muted">— {new Date(item.createdAt).toLocaleString()}</span></li>)}</ul>}
   <form onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const text=String(new FormData(form).get('note')).trim();if(!text)return;onAction({type:'request.pipeline.note',idempotencyKey:crypto.randomUUID(),requestId:request.id,expectedRevision:request.revision,text});form.reset();}}>
    <label className="field">Brief note<input name="note" maxLength={4000} placeholder="Refine the director brief" disabled={busy||!ready}/></label>
    <button className="secondary" disabled={busy||!ready}>Add note</button>
   </form>
   {!ready&&<p className="muted">Notes are recorded once the request is started.</p>}
   <button className="primary" disabled={busy||!ready||briefJob?.state!=='COMPLETED'} title={briefJob?.state==='COMPLETED'?'':'Available once the director brief completes'} onClick={()=>onAction({type:'request.pipeline.confirm',idempotencyKey:crypto.randomUUID(),requestId:request.id,expectedRevision:request.revision})}>Launch pipeline</button>
  </>}
  {(pipeline.phase==='LAUNCHED'||pipeline.phase==='AWAITING_DECISION')&&<p className="muted">{hopsLine}</p>}
  {pipeline.phase==='AWAITING_DECISION'&&<>
   <p className="muted">The round is sealed — the decision binds to the verified report receipt.</p>
   {pending?<>
    <p className="muted">Terminal hop{headJob?`: job ${headJob.state.toLowerCase().replaceAll('_',' ')}`:' recorded; its job is not on record'}{headJob?.outputs.length?` — ${headJob.outputs.length} recorded output${headJob.outputs.length===1?'':'s'}`:''}</p>
    {!!headJob?.outputs.length&&<ul className="evidence-list">{headJob.outputs.map(output=>{const artifact=state.artifacts.find(item=>item.sha256===output.sha256);return <li key={output.path+output.sha256}>{output.path} · {output.bytes} bytes · sha256 {output.sha256.slice(0,16)}…{artifact?` · stored as ${artifact.name}`:output.stored?' · stored':''}</li>;})}</ul>}
    <label className="field">Decision note<textarea value={decisionNote} onChange={e=>setDecisionNote(e.target.value)} maxLength={4000} placeholder="Required to request a revision; optional otherwise" disabled={busy||!ready}/></label>
    <div className="button-row">
     <button className="primary" disabled={busy||!ready} onClick={()=>decide('APPROVE')}>Approve</button>
     <button className="secondary" disabled={busy||!ready||!decisionNote.trim()} onClick={()=>decide('REVISE')}>Request revision</button>
     <button className="cancel-request" disabled={busy||!ready} onClick={()=>decide('REJECT')}>Reject</button>
    </div>
   </>:<p className="muted">Awaiting the sealed decision record — no pending decision is on record yet.</p>}
  </>}
  {pipeline.phase==='DECIDED'&&(pipeline.decision
   ?<p className="muted">Decision recorded: {pipeline.decision.decision.toLowerCase()} · bound to report receipt {pipeline.decision.headReceiptHash.slice(0,16)}… · {new Date(pipeline.decision.decidedAt).toLocaleString()}{pipeline.decision.note?` — “${pipeline.decision.note}”`:''}</p>
   :<p className="muted">Decision phase reached; no decision record is attached.</p>)}
 </div>;
}
