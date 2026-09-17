import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {removeTreeSync} from '../src/main/fsx';

/**
 * The project folder itself is the input scope: location.save records the canonical folder and
 * stores an empty allowlist because snapshots now walk the folder's whole contents. Callers may
 * still send legacy inputPaths — they are accepted but not stored — and no managed inputs directory
 * is created. Folder-walk enumeration, exclusions and byte-level transfer checks live in
 * locations.test.ts.
 */
const key=()=>randomUUID();
function fixture(t:any){
 const root=mkdtempSync(path.join(tmpdir(),'qro-location-'));
 const file=path.join(root,'workspace.sqlite');
 const store=new OfficeStore(file);t.after(()=>{try{store.close();}catch{/* already closed */}removeTreeSync(root);});
 const project=store.execute({type:'project.create',idempotencyKey:key(),name:'Alpha study',mandate:'Test',budgetCents:0}).projects[0];
 const source=path.join(root,'source');mkdirSync(source,{recursive:true});
 return {root,source,project,store};
}
const save=(f:ReturnType<typeof fixture>,localFolder:string,inputPaths:string[]|undefined,expectedRevision:number)=>
 f.store.execute({type:'location.save',idempotencyKey:key(),projectId:f.project.id,expectedRevision,localFolder,...(inputPaths?{inputPaths}:{}),outputFolder:''});

test('location.save records the folder as the scope and stores no per-file allowlist',t=>{
 const f=fixture(t);
 writeFileSync(path.join(f.source,'prices.csv'),'a,b\n1,2\n');
 const state=save(f,f.source,['prices.csv'],0);
 const location=state.locations![0];
 assert.deepEqual(location.inputPaths,[],'the folder is the scope; a legacy selection is not stored');
 assert.equal(location.localFolder,realpathSync(f.source),'the stored folder is canonical');
 assert.equal(location.snapshotRoute,'PROJECT_FOLDER_SNAPSHOT');
 assert.equal(existsSync(path.join(realpathSync(f.source),'inputs')),false,'no managed inputs directory is created');
});

test('the folder must be real, later saves stay revision-checked, and the scope survives restart',t=>{
 const f=fixture(t);
 writeFileSync(path.join(f.source,'a.csv'),'1\n');
 assert.throws(()=>save(f,path.join(f.root,'missing'),undefined,0),/Choose an existing project folder/,'a missing folder is still refused');
 save(f,f.source,undefined,0);
 assert.throws(()=>save(f,f.source,undefined,0),/changed in another view/,'a stale revision is refused');
 const second=save(f,f.source,['b.csv'],1);
 assert.deepEqual(second.locations![0].inputPaths,[],'a later save keeps the folder scope, not a selection');
 assert.equal(second.locations![0].revision,2);
 const reopened=new OfficeStore(path.join(f.root,'workspace.sqlite'));
 const again=reopened.snapshot({history:false});
 reopened.close();
 assert.equal(again.locations![0].snapshotRoute,'PROJECT_FOLDER_SNAPSHOT','the folder-scope route replays');
});
