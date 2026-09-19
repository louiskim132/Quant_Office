import {OutputService} from '../src/main/outputs';
import {ArtifactService} from '../src/main/artifacts';
import {prepareRestore,commitRestore,workspaceDirectory} from '../src/main/recovery';
import {reconstructSnapshot,verifySnapshotForTransfer,snapshotObjectPath} from '../src/main/locations';
import {readFileSync} from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import {unzipSync,strFromU8} from 'fflate';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {nextJob,reconciliationPlan,isTerminalJob} from '../src/core/jobs';
import {AssignmentController,type ObserveResult,type ProviderAdapter,type SubmitResult} from '../src/main/controller';
import {prepareInputSnapshot} from '../src/main/locations';
import type {Agent,CapabilityEvidence,CapabilityOperation,ProviderJob} from '../src/shared/types';

const key=()=>randomUUID();
const at=(minutes:number)=>new Date(Date.UTC(2026,8,8,10,0,0)+minutes*60000).toISOString();
const ROUTES=['FAKE_ADAPTER','OFFICIAL_TERMINAL_HANDOFF','OFFICIAL_CLI_PTY'] as const;
const CLOUD:CapabilityOperation[]=['CLOUD_SUBMIT','CLOUD_OBSERVE','CLOUD_OUTPUT_FETCH','CLOUD_CANCEL_REQUEST','CLOUD_CANCEL_ACK','MODEL_APPLICATION','EFFORT_APPLICATION','ENVIRONMENT_IDENTITY','DELEGATION_CONTROL','TOOL_CONFINEMENT'];
const seen=(operation:CapabilityOperation,minutes:number,extra:Partial<CapabilityEvidence>={}):CapabilityEvidence=>({operation,level:'ACCOUNT_VERIFIED',detail:'Exercised.',evidence:'OBSERVED',verifiedAt:at(minutes),source:'fixture',...extra});
const verifiedObservation=(minutes:number)=>({provider:'claude' as const,identity:'researcher@example.com',credentialContext:'claude-code-cli',state:'SIGNED_IN' as const,allowance:[],note:'',
 toolVersion:'2.1.236',transport:'OFFICIAL_CLI_TERMINAL' as const,environment:'anthropic-managed',models:[{id:'opus',name:'Opus'}],
 operations:[seen('ACCOUNT_STATUS',minutes),seen('MODEL_CATALOG',minutes),...CLOUD.flatMap(o=>ROUTES.flatMap(route=>o==='DELEGATION_CONTROL'?[seen(o,minutes,{model:'opus',route,delegation:false}),seen(o,minutes,{model:'opus',route,delegation:true})]:o==='EFFORT_APPLICATION'?[seen(o,minutes,{model:'opus',route,effort:'default'})]:o==='TOOL_CONFINEMENT'?[seen(o,minutes,{model:'opus',route,confinement:{tools:'Only the read-only fixture tools were offered.',filesystem:'Confined to the staged snapshot directory.',network:'No outbound network was reachable from the session.',environment:'anthropic-managed'}})]:[seen(o,minutes,{model:'opus',route})]))],
 source:'transport fixture',observedAt:at(minutes)});

/** A test double for the provider. No production code path can inject provider evidence this way. */
class FakeAdapter implements ProviderAdapter {
 readonly route='FAKE_ADAPTER' as const;
 submits=0;cancels=0;
 constructor(public behaviour:{submit?:()=>Promise<SubmitResult>;observe?:()=>Promise<ObserveResult>;cancel?:()=>Promise<{acknowledged:boolean;detail:string}>}={}){}
 async submit(){this.submits++;return this.behaviour.submit?await this.behaviour.submit():{externalId:'session_fixture_1',externalUrl:'https://example.invalid/session_fixture_1',detail:'Accepted by the fixture provider.'};}
 async observe(_job:ProviderJob){return this.behaviour.observe?await this.behaviour.observe():{state:'RUNNING' as const,detail:'Working.'};}
 async cancel(_job:ProviderJob){this.cancels++;return this.behaviour.cancel?await this.behaviour.cancel():{acknowledged:true,detail:'Provider acknowledged the cancellation.'};}
}

