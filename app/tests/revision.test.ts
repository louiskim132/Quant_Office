import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {requestQueue} from '../src/shared/queue';
import {suggestedEfforts} from '../src/shared/effort';
import {ArtifactService,validateArchiveFiles} from '../src/main/artifacts';
import {prepareRestore,discardCandidate} from '../src/main/recovery';
const key=()=>randomUUID();
function fixture(t:any){const root=mkdtempSync(path.join(tmpdir(),'qro-revision-')),file=path.join(root,'workspace.sqlite'),store=new OfficeStore(file);t.after(()=>store.close());const project=store.execute({type:'project.create',idempotencyKey:key(),name:'Test',mandate:'',budgetCents:0}).projects[0];return {store,project,root,file};}
function worker(store:OfficeStore){const now=new Date().toISOString(),id=key();store.addAgent({id,name:'Only worker',provider:'openai',model:'unverified',team:'Research',role:'WORKER',instructions:'',account:'fixture',createdAt:now,connectionVerifiedAt:now,execution:'HOSTED_SETUP_REQUIRED'});return id;}

test('review, revise, repeat, cancel uses the root; superseded children never cancel the queue',t=>{
 const {store,project}=fixture(t);let state=store.execute({type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Legacy request',hypothesis:'Question'});const exp=state.experiments[0],root=state.tasks[0];
 for(let revision=0;revision<4;revision+=2){store.execute({type:'contract.submit',idempotencyKey:key(),experimentId:exp.id,expectedRevision:revision});state=store.execute({type:'contract.save',idempotencyKey:key(),experimentId:exp.id,expectedRevision:revision+1,contract:exp.contract});assert.equal(requestQueue(state).length,1);assert.equal(requestQueue(state)[0].status,'BLOCKED');assert.equal(requestQueue(state)[0].id,root.id);}
 state=store.execute({type:'task.cancel',idempotencyKey:key(),taskId:requestQueue(state)[0].id});assert.equal(requestQueue(state)[0].status,'CANCELED');assert.equal(state.tasks.filter(t=>t.status==='SUPERSEDED').length,2);
 store.execute({type:'project.archive',idempotencyKey:key(),projectId:project.id,archived:true});store.execute({type:'project.archive',idempotencyKey:key(),projectId:project.id,archived:false});assert.throws(()=>store.execute({type:'contract.submit',idempotencyKey:key(),experimentId:exp.id,expectedRevision:5}),/Canceled/);
});

test('archived profiles reject all effort mutations including no-op, and stale profile writes',t=>{
 const {store}=fixture(t),id=worker(store);const update={type:'agent.update',idempotencyKey:key(),agentId:id,expectedRevision:0,name:'New',team:'Research',role:'WORKER',instructions:''};store.execute(update);
 assert.throws(()=>store.execute({...update,idempotencyKey:key()}),/Stale/);
 store.execute({type:'agent.remove',idempotencyKey:key(),agentId:id,removed:true});for(const effort of ['default','high'] as const)assert.throws(()=>store.setAgentEffort(id,effort,'default'),/Restore/);
 assert.throws(()=>store.execute({...update,idempotencyKey:key(),expectedRevision:2}),/Restore/);assert.equal(store.snapshot().agents[0].revision,2);
});

test('a question belongs to one Worker without an experiment or implicit team; start records blockers',t=>{
 const {store,project}=fixture(t),leadAgentId=worker(store);const create={type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Explain',hypothesis:'Explain this notebook',workType:'QUESTION',mode:'SINGLE',leadAgentId};
 let state=store.execute(create);const request=state.requests![0];assert.equal(state.experiments.length,0);assert.equal(state.tasks.length,0);assert.equal(request.delegation,false);assert.equal(request.status,'DRAFT');assert.equal(store.execute(create).requests!.length,1);
 state=store.execute({type:'request.start',idempotencyKey:key(),requestId:request.id,expectedRevision:0});assert.deepEqual(state.requests![0].blockers.map(b=>b.code),['CLOUD_TRANSPORT_UNVERIFIED']);assert.equal(requestQueue(state)[0].status,'BLOCKED');
 state=store.execute({type:'request.cancel',idempotencyKey:key(),requestId:request.id,expectedRevision:1});assert.equal(requestQueue(state)[0].active,false);assert.throws(()=>store.execute({type:'request.start',idempotencyKey:key(),requestId:request.id,expectedRevision:2}),/Canceled/);
 state=store.execute({type:'request.duplicate',idempotencyKey:key(),requestId:request.id,expectedRevision:2});assert.notEqual(state.requests![1].id,request.id);assert.equal(state.requests![1].sourceRequestId,request.id);assert.equal(state.requests![0].status,'CANCELED');
});

test('selected groups resolve actual same-role agents and reject archived participants or implicit single-agent collaborators',t=>{
 const {store,project}=fixture(t),leadAgentId=worker(store),second=worker(store);const create={type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Compare',hypothesis:'Compare designs',workType:'ANALYSIS',mode:'GROUP',leadAgentId,participantIds:[second]};
 const state=store.execute(create);assert.deepEqual(state.requests![0].participantIds,[second]);assert.throws(()=>store.execute({...create,idempotencyKey:key(),mode:'SINGLE'}),/Single-agent/);
 store.execute({type:'agent.remove',idempotencyKey:key(),agentId:second,removed:true});assert.throws(()=>store.execute({...create,idempotencyKey:key()}),/active agent/);
 const started=store.execute({type:'request.start',idempotencyKey:key(),requestId:state.requests![0].id,expectedRevision:0});assert.ok(started.requests![0].blockers.some(b=>b.code==='AGENT_UNAVAILABLE'));
});

test('empirical request reviews remain a single queue entry and cancellation closes scientific details',t=>{
 const {store,project}=fixture(t);let state=store.execute({type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Experiment',hypothesis:'Test',workType:'EXPERIMENT',mode:'SINGLE'});const r=state.requests![0],exp=state.experiments[0];
 store.execute({type:'contract.submit',idempotencyKey:key(),experimentId:exp.id,expectedRevision:0});state=store.execute({type:'contract.save',idempotencyKey:key(),experimentId:exp.id,expectedRevision:1,contract:exp.contract});assert.equal(requestQueue(state).length,1);assert.equal(requestQueue(state)[0].status,'DRAFT');
 state=store.execute({type:'request.cancel',idempotencyKey:key(),requestId:r.id,expectedRevision:0});assert.equal(state.experiments[0].stage,'CANCELED');
});

test('project folders with Unicode and spaces persist without reading folder contents; missing paths reject',t=>{
 const {store,root}=fixture(t);const folder=mkdtempSync(path.join(root,'研究 folder '));const state=store.execute({type:'project.create',idempotencyKey:key(),name:'Located',mandate:'',budgetCents:0,localFolder:folder,cloudWorkspace:'unverified provider/environment'});assert.equal(state.projects[1].localFolder,folder);assert.equal(state.artifacts.length,0);
 assert.throws(()=>store.execute({type:'project.update',idempotencyKey:key(),projectId:state.projects[1].id,name:'Moved',mandate:'',budgetCents:0,localFolder:path.join(root,'absent')}));
});

test('native requests and old event hashes survive reopen and backup restore',async t=>{
 const {store,project,root,file}=fixture(t),old=store.snapshot().events.map(e=>e.hash);store.execute({type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Question',hypothesis:'Why?',workType:'QUESTION'});
 const destination=path.join(root,'backup.zip');await new ArtifactService(store,root).backup(destination);const prepared=await prepareRestore(destination,root),restored=new OfficeStore(path.join(prepared.candidate,'workspace.sqlite'));try{assert.equal(restored.snapshot().requests!.length,1);assert.deepEqual(restored.snapshot().events.slice(0,old.length).map(e=>e.hash),old);}finally{restored.close();await discardCandidate(prepared.candidate,root);}store.close();const reopened=new OfficeStore(file);try{assert.equal(reopened.snapshot().requests!.length,1);}finally{reopened.close();}
});

test('unknown provider model and aliases never offer an inferred effort scale',()=>{for(const provider of ['openai','claude'] as const)for(const model of ['unknown','opus','claude-opus-4-6'])assert.deepEqual(suggestedEfforts(provider,model),['default']);});
test('archive writer accounts for manifests and entry count before announcing success',()=>{const files=Object.fromEntries(Array.from({length:513},(_,i)=>['file'+i,new Uint8Array()]));assert.throws(()=>validateArchiveFiles(files),/512 entries/);assert.throws(()=>validateArchiveFiles({'backup.json':new Uint8Array(1024*1024+1)}),/manifest/);});

test('editing a request requires its revision and supersedes review children without canceling parent',t=>{
 const {store,project}=fixture(t),leadAgentId=worker(store);let state=store.execute({type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Test',hypothesis:'Original',workType:'EXPERIMENT',leadAgentId});const request=state.requests![0];
 store.execute({type:'contract.submit',idempotencyKey:key(),experimentId:request.experimentId,expectedRevision:0});const edit={type:'request.update',idempotencyKey:key(),requestId:request.id,expectedRevision:0,objective:'Revised',leadAgentId,participantIds:[],acceptanceCriteria:'Explain uncertainty'};state=store.execute(edit);
 assert.equal(state.tasks[0].status,'SUPERSEDED');assert.equal(state.requests![0].status,'DRAFT');assert.equal(state.experiments[0].contract.objective,'Revised');assert.throws(()=>store.execute({...edit,idempotencyKey:key()}),/Stale/);
});

test('legacy archive repair appends a migration and leaves original event hashes intact',t=>{
 const {store,project,file}=fixture(t);const state=store.execute({type:'request.create',idempotencyKey:key(),projectId:project.id,name:'Old request',hypothesis:'Old objective'});const task=state.tasks[0],exp=state.experiments[0];
 // Reproduce the old writer's archive event through its transaction boundary.
 const internal=store as any;internal.transaction(()=>internal.append(internal.readProjection(),[{collection:'tasks',value:{...task,status:'CANCELED',blocker:'Project archived'}},{collection:'projects',value:{...project,archived:true}}],{kind:'PROJECT_ARCHIVE',projectId:project.id,experimentId:null,reason:'Legacy archive fixture'},null));
 const hashes=store.snapshot().events.map(e=>e.hash);store.close();const reopened=new OfficeStore(file);try{const fixed=reopened.snapshot();assert.deepEqual(fixed.events.slice(0,hashes.length).map(e=>e.hash),hashes);assert.equal(fixed.events.at(-1)!.kind,'MIGRATION_ARCHIVE_LIFECYCLE');assert.equal(fixed.experiments[0].stage,'CANCELED');reopened.execute({type:'project.archive',idempotencyKey:key(),projectId:project.id,archived:false});assert.throws(()=>reopened.execute({type:'contract.submit',idempotencyKey:key(),experimentId:exp.id,expectedRevision:1}),/Canceled/);}finally{reopened.close();}
});
