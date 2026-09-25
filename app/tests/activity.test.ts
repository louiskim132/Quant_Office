import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {reconstructUsage} from '../src/main/local-usage.js';
import {parseWorkLogs} from '../src/main/work-logs.js';
import {OfficeStore} from '../src/core/store.js';
import {ArtifactService} from '../src/main/artifacts.js';
import {prepareRestore} from '../src/main/recovery.js';
import {Subscriptions} from '../src/main/subscriptions.js';
import {officeActivity} from '../src/shared/activity.js';
import type {Agent,Assignment,JobEvent,ProviderJob,Request} from '../src/shared/types.js';
import type {LocalSessionRecord,StopStatus} from '../src/shared/local-session.js';
const now=Date.parse('2026-09-07T12:00:00Z');
const usage=(id:string,time:string,output=10)=>({type:'assistant',sessionId:'s1',timestamp:time,message:{id,model:'test-opus',content:[{type:'text',text:'PRIVATE PROMPT MUST NOT APPEAR IN AGGREGATES'}],usage:{input_tokens:100,output_tokens:output,cache_read_input_tokens:20,cache_creation_input_tokens:5}}});
test('local reconstruction deduplicates streamed/copied responses and uses rolling periods without quota inference',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'qro-counts-'));await mkdir(path.join(root,'subagents'));
 await writeFile(path.join(root,'one.jsonl'),[usage('a','2026-09-07T10:00:00Z',2),usage('a','2026-09-07T10:00:00Z',10),usage('b','2026-09-06T10:00:00Z'),usage('old','2026-08-01T10:00:00Z')].map(JSON.stringify as any).join('\n'));
 await writeFile(path.join(root,'subagents','copy.jsonl'),JSON.stringify(usage('a','2026-09-07T10:00:00Z'))+'\n');
 const result=await reconstructUsage(root,now);assert.equal(result.last5Hours.input,100);assert.equal(result.last5Hours.output,10);assert.equal(result.last7Days.input,200);assert.equal(result.last7Days.messages,2);assert.equal(result.last7Days.cacheRead,40);assert.equal(result.last7Days.cacheCreation,10);assert.equal(result.duplicates,2);assert.equal(result.daily.length,2);assert.equal(result.models[0].totals.messages,2);assert.doesNotMatch(JSON.stringify(result),/PRIVATE PROMPT/);assert.equal('remainingPercent' in result,false);assert.equal('resetsAt' in result,false);
});
test('partial and malformed lines, negative tokens and future timestamps are reported without corrupting counts',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'qro-partial-'));const invalid=usage('bad','2026-09-07T10:00:00Z');invalid.message.usage.input_tokens=-1;
 await writeFile(path.join(root,'active.jsonl'),[JSON.stringify(usage('ok','2026-09-07T10:00:00Z')),JSON.stringify(invalid),JSON.stringify(usage('future','2026-09-08T10:00:00Z')),'broken json','{"type":'].join('\n'));
 const r=await reconstructUsage(root,now);assert.equal(r.last5Hours.messages,1);assert.equal(r.malformed,4);assert.equal(r.partial,true);
 await writeFile(path.join(root,'active.jsonl'),JSON.stringify(usage('replacement','2026-09-07T10:00:00Z',1))+'\n');const rescan=await reconstructUsage(root,now);assert.equal(rescan.last5Hours.output,1);assert.equal(rescan.partial,false);
});
test('missing transcript directory is unavailable rather than a claim of zero account use',async()=>{const root=await mkdtemp(path.join(tmpdir(),'qro-missing-'));const r=await reconstructUsage(path.join(root,'absent'),now);assert.equal(r.files,0);assert.match(r.note,/unavailable/);});
test('imported visible conversation and tool records exclude thinking blocks and retain external provenance',()=>{
 const agentId=randomUUID(),known=new Set([agentId]);const source=[{type:'user',sessionId:'session',uuid:'u1',timestamp:'2026-09-07T10:00:00Z',message:{content:'Research request'}},{type:'assistant',sessionId:'session',uuid:'a1',timestamp:'2026-09-07T10:01:00Z',message:{content:[{type:'thinking',thinking:'PRIVATE REASONING'},{type:'text',text:'Visible result <script>bad()</script>'},{type:'tool_use',name:'Read',input:{secret:'not included'}}]}}];
 const result=parseWorkLogs(Buffer.from(source.map(JSON.stringify as any).join('\n')),agentId,known);assert.equal(result.entries.length,2);assert.equal(result.entries[0].from,'USER');assert.equal(result.entries[1].to,'TOOL');assert.equal(result.entries[1].provenance,'USER_IMPORTED');assert.doesNotMatch(JSON.stringify(result),/PRIVATE REASONING|not included/);assert.match(result.entries[1].text,/<script>/);
});
function setupStore(file:string){const store=new OfficeStore(file),first=randomUUID(),second=randomUUID();for(const [id,name] of [[first,'First'],[second,'Second']])store.addAgent({id,name,provider:'claude',model:'opus',role:'DIRECTOR',team:'Research',instructions:'',account:'test@example.test',createdAt:new Date().toISOString(),connectionVerifiedAt:new Date().toISOString(),execution:'HOSTED_SETUP_REQUIRED'});return {store,first,second};}
const exchange=(from:string,to:string,text='Please review')=>({format:'qro-log-v1',conversationId:'review-1',messageId:'msg-1',from,to,kind:'MESSAGE',text,timestamp:'2026-09-07T10:00:00Z'});
test('between-agent messages are immutable, deduplicated and survive restart; unknown participants fail atomically',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'qro-logs-')),file=path.join(root,'workspace.sqlite');const {store,first,second}=setupStore(file),known=new Set([first,second]);
 const entries=parseWorkLogs(Buffer.from(JSON.stringify(exchange(first,second))),first,known).entries;
 assert.equal(store.importWorkLogs(entries),1);assert.equal(store.importWorkLogs(entries),0);assert.equal(store.workLogs().filter(l=>l.provenance==='USER_IMPORTED').length,1);
 const conflict=parseWorkLogs(Buffer.from(JSON.stringify(exchange(first,second,'Altered'))),first,known);assert.throws(()=>store.importWorkLogs(conflict.entries),/Conflicting/);
 assert.throws(()=>parseWorkLogs(Buffer.from(JSON.stringify(exchange(first,randomUUID()))),first,known),/unknown agent/);
 assert.throws(()=>parseWorkLogs(Buffer.from(JSON.stringify(exchange(first,second))+'\nnot json'),first,known),/Invalid JSON/);
 store.close();const reopened=new OfficeStore(file);try{const messages=reopened.workLogs().filter(l=>l.kind==='MESSAGE');assert.equal(messages.length,1);assert.equal(messages[0].from,first);assert.equal(messages[0].to,second);}finally{reopened.close();}
});
test('effort changes use optimistic checks, create work-log events and restore with imported conversations',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'qro-effort-')),live=path.join(root,'workspace');await mkdir(live);const {store,first,second}=setupStore(path.join(live,'workspace.sqlite'));
 store.setAgentEffort(first,'high','default');assert.equal(store.snapshot().agents[0].effort,'high');assert.throws(()=>store.setAgentEffort(first,'low','default'),/another view/);store.setAgentEffort(first,'max','high');
 store.importWorkLogs(parseWorkLogs(Buffer.from(JSON.stringify(exchange(first,second))),first,new Set([first,second])).entries);assert.ok(store.workLogs().some(l=>l.provenance==='OFFICE_EVENT'&&l.text.includes('high → max')));
 const archive=path.join(root,'backup.zip');await new ArtifactService(store,live).backup(archive);store.close();const prepared=await prepareRestore(archive,root),restored=new OfficeStore(path.join(prepared.candidate,'workspace.sqlite'));try{assert.equal(restored.snapshot().agents[0].effort,'max');assert.ok(restored.workLogs().some(l=>l.conversationId==='review-1'));}finally{restored.close();}
});
test('a canceled request holds the seat idle only once its process is durably dead',()=>{
 // The frozen rule: an open job on a CANCELED request reads IDLE with 'outcome unresolved' only
 // when the office knows no process can still be alive — a recorded dead stop, or no session at
 // all. Fresh provider evidence still reads WORKING; a possibly-live binding keeps UNKNOWN.
 const now=Date.parse('2026-09-20T12:00:00Z'),old=new Date(now-60*60000).toISOString();
 const agent={id:'agent-1',name:'Worker',provider:'claude',model:'opus',role:'WORKER',team:'Research',instructions:'',account:'acct',createdAt:old,connectionVerifiedAt:old,execution:'LOCAL'} as Agent;
 const assignment={id:'assignment-1',agentId:agent.id} as Assignment;
 const job={id:'job-1',assignmentId:assignment.id,projectId:'project-1',requestId:'request-1',state:'RUNNING',evidence:'OFFICE_LOCAL',detail:'Running.',createdAt:old,updatedAt:old} as unknown as ProviderJob;
 const request={id:'request-1',status:'CANCELED'} as Request;
 const session=(stopStatus:StopStatus):LocalSessionRecord=>({
  schemaVersion:1,id:'session-1',jobId:job.id,assignmentId:assignment.id,projectId:'project-1',attemptId:'attempt-1',revision:0,
  provider:'claude',surface:'CLAUDE_CLI',layout:'FLAT_PACKET',packetVersion:2,packetHash:null,
  storageRelativePath:'session-fixture',originalCwd:null,repoRelativePath:null,seedCommit:null,worktreeOwner:'NONE',
  providerSessionId:null,providerProjectId:null,bindingEvidence:'UNBOUND',groupingStatus:'UNKNOWN',
  requirement:'SCOPED_DELIVERY',confinementStatus:'UNVERIFIED',confinementEvidenceId:null,lifecycle:'READY',
  archiveRelativePath:null,lastReceipt:null,cancelRequestId:null,stopStatus,createdAt:old,updatedAt:old});
 const seat=(localSessions:LocalSessionRecord[]=[],jobEvents:JobEvent[]=[])=>
  officeActivity({agents:[agent],assignments:[assignment],jobs:[job],jobEvents,messages:[],requests:[request],localSessions},{now})[0];
 assert.equal(seat().kind,'IDLE','no recorded session means no office-owned process was ever observed');
 assert.equal(seat().detail,'Last job cancelled; outcome unresolved');
 for(const stopStatus of ['PROCESS_EXIT_OBSERVED','SESSION_REPORTED_STOPPED','LEGACY_UNVERIFIED'] as const){
  const entry=seat([session(stopStatus)]);
  assert.equal(entry.kind,'IDLE',stopStatus);
  assert.equal(entry.detail,'Last job cancelled; outcome unresolved');
 }
 for(const stopStatus of ['NOT_REQUESTED','REQUESTED'] as const)
  assert.equal(seat([session(stopStatus)]).kind,'UNKNOWN',`a ${stopStatus} binding might still be live`);
 const fresh={id:'event-1',jobId:job.id,externalId:'evt-1',cursor:'',kind:'STATUS',text:'Still working.',occurredAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),evidence:'PROVIDER_REPORTED'} as JobEvent;
 assert.equal(seat([session('PROCESS_EXIT_OBSERVED')],[fresh]).kind,'WORKING','fresh provider evidence outranks the canceled bookkeeping');
});
test('effort capability validation rejects unsupported levels instead of substitution',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'qro-capabilities-')),service=new Subscriptions(root,async()=>{});
 try{
  // Claude's session-level enum is tool-published, so post-creation edits validate without a
  // connection; values outside the CLI's enum still refuse. OpenAI/Devin stay account-bound.
  assert.doesNotThrow(()=>service.validateEffort('claude','claude-sonnet-5','low'));
  assert.doesNotThrow(()=>service.validateEffort('claude','opus','max'));
  assert.throws(()=>service.validateEffort('claude','opus','ultra'),/not supported/);
  assert.throws(()=>service.validateEffort('claude','opus','none'),/not supported/);
  assert.throws(()=>service.validateEffort('openai','model','high'),/not supported/);
  assert.throws(()=>service.validateEffort('devin','swe-2-max','low'),/not supported/);
  // A signed-in catalog that narrows a model's levels still wins over the published enum.
  const narrowed={provider:'claude' as const,connected:true,account:'test',models:[{id:'opus',name:'Opus',efforts:['low' as const]}],windows:[],checkedAt:new Date().toISOString(),note:''};
  assert.throws(()=>service.validateEffort('claude','opus','max',narrowed),/not supported/);
  assert.throws(()=>service.validateEffort('openai','model','high',{provider:'openai',connected:true,account:'test',models:[{id:'model',name:'Model',efforts:['low']}],windows:[],checkedAt:new Date().toISOString(),note:''}),/not supported/);
 }finally{service.close();}
});