/** Real bytes, so an output is certified by what arrived rather than by a hash string. */
const OUTPUT_BYTES=new Map<string,Uint8Array>();
const declare=(path:string,text:string)=>{
 const bytes=Buffer.from(text);
 const sha256=createHash('sha256').update(bytes).digest('hex');
 OUTPUT_BYTES.set(sha256,bytes);
 return {path,sha256,bytes:bytes.byteLength};
};
const fetchOutput=async(_job:any,output:{sha256:string})=>{
 const bytes=OUTPUT_BYTES.get(output.sha256);
 if(!bytes)throw new Error('no bytes for this output');
 return bytes;
};
async function fixture(t:any,adapter=new FakeAdapter()){
 const root=mkdtempSync(path.join(tmpdir(),'qro-controller-'));
 const file=path.join(root,'workspace.sqlite');
 let store=new OfficeStore(file);
 t.after(()=>{try{store.close();}catch{}removeTreeSync(root);});
 const project=store.execute({type:'project.create',idempotencyKey:key(),name:'Alpha',mandate:'m',budgetCents:0}).projects[0];
 const source=path.join(root,'source');mkdirSync(source);writeFileSync(path.join(source,'input.csv'),'a,b\n1,2\n');
 store.execute({type:'location.save',idempotencyKey:key(),projectId:project.id,expectedRevision:0,localFolder:source,inputPaths:['input.csv'],outputFolder:''});
 const agent:Agent={id:randomUUID(),name:'Sole worker',provider:'claude',model:'opus',team:'Research',role:'WORKER',instructions:'',effort:'default',
  account:'researcher@example.com',createdAt:at(0),connectionVerifiedAt:at(0),execution:'HOSTED_SETUP_REQUIRED'};
 store.confirmAgentBinding({observation:verifiedObservation(0),agent});
 const request=store.execute({type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Tiny question',hypothesis:'Explain the fixture',workType:'QUESTION',mode:'SINGLE',leadAgentId:agent.id,participantIds:[]}).requests![0];
 const snapshot=await prepareInputSnapshot({store,objectRoot:root,stagingRoot:path.join(root,'staging'),projectId:project.id,requestId:request.id,requestRevision:request.revision});
 // One injected clock, held just inside the account-freshness window, so a run's result never
 // depends on the calendar date the suite happens to execute on.
 let tick=0;
 const clock=()=>at(++tick/60);
 let controller=new AssignmentController(store,adapter,clock,undefined,undefined,undefined,fetchOutput,new OutputService(store,root).storeBytes);
 return {root,project,agent,request,snapshot,adapter,get store(){return store;},get controller(){return controller;},
  restart(nextAdapter?:ProviderAdapter){store.close();store=new OfficeStore(file);controller=new AssignmentController(store,nextAdapter??adapter,clock,undefined,undefined,undefined,fetchOutput,new OutputService(store,root).storeBytes);return {store,controller};}};
}

test('the reducer refuses every transition that would invent provider evidence',()=>{
 const base:ProviderJob={id:randomUUID(),assignmentId:randomUUID(),projectId:randomUUID(),requestId:randomUUID(),provider:'claude',route:'FAKE_ADAPTER',
  state:'INTENT',evidence:'OFFICE_LOCAL',detail:'',externalId:'',externalUrl:'',outputs:[],revision:0,createdAt:at(0),updatedAt:at(0),dispatchedAt:'',settledAt:''};
 assert.throws(()=>nextJob(base,{to:'COMPLETED',at:at(1),evidence:'PROVIDER_REPORTED',detail:'x'}),/cannot move from INTENT to COMPLETED/);
 const submitting=nextJob(base,{to:'SUBMITTING',at:at(1),evidence:'OFFICE_LOCAL',detail:'sending'});
 assert.throws(()=>nextJob(submitting,{to:'ACCEPTED',at:at(2),evidence:'USER_REPORTED',detail:'I pasted a link'}),/needs a provider observation/);
 assert.throws(()=>nextJob(submitting,{to:'ACCEPTED',at:at(2),evidence:'PROVIDER_REPORTED',detail:'ok'}),/identifier the provider returned/);
 const accepted=nextJob(submitting,{to:'ACCEPTED',at:at(2),evidence:'PROVIDER_REPORTED',detail:'ok',externalId:'session_1'});
 assert.throws(()=>nextJob(accepted,{to:'COMPLETED',at:at(3),evidence:'PROVIDER_REPORTED',detail:'done'}),/attributable output/);
 const canceling=nextJob(accepted,{to:'CANCEL_REQUESTED',at:at(3),evidence:'OFFICE_LOCAL',detail:'stop'});
 assert.throws(()=>nextJob(canceling,{to:'CANCEL_ACKNOWLEDGED',at:at(4),evidence:'OFFICE_LOCAL',detail:'I closed the window'}),/provider acknowledgement/);
 const done=nextJob(accepted,{to:'COMPLETED',at:at(4),evidence:'PROVIDER_REPORTED',detail:'done',outputs:[{path:'out.json',sha256:'a'.repeat(64),bytes:2}]});
 assert.equal(isTerminalJob(done.state),true);
 assert.throws(()=>nextJob(done,{to:'RUNNING',at:at(5),evidence:'PROVIDER_REPORTED',detail:'late message'}),/cannot reopen/);
});

test('preparation freezes the exact versions and records intent before any provider call',async t=>{
 const f=await fixture(t);
 const {assignment,state}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 assert.equal(assignment.requestRevision,f.request.revision);
 assert.equal(assignment.agentRevision,0);
 assert.equal(assignment.snapshotId,f.snapshot.id);
 assert.equal(assignment.appliedEffort,'UNVERIFIED','no setting is claimed applied before the provider confirms it');
 const job=state.jobs![0];
 assert.equal(job.state,'INTENT');
 assert.equal(job.externalId,'','no identifier exists before the provider returns one');
 assert.equal(f.adapter.submits,0,'preparing calls no provider');
 assert.throws(()=>f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id}),/already has work in flight/);
});

