import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {removeTreeSync} from '../src/main/fsx';

/**
 * The Projects panel now edits the saved selection directly, so these cases pin the store contract
 * it relies on: location.save stores the real input paths (sorted and deduplicated), a later save
 * replaces rather than merges the list, saving a real folder creates the managed inputs directory
 * the panel advertises, and paths without a folder are refused. Byte-level preparation and transfer
 * validation of the selection stay covered in locations.test.ts.
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
const save=(f:ReturnType<typeof fixture>,localFolder:string,inputPaths:string[],expectedRevision:number)=>
 f.store.execute({type:'location.save',idempotencyKey:key(),projectId:f.project.id,expectedRevision,localFolder,inputPaths,outputFolder:''});

test('location.save stores the real selected paths and creates the managed inputs directory',t=>{
 const f=fixture(t);
 writeFileSync(path.join(f.source,'prices.csv'),'a,b\n1,2\n');
 mkdirSync(path.join(f.source,'data'),{recursive:true});
 writeFileSync(path.join(f.source,'data','notes.md'),'# notes\n');
 const state=save(f,f.source,['prices.csv','data/notes.md','prices.csv'],0);
 const location=state.locations![0];
 assert.deepEqual(location.inputPaths,['data/notes.md','prices.csv'],'the stored allowlist is deduplicated and sorted');
 assert.equal(location.localFolder,realpathSync(f.source),'the stored folder is canonical');
 const managed=path.join(realpathSync(f.source),'inputs');
 assert.equal(statSync(managed).isDirectory(),true,'saving a folder creates the managed inputs directory the panel names');
});

test('the stored selection is replaced, never merged, and paths require a real folder',t=>{
 const f=fixture(t);
 writeFileSync(path.join(f.source,'a.csv'),'1\n');
 writeFileSync(path.join(f.source,'b.csv'),'2\n');
 assert.throws(()=>save(f,'',['a.csv'],0),/Choose the project folder before selecting files/,'selected paths have nothing to resolve under without a folder');
 save(f,f.source,['a.csv'],0);
 const second=save(f,f.source,['b.csv'],1);
 assert.deepEqual(second.locations![0].inputPaths,['b.csv'],'a later save replaces the allowlist the panel sent');
 const cleared=save(f,f.source,[],2);
 assert.deepEqual(cleared.locations![0].inputPaths,[],'an empty selection is stored honestly');
});
