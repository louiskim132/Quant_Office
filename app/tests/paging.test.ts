import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import type {Agent,WorkLog} from '../src/shared/types';

const key=()=>randomUUID();
const at=(index:number)=>new Date(Date.UTC(2026,8,8,16,0,0)+index*1000).toISOString();

function fixture(t:any){
 const root=mkdtempSync(path.join(tmpdir(),'qro-paging-'));
 const file=path.join(root,'workspace.sqlite');
 let store=new OfficeStore(file);
 t.after(()=>{try{store.close();}catch{}removeTreeSync(root);});
 return {file,root,get store(){return store;},reopen(){store.close();store=new OfficeStore(file);return store;}};
}
const agent=(name:string):Agent=>({id:randomUUID(),name,provider:'claude',model:'opus',team:'Research',role:'WORKER',instructions:'',
 account:'researcher@example.com',createdAt:at(0),connectionVerifiedAt:at(0),execution:'HOSTED_SETUP_REQUIRED'});

test('history pages by cursor, scoped by project, without loading the whole log',t=>{
 const f=fixture(t);
 const alpha=f.store.execute({type:'project.create',idempotencyKey:key(),name:'Alpha',mandate:'m',budgetCents:0}).projects[0];
 const beta=f.store.execute({type:'project.create',idempotencyKey:key(),name:'Beta',mandate:'m',budgetCents:0}).projects.find(p=>p.name==='Beta')!;
 for(let index=0;index<40;index++)f.store.execute({type:'project.update',idempotencyKey:key(),projectId:index%2?alpha.id:beta.id,
  name:index%2?'Alpha':'Beta',mandate:`revision ${index}`,budgetCents:0});
 const first=f.store.historyPage({limit:10});
 assert.equal(first.entries.length,10);
 assert.equal(first.total,42);
 assert.ok(first.nextCursor);
 const second=f.store.historyPage({limit:10,cursor:first.nextCursor!});
 assert.equal(second.entries.length,10);
 assert.equal(new Set([...first.entries,...second.entries].map(entry=>entry.sequence)).size,20,'pages do not overlap');
 assert.ok(first.entries[0].sequence>second.entries[0].sequence,'newest first');
 const scoped=f.store.historyPage({projectId:alpha.id,limit:100});
 assert.equal(scoped.total,21);
 assert.equal(scoped.entries.every(entry=>entry.projectId===alpha.id),true);
 const last=f.store.historyPage({limit:100});
 assert.equal(last.nextCursor,null);
 assert.equal(last.entries.length,42);
});

test('imported conversation pages by agent and by conversation',t=>{
 const f=fixture(t);
 const one=agent('Worker one'),two=agent('Worker two');
 f.store.addAgent(one);f.store.addAgent(two);
 const logs:WorkLog[]=[];
 for(let index=0;index<30;index++)logs.push({id:randomUUID(),conversationId:index<20?'conversation-a':'conversation-b',
  from:index%2?one.id:two.id,to:index%2?two.id:one.id,kind:'MESSAGE',text:`entry ${index}`,timestamp:at(index),
  sourceHash:'a'.repeat(64),externalId:`external-${index}`,provenance:'USER_IMPORTED'});
 assert.equal(f.store.importWorkLogs(logs),30);
 const page=f.store.logPage({agentId:one.id,limit:8});
 assert.equal(page.entries.length,8);
 assert.equal(page.total,30,'every entry involves both agents in this fixture');
 const next=f.store.logPage({agentId:one.id,limit:8,cursor:page.nextCursor!});
 assert.equal(next.entries.length,8);
 assert.equal(new Set([...page.entries,...next.entries].map(entry=>entry.id)).size,16);
 const conversation=f.store.logPage({conversationId:'conversation-b',limit:100});
 assert.equal(conversation.total,20,'each entry is indexed once per participant');
 assert.equal(conversation.entries.every(entry=>entry.conversationId==='conversation-b'),true);
});