test('a stale request or profile revision blocks the assignment',async t=>{
 const f=await fixture(t);
 f.store.execute({type:'request.update',idempotencyKey:key(),requestId:f.request.id,expectedRevision:f.request.revision,objective:'Changed objective',leadAgentId:f.agent.id,participantIds:[],acceptanceCriteria:''});
 assert.throws(()=>f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id,expectedRequestRevision:f.request.revision}),/changed in another view/);
 assert.throws(()=>f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id,expectedAgentRevision:5}),/profile changed in another view/);
 assert.equal(f.store.snapshot().assignments,undefined,'a refused preparation records nothing');
});

test('accepted submission stores the real identifier and receipt',async t=>{
 const f=await fixture(t);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 const state=await f.controller.dispatch(assignment.id);
 const job=state.jobs![0];
 assert.equal(job.state,'ACCEPTED');
 assert.equal(job.externalId,'session_fixture_1');
 assert.equal(job.evidence,'PROVIDER_REPORTED');
 assert.equal(job.dispatchedAt!=='',true);
 assert.equal(f.adapter.submits,1);
 assert.ok(state.events.some(e=>e.kind==='PROVIDER_JOB_ACCEPTED'));
});

test('a submission timeout becomes Unknown and is never retried automatically',async t=>{
 const adapter=new FakeAdapter({submit:async()=>{throw new Error('The provider call timed out after dispatch started.');}});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 const state=await f.controller.dispatch(assignment.id);
 const job=state.jobs![0];
 assert.equal(job.state,'UNKNOWN');
 assert.match(job.detail,/will not resubmit automatically/);
 assert.equal(adapter.submits,1);
 const plan=reconciliationPlan(job);
 assert.equal(plan.action,'OBSERVE');
 const resolved=await f.controller.observe(assignment.id);
 assert.equal(resolved.jobs![0].state,'RUNNING','reconciliation, not resubmission, resolves an unknown dispatch');
 assert.equal(adapter.submits,1);
});

test('a missing receipt is treated as unknown, not as acceptance',async t=>{
 const adapter=new FakeAdapter({submit:async()=>({externalId:'',externalUrl:'',detail:'The tool exited 0 but printed no session id.'})});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 const state=await f.controller.dispatch(assignment.id);
 assert.equal(state.jobs![0].state,'UNKNOWN');
 assert.equal(state.jobs![0].externalId,'');
});

test('duplicated provider events are recorded once and never change the outcome',async t=>{
 const events=[{externalId:'evt-1',cursor:'1',kind:'MESSAGE' as const,text:'Reading the input file.',occurredAt:at(1),receivedAt:at(1),evidence:'PROVIDER_REPORTED' as const},
  {externalId:'evt-2',cursor:'2',kind:'STATUS' as const,text:'Running.',occurredAt:at(2),receivedAt:at(2),evidence:'PROVIDER_REPORTED' as const}];
 const adapter=new FakeAdapter({observe:async()=>({state:'RUNNING',detail:'Working.',events})});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);
 await f.controller.observe(assignment.id);
 await f.controller.observe(assignment.id);
 const state=f.store.snapshot();
 assert.equal(state.jobEvents!.length,2,'a reconnect that replays the same events records them once');
 assert.equal(state.jobs![0].state,'RUNNING');
});

