import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {agentDispatchReadiness} from '../src/shared/readiness';
import type {Agent,CapabilityEvidence,CapabilityOperation,Provider} from '../src/shared/types';

function fixture(t:any){const file=path.join(mkdtempSync(path.join(tmpdir(),'qro-agent-model-')),'workspace.sqlite');const store=new OfficeStore(file);t.after(()=>store.close());return {store};}
const at=(minutes:number)=>new Date(Date.UTC(2026,8,15,9,0,0)+minutes*60000).toISOString();
const ROUTES=['FAKE_ADAPTER','OFFICIAL_TERMINAL_HANDOFF','OFFICIAL_CLI_PTY'] as const;
const CLOUD:CapabilityOperation[]=['CLOUD_SUBMIT','CLOUD_OBSERVE','CLOUD_OUTPUT_FETCH','CLOUD_CANCEL_REQUEST','CLOUD_CANCEL_ACK','MODEL_APPLICATION','EFFORT_APPLICATION','ENVIRONMENT_IDENTITY','DELEGATION_CONTROL','TOOL_CONFINEMENT'];
const seen=(operation:CapabilityOperation,minutes:number,extra:Partial<CapabilityEvidence>={}):CapabilityEvidence=>({operation,level:'ACCOUNT_VERIFIED',detail:'Exercised.',evidence:'OBSERVED',verifiedAt:at(minutes),source:'fixture',...extra});
const unknown=(operation:CapabilityOperation,minutes:number):CapabilityEvidence=>({operation,level:'UNKNOWN',detail:'No supported route established.',evidence:'DOCUMENTED',verifiedAt:at(minutes),source:'docs'});
function observation(minutes:number,overrides:Record<string,unknown>={}){
 return {provider:'claude' as Provider,identity:'researcher@example.com',credentialContext:'claude-code-cli',state:'SIGNED_IN' as const,allowance:[],note:'',
  toolVersion:'2.1.236',transport:'NONE' as const,environment:'',models:[{id:'opus',name:'Opus'}],
  operations:[seen('ACCOUNT_STATUS',minutes),...CLOUD.map(o=>unknown(o,minutes))],source:'fixture',observedAt:at(minutes),...overrides};
}
const draft=(overrides:Partial<Agent>={}):Agent=>({id:randomUUID(),name:'Sole worker',provider:'claude',model:'opus',team:'Research',role:'WORKER',instructions:'',
 account:'researcher@example.com',createdAt:at(0),connectionVerifiedAt:at(0),execution:'HOSTED_SETUP_REQUIRED',...overrides});

test('a model change bumps the revision, names both models and leaves the rest of the profile untouched',t=>{
 const {store}=fixture(t);const agent=draft();
 store.addAgent(agent);
 store.setAgentEffort(agent.id,'high','default');
 const before=store.snapshot().agents[0];
 const changed=store.setAgentModel(agent.id,'sonnet','opus');
 const after=changed.agents[0];
 assert.equal(after.model,'sonnet');
 assert.equal(after.revision,(before.revision??0)+1,'one profile revision per accepted change');
 const events=changed.events.filter(e=>e.kind==='AGENT_MODEL_CHANGED');
 assert.equal(events.length,1);
 assert.ok(events[0].reason.includes('opus')&&events[0].reason.includes('sonnet'),'the event reason names both models');
 assert.equal(after.effort,'high','effort is not reset by a model change');
 const {model:_m,revision:_r,...rest}=after;const {model:_om,revision:_or,...base}=before;
 assert.deepEqual(rest,base,'account, binding, team, role and instructions are all unchanged');
});

test('stale, missing, archived and empty model writes are each refused at their own check',t=>{
 const {store}=fixture(t);const agent=draft();
 store.addAgent(agent);
 assert.throws(()=>store.setAgentModel(agent.id,'sonnet','haiku'),/another view/);
 assert.throws(()=>store.setAgentModel(randomUUID(),'sonnet','opus'),/not found/);
 assert.throws(()=>store.setAgentModel(agent.id,'','opus'),'an empty model is rejected by schema validation');
 assert.throws(()=>store.setAgentModel(agent.id,'   ','opus'),'a whitespace-only model trims to empty and is rejected');
 store.execute({type:'agent.remove',idempotencyKey:randomUUID(),agentId:agent.id,removed:true});
 assert.throws(()=>store.setAgentModel(agent.id,'sonnet','opus'),/Restore/);
 assert.equal(store.snapshot().agents[0].model,'opus');
 assert.equal(store.snapshot().events.some(e=>e.kind==='AGENT_MODEL_CHANGED'),false,'no refused write records a change');
});

test('a same-model save is accepted without writing an event',t=>{
 const {store}=fixture(t);const agent=draft();
 store.addAgent(agent);
 const before=store.snapshot();
 store.setAgentModel(agent.id,'opus','opus');
 const after=store.snapshot();
 assert.equal(after.agents[0].model,'opus');
 assert.equal(after.agents[0].revision,undefined,'a no-op does not advance the profile');
 assert.equal(after.events.length,before.events.length,'no history event is written');
 assert.equal(after.events.some(e=>e.kind==='AGENT_MODEL_CHANGED'),false);
});

test('dispatch readiness re-derives under the new model; evidence recorded under the old model does not transfer',t=>{
 const {store}=fixture(t);const agent=draft();
 store.confirmAgentBinding({observation:observation(0),agent});
 const verified=store.recordAccountObservation(observation(10,{
  transport:'OFFICIAL_CLI_TERMINAL',environment:'anthropic-managed',
  operations:[seen('ACCOUNT_STATUS',10),seen('MODEL_CATALOG',10),...CLOUD.flatMap(o=>ROUTES.flatMap(route=>o==='DELEGATION_CONTROL'?[seen(o,10,{model:'opus',route,delegation:false}),seen(o,10,{model:'opus',route,delegation:true})]:o==='EFFORT_APPLICATION'?[seen(o,10,{model:'opus',route,effort:'default'})]:o==='TOOL_CONFINEMENT'?[seen(o,10,{model:'opus',route,confinement:{tools:'Only the read-only fixture tools were offered.',filesystem:'Confined to the staged snapshot directory.',network:'No outbound network was reachable from the session.',environment:'anthropic-managed'}})]:[seen(o,10,{model:'opus',route})]))]}));
 const bound=verified.agents[0];
 assert.equal(agentDispatchReadiness(verified,bound,{now:Date.parse(at(11))}).canStart,true,'the recorded scope supports dispatch under opus');
 const changed=store.setAgentModel(agent.id,'sonnet','opus');
 const moved=changed.agents[0];
 const gate=agentDispatchReadiness(changed,moved,{now:Date.parse(at(11))});
 assert.equal(gate.binding.available,true,'the binding is independent of the model');
 assert.equal(gate.canHandoff,true,'a labelled handoff still only needs the live account');
 assert.equal(gate.readiness.modelChecked,false);
 assert.equal(gate.canStart,false,'opus-scoped transport evidence does not answer for sonnet');
 assert.ok(gate.blockers.some(b=>b.includes('sonnet')));
});
