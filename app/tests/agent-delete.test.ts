import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {removeTreeSync} from '../src/main/fsx';
import {AssignmentController,type ObserveResult,type ProviderAdapter,type SubmitContext} from '../src/main/controller';
import {prepareInputSnapshot} from '../src/main/locations';
import type {Agent,CapabilityEvidence,CapabilityOperation,ProviderJob} from '../src/shared/types';

/**
 * agent.delete mirrors project.delete: removal hides an archived profile from pickers and
 * lists while the record, its memberships and assignments, and every lineage event stay
 * intact. Archiving alone never hides — a removed agent stays reachable through the Removed
 * membership filter and restores into the archived list, not active.
 */
const key=()=>randomUUID();
const base=Date.UTC(2026,8,16,16,0,0);
const at=(minutes:number)=>new Date(base+minutes*60000).toISOString();
const ROUTES=['FAKE_ADAPTER','OFFICIAL_TERMINAL_HANDOFF','OFFICIAL_CLI_PTY'] as const;
const CLOUD:CapabilityOperation[]=['CLOUD_SUBMIT','CLOUD_OBSERVE','CLOUD_OUTPUT_FETCH','CLOUD_CANCEL_REQUEST','CLOUD_CANCEL_ACK','MODEL_APPLICATION','EFFORT_APPLICATION','ENVIRONMENT_IDENTITY','DELEGATION_CONTROL','TOOL_CONFINEMENT'];
const seen=(operation:CapabilityOperation,minutes:number,extra:Partial<CapabilityEvidence>={}):CapabilityEvidence=>({operation,level:'ACCOUNT_VERIFIED',detail:'Exercised.',evidence:'OBSERVED',verifiedAt:at(minutes),source:'fixture',...extra});
const verified=(minutes:number)=>({provider:'claude' as const,identity:'researcher@example.com',credentialContext:'claude-code-cli',state:'SIGNED_IN' as const,allowance:[],note:'',
 toolVersion:'2.1.236',transport:'OFFICIAL_CLI_TERMINAL' as const,environment:'anthropic-managed',models:[{id:'opus',name:'Opus'}],
 operations:[seen('ACCOUNT_STATUS',minutes),seen('MODEL_CATALOG',minutes),...CLOUD.flatMap(o=>ROUTES.flatMap(route=>o==='DELEGATION_CONTROL'?[seen(o,minutes,{model:'opus',route,delegation:false}),seen(o,minutes,{model:'opus',route,delegation:true})]:o==='EFFORT_APPLICATION'?[seen(o,minutes,{model:'opus',route,effort:'default'})]:o==='TOOL_CONFINEMENT'?[seen(o,minutes,{model:'opus',route,confinement:{tools:'Only the read-only fixture tools were offered.',filesystem:'Confined to the staged snapshot directory.',network:'No outbound network was reachable from the session.',environment:'anthropic-managed'}})]:[seen(o,minutes,{model:'opus',route})]))],source:'fixture',observedAt:at(minutes)});
const agent=(name:string):Agent=>({id:randomUUID(),name,provider:'claude',model:'opus',team:'Research',role:'WORKER',instructions:'',
 account:'researcher@example.com',createdAt:at(0),connectionVerifiedAt:at(0),execution:'HOSTED_SETUP_REQUIRED'});

class Adapter implements ProviderAdapter {
 readonly route='FAKE_ADAPTER' as const;
 async submit(context:SubmitContext){return {externalId:'session_'+context.assignment.id.slice(0,10).replace(/-/g,''),externalUrl:'',detail:'accepted'};}
 async observe(_job:ProviderJob):Promise<ObserveResult>{return {state:'RUNNING',detail:'working'};}
 async cancel(_job:ProviderJob){return {acknowledged:true,detail:'ok'};}
}

test('only an existing archived agent can be removed',()=>{
 const store=new OfficeStore(':memory:');try{
 const profile=agent('Active');store.confirmAgentBinding({observation:verified(0),agent:profile});
 assert.throws(()=>store.execute({type:'agent.delete',idempotencyKey:key(),agentId:profile.id}),/Archive the agent before removing/);
 assert.throws(()=>store.execute({type:'agent.delete',idempotencyKey:key(),agentId:randomUUID()}),/not found/i);
 }finally{store.close();}
});

