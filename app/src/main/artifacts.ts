import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync, zip, strFromU8, strToU8 } from 'fflate';
import { z } from 'zod';
import { writeStreamedArchive } from './archive.js';
import { removeTree } from './fsx.js';
import { OfficeStore } from '../core/store.js';
import { canonicalHash } from '../core/canonical.js';
import { parseStrictJson } from '../core/strict-json.js';
import { objectInventory } from '../core/object-inventory.js';
import type { Artifact, AppState } from '../shared/types.js';
import { catBoostPackageSchema, type CatBoostPackage, type GateEvaluation } from '../shared/research-contracts.js';
import { advanceable, evaluatePackage } from '../core/research-gates.js';
import { assertHonestApproval, releaseManifestSchema } from '../shared/shadow.js';

export const MAX_FILE = 64 * 1024 * 1024;
export const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_ENTRIES = 512;
const compress=(files:Record<string,Uint8Array>)=>new Promise<Uint8Array>((resolve,reject)=>zip(files,{level:6},(error,bytes)=>error?reject(error):resolve(bytes)));
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const resultManifestSchema = z.object({
 schemaVersion: z.literal(1), runId: z.string().uuid(), projectId: z.string().uuid(), experimentId: z.string().uuid(),
 sourceHash: hashSchema, terminal: z.literal(true), status: z.enum(['COMPLETED', 'EXECUTION_FAILED', 'INVALID', 'INCONCLUSIVE']),
 artifacts: z.array(z.object({ path: z.string().min(1).max(240), sha256: hashSchema, size: z.number().int().min(0).max(MAX_FILE) }).strict()).max(MAX_ENTRIES),
}).strict();