test('completion requires provider output, and a late event cannot reopen the job',async t=>{
 // Real bytes, so the completion is certified by what actually arrived, not by a hash string.
 const output=declare('proof.json','{"proof":"present"}');
 const adapter=new FakeAdapter({observe:async()=>({state:'COMPLETED',detail:'Finished.',outputs:[output],
  events:[{externalId:'evt-final',cursor:'9',kind:'OUTPUT',text:'proof.json written',occurredAt:at(5),receivedAt:at(5),evidence:'PROVIDER_REPORTED'}]})});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);
 const state=await f.controller.observe(assignment.id);
 const job=state.jobs![0];
 assert.equal(job.state,'COMPLETED');
 assert.deepEqual(job.outputs,[{...output,stored:true}]);
 assert.equal(job.settledAt!=='',true);
 await f.controller.observe(assignment.id);
 assert.equal(f.store.snapshot().jobs![0].revision,job.revision,'a settled job is not touched again');
 assert.throws(()=>f.store.recordJobTransition({jobId:job.id,expectedRevision:job.revision,to:'RUNNING',evidence:'PROVIDER_REPORTED',detail:'late'}),/cannot reopen/);
});

test("a verified receipt's applied self-report is recorded once as provider testimony",async t=>{
 const output=declare('proof.json','{"proof":"present"}');
 const adapter=new FakeAdapter({observe:async()=>({state:'COMPLETED' as const,detail:'Finished.',outputs:[output],
  applied:{model:'swe-2-max',effort:'high' as const,delegation:true}})});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);
 await f.controller.observe(assignment.id);
 const applied=(f.store.snapshot().jobEvents??[]).filter(e=>e.externalId.startsWith('applied:'));
 assert.equal(applied.length,1,'the self-report lands as exactly one job event');
 assert.equal(applied[0].kind,'STATUS');
 assert.equal(applied[0].evidence,'PROVIDER_REPORTED','the office verified the receipt; the content is the session\'s claim');
 assert.match(applied[0].text,/appliedModel="swe-2-max"/);
 assert.match(applied[0].text,/appliedEffort="high"/);
 assert.match(applied[0].text,/delegation=true/);
 assert.match(applied[0].text,/self-report.*not office-verified/is,'the text carries the self-reported qualifier');
 await f.controller.observe(assignment.id);
 assert.equal((f.store.snapshot().jobEvents??[]).filter(e=>e.externalId.startsWith('applied:')).length,1,'a repeated poll of the same receipt records nothing new');
});

test('an absent applied self-report records nothing; a changed one lands as a new event',async t=>{
 let report:ObserveResult={state:'RUNNING',detail:'Working.'};
 const adapter=new FakeAdapter({observe:async()=>report});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);
 await f.controller.observe(assignment.id);
 assert.equal((f.store.snapshot().jobEvents??[]).filter(e=>e.externalId.startsWith('applied:')).length,0,'an absent self-report records nothing');
 report={state:'RUNNING',detail:'Working.',applied:{effort:'low'}};
 await f.controller.observe(assignment.id);
 report={state:'RUNNING',detail:'Working.',applied:{effort:'high'}};
 await f.controller.observe(assignment.id);
 const applied=(f.store.snapshot().jobEvents??[]).filter(e=>e.externalId.startsWith('applied:'));
 assert.equal(applied.length,2,'a changed self-report lands as a new event even when the state did not move');
 assert.match(applied[0].text,/appliedEffort="low"/);
 assert.match(applied[1].text,/appliedEffort="high"/);
});

