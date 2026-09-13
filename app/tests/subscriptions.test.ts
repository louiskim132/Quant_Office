import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Subscriptions,usageWindows,claudeIdentity,subscriptionEnvironment } from '../src/main/subscriptions.js';
import { OfficeStore } from '../src/core/store.js';
import type { AgentDraft,Connection } from '../src/shared/types.js';
const draft:AgentDraft={name:'Researcher',provider:'openai',model:'model-a',team:'Signals',role:'DIRECTOR',instructions:'Compare evidence independently.'};
function fixture(){
 const root=mkdtempSync(path.join(tmpdir(),'qro-subscriptions-'));
 const service=new Subscriptions(root,async()=>{throw new Error('No browser in this metadata fixture');});
 let account:Connection={provider:'openai',account:'research@example.test',connected:true,models:[{id:'model-a',name:'Model A'}],windows:[],checkedAt:new Date().toISOString(),note:''};
 service.status=async()=>structuredClone(account);
 return {root,service,setConnection:(value:Partial<Connection>)=>{account={...account,...value};}};
}
test('Add verifies but does not create an agent; Confirm saves once and retains exact choices',async()=>{
 const f=fixture(),store=new OfficeStore(path.join(f.root,'workspace.sqlite'));
 try{const project=store.execute({type:'project.create',idempotencyKey:randomUUID(),name:'Research',mandate:'',budgetCents:0}).projects[0];store.execute({type:'task.create',idempotencyKey:randomUUID(),projectId:project.id,experimentId:null,prompt:'Evaluate',recipient:'DIRECTOR'});const ticket=await f.service.connect(draft);assert.equal(store.snapshot().agents.length,0);await f.service.confirm(ticket.id,agent=>{store.addAgent(agent);});const agent=store.snapshot().agents[0];assert.equal(store.snapshot().tasks[0].blocker,'Provider-hosted execution is not configured');assert.equal(agent.model,'model-a');assert.equal(agent.team,'Signals');assert.equal(agent.execution,'HOSTED_SETUP_REQUIRED');await assert.rejects(f.service.confirm(ticket.id,agent=>store.addAgent(agent)),/expired/);assert.equal(store.snapshot().agents.length,1);}finally{store.close();f.service.close();}
});
test('cancel, expired confirmations and changed account or model fail closed',async()=>{
 const f=fixture();let saved=0;
 let ticket=await f.service.connect(draft);f.service.cancel();await assert.rejects(f.service.confirm(ticket.id,()=>saved++),/expired/);
 ticket=await f.service.connect(draft);f.setConnection({account:'other@example.test'});await assert.rejects(f.service.confirm(ticket.id,()=>saved++),/changed/);
 ticket=await f.service.connect(draft);f.setConnection({models:[]});await assert.rejects(f.service.confirm(ticket.id,()=>saved++),/Model access/);
 f.setConnection({models:[{id:'model-a',name:'Model A'}]});ticket=await f.service.connect(draft);
 const realNow=Date.now;Date.now=()=>ticket.expiresAt+1;try{await assert.rejects(f.service.confirm(ticket.id,()=>saved++),/expired/);}finally{Date.now=realNow;}
 assert.equal(saved,0);f.service.close();
});
test('unavailable OpenAI model cannot be silently substituted',async()=>{const f=fixture();await assert.rejects(f.service.connect({...draft,model:'other-model'}),/selected model/);f.service.close();});
test('unlimited same-role agents persist through restart with event verification',()=>{
 const f=fixture(),file=path.join(f.root,'workspace.sqlite');let store=new OfficeStore(file);
 for(let i=0;i<30;i++)store.addAgent({...draft,id:randomUUID(),name:'Director '+i,account:'shared@example.test',createdAt:new Date().toISOString(),connectionVerifiedAt:new Date().toISOString(),execution:'HOSTED_SETUP_REQUIRED'});
 assert.equal(store.snapshot().agents.length,30);store.close();store=new OfficeStore(file);try{assert.equal(store.snapshot().agents.length,30);assert.equal(store.snapshot().events.length,30);assert.throws(()=>store.execute({type:'agent.add',idempotencyKey:randomUUID(),...draft}));}finally{store.close();f.service.close();}
});
test('Claude identity accepts subscription metadata only, never Console or missing identity',()=>{
 assert.equal(claudeIdentity({loggedIn:true,authMethod:'claude.ai',subscriptionType:'max',email:'a@example.test'}),'a@example.test');
 for(const value of [{loggedIn:false},{loggedIn:true,authMethod:'api_key',subscriptionType:'max',email:'a@example.test'},{loggedIn:true,authMethod:'claude.ai',email:'a@example.test'}])assert.throws(()=>claudeIdentity(value),/subscription/);
});
test('usage uses actual window durations, clamps percentages and preserves unavailable values',()=>{
 assert.deepEqual(usageWindows({rateLimits:null}),[]);
 const windows=usageWindows({rateLimits:{primary:{usedPercent:35,windowDurationMins:300,resetsAt:1234},secondary:{usedPercent:110,windowDurationMins:10080,resetsAt:4567}}});
 assert.deepEqual(windows.map(w=>w.remainingPercent),[65,0]);assert.match(windows[0].label,/5 hour/);assert.match(windows[1].label,/Weekly/);assert.equal(windows[1].resetsAt,4567);
 assert.deepEqual(usageWindows({rateLimits:{primary:{usedPercent:null,windowDurationMins:300,resetsAt:1}}}),[]);
});
test('metadata child environment excludes API billing overrides',()=>{
 const original=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='test-placeholder';try{assert.equal(subscriptionEnvironment().ANTHROPIC_API_KEY,undefined);assert.equal(process.env.ANTHROPIC_API_KEY,'test-placeholder');}finally{if(original===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=original;}
});
