import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {AssignmentController} from '../src/main/controller';
import {TerminalHandoffAdapter,type LaunchRequest,type LaunchResult} from '../src/main/handoff';
import {prepareInputSnapshot} from '../src/main/locations';
import type {Agent,CapabilityEvidence,CapabilityOperation} from '../src/shared/types';

const key=()=>randomUUID();
const at=(minutes:number)=>new Date(Date.UTC(2026,8,8,11,0,0)+minutes*60000).toISOString();
const CLOUD:CapabilityOperation[]=['CLOUD_SUBMIT','CLOUD_OBSERVE','CLOUD_OUTPUT_FETCH','CLOUD_CANCEL_REQUEST','CLOUD_CANCEL_ACK','MODEL_APPLICATION','EFFORT_APPLICATION','ENVIRONMENT_IDENTITY','DELEGATION_CONTROL'];
const seen=(operation:CapabilityOperation,minutes:number,extra:Partial<CapabilityEvidence>={}):CapabilityEvidence=>({operation,level:'ACCOUNT_VERIFIED',detail:'Exercised.',evidence:'OBSERVED',verifiedAt:at(minutes),source:'fixture',...extra});
const unknown=(operation:CapabilityOperation,minutes:number):CapabilityEvidence=>({operation,level:'UNKNOWN',detail:'No supported route.',evidence:'DOCUMENTED',verifiedAt:at(minutes),source:'docs'});
/** Signed in and fresh, but hosted execution is unverified: the real situation today. */
const signedIn=(minutes:number)=>({provider:'claude' as const,identity:'researcher@example.com',credentialContext:'claude-code-cli',state:'SIGNED_IN' as const,allowance:[],note:'',
 toolVersion:'2.1.236',transport:'NONE' as const,environment:'',models:[{id:'opus',name:'Opus'}],
 operations:[seen('ACCOUNT_STATUS',minutes),...CLOUD.map(o=>unknown(o,minutes))],source:'claude auth status',observedAt:at(minutes)});