test('a self-report returning to an earlier value still lands — content-hash dedup must not lose A→B→A',async t=>{
 let report:ObserveResult={state:'RUNNING',detail:'Working.',applied:{effort:'low'}};
 const adapter=new FakeAdapter({observe:async()=>report});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);
 await f.controller.observe(assignment.id);
 report={state:'RUNNING',detail:'Working.',applied:{effort:'high'}};
 await f.controller.observe(assignment.id);
 report={state:'RUNNING',detail:'Working.',applied:{effort:'low'}};
 await f.controller.observe(assignment.id);
 const applied=(f.store.snapshot().jobEvents??[]).filter(e=>e.externalId.startsWith('applied:'));
 assert.equal(applied.length,3,'a return to an earlier value is a new report, not a duplicate of the first');
 assert.match(applied[2].text,/appliedEffort="low"/);
 assert.equal(applied[2].applied,undefined,'an unbound receipt carries no receipt identity — no structured payload');
 // A repeated poll of an unchanged report still records nothing.
 await f.controller.observe(assignment.id);
 assert.equal((f.store.snapshot().jobEvents??[]).filter(e=>e.externalId.startsWith('applied:')).length,3);
 assert.equal(f.store.appliedReports(f.store.snapshot().jobs![0].id).length,3,'the structured query returns the same chronological reports');
});

test('an adapter method fetch still retrieves declared output bytes',async t=>{
 // LocalMailboxAdapter.fetch is a real method that reads its own session root; the controller
 // must invoke it bound to the adapter, or every declared output fails retrieval.
 const text='{"proof":"present"}';
 const output=declare('proof.json',text);
 class MethodFetchAdapter extends FakeAdapter {
  private readonly bytes=Buffer.from(text);
  async fetch(){return new Uint8Array(this.bytes);}
 }
 const adapter=new MethodFetchAdapter();
 adapter.behaviour={observe:async()=>({state:'COMPLETED' as const,detail:'Finished.',outputs:[output]})};
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);
 const state=await f.controller.observe(assignment.id);
 const job=state.jobs![0];
 assert.equal(job.state,'COMPLETED','a declared output must be retrieved through the bound adapter method');
 assert.deepEqual(job.outputs,[{...output,stored:true}]);
});

test('a failed cancellation stays cancel-requested and records why',async t=>{
 const adapter=new FakeAdapter({cancel:async()=>({acknowledged:false,detail:'The provider has no supported cancellation route for this session.'})});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);
 const state=await f.controller.cancel(assignment.id);
 assert.equal(state.jobs![0].state,'CANCEL_REQUESTED');
 assert.equal(state.jobEvents!.some(e=>e.text.includes('not acknowledged')),true);
 assert.equal(f.store.snapshot().requests![0].status!=='CANCELED',true,'the request is not closed while provider work may continue');
});

test('cancellation before dispatch is immediate; after dispatch it waits for the provider',async t=>{
 const f=await fixture(t);
 const first=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 const early=await f.controller.cancel(first.assignment.id);
 assert.equal(early.jobs![0].state,'CANCEL_ACKNOWLEDGED');
 assert.equal(early.jobs![0].evidence,'OFFICE_LOCAL');
 assert.equal(f.adapter.cancels,0,'nothing was submitted, so no provider call is needed');
 assert.equal(early.requests![0].status,'CANCELED');
});

test('a late completion after a cancellation request stays with the old job',async t=>{
 const adapter=new FakeAdapter({cancel:async()=>({acknowledged:false,detail:'No route.'}),
  observe:async()=>({state:'COMPLETED',detail:'It finished before the cancellation reached it.',outputs:[declare('late.json','abc')]})});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);
 await f.controller.cancel(assignment.id);
 const state=await f.controller.observe(assignment.id);
 assert.equal(state.jobs![0].state,'COMPLETED');
 assert.equal(state.jobs![0].outputs[0].path,'late.json');
 assert.equal(state.assignments!.length,1,'the late outcome belongs to the same assignment');
});

test('a restart during dispatch reconciles to Unknown and never resubmits or invents an outcome',async t=>{
 const adapter=new FakeAdapter();
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 // Simulate a crash between recording intent and hearing back from the provider.
 const job=f.store.snapshot().jobs![0];
 f.store.recordJobTransition({jobId:job.id,expectedRevision:job.revision,to:'SUBMITTING',evidence:'OFFICE_LOCAL',detail:'Submitting.'});
 const after=f.restart(adapter);
 const results=await after.controller.reconcile();
 assert.equal(results[0].action,'MARK_UNKNOWN');
 const state=after.store.snapshot();
 assert.equal(state.jobs![0].state,'UNKNOWN');
 assert.equal(adapter.submits,0,'a restart never resubmits work the provider may already have accepted');
 assert.equal(state.requests![0].status!=='CANCELED',true);
});