test('removal retains the profile and the recorded history',()=>{
 const store=new OfficeStore(':memory:');try{
 const profile=agent('Study');store.confirmAgentBinding({observation:verified(0),agent:profile});
 store.execute({type:'agent.remove',idempotencyKey:key(),agentId:profile.id,removed:true});
 const removed=store.execute({type:'agent.delete',idempotencyKey:key(),agentId:profile.id});
 const row=removed.agents.find(a=>a.id===profile.id)!;
 assert.ok(row.deletedAt,'the agent row stays and carries the removal timestamp');
 assert.ok(row.removedAt,'removal keeps the archived flag — it does not reactivate');
 const history=store.historyPage({limit:100});
 for(const kind of ['AGENT_REMOVE','AGENT_DELETE'])
  assert.ok(history.entries.some(e=>e.kind===kind),`${kind} stays in history`);
 assert.throws(()=>store.execute({type:'agent.delete',idempotencyKey:key(),agentId:profile.id}),/already removed/);
 assert.throws(()=>store.execute({type:'agent.remove',idempotencyKey:key(),agentId:profile.id,removed:true}),/Restore this agent/);
 }finally{store.close();}
});

test('restoring a removed agent clears the removal and lands it in the archived list',()=>{
 const store=new OfficeStore(':memory:');try{
 const profile=agent('Recoverable');store.confirmAgentBinding({observation:verified(0),agent:profile});
 store.execute({type:'agent.remove',idempotencyKey:key(),agentId:profile.id,removed:true});
 store.execute({type:'agent.delete',idempotencyKey:key(),agentId:profile.id});
 assert.ok(store.snapshot().agents[0].deletedAt);
 const restored=store.execute({type:'agent.remove',idempotencyKey:key(),agentId:profile.id,removed:false});
 const row=restored.agents.find(a=>a.id===profile.id)!;
 assert.equal(row.deletedAt,undefined,'restore clears the removal flag');
 assert.ok(row.removedAt,'a mistaken remove lands back in the archived list, not active');
 const reactivated=store.execute({type:'agent.remove',idempotencyKey:key(),agentId:profile.id,removed:false});
 assert.equal(reactivated.agents.find(a=>a.id===profile.id)!.removedAt,undefined,'a second restore reactivates');
 }finally{store.close();}
});

test('removing the last agent never touches the recorded connection',()=>{
 const store=new OfficeStore(':memory:');try{
 const profile=agent('Solo');store.confirmAgentBinding({observation:verified(0),agent:profile});
 const before=store.snapshot().connections;
 assert.ok(before?.length,'the binding fixture records a connection');
 store.execute({type:'agent.remove',idempotencyKey:key(),agentId:profile.id,removed:true});
 const removed=store.execute({type:'agent.delete',idempotencyKey:key(),agentId:profile.id});
 assert.deepEqual(removed.connections,before,'archiving and removing an agent leave connection records byte-identical');
 assert.deepEqual(store.snapshot().connections,before);
 }finally{store.close();}
});

test('an archived agent whose assignment carries an unresolved provider job cannot be removed',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'qro-agent-delete-'));
 const store=new OfficeStore(path.join(root,'workspace.sqlite'));
 t.after(()=>{try{store.close();}catch{}removeTreeSync(root);});
 const project=store.execute({type:'project.create',idempotencyKey:key(),name:'Live work',mandate:'m',budgetCents:0}).projects[0];
 const source=path.join(root,'source');mkdirSync(source);writeFileSync(path.join(source,'input.csv'),'a\n1\n');
 store.execute({type:'location.save',idempotencyKey:key(),projectId:project.id,expectedRevision:0,localFolder:source,inputPaths:['input.csv'],outputFolder:''});
 const profile=agent('Worker');store.confirmAgentBinding({observation:verified(0),agent:profile});
 const request=store.execute({type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Alpha question',hypothesis:'Explain alpha',workType:'QUESTION',mode:'SINGLE',leadAgentId:profile.id,participantIds:[]}).requests!.find(r=>r.projectId===project.id)!;
 const snapshot=await prepareInputSnapshot({store,stagingRoot:path.join(root,'staging'),projectId:project.id,requestId:request.id,requestRevision:request.revision});
 let tick=0;const clock=()=>at(++tick/60);
 const controller=new AssignmentController(store,new Adapter(),clock);
 const {assignment}=controller.prepare({requestId:request.id,agentId:profile.id,snapshotId:snapshot.id});
 await controller.dispatch(assignment.id);
 assert.equal(store.snapshot().jobs![0].state,'ACCEPTED','the provider accepted the work; its outcome is unresolved');
 store.execute({type:'request.cancel',idempotencyKey:key(),requestId:request.id,expectedRevision:request.revision});
 store.execute({type:'agent.remove',idempotencyKey:key(),agentId:profile.id,removed:true});
 assert.throws(()=>store.execute({type:'agent.delete',idempotencyKey:key(),agentId:profile.id}),/unresolved/);
 assert.equal(store.snapshot().agents.find(a=>a.id===profile.id)!.deletedAt,undefined,'the refused removal leaves the row untouched');
});
