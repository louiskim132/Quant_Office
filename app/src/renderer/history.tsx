import React,{useCallback,useEffect,useState} from 'react';
import type {AppState,LineageEvent} from '../shared/types';

/**
 * History reads one page at a time from the indexed event log.
 * The workspace can hold far more events than the window ever renders, so nothing here loads the
 * whole log to show the top of it.
 */
export function HistoryView({state,projectId,label,date}:{state:AppState;projectId:string|null;label:(value:string)=>string;date:(value:string)=>string}){
 const [search]=useState('');
 const [entries,setEntries]=useState<LineageEvent[]>([]);
 const [cursor,setCursor]=useState<number|null>(null);
 const [total,setTotal]=useState(0);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const load=useCallback(async(next:number|null,reset:boolean)=>{
  setBusy(true);setError('');
  try{
   const page=await window.office.historyPage({projectId,limit:50,...(next?{cursor:next}:{})});
   setEntries(current=>reset?page.entries:[...current,...page.entries]);
   setCursor(page.nextCursor);setTotal(page.total);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 },[projectId]);
 useEffect(()=>{void load(null,true);},[load]);
 useEffect(()=>window.office.onChanged(()=>{void load(null,true);}),[load]);
 const visible=entries.filter(entry=>`${entry.kind} ${entry.reason}`.toLowerCase().includes(search.toLowerCase()));
 return <>
  <div className="section-toolbar"><span>{total} recorded event{total===1?'':'s'} · showing {visible.length}</span></div>
  {error&&<p className="notice error" role="alert">{error}</p>}
  <div className="timeline">{visible.map(entry=><article key={entry.id}>
   <span className="timeline-dot"/>
   <div className="card-heading"><h3>{label(entry.kind.replaceAll('.',' '))}</h3><time>{date(entry.createdAt)}</time></div>
   <p>{entry.reason}</p>
   <div className="event-meta"><span>#{entry.sequence} · {entry.actor}</span>
    <details><summary>Event integrity</summary><code className="hash">{entry.hash}</code></details></div>
  </article>)}</div>
  <div className="button-row">
   {cursor!==null&&<button className="secondary" disabled={busy} onClick={()=>void load(cursor,false)}>{busy?'Loading…':'Load older events'}</button>}
   {cursor===null&&entries.length>0&&<p className="muted">The whole recorded history for this scope is shown.</p>}
  </div>
 </>;
}