async function fixture(t:any,launch:(request:LaunchRequest)=>Promise<LaunchResult>){
 const root=mkdtempSync(path.join(tmpdir(),'qro-handoff-'));
 const store=new OfficeStore(path.join(root,'workspace.sqlite'));
 t.after(()=>{try{store.close();}catch{}removeTreeSync(root);});
 const project=store.execute({type:'project.create',idempotencyKey:key(),name:'Alpha',mandate:'m',budgetCents:0}).projects[0];
 const source=path.join(root,'source');mkdirSync(source);writeFileSync(path.join(source,'input.csv'),'a\n1\n');
 store.execute({type:'location.save',idempotencyKey:key(),projectId:project.id,expectedRevision:0,localFolder:source,inputPaths:['input.csv'],outputFolder:''});
 const agent:Agent={id:randomUUID(),name:'Sole worker',provider:'claude',model:'opus',team:'Research',role:'WORKER',instructions:'',
  account:'researcher@example.com',createdAt:at(0),connectionVerifiedAt:at(0),execution:'HOSTED_SETUP_REQUIRED'};
 store.confirmAgentBinding({observation:signedIn(0),agent});
 const request=store.execute({type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Tiny question',hypothesis:'Explain',workType:'QUESTION',mode:'SINGLE',leadAgentId:agent.id,participantIds:[]}).requests![0];
 const snapshot=await prepareInputSnapshot({store,stagingRoot:path.join(root,'staging'),projectId:project.id,requestId:request.id,requestRevision:request.revision});
 const calls:LaunchRequest[]=[];
 const adapter=new TerminalHandoffAdapter({executable:()=>'C:/Users/example/.local/bin/claude.exe',launch:async request=>{calls.push(request);return launch(request);}});
 // One injected clock, held just inside the account-freshness window, so a run's result never
 // depends on the calendar date the suite happens to execute on.
 let tick=0;
 const clock=()=>at(++tick/60);
 const controller=new AssignmentController(store,adapter,clock);
 return {root,store,controller,adapter,agent,request,snapshot,project,calls};
}

test('the handoff shows the exact official cloud command from the staged directory',async t=>{
 const f=await fixture(t,async()=>({launched:true,detail:'opened'}));
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 const plan=f.controller.handoffPlan(assignment.id)!;
 assert.equal(plan.cwd,f.snapshot.stagingPath,'the command runs in the prepared snapshot, never in the user folder');
 assert.deepEqual(plan.args,['--cloud','Tiny question']);
 assert.equal(plan.args.includes('--teleport'),false);
 assert.equal(plan.args.some(a=>a.startsWith('--environment')),false,'self-hosted routing is never used');
 assert.equal(f.calls.length,0,'showing the plan launches nothing');
});

test('preparation alone creates no provider job state and transfers nothing',async t=>{
 const f=await fixture(t,async()=>({launched:true,detail:'opened'}));
 const {state,assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 assert.equal(state.jobs![0].state,'INTENT');
 assert.equal(state.jobs![0].externalId,'');
 assert.equal(f.calls.length,0);
 assert.equal(state.assignments![0].id,assignment.id);
 assert.equal(state.assignments![0].route,'OFFICIAL_TERMINAL_HANDOFF');
});

test('opening the terminal records a handoff, never an accepted submission',async t=>{
 const f=await fixture(t,async()=>({launched:true,detail:'The official Claude terminal was opened in the prepared snapshot directory.'}));
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 const state=await f.controller.handoff(assignment.id);
 const job=state.jobs![0];
 assert.equal(job.state,'UNKNOWN','a launched terminal is not a submission');
 assert.equal(job.evidence,'OFFICE_LOCAL');
 assert.equal(job.externalId,'');
 assert.match(job.detail,/cannot see whether a session was created/);
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].cwd,f.snapshot.stagingPath);
});

test('a launcher failure is recorded as unknown and never as "not submitted"',async t=>{
 const f=await fixture(t,async()=>({launched:false,detail:'The official terminal could not be opened: spawn failed.'}));
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 const state=await f.controller.handoff(assignment.id);
 assert.equal(state.jobs![0].state,'UNKNOWN');
 assert.match(state.jobs![0].detail,/could not be completed/);
});

test('a user-reported session links for reconciliation but settles nothing',async t=>{
 const f=await fixture(t,async()=>({launched:true,detail:'opened'}));
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.handoff(assignment.id);
 const state=f.controller.link(assignment.id,'session_01Aj1hpgmeoZLdgYVR9eQ6PB','https://claude.ai/code/session_01Aj1hpgmeoZLdgYVR9eQ6PB');
 const job=state.jobs![0];
 assert.equal(job.externalId,'session_01Aj1hpgmeoZLdgYVR9eQ6PB');
 assert.equal(job.evidence,'USER_REPORTED');
 assert.equal(job.state,'UNKNOWN','your report is a hint to reconcile, not an outcome');
 assert.equal(job.outputs.length,0);
 assert.ok(state.events.some(e=>e.kind==='PROVIDER_JOB_LINK_USER_REPORTED'));
 assert.throws(()=>f.store.recordJobTransition({jobId:job.id,expectedRevision:job.revision,to:'COMPLETED',evidence:'USER_REPORTED',detail:'It looked done to me',outputs:[{path:'x',sha256:'a'.repeat(64),bytes:1}]}),/needs a provider observation/);
});

test('a linked session must be an official provider URL',async t=>{
 const f=await fixture(t,async()=>({launched:true,detail:'opened'}));
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.handoff(assignment.id);
 assert.throws(()=>f.controller.link(assignment.id,'session_x','https://example.invalid/session_x'),/official provider session URL/);
 assert.throws(()=>f.controller.link(assignment.id,'','https://claude.ai/code/session_x'));
});

test('the handoff route reports no observation or cancellation it cannot perform',async t=>{
 const f=await fixture(t,async()=>({launched:true,detail:'opened'}));
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await f.controller.handoff(assignment.id);
 const observed=await f.controller.observe(assignment.id);
 assert.equal(observed.jobs![0].state,'UNKNOWN');
 const canceled=await f.controller.cancel(assignment.id);
 assert.equal(canceled.jobs![0].state,'CANCEL_REQUESTED','without an acknowledgement the office does not claim cancellation');
 assert.ok(canceled.jobEvents!.some(e=>e.text.includes('not acknowledged')));
 assert.notEqual(canceled.requests![0].status,'CANCELED','the request is not closed while provider work may still exist');
});

test('automatic start stays blocked on this route even after a successful handoff',async t=>{
 const f=await fixture(t,async()=>({launched:true,detail:'opened'}));
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:f.snapshot.id});
 await assert.rejects(f.controller.dispatch(assignment.id),/Automatic start is blocked/);
 assert.equal(f.calls.length,0,'a blocked automatic start launches nothing');
});

test('a snapshot without a commit cannot be handed off',async t=>{
 const f=await fixture(t,async()=>({launched:true,detail:'opened'}));
 const root=mkdtempSync(path.join(tmpdir(),'qro-handoff-nogit-'));
 t.after(()=>removeTreeSync(root));
 const noCommit=await prepareInputSnapshot({store:f.store,stagingRoot:root,projectId:f.project.id,requestId:f.request.id,requestRevision:f.request.revision,gitExecutable:path.join(root,'missing-git.exe')});
 assert.equal(noCommit.stagingCommit,'');
 const {assignment}=f.controller.prepare({requestId:f.request.id,agentId:f.agent.id,snapshotId:noCommit.id});
 assert.throws(()=>f.controller.handoffPlan(assignment.id),/no commit/);
 // Local preflight runs before the job is marked as being submitted. Nothing was launched, so the
 // work stays prepared and retryable instead of becoming an Unknown that implies the provider may
 // have seen something.
 await assert.rejects(f.controller.handoff(assignment.id),/still prepared/);
 const state=f.store.snapshot();
 assert.equal(state.jobs![0].state,'INTENT','a preflight refusal leaves the job exactly as it was');
 assert.equal(f.calls.length,0,'nothing is launched when the snapshot cannot support the route');
});