test('an account change or archived profile blocks dispatch of an already frozen assignment',async t=>{
 const f=await fixture(t);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 f.store.recordAccountObservation({...verifiedObservation(30),identity:'someone-else@example.com'});
 await assert.rejects(f.controller.dispatch(assignment.id),/blocked/i);
 assert.equal(f.store.snapshot().jobs![0].state,'INTENT','a blocked dispatch does not touch the job');
 assert.equal(f.adapter.submits,0);
});

test('unverified transport keeps automatic start blocked even with a frozen assignment',async t=>{
 const f=await fixture(t);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 // A newer tool version discards the earlier transport evidence.
 f.store.recordAccountObservation({...verifiedObservation(30),toolVersion:'9.9.9',transport:'NONE',environment:'',
  operations:[seen('ACCOUNT_STATUS',30),seen('MODEL_CATALOG',30)]});
 await assert.rejects(f.controller.dispatch(assignment.id),/Automatic start is blocked/);
 assert.equal(f.adapter.submits,0);
});

test('restart preserves undispatched preparation and explicit discard permits a fresh preparation',async t=>{
 const f=await fixture(t);
 const first=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 const restarted=f.restart();
 await restarted.controller.reconcile();
 assert.equal(restarted.store.snapshot().jobs![0].state,'INTENT');
 assert.equal(f.adapter.submits,0);
 restarted.controller.discardPreparation(first.assignment.id);
 assert.notEqual(restarted.store.snapshot().requests![0].status,'CANCELED');
 const next=restarted.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await restarted.controller.dispatch(next.assignment.id);
 assert.throws(()=>restarted.controller.discardPreparation(next.assignment.id),/Only undispatched/);
});

test('partial retrieval stays retryable across restart and does not settle on one successful file',async t=>{
 const one=declare('one.json','one'),two=declare('two.json','two');
 const bytes=OUTPUT_BYTES.get(two.sha256)!;
 OUTPUT_BYTES.delete(two.sha256);
 const adapter=new FakeAdapter({observe:async()=>({state:'COMPLETED',detail:'Two outputs ready.',outputs:[one,two]})});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);
 await assert.rejects(f.controller.observe(assignment.id),/entire reported inventory/);
 assert.equal(f.store.snapshot().jobs![0].state,'ACCEPTED');
 assert.equal(f.store.snapshot().jobs![0].outputs.length,0);
 assert.ok(f.store.snapshot().jobEvents?.some(item=>item.text.includes('not retrieved')));
 OUTPUT_BYTES.set(two.sha256,bytes);
 const next=f.restart();
 await next.controller.observe(assignment.id);
 assert.equal(next.store.snapshot().jobs![0].state,'COMPLETED');
 assert.equal(next.store.snapshot().jobs![0].outputs.length,2);
 assert.ok(next.store.snapshot().jobs![0].outputs.every(item=>item.stored));
 assert.equal(f.adapter.submits,1);
});

test('same-state output observations persist once and fetched bytes without a sink cannot settle work',async t=>{
 const output=declare('progress.txt','durable progress');
 const adapter=new FakeAdapter({observe:async()=>({state:'RUNNING',detail:'Progress.',outputs:[output]})});
 const f=await fixture(t,adapter);
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);
 await f.controller.observe(assignment.id);
 const revision=f.store.snapshot().jobs![0].revision;
 await f.controller.observe(assignment.id);
 assert.equal(f.store.snapshot().jobs![0].revision,revision);
 assert.equal(f.store.snapshot().jobs![0].outputs.length,1);
 adapter.behaviour.observe=async()=>({state:'COMPLETED',detail:'Done.',outputs:[output]});
 const noSink=new AssignmentController(f.store,adapter,()=>at(1),undefined,undefined,undefined,fetchOutput);
 await assert.rejects(noSink.observe(assignment.id),/durably stored/);
 assert.equal(f.store.snapshot().jobs![0].state,'RUNNING');
});

test('production output preflight reserves the selected destination before launch and blocks invalid output roots',async t=>{
 const f=await fixture(t);
 const outputs=new OutputService(f.store,f.root);
 const controller=new AssignmentController(f.store,f.adapter,()=>at(1),undefined,undefined,undefined,fetchOutput,outputs.storeBytes,outputs.prepare);
 const {assignment}=controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 const first=outputs.prepare(assignment,f.snapshot);
 assert.deepEqual(first,outputs.prepare(assignment,f.snapshot));
 assert.equal(f.adapter.submits,0);
 // A destination that became unusable after preview must be rechecked at launch.
 const results=path.join(f.root,'results');
 assert.equal(path.relative(f.root,results),'results');
 removeTreeSync(results);writeFileSync(results,'not a directory');
 await assert.rejects(controller.dispatch(assignment.id));
 assert.equal(f.adapter.submits,0);
 assert.equal(f.store.snapshot().jobs![0].state,'INTENT');
});

