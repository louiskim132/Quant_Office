import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Subscriptions,usageWindows,claudeIdentity,devinStatusIdentity,subscriptionEnvironment } from '../src/main/subscriptions.js';
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
test('a Codex catalog failure keeps the verified account and reports the catalog as unavailable',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'qro-subscriptions-'));
 const service=new Subscriptions(root,async()=>{throw new Error('No browser in this metadata fixture');});
 const calls:string[]=[];
 (service as any).codex={async request(method:string){calls.push(method);if(method==='account/read')return {account:{type:'chatgpt',email:'research@example.test'}};if(method==='model/list')throw new Error('catalog exploded');if(method==='account/rateLimits/read')return {rateLimits:{primary:{usedPercent:40,windowDurationMins:300,resetsAt:9999}}};throw new Error('Unexpected '+method);},stop(){}};
 try{
  const connection=await service.status('openai');
  assert.equal(connection.connected,true);assert.equal(connection.account,'research@example.test');
  assert.deepEqual(connection.models,[]);
  assert.match(connection.note,/Codex model catalog unavailable\. Refresh to retry\./);
  assert.equal(connection.windows.length,1);
  assert.deepEqual(calls,['account/read','model/list','account/rateLimits/read']);
 }finally{service.close();}
});
test('a repeated catalog cursor degrades mid-pagination rather than shipping a truncated catalog',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'qro-subscriptions-'));
 const service=new Subscriptions(root,async()=>{throw new Error('No browser in this metadata fixture');});
 let pages=0;
 (service as any).codex={async request(method:string){if(method==='account/read')return {account:{type:'chatgpt',email:'research@example.test'}};if(method==='model/list')return {data:[{id:'model-'+(++pages),displayName:'Model '+pages}],nextCursor:'same-cursor'};if(method==='account/rateLimits/read')return {rateLimits:{}};throw new Error('Unexpected '+method);},stop(){}};
 try{
  const connection=await service.status('openai');
  assert.equal(connection.connected,true);
  assert.equal(pages,2);
  assert.deepEqual(connection.models,[]);
  assert.match(connection.note,/Codex model catalog unavailable\. Refresh to retry\./);
 }finally{service.close();}
});
test('signIn refuses a concurrent sign-in and resolves to the verified connection',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'qro-subscriptions-'));
 const service=new Subscriptions(root,async()=>{});
 (service as any).codex={async request(method:string){await new Promise(resolve=>setTimeout(resolve,25));if(method==='account/read')return {account:{type:'chatgpt',email:'research@example.test'}};if(method==='model/list')return {data:[{id:'model-a',displayName:'Model A'}],nextCursor:null};if(method==='account/rateLimits/read')return {rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:9999}}};throw new Error('Unexpected '+method);},stop(){}};
 try{
  const first=service.signIn('openai');
  await assert.rejects(service.signIn('openai'),/already in progress/);
  const connection=await first;
  assert.equal(connection.provider,'openai');assert.equal(connection.connected,true);assert.equal(connection.account,'research@example.test');
  assert.ok(connection.models.some(m=>m.id==='model-a'));assert.ok(Date.parse(connection.checkedAt));
 }finally{service.close();}
});
test('signIn runs the official browser flow and returns the account verified afterwards',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'qro-subscriptions-'));
 let opened='',signedIn=false;
 const service=new Subscriptions(root,async url=>{opened=url;signedIn=true;});
 (service as any).codex={async request(method:string){if(method==='account/read')return signedIn?{account:{type:'chatgpt',email:'signedin@example.test'}}:{account:{type:'apiKey',email:'api@example.test'}};if(method==='account/login/start')return {loginId:'login-1',authUrl:'https://auth.openai.com/device'};if(method==='account/login/cancel')return {};if(method==='model/list')return {data:[{id:'model-a',displayName:'Model A'}],nextCursor:null};if(method==='account/rateLimits/read')return {rateLimits:{}};throw new Error('Unexpected '+method);},stop(){}};
 try{
  const connection=await service.signIn('openai');
  assert.equal(opened,'https://auth.openai.com/device');
  assert.equal(connection.connected,true);assert.equal(connection.account,'signedin@example.test');
 }finally{service.close();}
});
test('a canceled sign-in rejects honestly and leaves the gate free for a later attempt',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'qro-subscriptions-'));
 const service=new Subscriptions(root,async()=>{});
 (service as any).codex={async request(method:string){await new Promise(resolve=>setTimeout(resolve,25));if(method==='account/read')return {account:{type:'chatgpt',email:'research@example.test'}};if(method==='model/list')return {data:[],nextCursor:null};if(method==='account/rateLimits/read')return {rateLimits:{}};throw new Error('Unexpected '+method);},stop(){}};
 try{
  const pending=service.signIn('openai');
  service.cancel();
  await assert.rejects(pending,/canceled/i);
  const connection=await service.signIn('openai');
  assert.equal(connection.connected,true);assert.equal(connection.account,'research@example.test');
 }finally{service.close();}
});
test('metadata child environment excludes API billing overrides',()=>{
 const original=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='test-placeholder';try{assert.equal(subscriptionEnvironment().ANTHROPIC_API_KEY,undefined);assert.equal(process.env.ANTHROPIC_API_KEY,'test-placeholder');}finally{if(original===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=original;}
});
test('Devin auth status yields the account email or an empty identity, never a status phrase',()=>{
 const full='Logged in (via Devin).\n\nCredentials:\n  File:              C:\cred.toml\n\nUser:\n  Name:              someone\n  Email:             louisnn80@gmail.com\n  User ID:           user-1\n';
 assert.equal(devinStatusIdentity(full),'louisnn80@gmail.com','the labeled User/Email field is the account');
 assert.equal(devinStatusIdentity('Logged in as louisnn80@gmail.com'),'louisnn80@gmail.com','an inline email still identifies the account');
 assert.equal(devinStatusIdentity('Logged in (via Devin).\n\nCredentials:\n  File:              C:\cred.toml\n'),'','a truncated report is unidentified, not an account named after a status line');
 assert.equal(devinStatusIdentity('Not logged in.'),'');
});
test('a signed-in but unidentified session cannot mint a binding ticket',async()=>{
 const f=fixture();
 f.setConnection({provider:'devin',connected:true,account:'',models:[{id:'swe-2-max',name:'SWE-2 Max'}]});
 await assert.rejects(f.service.connect({...draft,provider:'devin',model:'swe-2-max'}),/unidentified session/);
 f.service.close();
});
test('a negative account read re-checks on a fresh process when auth.json moved, but never while a login listener lives',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'qro-subscriptions-'));
 const codexHome=mkdtempSync(path.join(tmpdir(),'qro-codex-home-'));
 const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=codexHome;
 const service=new Subscriptions(root,async()=>{throw new Error('No browser in this metadata fixture');});
 writeFileSync(path.join(root,'codex.exe'),'not an executable');
 (service as any).paths={openai:path.join(root,'codex.exe')};
 let stopped=0;
 (service as any).codex={request:async()=>({account:{type:'apikey'}}),stop(){stopped++;},spawnedAt:Date.now()-60_000};
 try{
  // No auth evidence on disk yet: the in-process answer stands on its own.
  const first=await service.status('openai');
  assert.equal(first.connected,false);assert.equal(stopped,0,'no newer auth file — the process answer stands');
  // A login listener in flight suppresses recycling even with newer auth evidence on disk.
  writeFileSync(path.join(codexHome,'auth.json'),'{}');
  (service as any).loginId='login-1';
  const during=await service.status('openai');
  assert.equal(during.connected,false);assert.equal(stopped,0,'no recycle while a login is in flight');
  // No login + newer auth.json: the negative is verified against a fresh process before it
  // counts. The respawn of the bogus executable fails here, which proves the recycle ran.
  (service as any).loginId=undefined;
  await assert.rejects(service.status('openai'));
  assert.equal(stopped,1,'the provably stale client was recycled exactly once');
 }finally{service.close();if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
});
test('a completed browser login is detected from the auth file write, verified on a probe before the listener is retired',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'qro-subscriptions-'));
 const codexHome=mkdtempSync(path.join(tmpdir(),'qro-codex-home-'));
 const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=codexHome;
 const service=new Subscriptions(root,async()=>{writeFileSync(path.join(codexHome,'auth.json'),'{"tokens":{}}');});
 let stopped=0,probed=0,probeStopped=0;
 // The login-owning client serves its pre-login snapshot forever — account stays null.
 (service as any).codex={async request(method:string){if(method==='account/read')return {account:null};if(method==='account/login/start')return {loginId:'login-1',authUrl:'https://auth.openai.com/device'};if(method==='account/login/cancel')return {};throw new Error('Unexpected '+method);},stop(){stopped++;}};
 // The probe that reads the post-callback auth state is injected through spawnCodex.
 (service as any).spawnCodex=()=>({async request(method:string){probed++;if(method==='account/read')return {account:{type:'chatgpt',email:'fresh@example.test'}};if(method==='model/list')return {data:[{id:'model-a',displayName:'Model A'}],nextCursor:null};if(method==='account/rateLimits/read')return {rateLimits:{}};throw new Error('Unexpected '+method);},stop(){probeStopped++;}});
 try{
  const connection=await service.signIn('openai');
  assert.equal(connection.connected,true);assert.equal(connection.account,'fresh@example.test');
  assert.ok(probed>0,'a fresh process verified the auth write');
  assert.equal(stopped,1,'the stale login-owning client was retired once, after the probe verified');
  assert.equal(probeStopped,0,'the verified probe was adopted, not discarded');
 }finally{service.close();if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
});
