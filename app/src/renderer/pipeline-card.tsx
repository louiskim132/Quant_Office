import React, {useEffect, useState} from 'react';
import type {AppState,Command,PipelineShape,ProviderJob,Request} from '../shared/types';
import {latestJobFor} from '../core/jobs';
import './pipeline.css';
import './office.css';

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCEL_ACKNOWLEDGED'];
const RUNNING = ['SUBMITTING', 'ACCEPTED', 'RUNNING', 'UNKNOWN', 'CANCEL_REQUESTED'];

const elapsed = (job?: ProviderJob) => {
 if (!job) return '—';
 const start = Date.parse(job.dispatchedAt || job.createdAt), end = Date.parse(job.settledAt || job.updatedAt);
 if (!isFinite(start) || !isFinite(end) || end < start) return '—';
 const s = Math.round((end - start) / 1000);
 return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

/**
 * Mirrors the store's request.pipeline.retryHop gate: the round retries while it is BRIEFING or
 * LAUNCHED — the store refuses only DECIDED and AWAITING_DECISION — and only when the latest job
 * is FAILED, or UNKNOWN while its binding carries no verified receipt. A dead brief in BRIEFING
 * retries like any other hop.
 */
export const pipelineHopRetryable=(phase:string,job:ProviderJob|undefined,binding:{lastReceipt:unknown}|undefined):boolean=>
 phase!=='DECIDED'&&phase!=='AWAITING_DECISION'&&!!job&&(job.state==='FAILED'||(job.state==='UNKNOWN'&&!binding?.lastReceipt));

/**
 * Observe is a server-side no-op until something dispatched — INTENT and SUBMITTING jobs, and a
 * hop with no job record, get a disabled control carrying the reason, never a silent dead click.
 * (Rendered visibly too: a title alone never surfaces on a disabled control in Chromium.)
 */
export const observeDisabledReason=(job:ProviderJob|undefined):string|undefined=>
 !job||job.state==='INTENT'||job.state==='SUBMITTING'?'Nothing dispatched yet — nothing to observe.':undefined;

/**
 * The preview's verification wording is response-derived: 'verified' appears only when the
 * handler reported the hash check — an absent flag says nothing, so the label stays plain.
 */
export const previewCaption=(preview:{verified?:boolean}|undefined):string=>
 preview?.verified?'office-verified bytes':'output bytes';

/** The output a decision binds to — a named report file wins, else the first stored text file. */
function pickPreview(job: ProviderJob | undefined, preferred: string[]) {
 if (!job) return undefined;
 const stored = job.outputs.filter(output => output.stored);
 const named = preferred.map(name => stored.find(output => output.path === name || output.path.endsWith(`/${name}`))).find(Boolean);
 const output = named ?? stored.find(output => output.path.toLowerCase().endsWith('.md'))
  ?? stored.find(output => /\.(txt|json|log|csv|tsv|tex)$/i.test(output.path)) ?? stored[0];
 return output && {jobId: job.id, path: output.path, sha256: output.sha256, bytes: output.bytes};
}

export function PipelineCard({request,state,busy,onAction}:{request:Request;state:AppState;busy:boolean;onAction:(c:Command)=>void}){
 const pipeline=request.pipeline!;
 const briefJob=pipeline.briefAssignmentId?latestJobFor(state.jobs,pipeline.briefAssignmentId):undefined;
 const ready=request.status==='READY';
 const hops=(state.assignments??[]).filter(item=>item.requestId===request.id&&item.pipelineKey);
 const notes=request.pipelineNotes??[];
 const pending=pipeline.pendingDecision;
 const headJob=pending?latestJobFor(state.jobs,pending.headAssignmentId):undefined;
 const [decisionNote,setDecisionNote]=useState('');
 const [hopBusy,setHopBusy]=useState('');
 const [hopError,setHopError]=useState('');
 const [confirmCancel,setConfirmCancel]=useState(false);
 /** The round shape the user confirms: the full debate, or one planner and one worker. */
 const [shape,setShape]=useState<PipelineShape>('FULL');
 /** Where a requested revision restarts: a new planning round, or implementation on the approved plan. */
 const [restartAt,setRestartAt]=useState<'PLANNING'|'IMPLEMENTATION'>('PLANNING');
 const [preview,setPreview]=useState<{path:string;sha256:string;bytes:number;text:string;truncated:boolean;verified?:boolean}|null>(null);
 const [previewError,setPreviewError]=useState('');
 const archived=!!state.projects.find(item=>item.id===request.projectId)?.archived;
 const revision=(state.requests??[]).find(item=>item.revisionOf?.requestId===request.id);
 const source=request.revisionOf?(state.requests??[]).find(item=>item.id===request.revisionOf!.requestId):undefined;
 const decide=(decision:'APPROVE'|'REVISE'|'REJECT')=>{
  if(!pending)return;
  const note=decisionNote.trim();
  if(decision==='REVISE'&&!note)return;
  onAction({type:'request.pipeline.decide',idempotencyKey:crypto.randomUUID(),requestId:request.id,expectedRevision:request.revision,decision,...(note?{note}:{}),...(decision==='REVISE'&&restartAt==='IMPLEMENTATION'?{restartAt}:{}),expectedSpecHash:pending.specHash,expectedReceiptHash:pending.headReceiptHash});
 };
 const hopAction=async(label:string,action:()=>Promise<unknown>)=>{
  setHopBusy(label);setHopError('');
  try{await action();}catch(e){setHopError((e as Error).message);}finally{setHopBusy('');}
 };
 const retryable=(job:ProviderJob|undefined)=>pipelineHopRetryable(pipeline.phase,job,(state.localSessions??[]).find(item=>item.jobId===job?.id));
 const previewTarget=pipeline.phase==='BRIEFING'&&briefJob?.state==='COMPLETED'?pickPreview(briefJob,['brief.md','report.md'])
  :pipeline.phase==='AWAITING_DECISION'?pickPreview(headJob,['verification.md','report.md']):undefined;
 useEffect(()=>{
  setPreview(null);setPreviewError('');
  if(!previewTarget)return;
  let live=true;
  void window.office.jobOutputPreview({jobId:previewTarget.jobId,path:previewTarget.path})
   .then(result=>{if(live)setPreview(result);})
   .catch(e=>{if(live)setPreviewError((e as Error).message);});
  return ()=>{live=false;};
 },[previewTarget?.jobId,previewTarget?.path]);
 const runningHops=hops.filter(hop=>{const job=latestJobFor(state.jobs,hop.id);return job?RUNNING.includes(job.state):false;}).length;
 const queuedHops=hops.filter(hop=>{const job=latestJobFor(state.jobs,hop.id);return !job||job.state==='INTENT';}).length;
 const jumpTo=(id:string)=>document.getElementById(`pipeline-card-${id}`)?.scrollIntoView({behavior:'smooth',block:'center'});
 const previewBlock=()=>!preview&&!previewError&&!previewTarget?null:<div className="pipeline-preview-block">
  {preview?<><pre className="pipeline-preview">{preview.text||'(Empty output)'}</pre><p className="muted">{previewCaption(preview)} — sha256 {preview.sha256.slice(0,12)}…{preview.truncated?' · preview truncated to 64KB':''}</p></>
   :previewError?<p className="muted">Preview unavailable: {previewError}</p>
   :<p className="muted">Loading preview…</p>}
 </div>;
 return <div className="pipeline-card" id={`pipeline-card-${request.id}`} data-open={request.status!=='CANCELED'||undefined} data-started={request.status!=='DRAFT'||undefined}>
  {request.revisionOf&&<p className="muted">{request.revisionOf.restartAt==='IMPLEMENTATION'?'Implementation-only revision':'Revision'} {request.revisionOf.round} of {source?<button type="button" className="text-button" onClick={()=>jumpTo(source.id)}>{source.name}</button>:'the earlier round'}</p>}
  {request.analysisOf&&(()=>{const plan=(state.requests??[]).find(item=>item.id===request.analysisOf!.requestId);return <p className="muted">Follows the analysis plan pre-registered by {plan?<button type="button" className="text-button" onClick={()=>jumpTo(plan.id)}>{plan.name}</button>:'an earlier planning request'}</p>;})()}
  {pipeline.phase==='BRIEFING'&&<>
   <p className="muted">Director brief{pipeline.briefAssignmentId?`: ${briefJob?briefJob.state.toLowerCase().replaceAll('_',' '):'hop recorded; no job on record yet'}`:' — not minted yet; start the request to brief the director'}</p>
   {!!notes.length&&<ul className="evidence-list">{notes.map(item=><li key={item.id}>{item.text} <span className="muted">— {new Date(item.createdAt).toLocaleString()}</span></li>)}</ul>}
   {previewBlock()}
   <form onSubmit={e=>{e.preventDefault();const form=e.currentTarget;const text=String(new FormData(form).get('note')).trim();if(!text)return;onAction({type:'request.pipeline.note',idempotencyKey:crypto.randomUUID(),requestId:request.id,expectedRevision:request.revision,text});form.reset();}}>
    <label className="field">Brief note<input name="note" maxLength={4000} placeholder="Refine the director brief" disabled={busy||!ready}/></label>
    <button className="secondary" disabled={busy||!ready}>Add note</button>
   </form>
   {!ready&&<p className="muted">Notes are recorded once the request is started.</p>}
   {request.revisionOf?.restartAt==='IMPLEMENTATION'?<p className="muted">This revision keeps the approved plan: the director amends it, one worker re-applies it, and the director verifies.</p>:<label className="field">Round<select value={shape} disabled={busy||!ready} onChange={e=>setShape(e.target.value as PipelineShape)}>
    <option value="FULL">{pipeline.kind==='PLANNING'?'Full — two planners, critique, synthesis':'Full — with cross-responses'}</option>
    <option value="QUICK">{pipeline.kind==='PLANNING'?'Quick — one planner, one worker':'Quick — no cross-responses'}</option>
   </select></label>}
   <button className="primary" disabled={busy||!ready||briefJob?.state!=='COMPLETED'} title={briefJob?.state==='COMPLETED'?'':'Available once the director brief completes'} onClick={()=>onAction({type:'request.pipeline.confirm',idempotencyKey:crypto.randomUUID(),requestId:request.id,expectedRevision:request.revision,shape})}>{briefJob?.state==='COMPLETED'?'Confirm brief & launch':'Launch pipeline'}</button>
  </>}
  {(pipeline.phase==='LAUNCHED'||pipeline.phase==='AWAITING_DECISION')&&<p className="muted">{`Launched${pipeline.shape==='QUICK'?' as a quick round':''}${hops.length?` — ${hops.length} minted hop${hops.length===1?'':'s'}`:' — no minted hops on record yet'}`}</p>}
  {!!hops.length&&<table className="pipeline-hops">
   <thead><tr><th>Hop</th><th>Agent</th><th>Latest job</th><th>Elapsed</th><th>Last reason</th><th aria-label="Actions"/></tr></thead>
   <tbody>{hops.map(hop=>{
    const job=latestJobFor(state.jobs,hop.id);
    const agent=state.agents.find(item=>item.id===hop.agentId);
    return <tr key={hop.id}><td>{hop.pipelineKey}</td>
     <td>{agent?.name??'Unassigned'} · {hop.requestedModel} · {hop.appliedEffort==='UNVERIFIED'?'effort unverified':(hop.appliedEffort??hop.requestedEffort).toLowerCase()}</td>
     <td>{job?`${job.state.toLowerCase().replaceAll('_',' ')} · attempt ${job.attempt??1}`:'no job on record'}</td>
     <td>{elapsed(job)}</td>
     <td className="pipeline-reason">{job?(job.lastObservation??(job.detail||'—')):'—'}</td>
     <td className="pipeline-hop-actions">
      <button type="button" className="secondary" disabled={busy||!!hopBusy||!!observeDisabledReason(job)} title={observeDisabledReason(job)} onClick={()=>void hopAction('observe',()=>window.office.observeJob({assignmentId:hop.id}))}>Observe</button>
      {observeDisabledReason(job)&&<div className="muted pipeline-hop-note">{observeDisabledReason(job)}</div>}
      {retryable(job)&&<button type="button" className="secondary" disabled={busy||!!hopBusy} onClick={()=>void hopAction('retry',()=>window.office.retryPipelineHop({requestId:request.id,pipelineKey:hop.pipelineKey!,expectedRevision:request.revision}))}>{hopBusy==='retry'?'Retrying…':'Retry'}</button>}
      {job&&!TERMINAL.includes(job.state)&&<button type="button" className="cancel-request" disabled={busy||!!hopBusy} onClick={()=>void hopAction('cancel',()=>window.office.cancelJob({assignmentId:hop.id}))}>{job.state==='CANCEL_REQUESTED'?'Re-check cancellation':'Cancel hop'}</button>}
     </td></tr>;
   })}</tbody>
  </table>}
  {pipeline.phase==='AWAITING_DECISION'&&<>
   <p className="muted">The round is sealed — the decision binds to the verified report receipt.</p>
   {pending?<>
    <p className="muted">Terminal hop{headJob?`: job ${headJob.state.toLowerCase().replaceAll('_',' ')}`:' recorded; its job is not on record'}{headJob?.outputs.length?` — ${headJob.outputs.length} recorded output${headJob.outputs.length===1?'':'s'}`:''}</p>
    {!!headJob?.outputs.length&&<ul className="evidence-list">{headJob.outputs.map(output=>{const artifact=state.artifacts.find(item=>item.sha256===output.sha256);return <li key={output.path+output.sha256}>{output.path} · {output.bytes} bytes · sha256 {output.sha256.slice(0,16)}…{artifact?` · stored as ${artifact.name}`:output.stored?' · stored':''}</li>;})}</ul>}
    {previewBlock()}
    <label className="field">Decision note<textarea value={decisionNote} onChange={e=>setDecisionNote(e.target.value)} maxLength={4000} placeholder="Required to request a revision; optional otherwise" disabled={busy||!ready}/></label>
    {pipeline.kind==='PLANNING'&&<label className="field">A revision restarts at<select value={restartAt} disabled={busy||!ready} onChange={e=>setRestartAt(e.target.value as 'PLANNING'|'IMPLEMENTATION')}>
     <option value="PLANNING">Planning — a new round</option>
     <option value="IMPLEMENTATION">Implementation — keep the approved plan</option>
    </select></label>}
    <div className="button-row">
     <button className="primary" disabled={busy||!ready} onClick={()=>decide('APPROVE')}>Approve</button>
     <button className="secondary" disabled={busy||!ready||!decisionNote.trim()} onClick={()=>decide('REVISE')}>Request revision</button>
     <button className="cancel-request" disabled={busy||!ready} onClick={()=>decide('REJECT')}>Reject</button>
    </div>
   </>:<p className="muted">Awaiting the sealed decision record — no pending decision is on record yet.</p>}
  </>}
  {pipeline.phase==='DECIDED'&&(pipeline.decision
   ?<>
    <p className="muted">Decision recorded: {pipeline.decision.decision.toLowerCase()} · bound to report receipt {pipeline.decision.headReceiptHash.slice(0,16)}… · {new Date(pipeline.decision.decidedAt).toLocaleString()}{pipeline.decision.note?` — “${pipeline.decision.note}”`:''}</p>
    {pipeline.decision.decision==='REVISE'&&(revision
     ?<p className="muted">Revised — see <button type="button" className="text-button" onClick={()=>jumpTo(revision.id)}>revision {revision.revisionOf?.round}</button>{revision.name?` (${revision.name})`:''}</p>
     :<p className="muted">Revised — the linked revision request is not in the current workspace state.</p>)}
    {pipeline.decision.decision==='REJECT'&&<p className="muted">Rejected — no further work will run.</p>}
   </>
   :<p className="muted">Decision phase reached; no decision record is attached.</p>)}
  {hopError&&<p className="notice error" role="alert">{hopError}</p>}
  {request.status!=='CANCELED'&&!archived&&<div className="pipeline-card-actions">
   <button type="button" className="cancel-request" disabled={busy||!!hopBusy} onClick={()=>setConfirmCancel(true)}>Cancel request</button>
  </div>}
  {confirmCancel&&<div className="pipeline-confirm" role="alertdialog" aria-label="Cancel this request">
   <div className="pipeline-confirm-panel">
    <h3>Cancel this request?</h3>
    <p>{runningHops} hop{runningHops===1?' is':'s are'} running and will be asked to stop; {queuedHops} queued hop{queuedHops===1?'':'s'} will be discarded; the record is kept.</p>
    <div className="button-row">
     <button type="button" className="cancel-request" disabled={busy} onClick={()=>{setConfirmCancel(false);onAction({type:'request.cancel',idempotencyKey:crypto.randomUUID(),requestId:request.id,expectedRevision:request.revision});}}>Cancel request</button>
     <button type="button" className="secondary" disabled={busy} onClick={()=>setConfirmCancel(false)}>Keep working</button>
    </div>
   </div>
  </div>}
 </div>;
}
