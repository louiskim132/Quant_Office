import React,{useCallback,useEffect,useRef,useState} from 'react';
import type {AgentLog,AppState,LineageEvent} from '../shared/types';
import './history.css';

type RecordView='all'|'yours'|'messages'|'work'|'between';
type Row={id:string;time:string;sequence:number;event:LineageEvent|null;log:AgentLog|null};

/**
 * History reads one page at a time from the indexed event log and merges it with the recorded
 * agent work log in one timeline. The workspace can hold far more events than the window ever
 * renders, so nothing here loads the whole event log to show the top of it.
 */
export function HistoryView({state,projectId,label,date}:{state:AppState;projectId:string|null;label:(value:string)=>string;date:(value:string)=>string}){
 const [subject,setSubject]=useState('');
 const [peer,setPeer]=useState('');
 const [view,setView]=useState<RecordView>('all');
 const [search,setSearch]=useState('');
 const [entries,setEntries]=useState<LineageEvent[]>([]);
 const [logs,setLogs]=useState<AgentLog[]>([]);
 const [cursor,setCursor]=useState<number|null>(null);
 const [total,setTotal]=useState(0);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const request=useRef(0);
 const load=useCallback(async(next:number|null,reset:boolean)=>{
  const ticket=++request.current;
  setBusy(true);setError('');
  try{
   const page=await window.office.historyPage({projectId,limit:50,...(next?{cursor:next}:{})});
   if(ticket!==request.current)return;
   setEntries(current=>reset?page.entries:[...current,...page.entries]);
   setCursor(page.nextCursor);setTotal(page.total);
  }catch(e){if(ticket===request.current)setError((e as Error).message);}finally{if(ticket===request.current)setBusy(false);}
 },[projectId]);
 const refreshLogs=useCallback(async()=>{
  try{setLogs(await window.office.getWorkLogs());}catch(e){setError((e as Error).message);}
 },[]);
 useEffect(()=>{void load(null,true);},[load,subject,peer,view,search]);
 useEffect(()=>{void refreshLogs();},[refreshLogs]);
 useEffect(()=>window.office.onChanged(()=>{void load(null,true);void refreshLogs();}),[load,refreshLogs]);
 const name=(id:string)=>state.agents.find(a=>a.id===id)?.name??({USER:'You',SYSTEM:'Office',TOOL:'Tool'}[id]??id);
 const isAgent=(id:string)=>state.agents.some(a=>a.id===id);
 const parties=[{id:'USER',label:'You'},{id:'SYSTEM',label:'Office'},{id:'TOOL',label:'Tool'},...state.agents.map(a=>({id:a.id,label:a.name}))];
 const needle=search.toLowerCase();
 const rows:Row[]=[
  ...entries.map(event=>({id:event.id,time:event.createdAt,sequence:event.sequence,event,log:null})),
  ...logs.filter(log=>subject!==''||log.provenance!=='OFFICE_EVENT').map(log=>({id:log.id,time:log.timestamp,sequence:-1,event:null,log}))
 ];
 const visible=rows.filter(row=>{
  if(row.event){
   if(subject&&subject!=='USER')return false;
   if(peer)return false;
   if(view==='messages'||view==='between')return false;
   return `${row.event.kind} ${row.event.reason}`.toLowerCase().includes(needle);
  }
  const log=row.log!;
  if(subject&&log.from!==subject&&log.to!==subject)return false;
  if(peer&&log.from!==peer&&log.to!==peer)return false;
  if(view==='yours')return false;
  if(view==='messages'&&log.kind!=='MESSAGE')return false;
  if(view==='work'&&log.kind==='MESSAGE')return false;
  if(view==='between'&&!(isAgent(log.from)&&isAgent(log.to)))return false;
  return `${log.text} ${name(log.from)} ${name(log.to)}`.toLowerCase().includes(needle);
 }).sort((a,b)=>Date.parse(b.time)-Date.parse(a.time)||b.sequence-a.sequence||(a.id<b.id?-1:a.id>b.id?1:0));
 const recorded=total+logs.length;
 return <>
  <div className="section-toolbar"><span>{recorded} recorded record{recorded===1?'':'s'} · showing {visible.length}</span></div>
  <div className="history-filters">
   <label className="field">Subject<select aria-label="Subject" value={subject} onChange={e=>{setSubject(e.target.value);setPeer('');}}>
    <option value="">All subjects</option><option value="USER">You</option><option value="SYSTEM">Office</option><option value="TOOL">Tool</option>{state.agents.map(a=><option key={a.id} value={a.id}>{a.name} · {a.team}</option>)}
   </select></label>
   <label className="field">Other participant<select aria-label="Other participant" value={peer} onChange={e=>setPeer(e.target.value)}>
    <option value="">Anyone</option>{parties.filter(p=>p.id!==subject).map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
   </select></label>
   <label className="field">Record view<select aria-label="Record view" value={view} onChange={e=>setView(e.target.value as RecordView)}>
    <option value="all">All records</option><option value="yours">Your actions</option><option value="messages">Conversation messages</option><option value="work">Work &amp; office events</option><option value="between">Between agents</option>
   </select></label>
   <label className="field">Search<input aria-label="Search records" value={search} onChange={e=>setSearch(e.target.value)}/></label>
  </div>
  {error&&<p className="notice error" role="alert">{error}</p>}
  <div className="timeline">{visible.map(row=>row.event?<article key={row.id}>
   <span className="timeline-dot"/>
   <div className="card-heading"><h3>{label(row.event.kind.replaceAll('.',' '))}</h3><time>{date(row.event.createdAt)}</time></div>
   <p>{row.event.reason}</p>
   <div className="event-meta"><span>#{row.event.sequence} · {name(row.event.actor)}</span>
    <details><summary>Event integrity</summary><code className="hash">{row.event.hash}</code></details></div>
  </article>:<article key={row.id}>
   <span className="timeline-dot"/>
   <div className="card-heading"><h3>{name(row.log!.from)} → {name(row.log!.to)}</h3><time>{date(row.log!.timestamp)}</time></div>
   <p>{row.log!.text}</p>
   <div className="event-meta"><span>{row.log!.kind.toLowerCase()} · {row.log!.conversationId} · {row.log!.provenance==='OFFICE_EVENT'?'Office event':'Imported transcript'}</span>
    <details><summary>Record integrity</summary><code className="hash">{row.log!.externalId}<br/>{row.log!.provenance==='OFFICE_EVENT'?'Event':'Source file'} SHA-256: {row.log!.sourceHash}</code></details></div>
  </article>)}</div>
  <div className="button-row">
   {cursor!==null&&<button className="secondary" disabled={busy} onClick={()=>void load(cursor,false)}>{busy?'Loading…':'Load older events'}</button>}
   {cursor===null&&entries.length>0&&<p className="muted">The whole recorded history for this scope is shown.</p>}
  </div>
 </>;
}
