import React,{useEffect,useState} from 'react';
import type {Agent,AppState,JobEvent,WorkLog,Message} from '../shared/types';
import {agentDispatchReadiness} from '../shared/readiness';

const tabs=['Profile','Assignments','Conversation','Logs'] as const;
type Tab=typeof tabs[number];

/**
 * One profile, four views: who they are, what work they hold, what was said to them, and the
 * imported record. Assignments and conversation come from real records, never from a status guess.
 */
export function ProfileTabs({agent,state,children,onState:_onState}:{agent:Agent;state:AppState;children:React.ReactNode;onState:(state:AppState)=>void}){
 const [tab,setTab]=useState<Tab>('Profile');
 const [logs,setLogs]=useState<WorkLog[]>([]);
 const [cursor,setCursor]=useState<string|null>(null);
 const [events,setEvents]=useState<JobEvent[]>([]);
 const [eventCursor,setEventCursor]=useState<string|null>(null);
 const [error,setError]=useState('');
 const assignments=(state.assignments??[]).filter(item=>item.agentId===agent.id);
 const jobs=(state.jobs??[]).filter(job=>assignments.some(item=>item.id===job.assignmentId));
 const [messages,setMessages]=useState<Message[]>([]);
 const [messageCursor,setMessageCursor]=useState<string|null>(null);
 const [selectedJobId,setSelectedJobId]=useState('');
 const selectedJob=jobs.find(j=>j.id===selectedJobId)??jobs.at(-1);
 useEffect(()=>{
   if(tab!=='Conversation')return;let canceled=false;
   void window.office.messagePage({agentId:agent.id,limit:50}).then(page=>{if(!canceled){setMessages(page.entries);setMessageCursor(page.nextCursor);}}).catch(e=>{if(!canceled)setError((e as Error).message);});
   return()=>{canceled=true;};
 },[tab,agent.id,state]);
 const gate=agentDispatchReadiness(state,agent,{route:'OFFICIAL_TERMINAL_HANDOFF'});
 useEffect(()=>{
  if(tab!=='Logs')return;
  let cancelled=false;
  void window.office.logPage({agentId:agent.id,limit:50}).then(page=>{if(!cancelled){setLogs(page.entries);setCursor(page.nextCursor);}})
   .catch(e=>setError((e as Error).message));
  return()=>{cancelled=true;};
 },[tab,agent.id]);
 useEffect(()=>{
  if(tab!=='Assignments'||!jobs.length)return;
  let cancelled=false;
  void window.office.jobEventPage({jobId:selectedJob!.id,limit:50}).then(page=>{if(!cancelled){setEvents(page.entries);setEventCursor(page.nextCursor);}})
   .catch(e=>setError((e as Error).message));
  return()=>{cancelled=true;};
 },[tab,selectedJob?.id,selectedJob?.revision]);
 return <div className="profile-tabs">
  <div className="tab-row" role="tablist">{tabs.map(name=>
   <button key={name} role="tab" aria-selected={tab===name} className={`tab ${tab===name?'active':''}`} onClick={()=>setTab(name)}>{name}</button>)}</div>
  {error&&<p className="notice error" role="alert">{error}</p>}
  {tab==='Profile'&&<div className="tab-panel">{children}</div>}
  {tab==='Assignments'&&<div className="tab-panel">
   {jobs.length>0&&<label>Assignment event scope<select aria-label="Assignment event scope" value={selectedJob?.id??''} onChange={e=>setSelectedJobId(e.target.value)}>{jobs.map(job=><option key={job.id} value={job.id}>{job.assignmentId.slice(0,8)} · {job.state}</option>)}</select></label>}
   <p className="muted">{assignments.length} assignment{assignments.length===1?'':'s'} · dispatch {gate.canStart?'available':'blocked'}</p>
   {!assignments.length&&<p>No work has been frozen for this profile yet.</p>}
   {assignments.map(assignment=>{
    const job=jobs.find(item=>item.assignmentId===assignment.id);
    const request=(state.requests??[]).find(item=>item.id===assignment.requestId);
    return <article className="assignment-row" key={assignment.id}>
     <strong>{request?.name??'Request'}</strong>
     <p className="muted">{assignment.requestedModel} · requested effort {assignment.requestedEffort} · applied {assignment.appliedEffort.toLowerCase()}</p>
     <p>{job?`${job.state.replaceAll('_',' ').toLowerCase()}${job.externalId?` · ${job.externalId}`:''}`:'No job record'}</p>
     {job?.detail&&<p className="muted">{job.detail}</p>}
    </article>;})}
   {events.length>0&&<details><summary>Latest provider events ({events.length})</summary>
    <ul className="evidence-list">{events.map(event=><li key={event.id}>{new Date(event.occurredAt).toLocaleString()} — {event.text}</li>)}</ul></details>}
  </div>}
  {tab==='Conversation'&&<div className="tab-panel">
   {!messages.length&&<p>No scoped messages involve this profile.</p>}
   {messages.map(message=><article className="assignment-row" key={message.id}>
    <strong>{message.kind.replaceAll('_',' ').toLowerCase()}</strong>
    <p>{message.body}</p>
    <p className="muted">{message.fromAgentId===agent.id?'sent':'received'} · {message.deliveredAt?`delivered ${new Date(message.deliveredAt).toLocaleString()}`:'no delivery receipt yet'}</p>
   </article>)}
   {messageCursor&&<button onClick={()=>void window.office.messagePage({agentId:agent.id,limit:50,cursor:messageCursor}).then(page=>{setMessages(current=>[...current,...page.entries]);setMessageCursor(page.nextCursor);}).catch(e=>setError((e as Error).message))}>More scoped messages</button>}
  </div>}
  {tab==='Logs'&&<div className="tab-panel">
   {!logs.length&&<p>No imported conversation for this profile.</p>}
   <ul className="evidence-list">{logs.map(log=><li key={log.id}><b>{new Date(log.timestamp).toLocaleString()}</b> — {log.text.slice(0,400)}</li>)}</ul>
   {cursor&&<button className="secondary" onClick={()=>void window.office.logPage({agentId:agent.id,limit:50,cursor}).then(page=>{setLogs(current=>[...current,...page.entries]);setCursor(page.nextCursor);})}>Load more</button>}
   <p className="muted">Imported records are historical evidence. They never drive live office activity.</p>
  </div>}
 </div>;
}
