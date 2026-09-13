import React,{useEffect,useRef,useState} from 'react';
import type {AgentDraft,AgentTicket,AppState,Connection,Provider,ReadinessActions,Role,Effort} from '../shared/types';
import { suggestedEfforts } from '../shared/effort';
import { providerReadiness } from '../shared/readiness';
import { LocalConsumption } from './activity';
import {TRANSPORT_PROBE_CONTAINMENT} from '../shared/transport';
import './agents.css';
const roleNames:Record<Role,string>={DIRECTOR:'Director',PM_A:'PM · Implementation',PM_B:'PM · Verification',PM_C:'PM · Findings',PM_D:'PM · Falsification',WORKER:'Worker'};
let setupDraft:AgentDraft|undefined;
export function AgentSetup({onAdded}:{onAdded:(state:AppState)=>void}){
 // Claude is the primary provider for new work. Existing profiles keep the provider they were created with.
 const [draft,setDraft]=useState<AgentDraft>(setupDraft??{name:'',provider:'claude',model:'opus',team:'Research',role:'WORKER',instructions:'',effort:'default'});
 const [ticket,setTicket]=useState<AgentTicket|null>(null),[connection,setConnection]=useState<Connection|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const operation=useRef(0);
 useEffect(()=>()=>{operation.current++;void window.office.cancelAgent();},[]);
 function edit(patch:Partial<AgentDraft>){setTicket(null);setupDraft={...draft,...patch};setDraft(setupDraft);}
 async function add(){const turn=++operation.current;setBusy(true);setError('');try{const result=await window.office.connectAgent(draft);if(turn===operation.current){setTicket(result);setConnection(result.connection);}}catch(e){if(turn===operation.current)setError(String((e as Error).message));}finally{if(turn===operation.current)setBusy(false);}}
 async function cancel(){operation.current++;setBusy(false);setTicket(null);await window.office.cancelAgent();}
 async function confirm(){setBusy(true);setError('');try{if(ticket){const state=await window.office.confirmAgent(ticket.id);setupDraft=undefined;onAdded(state);}}catch(e){setError((e as Error).message);setTicket(null);}finally{setBusy(false);}}
 async function refresh(){setBusy(true);setError('');try{setConnection(await window.office.connectionStatus(draft.provider));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 return <section className="settings-card agent-setup"><div className="section-title"><div><h2>A new member of your team</h2><p>Subscription sign-in stays with the official provider tool. Add verifies the account; Confirm creates the agent.</p></div></div>
 <form onSubmit={e=>{e.preventDefault();void(ticket?confirm():add());}}>
 <fieldset disabled={busy||!!ticket} className="agent-fields">
 <label className="field">Agent name<input required maxLength={160} value={draft.name} onChange={e=>edit({name:e.target.value})}/></label>
 <label className="field">Provider<select value={draft.provider} onChange={e=>{const provider=e.target.value as Provider;setConnection(null);edit({provider,model:provider==='openai'?'gpt-6-astra':'opus'});}}><option value="openai">OpenAI · ChatGPT subscription</option><option value="claude">Anthropic · Claude subscription</option></select></label>
 <label className="field">Model<input required maxLength={160} list="provider-models" value={draft.model} onChange={e=>edit({model:e.target.value})}/><datalist id="provider-models">{(connection?.models.length?connection.models:draft.provider==='openai'?[{id:'gpt-6-astra',name:'GPT-6 Astra'},{id:'gpt-5.6-sol',name:'GPT-5.6 Sol'},{id:'gpt-5.6-terra',name:'GPT-5.6 Terra'}]:[{id:'opus',name:'Opus alias'},{id:'sonnet',name:'Sonnet alias'},{id:'haiku',name:'Haiku alias'}]).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</datalist><small>{draft.provider==='openai'?'Provisional until checked against your signed-in model catalog.':'Choose a Claude Code alias or exact model ID. Account login does not verify model entitlement.'}</small></label>
 <label className="field">Section / team<input required maxLength={160} value={draft.team} onChange={e=>edit({team:e.target.value})}/></label>
 <label className="field">Role<select aria-label="Role" value={draft.role} onChange={e=>edit({role:e.target.value as Role})}>{Object.entries(roleNames).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
 <label className="field">Effort level<select aria-label="Initial effort level" value={draft.effort??'default'} onChange={e=>edit({effort:e.target.value as Effort})}>{[...new Set([draft.effort??'default',...(connection?.models.find(m=>m.id===draft.model)?.efforts??suggestedEfforts(draft.provider,draft.model))])].map(level=><option value={level} key={level}>{level==='default'?'Provider default':level}</option>)}</select><small>Saved preference is revalidated before confirmation. Without an exact catalog, capability is unknown and only provider default is accepted.</small></label>
 <label className="field">Instructions<textarea rows={3} maxLength={12000} value={draft.instructions} onChange={e=>edit({instructions:e.target.value})}/></label>
 </fieldset>
 {error&&<div className="notice error" role="alert">{error}</div>}
 {busy&&<p role="status">Checking the subscription connection… Complete sign-in in the provider window if it opens.</p>}
 {ticket&&<div className="connection-confirm" role="status"><h3>Account connected · ready to confirm</h3><p>{ticket.connection.account} · {ticket.draft.model} · effort {ticket.draft.effort??'default'}</p><p>{ticket.draft.team} / {roleNames[ticket.draft.role]}</p><p>{ticket.connection.note}</p><small>Provider-hosted research execution still requires setup. This agent will be added with research dispatch blocked.</small></div>}
 <div className="button-row"><button className="primary" disabled={busy}>{ticket?'Confirm':'Add'}</button>{(busy||ticket)&&<button type="button" className="secondary" onClick={()=>void cancel()}>{busy?'Cancel sign-in':'Edit details'}</button>}<button type="button" className="secondary" disabled={busy||!!ticket} onClick={()=>void refresh()}>Refresh models &amp; account</button></div>
 </form>
 <div className="inline-note">No limit on the number of agents or members of a role. Agents using the same account share its allowance.</div>
 <div className="button-row"><button className="text-button" disabled={busy} onClick={()=>void window.office.selectProviderTool(draft.provider).catch(e=>setError(e.message))}>Locate sign-in tool</button></div>
 <p className="muted">Requires the official codex.exe or claude.exe installed on this device. Authentication and usage checks run locally; research code does not.</p>
 </section>;
}
export function SubscriptionUsage({state}:{state:AppState}){
 const [connections,setConnections]=useState<Partial<Record<Provider,Connection>>>({}),[errors,setErrors]=useState<Partial<Record<Provider,string>>>({}),[busy,setBusy]=useState<Partial<Record<Provider,boolean>>>({});
 async function refresh(provider:Provider){setBusy(b=>({...b,[provider]:true}));setErrors(e=>({...e,[provider]:''}));try{const value=await window.office.connectionStatus(provider);setConnections(c=>({...c,[provider]:value}));}catch(e){setErrors(old=>({...old,[provider]:(e as Error).message}));setConnections(c=>({...c,[provider]:undefined}));}finally{setBusy(b=>({...b,[provider]:false}));}}
 return <><div className="inline-note">Subscription allowances belong to accounts, not individual agents. No API billing or automatic paid fallback. Usage is refreshed only when requested.</div>{(['openai','claude'] as Provider[]).map(provider=>{const c=connections[provider];return <section className="settings-card" key={provider}><div className="section-toolbar"><h2>{provider==='openai'?'ChatGPT / Codex':'Claude'}</h2><button className="secondary" disabled={busy[provider]} onClick={()=>void refresh(provider)}>{busy[provider]?'Checking…':'Refresh usage'}</button></div><p>{c?.connected?c.account:'Account not checked'} · {state.agents.filter(a=>!a.removedAt&&a.provider===provider&&(!c?.connected||a.account===c.account)).length} active profiles{c?.connected?' with matching setup account':' (account not checked)'}</p>{c?.connected&&state.agents.some(a=>!a.removedAt&&a.provider===provider&&a.account!==c.account)&&<p className="blocker">Some profiles were verified under a different account. Their connection is not current.</p>}{c?.windows.length?<div className="metric-grid">{c.windows.map((w,i)=><div className="metric" key={i}><span>{w.label}</span><strong>{w.remainingPercent.toFixed(0)}% remaining</strong><progress max="100" value={w.remainingPercent}/><small>Resets {new Date(w.resetsAt*1000).toLocaleString()}</small></div>)}</div>:<div className="usage-unavailable"><strong>5 hour: Unavailable</strong><strong>Weekly: Unavailable</strong></div>}<p>{errors[provider]||c?.note||'Refresh to check the official provider tool. Missing values are never estimated.'}</p>{c&&<small>Checked {new Date(c.checkedAt).toLocaleString()}</small>}<div><button className="text-button" onClick={()=>void window.office.openProviderUsage(provider).catch(e=>setErrors(old=>({...old,[provider]:e.message})))}>Open official usage page</button></div></section>;})}<LocalConsumption/></>;
}

const providerNames:Record<Provider,string>={claude:'Anthropic · Claude subscription',openai:'OpenAI · ChatGPT subscription'};
const actionNames:[keyof ReadinessActions,string][]=[['prepare','Prepare request'],['handoff','Official terminal handoff'],['automaticStart','Automatic start'],['observe','Observe job'],['requestCancellation','Request cancellation'],['duplicate','Duplicate'],['viewTerminalHistory','View handoff history']];
/**
 * Readiness comes only from persisted observations. A live check that could not be recorded is shown
 * as exactly that, and never changes what the office is allowed to do.
 */
export function ProviderConnections({state}:{state:AppState}){
 const [busy,setBusy]=useState<Partial<Record<Provider,boolean>>>({}),[errors,setErrors]=useState<Partial<Record<Provider,string>>>({}),[live,setLive]=useState<Partial<Record<Provider,string>>>({});
 async function check(provider:Provider){setBusy(b=>({...b,[provider]:true}));setErrors(e=>({...e,[provider]:''}));
  try{const connection=await window.office.connectionStatus(provider);setLive(l=>({...l,[provider]:connection.checkedAt}));}
  catch(e){setErrors(old=>({...old,[provider]:(e as Error).message}));}finally{setBusy(b=>({...b,[provider]:false}));}}
 return <div className="settings-card"><h2>Connections</h2>
  <p className="muted">Every check is recorded with the exact official tool version that produced it. Only an operation the office actually exercised counts as verified; documentation and sign-in never make work runnable.</p>
  {(['claude','openai'] as Provider[]).map(provider=>{const readiness=providerReadiness(state,provider);const snapshot=state.capabilities?.filter(c=>c.provider===provider).at(-1);
   const checked=live[provider];
   return <div className="setting-row connection-row" key={provider}><div>
    <strong>{providerNames[provider]}{provider==='claude'&&<span className="quiet-badge"> Primary</span>}</strong>
    <p>{readiness.identity?`${readiness.identity} · last recorded observation ${new Date(readiness.lastObservedAt).toLocaleString()}`:'No account check recorded yet.'}</p>
    {checked&&checked!==readiness.lastObservedAt&&<p className="muted">Last live check {new Date(checked).toLocaleString()} was not persisted as a new observation. It cannot authorize anything.</p>}
    <ul className="readiness-list">{([['Signed in',readiness.signedIn],['Account fresh',readiness.accountFresh],['Model checked',readiness.modelChecked],['Cloud checked',readiness.cloudChecked],['Ready',readiness.ready]] as [string,boolean][])
      .map(([label,value])=><li key={label} data-state={value?'yes':'no'}>{label}: {value?'Yes':'No'}</li>)}</ul>
    <ul className="readiness-list">{actionNames.map(([action,label])=><li key={action} data-state={readiness.actions[action]?'yes':'no'}>{label}: {readiness.actions[action]?'Allowed':'Blocked'}</li>)}</ul>
    {snapshot&&<p className="muted">Tool {snapshot.toolVersion} · transport {snapshot.transport.toLowerCase().replaceAll('_',' ')} · {snapshot.models.length} model{snapshot.models.length===1?'':'s'} · source: {snapshot.source}</p>}
    {readiness.evidence.filter(item=>item.level!=='ACCOUNT_VERIFIED'||item.expired).length>0&&<details><summary>Capability evidence</summary>
     <ul className="evidence-list">{readiness.evidence.map(item=><li key={item.operation}><b>{item.operation.toLowerCase().replaceAll('_',' ')}</b>: {item.level.toLowerCase().replaceAll('_',' ')} · {item.evidence.toLowerCase()}{item.model?` · model ${item.model}`:''}{item.expired?' · expired':''} — {item.detail} <i>({item.source})</i></li>)}</ul>
    </details>}
    {readiness.blockers.map(blocker=><p className="muted" key={blocker}>{blocker}</p>)}
    {errors[provider]&&<p className="notice error" role="alert">{errors[provider]}</p>}
    {provider==='claude'&&TRANSPORT_PROBE_CONTAINMENT.contained&&<p className="muted">{TRANSPORT_PROBE_CONTAINMENT.status}</p>}
   </div><div className="button-row">
    <button className="secondary" disabled={busy[provider]} onClick={()=>void check(provider)}>{busy[provider]?'Checking…':'Check account'}</button>
    {provider==='claude'&&<button className="text-button" disabled title={TRANSPORT_PROBE_CONTAINMENT.status}>Verify cloud transport…</button>}
   </div></div>;})}
 </div>;
}
