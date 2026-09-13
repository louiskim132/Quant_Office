import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {OfficeStore} from '../src/core/store';
import {queueScope} from '../src/shared/queue';

/**
 * task.delete only hides a terminal queue row. The underlying request/task records and every
 * lineage event stay intact: removal is a view change, never a rewrite of history.
 */
test('a canceled request leaves the queue and keeps its record and history',()=>{
 const store=new OfficeStore(':memory:');try{
 const project=store.execute({type:'project.create',idempotencyKey:randomUUID(),name:'Test',mandate:'',budgetCents:0}).projects[0];
 const created=store.execute({type:'request.create',idempotencyKey:randomUUID(),projectId:project.id,name:'Request',hypothesis:'Compare baselines',workType:'QUESTION'});
 const request=created.requests![0];
 assert.equal(queueScope(created,{lifecycle:'ALL'}).entries.some(e=>e.id===request.id),true);
 assert.equal(queueScope(created,{lifecycle:'ALL'}).entries[0].deletable,false);
 // Open requests cannot be removed.
 assert.throws(()=>store.execute({type:'task.delete',idempotencyKey:randomUUID(),taskId:request.id}),/completed or canceled/);
 const canceled=store.execute({type:'request.cancel',idempotencyKey:randomUUID(),requestId:request.id,expectedRevision:request.revision});
 assert.equal(queueScope(canceled,{lifecycle:'ALL'}).entries[0].deletable,true);
 // A stale revision is refused before removal.
 assert.throws(()=>store.execute({type:'task.delete',idempotencyKey:randomUUID(),taskId:request.id,expectedRevision:request.revision+9}),/changed/);
 const removed=store.execute({type:'task.delete',idempotencyKey:randomUUID(),taskId:request.id,expectedRevision:canceled.requests![0].revision});
 assert.ok(removed.requests![0].removedAt);
 assert.equal(removed.requests![0].status,'CANCELED');
 // The row is gone from every queue scope while the record stays in state.
 for(const lifecycle of ['ACTIVE','COMPLETED','CANCELED','ALL'] as const)assert.equal(queueScope(removed,{lifecycle}).entries.some(e=>e.id===request.id),false,lifecycle);
 assert.ok(removed.requests!.some(r=>r.id===request.id));
 // A second removal is refused.
 assert.throws(()=>store.execute({type:'task.delete',idempotencyKey:randomUUID(),taskId:request.id}),/already removed/);
 // Every event, including the removal itself, remains in history.
 const history=store.historyPage({limit:100});
 assert.ok(history.entries.some(e=>e.kind==='TASK_DELETE'));
 assert.ok(history.entries.some(e=>e.kind==='REQUEST_CANCEL'));
 assert.ok(history.entries.some(e=>e.kind==='REQUEST_CREATE'));
 }finally{store.close();}
});

test('a canceled legacy task group leaves the queue; open groups stay put',()=>{
 const store=new OfficeStore(':memory:');try{
 const project=store.execute({type:'project.create',idempotencyKey:randomUUID(),name:'Test',mandate:'',budgetCents:0}).projects[0];
 const state=store.execute({type:'task.create',idempotencyKey:randomUUID(),projectId:project.id,experimentId:null,prompt:'Standalone investigation',recipient:'WORKER'});
 const task=state.tasks[0];
 assert.equal(queueScope(state,{lifecycle:'ALL'}).entries.length,1);
 assert.throws(()=>store.execute({type:'task.delete',idempotencyKey:randomUUID(),taskId:task.id}),/completed or canceled/);
 store.execute({type:'task.cancel',idempotencyKey:randomUUID(),taskId:task.id});
 const removed=store.execute({type:'task.delete',idempotencyKey:randomUUID(),taskId:task.id});
 assert.ok(removed.tasks.every(t=>t.removedAt));
 assert.equal(queueScope(removed,{lifecycle:'ALL'}).entries.length,0);
 assert.ok(removed.tasks.some(t=>t.id===task.id));
 assert.throws(()=>store.execute({type:'task.delete',idempotencyKey:randomUUID(),taskId:randomUUID()}),/not found/i);
 }finally{store.close();}
});
