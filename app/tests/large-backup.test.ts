import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import { removeTreeSync } from '../src/main/fsx';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficeStore} from '../src/core/store';
import {ArtifactService,MAX_TOTAL} from '../src/main/artifacts';
import {prepareRestore,discardCandidate,workspaceDirectory} from '../src/main/recovery';

const key=()=>randomUUID();
/** Tiny format thresholds force the streamed path with small fixtures; the code path is the real one. */
const STREAMED={maxEntries:2,maxTotalBytes:1,maxFileBytes:1};

function fixture(t:any,format?:{maxEntries:number;maxTotalBytes:number;maxFileBytes:number}){
 const root=mkdtempSync(path.join(tmpdir(),'qro-large-'));
 const workspace=workspaceDirectory(root);mkdirSync(workspace,{recursive:true});
 const store=new OfficeStore(path.join(workspace,'workspace.sqlite'));
 t.after(()=>{try{store.close();}catch{}removeTreeSync(root);});
 const artifacts=format?new ArtifactService(store,workspace,format):new ArtifactService(store,workspace);
 const project=store.execute({type:'project.create',idempotencyKey:key(),name:'Alpha',mandate:'m',budgetCents:0}).projects[0];
 return {root,workspace,store,artifacts,project};
}

test('a small workspace keeps the in-memory format and restores from it',async t=>{
 const f=fixture(t);
 const file=path.join(f.root,'small.txt');writeFileSync(file,'a small reference');
 await f.artifacts.importFile(file,f.project.id,null,'REFERENCE');
 const destination=path.join(f.root,'small-backup.zip');
 await f.artifacts.backup(destination);
 assert.ok(statSync(destination).size<MAX_TOTAL);
 const prepared=await prepareRestore(destination,f.root);
 assert.match(prepared.summary,/1 projects/);
 assert.equal(prepared.summary.includes('streamed'),false,'a small workspace does not need the streamed format');
 await discardCandidate(prepared.candidate,f.root);
});

test('a workspace past the in-memory limits backs up and restores through the streamed format',async t=>{
 const f=fixture(t,STREAMED);
 const first=path.join(f.root,'one.txt');writeFileSync(first,'first reference');
 const second=path.join(f.root,'two.csv');writeFileSync(second,'a,b\n1,2\n');
 await f.artifacts.importFile(first,f.project.id,null,'REFERENCE');
 await f.artifacts.importFile(second,f.project.id,null,'REFERENCE');
 const destination=path.join(f.root,'streamed-backup.zip');
 await f.artifacts.backup(destination);
 const prepared=await prepareRestore(destination,f.root);
 assert.match(prepared.summary,/streamed archive/,'the streamed format is used and reported honestly');
 assert.match(prepared.summary,/2 artifacts/);
 await discardCandidate(prepared.candidate,f.root);
 const events=f.store.snapshot().events.filter(event=>event.kind==='WORKSPACE_BACKED_UP');
 assert.equal(events.length,1);
 assert.match(events[0].reason,/streamed workspace backup/);
});

test('a streamed backup is verified by reading it back before it is announced',async t=>{
 const f=fixture(t,STREAMED);
 const file=path.join(f.root,'one.txt');writeFileSync(file,'reference');
 const artifact=await f.artifacts.importFile(file,f.project.id,null,'REFERENCE');
 const objectPath=path.join(f.workspace,'objects',artifact.sha256.slice(0,2),artifact.sha256);
 assert.ok(statSync(objectPath).isFile());
 // A stored object that no longer matches its identity must stop the backup, not be written into it.
 writeFileSync(objectPath,'tampered bytes');
 await assert.rejects(f.artifacts.backup(path.join(f.root,'broken.zip')),/integrity failure/i);
 assert.equal(f.store.snapshot().events.some(event=>event.kind==='WORKSPACE_BACKED_UP'),false,'a failed backup is never recorded as one');
});

test('a corrupted streamed archive is refused and leaves the live workspace untouched',async t=>{
 const f=fixture(t,STREAMED);
 const file=path.join(f.root,'one.txt');writeFileSync(file,'reference');
 await f.artifacts.importFile(file,f.project.id,null,'REFERENCE');
 const destination=path.join(f.root,'backup.zip');
 await f.artifacts.backup(destination);
 const bytes=readFileSync(destination);
 bytes[Math.floor(bytes.length/2)]^=0xff;
 const broken=path.join(f.root,'broken.zip');writeFileSync(broken,bytes);
 await assert.rejects(prepareRestore(broken,f.root),/.+/);
 assert.equal(f.store.snapshot().projects.length,1);
 assert.equal(f.store.snapshot().artifacts.length,1);
});