export async function fileHash(file: string): Promise<string> {
 const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex');
}
export function safeEntry(name: string): boolean {
 return name.length > 0 && name.length <= 240 && !/[\\:\x00-\x1f]/.test(name) && !name.startsWith('/') && name.split('/').every(p => p !== '..' && p !== '.' && p.length > 0 && !/[ .]$/.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
export function validateZipHeaders(bytes:Uint8Array):void {
 const b=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
 for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50&&i+22+b.readUInt16LE(i+20)===b.length){end=i;break;}
 if(end<0)throw new Error('Invalid ZIP directory.');
 const count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),offset=b.readUInt32LE(end+16);
 if(b.readUInt16LE(end+4)||b.readUInt16LE(end+6)||b.readUInt16LE(end+8)!==count||count>MAX_ENTRIES||size===0xffffffff||offset===0xffffffff||offset+size!==end)throw new Error('Unsupported or oversized ZIP directory.');
 let p=offset,total=0;const names=new Set<string>();
 for(let n=0;n<count;n++){
  if(p+46>end||b.readUInt32LE(p)!==0x02014b50)throw new Error('Invalid ZIP entry.');
  const flags=b.readUInt16LE(p+8),method=b.readUInt16LE(p+10),packed=b.readUInt32LE(p+20),unpacked=b.readUInt32LE(p+24),length=b.readUInt16LE(p+28),extra=b.readUInt16LE(p+30),comment=b.readUInt16LE(p+32),external=b.readUInt32LE(p+38),local=b.readUInt32LE(p+42),mode=(external>>>16)&0xf000;
  if(p+46+length+extra+comment>end||(flags&1)||![0,8].includes(method)||[0xffffffff].includes(local)||b.readUInt16LE(p+34)!==0)throw new Error('Unsupported ZIP entry metadata.');
  if(mode!==0&&mode!==0x8000||external&0x400)throw new Error('ZIP links, directories and special files are not permitted.');
  const name=strFromU8(b.subarray(p+46,p+46+length),!(flags&0x800));
  if(!safeEntry(name)||names.has(name.toLowerCase()))throw new Error('Archive contains unsafe or duplicate entries.');names.add(name.toLowerCase());
  total+=unpacked;if(unpacked>MAX_FILE||total>MAX_TOTAL)throw new Error('Archive expands beyond the permitted size.');
  if(local+30>offset||b.readUInt32LE(local)!==0x04034b50||b.readUInt16LE(local+6)!==flags||b.readUInt16LE(local+8)!==method)throw new Error('ZIP local header mismatch.');
  const localLength=b.readUInt16LE(local+26),localExtra=b.readUInt16LE(local+28);
  if(localLength!==length||local+30+localLength+localExtra+packed>offset||!b.subarray(local+30,local+30+localLength).equals(b.subarray(p+46,p+46+length)))throw new Error('ZIP local name or size mismatch.');
  p+=46+length+extra+comment;
 }
 if(p!==end)throw new Error('ZIP entry count mismatch.');
}
export function inspectResultArchive(bytes: Uint8Array, projectId: string, experimentId: string | null): { summary: string; manifestValid: boolean } {
 if (bytes.length > MAX_FILE) throw new Error('Archive exceeds the 64 MiB limit.');
 validateZipHeaders(bytes);
 const seen = new Set<string>(); let total = 0;
 const files = unzipSync(bytes, { filter: entry => {
  if (!safeEntry(entry.name) || seen.has(entry.name.toLowerCase()) || seen.size >= MAX_ENTRIES) throw new Error('Archive contains unsafe, duplicate, or too many entries.');
  seen.add(entry.name.toLowerCase()); total += entry.originalSize;
  if (entry.originalSize > MAX_FILE || total > MAX_TOTAL) throw new Error('Archive expands beyond the permitted size.');
  return true;
 }});
 const data = files['run-manifest.json'];
 if (!data || data.length > 1024 * 1024) throw new Error('A result archive needs a run-manifest.json smaller than 1 MiB.');
 const manifest = resultManifestSchema.parse(parseStrictJson(strFromU8(data)));
 if (manifest.projectId !== projectId || manifest.experimentId !== experimentId) throw new Error('Result project/experiment identity does not match the selected experiment.');
 const expected = new Set<string>(['run-manifest.json']);
 for (const entry of manifest.artifacts) {
  if (!safeEntry(entry.path) || expected.has(entry.path) || entry.path === 'run-manifest.json') throw new Error('Invalid artifact inventory.');
  expected.add(entry.path); const file = files[entry.path];
  if (!file || file.length !== entry.size || createHash('sha256').update(file).digest('hex') !== entry.sha256) throw new Error(`Result inventory mismatch: ${entry.path}`);
 }
 if (Object.keys(files).some(name => !expected.has(name))) throw new Error('Archive has files not declared in its manifest.');
 return { manifestValid: true, summary: `Manifest and ${manifest.artifacts.length} artifact byte identities match. External run ${manifest.runId}: ${manifest.status}. No approved run package or provider verification is available; kept in quarantine.` };
}
/**
 * Reads a delivered CatBoost research package and says exactly what it is.
 *
 * The import is where a post-hoc result gets its one chance to claim it was preregistered, so the
 * registration class is taken from the package, checked against the frozen specification, and never
 * inferred from the fact that a specification identifier happens to be present. Every declared
 * prediction file is matched by bytes and row count, and the failed-run ledger is carried through
 * whole: a package that reports only its successful attempt is a selected package, and it is
 * recorded as such rather than quietly accepted.
 *
 * Nothing in the archive is executed. The importer parses documents.
 */
