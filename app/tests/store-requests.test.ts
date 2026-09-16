import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {removeTreeSync} from '../src/main/fsx';
import type {Agent,Provider} from '../src/shared/types';

/**
 * request.start names CLOUD_TRANSPORT_UNVERIFIED only for work that could reach a hosted route.
 * An all-local selection is gated by local evidence instead, so recording the cloud warning there
 * would tell the user to fix a route they never asked for. Dispatch evidence itself stays covered
 * by the readiness and local-agent suites; these cases pin which blocker the store records.
 */
const key=()=>randomUUID();
const at=(minutes:number)=>new Date(Date.UTC(2026,8,16,9,0,0)+minutes*60000).toISOString();
function fixture(t:any){
 const root=mkdtempSync(path.join(tmpdir(),'qro-store-requests-'));
 const store=new OfficeStore(path.join(root,'workspace.sqlite'));
 t.after(()=>{store.close();removeTreeSync(root);});
 const project=store.execute({type:'project.create',idempotencyKey:key(),name:'Alpha study',mandate:'Test',budgetCents:0}).projects[0];
 return {store,project};
}
const observation=(minutes:number)=>({provider:'claude' as Provider,identity:'researcher@example.com',credentialContext:'claude-code-cli',state:'SIGNED_IN' as const,allowance:[],note:'',
 toolVersion:'2.1.273',transport:'NONE' as const,environment:'',models:[{id:'opus',name:'Opus'}],operations:[],source:'request-start fixture',observedAt:at(minutes)});
const agent=(name:string,execution:Agent['execution'],minutes:number):Agent=>({id:randomUUID(),name,provider:'claude',model:'opus',team:'Research',role:'WORKER',instructions:'',
 effort:'default',account:'researcher@example.com',createdAt:at(minutes),connectionVerifiedAt:at(minutes),execution});
const start=(f:ReturnType<typeof fixture>,requestId:string,revision:number)=>
 f.store.execute({type:'request.start',idempotencyKey:key(),requestId,expectedRevision:revision}).requests!.find(r=>r.id===requestId)!;

test('an all-local selection starts without the cloud-transport warning',t=>{
 const f=fixture(t);
 const local=agent('Local worker','LOCAL',0);
 f.store.confirmAgentBinding({observation:observation(0),agent:local});
 const request=f.store.execute({type:'request.create',idempotencyKey:key(),projectId:f.project.id,name:'Local pass',
  hypothesis:'Sort the office notes',workType:'QUESTION',mode:'SINGLE',leadAgentId:local.id,participantIds:[]}).requests![0];
 const started=start(f,request.id,request.revision);
 assert.equal(started.status,'READY');
 assert.deepEqual(started.blockers.map(b=>b.code),[],'no hosted route is named, so no cloud warning is recorded');
});

test('a hosted participant still records the cloud-transport warning',t=>{
 const f=fixture(t);
 const local=agent('Local worker','LOCAL',0);
 const hosted=agent('Hosted worker','HOSTED_SETUP_REQUIRED',1);
 f.store.confirmAgentBinding({observation:observation(0),agent:local});
 f.store.confirmAgentBinding({observation:observation(2),agent:hosted});
 const direct=f.store.execute({type:'request.create',idempotencyKey:key(),projectId:f.project.id,name:'Hosted pass',
  hypothesis:'Check the figures',workType:'QUESTION',mode:'SINGLE',leadAgentId:hosted.id,participantIds:[]}).requests![0];
 assert.ok(start(f,direct.id,direct.revision).blockers.some(b=>b.code==='CLOUD_TRANSPORT_UNVERIFIED'),'a hosted lead keeps the warning');
 const mixed=f.store.execute({type:'request.create',idempotencyKey:key(),projectId:f.project.id,name:'Mixed pass',
  hypothesis:'Check the figures',workType:'QUESTION',mode:'GROUP',leadAgentId:local.id,participantIds:[hosted.id]}).requests![0];
 assert.ok(start(f,mixed.id,mixed.revision).blockers.some(b=>b.code==='CLOUD_TRANSPORT_UNVERIFIED'),'one hosted participant is enough to name the route');
});
