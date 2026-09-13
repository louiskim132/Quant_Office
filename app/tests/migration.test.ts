import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readdirSync} from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {requestQueue} from '../src/shared/queue';

const key=()=>randomUUID();
function fixture(t:any){
 const root=mkdtempSync(path.join(tmpdir(),'qro-migration-'));
 const file=path.join(root,'workspace.sqlite');
 let store=new OfficeStore(file);
 t.after(()=>{try{store.close();}catch{}removeTreeSync(root);});
 const project=store.execute({type:'project.create',idempotencyKey:key(),name:'Alpha',mandate:'m',budgetCents:0}).projects[0];
 return {root,file,project,get store(){return store;},reopen(){store.close();store=new OfficeStore(file);return store;}};
}

test('legacy task groups become requests that stay explicitly ambiguous',t=>{
 const f=fixture(t);
 f.store.execute({type:'task.create',idempotencyKey:key(),projectId:f.project.id,experimentId:null,prompt:'An old standalone question',recipient:'WORKER'});
 const before=f.store.snapshot();
 assert.equal(before.requests,undefined);
 const hashes=before.events.map(event=>event.hash);
 const result=f.store.migrateLegacyRequests();
 assert.equal(result.migrated,1);
 const state=f.store.snapshot();
 const migrated=state.requests![0];
 assert.equal(migrated.objective,'An old standalone question');
 assert.equal(migrated.status,'DRAFT','a migrated record is never promoted to a completed outcome');
 assert.equal(migrated.blockers[0].code,'MIGRATED_LEGACY_RECORD');
 assert.match(migrated.blockers[0].message,/never observed a provider result/);
 assert.equal(state.assignments,undefined,'migration invents no assignment or job');
 assert.deepEqual(state.events.map(event=>event.hash).slice(0,hashes.length),hashes,'original event bytes are untouched');
 assert.ok(state.events.some(event=>event.kind==='MIGRATION_LEGACY_REQUESTS_V1'));
});

test('migration copies the database first and survives replay and restart',t=>{
 const f=fixture(t);
 f.store.execute({type:'task.create',idempotencyKey:key(),projectId:f.project.id,experimentId:null,prompt:'Legacy work',recipient:'WORKER'});
 const copy=path.join(f.root,'pre-migration.sqlite');
 f.store.migrateLegacyRequests({copyTo:copy});
 assert.ok(existsSync(copy),'a copy is taken before the migration appends anything');
 const previous=new OfficeStore(copy);
 assert.equal(previous.snapshot().requests,undefined,'the copy is the pre-migration workspace');
 previous.close();
 const before=f.store.snapshot().requests;
 const reopened=f.reopen();
 assert.deepEqual(reopened.snapshot().requests,before,'the migrated records replay identically');
});

test('migration is idempotent and never touches work that already has a request',t=>{
 const f=fixture(t);
 f.store.execute({type:'request.create',idempotencyKey:key(),projectId:f.project.id,name:'Native request',hypothesis:'Modern work',workType:'EXPERIMENT',mode:'SINGLE'});
 f.store.execute({type:'task.create',idempotencyKey:key(),projectId:f.project.id,experimentId:null,prompt:'Legacy work',recipient:'WORKER'});
 const first=f.store.migrateLegacyRequests();
 assert.equal(first.migrated,1,'only the legacy group is migrated');
 const second=f.store.migrateLegacyRequests();
 assert.equal(second.migrated,0);
 const state=f.store.snapshot();
 assert.equal(state.requests!.length,2);
 assert.equal(state.requests!.filter(request=>request.migratedFromTaskId).length,1);
 assert.equal(state.events.filter(event=>event.kind==='MIGRATION_LEGACY_REQUESTS_V1').length,1,'a second run appends nothing');
});

test('a legacy group that ended canceled migrates as canceled, not as open work',t=>{
 const f=fixture(t);
 const state=f.store.execute({type:'task.create',idempotencyKey:key(),projectId:f.project.id,experimentId:null,prompt:'Abandoned work',recipient:'WORKER'});
 f.store.execute({type:'task.cancel',idempotencyKey:key(),taskId:state.tasks[0].id});
 f.store.migrateLegacyRequests();
 const migrated=f.store.snapshot().requests![0];
 assert.equal(migrated.status,'CANCELED');
 assert.equal(migrated.blockers[0].code,'MIGRATED_LEGACY_RECORD');
 const queue=requestQueue(f.store.snapshot());
 assert.equal(queue.filter(entry=>entry.request?.migratedFromTaskId).length,1,'the migrated request appears once in the canonical queue');
});

test('migrating a large legacy workspace stays one event and keeps integrity',t=>{
 const f=fixture(t);
 for(let index=0;index<50;index++)f.store.execute({type:'task.create',idempotencyKey:key(),projectId:f.project.id,experimentId:null,prompt:`Legacy item ${index}`,recipient:'WORKER'});
 const before=f.store.snapshot().events.length;
 const result=f.store.migrateLegacyRequests();
 assert.equal(result.migrated,50);
 const after=f.store.snapshot();
 assert.equal(after.events.length,before+1,'one migration event covers the whole batch');
 assert.equal(after.requests!.length,50);
 assert.equal(readdirSync(f.root).filter(name=>name.includes('before-legacy-request-migration')).length,1);
});