export function inspectResearchPackage(bytes: Uint8Array, projectId: string, spec: { id: string; hash: string; frozenAt: string } | null): {
  package: CatBoostPackage; evaluations: GateEvaluation[]; canAdvance: boolean; summary: string;
} {
 if (bytes.length > MAX_FILE) throw new Error('Archive exceeds the 64 MiB limit.');
 validateZipHeaders(bytes);
 const seen = new Set<string>(); let total = 0;
 const files = unzipSync(bytes, { filter: entry => {
  if (!safeEntry(entry.name) || seen.has(entry.name.toLowerCase()) || seen.size >= MAX_ENTRIES) throw new Error('Archive contains unsafe, duplicate, or too many entries.');
  seen.add(entry.name.toLowerCase()); total += entry.originalSize;
  if (entry.originalSize > MAX_FILE || total > MAX_TOTAL) throw new Error('Archive expands beyond the permitted size.');
  return true;
 }});
 const document = files['research-package.json'];
 if (!document || document.length > 4 * 1024 * 1024) throw new Error('A research package needs a research-package.json smaller than 4 MiB.');
 const parsed = catBoostPackageSchema.parse(parseStrictJson(strFromU8(document)));
 if (parsed.projectId !== projectId) throw new Error('This research package belongs to a different project.');

 // Predictions are read as delivered rows so the integrity and timing gates judge the actual file,
 // not the package's description of it.
 const delivered = new Map<string, { sha256: string; rows: number }>();
 const predictions: unknown[] = [];
 for (const declared of parsed.predictionInventory) {
  const file = files[declared.path];
  if (!file) continue;
  const rows = strFromU8(file).split(/\r?\n/).filter(line => line.trim().length > 0).map(line => parseStrictJson(line));
  delivered.set(declared.path, { sha256: createHash('sha256').update(file).digest('hex'), rows: rows.length });
  predictions.push(...rows);
 }
 const undeclared = Object.keys(files).filter(name => name !== 'research-package.json' && !parsed.predictionInventory.some(item => item.path === name));
 if (undeclared.length) throw new Error('The research package contains files it does not declare.');

 const evaluations = evaluatePackage(parsed, { predictions, deliveredFiles: delivered, spec });
 const verdict = advanceable(evaluations);
 const failedRuns = parsed.failedRuns.length;
 const summary = [
  parsed.registration === 'PROSPECTIVE'
   ? `Prospective run ${parsed.runId} against specification ${parsed.specId ?? 'unnamed'}.`
   : `Exploratory run ${parsed.runId}. It cannot satisfy S0 registration or an S8 holdout evaluation, whatever it reports.`,
  `${parsed.predictionInventory.length} prediction file${parsed.predictionInventory.length === 1 ? '' : 's'}, ${predictions.length} rows.`,
  failedRuns ? `${failedRuns} failed attempt${failedRuns === 1 ? ' is' : 's are'} recorded in the ledger.` : 'The ledger records no failed attempts, which is itself a claim about this lineage.',
  verdict.canAdvance ? 'Every deterministic gate passes on the delivered evidence.'
   : `Blocked or failed gates: ${[...verdict.failed, ...verdict.blocked].join(', ')}.`,
  'No approved run package or provider verification is implied by this import.',
 ].join(' ');
 return { package: parsed, evaluations, canAdvance: verdict.canAdvance, summary };
}
/**
 * Builds a reproducible research package: the exact code, data and approvals behind one candidate.
 *
 * Everything in the manifest is a reference rather than a copy, because the package's job is to let
 * somebody reconstruct what was done, not to become a second source of truth for it. The approval
 * statement is validated rather than accepted: a package that reads as authorisation to trade is the
 * artefact somebody points at later, and the office does not grant that.
 */