test('project export includes job provenance and byte objects without unrelated project records',async t=>{
 const output=declare('result.txt','project-specific output');
 const f=await fixture(t,new FakeAdapter({observe:async()=>({state:'COMPLETED',detail:'Done.',outputs:[output]})}));
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);await f.controller.observe(assignment.id);
 const other=f.store.execute({type:'project.create',idempotencyKey:key(),name:'Unrelated project',mandate:'private other mandate',budgetCents:0}).projects.find(p=>p.id!==f.project.id)!;
 const archive=path.join(f.root,'project.zip');await new ArtifactService(f.store,f.root).exportProject(f.project.id,archive);
 const files=unzipSync(readFileSync(archive)),project=JSON.parse(strFromU8(files['project.json']));
 assert.equal(project.assignments[0].id,assignment.id);
 assert.equal(project.jobs[0].outputs[0].stored,true);
 assert.equal(project.snapshots[0].id,f.snapshot.id);
 assert.equal(strFromU8(files['objects/'+output.sha256]),'project-specific output');
 assert.equal(project.approvals.length,0);
 assert.equal(strFromU8(files['project.json']).includes(other.id),false);
 assert.equal(strFromU8(files['project.json']).includes('private other mandate'),false);
});

for(const streamed of [false,true])test(`actual ${streamed?'streamed':'small'} backup restores snapshot and job bytes into a new root`,async t=>{
 const output=declare('result.json','{"value":42}');
 const f=await fixture(t,new FakeAdapter({observe:async()=>({state:'COMPLETED',detail:'Done.',outputs:[output]})}));
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.dispatch(assignment.id);await f.controller.observe(assignment.id);
 const archive=path.join(f.root,'backup.zip');
 const service=new ArtifactService(f.store,f.root,streamed?{maxEntries:2,maxTotalBytes:1,maxFileBytes:1}:undefined);
 await service.backup(archive);
 const restoredRoot=path.join(f.root,'restored');mkdirSync(workspaceDirectory(restoredRoot),{recursive:true});
 const prepared=await prepareRestore(archive,restoredRoot);await commitRestore(restoredRoot,prepared.transactionId);
 const restoredWorkspace=workspaceDirectory(restoredRoot);
 const restored=new OfficeStore(path.join(restoredWorkspace,'workspace.sqlite'));
 try{
  const state=restored.snapshot(),saved=state.snapshots!.find(item=>item.id===f.snapshot.id)!;
  assert.equal(saved.objectsStored,true);
  assert.equal(state.jobs![0].outputs[0].stored,true);
  assert.equal(readFileSync(snapshotObjectPath(restoredWorkspace,output.sha256),'utf8'),'{"value":42}');
  for(const target of [f.snapshot.stagingPath,path.join(f.root,'source')]){
   assert.ok(path.relative(f.root,target)&&!path.relative(f.root,target).startsWith('..'));
   removeTreeSync(target);
  }
  const rebuilt=await reconstructSnapshot({snapshot:saved,objectRoot:restoredWorkspace,stagingRoot:path.join(restoredWorkspace,'snapshots')});
  assert.deepEqual(rebuilt.problems,[]);
  assert.deepEqual(await verifySnapshotForTransfer({...saved,stagingPath:rebuilt.stagingPath},'git',path.join(restoredWorkspace,'snapshots')),[]);
  const outputs=new OutputService(restored,restoredWorkspace);
  const reservation=outputs.prepare(state.assignments![0],saved);
  assert.ok(reservation.path.startsWith(restoredWorkspace));
  await outputs.storeBytes(output.sha256,OUTPUT_BYTES.get(output.sha256)!,state.jobs![0],output);
  assert.equal(readFileSync(path.join(reservation.path,'files',output.sha256,output.path),'utf8'),'{"value":42}');
 }finally{restored.close();}
 rmSync(snapshotObjectPath(f.root,output.sha256));
 await assert.rejects(service.backup(path.join(f.root,'missing.zip')),/required stored object/);
});