test('job events page per job and stay deduplicated',t=>{
 const f=fixture(t);
 const project=f.store.execute({type:'project.create',idempotencyKey:key(),name:'Alpha',mandate:'m',budgetCents:0}).projects[0];
 const worker=agent('Worker one');f.store.addAgent(worker);
 const request=f.store.execute({type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Question',hypothesis:'Ask',workType:'QUESTION',mode:'SINGLE',leadAgentId:worker.id,participantIds:[]}).requests![0];
 const snapshot={id:randomUUID(),projectId:project.id,requestId:request.id,locationRevision:0,requestRevision:request.revision,
  route:'GENERATED_REQUEST_ONLY' as const,files:[],totalBytes:0,manifestHash:'0'.repeat(64),stagingCommit:'',stagingPath:'',
  warnings:[],provenance:'OFFICE_STAGED' as const,createdAt:at(0)};
 f.store.recordInputSnapshot(snapshot);
 const observation={provider:'claude' as const,identity:'researcher@example.com',credentialContext:'claude-code-cli',state:'SIGNED_IN' as const,
  allowance:[],note:'',toolVersion:'2.1.236',transport:'NONE' as const,environment:'',models:[{id:'opus',name:'Opus'}],
  operations:[{operation:'ACCOUNT_STATUS' as const,level:'ACCOUNT_VERIFIED' as const,detail:'ok',evidence:'OBSERVED' as const,verifiedAt:at(0)}],
  source:'fixture',observedAt:at(0)};
 f.store.recordAccountObservation(observation);
 f.store.bindAgentConnection({agentId:worker.id,expectedRevision:0,intent:'VERIFY',observation:{...observation,observedAt:at(1)}});
 const connection=f.store.snapshot().connections![0];
 const capability=f.store.snapshot().capabilities![0];
 const assignment={id:randomUUID(),projectId:project.id,requestId:request.id,requestRevision:request.revision,agentId:worker.id,
  agentRevision:1,connectionId:connection.id,capabilitySnapshotId:capability.id,snapshotId:snapshot.id,route:'FAKE_ADAPTER' as const,
  requestedModel:'opus',resolvedModel:'',requestedEffort:'default' as const,appliedEffort:'UNVERIFIED' as const,delegation:false,
  objectiveHash:'0'.repeat(64),createdAt:at(1)};
 f.store.createAssignment({assignment,job:{id:randomUUID(),assignmentId:assignment.id,projectId:project.id,requestId:request.id,provider:'claude',route:'FAKE_ADAPTER'}});
 const job=f.store.snapshot().jobs![0];
 const events=Array.from({length:25},(_,index)=>({externalId:`evt-${index}`,cursor:String(index),kind:'MESSAGE' as const,
  text:`step ${index}`,occurredAt:at(index),receivedAt:at(index),evidence:'PROVIDER_REPORTED' as const}));
 assert.equal(f.store.recordJobEvents(job.id,events),25);
 assert.equal(f.store.recordJobEvents(job.id,events),0,'a replayed feed adds nothing');
 const page=f.store.jobEventPage(job.id,{limit:10});
 assert.equal(page.entries.length,10);
 assert.equal(page.total,25);
 const rest=f.store.jobEventPage(job.id,{limit:100,cursor:page.nextCursor!});
 assert.equal(rest.entries.length,15);
 assert.equal(rest.nextCursor,null);
 assert.equal(f.store.jobEventPage(randomUUID(),{limit:10}).total,0);
});

test('the read indexes are rebuilt from the event log when an older workspace is opened',t=>{
 const f=fixture(t);
 const project=f.store.execute({type:'project.create',idempotencyKey:key(),name:'Alpha',mandate:'m',budgetCents:0}).projects[0];
 for(let index=0;index<5;index++)f.store.execute({type:'project.update',idempotencyKey:key(),projectId:project.id,name:'Alpha',mandate:`m${index}`,budgetCents:0});
 const before=f.store.historyPage({limit:100});
 // Simulate a workspace written by the previous schema version: drop the derived indexes.
 const store=f.store as unknown as {db:{exec(sql:string):void}};
 store.db.exec('PRAGMA user_version=1; DROP TABLE event_index; DROP TABLE log_index; DROP TABLE job_event_index; DROP TABLE research_read_index;');
 const reopened=f.reopen();
 const after=reopened.historyPage({limit:100});
 assert.deepEqual(after.entries.map(entry=>entry.sequence),before.entries.map(entry=>entry.sequence));
 assert.equal(after.total,before.total);
 assert.equal(reopened.snapshot().projects.length,1,'rebuilding an index never changes the recorded facts');
});
