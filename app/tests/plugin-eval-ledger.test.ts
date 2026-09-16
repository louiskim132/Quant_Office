import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {appendFileSync,existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {removeTreeSync} from '../src/main/fsx';

// Harness modules ship as dependency-free .mjs outside tsconfig's include set, so a literal
// specifier has no declaration file to resolve; binding through a variable keeps the dynamic
// import unresolvable to tsc and is typed here instead.
const ledgerModule='../benchmarks/plugin-evaluation/harness/ledger.mjs';
const recordsModule='../benchmarks/plugin-evaluation/harness/records.mjs';
interface LedgerEntry{type:string;attemptId:string;record:Record<string,unknown>;appendedAt:string}
const ledger=await import(ledgerModule) as {
 append(ledgerPath:string,entry:LedgerEntry,options?:{attemptDir?:string}):void;
 read(ledgerPath:string,options?:{attemptDir?:string}):{entries:LedgerEntry[];corrupt:number[]};
 entriesByAttempt(entries:LedgerEntry[],attemptId:string):{attemptId:string;manifest:LedgerEntry[];usage:LedgerEntry[];score:LedgerEntry[]};
};
const {EVIDENCE_FINDINGS,TIMEBOX_MS}=await import(recordsModule) as {EVIDENCE_FINDINGS:string[];TIMEBOX_MS:number};

const HEX='a'.repeat(64);
const manifest=(attemptId:string)=>({schema:'plugin-eval-attempt@1',attemptId,arm:'A0',phase:'INITIAL',promptSha256:HEX,taskHash:HEX,
 files:[{path:'TASK.md',sha256:HEX,bytes:120}],config:{provider:'devin',model:'swe-2-max',effort:'default',clientVersion:'devin-cli 0.0.0',tools:[]},
 timeboxMs:TIMEBOX_MS,setupMs:0,createdAt:'2026-09-16T00:00:00.000Z'});
const usage=(attemptId:string)=>({schema:'plugin-eval-usage@1',attemptId,
 agent:{input:1000,output:200,reasoning:null,cacheRead:null,cacheWrite:null},helperModels:[{name:'helper-a',input:50,output:10}],
 setupWallMs:0,taskWallMs:540000,toolBytes:null});
const score=(attemptId:string)=>({schema:'plugin-eval-score@1',attemptId,codeGate:{ran:true,exitCode:0,passed:16,total:16},
 findings:EVIDENCE_FINDINGS.map(id=>({id,verdict:'PRESENT',source:'catalog.md',heading:'Sources'})),defects:[],blind:true});
const entry=(type:'manifest'|'usage'|'score',attemptId:string):LedgerEntry=>({type,attemptId,record:{manifest,usage,score}[type](attemptId),appendedAt:'2026-09-16T01:00:00.000Z'});

function workspace(t:any){
 const root=mkdtempSync(path.join(tmpdir(),'qro-eval-ledger-'));
 t.after(()=>removeTreeSync(root));
 return root;
}
const moduleUrl=pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../benchmarks/plugin-evaluation/harness/ledger.mjs')).href;

test('append validates every record before it lands and refuses malformed entries',t=>{
 const root=workspace(t);
 const ledgerPath=path.join(root,'attempts.jsonl');
 ledger.append(ledgerPath,entry('manifest','a0-initial-1'));
 ledger.append(ledgerPath,entry('usage','a0-initial-1'));
 ledger.append(ledgerPath,entry('score','a0-initial-1'));
 assert.equal(ledger.read(ledgerPath).entries.length,3);
 // A malformed record never lands: bad schema, unknown type, missing timestamp, envelope mismatch.
 for(const bad of [
  {type:'manifest',attemptId:'a0-initial-2',record:{...manifest('a0-initial-2'),schema:'plugin-eval-attempt@0'},appendedAt:'2026-09-16T01:00:00.000Z'},
  {type:'note',attemptId:'a0-initial-2',record:manifest('a0-initial-2'),appendedAt:'2026-09-16T01:00:00.000Z'},
  {type:'usage',attemptId:'a0-initial-2',record:usage('a0-initial-2'),appendedAt:'not-a-time'},
  {type:'score',attemptId:'b0-initial-1',record:score('a0-initial-2'),appendedAt:'2026-09-16T01:00:00.000Z'},
  {type:'manifest',attemptId:'a0-initial-2',record:{...manifest('a0-initial-2'),files:[]},appendedAt:'2026-09-16T01:00:00.000Z'},
 ] as LedgerEntry[]) assert.throws(()=>ledger.append(ledgerPath,bad),/Refusing to append/);
 assert.equal(ledger.read(ledgerPath).entries.length,3,'a refused entry must not land in the ledger');
 // Immutability is structural: no update or delete operation exists.
 for(const name of ['update','remove','delete','rewrite','truncate']) assert.equal((ledger as Record<string,unknown>)[name],undefined);
});

test('entries appended by another process survive reopen and read back intact',t=>{
 const root=workspace(t);
 const ledgerPath=path.join(root,'attempts.jsonl');
 ledger.append(ledgerPath,entry('manifest','b0-initial-1'));
 // A separate node process appends to the same ledger; nothing is shared through this process.
 const child=path.join(root,'child.mjs');
 writeFileSync(child,'const [mod,ledger,entryJson]=process.argv.slice(2);(await import(mod)).append(ledger,JSON.parse(entryJson));\n');
 execFileSync(process.execPath,[child,moduleUrl,ledgerPath,JSON.stringify(entry('usage','b0-initial-1'))]);
 const after=ledger.read(ledgerPath);
 assert.equal(after.corrupt.length,0);
 assert.deepEqual(after.entries.map(e=>e.type),['manifest','usage']);
 assert.equal(after.entries[1].attemptId,'b0-initial-1');
 assert.equal((after.entries[1].record as {taskWallMs:number}).taskWallMs,540000);
});

test('a trailing partial or corrupt line is flagged, never silently dropped',t=>{
 const root=workspace(t);
 const ledgerPath=path.join(root,'attempts.jsonl');
 ledger.append(ledgerPath,entry('manifest','a0-initial-1'));
 ledger.append(ledgerPath,entry('usage','a0-initial-1'));
 // A crashed append leaves a truncated final line; a structurally impossible line counts too.
 appendFileSync(ledgerPath,'{"type":"score","attemptId":"a0-init');
 const flagged=ledger.read(ledgerPath);
 assert.equal(flagged.entries.length,2,'intact entries still read back');
 assert.deepEqual(flagged.corrupt,[3]);
 appendFileSync(ledgerPath,'\n{"type":"unknown","attemptId":"x","record":{},"appendedAt":"2026-09-16T01:00:00.000Z"}\n');
 const again=ledger.read(ledgerPath);
 assert.equal(again.entries.length,2);
 assert.deepEqual(again.corrupt,[3,4],'a parseable line that is not a ledger entry is still corruption');
 // A ledger that does not exist yet reads as empty rather than throwing.
 assert.deepEqual(ledger.read(path.join(root,'never-written.jsonl')),{entries:[],corrupt:[]});
});

test('entriesByAttempt groups a ledger read by attempt in append order',t=>{
 const root=workspace(t);
 const ledgerPath=path.join(root,'attempts.jsonl');
 ledger.append(ledgerPath,entry('manifest','a0-initial-1'));
 ledger.append(ledgerPath,entry('manifest','a0-initial-2'));
 ledger.append(ledgerPath,entry('usage','a0-initial-1'));
 ledger.append(ledgerPath,entry('score','a0-initial-1'));
 ledger.append(ledgerPath,entry('usage','a0-initial-2'));
 const {entries}=ledger.read(ledgerPath);
 const first=ledger.entriesByAttempt(entries,'a0-initial-1');
 assert.equal(first.attemptId,'a0-initial-1');
 assert.deepEqual(first.manifest.map(e=>e.record.schema),['plugin-eval-attempt@1']);
 assert.equal(first.usage.length,1);
 assert.equal(first.score.length,1);
 const second=ledger.entriesByAttempt(entries,'a0-initial-2');
 assert.equal(second.manifest.length,1);
 assert.equal(second.usage.length,1);
 assert.equal(second.score.length,0,'an attempt without a score groups to an empty list');
 const unknown=ledger.entriesByAttempt(entries,'ag-initial-9');
 assert.deepEqual([unknown.manifest.length,unknown.usage.length,unknown.score.length],[0,0,0]);
});

test('a ledger path inside an attempt dir or the fixture task tree is refused',t=>{
 const root=workspace(t);
 const attemptDir=path.join(root,'attempts','a0-initial-1');
 const insideAttempt=path.join(attemptDir,'ledger.jsonl');
 assert.throws(()=>ledger.append(insideAttempt,entry('manifest','a0-initial-1'),{attemptDir}),/evaluator-side state/);
 assert.throws(()=>ledger.read(insideAttempt,{attemptDir}),/evaluator-side state/);
 assert.equal(existsSync(insideAttempt),false,'a refused append must not create the file');
 // The participant-visible task tree is never a ledger location, supplied attempt dir or not.
 const taskDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../benchmarks/plugin-evaluation/task');
 const insideTask=path.join(taskDir,'attempts.jsonl');
 assert.throws(()=>ledger.append(insideTask,entry('manifest','a0-initial-1')),/task\/ tree/);
 assert.throws(()=>ledger.read(insideTask),/task\/ tree/);
 // The evaluator's own directory and ordinary workspace paths remain valid locations.
 const outside=path.join(root,'evaluator','attempts.jsonl');
 ledger.append(outside,entry('manifest','a0-initial-1'),{attemptDir});
 assert.equal(ledger.read(outside,{attemptDir}).entries.length,1);
 assert.ok(readFileSync(outside,'utf8').trim().split('\n').every(line=>JSON.parse(line)));
});