export function buildResearchPackage(manifest: unknown, files: Record<string, Uint8Array> = {}): Uint8Array {
 const release = releaseManifestSchema.parse(manifest);
 assertHonestApproval(release);
 const contents: Record<string, Uint8Array> = { ...files,
  'release-manifest.json': strToU8(JSON.stringify(release, null, 2)),
  'README.txt': strToU8([
   'Reproducible research package.',
   '',
   'This package records what was done and under what recorded standing. It is not an approved run',
   'package, not a deployment authorisation and not a statement that capital should be committed.',
   '',
   'Approved scope: ' + release.approvedScope,
   'What this approval means: ' + release.approvalMeaning,
   '',
   'Limitations:',
   ...release.limitations.map(item => '  - ' + item),
   '',
  ].join('\n')),
 };
 const entries = Object.entries(contents).map(([name, bytes]) => ({ path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
 contents['inventory.json'] = strToU8(JSON.stringify({ schemaVersion: 1, kind: 'RESEARCH_PACKAGE', entries, inventoryHash: canonicalHash(entries) }, null, 2));
 validateArchiveFiles(contents);
 const zipped = zipSync(contents, { level: 6 });
 validateZipHeaders(zipped);
 return zipped;
}
function mediaType(name: string): string {
 const ext = path.extname(name).toLowerCase();
 return ({ '.json':'application/json', '.csv':'text/csv', '.md':'text/markdown', '.txt':'text/plain', '.py':'text/plain', '.ipynb':'application/json', '.zip':'application/zip', '.qro':'application/zip' } as Record<string,string>)[ext] || 'application/octet-stream';
}
export class ArtifactService {
 /** `format` thresholds decide when a workspace outgrows the in-memory archive. Tests may lower them. */
 constructor(private readonly store: OfficeStore, private readonly root: string, private readonly format: {maxEntries:number;maxTotalBytes:number;maxFileBytes:number}={maxEntries:MAX_ENTRIES,maxTotalBytes:MAX_TOTAL,maxFileBytes:MAX_FILE}) {}
 private objectPath(hash: string): string { hashSchema.parse(hash); return path.join(this.root, 'objects', hash.slice(0,2), hash); }
 /**
  * Every object a backup must carry: imported artifacts, and the frozen bytes of prepared request
  * inputs. Staging directories are disposable, so without these a restored workspace would hold
  * snapshot records describing bytes it no longer has. Content addressing means the two sources
  * share storage whenever they happen to hold identical bytes.
  */
 private backedUpObjects(): string[] {
  const state = this.store.snapshot({history:false});
  return [...objectInventory(state)].filter(([hash, item]) => {
   if (existsSync(this.objectPath(hash))) return true;
   if (item.required) throw new Error(`A required stored object is missing: ${hash}`);
   return false;
  }).map(([hash]) => hash).sort();
 }
 private assertScope(projectId: string, experimentId: string | null): void {
  const state = this.store.snapshot({history:false}); const project = state.projects.find(p=>p.id===projectId);
  if (!project || project.archived) throw new Error('Select an active project first.');
  if (experimentId !== null && !state.experiments.some(e=>e.id===experimentId && e.projectId===projectId)) throw new Error('Experiment does not belong to this project.');
 }
 async importFile(file: string, projectId: string, experimentId: string|null, kind: 'REFERENCE'|'RESULT'): Promise<Artifact> {
  this.assertScope(projectId,experimentId);
  const info = await stat(file); if (!info.isFile() || info.size > MAX_FILE) throw new Error('Select a regular file no larger than 64 MiB.');
  const bytes = await readFile(file); if (bytes.length > MAX_FILE) throw new Error('File grew beyond the import limit.');
  const hash=createHash('sha256').update(bytes).digest('hex');
  const existing = this.store.snapshot({history:false}).artifacts.find(a=>a.projectId===projectId && a.experimentId===experimentId && a.sha256===hash && a.kind===kind);
  if (existing) {if(await fileHash(this.objectPath(hash))!==hash)throw new Error('Stored artifact integrity failure.');return existing;}
  let note = 'User-selected reference. Unclassified; unavailable to provider contexts until its data grant is reviewed.';
  if (kind==='RESULT') {
   note='User-supplied external result. No approved run or hosted verification is available; kept in quarantine.';
   if (['.zip','.qro'].includes(path.extname(file).toLowerCase())) {
    try { note=inspectResultArchive(bytes, projectId, experimentId).summary; }
    catch(error) { note=`Quarantined: ${error instanceof Error ? error.message : 'Invalid archive'}`.slice(0,3900); }
   }
  }
  const dest=this.objectPath(hash); await mkdir(path.dirname(dest),{recursive:true});
  try { const existingHash=await fileHash(dest); if(existingHash!==hash) throw new Error('Stored artifact integrity failure.'); }
  catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
   const temp=dest+'.'+randomUUID()+'.tmp'; await writeFile(temp,bytes,{flag:'wx'}); await rename(temp,dest);
  }
  const artifact:Artifact={id:randomUUID(),projectId,experimentId,name:path.basename(file),sha256:hash,size:bytes.length,kind,classification:kind==='RESULT'?'USER_ATTESTED':'UNCLASSIFIED',status:kind==='RESULT'?'QUARANTINED':'STORED',createdAt:new Date().toISOString(),mediaType:mediaType(file),note};
  this.store.addArtifact(artifact); return artifact;
 }
 async preview(id:string):Promise<{text:string;truncated:boolean;binary:boolean}> {
  const a=this.store.getArtifact(id), file=this.objectPath(a.sha256);
  if(await fileHash(file)!==a.sha256) throw new Error('Artifact bytes no longer match their recorded identity.');
  const textTypes=['text/plain','text/csv','text/markdown','application/json'];
  if(!textTypes.includes(a.mediaType)) return {text:`${a.name}\n${a.size.toLocaleString()} bytes\nSHA-256 ${a.sha256}\n\n${a.note}\n\nBinary artifacts are stored without executing or deserializing them.`,truncated:false,binary:true};
  const handle=await open(file,'r'); try { const buffer=Buffer.alloc(65536);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);return {text:buffer.subarray(0,bytesRead).toString('utf8'),truncated:a.size>bytesRead,binary:false};} finally { await handle.close(); }
 }
 async exportProject(projectId:string,destination:string):Promise<void> {
  const state=this.store.snapshot({history:false}),project=state.projects.find(p=>p.id===projectId); if(!project) throw new Error('Project not found.');
  const artifacts=state.artifacts.filter(a=>a.projectId===projectId); 
  const requests=state.requests?.filter(r=>r.projectId===projectId)??[];
  const requestIds=new Set(requests.map(item=>item.id));
  const assignments=(state.assignments??[]).filter(item=>item.projectId===projectId&&requestIds.has(item.requestId));
  const assignmentIds=new Set(assignments.map(item=>item.id));
  const jobs=(state.jobs??[]).filter(item=>item.projectId===projectId&&assignmentIds.has(item.assignmentId));
  const jobIds=new Set(jobs.map(item=>item.id));
  const messages=(state.messages??[]).filter(item=>item.projectId===projectId&&requestIds.has(item.requestId));
  const decisions=(state.decisions??[]).filter(item=>item.projectId===projectId&&requestIds.has(item.requestId));
  const snapshots=(state.snapshots??[]).filter(item=>item.projectId===projectId);
  const pipeline=(state.pipeline??[]).filter(r=>r.projectId===projectId);
  const branchIds=new Set((state.branches??[]).filter(b=>b.projectId===projectId).map(b=>b.id));
  const research={branches:state.branches?.filter(b=>branchIds.has(b.id)),specs:state.specs?.filter(s=>branchIds.has(s.branchId)),
    predictions:state.predictions?.filter(p=>branchIds.has(p.branchId)),trials:state.trials?.filter(t=>branchIds.has(t.branchId)),
    attempts:state.attempts?.filter(a=>branchIds.has(a.branchId)),receipts:state.receipts?.filter(r=>branchIds.has(r.branchId)),
    functions:state.functions?.filter(f=>f.projectId===projectId),pipeline,
    evidence:this.store.evidenceRecords().filter(r=>r.projectId===projectId)};
  let cursor:number|undefined;
  do{const page=this.store.historyPage({projectId,limit:200,cursor});state.events.push(...page.entries);cursor=page.nextCursor??undefined;await new Promise<void>(resolve=>setImmediate(resolve));}while(cursor);
  state.events.reverse();
  const grants=(state.grants??[]).filter(item=>requestIds.has(item.requestId));
  const jobEvents=(state.jobEvents??[]).filter(item=>jobIds.has(item.jobId));
  const agentIds=new Set([...requests.flatMap(r=>[r.leadAgentId,...r.participantIds]),...assignments.map(a=>a.agentId),
    ...messages.flatMap(m=>[m.fromAgentId,m.toAgentId]),...grants.map(g=>g.agentId)].filter(Boolean));
  const snapshot={schemaVersion:2,kind:'PROJECT_DRAFT_EXPORT',exportedAt:new Date().toISOString(),provenance:{producedBy:'Quant Research Office',scope:'ONE_PROJECT',includes:['project','requests','experiments','tasks','artifacts','project-scoped events','profiles referenced by these requests'],excludes:['credentials','unscoped legacy conversations','external project folder contents','other projects'],externalFoldersIncluded:false,approvals:'NONE_RECORDED: this export carries no run approval and no scientific verdict.'},project,requests,experiments:state.experiments.filter(e=>e.projectId===projectId),tasks:state.tasks.filter(t=>t.projectId===projectId),artifacts,events:state.events.filter(e=>e.projectId===projectId),approvals:[],agents:state.agents.filter(a=>agentIds.has(a.id)),conversationExport:'Unscoped legacy logs are excluded. Workspace backup preserves them.',externalFoldersIncluded:false,warning:'Research planning archive only. Not an approved executable run package.'};
  const files:Record<string,Uint8Array>={};
  const unavailableObjectHashes:string[]=[];
  for(const [hash,item] of objectInventory({artifacts,snapshots,jobs,pipeline})){
   if(!existsSync(this.objectPath(hash))&&!item.required){unavailableObjectHashes.push(hash);continue;}
   const bytes=await readFile(this.objectPath(hash));
   if(bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error('Project object integrity failure.');
   files['objects/'+hash]=bytes;
  }
  snapshot.provenance.includes.push('assignments','jobs','snapshots','scoped messages','review decision records','job events','grants','available referenced object bytes');
  files['project.json']=strToU8(JSON.stringify({...snapshot,assignments,jobs,snapshots,messages,decisions,grants,jobEvents,unavailableObjectHashes,...research,
    reviewMeaning:'Recorded review decisions do not establish context isolation, scientific gate approval or trading authorization.'},null,2));
  const entries=Object.entries(files).map(([name,data])=>({path:name,size:data.length,sha256:createHash('sha256').update(data).digest('hex')}));
  files['inventory.json']=strToU8(JSON.stringify({schemaVersion:1,kind:'DRAFT',entries,inventoryHash:canonicalHash(entries)},null,2));
  validateArchiveFiles(files);const zipped=await compress(files);validateWrittenArchive(zipped);await atomicWrite(destination,zipped);
  this.store.recordTransfer('PROJECT_EXPORTED',projectId,'Exported a draft planning archive; no run approval or code execution.');
 }
 /**
  * Streams a workspace that is too large for the in-memory format.
  * Every entry is hashed as it is written, and the archive is extracted and verified again before the
  * destination is announced, so a backup is never reported without having been read back.
  */
 private async backupStreamed(destination:string,tempDir:string,db:string):Promise<void>{
  const snapshot=this.store.snapshot({history:false});
  const seen=new Set<string>();
  const sources=[{path:'workspace.sqlite',file:db},
   ...this.backedUpObjects().map(hash=>({path:'objects/'+hash,file:this.objectPath(hash)}))]
   .filter(source=>{if(seen.has(source.path))return false;seen.add(source.path);return true;});
  const measured=[];
  for(const source of sources){
   const sha256=await fileHash(source.file);
   if(source.path.startsWith('objects/')&&sha256!==source.path.slice(8))throw new Error('Artifact integrity failure while preparing the backup.');
   measured.push({path:source.path,file:source.file,size:(await stat(source.file)).size,sha256});
  }
  const manifest={schemaVersion:2,kind:'WORKSPACE_BACKUP',format:'STREAMED',createdAt:new Date().toISOString(),
   lastEvent:this.store.lineageTip().hash,files:measured.map(({path,size,sha256})=>({path,size,sha256}))};
  const staged=path.join(tempDir,'backup.zip');
  await writeStreamedArchive(staged,[...sources,{path:'backup.json',bytes:strToU8(JSON.stringify(manifest,null,2))}]);
  const {prepareRestore,discardCandidate}=await import('./recovery.js');
  const prepared=await prepareRestore(staged,tempDir);await discardCandidate(prepared.candidate,tempDir);
  await rename(staged,destination);
  this.store.recordTransfer('WORKSPACE_BACKED_UP',null,'Created and round-trip verified a streamed workspace backup. External project folders and credentials are not included.');
 }
 async exportResearch(branchId:string,destination:string):Promise<void>{
  const state=this.store.snapshot({history:false}),branch=state.branches?.find(b=>b.id===branchId);
  if(!branch)throw new Error('Research branch not found.');
  const spec=state.specs?.find(s=>s.id===branch.specId),pipeline=(state.pipeline??[]).filter(r=>r.branchId===branch.id);
  if(pipeline.some(r=>r.kind==='REVIEW_REPORT'&&!r.opened))throw new Error('Research export waits until every first review in the round is immutable and opened.');
  const assignments=(state.assignments??[]).filter(a=>a.research?.branchId===branch.id),assignmentIds=new Set(assignments.map(a=>a.id));
  const jobs=(state.jobs??[]).filter(j=>assignmentIds.has(j.assignmentId)),snapshotIds=new Set(assignments.map(a=>a.snapshotId));
  const snapshots=(state.snapshots??[]).filter(s=>snapshotIds.has(s.id));
  const sourceHashes=new Set(pipeline.flatMap(r=>r.kind==='SHADOW_BATCH'?[r.sourceHash]:r.kind==='IMPORT'?[state.artifacts.find(a=>a.id===r.artifactId)?.sha256??'']:[]));
  for(const record of pipeline)if(record.kind==='SHADOW_BATCH'&&record.batchType==='EXECUTIONS'){
    const batch=parseStrictJson((await readFile(this.objectPath(record.sourceHash))).toString('utf8')) as {sourceDocumentHash?:string};
    if(batch.sourceDocumentHash)sourceHashes.add(batch.sourceDocumentHash);
  }
  const candidateHashes=new Set(pipeline.filter(r=>r.kind==='LINK').map(r=>r.kind==='LINK'?r.subjectHash:''));
  const artifacts=state.artifacts.filter(a=>a.projectId===branch.projectId&&(sourceHashes.has(a.sha256)||candidateHashes.has(a.sha256)));
  const inventory=objectInventory({artifacts,snapshots,jobs,pipeline});
  const sources:{path:string;file?:string;bytes?:Uint8Array}[]=[],unavailable:string[]=[];
  for(const [hash,item] of inventory){
    const file=this.objectPath(hash);
    if(!existsSync(file)){if(item.required)throw new Error('Research export is missing a required object.');unavailable.push(hash);continue;}
    if((await stat(file)).size!==item.bytes||await fileHash(file)!==hash)throw new Error('Research export object integrity failure.');
    sources.push({path:'objects/'+hash,file});
  }
  const manifest={schemaVersion:1,kind:'RESEARCH_EVIDENCE_PACKAGE',exportedAt:new Date().toISOString(),branch,spec:spec??null,
    assignments,jobs,snapshots,artifacts,pipeline,receipts:state.receipts?.filter(r=>r.branchId===branch.id),
    predictions:state.predictions?.filter(p=>p.branchId===branch.id),trials:state.trials?.filter(t=>t.lineageId===branch.lineageId),
    ancestry:state.branches?.filter(b=>b.lineageId===branch.lineageId),
    codeAndEnvironment:{sourceSnapshots:snapshots.map(s=>({id:s.id,manifestHash:s.manifestHash,stagingCommit:s.stagingCommit||null})),
      executions:assignments.map(a=>({assignmentId:a.id,model:a.requestedModel,frozen:a.frozen??null})),unknown:snapshots.some(s=>!s.stagingCommit)?['One or more staging commits were not recorded.']:[]},
    costs:spec?.sections.costContract??null,portfolio:spec?.sections.portfolioContract??null,unavailableObjectHashes:unavailable,
    limitations:['Not an approval for trading or capital deployment.','Imported executions are user-attested and remain separate from simulated fills.',
      'Local fixture receipts do not establish hosted behavior.','Verify receipt signatures against independently provisioned trust anchors; this archive cannot install its own trust.',
      'Holdout secret bytes and exposure journals are excluded; restore cannot replenish exposure.'],
    approvedScope:'The exact recorded branch, specification, candidate identities and evidence inventories only.',
    approvalMeaning:'Research standing only. No capital deployment is authorized. Missing environment facts remain unknown.'};
  sources.push({path:'research.json',bytes:strToU8(JSON.stringify(manifest,null,2))});
  sources.push({path:'inventory.json',bytes:strToU8(JSON.stringify({schemaVersion:1,objects:[...inventory].map(([sha256,value])=>({sha256,...value})),inventoryHash:canonicalHash([...inventory])},null,2))});
  await writeStreamedArchive(destination,sources);
  this.store.recordTransfer('PROJECT_EXPORTED',branch.projectId,'Exported exact research evidence and frozen source objects with explicit verification limits.');
 }
 async backup(destination:string):Promise<void> {
  const tempDir=path.join(this.root,'staging',randomUUID());await mkdir(tempDir,{recursive:true});
  try {
   const db=path.join(tempDir,'workspace.sqlite');await this.store.backup(db);
   // Small workspaces keep the original in-memory format; larger ones use the streamed format.
   let objectBytes=0;
   const objects=this.backedUpObjects();
   for(const hash of objects)objectBytes+=(await stat(this.objectPath(hash))).size;
   const databaseBytes=(await stat(db)).size;
   if(objects.length+2>this.format.maxEntries||databaseBytes+objectBytes>this.format.maxTotalBytes||databaseBytes>this.format.maxFileBytes)
    return await this.backupStreamed(destination,tempDir,db);
   const snapshot=this.store.snapshot({history:false});

   const files:Record<string,Uint8Array>={'workspace.sqlite':await readFile(db)};
   for(const hash of objects){const bytes=await readFile(this.objectPath(hash));if(createHash('sha256').update(bytes).digest('hex')!==hash) throw new Error(`Stored object integrity failure: ${hash}`); files['objects/'+hash]=bytes;}
   files['backup.json']=strToU8(JSON.stringify({schemaVersion:1,kind:'WORKSPACE_BACKUP',createdAt:new Date().toISOString(),lastEvent:this.store.lineageTip().hash,files:Object.entries(files).map(([p,b])=>({path:p,size:b.length,sha256:createHash('sha256').update(b).digest('hex')}))},null,2));
   validateArchiveFiles(files);const zipped=await compress(files);validateWrittenArchive(zipped);
   const testArchive=path.join(tempDir,'roundtrip.zip');await atomicWrite(testArchive,zipped);
   const {prepareRestore,discardCandidate}=await import('./recovery.js');
   const prepared=await prepareRestore(testArchive,tempDir);await discardCandidate(prepared.candidate,tempDir);
   await atomicWrite(destination,zipped);this.store.recordTransfer('WORKSPACE_BACKED_UP',null,'Created and round-trip verified a workspace backup. External project folders and credentials are not included.');
  } finally { await removeTree(tempDir); }
 }
}
export async function atomicWrite(destination:string,bytes:Uint8Array):Promise<void>{const temp=destination+'.'+randomUUID()+'.tmp';try{await writeFile(temp,bytes,{flag:'wx'});await rename(temp,destination);}finally{await rm(temp,{force:true});}}

/** Writer and reader share byte and entry acceptance via ZIP header validation. */
export function validateArchiveFiles(files:Record<string,Uint8Array>):void {
 const entries=Object.entries(files);
 if(entries.length>MAX_ENTRIES||entries.some(([name,bytes])=>!safeEntry(name)||bytes.length>MAX_FILE)||entries.reduce((n,[,b])=>n+b.length,0)>MAX_TOTAL)throw new Error('Archive exceeds supported limits: 512 entries, 64 MiB per entry, 256 MiB total including database and manifests.');
 if(files['backup.json']?.length>1024*1024)throw new Error('Backup manifest exceeds 1 MiB.');
}
function validateWrittenArchive(bytes:Uint8Array):void {if(bytes.length>MAX_TOTAL)throw new Error('Compressed archive exceeds 256 MiB.');validateZipHeaders(bytes);}
